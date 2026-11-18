import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Address, Hex } from 'viem';
import { loadMeConfig } from '../../packages/me/src/config.js';
import { bankAddressToEvm, evmToBankAddress, cosmosResponseHeight, verifyMeUnits } from '../../packages/me/src/bank.js';
import type { MePublicClient } from '../../packages/me/src/chain.js';
import type { FetchLike } from '../../packages/me/src/rpc.js';
import { calculateGasCharge } from '../../packages/me/src/balances.js';

const wallet = '0xf1829676db577682e944fc3493d451b67ff3e29f' as Address;
const bankAddress = 'me17xpfvakm2amg962yls6f84z3kell8c5lr2wff2';
const blockHash = '0x36ec2f1965492c7855244beb31ffb984795510fe2c7a9576c66df703d1fb7550' as Hex;
const height = 5380384n;
const config = loadMeConfig({ ME_NETWORK: 'me-testnet', ME_EVM_RPC_URL: 'https://rpc.example.invalid', ME_EVM_CHAIN_ID: '400', ME_NATIVE_SYMBOL: 'MEC', ME_BANK_DENOM: 'umec', ME_BANK_DECIMALS: '8', ME_QUANTUM_WEI: '10000000000', ME_COSMOS_REST_URL: 'https://rest.example.invalid' });

test('Bech32 account codec roundtrips the independently observed public module account and rejects bad checksums', () => {
  assert.equal(evmToBankAddress(wallet), bankAddress);
  assert.equal(bankAddressToEvm(bankAddress), wallet);
  assert.throws(() => bankAddressToEvm(`${bankAddress.slice(0, -1)}q`), /checksum/);
  assert.throws(() => bankAddressToEvm(bankAddress.toUpperCase()), /canonical lowercase/);
});

test('Both observed Cosmos height header forms are supported; inconsistent headers are rejected', () => {
  assert.equal(cosmosResponseHeight(new Headers({ 'grpc-metadata-x-cosmos-block-height': '5380384' })), height);
  assert.equal(cosmosResponseHeight(new Headers({ 'x-cosmos-block-height': '5380384' })), height);
  assert.equal(cosmosResponseHeight(new Headers()), undefined);
  assert.throws(() => cosmosResponseHeight(new Headers({ 'x-cosmos-block-height': '1', 'grpc-metadata-x-cosmos-block-height': '2' })), /Conflicting/);
});

function recordedResponseFixture(options: { zero?: boolean; badHeight?: boolean; missingHeight?: boolean; badBankAmount?: boolean; badDecimals?: boolean; wrongBlockHash?: boolean } = {}) {
  // Values mirror the recorded READ-ONLY observation. No network request occurs in this unit test.
  const bankAtoms = options.zero ? 0n : 237583380n;
  const client = { getChainId: async () => 400, getBlock: async () => ({ number: height, hash: blockHash }), getBalance: async ({ blockNumber }: { blockNumber: bigint }) => { assert.equal(blockNumber, height); return bankAtoms * config.quantumWei; } } as unknown as MePublicClient;
  const fetchImpl = (async (input: string | URL, init: RequestInit) => {
    const url = new URL(input); const headers = new Headers(init.headers);
    if (!url.pathname.includes('/blocks/')) assert.equal(headers.get('x-cosmos-block-height'), height.toString());
    let body: unknown;
    if (url.pathname.includes('/cosmos_account/')) body = { cosmos_address: bankAddress, sequence: '0', account_number: '20' };
    else if (url.pathname.includes('/balances/')) body = { balance: { denom: 'umec', amount: (bankAtoms + (options.badBankAmount ? 1n : 0n)).toString() } };
    else if (url.pathname.includes('/blocks/')) body = { block_id: { hash: Buffer.from(options.wrongBlockHash ? 'ab'.repeat(32) : blockHash.slice(2), 'hex').toString('base64') }, block: { header: { height: height.toString(), chain_id: 'mechain_400-1' } } };
    else if (url.pathname.includes('/denoms_metadata/')) body = { metadata: { base: 'umec', display: 'MEC', denom_units: [{ denom: 'umec', exponent: 0 }, { denom: 'MEC', exponent: options.badDecimals ? 9 : 8 }] } };
    else throw new Error(`Unexpected path ${url.pathname}`);
    const responseHeaders = new Headers({ 'content-type': 'application/json' });
    if (!(options.missingHeight && url.pathname.includes('/balances/'))) responseHeaders.set('grpc-metadata-x-cosmos-block-height', options.badHeight && url.pathname.includes('/balances/') ? '1' : height.toString());
    return new Response(JSON.stringify(body), { headers: responseHeaders });
  }) as FetchLike;
  return { client, fetchImpl };
}

test('Nonzero fixed-height bank/EVM evidence produces the strict unit-report schema without authorizing writes', async () => {
  const fixture = recordedResponseFixture();
  const report = await verifyMeUnits(fixture.client, config, wallet, { blockNumber: height, fetchImpl: fixture.fetchImpl });
  assert.equal(report.schema, 'humandock.units.v1');
  assert.equal(report.status, 'matched');
  assert.equal(report.quantumWei, '10000000000');
  assert.equal(report.nonZero, true);
  assert.equal(report.liveWritesEnabled, false);
  assert.equal(report.evidence.bankAtoms, '237583380');
  assert.equal(report.evidence.evmWei, '2375833800000000000');
});

test('Zero, mismatched quantum, mismatched chain block or unproven historical height cannot verify units', async () => {
  for (const [options, status] of [
    [{ zero: true }, 'unverified'], [{ badHeight: true }, 'unverified'], [{ missingHeight: true }, 'unverified'],
    [{ wrongBlockHash: true }, 'unverified'], [{ badBankAmount: true }, 'mismatch'], [{ badDecimals: true }, 'mismatch'],
  ] as const) {
    const fixture = recordedResponseFixture(options);
    const report = await verifyMeUnits(fixture.client, config, wallet, { blockNumber: height, fetchImpl: fixture.fetchImpl });
    assert.equal(report.status, status);
    assert.equal(report.liveWritesEnabled, false);
  }
});

test('ME gas rounding matches the observed 1 umec fee and the source-confirmed unused-gas boundary', () => {
  const q = 10_000_000_000n;
  assert.equal(calculateGasCharge({ gasLimit: 21000n, gasUsed: 21000n, effectiveGasPrice: 8n, quantumWei: q, model: 'me-bank-ceil-prepay-floor-refund' }), q);
  assert.equal(calculateGasCharge({ gasLimit: 21000n, gasUsed: 21000n, effectiveGasPrice: 8n, quantumWei: q, model: 'exact-wei' }), 168000n);
  // This is an arithmetic fixture for the fork's rounding path, not a claimed live receipt.
  assert.equal(calculateGasCharge({ gasLimit: 4n, gasUsed: 2n, effectiveGasPrice: 3n, quantumWei: 10n, model: 'me-bank-ceil-prepay-floor-refund' }), 20n);
  assert.throws(() => calculateGasCharge({ gasLimit: 1n, gasUsed: 2n, effectiveGasPrice: 3n, quantumWei: 10n, model: 'exact-wei' }), /Invalid gas/);
});
