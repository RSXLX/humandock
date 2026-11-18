# Security model and implementation boundaries

This document separates implemented controls, local evidence, and requirements for a hosted remote-ME service. It is not an audit certificate. Test evidence supports only the code and environment actually exercised; a local EVM result is not proof of an ME deployment.

## Modes and protected assets

| Mode | Authority | Boundary |
|---|---|---|
| `APP_MODE=demo` | Synthetic sessions and an isolated DEMO integer ledger | Trusted local development only; no wallet proof or real custody |
| `APP_MODE=me`, `ME_NETWORK=local` | Wallet signatures, actual local contracts, confirmed local events | Explicit local runner uses `local_test` identity; no ME ID or Cosmos bank claim |
| `APP_MODE=me`, remote ME network | Configured wallet/identity adapters, verified deployment, canonical confirmed state | Implemented path remains gated; no HumanDock remote deployment or funds flow has been demonstrated |

Mode values are validated. Demo sessions cannot authorize chain-backed requests, and chain sessions must match the configured chain. Configuration alone does not make writes ready: chain ID, deployed code/roles/quantum and event synchronization must pass. New admissions additionally require identity policy, unit evidence and the appropriate attesters. The explicit local runner injects its identity fixture in process; no production environment variable activates a synthetic identity verifier.

Protected data includes customer text and facts, immutable reports, private salts/manifests, membership, session tokens, signing credentials and approval/settlement records. User spending keys, identity documents, biometrics and unrelated private project data do not belong in the repository or public output. Only public development keys belong in the disposable local fixture. No third-party DID record has been stored in this repository.

### Current limits

The application implements authorization, concurrency checks, transactional idempotency, wallet authentication, chain intents, persisted event cursors and operator replay. Hosted PostgreSQL RLS/roles, full compound tenant constraints, an external immutable object store, a separate transactional outbox and managed key operations remain acceptance work. A configurable PostgreSQL connection is not evidence that those controls exist.

The contracts are non-upgradeable, use EOA signatures and make the task buyer the brand approval authority. Contract-wallet signature validation and delegated brand approvers are deferred. Public wallet and transaction metadata remain linkable despite private application identity aliases.

## Trust boundaries

| Component or actor | Trusted for | Not trusted for |
|---|---|---|
| Browser and wallet UI | Requesting an action and obtaining the user's signature | Authoritative role, identity, price, deadline, balance or export eligibility |
| Application API | Validation, authorization, private storage, exact intent construction and controlled export | Declaring an unconfirmed hash final or manufacturing identity policy |
| Reviewer | Signing a verdict about an exact final artifact | Granting brand export permission or changing escrow rules |
| Delivery attester | Schema, signatures, exact artifact linkage and retrievability | Report quality or legal correctness |
| Brand approver | Exact commitment, purpose and expiry | Implicit approval of a changed file or rewriting the reviewer verdict |
| Arbitrator | The agreed allocation of the reviewer service fee | Altering delivered content or resetting deadlines |
| ME identity source | Observed account/identity state under a documented policy | English skill, review quality, or total anonymity |
| AI provider | Bounded suggestions | Identity proof, final approval, signature or payment authorization |
| Confirmed contract state | Records for the exact verified deployment | Recalling downloaded text or proving off-chain quality |

The quote issuer, assignment issuer, delivery attester and arbitrator are explicit trusted roles. The system is not wholly trustless. Attestation keys are distinct from user spending keys; the API constructs transactions but does not hold a user's wallet key or automatically broadcast their payments.

## Wallet authentication and identity admission

Wallet sign-in uses a stored, one-use SIWE challenge with domain/origin, URI, account, chain ID, random nonce and five-minute expiry. A separate HttpOnly browser cookie binds the challenge to the initiating browser. Verification consumes it transactionally and replaces any prior session. An eight-hour session proves wallet control, not ME identity.

