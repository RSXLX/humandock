import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { encodeFunctionData, keccak256, stringToHex, toHex, type Hex } from 'viem';
import { deployLocalFixture } from '../../packages/me/src/local-fixture.js';
import { reviewEscrowAbi, releaseRegistryAbi } from '../../packages/me/src/generated-abis.js';
import { verifyDeployment, verifyTransaction, scanContractEvents, type PreparedTransaction, type MinedTransactionVerification, type MePublicClient } from '../../packages/me/src/chain.js';
import { signQuote, signAssignment, signDelivery, signApproval, signRevocation } from '../../packages/me/src/signing.js';
import { hashQuote, DELIVERY_SCHEMA_HASH, EXPORT_PURPOSE_HASH, Verdict, type Quote, type AssignmentPermit, type DeliveryEnvelope, type ApprovalIntent } from '../../packages/me/src/contracts.js';
import { readBalanceSnapshot, reconcileWithdrawal } from '../../packages/me/src/balances.js';

let fixture: Awaited<ReturnType<typeof deployLocalFixture>>;
before(async () => { fixture = await deployLocalFixture(); });
after(async () => { await fixture?.close(); });
const digest = (text: string) => keccak256(stringToHex(text));

test('Local EVM integration: signed funding to review, independent approval, verified receipts, replayable logs and reconciled withdrawals', async () => {
  const f = fixture; const { deployment: d, client, accounts, wallets, config } = f;
  const readiness = await verifyDeployment(client, config, d);
  assert.equal(readiness.ready, true);
  assert.equal(readiness.roles.quoteSigner.toLowerCase(), accounts[1].address.toLowerCase());
  function prepare(actor: number, action: string, args: readonly unknown[], value = 0n, registry = false): PreparedTransaction {
    return { chainId: config.chainId, from: accounts[actor].address, to: registry ? d.registry : d.escrow, data: encodeFunctionData({ abi: (registry ? releaseRegistryAbi : reviewEscrowAbi) as any, functionName: action, args }), value: toHex(value) };
  }
  async function send(actor: number, expected: PreparedTransaction): Promise<MinedTransactionVerification> {
    const hash = await wallets[actor].sendTransaction({ to: expected.to, data: expected.data, value: BigInt(expected.value), gas: 5_000_000n });
    await client.getTransactionReceipt({ hash }); // Ganache mines synchronously; no timer-based test assumptions.
    const verification = await verifyTransaction(client, expected, hash, 1);
    assert.notEqual(verification.status, 'pending');
    return verification as MinedTransactionVerification;
  }
  const stamp = (await client.getBlock()).timestamp;
  const q: Quote = { buyer: accounts[6].address, clientRequestId: digest('local-signed-request'), taskCommitment: digest('private-salted-task-commitment'), buyerPrincipal: digest('private-task-buyer-alias'), reviewerFeeWei: 101_000_000_000_000n, platformFeeWei: 20_000_000_000_000n, quantumWei: config.quantumWei, acceptUntil: stamp + 3600n, reviewDuration: 86400, expiresAt: stamp + 900n, nonce: 1n };
  const fundingIntent = prepare(6, 'createAndFund', [q, await signQuote(accounts[1], config.chainId, d.escrow, q)], q.reviewerFeeWei + q.platformFeeWei);
  const funding = await send(6, fundingIntent);
  assert.equal(funding.status, 'confirmed');
  const taskId = funding.events.find((event) => event.eventName === 'TaskFunded')!.args.taskId as bigint;
  await assert.rejects(verifyTransaction(client, { ...fundingIntent, value: '0x0' }, funding.hash, 1), /differs from the persisted intent/);
  await assert.rejects(verifyTransaction(client, { ...fundingIntent, from: accounts[9].address }, funding.hash, 1), /differs from the persisted intent/);
  const missing = await verifyTransaction(client, fundingIntent, digest('not-a-transaction'), 1);
  assert.equal(missing.status, 'pending');
  const p: AssignmentPermit = { taskId, taskCommitment: q.taskCommitment, termsHash: hashQuote(config.chainId, d.escrow, q), buyer: q.buyer, reviewer: accounts[7].address, reviewerPrincipal: digest('private-reviewer-alias'), expiresAt: q.acceptUntil, nonce: 1n };
  assert.equal((await send(7, prepare(7, 'acceptAssignment', [p, await signAssignment(accounts[2], config.chainId, d.escrow, p)]))).status, 'confirmed');
  const issuedAt = (await client.getBlock()).timestamp;
  const envelope: DeliveryEnvelope = { taskId, taskCommitment: q.taskCommitment, deliveryCommitment: digest('private-salted-final-commitment'), reviewer: accounts[7].address, verdict: Verdict.PASS, schemaHash: DELIVERY_SCHEMA_HASH, issuedAt, expiresAt: issuedAt + 900n, nonce: 1n };
  const delivery = await send(7, prepare(7, 'submitDelivery', [envelope, await signDelivery(accounts[7], config.chainId, d.escrow, envelope), await signDelivery(accounts[3], config.chainId, d.escrow, envelope)]));
  assert.equal(delivery.events[0].eventName, 'DeliverySubmitted');
  const approval: ApprovalIntent = { escrow: d.escrow, taskId, brandAuthority: q.buyer, deliveryCommitment: envelope.deliveryCommitment, purposeHash: EXPORT_PURPOSE_HASH, expiresAt: issuedAt + 86400n, nonce: 1n };
  const approvalIntent = prepare(8, 'approve', [approval, await signApproval(accounts[6], config.chainId, d.registry, approval)], 0n, true);
  const approved = await send(8, approvalIntent);
  assert.equal(approved.status, 'confirmed');
  const approvalId = approved.events[0].args.approvalId as Hex;
  assert.equal(await client.readContract({ address: d.escrow, abi: reviewEscrowAbi, functionName: 'totalClaimableWei' }), 0n);
  assert.equal(await client.readContract({ address: d.registry, abi: releaseRegistryAbi, functionName: 'isValidApproval', args: [approvalId, envelope.deliveryCommitment, EXPORT_PURPOSE_HASH] }), true);
  assert.equal((await verifyTransaction(client, approvalIntent, approved.hash, 2)).status, 'confirming');
  await f.provider.request({ method: 'evm_mine', params: [] });
  assert.equal((await verifyTransaction(client, approvalIntent, approved.hash, 2)).status, 'confirmed');
  assert.equal((await send(8, approvalIntent)).status, 'reverted'); // consumed approval nonce
  assert.equal((await send(6, prepare(6, 'acceptService', [taskId]))).status, 'confirmed');
  const preBlock = await client.getBlockNumber({ cacheTime: 0 });
  const watched = [d.escrow, accounts[7].address, accounts[9].address];
  const beforeBalances = await Promise.all(watched.map((address) => readBalanceSnapshot(client, { address, quantumWei: config.quantumWei, blockNumber: preBlock })));
  const paid = await send(7, prepare(7, 'withdrawTo', [accounts[9].address]));
  const afterBalances = await Promise.all(watched.map((address) => readBalanceSnapshot(client, { address, quantumWei: config.quantumWei, blockNumber: paid.blockNumber })));
  const reconciliation = reconcileWithdrawal({ before: beforeBalances, after: afterBalances, receipt: paid, withdrawal: paid.events.find((event) => event.eventName === 'Withdrawal')!, quantumWei: config.quantumWei, gasCharging: 'exact-wei' });
  assert.equal(reconciliation.status, 'evm-only'); // Ganache has no real Cosmos bank.
  assert.equal(reconciliation.evmBalanced, true);
  assert.equal(reconciliation.bankVerified, false);
  assert.equal(reconciliation.transferredWei, q.reviewerFeeWei);
  assert.ok(reconciliation.chargedGasWei > 0n);
  await send(5, prepare(5, 'withdrawTo', [accounts[5].address]));
  assert.equal(await client.getBalance({ address: d.escrow }), 0n);
  const revoke = { approvalId, brandAuthority: q.buyer, expiresAt: (await client.getBlock()).timestamp + 900n, nonce: 1n };
  await send(8, prepare(8, 'revoke', [revoke, await signRevocation(accounts[6], config.chainId, d.registry, revoke)], 0n, true));
  assert.equal(await client.readContract({ address: d.registry, abi: releaseRegistryAbi, functionName: 'isValidApproval', args: [approvalId, envelope.deliveryCommitment, EXPORT_PURPOSE_HASH] }), false);
  const end = await client.getBlockNumber({ cacheTime: 0 });
  const firstScan = await scanContractEvents(client, d, d.fromBlock, end, { chunkSize: 2n });
  const secondScan = await scanContractEvents(client, d, d.fromBlock, end, { chunkSize: 3n });
  assert.deepEqual(firstScan.map((event) => event.id), secondScan.map((event) => event.id));
  assert.equal(new Set(firstScan.map((event) => event.id)).size, firstScan.length);
  assert.equal(firstScan.filter((event) => event.eventName === 'Withdrawal').length, 2);
  assert.ok(firstScan.every((event) => event.id.includes(event.blockHash.toLowerCase())));
  assert.equal(await client.readContract({ address: d.escrow, abi: reviewEscrowAbi, functionName: 'totalFundedWei' }), await client.readContract({ address: d.escrow, abi: reviewEscrowAbi, functionName: 'totalWithdrawnWei' }));
});

