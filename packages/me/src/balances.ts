import type { Address, Hex } from 'viem';
import { MeChainError, type MePublicClient, type MinedTransactionVerification, type DecodedContractEvent } from './chain.js';

export interface BankBalanceEvidence {
  evmAddress: Address; bankAddress: string; denom: string; amountAtoms: bigint;
  blockNumber: bigint; blockHash: Hex; heightVerified: boolean; mappingVerified: boolean;
  evidenceReference: string;
}
export type BankBalanceReader = (input: { address: Address; blockNumber: bigint; blockHash: Hex }) => Promise<BankBalanceEvidence>;
export interface BalanceSnapshot {
  address: Address; blockNumber: bigint; blockHash: Hex; parentHash: Hex; blockTimestamp: bigint;
  blockTransactionCount: number; balanceWei: bigint; quantumWei: bigint;
  bank?: BankBalanceEvidence; bankStatus: 'verified' | 'unverified' | 'mismatch'; issues: string[];
}

/** Reads fixed block state. A bank reader must prove height AND the same 20-byte account mapping. */
export async function readBalanceSnapshot(client: MePublicClient, input: { address: Address; quantumWei: bigint; blockNumber?: bigint; bankReader?: BankBalanceReader }): Promise<BalanceSnapshot> {
  if (input.quantumWei <= 0n) throw new MeChainError('INVALID_QUANTUM', 'Positive quantum required');
  const block = input.blockNumber === undefined ? await client.getBlock() : await client.getBlock({ blockNumber: input.blockNumber });
  const balanceWei = await client.getBalance({ address: input.address, blockNumber: block.number });
  const issues: string[] = [];
  let bank: BankBalanceEvidence | undefined;
  let bankStatus: BalanceSnapshot['bankStatus'] = 'unverified';
  if (input.bankReader) {
    bank = await input.bankReader({ address: input.address, blockNumber: block.number, blockHash: block.hash });
    if (!bank.heightVerified || !bank.mappingVerified || !bank.evidenceReference || bank.blockNumber !== block.number || bank.blockHash.toLowerCase() !== block.hash.toLowerCase() || bank.evmAddress.toLowerCase() !== input.address.toLowerCase()) issues.push('BANK_HEIGHT_OR_ACCOUNT_MAPPING_UNVERIFIED');
    else if (bank.amountAtoms < 0n || bank.amountAtoms * input.quantumWei !== balanceWei) { bankStatus = 'mismatch'; issues.push('BANK_EVM_BALANCE_MISMATCH'); }
    else bankStatus = 'verified';
  } else issues.push('BANK_EVIDENCE_NOT_PROVIDED');
  const canonical = await client.getBlock({ blockNumber: block.number });
  if (canonical.hash.toLowerCase() !== block.hash.toLowerCase()) throw new MeChainError('REORG', 'Balance snapshot block changed during the read');
  return { address: input.address, blockNumber: block.number, blockHash: block.hash, parentHash: block.parentHash, blockTimestamp: block.timestamp, blockTransactionCount: block.transactions.length, balanceWei, quantumWei: input.quantumWei, bank, bankStatus, issues };
}

export interface WithdrawalReconciliation {
  status: 'verified' | 'evm-only' | 'unverified' | 'mismatch'; evmBalanced: boolean; bankVerified: boolean;
  nominalGasWei: bigint; chargedGasWei: bigint; transferredWei: bigint;
  gasCharging: 'exact-wei' | 'me-bank-ceil-prepay-floor-refund'; issues: string[];
  deltas: { address: Address; actualWei: bigint; expectedWei: bigint }[];
}

export function calculateGasCharge(input: { gasLimit: bigint; gasUsed: bigint; effectiveGasPrice: bigint; quantumWei: bigint; model: WithdrawalReconciliation['gasCharging'] }): bigint {
  const { gasLimit, gasUsed, effectiveGasPrice, quantumWei } = input;
  if (quantumWei <= 0n || gasUsed < 0n || gasLimit < gasUsed || effectiveGasPrice < 0n) throw new MeChainError('INVALID_GAS_EVIDENCE', 'Invalid gas quantities or quantum');
  if (input.model === 'exact-wei') return gasUsed * effectiveGasPrice;
  if (input.model !== 'me-bank-ceil-prepay-floor-refund') throw new MeChainError('UNKNOWN_GAS_MODEL', 'A verified gas charging model must be selected explicitly');
  const prepaidWei = gasLimit * effectiveGasPrice;
  const refundWei = (gasLimit - gasUsed) * effectiveGasPrice;
  return (((prepaidWei + quantumWei - 1n) / quantumWei) - refundWei / quantumWei) * quantumWei;
}

