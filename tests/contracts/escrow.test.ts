import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import ganache from 'ganache';
import solc from 'solc';
import {
  createPublicClient, createWalletClient, custom, defineChain, hashTypedData,
  keccak256, stringToHex, encodeFunctionData, type Abi, type Address, type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { compileContracts } from '../../scripts/compile-contracts.js';
import {
  quoteTypedData, assignmentTypedData, deliveryTypedData, approvalTypedData, revocationTypedData,
  DELIVERY_SCHEMA_HASH, EXPORT_PURPOSE_HASH, Verdict, EscrowState, ClosureReason,
  disputeAllocation, type Quote, type AssignmentPermit, type DeliveryEnvelope, type ApprovalIntent,
} from '../../packages/me/src/contracts.js';

const artifacts = await compileContracts(false);
const chainId = 31337;
const quantum = 10_000_000_000n;
const chain = defineChain({ id: chainId, name: 'HumanDock isolated EVM test', nativeCurrency: { name: 'Test only', symbol: 'TEST', decimals: 18 }, rpcUrls: { default: { http: ['http://127.0.0.1'] } } });
const hash = (value: string) => keccak256(stringToHex(value));
const escrowAbi = artifacts.ReviewEscrow.abi as Abi;
const registryAbi = artifacts.ReleaseRegistry.abi as Abi;

const receiversSource = `// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;
interface IEscrow { function withdrawTo(address payable receiver) external; }
contract RejectingReceiver { receive() external payable { revert("NO"); } }
contract ReenteringBuyer {
  address public immutable owner; IEscrow public immutable escrow;
  uint256 public attempts; bool public reentrySucceeded;
  constructor(address e) { owner = msg.sender; escrow = IEscrow(e); }
  function forward(address target, bytes calldata data) external payable {
    require(msg.sender == owner); (bool ok, bytes memory result) = target.call{value:msg.value}(data);
    if (!ok) assembly { revert(add(result, 32), mload(result)) }
  }
  receive() external payable {
    attempts++; try escrow.withdrawTo(payable(address(this))) { reentrySucceeded = true; } catch {}
  }
}
contract ForcedDonation { constructor(address payable target) payable { selfdestruct(target); } }
`;
const receiversOutput = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'Receivers.sol': { content: receiversSource } }, settings: { evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } })));
const receivers = receiversOutput.contracts['Receivers.sol'] as Record<string, { abi: Abi; evm: { bytecode: { object: string } } }>;

