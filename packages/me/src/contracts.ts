import { encodeAbiParameters, hashTypedData, keccak256, stringToHex, type Address, type Hex } from 'viem';

export const ESCROW_DOMAIN_NAME = 'HumanDockReviewEscrow';
export const REGISTRY_DOMAIN_NAME = 'HumanDockReleaseRegistry';
export const DELIVERY_SCHEMA_HASH = keccak256(stringToHex('HumanDockDeliveryV1'));
export const EXPORT_PURPOSE_HASH = keccak256(stringToHex('HUMANDOCK_CONTROLLED_EXPORT_V1'));
export const TASK_COMMITMENT_DOMAIN = keccak256(stringToHex('HumanDock/SOURCE/v1'));
export const DELIVERY_COMMITMENT_DOMAIN = keccak256(stringToHex('HumanDock/FINAL/v1'));
export const Verdict = { NONE: 0, PASS: 1, CHANGES_REQUIRED: 2, BLOCK: 3 } as const;
export const EscrowState = { NONE: 0, FUNDED: 1, ASSIGNED: 2, SUBMITTED: 3, DISPUTED: 4, CLOSED: 5 } as const;
export const ClosureReason = { NONE: 0, NORMAL: 1, BUYER_CANCELLED: 2, UNASSIGNED_EXPIRED: 3, DELIVERY_EXPIRED: 4, ARBITRATED: 5, ARBITRATION_TIMEOUT: 6 } as const;

/** All money fields are EVM wei; never JavaScript Number or bank-denom amounts. */
export interface Quote {
  buyer: Address; clientRequestId: Hex; taskCommitment: Hex; buyerPrincipal: Hex;
  reviewerFeeWei: bigint; platformFeeWei: bigint; quantumWei: bigint;
  acceptUntil: bigint; reviewDuration: number; expiresAt: bigint; nonce: bigint;
}
export interface AssignmentPermit {
  taskId: bigint; taskCommitment: Hex; termsHash: Hex; buyer: Address; reviewer: Address;
  reviewerPrincipal: Hex; expiresAt: bigint; nonce: bigint;
}
export interface DeliveryEnvelope {
  taskId: bigint; taskCommitment: Hex; deliveryCommitment: Hex; reviewer: Address;
  verdict: number; schemaHash: Hex; issuedAt: bigint; expiresAt: bigint; nonce: bigint;
}
export interface ApprovalIntent {
  escrow: Address; taskId: bigint; brandAuthority: Address; deliveryCommitment: Hex;
  purposeHash: Hex; expiresAt: bigint; nonce: bigint;
}
export interface RevocationIntent {
  approvalId: Hex; brandAuthority: Address; expiresAt: bigint; nonce: bigint;
}

export const quoteTypes = { Quote: [
  { name: 'buyer', type: 'address' }, { name: 'clientRequestId', type: 'bytes32' },
  { name: 'taskCommitment', type: 'bytes32' }, { name: 'buyerPrincipal', type: 'bytes32' },
  { name: 'reviewerFeeWei', type: 'uint256' }, { name: 'platformFeeWei', type: 'uint256' },
  { name: 'quantumWei', type: 'uint256' }, { name: 'acceptUntil', type: 'uint64' },
  { name: 'reviewDuration', type: 'uint32' }, { name: 'expiresAt', type: 'uint64' },
  { name: 'nonce', type: 'uint256' },
] } as const;
export const assignmentTypes = { AssignmentPermit: [
  { name: 'taskId', type: 'uint256' }, { name: 'taskCommitment', type: 'bytes32' },
  { name: 'termsHash', type: 'bytes32' }, { name: 'buyer', type: 'address' },
  { name: 'reviewer', type: 'address' }, { name: 'reviewerPrincipal', type: 'bytes32' },
  { name: 'expiresAt', type: 'uint64' }, { name: 'nonce', type: 'uint256' },
] } as const;
export const deliveryTypes = { DeliveryEnvelope: [
  { name: 'taskId', type: 'uint256' }, { name: 'taskCommitment', type: 'bytes32' },
  { name: 'deliveryCommitment', type: 'bytes32' }, { name: 'reviewer', type: 'address' },
  { name: 'verdict', type: 'uint8' }, { name: 'schemaHash', type: 'bytes32' },
  { name: 'issuedAt', type: 'uint64' }, { name: 'expiresAt', type: 'uint64' },
  { name: 'nonce', type: 'uint256' },
] } as const;
export const approvalTypes = { ApprovalIntent: [
  { name: 'escrow', type: 'address' }, { name: 'taskId', type: 'uint256' },
  { name: 'brandAuthority', type: 'address' }, { name: 'deliveryCommitment', type: 'bytes32' },
  { name: 'purposeHash', type: 'bytes32' }, { name: 'expiresAt', type: 'uint64' },
  { name: 'nonce', type: 'uint256' },
] } as const;
export const revocationTypes = { RevocationIntent: [
  { name: 'approvalId', type: 'bytes32' }, { name: 'brandAuthority', type: 'address' },
  { name: 'expiresAt', type: 'uint64' }, { name: 'nonce', type: 'uint256' },
] } as const;