/** For an isolated withdrawal transaction. Arbitrary concurrent activity cannot be inferred away.
 * exact-wei is valid for the local EVM. A live ME rounding model requires separately verified evidence.
 */
export function reconcileWithdrawal(input: {
  before: BalanceSnapshot[]; after: BalanceSnapshot[]; receipt: MinedTransactionVerification;
  withdrawal: DecodedContractEvent; quantumWei: bigint; gasCharging: 'exact-wei' | 'me-bank-ceil-prepay-floor-refund';
}): WithdrawalReconciliation {
  const { receipt, withdrawal, quantumWei } = input;
  const issues: string[] = [];
  if (quantumWei <= 0n) throw new MeChainError('INVALID_QUANTUM', 'Positive quantum required');
  if (receipt.status !== 'confirmed' || receipt.executionStatus !== 'success' || withdrawal.eventName !== 'Withdrawal' || withdrawal.transactionHash.toLowerCase() !== receipt.hash.toLowerCase() || withdrawal.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase()) throw new MeChainError('INVALID_WITHDRAWAL_EVIDENCE', 'A confirmed matching Withdrawal event is required');
  const { beneficiary, receiver, amountWei } = withdrawal.args as { beneficiary: Address; receiver: Address; amountWei: bigint };
  if (typeof amountWei !== 'bigint' || amountWei <= 0n || amountWei % quantumWei !== 0n || beneficiary?.toLowerCase() !== receipt.from.toLowerCase() || withdrawal.address.toLowerCase() !== receipt.to.toLowerCase()) throw new MeChainError('INVALID_WITHDRAWAL_EVIDENCE', 'Withdrawal sender, amount or emitting escrow does not match the receipt');
  const nominalGasWei = receipt.gasUsed * receipt.effectiveGasPrice;
  // Official fork 08a9eaaee040: successful tx prepay rounds up; unused-gas refund rounds down.
  // Applying ceil(gasUsed * price / q) alone can undercount by one bank atom.
  const chargedGasWei = calculateGasCharge({ gasLimit: receipt.gasLimit, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice, quantumWei, model: input.gasCharging });
  const expected = new Map<string, { address: Address; delta: bigint }>();
  const add = (address: Address, delta: bigint) => { const key = address.toLowerCase(); expected.set(key, { address, delta: (expected.get(key)?.delta ?? 0n) + delta }); };
  add(receipt.to, -amountWei); add(receiver, amountWei); add(receipt.from, -chargedGasWei);
  const deltas: WithdrawalReconciliation['deltas'] = [];
  let bankVerified = true;
  let isolated = true;
  for (const [key, expectation] of expected) {
    const before = input.before.find((snapshot) => snapshot.address.toLowerCase() === key);
    const after = input.after.find((snapshot) => snapshot.address.toLowerCase() === key);
    if (!before || !after) { issues.push(`MISSING_SNAPSHOT:${key}`); bankVerified = false; isolated = false; continue; }
    const correctHeights = after.blockNumber === receipt.blockNumber && before.blockNumber + 1n === receipt.blockNumber;
    if (correctHeights && (after.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase() || after.parentHash.toLowerCase() !== before.blockHash.toLowerCase())) throw new MeChainError('REORG', 'Withdrawal receipt and adjacent balance snapshots no longer share a canonical chain');
    if (!correctHeights || after.blockTransactionCount !== 1 || before.quantumWei !== quantumWei || after.quantumWei !== quantumWei) { issues.push(`NON_ISOLATED_OR_WRONG_HEIGHT_SNAPSHOT:${key}`); isolated = false; }
    if (before.bankStatus !== 'verified' || after.bankStatus !== 'verified') bankVerified = false;
    const actualWei = after.balanceWei - before.balanceWei;
    deltas.push({ address: expectation.address, actualWei, expectedWei: expectation.delta });
    if (before.bankStatus === 'mismatch' || after.bankStatus === 'mismatch') issues.push(`BANK_EVM_BALANCE_MISMATCH:${key}`);
  }
  // An end-of-block balance includes every transaction in that block. Without an
  // isolated adjacent snapshot, disagreement with this withdrawal alone proves nothing.
  if (isolated) for (const delta of deltas) if (delta.actualWei !== delta.expectedWei) issues.push(`BALANCE_DELTA_MISMATCH:${delta.address.toLowerCase()}`);
  const mismatch = issues.some((issue) => issue.includes('MISMATCH'));
  const evmBalanced = isolated && issues.length === 0 && deltas.length === expected.size;
  return { status: !isolated ? 'unverified' : mismatch ? 'mismatch' : !evmBalanced ? 'unverified' : bankVerified ? 'verified' : 'evm-only', evmBalanced, bankVerified, nominalGasWei, chargedGasWei, transferredWei: amountWei, gasCharging: input.gasCharging, issues, deltas };
}
