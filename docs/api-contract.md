# Shared and DEMO API contract

Base URL: `/v1` on the API, proxied by Next.js at `/api/v1`. Responses are JSON except TXT downloads. Errors use `{error:{code,message}}`. This document covers shared resources and the isolated DEMO operations. The implemented wallet login, identity, transaction-intent, confirmation and recovery protocol is specified in [live-api.md](./live-api.md).

`APP_MODE=demo` uses synthetic actors and an isolated ledger. `APP_MODE=me` uses wallet and contract paths; `ME_NETWORK` distinguishes local/testnet/mainnet. The local runner uses real local contracts and `local_test` identities. No remote HumanDock ME deployment is claimed.

## Request conventions

Authenticated business mutations send:

- The HttpOnly session cookie.
- `X-CSRF-Token` from the session response.
- `Idempotency-Key`: 8–128 characters; a fresh UUID is recommended for a new operation.
- `expectedVersion` for task transitions that require optimistic concurrency.

Idempotency is scoped to actor and route; chain mode additionally includes chain and escrow deployment. The same key with different input returns `IDEMPOTENCY_CONFLICT`. Ordinary same-input retries return the previously committed response. Identity refresh and reconciliation preserve key/body consistency while rereading current external state.

Auth bootstrap does not require an existing CSRF token: origin checks and the browser-bound challenge apply. The DEMO session bootstrap is available only in demo mode. Logout and AI assistance require CSRF but do not cache idempotent responses. Untrusted origins are rejected for browser writes. An idempotent API response is not a chain confirmation.

## Session and readiness

| Method and path | Behavior |
|---|---|
| `GET /health` | Returns process/storage/mode, chain status, AI mode and application version; health alone does not certify chain readiness |
| `GET /session` | `{user:User|null,csrfToken:string|null,mode:'demo'|'me'}` |
| `POST /demo/session` | `{role:'buyer'|'reviewer'|'outsider'}` → synthetic session; only demo mode |
| `POST /logout` | Removes the session and clears its cookie; `{ok:true}` |
| `GET /me/config` | Current chain readiness, write/admission reasons, public network/deployment configuration; see the live API |

`User` contains `id,name,role,orgId,wallet,identity`. Identity contains `status,label`, optionally `checkedAt,kycLevel,policyReference`. Status is `demo`, `pending`, `verified`, `local_test`, `rejected` or `unavailable`. Wallet sign-in starts with identity pending. A `local_test` fixture is never represented as verified ME identity. Reviewer role is server-controlled.

Chain login uses `/auth/challenge` and `/auth/verify`; identity refresh uses `/me/identity/refresh`. Full schemas, cookie binding and role admission are in [live-api.md](./live-api.md).

## Shared task resources

| Method and path | Request and result |
|---|---|
| `GET /tasks` | `{tasks:Task[]}`, restricted to authorized tasks and the current execution environment/deployment |
| `POST /tasks` | `{title,sourceText,facts,channel,locale:'en-US'}` → `{task}`; chain mode additionally requires `reviewerWallet` and admission |
| `GET /tasks/:id` | `{task}` after resource authorization |
| `POST /tasks/:id/quotes` | `{expectedVersion}` → `{task}`; freezes the purchased input and terms; chain mode issues a signed quote |
| `POST /tasks/:id/versions` | `{expectedVersion,text}` → `{task}`; creates a new immutable version without replacing a delivered report or approval |
| `POST /tasks/:id/ai-checks` | `{}` → `{suggestions,mode:'rules'|'provider'}`; bounded advisory output, not approval or payment authority |

Channels: `tiktok_text`, `instagram_text`, `youtube_text`, `x_text`. Source/review text is limited to 300 English words; facts are limited to 2,000 characters. These are short-text review labels; no external publishing integration exists.

AI suggestions contain `criterion,result:'OK'|'ISSUE'|'UNKNOWN',comment,evidenceRefs:string[]`. Unconfigured AI assistance is explicitly labeled local rules. A changed version after final delivery needs a new paid review task before it can receive a valid approval.

## DEMO task transitions

All routes below return `{task}`. They are direct local-ledger transitions only in `APP_MODE=demo`. In chain mode they return `TRANSACTION_INTENT_REQUIRED`; prepare and confirm the corresponding action through `/me/intents` instead. Quotes and versions remain shared routes as listed above.

| `POST /tasks/:id/…` | Input in addition to `expectedVersion` | Authority and effect |
|---|---|---|
| `fund` | None | Buyer; adds isolated DEMO escrow credit |
| `accept-assignment` | None | Invited reviewer accepts the task |
| `reviews` | `reviewedText,verdict,summary,checks` | Reviewer delivers one final immutable report/version |
| `accept-service` | None | Buyer accepts the service and allocates the fee independently of the content verdict |
| `approvals` | `versionId,expiresInHours:24|72|168` | Buyer approves the exact PASS-reviewed version |
| `revoke` | None | Buyer revokes the approval |
| `cancel` | None | Buyer cancels before assignment and receives the eligible refund |
| `disputes` | `reason` | Buyer opens the service dispute within the fixed challenge window |
| `timeouts` | None | Executes an eligible refund/settlement/arbitration fallback using the server clock; request input cannot fast-forward it |

A report verdict is `PASS`, `CHANGES_REQUIRED` or `BLOCK`. Checks must include each of these criteria exactly once: `factual_consistency`, `naturalness`, `brand_voice`, `misleading_claims`, `channel_format`. A `Check` contains `{criterion,result:'OK'|'ISSUE'|'UNKNOWN',comment,evidenceRefs:string[]}`. PASS requires all criteria to be OK. BLOCK and CHANGES_REQUIRED can still describe a completed payable review service.

