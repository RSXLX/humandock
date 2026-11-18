import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeAbiParameters, encodeEventTopics, keccak256, stringToHex, type Address, type Hex } from 'viem';
import { Database } from '../../apps/api/src/storage.js';
import { MeWorkflow, type ChainIntent } from '../../apps/api/src/live-workflow.js';
import type { LiveSettings } from '../../apps/api/src/live-config.js';
import { walletUserId } from '../../apps/api/src/wallet-auth.js';
import type { User } from '../../packages/domain/src/model.js';
import { loadMeConfig } from '../../packages/me/src/config.js';
import { reviewEscrowAbi } from '../../packages/me/src/generated-abis.js';
import { decodeHumanDockLog, type DeploymentConfig, type MePublicClient, type MinedTransactionVerification, type RoleAddresses } from '../../packages/me/src/chain.js';
import { readBalanceSnapshot, reconcileWithdrawal } from '../../packages/me/src/balances.js';

const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const hash = (label: string) => keccak256(stringToHex(label));
const code = '0x60006000' as Hex;
const wallet = address(20);
const roles: RoleAddresses = { owner: address(10), quoteSigner: address(11), assignmentSigner: address(12), deliveryGate: address(13), arbitrator: address(14), platformRecipient: address(15) };
const network = loadMeConfig({ ME_NETWORK: 'local', ME_EVM_RPC_URL: 'http://127.0.0.1:18545', ME_EVM_CHAIN_ID: '31337', ME_NATIVE_SYMBOL: 'LOCAL', ME_BANK_DENOM: 'local_atom', ME_BANK_DECIMALS: '18', ME_QUANTUM_WEI: '1' });
const deployment = (escrow: number, registry: number): DeploymentConfig => ({ escrow: address(escrow), registry: address(registry), fromBlock: 1n, confirmations: 1, escrowCodeHash: keccak256(code), registryCodeHash: keccak256(code), expectedRoles: roles });
const firstDeployment = deployment(1, 2), secondDeployment = deployment(3, 4);
const user: User = { id: walletUserId(wallet), name: 'Explicit recovery-test actor', wallet, role: 'buyer', orgId: 'local-recovery-fixture', identity: { status: 'local_test', label: 'Synthetic RPC recovery fixture; no ME claim' } };
const now = Date.now();

type Block = { number: bigint; hash: Hex; parentHash: Hex; timestamp: bigint; transactions: Hex[] };
type RawLog = { address: Address; data: Hex; topics: Hex[]; blockNumber: bigint; blockHash: Hex; transactionHash: Hex; transactionIndex: number; logIndex: number; removed: boolean };