async function fixture(t: TestContext) {
  const provider = ganache.provider({ logging: { quiet: true }, wallet: { deterministic: true, totalAccounts: 12, defaultBalance: 1000 }, chain: { chainId, hardfork: 'merge' }, miner: { timestampIncrement: 0 } });
  t.after(async () => { await provider.disconnect(); });
  const accounts = Object.values(provider.getInitialAccounts()).map(({ secretKey }) => privateKeyToAccount(secretKey as Hex));
  const transport = custom(provider as any);
  const publicClient = createPublicClient({ chain, transport, pollingInterval: 1, cacheTime: 0 });
  const wallets = accounts.map((account) => createWalletClient({ chain, transport, account }));
  // 0 owner, 1 quote issuer, 2 assignment issuer, 3 delivery gate, 4 arbitrator,
  // 5 platform, 6 buyer, 7 reviewer, 8 unrelated caller/keeper, 9 another reviewer.
  async function deploy(abi: Abi, bytecode: Hex, args: readonly unknown[] = []) {
    const txHash = await wallets[0].deployContract({ abi, bytecode, args, gas: 15_000_000n });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    assert.equal(receipt.status, 'success');
    assert.ok(receipt.contractAddress);
    return receipt.contractAddress;
  }
  const escrow = await deploy(escrowAbi, artifacts.ReviewEscrow.bytecode, [accounts[0].address, accounts[1].address, accounts[2].address, accounts[3].address, accounts[4].address, accounts[5].address, quantum, 10_000n * quantum]);
  const registry = await deploy(registryAbi, artifacts.ReleaseRegistry.bytecode, [escrow]);
  const read = (functionName: string, args: readonly unknown[] = []) => publicClient.readContract({ address: escrow, abi: escrowAbi, functionName, args }) as Promise<any>;
  const readRegistry = (functionName: string, args: readonly unknown[] = []) => publicClient.readContract({ address: registry, abi: registryAbi, functionName, args }) as Promise<any>;
  async function call(actor: number, functionName: string, args: readonly unknown[] = [], value = 0n, registryCall = false, expectedStatus: 'success' | 'reverted' = 'success') {
    const txHash = await wallets[actor].writeContract({ address: registryCall ? registry : escrow, abi: registryCall ? registryAbi : escrowAbi, functionName, args, value, gas: 5_000_000n });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    assert.equal(receipt.status, expectedStatus, `${functionName} expected ${expectedStatus}`);
    return receipt;
  }
  const fail = (actor: number, name: string, args: readonly unknown[] = [], value = 0n, registryCall = false) => call(actor, name, args, value, registryCall, 'reverted');
  const now = async () => (await publicClient.getBlock()).timestamp;
  async function advanceTo(timestamp: bigint) {
    const current = await now();
    assert.ok(timestamp >= current);
    await provider.request({ method: 'evm_increaseTime', params: [Number(timestamp - current)] });
    await provider.request({ method: 'evm_mine', params: [] });
    assert.equal(await now(), timestamp);
  }
  let nonce = 0n;
  async function quote(overrides: Partial<Quote> = {}): Promise<Quote> {
    const stamp = await now(); const n = ++nonce;
    return { buyer: accounts[6].address, clientRequestId: hash(`request-${n}`), taskCommitment: hash(`salted-task-${n}`), buyerPrincipal: hash(`private-task-buyer-${n}`), reviewerFeeWei: 101n * quantum, platformFeeWei: 20n * quantum, quantumWei: quantum, acceptUntil: stamp + 3600n, reviewDuration: 86400, expiresAt: stamp + 1800n, nonce: n, ...overrides };
  }
  async function fund(overrides: Partial<Quote> = {}) {
    const q = await quote(overrides);
    const signature = await accounts[1].signTypedData(quoteTypedData(chainId, escrow, q));
    const taskId = await read('nextTaskId') as bigint;
    await call(6, 'createAndFund', [q, signature], q.reviewerFeeWei + q.platformFeeWei);
    assert.equal(await read('taskByClientRequest', [q.buyer, q.clientRequestId]), taskId);
    return { taskId, q, signature };
  }
  async function permit(taskId: bigint, overrides: Partial<AssignmentPermit> = {}): Promise<AssignmentPermit> {
    const task = await read('getTask', [taskId]);
    return { taskId, taskCommitment: task.taskCommitment, termsHash: task.termsHash, buyer: task.buyer, reviewer: accounts[7].address, reviewerPrincipal: hash(`private-task-reviewer-${taskId}`), expiresAt: task.acceptUntil, nonce: ++nonce, ...overrides };
  }
  async function assign(taskId: bigint, overrides: Partial<AssignmentPermit> = {}) {
    const p = await permit(taskId, overrides);
    const signature = await accounts[2].signTypedData(assignmentTypedData(chainId, escrow, p));
    await call(7, 'acceptAssignment', [p, signature]);
    return { p, signature };
  }
  async function envelope(taskId: bigint, overrides: Partial<DeliveryEnvelope> = {}): Promise<DeliveryEnvelope> {
    const task = await read('getTask', [taskId]); const stamp = await now();
    return { taskId, taskCommitment: task.taskCommitment, deliveryCommitment: hash(`salted-delivery-${taskId}-${++nonce}`), reviewer: accounts[7].address, verdict: Verdict.PASS, schemaHash: DELIVERY_SCHEMA_HASH, issuedAt: stamp, expiresAt: stamp + 900n, nonce: ++nonce, ...overrides };
  }
  async function deliver(taskId: bigint, overrides: Partial<DeliveryEnvelope> = {}) {
    const e = await envelope(taskId, overrides);
    const data = deliveryTypedData(chainId, escrow, e);
    const reviewerSignature = await accounts[7].signTypedData(data);
    const gateSignature = await accounts[3].signTypedData(data);
    await call(7, 'submitDelivery', [e, reviewerSignature, gateSignature]);
    return { e, reviewerSignature, gateSignature };
  }
  async function submitted(verdict: number = Verdict.PASS) {
    const f = await fund(); await assign(f.taskId); const d = await deliver(f.taskId, { verdict });
    return { ...f, ...d };
  }
  async function approval(taskId: bigint, overrides: Partial<ApprovalIntent> = {}) {
    const task = await read('getTask', [taskId]);
    const intent: ApprovalIntent = { escrow, taskId, brandAuthority: accounts[6].address, deliveryCommitment: task.deliveryCommitment, purposeHash: EXPORT_PURPOSE_HASH, expiresAt: await now() + 86400n, nonce: ++nonce, ...overrides };
    const typed = approvalTypedData(chainId, registry, intent);
    return { intent, signature: await accounts[6].signTypedData(typed), approvalId: hashTypedData(typed) };
  }
  async function invariant() {
    const funded = await read('totalFundedWei') as bigint;
    const locked = await read('totalLockedWei') as bigint;
    const claimable = await read('totalClaimableWei') as bigint;
    const withdrawn = await read('totalWithdrawnWei') as bigint;
    assert.equal(funded, locked + claimable + withdrawn);
    assert.ok(await publicClient.getBalance({ address: escrow }) >= locked + claimable);
    for (const amount of [funded, locked, claimable, withdrawn]) assert.equal(amount % quantum, 0n);
  }
  return { accounts, wallets, publicClient, provider, deploy, escrow, registry, read, readRegistry, call, fail, now, advanceTo, quote, fund, permit, assign, envelope, deliver, submitted, approval, invariant };
}

