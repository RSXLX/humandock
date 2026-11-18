# Security model and implementation boundaries

This document specifies the trust boundaries for the first HumanDock implementation and the requirements for a live service. It is a design and review document, not an audit certificate. Local application tests and local EVM tests establish only the behaviors they actually execute.

## Modes and protected assets

The demo uses synthetic fixtures and an isolated **DEMO** integer ledger. It must not accept real funds, represent fixture identities as live ME verification, or show local transaction identifiers as ME network evidence. `APP_MODE=me` must keep money-changing application functions unavailable until the live adapter and the gates in [me-integration.md](./me-integration.md) are complete. Changing a configuration string is not a deployment procedure.

Protected assets are customer text and facts, immutable review reports, private salts and commitments, account/organization membership, signing credentials, settlement credits, and approval records. User private keys, identity documents, biometric material, and unrelated private project data do not belong in this repository or its fixtures. Public receipts, logs, screenshots, and test output must not expose those assets.

### First-milestone limitations

The browser demo can select predefined synthetic roles. Its API uses sessions, CSRF checks, actor/organization checks, and persistent local state, but the ability to select a fixture identity is intentionally not proof of that person's identity. The demo must stay in a trusted development environment; do not expose its role-selection flow to real customers or use it for real custody.

The initial storage implementation is an application-level prototype. A configurable PostgreSQL connection does not imply that production RLS roles, compound tenant constraints, external immutable object storage, a durable chain indexer, or transactional outbox recovery have been implemented and verified. Requirements for these controls below are live-service acceptance criteria.

The current Solidity registry uses EOA signatures and the task buyer as the brand authority. Delegated brand approvers and contract-wallet signature validation are deferred. Its funds are exercised by the separate local EVM test suite, not by the browser's DEMO ledger. The application has no established live ME deployment or verified chain index. Keep these distinctions visible in demonstrations and receipts.

## Trust boundaries

| Component or actor | Trusted for | Not trusted for |
| --- | --- | --- |
| Browser | Presenting requests and obtaining the user's wallet action | Authoritative roles, identity status, prices, timestamps, ledger balances, or export eligibility |
| Application API | Input validation, authorization, version freezing, private storage, and controlled export | Claiming an unconfirmed transaction is final |
| Reviewer | Signing a review about the exact final version | Granting the brand's export permission or moving funds outside the contract rules |
| Delivery attester | Verifying schema, exact artifact linkage, signatures, and retrievability | Certifying the report's substantive quality or legal correctness |
| Brand approver | Approving the exact final artifact for the stated purpose and expiry | Rewriting the review verdict or authorizing a different version implicitly |
| Arbitrator | Applying the agreed dispute rule to reviewer service fees | Editing delivered content or silently resetting deadlines |
| ME identity source | Reporting observed identity/account state under a verified policy | Proving English proficiency, review quality, or total anonymity |
| AI provider | Producing bounded advisory analysis | Issuing identity proofs, approving export, authorizing payment, or determining the final verdict |
| Confirmed contract state | Settlement and approval records for the exact deployment | Protecting plaintext already downloaded or proving off-chain content quality |

The app attester, designated approver, and arbitrator are explicit trusted roles. Do not call the entire system trustless. A public wallet address may create linkability even when the application does not publish a DID.

## Identity, sessions, and organization isolation

Live wallet login requires a one-use challenge scoped to origin/domain, URI, chain, actor, issuance time, and expiry. Signature verification must precede creation of a session. Session cookies require appropriate HttpOnly/Secure/SameSite behavior, CSRF protection for browser writes, and logout/expiry handling. A demo role selector is a fixture control, not production authentication.

Use a private canonical principal for main/sub-account identity matching; prevent self-review across wallet aliases and relevant organization membership. Application aliases must be keyed or randomly mapped, not a bare hash of a public DID. Freeze the task's alias-key version so key rotation cannot change the identity comparison on an existing order.

Every resource authorization checks organization, actor, and action in the API. Database compound references must preserve organization/task/version ownership. PostgreSQL row security should use both `USING` and `WITH CHECK`, with a non-owner application role that cannot bypass it and transaction-local tenant context. An assigned cross-organization reviewer receives a narrowly scoped task grant; do not disable isolation for an entire connection. See [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html). The embedded PGlite demo does not itself prove that a production PostgreSQL role/RLS deployment is correct; verify the actual server migration and role configuration before hosting multiple real tenants.

## Immutable versions and controlled export

The purchased review records its input **A** and brief. Before final delivery, the reviewer may propose **B** and review B. There is one final report per service task. An edited version after delivery becomes a new revision and a new paid review task; it does not overwrite the delivered report or restart the existing deadline.

Use detached signatures to avoid a self-referential hash:

```text
ReviewPayload without signatures
  -> private payload digest
  -> final manifest tying the task/input to exact B and verdict
  -> salted delivery commitment
  -> DeliveryEnvelope
  -> separate reviewer and delivery-attester signatures
```

The source and final manifests use independent random 256-bit salts and distinct domains. On-chain task/report records carry `taskCommitment` and `deliveryCommitment`; never put the plaintext, bare short-text digest, private manifest/report hash, or salt in public calldata, events, or logs. Salted commitments reduce easy guessing of short text; they do not hide wallet or transaction metadata. Canonicalization must be explicitly specified; [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) describes JSON canonicalization, while raw text must retain the frozen UTF-8 bytes without a hidden trim or Unicode transformation.

