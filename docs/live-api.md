# Wallet and chain API contract

Base URL `/v1`, proxied by the UI through `/api/v1`. Live wallet addresses are checksum `0x` EVM addresses. The demo and chain-backed modes use separate sessions, intents and ledgers.

## Authentication and readiness

- `GET /me/config`: `{mode,status,writesEnabled,admissionsEnabled,reasons,admissionReasons,network,walletChain,contracts,confirmations,localTest}`. Network/contracts can be null before configuration. `writesEnabled` requires verified chain/deployment and a healthy, caught-up confirmed event cursor; admissions additionally require issuers, identity policy and unit evidence. Existing delivery and exits never require a fresh KYC admission. New creation, quotes, funding and assignment do.
- `POST /auth/challenge` `{address,chainId}`: `{challengeId,message,expiresAt}` and a short-lived HttpOnly challenge cookie. No CSRF token required; origin checks apply. The SIWE message binds origin, URI, account, chain, random nonce and five-minute expiry.
- `POST /auth/verify` `{challengeId,signature}`: `{user,csrfToken,mode}` and a new HttpOnly session. Consumes the browser-bound challenge once. Signature login establishes wallet control; identity initially remains pending.
- `POST /me/identity/refresh` `{}`: updated session, with identity `pending|verified|local_test|rejected|unavailable`, label, checkedAt, kycLevel and policyReference. Local fixtures are never labelled as ME-verified identities. ME ID does not certify reviewer skill.
- `GET /me/reviewers`: `{reviewers:[{wallet,name}]}`. Reviewer role and invitation come from server configuration, never from a browser role selector.

Network fields: `kind,chainId,chainName,nativeSymbol,evmDecimals:18,bankDecimals,bankDenom,quantumWei`. Optional public `walletChain` follows `wallet_addEthereumChain` fields: hexadecimal chainId, chainName, nativeCurrency and public rpcUrls. Private RPC credentials are never returned.

## Tasks and transaction intents

Existing task reads remain available. Live task creation also requires `reviewerWallet`. `POST /tasks/:id/quotes` freezes the signed quote and returns `{task}`. Off-chain changed versions and controlled exports retain their existing routes.

All other live contract actions use `POST /me/intents`:

```json
{"taskId":"uuid (omit for withdraw)","action":"fund","expectedVersion":2,"payload":{}}
```

Actions: `fund`, `accept-assignment`, `reviews`, `accept-service`, `approvals`, `revoke`, `cancel`, `disputes`, `timeouts`, `withdraw`. Payloads use the corresponding demo operation's input fields. Withdrawals in this MVP target the signed-in wallet itself.

The response is `{intent}`. Its public fields are `id,taskId,action,status,account,chainId,allowedTargets,summary,expiresAt,typedData?,transaction?,txHash?,confirmations,requiredConfirmations,block?,applied,error?,reconciliation?`.

- Status: `awaiting_signature|ready|broadcast|confirming|confirmed|reverted|reorged|expired|rejected|replaced`.
- `summary`: `title,description,amountWei,symbol`, optionally `versionId,deliveryCommitment,receiver,withdrawalAmountWei`. `amountWei` is the actual transaction call value, so withdrawal has value zero and a separate expected payout.
- `transaction`: `{from,to,data,value,chainId}`, with hexadecimal RPC call value.
- EIP-712 bigint fields are serialized as decimal strings. The UI validates account, chain, contract, call value and signature domain before requesting wallet interaction.
- Block: `{number,hash,timestamp}`; number is a decimal string and timestamp is an ISO date. Broadcast hashes never cause a paid/completed state by themselves. `confirmed` refers to a verified successful receipt; `applied` separately means its canonical event has committed to the projection.

`POST /me/intents/:id/signature` `{signature}` produces the exact transaction after verifying the actor's typed signature. `POST /me/intents/:id/broadcast` `{txHash}` records a broadcast. `POST /me/intents/:id/reconcile` `{}` verifies the transaction and canonical confirmed receipt and returns `{intent,task?}`. `GET /me/intents` and `GET /me/intents/:id` support recovery. Business mutations require CSRF and Idempotency-Key; polling reconciliation and identity refresh recheck current external state even when the same key is repeated. Logout and bounded AI assistance require CSRF but do not cache idempotent results.

Registration verifies an already observable transaction's chain, sender, target, calldata and value; an unavailable hash remains an unconfirmed hint. It never reserves another actor's hash globally. A later mismatched transaction is `rejected`, with `applied:false`. A new hash on an existing intent must have the same sender and observed original nonce: an exact-call speed-up continues confirmation; a different transaction becomes `replaced` only after its nonce consumption is confirmed. If the original nonce is unknown, the server refuses to guess. Neither UI nor API automatically resends a dropped, cancelled or unknown transaction. An operator may need to investigate provider/pruned-history failures.

New quote and assignment attestations expire within five minutes of chain time. An issued authorization remains valid on chain until that short expiry even if off-chain identity changes; revocation is not instantaneous. The HMAC identity-key fingerprint is frozen per task; changing the server identity key blocks new funding/assignment for old tasks until it is restored or explicitly migrated. It never blocks settlement, refund or withdrawal.

The browser must preserve a broadcast hash before making the registration request. Registration or confirmation errors retry registration/reconciliation; they must not automatically send another transaction. Account changes invalidate the application session; network changes block signing until rechecked.

## Balances and export evidence

`GET /balances` retains `currency,claimableAtoms,withdrawnAtoms,escrowedAtoms,entries`; live responses add `walletBalanceAtoms,executionMode:'me',block,reconciliationStatus`. Amount fields are decimal integer EVM wei, never floating point bank units. Settlement allocates claimable funds; only a confirmed Withdrawal event records withdrawal. Balance reconciliation is separately reported and may remain unverified when historical bank/RPC evidence is unavailable.

Live downloads check the exact immutable bytes and a current canonical registry approval. A receipt records the observed block number/hash and does not promise to recall previously downloaded bytes.

## Canonical recovery and accounting

Events use a stable key containing chain, contract, block hash, transaction hash and log index. Event insertion, task/ledger effects and cursor advancement commit in one database transaction. The scanner checks the previous checkpoint both before and after scanning, including boundary parent linkage. A reorganization persists a blocked cursor across process restarts. Receipt and withdrawal-snapshot reorgs also block the deployment. An operator stops the API/indexer, backs up the database and runs `npm run me:reindex -- --execute`; replay archives old public event evidence and reconstructs only derived projections from canonical confirmed logs and immutable private reports. It sends no transaction.

Withdrawal evidence distinguishes `verified` (matching EVM and same-height bank snapshots), `evm-only` (local/available EVM proof without bank evidence), `unverified` (missing historical data or concurrent transactions), and `mismatch` (a comparison with sufficient isolated evidence failed). A local-chain result is never called a ME bank reconciliation. For the observed ME fork, successful gas charge is `(ceil(gasLimit * price / q) - floor((gasLimit - gasUsed) * price / q)) * q`; an ordinary EVM uses `gasUsed * price`. The actual model is explicit configuration.