test('Paris contracts deploy; exact quote digest and representable native fee are enforced', async (t) => {
  const f = await fixture(t);
  const q = await f.quote();
  const data = quoteTypedData(chainId, f.escrow, q);
  assert.equal(await f.read('quoteDigest', [q]), hashTypedData(data));
  const sig = await f.accounts[1].signTypedData(data);
  await f.fail(6, 'createAndFund', [q, sig], q.reviewerFeeWei + q.platformFeeWei - 1n);
  const fractional = { ...q, reviewerFeeWei: q.reviewerFeeWei + 1n };
  await f.fail(6, 'createAndFund', [fractional, await f.accounts[1].signTypedData(quoteTypedData(chainId, f.escrow, fractional))], fractional.reviewerFeeWei + fractional.platformFeeWei);
  const wrongQ = { ...q, quantumWei: 1n };
  await f.fail(6, 'createAndFund', [wrongQ, await f.accounts[1].signTypedData(quoteTypedData(chainId, f.escrow, wrongQ))], q.reviewerFeeWei + q.platformFeeWei);
  await f.call(6, 'createAndFund', [q, sig], q.reviewerFeeWei + q.platformFeeWei);
  await f.fail(6, 'createAndFund', [q, sig], q.reviewerFeeWei + q.platformFeeWei);
  await f.invariant();
});

test('PASS approval is independent of payment; normal W/P credits and aggregate withdrawals conserve funds', async (t) => {
  const f = await fixture(t); const task = await f.submitted();
  const a = await f.approval(task.taskId);
  await f.call(8, 'approve', [a.intent, a.signature], 0n, true);
  assert.equal((await f.read('getTask', [task.taskId])).state, EscrowState.SUBMITTED);
  assert.equal(await f.read('totalClaimableWei'), 0n);
  for (let n = 0; n < 2; n++) assert.equal(await f.readRegistry('isValidApproval', [a.approvalId, task.e.deliveryCommitment, EXPORT_PURPOSE_HASH]), true);
  assert.equal(await f.readRegistry('isValidApproval', [a.approvalId, hash('changed-artifact'), EXPORT_PURPOSE_HASH]), false);
  await f.call(6, 'acceptService', [task.taskId]);
  assert.equal(await f.read('claimableWei', [f.accounts[7].address]), task.q.reviewerFeeWei);
  assert.equal(await f.read('claimableWei', [f.accounts[5].address]), task.q.platformFeeWei);
  assert.equal(await f.read('claimableWei', [f.accounts[6].address]), 0n);
  await f.fail(6, 'openDispute', [task.taskId, hash('evidence')]);
  const before = await f.publicClient.getBalance({ address: f.accounts[9].address });
  await f.call(7, 'withdrawTo', [f.accounts[9].address]);
  assert.equal(await f.publicClient.getBalance({ address: f.accounts[9].address }) - before, task.q.reviewerFeeWei);
  await f.call(5, 'withdrawTo', [f.accounts[5].address]);
  await f.fail(7, 'withdrawTo', [f.accounts[7].address]);
  assert.equal(await f.readRegistry('isValidApproval', [a.approvalId, task.e.deliveryCommitment, EXPORT_PURPOSE_HASH]), true);
  await f.invariant();
});