Sessions use HttpOnly and SameSite=Strict cookies; Secure is enabled for the configured HTTPS chain-mode origin. Browser writes use origin validation and CSRF tokens. Auth bootstrap uses origin and challenge-cookie binding instead of a preexisting CSRF token. Logout and AI assistance require CSRF; ordinary business mutations also use idempotency keys. The frontend invalidates authentication after an account change and blocks signing on the wrong chain. See [live-api.md](./live-api.md).

Reviewer roles come from a server-configured invitation list. The browser cannot grant itself a reviewer role. ME identity admission resolves the EVM address through the official bank-account route, validates its address representation, and checks main/sub-account binding, active status and the configured minimum KYC policy with consistent observed heights. Missing, ambiguous or unavailable evidence is not accepted as verified identity. Only the signed-in, authorized wallet is checked; no public identity directory is collected.

The application uses keyed private canonical aliases to prevent self-review across mapped main/sub-account wallets. It does not publish a bare hash of a public DID. A task freezes the identity-key fingerprint: changing `ME_ID_HASH_SECRET` blocks new funding/assignment admissions for that task until the key is restored or explicitly migrated. Existing delivery and exit paths do not depend on a fresh KYC decision. Back up the stable key with the database; an automatic versioned key migration is not implemented.

Quote and assignment attestations have short expiry. A signature already issued can remain valid on chain until its expiry even if off-chain identity changes; this is not instantaneous revocation. HARBOR's “advanced” verification still needs an official numeric policy mapping. A configured minimum is an application policy, not proof of hackathon eligibility.

## Tenant isolation and concurrency

Application reads and mutations check organization, actor, task role and execution environment. Live task/intents/ledger handling also scopes the configured chain and deployment. The assigned cross-organization reviewer receives access to that task; it is not a global organization bypass. Resource responses omit private task salts/manifests except the explicitly private authorized export receipt.

Business mutations run under database transactions with expected task versions and actor/route/key/body-hash idempotency. Chain-mode idempotency is scoped to the chain, escrow and wallet actor. Same-key different-input requests fail; ordinary same-input retries return the original response. Identity refresh and reconciliation retain key/body consistency but reread changing external state instead of caching an old success.

A hosted database must additionally enforce ownership with compound references and PostgreSQL RLS `USING` and `WITH CHECK`, using a non-owner application role and transaction-local tenant context. Those server roles/policies need actual deployment verification; PGlite does not prove them. See [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html).

## Immutable versions and controlled export

A task records purchased input **A** and its brief. The reviewer may propose **B** before delivering one final report. Later edits create a new version and require a new review task; they do not overwrite the report or restart its deadline. Quote issuance freezes the purchased input and terms.

The final manifest binds the task/input, exact reviewed bytes and verdict. Source and final manifests use independent random 256-bit salts and distinct commitment domains. The reviewer and gate sign the same verdict-bearing delivery envelope. Public contract records contain `taskCommitment` and `deliveryCommitment`, not the private manifest/report hash, salt or raw text. This reduces short-text guessing but does not hide wallet metadata. Canonical JSON and frozen UTF-8 text bytes must remain deterministic; see [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785).

Every actual download and receipt request requires:

1. The actor may read the requested task/version in the current execution environment.
2. The immutable reviewed version and manifest match a final `PASS` report.
3. The brand approval binds that exact commitment, export purpose and expiry.
4. Approval is unexpired and unrevoked in a current confirmed chain view for chain mode.
5. The server recomputes the fixed stored version's digest/commitment and emits the same bytes, without substituting a `latest` object.

`BLOCK` and `CHANGES_REQUIRED` can complete a payable service but cannot pass this gate. Service settlement is independent from export approval. There is no override, advertising-platform publishing, or consume-per-export transaction. Repeated authorized downloads cost no additional review fee.

Export creation is idempotent and may return previously created metadata. That metadata is not a bearer capability: the download and private receipt endpoints always recheck current authorization and approval. The current implementation stores immutable versions in the database; production protected object storage remains separate work.

The demo receipt has `chain: null` and an explicit local-DEMO notice. A chain receipt records the observed block number and hash; local-chain receipts explicitly disclaim ME certification. Receipts contain private manifest/salt evidence and are not public certificates. A revocation confirmed before validation blocks export. No system promise recalls already downloaded bytes or makes chain revocation atomic with bytes already in flight.

