# HumanDock MVP API contract

Base: `/v1` on API port 4000; browser uses `/api/v1` through Next.js rewrite. All responses JSON except file downloads. Errors: `{error:{code,message}}`. Cookies: HttpOnly session. Mutation requests send `Idempotency-Key` (UUID) and `X-CSRF-Token` from session. Expected version required for task mutation. Demo mutations are accepted **only** in explicit local demo mode; no fake blockchain transactions are returned. The production ME integration remains gated until deployment, identity and network checks pass.

## Session and readiness

- GET `/health` -> `{ok:true,mode:'demo'|'me',storage:'pglite'|'postgres',chain:{status:'not_configured'|'configured_unverified',name:'MetaEarth'},ai:{mode:'rules'|'provider'},version:'0.1.0'}`.
- GET `/session` -> `{user:User|null,csrfToken:string|null,mode:'demo'|'me'}`.
- POST `/demo/session` `{role:'buyer'|'reviewer'|'outsider'}` -> session object; no CSRF needed for this demo-only bootstrap. Demo identities explicit, never ME verified. Reviewer is predefined and invited.
- POST `/logout` -> `{ok:true}`.

User: `{id,name,role:'buyer'|'reviewer'|'outsider',orgId,wallet,identity:{status:'demo',label:'Local test identity — not ME verified'}}`.

## Tasks

- GET `/tasks` -> `{tasks:Task[]}` restricted to caller's own organization or invited reviewer.
- POST `/tasks` `{title,sourceText,facts,channel:'tiktok_text'|'instagram_text'|'youtube_text'|'x_text',locale:'en-US'}` -> `{task:Task}`. Maximum 300 source English words, facts 2000 characters.
- GET `/tasks/:id` -> `{task:Task}`.
- POST `/tasks/:id/quotes` `{expectedVersion}` -> `{task}`; freezes inputs, immutable quote.
- POST `/tasks/:id/fund` `{expectedVersion}` -> `{task}` **DEMO ONLY**; updates isolated local demo ledger.
- POST `/tasks/:id/accept-assignment` `{expectedVersion}` -> `{task}` reviewer only.
- POST `/tasks/:id/ai-checks` `{}` -> `{suggestions:{criterion,result:'OK'|'ISSUE'|'UNKNOWN',comment,evidenceRefs:string[]}[],mode:'rules'|'provider'}`. Rule-based mode clearly labelled, not represented as a live model.
- POST `/tasks/:id/reviews` `{expectedVersion,reviewedText,verdict:'PASS'|'CHANGES_REQUIRED'|'BLOCK',summary,checks:Check[]}` -> `{task}`. Reviewer only; finalizes one immutable report and version. Exactly these five criteria, once each: `factual_consistency`, `naturalness`, `brand_voice`, `misleading_claims`, `channel_format`; each Check has `{criterion,result,comment,evidenceRefs:string[]}`.
- POST `/tasks/:id/accept-service` `{expectedVersion}` -> `{task}` buyer only; pays service irrespective of verdict.
- POST `/tasks/:id/approvals` `{expectedVersion,versionId,expiresInHours:24|72|168}` -> `{task}` buyer only, PASS only, binds fixed version.
- POST `/tasks/:id/revoke` `{expectedVersion}` -> `{task}` buyer only.
- POST `/tasks/:id/versions` `{expectedVersion,text}` -> `{task}` buyer only, creates a new immutable version; never updates an existing report or approval. New version cannot use prior approval.
- POST `/tasks/:id/cancel` `{expectedVersion}` -> `{task}` buyer only, before assignment.
- POST `/tasks/:id/disputes` `{expectedVersion,reason}` -> `{task}` buyer only within challenge period; escrow demo state DISPUTED.
- POST `/tasks/:id/timeouts` `{expectedVersion}` -> `{task}` executes eligible refund/settlement/arbitration timeout based on server clock; cannot fast-forward through client input.

Task: `{id,orgId,buyerId,reviewerId,title,sourceText,facts,channel,locale,status:'DRAFT'|'FUNDED'|'ASSIGNED'|'SUBMITTED'|'DISPUTED'|'CLOSED',version:number,sourceVersionId,currentVersionId,sourceCommitment:string|null,versions:AssetVersion[],quote:Quote|null,report:Report|null,approval:Approval|null,createdAt,updatedAt,acceptedAt:string|null,deliveryDue:string|null,challengeUntil:string|null,arbitrationUntil:string|null,closureReason:string|null,disputeReason:string|null,timeline:TimelineEvent[],executionMode:'demo'}`.

AssetVersion: `{id,text,contentHash,createdAt}`.
Quote: `{id,reviewerAtoms:string,platformAtoms:string,totalAtoms:string,quantumAtoms:string,currency:'DEMO',expiresAt,acceptUntil}`. Decimal integer atoms; display using BigInt / 10^18, never float in money writes.
Report: `{id,reviewedVersionId,verdict,summary,checks:Check[],deliveryCommitment,submittedAt}`.
Approval: `{id,versionId,deliveryCommitment,scope,expiresAt,revokedAt:string|null,approvedAt}`.
TimelineEvent: `{id,type,label,at,actorId,executionMode:'demo'}`. No fake tx hashes.

## Export and balances

- POST `/exports` `{taskId,versionId,approvalId}` -> `{export:{id,filename,downloadUrl,receiptUrl,verifiedAt,executionMode:'demo'}}`. Verifies exact immutable bytes, PASS, scope, unexpired and unrevoked approval. A modified version returns APPROVAL_VERSION_MISMATCH. Buyer only.
- GET `/exports/:id/download` -> text/plain attachment, re-checks permissions and approval every time.
- GET `/exports/:id/receipt` -> private receipt with explicit LOCAL DEMO / NOT A ME ATTESTATION.
- GET `/balances` -> `{currency:'DEMO',claimableAtoms:string,withdrawnAtoms:string,escrowedAtoms:string,entries:{id,type,amountAtoms,at,taskId:string|null}[]}`.
- POST `/withdrawals` `{}` -> balances; DEMO ONLY, withdraws current user's allocated local test credits.

All financial controls visible as 'Local demo' in UI. Wallet actions for ME must remain unavailable with a reason until the actual integration is configured. Never imply deployment or ME ID certification.