test('Deployment verification and event replay fail closed for wrong chain, code, signer and replaced block hash', async () => {
  const f = fixture;
  await assert.rejects(verifyDeployment(f.client, f.config, { ...f.deployment, escrowCodeHash: digest('wrong-code') }), /reviewed deployment manifest/);
  await assert.rejects(verifyDeployment(f.client, f.config, { ...f.deployment, expectedRoles: { quoteSigner: f.accounts[9].address } }), /configured signer/);
  const wrongChain = { ...f.client, getChainId: async () => f.config.chainId + 1 } as MePublicClient;
  await assert.rejects(verifyDeployment(wrongChain, f.config, f.deployment), /chain ID/);
  await assert.rejects(scanContractEvents(wrongChain, f.deployment, f.deployment.fromBlock, await f.client.getBlockNumber()), /wrong chain ID/);
  const replaced = { ...f.client, getBlock: async (parameters: any) => ({ ...await f.client.getBlock(parameters), hash: digest('replacement-block') }) } as unknown as MePublicClient;
  await assert.rejects(scanContractEvents(replaced, f.deployment, f.deployment.fromBlock, await f.client.getBlockNumber()), /no longer canonical/);
  await assert.rejects(scanContractEvents(f.client, f.deployment, f.deployment.fromBlock, await f.client.getBlockNumber() + 1n), /confirmation depth/);
});