/** Mock only RPC responses; all cursor, intent, event and ledger writes use real PGlite. */
class RecoveryRpc {
  head = 10n;
  blocks = new Map<bigint, Block>();
  logs: RawLog[] = [];
  transactions = new Map<Hex, any>();
  receipts = new Map<Hex, any>();
  onLogs?: () => void;
  onBalance?: (address: Address, blockNumber: bigint) => void;
  readonly deployments = [firstDeployment, secondDeployment];
  readonly client: MePublicClient;
  constructor() {
    for (let n = 0n; n <= this.head; n++) this.blocks.set(n, this.block(n));
    this.client = {
      chain: { id: network.chainId },
      getChainId: async () => network.chainId,
      getBlockNumber: async () => this.head,
      getBlock: async (parameters: { blockNumber?: bigint } = {}) => {
        const block = this.blocks.get(parameters.blockNumber ?? this.head);
        assert.ok(block, 'RPC fixture must contain the requested block');
        return { ...block, transactions: [...block.transactions] };
      },
      getBytecode: async () => code,
      readContract: async (parameters: { address: Address; functionName: string }) => {
        if (parameters.functionName in roles) return roles[parameters.functionName as keyof RoleAddresses];
        if (parameters.functionName === 'escrow') return this.deployments.find(d => d.registry === parameters.address)?.escrow;
        if (parameters.functionName === 'quantumWei') return 1n;
        if (parameters.functionName === 'maxTaskFeeWei') return 100_000n;
        if (parameters.functionName === 'admissionsPaused') return false;
        if (parameters.functionName === 'claimableWei') return 100n;
        throw new Error(`Unexpected contract read ${parameters.functionName}`);
      },
      getLogs: async (parameters: { address: Address[]; fromBlock: bigint; toBlock: bigint }) => {
        this.onLogs?.();
        return this.logs.filter(log => parameters.address.includes(log.address) && log.blockNumber >= parameters.fromBlock && log.blockNumber <= parameters.toBlock);
      },
      call: async () => ({ data: '0x' }),
      getTransaction: async ({ hash: txHash }: { hash: Hex }) => {
        const tx = this.transactions.get(txHash); assert.ok(tx, 'Expected mocked transaction'); return { ...tx };
      },
      getTransactionReceipt: async ({ hash: txHash }: { hash: Hex }) => {
        const receipt = this.receipts.get(txHash); assert.ok(receipt, 'Expected mocked receipt'); return { ...receipt, logs: [...receipt.logs] };
      },
      getBalance: async ({ address: account, blockNumber }: { address: Address; blockNumber: bigint }) => {
        this.onBalance?.(account, blockNumber);
        return this.deployments.some(d => d.escrow.toLowerCase() === account.toLowerCase()) ? blockNumber <= 10n ? 100n : 0n : blockNumber <= 10n ? 100_000n : 79_100n;
      },
    } as unknown as MePublicClient;
  }
  block(number: bigint, fork = 'A'): Block {
    return { number, hash: hash(`${fork}:${number}`), parentHash: hash(`${fork}:${number - 1n}`), timestamp: BigInt(Math.floor(now / 1000)) + number, transactions: [] };
  }
  mineWithdrawal(intent: ChainIntent) {
    assert.ok(intent.transaction);
    const expected = intent.transaction, txHash = hash(`withdrawal:${intent.id}`), number = 11n;
    const block = { ...this.block(number), transactions: [txHash] };
    const log: RawLog = {
      address: expected.to, data: encodeAbiParameters([{ type: 'uint256' }], [100n]),
      topics: encodeEventTopics({ abi: reviewEscrowAbi, eventName: 'Withdrawal', args: { withdrawalId: 1n, beneficiary: expected.from, receiver: expected.from } }) as Hex[],
      blockNumber: number, blockHash: block.hash, transactionHash: txHash, transactionIndex: 0, logIndex: 0, removed: false,
    };
    this.head = number; this.blocks.set(number, block); this.logs.push(log);
    this.transactions.set(txHash, { hash: txHash, chainId: network.chainId, from: expected.from, to: expected.to, input: expected.data, value: BigInt(expected.value), blockHash: block.hash, blockNumber: number, transactionIndex: 0, nonce: 0, gas: 21_000n, gasPrice: 1n, type: 'legacy' });
    this.receipts.set(txHash, { transactionHash: txHash, from: expected.from, to: expected.to, blockNumber: number, blockHash: block.hash, transactionIndex: 0, status: 'success', gasUsed: 21_000n, effectiveGasPrice: 1n, logs: [log] });
    return { txHash, log, block };
  }
}

