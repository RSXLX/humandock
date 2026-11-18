import {
  createPublicClient, defineChain, http, keccak256, decodeEventLog, decodeFunctionData,
  isAddress, isHex, TransactionNotFoundError, TransactionReceiptNotFoundError,
  type Address, type Hex, type Transport, type Abi,
} from 'viem';
import type { MeNetworkConfig } from './config.js';
import { reviewEscrowAbi, releaseRegistryAbi } from './generated-abis.js';

export interface PreparedTransaction { chainId: number; from: Address; to: Address; data: Hex; value: Hex }
export interface RoleAddresses { owner: Address; quoteSigner: Address; assignmentSigner: Address; deliveryGate: Address; arbitrator: Address; platformRecipient: Address }
export interface DeploymentConfig {
  escrow: Address; registry: Address; fromBlock: bigint; confirmations: number;
  escrowCodeHash: Hex; registryCodeHash: Hex;
  expectedRoles?: Partial<RoleAddresses>;
}
export class MeChainError extends Error {
  override name = 'MeChainError';
  constructor(public readonly code: string, message: string) { super(message); }
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const zeroAddress = '0x0000000000000000000000000000000000000000';
function requireCondition(condition: unknown, code: string, message: string): asserts condition { if (!condition) throw new MeChainError(code, message); }
function validConfirmations(value: number) { requireCondition(Number.isSafeInteger(value) && value >= 1, 'INVALID_CONFIRMATIONS', 'Explicit confirmations must be a positive safe integer'); }

export function createMePublicClient(config: MeNetworkConfig, options: { transport?: Transport } = {}) {
  const chain = defineChain({
    id: config.chainId, name: `HumanDock ${config.network}`,
    nativeCurrency: { name: config.nativeSymbol, symbol: config.nativeSymbol, decimals: config.evmDecimals },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });
  return createPublicClient({ chain, transport: options.transport ?? http(config.rpcUrl, { timeout: 15_000, retryCount: 1 }), cacheTime: 0, pollingInterval: 1_000 });
}
export type MePublicClient = ReturnType<typeof createMePublicClient>;

export async function verifyDeployment(client: MePublicClient, config: MeNetworkConfig, deployment: DeploymentConfig) {
  validConfirmations(deployment.confirmations);
  requireCondition(isAddress(deployment.escrow) && isAddress(deployment.registry) && !same(deployment.escrow, deployment.registry), 'INVALID_DEPLOYMENT', 'Distinct escrow and registry addresses are required');
  requireCondition(deployment.fromBlock >= 0n, 'INVALID_DEPLOYMENT', 'Deployment start block must be nonnegative');
  for (const h of [deployment.escrowCodeHash, deployment.registryCodeHash]) requireCondition(/^0x[0-9a-fA-F]{64}$/.test(h), 'INVALID_CODE_HASH', 'Expected deployed runtime code hashes are required');
  const chainId = await client.getChainId();
  requireCondition(chainId === config.chainId, 'CHAIN_MISMATCH', 'RPC chain ID does not match configuration');
  const head = await client.getBlockNumber({ cacheTime: 0 });
  const confirmedHeight = head - BigInt(deployment.confirmations) + 1n;
  requireCondition(confirmedHeight >= 0n, 'DEPLOYMENT_NOT_CONFIRMED', 'Deployment has not reached the configured confirmation depth');
  const block = await client.getBlock({ blockNumber: confirmedHeight });
  requireCondition(block.number >= deployment.fromBlock, 'DEPLOYMENT_NOT_REACHED', 'RPC is behind the deployment start block');
  const [escrowCode, registryCode] = await Promise.all([
    client.getBytecode({ address: deployment.escrow, blockNumber: block.number }),
    client.getBytecode({ address: deployment.registry, blockNumber: block.number }),
  ]);
  requireCondition(escrowCode && escrowCode !== '0x' && registryCode && registryCode !== '0x', 'MISSING_CODE', 'Expected contract code is absent');
  requireCondition(same(keccak256(escrowCode), deployment.escrowCodeHash) && same(keccak256(registryCode), deployment.registryCodeHash), 'CODE_HASH_MISMATCH', 'Runtime code does not match the reviewed deployment manifest');
  const escrowRead = (functionName: 'owner' | 'quoteSigner' | 'assignmentSigner' | 'deliveryGate' | 'arbitrator' | 'platformRecipient' | 'quantumWei' | 'maxTaskFeeWei' | 'admissionsPaused') => client.readContract({ address: deployment.escrow, abi: reviewEscrowAbi, functionName, blockNumber: block.number });
  const roleNames = ['owner', 'quoteSigner', 'assignmentSigner', 'deliveryGate', 'arbitrator', 'platformRecipient'] as const;
  const [registryEscrow, quantumWei, maxTaskFeeWei, admissionsPaused, ...roleValues] = await Promise.all([
    client.readContract({ address: deployment.registry, abi: releaseRegistryAbi, functionName: 'escrow', blockNumber: block.number }),
    escrowRead('quantumWei'), escrowRead('maxTaskFeeWei'), escrowRead('admissionsPaused'), ...roleNames.map(escrowRead),
  ]);
  requireCondition(same(registryEscrow as Address, deployment.escrow), 'REGISTRY_ESCROW_MISMATCH', 'Registry points to a different escrow');
  requireCondition(quantumWei === config.quantumWei, 'QUANTUM_MISMATCH', 'Configured amount quantum differs from immutable escrow quantum');
  const roles = Object.fromEntries(roleNames.map((name, index) => [name, roleValues[index]])) as unknown as RoleAddresses;
  for (const name of roleNames) {
    requireCondition(isAddress(roles[name]) && (name === 'owner' || !same(roles[name], zeroAddress)), 'INVALID_ROLE', `Invalid deployed ${name}`);
    const expected = deployment.expectedRoles?.[name];
    if (expected) requireCondition(same(roles[name], expected), 'ROLE_MISMATCH', `Deployed ${name} differs from configured signer`);
  }
  const canonical = await client.getBlock({ blockNumber: block.number });
  requireCondition(same(canonical.hash, block.hash), 'REORG', 'Deployment verification crossed a reorganization');
  return { ready: true as const, chainId, checkedAtBlock: block.number, blockHash: block.hash, roles, quantumWei: quantumWei as bigint, maxTaskFeeWei: maxTaskFeeWei as bigint, admissionsPaused: admissionsPaused as boolean, escrow: deployment.escrow, registry: deployment.registry };
}

export interface DecodedContractEvent {
  /** Includes blockHash: a replacement-fork event must never be silently discarded. */
  id: string; chainId: number; contract: 'escrow' | 'registry'; address: Address;
  eventName: string; args: Record<string, unknown>; blockNumber: bigint; blockHash: Hex;
  transactionHash: Hex; transactionIndex: number; logIndex: number;
}
type CompleteLog = { address: Address; data: Hex; topics: readonly Hex[]; blockNumber: bigint | null; blockHash: Hex | null; transactionHash: Hex | null; transactionIndex: number | null; logIndex: number | null; removed?: boolean };
export function decodeHumanDockLog(log: CompleteLog, chainId: number, contract: 'escrow' | 'registry'): DecodedContractEvent {
  requireCondition(!log.removed && log.blockNumber !== null && log.blockHash !== null && log.transactionHash !== null && log.transactionIndex !== null && log.logIndex !== null, 'NONCANONICAL_LOG', 'Removed or incomplete logs cannot update a financial projection');
  const abi = contract === 'escrow' ? reviewEscrowAbi : releaseRegistryAbi;
  let decoded: { eventName: string; args?: unknown };
  try { decoded = decodeEventLog({ abi: abi as Abi, data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true }); }
  catch { throw new MeChainError('UNDECODABLE_LOG', 'An expected contract emitted a log that does not match its pinned ABI'); }
  const id = `${chainId}:${log.address.toLowerCase()}:${log.blockHash.toLowerCase()}:${log.transactionHash.toLowerCase()}:${log.logIndex}`;
  return { id, chainId, contract, address: log.address, eventName: decoded.eventName, args: decoded.args as Record<string, unknown> ?? {}, blockNumber: log.blockNumber, blockHash: log.blockHash, transactionHash: log.transactionHash, transactionIndex: log.transactionIndex, logIndex: log.logIndex };
}

export interface MinedTransactionVerification {
  status: 'confirming' | 'confirmed' | 'reverted'; executionStatus: 'success' | 'reverted';
  hash: Hex; chainId: number; from: Address; to: Address; value: bigint;
  blockNumber: bigint; blockHash: Hex; blockTimestamp: bigint; transactionIndex: number;
  confirmations: bigint; requiredConfirmations: number; events: DecodedContractEvent[];
  gasUsed: bigint; gasLimit: bigint; effectiveGasPrice: bigint;
}
export type TransactionVerification = { status: 'pending'; hash: Hex; chainId: number } | MinedTransactionVerification;

/** Exact transaction intent AND canonical receipt verification. Broadcast hashes are not payment evidence. */
export async function verifyTransaction(client: MePublicClient, expected: PreparedTransaction, hash: Hex, confirmations: number): Promise<TransactionVerification> {
  validConfirmations(confirmations);
  requireCondition(isAddress(expected.from) && isAddress(expected.to) && isHex(expected.data) && /^0x[0-9a-fA-F]+$/.test(expected.value) && /^0x[0-9a-fA-F]{64}$/.test(hash), 'INVALID_INTENT', 'Malformed prepared transaction or hash');
  const chainId = await client.getChainId();
  requireCondition(chainId === expected.chainId, 'CHAIN_MISMATCH', 'Transaction verification is on the wrong chain');
  let transaction;
  try { transaction = await client.getTransaction({ hash }); }
  catch (error) { if (error instanceof TransactionNotFoundError) return { status: 'pending', hash, chainId }; throw error; }
  requireCondition(transaction.to && same(transaction.to, expected.to) && same(transaction.from, expected.from) && transaction.value === BigInt(expected.value) && same(transaction.input, expected.data), 'INTENT_MISMATCH', 'Transaction sender, target, calldata or value differs from the persisted intent');
  if (transaction.chainId !== undefined) requireCondition(transaction.chainId === expected.chainId, 'CHAIN_MISMATCH', 'Signed transaction has a different chain ID');
  let receipt;
  try { receipt = await client.getTransactionReceipt({ hash }); }
  catch (error) { if (error instanceof TransactionReceiptNotFoundError) return { status: 'pending', hash, chainId }; throw error; }
  requireCondition(receipt.to && same(receipt.to, expected.to) && same(receipt.from, expected.from) && same(receipt.transactionHash, hash), 'RECEIPT_MISMATCH', 'Receipt does not match the intended transaction');
  const [block, latest] = await Promise.all([client.getBlock({ blockNumber: receipt.blockNumber }), client.getBlockNumber({ cacheTime: 0 })]);
  requireCondition(same(block.hash, receipt.blockHash) && transaction.blockHash && same(transaction.blockHash, receipt.blockHash), 'REORG', 'Transaction receipt is no longer canonical');
  requireCondition(latest >= receipt.blockNumber, 'RPC_INCONSISTENT', 'Latest block is behind the receipt');
  let contract: 'escrow' | 'registry'; let action: string;
  try { action = decodeFunctionData({ abi: reviewEscrowAbi, data: expected.data }).functionName; contract = 'escrow'; }
  catch {
    try { action = decodeFunctionData({ abi: releaseRegistryAbi, data: expected.data }).functionName; contract = 'registry'; }
    catch { throw new MeChainError('UNKNOWN_ACTION', 'Transaction calldata is not a supported HumanDock contract action'); }
  }
  const events = receipt.logs.filter((log) => same(log.address, expected.to)).map((log) => decodeHumanDockLog(log, chainId, contract));
  const eventByAction: Record<string, string> = { createAndFund: 'TaskFunded', acceptAssignment: 'TaskAssigned', submitDelivery: 'DeliverySubmitted', openDispute: 'DisputeOpened', cancelUnassigned: 'TaskClosed', expireUnassigned: 'TaskClosed', expireUndelivered: 'TaskClosed', acceptService: 'TaskClosed', settleAfterWindow: 'TaskClosed', resolveDispute: 'TaskClosed', finalizeDisputeTimeout: 'TaskClosed', withdrawTo: 'Withdrawal', approve: 'ReleaseApproved', revoke: 'ReleaseRevoked', setAdmissionsPaused: 'AdmissionsPauseChanged', transferOwnership: 'OwnershipTransferred', renounceOwnership: 'OwnershipTransferred' };
  requireCondition(eventByAction[action], 'UNKNOWN_ACTION', 'Only supported state-changing HumanDock actions can confirm an intent');
  if (receipt.status === 'success') requireCondition(events.filter((event) => event.eventName === eventByAction[action]).length === 1, 'EXPECTED_EVENT_MISSING', 'Successful transaction did not emit exactly one expected action event');
  const count = latest - receipt.blockNumber + 1n;
  const effectiveGasPrice = receipt.effectiveGasPrice ?? (transaction.type === 'legacy' || transaction.type === 'eip2930' ? transaction.gasPrice : undefined);
  requireCondition(typeof effectiveGasPrice === 'bigint' && effectiveGasPrice >= 0n, 'GAS_PRICE_UNVERIFIED', 'Receipt lacks effective gas price and transaction has no legacy gas price fallback');
  return { status: count < BigInt(confirmations) ? 'confirming' : receipt.status === 'success' ? 'confirmed' : 'reverted', executionStatus: receipt.status, hash, chainId, from: transaction.from, to: expected.to, value: transaction.value, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, blockTimestamp: block.timestamp, transactionIndex: receipt.transactionIndex, confirmations: count, requiredConfirmations: confirmations, events, gasUsed: receipt.gasUsed, gasLimit: transaction.gas, effectiveGasPrice };
}

/** Re-scanning overlapping ranges is safe when event.id is the database uniqueness key.
 * Persist the caller's checkpoint and all effects in the same database transaction.
 * Compare saved checkpoint block hashes before advancing; a detected fork must roll back projections.
 */
export async function scanContractEvents(client: MePublicClient, deployment: DeploymentConfig, from: bigint, to: bigint, options: { chunkSize?: bigint } = {}): Promise<DecodedContractEvent[]> {
  validConfirmations(deployment.confirmations);
  requireCondition(from >= deployment.fromBlock && to >= from, 'INVALID_RANGE', 'Event scan must begin at or after deployment and have an ordered range');
  const chunk = options.chunkSize ?? 500n;
  requireCondition(chunk > 0n && chunk <= 5000n, 'INVALID_CHUNK', 'Chunk size must be 1..5000 blocks');
  const [chainId, latest] = await Promise.all([client.getChainId(), client.getBlockNumber({ cacheTime: 0 })]);
  requireCondition(chainId === client.chain.id, 'CHAIN_MISMATCH', 'Event RPC has the wrong chain ID');
  requireCondition(to + BigInt(deployment.confirmations) - 1n <= latest, 'UNCONFIRMED_RANGE', 'Event range has not reached the configured confirmation depth');
  const events = new Map<string, DecodedContractEvent>();
  for (let start = from; start <= to; start += chunk) {
    const end = start + chunk - 1n > to ? to : start + chunk - 1n;
    const logs = await client.getLogs({ address: [deployment.escrow, deployment.registry], fromBlock: start, toBlock: end });
    const blocks = new Map<bigint, Hex>();
    for (const log of logs) {
      const kind = same(log.address, deployment.escrow) ? 'escrow' : same(log.address, deployment.registry) ? 'registry' : undefined;
      requireCondition(kind, 'UNEXPECTED_EMITTER', 'RPC returned a log outside the requested contract set');
      const event = decodeHumanDockLog(log, chainId, kind);
      requireCondition(event.blockNumber >= start && event.blockNumber <= end, 'RPC_INCONSISTENT', 'RPC returned a log outside the requested block range');
      const existingHash = blocks.get(event.blockNumber);
      requireCondition(!existingHash || same(existingHash, event.blockHash), 'REORG', 'Conflicting block hashes in one log response');
      blocks.set(event.blockNumber, event.blockHash);
      const previous = events.get(event.id);
      if (previous) {
        const serialize = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
        requireCondition(previous.eventName === event.eventName && serialize(previous.args) === serialize(event.args), 'CONFLICTING_LOG', 'RPC returned conflicting payloads for one canonical event ID');
      }
      events.set(event.id, event);
    }
    // Bounded concurrency is preferable to a request for every block in an empty range.
    for (const [number, expectedHash] of blocks) {
      const actual = await client.getBlock({ blockNumber: number });
      requireCondition(same(actual.hash, expectedHash), 'REORG', 'Event block is no longer canonical');
    }
  }
  return [...events.values()].sort((a, b) => a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex);
}