## Money, signatures and deadlines

All amounts are integers, `F = W + P`. Normal completion allocates W to the reviewer and P to the platform. Pre-assignment cancellation or missed delivery refunds F. The 48-hour post-delivery dispute window is fixed. Disputes divide only W and refund P; after 72 hours without arbitration, the agreed quantum-aligned 50/50 fallback divides W and refunds P. This resolves deadlock; it is not a quality-fairness guarantee.

Chain timestamps define contract deadlines. Before-deadline actions use `<`; timeout actions use `>=`; retries do not reset them. Terminal transitions allocate claimable credit once. A separate pull withdrawal transfers it. Successful settlement is not equivalent to external-wallet receipt or reconciled bank movement.

EIP-712 structures bind the relevant actor, task, commitment, nonce, expiry, chain and contract, with monetary/deadline fields as appropriate. Purpose-separated signatures and contract nonce consumption prevent cross-action replay. EIP-712 alone is not replay protection; see [the specification](https://eips.ethereum.org/EIPS/eip-712). A database cancellation flag cannot invalidate an already issued on-chain authorization before expiry.

Fee inputs and splits must preserve the deployment's immutable monetary quantum. Testnet read-only evidence supports `q = 10^10 wei` for the observed ME deployment; it is not a HumanDock funding/splitting/withdrawal test or a mainnet guarantee. Existing API `Atoms` fields are EVM wei strings, not bank atoms. ME fee reconciliation accounts for bank-rounded prepayment/refund; ordinary EVM mode uses its own explicit gas model. Details: [network-verification.md](./network-verification.md).

The owner can pause new funding and new assignments, not existing delivery, dispute, settlement, refund and withdrawal paths. Local contract tests exercise actual bytecode, including replay, deadlines, allocation and receiver failures. External review remains necessary before real custody.

## Transaction confirmation, reorganization and replay

A submitted hash is only a hint. Before confirmation, the server verifies the transaction's chain, sender, target, calldata and value against its intent, then checks receipt success, canonical block/hash and required confirmation depth. `confirmed` receipt status and `applied` projection status are separate. A mismatched transaction is rejected and cannot make the intent applied.

Replacement recovery uses an already observed sender/nonce. An exact-call speed-up can continue confirmation; a different call is marked replaced only after nonce consumption is confirmed. An unknown original nonce is not guessed. Neither UI nor API automatically resends an uncertain transaction. Provider or pruned-history failures can need operator investigation.

Event identity includes chain, contract, block hash, transaction hash and log index. Event insertion, task/ledger effects and cursor advancement commit together. The scanner checks the prior checkpoint before and after the scan and verifies the boundary parent link. Detected reorganization blocks writes/exports and persists the blocked cursor. Receipt or withdrawal-snapshot reorgs also block the deployment.

The operator stops API/indexer processes, backs up the database, then uses `npm run me:reindex -- --execute` for the matching deployment. Replay archives prior event evidence and rebuilds derived projections from canonical confirmed logs and immutable private records. It sends no transaction and cannot restore missing text or salts. A separate outbox for additional external side effects is not implemented or claimed.

Withdrawal evidence distinguishes `verified`, `evm-only`, `unverified` and `mismatch`. Matching EVM snapshots alone do not prove a ME bank reconciliation. Historical unavailability or concurrent wallet activity can prevent an isolated balance proof without implying that the confirmed contract transaction failed. Preserve this distinction in the UI and audit evidence.

## Remaining hosted-service gates

Before admitting real customers or value, close the ecosystem-overlap decision, supported secure EVM access, official identity policy, remote deployment and authorized workflow evidence. Complete tenant DB roles/policies, private storage/backups, managed issuer keys, incident/replay procedures and contract/application review. Use [.env.example](../.env.example) for configuration, [live-api.md](./live-api.md) for the implemented protocol and [roadmap.md](./roadmap.md) for acceptance gates. These requirements are not claims of completed production hardening.