function domain(name: string, chainId: number, verifyingContract: Address) {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('Invalid EVM chainId');
  return { name, version: '1', chainId, verifyingContract } as const;
}
export const quoteTypedData = (chainId: number, escrow: Address, message: Quote) => ({ domain: domain(ESCROW_DOMAIN_NAME, chainId, escrow), types: quoteTypes, primaryType: 'Quote' as const, message });
export const assignmentTypedData = (chainId: number, escrow: Address, message: AssignmentPermit) => ({ domain: domain(ESCROW_DOMAIN_NAME, chainId, escrow), types: assignmentTypes, primaryType: 'AssignmentPermit' as const, message });
export const deliveryTypedData = (chainId: number, escrow: Address, message: DeliveryEnvelope) => ({ domain: domain(ESCROW_DOMAIN_NAME, chainId, escrow), types: deliveryTypes, primaryType: 'DeliveryEnvelope' as const, message });
export const approvalTypedData = (chainId: number, registry: Address, message: ApprovalIntent) => ({ domain: domain(REGISTRY_DOMAIN_NAME, chainId, registry), types: approvalTypes, primaryType: 'ApprovalIntent' as const, message });
export const revocationTypedData = (chainId: number, registry: Address, message: RevocationIntent) => ({ domain: domain(REGISTRY_DOMAIN_NAME, chainId, registry), types: revocationTypes, primaryType: 'RevocationIntent' as const, message });
export const hashQuote = (chainId: number, escrow: Address, quote: Quote) => hashTypedData(quoteTypedData(chainId, escrow, quote));

/** Input hash and salt stay private. Use independent CSPRNG salts for source/final. */
export function saltedCommitment(kind: 'task' | 'delivery', manifestHash: Hex, salt: Hex): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(manifestHash) || !/^0x[0-9a-fA-F]{64}$/.test(salt)) throw new Error('Expected 32-byte manifest hash and salt');
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }], [kind === 'task' ? TASK_COMMITMENT_DOMAIN : DELIVERY_COMMITMENT_DOMAIN, manifestHash, salt]));
}

export function assertQuantumAmount(amountWei: bigint, quantumWei: bigint): void {
  if (quantumWei <= 0n || amountWei < 0n || amountWei % quantumWei !== 0n) throw new Error('Amount is not representable by deployment quantum');
}

/** Dispute-only split: platform gets zero; all P and W rounding remainder go to buyer. */
export function disputeAllocation(reviewerFeeWei: bigint, platformFeeWei: bigint, quantumWei: bigint, alphaBps: bigint) {
  assertQuantumAmount(reviewerFeeWei, quantumWei);
  assertQuantumAmount(platformFeeWei, quantumWei);
  if (reviewerFeeWei === 0n || alphaBps < 0n || alphaBps > 10_000n) throw new Error('Invalid dispute terms');
  const reviewerWei = ((reviewerFeeWei / quantumWei) * alphaBps / 10_000n) * quantumWei;
  return { reviewerWei, platformWei: 0n, buyerWei: reviewerFeeWei + platformFeeWei - reviewerWei };
}