test('BLOCK and CHANGES_REQUIRED complete paid services but can never receive release approval', async (t) => {
  const f = await fixture(t);
  for (const verdict of [Verdict.BLOCK, Verdict.CHANGES_REQUIRED]) {
    const task = await f.submitted(verdict); const a = await f.approval(task.taskId);
    await f.fail(6, 'approve', [a.intent, a.signature], 0n, true);
    const stored = await f.read('getTask', [task.taskId]);
    await f.advanceTo(stored.challengeUntil);
    await f.call(8, 'settleAfterWindow', [task.taskId]);
    assert.equal((await f.read('getTask', [task.taskId])).closureReason, ClosureReason.NORMAL);
  }
  assert.equal(await f.read('claimableWei', [f.accounts[7].address]), 202n * quantum);
  assert.equal(await f.read('claimableWei', [f.accounts[5].address]), 40n * quantum);
  await f.invariant();
});

test('Unassigned cancellation and exact-deadline expiry return all F; strangers cannot cancel', async (t) => {
  const f = await fixture(t); const first = await f.fund();
  await f.fail(8, 'cancelUnassigned', [first.taskId]);
  await f.call(6, 'cancelUnassigned', [first.taskId]);
  await f.fail(6, 'cancelUnassigned', [first.taskId]);
  const second = await f.fund();
  await f.fail(8, 'expireUnassigned', [second.taskId]);
  const permit = await f.permit(second.taskId);
  const sig = await f.accounts[2].signTypedData(assignmentTypedData(chainId, f.escrow, permit));
  await f.advanceTo(second.q.acceptUntil);
  await f.fail(7, 'acceptAssignment', [permit, sig]);
  await f.call(8, 'expireUnassigned', [second.taskId]);
  assert.equal(await f.read('claimableWei', [f.accounts[6].address]), 242n * quantum);
  await f.invariant();
});

test('Accepted task starts its delivery clock at acceptance and fully refunds missed delivery', async (t) => {
  const f = await fixture(t); const task = await f.fund();
  await f.advanceTo(await f.now() + 600n); await f.assign(task.taskId);
  const stored = await f.read('getTask', [task.taskId]);
  assert.equal(stored.deliveryDue, stored.acceptedAt + BigInt(task.q.reviewDuration));
  await f.fail(6, 'cancelUnassigned', [task.taskId]);
  await f.fail(8, 'expireUndelivered', [task.taskId]);
  await f.advanceTo(stored.deliveryDue);
  const e = await f.envelope(task.taskId); const data = deliveryTypedData(chainId, f.escrow, e);
  await f.fail(7, 'submitDelivery', [e, await f.accounts[7].signTypedData(data), await f.accounts[3].signTypedData(data)]);
  await f.call(8, 'expireUndelivered', [task.taskId]);
  assert.equal(await f.read('claimableWei', [f.accounts[6].address]), 121n * quantum);
  await f.invariant();
});

test('Quote and assignment signatures bind chain, escrow, task, named reviewer, terms and canonical principal', async (t) => {
  const f = await fixture(t); const q = await f.quote();
  const wrongChain = await f.accounts[1].signTypedData(quoteTypedData(chainId + 1, f.escrow, q));
  await f.fail(6, 'createAndFund', [q, wrongChain], q.reviewerFeeWei + q.platformFeeWei);
  const wrongContract = await f.accounts[1].signTypedData(quoteTypedData(chainId, f.registry, q));
  await f.fail(6, 'createAndFund', [q, wrongContract], q.reviewerFeeWei + q.platformFeeWei);
  const first = await f.fund(); const second = await f.fund();
  const p = await f.permit(first.taskId); const sig = await f.accounts[2].signTypedData(assignmentTypedData(chainId, f.escrow, p));
  await f.fail(9, 'acceptAssignment', [p, sig]);
  await f.fail(7, 'acceptAssignment', [{ ...p, taskId: second.taskId }, sig]);
  const self = { ...p, reviewerPrincipal: first.q.buyerPrincipal };
  await f.fail(7, 'acceptAssignment', [self, await f.accounts[2].signTypedData(assignmentTypedData(chainId, f.escrow, self))]);
  const badTerms = { ...p, termsHash: hash('other-terms') };
  await f.fail(7, 'acceptAssignment', [badTerms, await f.accounts[2].signTypedData(assignmentTypedData(chainId, f.escrow, badTerms))]);
  await f.call(7, 'acceptAssignment', [p, sig]);
  const replay = await f.permit(second.taskId, { nonce: p.nonce });
  await f.fail(7, 'acceptAssignment', [replay, await f.accounts[2].signTypedData(assignmentTypedData(chainId, f.escrow, replay))]);
  await f.invariant();
});

