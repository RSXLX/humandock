import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keccak256, stringToHex, type Address } from 'viem';
import { loadMeConfig, bankAtomsToWei, weiToBankAtoms, MeConfigurationError } from '../../packages/me/src/config.js';
import { probeMeRpc, type FetchLike } from '../../packages/me/src/rpc.js';
import { getMeIdByDid, verifyMeIdentityForWallet } from '../../packages/me/src/identity.js';
import { saltedCommitment, disputeAllocation } from '../../packages/me/src/contracts.js';
import { canonicalJson, commitment } from '../../packages/domain/src/commitments.js';
import { evmToBankAddress } from '../../packages/me/src/bank.js';

const env = {
  ME_NETWORK: 'me-testnet', ME_EVM_RPC_URL: 'https://rpc.example.invalid', ME_EVM_CHAIN_ID: '400',
  ME_NATIVE_SYMBOL: 'MEC', ME_BANK_DENOM: 'umec', ME_BANK_DECIMALS: '8', ME_QUANTUM_WEI: '10000000000',
  ME_COSMOS_REST_URL: 'https://rest.example.invalid', ME_MIN_KYC_LEVEL: '2',
  ME_ID_POLICY_REFERENCE: 'TEST FIXTURE ONLY: does not establish the official advanced-KYC mapping',
};
const wallet = '0x1234567890123456789012345678901234567890' as Address;
const bankAddress = evmToBankAddress(wallet);
const info = { did: 'private-test-did', address: 'me1fixture', pubkey: 'fixture-public-key', status: 'DID_STATUS_ACTIVE', kycLevel: 'KYC_LEVEL_TWO', subAccount: bankAddress };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'grpc-metadata-x-cosmos-block-height': '12' } });

test('ME configuration has no implicit network or units and rejects lossy/HTTP configuration', () => {
  assert.throws(() => loadMeConfig({}), MeConfigurationError);
  assert.throws(() => loadMeConfig({ ...env, ME_EVM_RPC_URL: 'http://118.175.0.249:8545' }), /HTTPS/);
  assert.throws(() => loadMeConfig({ ...env, ME_QUANTUM_WEI: '1' }), /QUANTUM/);
  assert.throws(() => loadMeConfig({ ...env, ME_EVM_CHAIN_ID: '4e2' }), /integer/);
  assert.throws(() => loadMeConfig({ ...env, ME_BANK_DECIMALS: '19' }), /decimals/);
  assert.throws(() => loadMeConfig({ ...env, ME_MIN_KYC_LEVEL: '6' }), /1..5/);
  const config = loadMeConfig(env);
  assert.equal(bankAtomsToWei(13n, config), 130_000_000_000n);
  assert.equal(weiToBankAtoms(130_000_000_000n, config), 13n);
  assert.throws(() => weiToBankAtoms(130_000_000_001n, config), /lose precision/);
  assert.equal(loadMeConfig({ ...env, ME_NETWORK: 'local', ME_EVM_RPC_URL: 'http://127.0.0.1:8545' }).network, 'local');
});

test('RPC probe uses only read methods, checks expected chain and never approves live writes or units', async () => {
  const methods: string[] = [];
  const fetcher = (async (_url: unknown, options: RequestInit) => {
    const request = JSON.parse(options.body as string); methods.push(request.method);
    const result = request.method === 'eth_chainId' ? '0x190' : request.method === 'web3_clientVersion' ? 'fixture-client/not-live' : { number: '0x20', hash: `0x${'ab'.repeat(32)}` };
    return response({ jsonrpc: '2.0', id: request.id, result });
  }) as FetchLike;
  const result = await probeMeRpc(loadMeConfig(env), fetcher);
  assert.deepEqual(methods.sort(), ['eth_chainId', 'eth_getBlockByNumber', 'web3_clientVersion'].sort());
  assert.equal(result.blockNumber, '32');
  assert.equal(result.liveWritesEnabled, false);
  assert.equal(result.unitsVerifiedOnLiveChain, false);
  await assert.rejects(probeMeRpc(loadMeConfig({ ...env, ME_EVM_CHAIN_ID: '401' }), fetcher), /does not match/);
});