test('Legacy receipts can use the signed transaction gasPrice; missing dynamic effective price fails closed', async () => {
  const f = fixture;
  const prepare = (paused: boolean): PreparedTransaction => ({ chainId: f.config.chainId, from: f.accounts[0].address, to: f.deployment.escrow, value: '0x0', data: encodeFunctionData({ abi: reviewEscrowAbi, functionName: 'setAdmissionsPaused', args: [paused] }) });
  const legacy = prepare(true);
  const hash = await f.wallets[0].sendTransaction({ to: legacy.to, data: legacy.data, gas: 200_000n, gasPrice: 2_000_000_000n, type: 'legacy' });
  const missingPrice = { ...f.client, getTransactionReceipt: async (parameters: any) => ({ ...await f.client.getTransactionReceipt(parameters), effectiveGasPrice: undefined }) } as unknown as MePublicClient;
  const verified = await verifyTransaction(missingPrice, legacy, hash, 1);
  assert.equal(verified.status, 'confirmed');
  assert.equal((verified as MinedTransactionVerification).effectiveGasPrice, 2_000_000_000n);
  const dynamic = prepare(false);
  const dynamicHash = await f.wallets[0].sendTransaction({ to: dynamic.to, data: dynamic.data, gas: 200_000n, type: 'eip1559' });
  await assert.rejects(verifyTransaction(missingPrice, dynamic, dynamicHash, 1), /gas price/);
});