test('Delivery needs matching reviewer and gate signatures, short freshness, correct schema and one immutable final commitment', async (t) => {
  const f = await fixture(t); const task = await f.fund(); await f.assign(task.taskId);
  const e = await f.envelope(task.taskId); const data = deliveryTypedData(chainId, f.escrow, e);
  const r = await f.accounts[7].signTypedData(data); const g = await f.accounts[3].signTypedData(data);
  await f.fail(7, 'submitDelivery', [e, r, r]);
  await f.fail(7, 'submitDelivery', [{ ...e, verdict: Verdict.BLOCK }, r, g]);
  await f.fail(8, 'submitDelivery', [e, r, g]);
  const long = { ...e, expiresAt: e.issuedAt + 901n };
  await f.fail(7, 'submitDelivery', [long, await f.accounts[7].signTypedData(deliveryTypedData(chainId, f.escrow, long)), await f.accounts[3].signTypedData(deliveryTypedData(chainId, f.escrow, long))]);
  const badSchema = { ...e, schemaHash: hash('unknown-schema') };
  await f.fail(7, 'submitDelivery', [badSchema, await f.accounts[7].signTypedData(deliveryTypedData(chainId, f.escrow, badSchema)), await f.accounts[3].signTypedData(deliveryTypedData(chainId, f.escrow, badSchema))]);
  await f.advanceTo(e.expiresAt);
  await f.fail(7, 'submitDelivery', [e, r, g]);
  const valid = await f.deliver(task.taskId);
  await f.fail(7, 'submitDelivery', [valid.e, valid.reviewerSignature, valid.gateSignature]);
  assert.equal((await f.read('getTask', [task.taskId])).deliveryCommitment, valid.e.deliveryCommitment);
});

test('Pause only blocks new funds and new assignments; delivery, dispute, arbitration and withdrawals remain live', async (t) => {
  const f = await fixture(t); const accepted = await f.fund(); await f.assign(accepted.taskId);
  const open = await f.fund(); const p = await f.permit(open.taskId);
  const pSig = await f.accounts[2].signTypedData(assignmentTypedData(chainId, f.escrow, p));
  await f.fail(8, 'setAdmissionsPaused', [true]);
  await f.call(0, 'setAdmissionsPaused', [true]);
  const q = await f.quote(); const qSig = await f.accounts[1].signTypedData(quoteTypedData(chainId, f.escrow, q));
  await f.fail(6, 'createAndFund', [q, qSig], q.reviewerFeeWei + q.platformFeeWei);
  await f.fail(7, 'acceptAssignment', [p, pSig]);
  await f.deliver(accepted.taskId);
  await f.call(6, 'openDispute', [accepted.taskId, hash('private-evidence')]);
  await f.call(4, 'resolveDispute', [accepted.taskId, 10000n, hash('private-decision')]);
  await f.call(6, 'cancelUnassigned', [open.taskId]);
  await f.call(6, 'withdrawTo', [f.accounts[6].address]);
  await f.call(7, 'withdrawTo', [f.accounts[7].address]);
  await f.invariant();
});

