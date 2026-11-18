export const CRITERIA = ['factual_consistency', 'naturalness', 'brand_voice', 'misleading_claims', 'channel_format'] as const;
export type Criterion = typeof CRITERIA[number];
export type Verdict = 'PASS' | 'CHANGES_REQUIRED' | 'BLOCK';
export type Status = 'DRAFT' | 'FUNDED' | 'ASSIGNED' | 'SUBMITTED' | 'DISPUTED' | 'CLOSED';
export type Role = 'buyer' | 'reviewer' | 'outsider';
export type Check = { criterion: Criterion; result: 'OK' | 'ISSUE' | 'UNKNOWN'; comment: string; evidenceRefs: string[] };
export type User = { id: string; name: string; role: Role; orgId: string; wallet: string; identity: { status: 'demo'; label: string } };
export type AssetVersion = { id: string; text: string; contentHash: string; createdAt: string };
export type Quote = { id: string; reviewerAtoms: string; platformAtoms: string; totalAtoms: string; quantumAtoms: string; currency: 'DEMO'; expiresAt: string; acceptUntil: string };
export type Report = { id: string; reviewedVersionId: string; verdict: Verdict; summary: string; checks: Check[]; deliveryCommitment: string; submittedAt: string };
export type Approval = { id: string; versionId: string; deliveryCommitment: string; scope: string; expiresAt: string; revokedAt: string | null; approvedAt: string };
export type TimelineEvent = { id: string; type: string; label: string; at: string; actorId: string; executionMode: 'demo' };
export type Task = {
  id: string; orgId: string; buyerId: string; reviewerId: string; title: string;
  sourceText: string; facts: string; channel: string; locale: 'en-US'; status: Status; version: number;
  sourceVersionId: string; currentVersionId: string; sourceCommitment: string | null;
  versions: AssetVersion[]; quote: Quote | null; report: Report | null; approval: Approval | null;
  createdAt: string; updatedAt: string; acceptedAt: string | null; deliveryDue: string | null;
  challengeUntil: string | null; arbitrationUntil: string | null; closureReason: string | null;
  disputeReason: string | null; timeline: TimelineEvent[]; executionMode: 'demo';
};
export type PrivateTask = Task & { secrets: { sourceSalt: string; finalSalt: string | null; sourceManifest: Record<string, unknown>; finalManifest: Record<string, unknown> | null; approvalHistory?: Approval[] } };
export type Allocation = { accountId: string; amountAtoms: bigint };

export class DomainError extends Error {
  constructor(public code: string, message: string, public statusCode = 409) { super(message); }
}
export function requireThat(condition: unknown, code: string, message: string, status = 409): asserts condition {
  if (!condition) throw new DomainError(code, message, status);
}
export function publicTask(task: PrivateTask): Task {
  const { secrets: _secrets, ...view } = structuredClone(task);
  return view;
}