## Resource shapes

`Task` contains:

- Identity/ownership: `id,orgId,buyerId,reviewerId`.
- Brief: `title,sourceText,facts,channel,locale`.
- State: `status:'DRAFT'|'FUNDED'|'ASSIGNED'|'SUBMITTED'|'DISPUTED'|'CLOSED'`, numeric `version`.
- Content: `sourceVersionId,currentVersionId,sourceCommitment,versions,quote,report,approval`.
- Timing and outcome: `createdAt,updatedAt,acceptedAt,deliveryDue,challengeUntil,arbitrationUntil,closureReason,disputeReason`.
- Evidence: `timeline`, `executionMode:'demo'|'me'`, optional `chain`.

Nullable timestamps/outcome fields stay null until the corresponding transition. Chain metadata contains `chainId,escrow,registry` and, when known, the contract task ID and last transaction/block evidence. API task views omit private salts and manifests.

| Type | Fields |
|---|---|
| `AssetVersion` | `id,text,contentHash,createdAt` |
| `Quote` | `id,reviewerAtoms,platformAtoms,totalAtoms,quantumAtoms,currency,expiresAt,acceptUntil` |
| `Report` | `id,reviewedVersionId,verdict,summary,checks,deliveryCommitment,submittedAt` |
| `Approval` | `id,versionId,deliveryCommitment,scope,expiresAt,revokedAt,approvedAt` |
| `TimelineEvent` | `id,type,label,at,actorId,executionMode`; chain events may add `txHash,blockNumber,blockHash` |

Amount fields are unsigned decimal integer strings where applicable. Existing `*Atoms` names carry **EVM wei-style 18-decimal amounts**, not Cosmos bank atoms. DEMO has no external value; chain currency comes from explicit network configuration. Use `BigInt` or a precise decimal formatter, never floating point money writes. Live split amounts must preserve the verified deployment quantum. DEMO timeline entries do not fabricate chain hashes.

## Controlled export

| Method and path | Behavior |
|---|---|
| `POST /exports` | `{taskId,versionId,approvalId}` → `{export:{id,filename,downloadUrl,receiptUrl,verifiedAt,executionMode}}` |
| `GET /exports/:id/download` | Authorized `text/plain` attachment containing the exact fixed approved bytes |
| `GET /exports/:id/receipt` | Authorized private JSON receipt, with current validation evidence |

Export creation verifies task access, exact immutable content, PASS, purpose, expiry and revocation. A modified version returns `APPROVAL_VERSION_MISMATCH`. It is buyer-only. Service settlement is independent of export eligibility.

An idempotent creation retry may return existing metadata. Its URLs are not public or unrestricted: **both download and receipt recheck current permissions, exact content, expiry and revocation on every request**. Chain mode synchronizes and reads the canonical registry state before validation. It never swaps in a newer `currentVersionId` after checking the requested version.

The receipt includes the task/version, content hash, report, delivery commitment, approval, private final manifest/salt, current validation time and original export creation time. DEMO uses schema `receipt.demo.v1`, an explicit local-DEMO notice and `chain:null`. Chain mode uses `receipt.chain.v1` and an observed block number/hash; local chain receipts explicitly say they are not ME certification. Keep this receipt private. Its observed validity is not legal/platform certification and cannot recall an already downloaded file.

## Balances and withdrawal

`GET /balances` returns:

```text
currency
claimableAtoms, withdrawnAtoms, escrowedAtoms
entries: [{id,type,amountAtoms,at,taskId}]
```

All amount fields are decimal integer strings. Chain mode additionally returns `walletBalanceAtoms`, `executionMode:'me'`, observed `block`, and `reconciliationStatus`; chain ledger entries can include transaction/block evidence. DEMO balances come solely from the isolated ledger.

`POST /withdrawals` with `{}` is **DEMO only** and withdraws the current user's allocated local credits. Chain mode requires `/me/intents` with action `withdraw`; the MVP sends the withdrawal to the signed-in wallet. Settlement, confirmed withdrawal and independently verified EVM/bank reconciliation remain separate outcomes. The old `/tasks/:id/funding-intents` route directs clients to `/me/intents` and does not issue a second protocol.

## Conflicts and recoverable errors

| Code | Client action |
|---|---|
| `NOT_FOUND` | Do not infer access to another tenant's resource |
| `VERSION_CONFLICT` | Reload the task before constructing a new mutation |
| `CSRF_INVALID` | Refresh the session; do not retry with an unrelated token |
| `IDEMPOTENCY_KEY_REQUIRED` | Supply a valid operation key |
| `IDEMPOTENCY_CONFLICT` | Do not reuse a key for changed input |
| `TRANSACTION_INTENT_REQUIRED` | Use the wallet/intent protocol instead of a DEMO mutation |
| `APPROVAL_VERSION_MISMATCH` | Select the exactly approved version or complete a new review/approval |
| `CHAIN_SYNC_REQUIRED` / `CHAIN_REPLAY_REQUIRED` | Wait for verified synchronization or operator canonical recovery; do not automatically rebroadcast |
| `IDENTITY_KEY_CHANGED` | Restore the task's original identity key or complete an explicit migration before new admission; exits remain separate |

See [live-api.md](./live-api.md) for current intent statuses, replacement rules, admission/readiness reasons and reconciliation outcomes. Use the returned machine code and current state; a user-facing message or a cached response does not prove a chain transition.