test('ME identity uses official pinned query paths, verifies both directions and keeps canonical DID private', async () => {
  const urls: URL[] = [];
  const fetcher = (async (input: string | URL) => { const url = new URL(input); urls.push(url); return response(url.pathname.includes('/cosmos_account/') ? { cosmos_address: bankAddress } : { info }); }) as FetchLike;
  const result = await verifyMeIdentityForWallet(loadMeConfig(env), wallet, fetcher);
  assert.equal(result.canonicalDid, info.did);
  assert.deepEqual(urls.map((url) => url.pathname), [`/ethermint/evm/v1/cosmos_account/${wallet}`, '/metaearth/kyc/QuerySubAccountDidResponse', '/metaearth/did/did']);
  assert.equal(urls[1].searchParams.get('sub_account'), bankAddress);
  assert.equal(urls[2].searchParams.get('address'), info.address);
  await getMeIdByDid(loadMeConfig(env), 'private-did?&value', fetcher);
  assert.equal(urls[3].pathname, '/metaearth/did/didInfo');
  assert.equal(urls[3].searchParams.get('did'), 'private-did?&value');
});

test('Identity admission fails closed for absent policy, unknown enums, inactive identity and inconsistent bindings', async () => {
  const mock = (value: unknown) => (async (input: string | URL) => response(new URL(input).pathname.includes('/cosmos_account/') ? { cosmos_address: bankAddress } : { info: value })) as FetchLike;
  await assert.rejects(verifyMeIdentityForWallet(loadMeConfig({ ...env, ME_ID_POLICY_REFERENCE: '' }), wallet, mock(info)), /mapping/);
  await assert.rejects(verifyMeIdentityForWallet(loadMeConfig(env), wallet, mock({ ...info, status: '1' })), /Unknown/);
  await assert.rejects(verifyMeIdentityForWallet(loadMeConfig(env), wallet, mock({ ...info, kycLevel: 'ADVANCED' })), /Unknown/);
  await assert.rejects(verifyMeIdentityForWallet(loadMeConfig(env), wallet, mock({ ...info, status: 0 })), /does not satisfy/);
  await assert.rejects(verifyMeIdentityForWallet(loadMeConfig(env), wallet, mock({ ...info, kycLevel: 1 })), /does not satisfy/);
  await assert.rejects(verifyMeIdentityForWallet(loadMeConfig(env), wallet, mock({ ...info, subAccount: '0x0000000000000000000000000000000000000001' })), /does not satisfy/);
  let calls = 0;
  const mismatch = (async (input: string | URL) => response(new URL(input).pathname.includes('/cosmos_account/') ? { cosmos_address: bankAddress } : { info: ++calls === 1 ? info : { ...info, did: 'different-person' } })) as FetchLike;
  await assert.rejects(verifyMeIdentityForWallet(loadMeConfig(env), wallet, mismatch), /consistently verified/);
  await assert.rejects(verifyMeIdentityForWallet(loadMeConfig(env), wallet, (async (input: string | URL) => response(new URL(input).pathname.includes('/cosmos_account/') ? { cosmos_address: bankAddress } : { data: info })) as FetchLike), /envelope/);
});

test('Commitments domain-separate private source/final hashes; dispute remainder remains quantum aligned', () => {
  const digest = keccak256(stringToHex('private-fixture'));
  const salt = `0x${'ab'.repeat(32)}` as const;
  assert.notEqual(saltedCommitment('task', digest, salt), saltedCommitment('delivery', digest, salt));
  assert.notEqual(saltedCommitment('task', digest, salt), digest);
  const manifest = { scope: 'en-US', text: 'Exact bytes\r\n广告', feeWei: '1010000000000' };
  const manifestHash = keccak256(stringToHex(canonicalJson(manifest)));
  assert.equal(saltedCommitment('task', manifestHash, salt), commitment('SOURCE', manifest, salt));
  assert.equal(saltedCommitment('delivery', manifestHash, salt), commitment('FINAL', manifest, salt));
  const split = disputeAllocation(101n * 10_000_000_000n, 20n * 10_000_000_000n, 10_000_000_000n, 5000n);
  assert.deepEqual(split, { reviewerWei: 500_000_000_000n, platformWei: 0n, buyerWei: 710_000_000_000n });
  assert.throws(() => disputeAllocation(101n, 20n, 10n, 5000n), /representable/);
});