test('Arbitration rounds W in quantum units, refunds all P, and conserves money across alpha boundaries', async (t) => {
  const f = await fixture(t); let reviewer = 0n; let buyer = 0n;
  for (const alpha of [0n, 1n, 3333n, 5000n, 9999n, 10000n]) {
    const task = await f.submitted();
    await f.call(6, 'openDispute', [task.taskId, hash('salted-evidence')]);
    await f.fail(8, 'resolveDispute', [task.taskId, alpha, hash('salted-decision')]);
    await f.fail(4, 'resolveDispute', [task.taskId, 10001n, hash('salted-decision')]);
    await f.call(4, 'resolveDispute', [task.taskId, alpha, hash('salted-decision')]);
    await f.fail(4, 'resolveDispute', [task.taskId, alpha, hash('salted-decision')]);
    const split = disputeAllocation(task.q.reviewerFeeWei, task.q.platformFeeWei, quantum, alpha);
    reviewer += split.reviewerWei; buyer += split.buyerWei;
    await f.invariant();
  }
  assert.equal(await f.read('claimableWei', [f.accounts[7].address]), reviewer);
  assert.equal(await f.read('claimableWei', [f.accounts[6].address]), buyer);
  assert.equal(await f.read('claimableWei', [f.accounts[5].address]), 0n);
});

test('Exact arbitration timeout finalizes 50% of W rounded down, all P to buyer; no arbiter or pause can lock funds', async (t) => {
  const f = await fixture(t); const task = await f.submitted();
  await f.call(6, 'openDispute', [task.taskId, hash('evidence')]);
  const disputed = await f.read('getTask', [task.taskId]);
  assert.equal(disputed.arbitrationUntil, await f.now() + 72n * 3600n);
  await f.fail(6, 'openDispute', [task.taskId, hash('additional-evidence')]);
  assert.equal((await f.read('getTask', [task.taskId])).arbitrationUntil, disputed.arbitrationUntil);
  await f.fail(8, 'finalizeDisputeTimeout', [task.taskId]);
  await f.call(0, 'setAdmissionsPaused', [true]);
  await f.advanceTo(disputed.arbitrationUntil);
  await f.fail(4, 'resolveDispute', [task.taskId, 10000n, hash('late-decision')]);
  await f.call(8, 'finalizeDisputeTimeout', [task.taskId]);
  assert.equal(await f.read('claimableWei', [f.accounts[7].address]), 50n * quantum);
  assert.equal(await f.read('claimableWei', [f.accounts[6].address]), 71n * quantum);
  assert.equal(await f.read('claimableWei', [f.accounts[5].address]), 0n);
  await f.call(7, 'withdrawTo', [f.accounts[7].address]);
  await f.call(6, 'withdrawTo', [f.accounts[6].address]);
  assert.equal(await f.publicClient.getBalance({ address: f.escrow }), 0n);
  await f.invariant();
});

test('Challenge boundary has no overlap: dispute fails at deadline and settlement works during pause', async (t) => {
  const f = await fixture(t); const task = await f.submitted();
  const stored = await f.read('getTask', [task.taskId]);
  assert.equal(stored.challengeUntil, await f.now() + 48n * 3600n);
  await f.fail(8, 'settleAfterWindow', [task.taskId]);
  await f.call(0, 'setAdmissionsPaused', [true]);
  await f.advanceTo(stored.challengeUntil);
  await f.fail(6, 'openDispute', [task.taskId, hash('late-evidence')]);
  await f.call(8, 'settleAfterWindow', [task.taskId]);
  await f.fail(8, 'settleAfterWindow', [task.taskId]);
  await f.invariant();
});

