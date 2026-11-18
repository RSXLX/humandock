import type { TypedData, WalletChain, WalletTransaction } from "./wallet";
export type Role = "buyer" | "reviewer" | "outsider";
export type Channel = "tiktok_text" | "instagram_text" | "youtube_text" | "x_text";
export type Verdict = "PASS" | "CHANGES_REQUIRED" | "BLOCK";
export type CheckResult = "OK" | "ISSUE" | "UNKNOWN";
export type Criterion = "factual_consistency" | "naturalness" | "brand_voice" | "misleading_claims" | "channel_format";
export type User = { id: string; name: string; role: Role; orgId: string; wallet: string; identity: Identity };
export type Session = { user: User | null; csrfToken: string | null; mode: "demo" | "me" };
export type Health = { ok: boolean; mode: "demo" | "me"; storage: "pglite" | "postgres"; chain: { status: "not_configured" | "configured_unverified" | "checking" | "ready" | "blocked"; name: string }; ai: { mode: "rules" | "provider" }; version: string };
export type Check = { criterion: Criterion; result: CheckResult; comment: string; evidenceRefs: string[] };
export type AssetVersion = { id: string; text: string; contentHash: string; createdAt: string };
export type Quote = { id: string; reviewerAtoms: string; platformAtoms: string; totalAtoms: string; quantumAtoms: string; currency: string; expiresAt: string; acceptUntil: string };
export type Report = { id: string; reviewedVersionId: string; verdict: Verdict; summary: string; checks: Check[]; deliveryCommitment: string; submittedAt: string };
export type Approval = { id: string; versionId: string; deliveryCommitment: string; scope: string; expiresAt: string; revokedAt: string | null; approvedAt: string };
export type TimelineEvent = { id: string; type: string; label: string; at: string; actorId: string; executionMode: "demo" | "me" };
export type TaskStatus = "DRAFT" | "FUNDED" | "ASSIGNED" | "SUBMITTED" | "DISPUTED" | "CLOSED";
export type Task = { id: string; orgId: string; buyerId: string; reviewerId: string; title: string; sourceText: string; facts: string; channel: Channel; locale: "en-US"; status: TaskStatus; version: number; sourceVersionId: string; currentVersionId: string; sourceCommitment: string | null; versions: AssetVersion[]; quote: Quote | null; report: Report | null; approval: Approval | null; createdAt: string; updatedAt: string; acceptedAt: string | null; deliveryDue: string | null; challengeUntil: string | null; arbitrationUntil: string | null; closureReason: string | null; disputeReason: string | null; timeline: TimelineEvent[]; executionMode: "demo" | "me"; chain?: { chainId: number; escrow: string; registry: string; taskId?: string; lastTxHash?: string; blockNumber?: string; blockHash?: string } };
export type Balances = { executionMode?: "demo" | "me"; walletBalanceAtoms?: string; block?: ChainBlock; reconciliationStatus?: string; currency: string; claimableAtoms: string; withdrawnAtoms: string; escrowedAtoms: string; entries: { id: string; type: string; amountAtoms: string; at: string; taskId: string | null }[] };
export type ExportRecord = { id: string; filename: string; downloadUrl: string; receiptUrl: string; verifiedAt: string; executionMode: "demo" | "me" };
export type TaskInput = { reviewerWallet?: string; title: string; sourceText: string; facts: string; channel: Channel; locale: "en-US" };
export type ReportInput = { reviewedText: string; verdict: Verdict; summary: string; checks: Check[] };
export type Notice = { kind: "success" | "error"; message: string };
export const CRITERIA: { key: Criterion; title: string; help: string }[] = [
  { key: "factual_consistency", title: "Factual consistency", help: "Does the copy stay within the supplied product facts?" },
  { key: "naturalness", title: "Natural US English", help: "Is the language clear and natural for the intended reader?" },
  { key: "brand_voice", title: "Brand voice", help: "Does the tone fit the brand and audience in the brief?" },
  { key: "misleading_claims", title: "Unsupported claims", help: "Flag promises the supplied facts cannot support. This is not legal certification." },
  { key: "channel_format", title: "Channel fit", help: "Check the agreed text format and intent; not platform approval." },
];
export const CHANNELS: Record<Channel, string> = { tiktok_text: "TikTok · text", instagram_text: "Instagram · text", youtube_text: "YouTube · text", x_text: "X · text" };

export type Identity = { status: "demo" | "pending" | "verified" | "local_test" | "rejected" | "unavailable"; label: string; checkedAt?: string; kycLevel?: string | number; policyReference?: string };
export type ChainBlock = { number: string; hash: string; timestamp?: number | string };
export type MeConfig = {
  mode: "me"; status: "not_configured" | "checking" | "ready" | "blocked";
  writesEnabled: boolean; admissionsEnabled: boolean; reasons: string[]; admissionReasons: string[];
  network: { kind: "local" | "me-testnet" | "me-mainnet"; chainId: number; chainName: string; nativeSymbol: string; evmDecimals: 18; bankDecimals: number; bankDenom: string; quantumWei: string } | null;
  walletChain?: WalletChain; contracts: { escrow: string; registry: string } | null;
  confirmations: number; localTest: boolean;
};
export type Reviewer = { wallet: string; name: string };
export type IntentAction = "fund" | "accept-assignment" | "reviews" | "accept-service" | "approvals" | "revoke" | "cancel" | "disputes" | "timeouts" | "withdraw";
export type IntentStatus = "awaiting_signature" | "ready" | "broadcast" | "confirming" | "confirmed" | "reverted" | "reorged" | "expired" | "rejected" | "replaced";
export type IntentRequest = { taskId?: string; action: IntentAction; expectedVersion?: number; payload?: Record<string, unknown> };
export type TransactionIntent = {
  id: string; taskId?: string | null; action: IntentAction; status: IntentStatus;
  account: string; chainId: number; allowedTargets: string[];
  summary: { title: string; description: string; amountWei: string; symbol: string; versionId?: string; deliveryCommitment?: string; receiver?: string; withdrawalAmountWei?: string };
  expiresAt: string; typedData?: TypedData; transaction?: WalletTransaction; txHash?: string;
  confirmations: number; requiredConfirmations: number; block?: ChainBlock;
  applied: boolean; error?: { code: string; message: string }; reconciliation?: Record<string, unknown>;
};
