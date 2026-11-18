import { randomUUID } from 'node:crypto';
import { canonicalJson, commitment, randomSalt, textHash } from './commitments.js';
import { CRITERIA, requireThat, type Allocation, type Check, type PrivateTask, type User, type Verdict } from './model.js';

export const HOUR = 60 * 60 * 1000;
export const DEMO_QUANTUM = 10_000_000_000n;
export const DEMO_REVIEWER_ID = 'demo-reviewer';
export const DEMO_USERS: Record<string, User> = {
  buyer: { id: 'demo-buyer', name: 'Brand studio', role: 'buyer', orgId: 'demo-brand', wallet: '0x1111111111111111111111111111111111111111', identity: { status: 'demo', label: 'Local test identity — not ME verified' } },
  reviewer: { id: DEMO_REVIEWER_ID, name: 'Invited reviewer', role: 'reviewer', orgId: 'demo-reviewer-org', wallet: '0x2222222222222222222222222222222222222222', identity: { status: 'demo', label: 'Local test identity — not ME verified' } },
  outsider: { id: 'demo-outsider', name: 'Other organization', role: 'outsider', orgId: 'demo-other-brand', wallet: '0x3333333333333333333333333333333333333333', identity: { status: 'demo', label: 'Local test identity — not ME verified' } },
};
const iso = (time: number) => new Date(time).toISOString();
export function record(task: PrivateTask, user: User, type: string, label: string, now: number) {
  task.timeline.push({ id: randomUUID(), type, label, at: iso(now), actorId: user.id, executionMode: 'demo' });
  task.updatedAt = iso(now); task.version++;
}
export function canRead(task: PrivateTask, user: User) {
  return task.orgId === user.orgId || (user.id === task.reviewerId && task.status !== 'DRAFT');
}
export function assertRead(task: PrivateTask, user: User) {
  requireThat(canRead(task, user), 'NOT_FOUND', 'Task not found.', 404);
}
export function assertBuyer(task: PrivateTask, user: User) {
  assertRead(task, user); requireThat(task.buyerId === user.id, 'BUYER_REQUIRED', 'Only the task buyer can do this.', 403);
}
export function expected(task: PrivateTask, version: number) {
  requireThat(task.version === version, 'VERSION_CONFLICT', 'Task changed. Refresh and review the current state.');
}
export function createTask(user: User, input: { title: string; sourceText: string; facts: string; channel: string; locale: 'en-US' }, now: number): PrivateTask {
  requireThat(user.role !== 'reviewer', 'BUYER_REQUIRED', 'Use a brand account to create a task.', 403);
  const id = randomUUID(), versionId = randomUUID();
  const sourceManifest = { schemaVersion: 'source.v1', taskId: id, versionId, sourceHash: textHash(input.sourceText), factsHash: textHash(input.facts), locale: input.locale, channel: input.channel, rubric: 'ad-review.v1' };
  const task: PrivateTask = { ...input, id, orgId: user.orgId, buyerId: user.id, reviewerId: DEMO_REVIEWER_ID, status: 'DRAFT', version: 0,
    sourceVersionId: versionId, currentVersionId: versionId, sourceCommitment: null,
    versions: [{ id: versionId, text: input.sourceText, contentHash: textHash(input.sourceText), createdAt: iso(now) }],
    quote: null, report: null, approval: null, createdAt: iso(now), updatedAt: iso(now), acceptedAt: null, deliveryDue: null,
    challengeUntil: null, arbitrationUntil: null, closureReason: null, disputeReason: null, timeline: [], executionMode: 'demo',
    secrets: { sourceSalt: randomSalt(), finalSalt: null, sourceManifest, finalManifest: null } };
  record(task, user, 'CREATED', 'Task created in local demo', now); return task;
}
export function quoteTask(task: PrivateTask, user: User, now: number) {
  assertBuyer(task, user); requireThat(task.status === 'DRAFT', 'INVALID_STATE', 'Only draft tasks can be quoted.');
  requireThat(!task.quote, 'QUOTE_ALREADY_FROZEN', 'This quote is immutable. Create a new task for changed inputs.');
  task.sourceCommitment = commitment('SOURCE', task.secrets.sourceManifest, task.secrets.sourceSalt);
  task.quote = { id: randomUUID(), reviewerAtoms: '800000000000000000', platformAtoms: '200000000000000000', totalAtoms: '1000000000000000000', quantumAtoms: DEMO_QUANTUM.toString(), currency: 'DEMO', expiresAt: iso(now + HOUR), acceptUntil: iso(now + 24 * HOUR) };
  record(task, user, 'QUOTED', 'Inputs frozen · 1.00 DEMO quote', now);
}
export function fundTask(task: PrivateTask, user: User, now: number) {
  assertBuyer(task, user); requireThat(task.status === 'DRAFT' && task.quote, 'INVALID_STATE', 'A valid frozen quote is required.');
  requireThat(now < Date.parse(task.quote.expiresAt), 'QUOTE_EXPIRED', 'Quote expired. Create a new task and quote.');
  task.status = 'FUNDED'; record(task, user, 'FUNDED', 'Local test credits escrowed · no ME transaction', now);
}
export function acceptAssignment(task: PrivateTask, user: User, now: number) {
  assertRead(task, user); requireThat(user.id === task.reviewerId && user.id !== task.buyerId && user.orgId !== task.orgId, 'REVIEWER_REQUIRED', 'Only the invited independent reviewer may accept.', 403);
  requireThat(task.status === 'FUNDED' && task.quote, 'INVALID_STATE', 'Task is not available for acceptance.');
  requireThat(now < Date.parse(task.quote.acceptUntil), 'ASSIGNMENT_EXPIRED', 'The acceptance window has closed.');
  task.status = 'ASSIGNED'; task.acceptedAt = iso(now); task.deliveryDue = iso(now + 24 * HOUR);
  record(task, user, 'ASSIGNED', 'Invited reviewer accepted the task', now);
}
export function submitReview(task: PrivateTask, user: User, input: { reviewedText: string; verdict: Verdict; summary: string; checks: Check[] }, now: number) {
  assertRead(task, user); requireThat(user.id === task.reviewerId, 'REVIEWER_REQUIRED', 'Only the assigned reviewer can submit.', 403);
  requireThat(task.status === 'ASSIGNED' && !task.report, 'INVALID_STATE', 'A task accepts one final report.');
  requireThat(task.deliveryDue && now < Date.parse(task.deliveryDue), 'DELIVERY_EXPIRED', 'The delivery deadline has passed.');
  requireThat(input.checks.length === CRITERIA.length && new Set(input.checks.map(c => c.criterion)).size === CRITERIA.length && CRITERIA.every(c => input.checks.some(x => x.criterion === c)), 'INCOMPLETE_REPORT', 'Complete every rubric item exactly once.');
  requireThat(input.verdict !== 'PASS' || input.checks.every(c => c.result === 'OK'), 'INCONSISTENT_VERDICT', 'PASS requires all rubric items to be OK; unresolved items need changes or BLOCK.');
  const versionId = randomUUID();
  task.versions.push({ id: versionId, text: input.reviewedText, contentHash: textHash(input.reviewedText), createdAt: iso(now) });
  task.currentVersionId = versionId;
  const body = { schemaVersion: 'review.v1', taskId: task.id, sourceVersionId: task.sourceVersionId, reviewedVersionId: versionId, verdict: input.verdict, summary: input.summary, checks: input.checks };
  task.secrets.finalManifest = { schemaVersion: 'final.v1', taskId: task.id, sourceCommitment: task.sourceCommitment, reviewedVersionId: versionId, contentHash: textHash(input.reviewedText), reportHash: textHash(canonicalJson(body)), verdict: input.verdict };
  task.secrets.finalSalt = randomSalt();
  task.report = { id: randomUUID(), reviewedVersionId: versionId, verdict: input.verdict, summary: input.summary, checks: input.checks, deliveryCommitment: commitment('FINAL', task.secrets.finalManifest, task.secrets.finalSalt), submittedAt: iso(now) };
  task.status = 'SUBMITTED'; task.challengeUntil = iso(now + 48 * HOUR);
  record(task, user, 'SUBMITTED', `Final report sealed · ${input.verdict}`, now);
}
export function closeTask(task: PrivateTask, user: User, reason: string, now: number, alphaBps?: number): Allocation[] {
  requireThat(task.status !== 'CLOSED' && task.quote, 'INVALID_STATE', 'Task cannot close twice.');
  const W = BigInt(task.quote.reviewerAtoms), P = BigInt(task.quote.platformAtoms), F = W + P, q = BigInt(task.quote.quantumAtoms);
  let result: Allocation[];
  if (reason === 'NORMAL') result = [{ accountId: task.reviewerId, amountAtoms: W }, { accountId: 'platform', amountAtoms: P }];
  else if (reason === 'DISPUTE_TIMEOUT' || reason === 'ARBITRATED') {
    const alpha = alphaBps ?? 5000;
    requireThat(Number.isInteger(alpha) && alpha >= 0 && alpha <= 10000, 'INVALID_ALLOCATION', 'Invalid basis points.');
    const reviewer = (W / q) * BigInt(alpha) / 10000n * q;
    result = [{ accountId: task.reviewerId, amountAtoms: reviewer }, { accountId: task.buyerId, amountAtoms: F - reviewer }];
  } else result = [{ accountId: task.buyerId, amountAtoms: F }];
  requireThat(result.reduce((sum, x) => sum + x.amountAtoms, 0n) === F, 'INVARIANT_FAILED', 'Allocation must preserve the funded amount.');
  task.status = 'CLOSED'; task.closureReason = reason;
  record(task, user, 'CLOSED', `Service closed · ${reason} · local credits allocated`, now); return result;
}
export function acceptService(task: PrivateTask, user: User, now: number) {
  assertBuyer(task, user); requireThat(task.status === 'SUBMITTED', 'INVALID_STATE', 'Only an undisputed submitted service can be accepted.');
  return closeTask(task, user, 'NORMAL', now);
}
export function cancelTask(task: PrivateTask, user: User, now: number) {
  assertBuyer(task, user); requireThat(task.status === 'FUNDED', 'INVALID_STATE', 'Cancellation is available before acceptance.');
  return closeTask(task, user, 'CANCELLED', now);
}
export function openDispute(task: PrivateTask, user: User, reason: string, now: number) {
  assertBuyer(task, user); requireThat(task.status === 'SUBMITTED', 'INVALID_STATE', 'Only submitted services can be disputed.');
  requireThat(task.challengeUntil && now < Date.parse(task.challengeUntil), 'CHALLENGE_EXPIRED', 'The dispute window is closed.');
  task.status = 'DISPUTED'; task.disputeReason = reason; task.arbitrationUntil = iso(now + 72 * HOUR);
  record(task, user, 'DISPUTED', 'Service dispute opened · 72 hour resolution window', now);
}
export function timeoutTask(task: PrivateTask, user: User, now: number) {
  assertRead(task, user);
  if (task.status === 'FUNDED' && task.quote && now >= Date.parse(task.quote.acceptUntil)) return closeTask(task, user, 'UNASSIGNED_TIMEOUT', now);
  if (task.status === 'ASSIGNED' && task.deliveryDue && now >= Date.parse(task.deliveryDue)) return closeTask(task, user, 'DELIVERY_TIMEOUT', now);
  if (task.status === 'SUBMITTED' && task.challengeUntil && now >= Date.parse(task.challengeUntil)) return closeTask(task, user, 'NORMAL', now);
  if (task.status === 'DISPUTED' && task.arbitrationUntil && now >= Date.parse(task.arbitrationUntil)) return closeTask(task, user, 'DISPUTE_TIMEOUT', now, 5000);
  requireThat(false, 'DEADLINE_NOT_REACHED', 'No timeout is eligible at the current server time.');
}
export function approveTask(task: PrivateTask, user: User, versionId: string, hours: number, now: number) {
  assertBuyer(task, user); requireThat(task.report?.verdict === 'PASS', 'REVIEW_NOT_PASS', 'Only a PASS report can receive a brand approval.');
  requireThat(versionId === task.report.reviewedVersionId, 'APPROVAL_VERSION_MISMATCH', 'The requested version is not the reviewed version.');
  requireThat([24, 72, 168].includes(hours), 'INVALID_EXPIRY', 'Choose 24, 72 or 168 hours.');
  requireThat(!task.approval || task.approval.revokedAt || now >= Date.parse(task.approval.expiresAt), 'APPROVAL_ALREADY_ACTIVE', 'An active approval already exists. Revoke it explicitly or wait for expiry before replacing it.');
  if (task.approval) {
    // Keep previous records; the demo has one current approval per task.
    task.secrets.approvalHistory ??= [];
    task.secrets.approvalHistory.push(structuredClone(task.approval));
  }
  task.approval = { id: randomUUID(), versionId, deliveryCommitment: task.report.deliveryCommitment, scope: `${task.locale}:${task.channel}`, expiresAt: iso(now + hours * HOUR), revokedAt: null, approvedAt: iso(now) };
  record(task, user, 'APPROVED', 'Brand approved the exact reviewed version', now);
}
export function revokeTask(task: PrivateTask, user: User, now: number) {
  assertBuyer(task, user); requireThat(task.approval && !task.approval.revokedAt, 'INVALID_STATE', 'No active approval to revoke.');
  task.approval.revokedAt = iso(now); record(task, user, 'REVOKED', 'Brand revoked further controlled exports', now);
}
export function addVersion(task: PrivateTask, user: User, text: string, now: number) {
  assertBuyer(task, user); requireThat(task.report, 'INVALID_STATE', 'Create a new task to change inputs before review.');
  const id = randomUUID(); task.versions.push({ id, text, contentHash: textHash(text), createdAt: iso(now) });
  task.currentVersionId = id; record(task, user, 'VERSION_CREATED', 'New version created · prior approval does not cover it', now);
}
export function verifyExport(task: PrivateTask, user: User, versionId: string, approvalId: string, now: number) {
  assertBuyer(task, user);
  requireThat(task.report?.verdict === 'PASS', 'REVIEW_NOT_PASS', 'The report must be PASS.');
  const a = task.approval;
  requireThat(a && a.id === approvalId, 'APPROVAL_NOT_FOUND', 'Approval does not match this task.');
  requireThat(a.versionId === versionId && task.report.reviewedVersionId === versionId, 'APPROVAL_VERSION_MISMATCH', 'This version is not covered by that approval.');
  requireThat(!a.revokedAt && now < Date.parse(a.expiresAt), 'APPROVAL_EXPIRED_OR_REVOKED', 'Approval has expired or was revoked.');
  requireThat(a.scope === `${task.locale}:${task.channel}` && a.deliveryCommitment === task.report.deliveryCommitment, 'APPROVAL_SCOPE_MISMATCH', 'Approval scope differs from the report.');
  const asset = task.versions.find(v => v.id === versionId);
  requireThat(asset && task.secrets.finalManifest && task.secrets.finalSalt, 'CONTENT_UNAVAILABLE', 'The sealed content is unavailable.');
  const reportBody = { schemaVersion: 'review.v1', taskId: task.id, sourceVersionId: task.sourceVersionId, reviewedVersionId: task.report.reviewedVersionId, verdict: task.report.verdict, summary: task.report.summary, checks: task.report.checks };
  requireThat(textHash(asset.text) === asset.contentHash && task.secrets.finalManifest.contentHash === asset.contentHash
    && task.secrets.finalManifest.reportHash === textHash(canonicalJson(reportBody)) && task.secrets.finalManifest.verdict === task.report.verdict
    && commitment('FINAL', task.secrets.finalManifest, task.secrets.finalSalt) === a.deliveryCommitment, 'CONTENT_INTEGRITY_FAILURE', 'Stored bytes do not match the sealed report.');
  return asset;
}
