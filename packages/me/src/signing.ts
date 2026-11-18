import { recoverTypedDataAddress, type Address, type Hex, type LocalAccount } from 'viem';
import { quoteTypedData, assignmentTypedData, deliveryTypedData, approvalTypedData, revocationTypedData, type Quote, type AssignmentPermit, type DeliveryEnvelope, type ApprovalIntent, type RevocationIntent } from './contracts.js';

/** Signers are explicit dependencies. This module never loads keys or environment files. */
export const signQuote = (signer: LocalAccount, chainId: number, escrow: Address, quote: Quote) => signer.signTypedData(quoteTypedData(chainId, escrow, quote));
export const signAssignment = (signer: LocalAccount, chainId: number, escrow: Address, permit: AssignmentPermit) => signer.signTypedData(assignmentTypedData(chainId, escrow, permit));
export const signDelivery = (signer: LocalAccount, chainId: number, escrow: Address, envelope: DeliveryEnvelope) => signer.signTypedData(deliveryTypedData(chainId, escrow, envelope));
export const signApproval = (signer: LocalAccount, chainId: number, registry: Address, intent: ApprovalIntent) => signer.signTypedData(approvalTypedData(chainId, registry, intent));
export const signRevocation = (signer: LocalAccount, chainId: number, registry: Address, intent: RevocationIntent) => signer.signTypedData(revocationTypedData(chainId, registry, intent));
export const recoverDeliverySigner = (chainId: number, escrow: Address, envelope: DeliveryEnvelope, signature: Hex) => recoverTypedDataAddress({ ...deliveryTypedData(chainId, escrow, envelope), signature });
export const recoverApprovalSigner = (chainId: number, registry: Address, intent: ApprovalIntent, signature: Hex) => recoverTypedDataAddress({ ...approvalTypedData(chainId, registry, intent), signature });