An export requires all of the following at validation time:

1. The actor is authorized to read the requested organization/task/version.
2. The immutable version and final manifest match the delivered report, and its verdict is `PASS`.
3. The designated brand approver authorized the exact final commitment, export purpose, and validity interval.
4. The approval is unexpired and unrevoked according to a sufficiently fresh confirmed chain view in live mode.
5. The server reads the fixed immutable blob, recomputes the private digest and commitment, and emits those same bytes. It never substitutes a `latest` or `head` object after checking.

`CHANGES_REQUIRED` and `BLOCK` can complete and pay for a review service, but cannot pass the export gate. Payment settlement is not a prerequisite for a valid brand export approval. There is no P0 override, external publishing hook, or on-chain consume operation. The current demo exports the approved copy as TXT and a private JSON receipt. An active approval allows repeated downloads without another service fee. Idempotent replay still rechecks current access, revocation, expiry, and content; it cannot return an old unrestricted download URL.

A private demo receipt records the exact version/commitment, approval reference, and validation time, with `chain: null`. A future live receipt must additionally record the verified block number **and hash** and state validity at that observed chain state. A revocation confirmed before validation blocks export; the system cannot recall downloaded content or promise atomic ordering between a chain revocation and bytes already in flight.

## Settlement invariants

Amounts use integers, with `F = W + P`. A normal completed service allocates W to the reviewer and P to the platform. Cancellation before assignment or a missed required delivery returns F. Following a delivered report, the buyer has 48 hours to dispute. Dispute allocation divides only W by `alphaBps`, refunds P, and must preserve the deployment's confirmed monetary quantum. An unresolved dispute after 72 hours uses the pre-agreed 50/50 allocation of W with P refunded; this is a deadlock fallback, not a guarantee of a fair quality judgment.

Deadlines come from chain timestamps, are fixed by the relevant transition, and do not reset when an API request is retried. Before-deadline actions use `< deadline`; timeout actions use `>= deadline`. A terminal settlement allocates claimable credits once. Withdrawals are a separate transaction: settled is not the same as money arriving in an external wallet.

Contract tests must cover unauthorized calls, duplicate finalization, deadline boundaries, refund/dispute branches, quantum-aligned rounding, total allocation conservation, reentrant or reverting receivers, nonce replay, wrong domains, and mismatched versions. Passing a local test suite does not establish the running ME network's bank/EVM conversion behavior.

## Signatures and privileged operations

Each signed action binds its purpose, actor, task/approval, exact commitment, nonce, expiry, chain ID, and verifying contract. Monetary terms also bind W, P, asset, beneficiaries, and applicable deadlines. The reviewer and delivery attester sign the same verdict-bearing delivery envelope. Approve and revoke operations need replay protection and an audit trail. [EIP-712](https://eips.ethereum.org/EIPS/eip-712) structures signed data but does not provide application replay protection by itself.

Once a quote is issued, its task snapshot is frozen. Editing the input creates a new task and quote. An old signed quote remains usable for its old snapshot until expiry or a contract-supported, confirmed nonce cancellation; a database flag alone cannot invalidate the signed on-chain authorization. Do not promise quote cancellation if the deployed contract has no corresponding operation.

Use separate purposes/key IDs for identity, assignment, quote, and delivery attestations. Keep production attester keys outside browser bundles and source control. Only verified deployment configuration selects authorized issuers. A source-level key rotation is not a substitute for revoking the old key under the deployed contract rules. Do not create a path for an operator or AI model to move customer funds outside the documented state machine.

## Events, retries, and failure behavior

The live indexer accepts events only from an allowlisted network fingerprint, chain ID, contract address, and ABI. It verifies receipt status and canonical block/hash and binds event fields back to the task terms. A transaction hash submitted by a browser is a lookup hint, not proof of payment.

Store raw events with network, contract, transaction hash, log index, and block hash. Preserve fork history with canonical status instead of overwriting evidence. Persist scan and confirmation cursors with their block hashes. Apply derived ledger entries once per confirmed event, and reconcile contract liabilities, credits, withdrawals, and application projections. If chain state cannot be established or balances diverge, stop new live money writes and exports that depend on that state; retain safe read/recovery paths.

Domain changes and outbox jobs belong in one database transaction. Consumers must tolerate at-least-once delivery. Idempotency is scoped by organization, actor, route, and key; reusing a key with a different payload returns a conflict. A timeout after broadcast becomes unknown/pending until reconciled, not an automatic second payment.

## AI and demo data

Customer text, reviewer notes, and quoted instructions are untrusted data. AI output cannot change permissions, sign an approval, choose a payment transaction, or fetch arbitrary URLs. P0 uses structured supplied facts; a later web-fetch feature needs a separate SSRF and data-exposure design. Apply input/output size limits, timeouts, bounded retries, and cost limits. If AI fails, disclose the missing assistance and continue the human workflow; do not prevent valid refunds or withdrawals.

Fixtures and screenshots must be synthetic. Redact secrets, raw identities, source text, private hashes, and salts from telemetry by default. Publish only the minimal status and deployment evidence needed for verification; a private receipt is shared only through an explicit access mechanism. The local demo is intended for a trusted development environment until real authentication, deployed tenant isolation, storage permissions, rate limits, operational recovery, and live-chain gates have been verified.