function settings(rpc: RecoveryRpc, d = firstDeployment): LiveSettings {
  return { network, deployment: d, client: rpc.client, signers: {}, reviewers: [], identitySecret: 'recovery-fixture-only-secret-at-least-32-characters', reviewerFeeWei: 100n, platformFeeWei: 0n, unitsVerified: true, syncIntervalMs: 0, gasCharging: 'exact-wei', identityVerifier: async () => { throw new Error('Recovery exits never require an identity admission'); } };
}
const cursorId = (d = firstDeployment) => `${network.chainId}:${d.escrow.toLowerCase()}:${d.registry.toLowerCase()}`;
async function withRecovery(work: (context: { rpc: RecoveryRpc; db: Database; workflow: MeWorkflow; live: LiveSettings }) => Promise<void>) {
  const rpc = new RecoveryRpc(), db = new Database({ dataDir: 'memory://' }), live = settings(rpc);
  await db.start(); const workflow = new MeWorkflow(db, live, () => now);
  try { await workflow.sync(); assert.equal(workflow.config().writesEnabled, true); await work({ rpc, db, workflow, live }); }
  finally { await workflow.stop(); await db.close(); }
}
const prepareWithdrawal = (workflow: MeWorkflow, db: Database) => db.transaction(sql => workflow.prepare(sql, user, 'withdraw', undefined, undefined));
const codeIs = (expected: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === expected;
async function assertDurablyBlocked(db: Database, workflow: MeWorkflow, live: LiveSettings) {
  const cursor = (await db.query<{ state: string }>('SELECT state FROM hd_chain_cursors WHERE id=$1', [cursorId(live.deployment)])).rows[0];
  assert.equal(cursor.state, 'reorg', 'A reorganization block must survive process restart');
  assert.equal(workflow.config().writesEnabled, false);
  const restarted = new MeWorkflow(db, live, () => now);
  try { await assert.rejects(restarted.sync(), codeIs('CHAIN_REPLAY_REQUIRED')); assert.equal(restarted.config().writesEnabled, false); }
  finally { await restarted.stop(); }
}

test('a fork beginning at the previous checkpoint during getLogs cannot splice financial events into the persisted projection', async () => {
  await withRecovery(async ({ rpc, db, workflow, live }) => {
    const intent = await prepareWithdrawal(workflow, db);
    rpc.mineWithdrawal(intent);
    const saved = (await db.query<{ next_block: string; last_hash: string }>('SELECT next_block,last_hash FROM hd_chain_cursors WHERE id=$1', [cursorId()])).rows[0];
    rpc.onLogs = () => {
      rpc.onLogs = undefined;
      rpc.blocks.set(10n, rpc.block(10n, 'B'));
      rpc.blocks.set(11n, { ...rpc.block(11n, 'B'), transactions: [rpc.logs[0].transactionHash] });
      rpc.logs[0] = { ...rpc.logs[0], blockHash: rpc.blocks.get(11n)!.hash };
    };
    await assert.rejects(workflow.sync(), codeIs('REORG'));
    const cursor = (await db.query<{ next_block: string; last_hash: string; state: string }>('SELECT * FROM hd_chain_cursors WHERE id=$1', [cursorId()])).rows[0];
    assert.equal(cursor.next_block, saved.next_block); assert.equal(cursor.last_hash, saved.last_hash);
    assert.equal((await db.query('SELECT id FROM hd_chain_events')).rows.length, 0);
    assert.equal((await db.query('SELECT id FROM hd_me_ledger')).rows.length, 0);
    await assertDurablyBlocked(db, workflow, live);
  });
});

test('a receipt reorganization persists the replay gate and never marks the withdrawal applied', async () => {
  await withRecovery(async ({ rpc, db, workflow, live }) => {
    const intent = await prepareWithdrawal(workflow, db), { txHash } = rpc.mineWithdrawal(intent);
    await db.transaction(sql => workflow.broadcast(sql, user, intent.id, txHash));
    rpc.blocks.set(11n, rpc.block(11n, 'B'));
    const result = await workflow.reconcile(user, intent.id);
    assert.equal(result.intent.status, 'reorged'); assert.equal(result.intent.applied, false);
    assert.equal(result.intent.error?.code, 'REORG');
    assert.equal((await db.query('SELECT id FROM hd_chain_events')).rows.length, 0);
    assert.equal((await db.query('SELECT id FROM hd_me_ledger')).rows.length, 0);
    await assertDurablyBlocked(db, workflow, live);
  });
});

test('a withdrawal balance snapshot reorganization cannot be downgraded to unavailable historical data', async () => {
  await withRecovery(async ({ rpc, db, workflow, live }) => {
    const intent = await prepareWithdrawal(workflow, db), { txHash } = rpc.mineWithdrawal(intent);
    await db.transaction(sql => workflow.broadcast(sql, user, intent.id, txHash));
    rpc.onBalance = (_account, height) => { if (height === 11n) { rpc.onBalance = undefined; rpc.blocks.set(11n, rpc.block(11n, 'B')); } };
    // Either a returned reorged view or an explicit API REORG error is acceptable;
    // durable state, not the exception surface, is the required financial invariant.
    await workflow.reconcile(user, intent.id).catch(error => { assert.ok(codeIs('REORG')(error) || codeIs('CHAIN_REORG')(error)); });
    const saved = await workflow.intent(db, intent.id, user);
    assert.equal(saved.view.status, 'reorged'); assert.equal(saved.view.applied, false);
    await assertDurablyBlocked(db, workflow, live);
  });
});

test('ordinary historical balance unavailability preserves the confirmed withdrawal while labelling its balance reconciliation unverified', async () => {
  await withRecovery(async ({ rpc, db, workflow }) => {
    const intent = await prepareWithdrawal(workflow, db), { txHash } = rpc.mineWithdrawal(intent);
    await db.transaction(sql => workflow.broadcast(sql, user, intent.id, txHash));
    rpc.onBalance = () => { throw new Error('Historical balance archive unavailable'); };
    const result = await workflow.reconcile(user, intent.id);
    assert.equal(result.intent.status, 'confirmed'); assert.equal(result.intent.applied, true);
    assert.equal(result.intent.reconciliation?.status, 'unverified');
    assert.equal((await db.query('SELECT id FROM hd_chain_events')).rows.length, 1);
    assert.equal((await db.query('SELECT id FROM hd_me_ledger')).rows.length, 2);
    assert.equal((await db.query<{ state: string }>('SELECT state FROM hd_chain_cursors WHERE id=$1', [cursorId()])).rows[0].state, 'healthy');
    assert.equal(workflow.config().writesEnabled, true);
  });
});

test('task-less active withdrawal intents are scoped by deployment while same-deployment duplicates remain blocked', async () => {
  await withRecovery(async ({ rpc, db, workflow }) => {
    const first = await prepareWithdrawal(workflow, db);
    const other = new MeWorkflow(db, settings(rpc, secondDeployment), () => now);
    try {
      await other.sync();
      const second = await prepareWithdrawal(other, db);
      assert.notEqual(first.id, second.id);
      assert.equal((await db.query('SELECT id FROM hd_me_intents')).rows.length, 2);
      assert.deepEqual((await workflow.listIntents(user)).map(i => i.id), [first.id]);
      assert.deepEqual((await other.listIntents(user)).map(i => i.id), [second.id]);
      await assert.rejects(other.intent(db, first.id, user), codeIs('NOT_FOUND'));
      await assert.rejects(workflow.intent(db, second.id, user), codeIs('NOT_FOUND'));
      await assert.rejects(prepareWithdrawal(workflow, db), codeIs('INTENT_PENDING'));
      await assert.rejects(prepareWithdrawal(other, db), codeIs('INTENT_PENDING'));
      assert.equal((await db.query('SELECT id FROM hd_me_intents')).rows.length, 2, 'Rejected duplicates roll back without adding another intent');
    } finally { await other.stop(); }
  });
});

async function reconciliationFixture() {
  const rpc = new RecoveryRpc();
  // This minimal intent only seeds a deterministic mocked transaction for pure balance tests.
  const intent = { id: 'balance-fixture', transaction: { chainId: network.chainId, from: wallet, to: firstDeployment.escrow, data: '0x', value: '0x0' } } as unknown as ChainIntent;
  const { log, block, txHash } = rpc.mineWithdrawal(intent);
  const receipt: MinedTransactionVerification = { status: 'confirmed', executionStatus: 'success', hash: txHash, chainId: network.chainId, from: wallet, to: firstDeployment.escrow, value: 0n, blockNumber: 11n, blockHash: block.hash, blockTimestamp: block.timestamp, transactionIndex: 0, confirmations: 1n, requiredConfirmations: 1, events: [decodeHumanDockLog(log, network.chainId, 'escrow')], gasUsed: 21_000n, gasLimit: 21_000n, effectiveGasPrice: 1n };
  const addresses = [wallet, firstDeployment.escrow];
  const before = await Promise.all(addresses.map(address => readBalanceSnapshot(rpc.client, { address, quantumWei: 1n, blockNumber: 10n })));
  const after = await Promise.all(addresses.map(address => readBalanceSnapshot(rpc.client, { address, quantumWei: 1n, blockNumber: 11n })));
  return { rpc, receipt, before, after, withdrawal: receipt.events[0], quantumWei: 1n, gasCharging: 'exact-wei' as const };
}

test('busy-block balance deltas are unverified evidence, while a genuinely isolated incorrect delta remains a mismatch', async () => {
  const fixture = await reconciliationFixture();
  const ordinary = reconcileWithdrawal(fixture);
  assert.equal(ordinary.status, 'evm-only'); assert.equal(ordinary.evmBalanced, true);
  const extraActivity = fixture.after.map(snapshot => ({ ...snapshot, blockTransactionCount: 2, balanceWei: snapshot.address === wallet ? snapshot.balanceWei + 500n : snapshot.balanceWei }));
  const busy = reconcileWithdrawal({ ...fixture, after: extraActivity });
  assert.equal(busy.status, 'unverified'); assert.equal(busy.evmBalanced, false);
  assert.ok(busy.issues.some(issue => issue.startsWith('NON_ISOLATED_OR_WRONG_HEIGHT_SNAPSHOT')));
  assert.ok(!busy.issues.some(issue => issue.startsWith('BALANCE_DELTA_MISMATCH')));
  const isolated = reconcileWithdrawal({ ...fixture, after: extraActivity.map(snapshot => ({ ...snapshot, blockTransactionCount: 1 })) });
  assert.equal(isolated.status, 'mismatch'); assert.ok(isolated.issues.some(issue => issue.startsWith('BALANCE_DELTA_MISMATCH')));
});

test('individually stable withdrawal snapshots must still match the receipt hash and adjacent parent hash', async () => {
  const fixture = await reconciliationFixture();
  for (const after of [
    fixture.after.map(snapshot => ({ ...snapshot, blockHash: hash('other-receipt-fork') })),
    fixture.after.map(snapshot => ({ ...snapshot, parentHash: hash('other-parent-fork') })),
  ]) assert.throws(() => reconcileWithdrawal({ ...fixture, after }), codeIs('REORG'));
});