test('Release approval/revocation prevents reviewer authority, replay, wrong domain, changed scope and expired export', async (t) => {
  const f = await fixture(t); const task = await f.submitted(); const a = await f.approval(task.taskId);
  const reviewerSignature = await f.accounts[7].signTypedData(approvalTypedData(chainId, f.registry, a.intent));
  await f.fail(7, 'approve', [a.intent, reviewerSignature], 0n, true);
  const wrongScope = await f.approval(task.taskId, { purposeHash: hash('UNSUPPORTED_EXTERNAL_PUBLISH') });
  await f.fail(6, 'approve', [wrongScope.intent, wrongScope.signature], 0n, true);
  const wrongVersion = await f.approval(task.taskId, { deliveryCommitment: hash('different-version') });
  await f.fail(6, 'approve', [wrongVersion.intent, wrongVersion.signature], 0n, true);
  const wrongChain = await f.accounts[6].signTypedData(approvalTypedData(chainId + 1, f.registry, a.intent));
  await f.fail(6, 'approve', [a.intent, wrongChain], 0n, true);
  await f.call(8, 'approve', [a.intent, a.signature], 0n, true);
  await f.fail(8, 'approve', [a.intent, a.signature], 0n, true);
  const revoke = { approvalId: a.approvalId, brandAuthority: f.accounts[6].address, expiresAt: await f.now() + 3600n, nonce: 9n };
  const revokeSig = await f.accounts[6].signTypedData(revocationTypedData(chainId, f.registry, revoke));
  await f.call(8, 'revoke', [revoke, revokeSig], 0n, true);
  await f.fail(8, 'revoke', [revoke, revokeSig], 0n, true);
  assert.equal(await f.readRegistry('isValidApproval', [a.approvalId, task.e.deliveryCommitment, EXPORT_PURPOSE_HASH]), false);
  const renewed = await f.approval(task.taskId, { expiresAt: await f.now() + 10n });
  await f.call(6, 'approve', [renewed.intent, renewed.signature], 0n, true);
  await f.advanceTo(renewed.intent.expiresAt);
  assert.equal(await f.readRegistry('isValidApproval', [renewed.approvalId, task.e.deliveryCommitment, EXPORT_PURPOSE_HASH]), false);
  assert.equal(await f.read('totalLockedWei'), 121n * quantum);
});

test('Receiver failure rolls back credits and an unrelated wallet cannot withdraw someone else’s credit', async (t) => {
  const f = await fixture(t); const task = await f.fund(); await f.call(6, 'cancelUnassigned', [task.taskId]);
  const reject = await f.deploy(receivers.RejectingReceiver.abi, `0x${receivers.RejectingReceiver.evm.bytecode.object}`);
  await f.fail(6, 'withdrawTo', [reject]);
  assert.equal(await f.read('claimableWei', [f.accounts[6].address]), 121n * quantum);
  assert.equal(await f.read('totalWithdrawnWei'), 0n);
  await f.fail(8, 'withdrawTo', [f.accounts[6].address]);
  await f.call(6, 'withdrawTo', [f.accounts[9].address]);
  await f.invariant();
});

test('Contract beneficiary reentrancy cannot withdraw twice; forced surplus does not change liabilities', async (t) => {
  const f = await fixture(t);
  const actor = await f.deploy(receivers.ReenteringBuyer.abi, `0x${receivers.ReenteringBuyer.evm.bytecode.object}`, [f.escrow]);
  async function forward(data: Hex, value = 0n) {
    const txHash = await f.wallets[0].writeContract({ address: actor, abi: receivers.ReenteringBuyer.abi, functionName: 'forward', args: [f.escrow, data], value, gas: 5_000_000n });
    assert.equal((await f.publicClient.waitForTransactionReceipt({ hash: txHash })).status, 'success');
  }
  const q = await f.quote({ buyer: actor });
  const signature = await f.accounts[1].signTypedData(quoteTypedData(chainId, f.escrow, q));
  const taskId = await f.read('nextTaskId');
  await forward(encodeFunctionData({ abi: escrowAbi, functionName: 'createAndFund', args: [q, signature] }), 121n * quantum);
  await forward(encodeFunctionData({ abi: escrowAbi, functionName: 'cancelUnassigned', args: [taskId] }));
  await forward(encodeFunctionData({ abi: escrowAbi, functionName: 'withdrawTo', args: [actor] }));
  assert.equal(await f.publicClient.readContract({ address: actor, abi: receivers.ReenteringBuyer.abi, functionName: 'attempts' }), 1n);
  assert.equal(await f.publicClient.readContract({ address: actor, abi: receivers.ReenteringBuyer.abi, functionName: 'reentrySucceeded' }), false);
  assert.equal(await f.read('claimableWei', [actor]), 0n);
  assert.equal(await f.read('totalWithdrawnWei'), 121n * quantum);
  const donation = await f.wallets[0].deployContract({ abi: receivers.ForcedDonation.abi, bytecode: `0x${receivers.ForcedDonation.evm.bytecode.object}`, args: [f.escrow], value: quantum, gas: 1_000_000n });
  assert.equal((await f.publicClient.waitForTransactionReceipt({ hash: donation })).status, 'success');
  assert.equal(await f.publicClient.getBalance({ address: f.escrow }), quantum);
  assert.equal(await f.read('totalClaimableWei'), 0n);
  await f.invariant();
});
