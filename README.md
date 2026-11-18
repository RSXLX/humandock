# HumanDock

**Human review, exact-version approvals, and native-asset escrow for AI-generated content.**

HumanDock is an MVP for teams reviewing short US-English advertising copy. A brand submits a fact sheet and draft, an invited reviewer delivers one immutable report, and the brand separately accepts the service and approves the exact reviewed version for export.

**Status: an isolated DEMO workflow and a wallet-to-withdrawal workflow on a local EVM are implemented. HumanDock has not been deployed to remote ME Network. No HumanDock MEC payment or actual user ME identity verification is claimed.** Test commands and fixtures are provided; their presence does not establish a passing CI run or remote ME end-to-end result.

[中文说明](README.zh-CN.md) · [Shared and demo API](docs/api-contract.md) · [Wallet and chain API](docs/live-api.md) · [Network evidence](docs/network-verification.md) · [Security](docs/security-model.md) · [Roadmap](docs/roadmap.md)

## Implemented scope

- Next.js review workspace, Fastify API, and PostgreSQL-compatible persistence.
- A separate DEMO mode with synthetic actors and an isolated integer ledger.
- Browser-bound wallet sign-in, typed signatures, configured reviewer invitations, and a separate identity admission check.
- Frozen signed quote → contract funding → assignment → reviewer and delivery-gate signatures → acceptance, refund or dispute settlement → pull withdrawal.
- Exact transaction-intent validation, confirmation depth, canonical event projection, persisted cursors, replay, and separate withdrawal reconciliation.
- Independent service payment and content decisions: a completed BLOCK report can be paid; only PASS with an exact, valid brand approval permits export.
- Fixed-byte TXT export and a private JSON receipt. Every download and receipt request rechecks authorization, content integrity, expiry and revocation. A changed version cannot borrow an older approval.

## Quick start

Use Node.js **22 or 24**, npm, and a supported desktop browser:

```bash
git clone https://github.com/RSXLX/humandock.git
cd humandock
npm ci
cp .env.example .env
```

Choose one development mode at a time; both use the same default web/API ports.

### 1. Isolated application demo

```bash
npm run dev
```

Open **http://localhost:3000**. The API is on **http://127.0.0.1:4000**, proxied through `/api/v1`. No wallet, token, AI API key or Docker is required. The default PGlite database persists under `.data/pglite`; `DATABASE_URL` selects PostgreSQL.

Use **Brand studio** to create and fund a task, **Invited reviewer** to accept and deliver its report, then the brand to accept the service and approve the exact content version. Export it, create a changed version to exercise the mismatch check, and revoke the old approval. The reviewer can withdraw allocated DEMO credits. These are local bookkeeping operations with no blockchain transaction.

The fixture role selector belongs in a trusted local development environment. Switching roles replaces the browser session and clears private workspace state.

### 2. Wallet and actual contracts on a local test chain

```bash
npm run dev:me-local
```

This runner starts Ganache, deploys the actual contracts, starts the API in chain-backed mode, and starts Next.js. It injects an explicit local identity fixture; it does not contact ME or enable a production identity bypass.

| Setting | Default |
|---|---|
| Browser | `http://127.0.0.1:3000` |
| API | `http://127.0.0.1:4000` |
| Wallet RPC | `http://127.0.0.1:18545` |
| EVM chain ID | `31337` |
| Currency | `LOCAL`, with no value |
| Identity | `local_test`, never ME-verified |
| Database | In-memory; reset with the chain on every run |

The runner prints the buyer/reviewer addresses and writes `.data/local-me-runner/fixture.json`, including the **public development mnemonic** and account list. Use those accounts in a disposable test-wallet profile. They are public test credentials; never send real assets to them. This runner deliberately ignores `DATABASE_URL` so chain and application state reset together.

Connect an EIP-1193 wallet to the local chain, sign in as the buyer, refresh the local identity fixture, choose the invited reviewer, and create a task. Follow the transaction panel for funding. Use the reviewer account for assignment and delivery, then the buyer for service acceptance and exact-version approval; finally use the reviewer to withdraw. Each signature or transaction remains a wallet action. Preserve a broadcast transaction hash before registering it with the API; retries reconcile that transaction instead of automatically sending another one.

The automated browser fixture uses an injected EIP-1193 test provider. It does not prove compatibility with every wallet extension or with ME Pass.

## Architecture and execution boundaries

| Area | Implementation |
|---|---|
| `apps/web` | Next.js 16 / React 19, review workspace and wallet transaction panels |
| `apps/api` | Fastify, sessions, private task storage, chain intents and event projections |
| `packages/domain` | Review state machine, immutable manifests, exact integer allocation |
| `packages/me` | Network/identity adapters, deployment verification, signatures, canonical reads and accounting |
| `contracts` | `ReviewEscrow` and `ReleaseRegistry` |
| `tests` | Domain, API, contracts, ME adapters, wallet behavior and browser scenarios |
| `docs` | API contracts, evidence, trust boundaries and gated roadmap |

`APP_MODE=demo` uses the isolated ledger. `APP_MODE=me` uses wallet and contract paths; `ME_NETWORK` distinguishes `local`, `me-testnet` and `me-mainnet`. A configuration string does not make a deployment ready. The API requires the configured chain, contract code and roles, synchronized canonical state, and the applicable unit/identity admission gates. Existing settlement, refund and withdrawal paths do not require fresh identity admission.

The indexer and replay path are implemented. Production PostgreSQL RLS deployment, an external immutable object store, a separate transactional outbox, hosted key management and a complete security review remain unfinished; see [security-model.md](docs/security-model.md).

### Money and review rules

`F = W + P`, where W is reviewer compensation and P is the platform fee. Normal acceptance allocates W to the reviewer and P to the platform. Pre-assignment cancellation or missed delivery refunds F. A dispute divides W and refunds P. After an unresolved 72-hour arbitration period, the agreed fallback divides W in half, with quantum rounding, and refunds P; this is a bounded pilot rule, not an objective fairness guarantee.

Settlement creates **claimable credits**. A separate confirmed withdrawal transfers funds, and balance reconciliation is a further check. The API's existing `*Atoms` amount fields carry decimal integer **EVM wei**, not Cosmos bank atoms. Never use floating point money writes.

A read-only, same-height testnet observation supports **8 bank decimals** and **10^10 EVM wei per `umec`** for that observed ME deployment; see [network verification](docs/network-verification.md) and the [machine evidence](packages/me/observations/testnet-units-verified.json). It does not prove HumanDock funding/splitting/withdrawal on ME, or mainnet behavior. Ganache has no actual ME Cosmos bank.

The contracts are non-upgradeable and support EOA typed signatures in this milestone. The owner can pause new funding and assignments; existing delivery, dispute, settlement, refund and withdrawal paths remain callable. The product performs controlled exports, not advertising-platform publishing or legal certification.

## Verification commands

```bash
npm run typecheck
npm test
npm run contracts:compile
npm run test:contracts
npm run test:me
npm run test:wallet
npm run test:live
npm run test:browser:live
npm run build
```

| Command | Scope |
|---|---|
| `npm test` | Domain and application API behavior |
| `test:contracts` | Actual Solidity bytecode on an isolated local EVM |
| `test:me` | Chain, identity, unit, signature and accounting adapters |
| `test:wallet` | Frontend wallet and transaction safety checks |
| `test:live` | Local chain-backed API integration |
| `test:browser:live` | Browser through API and local chain using the test wallet provider |
| `test:browser` | Separate DEMO browser flow |

Browser tests need Playwright's Chromium installation. Check the output and the relevant Actions run for the exact checkout; this README does not assert that every command or CI job has passed. None of these local fixtures proves remote ME execution.

When updating dependencies, preserve `optional: true` for Ganache's nested macOS-only `fsevents` package; npm can lose that upstream shrinkwrap marker ([npm/cli#7622](https://github.com/npm/cli/issues/7622)). Check a clean Linux `npm ci` after lockfile changes.

## Remote ME configuration and remaining gates

[`.env.example`](.env.example) is the complete configuration reference. Entrypoints load `.env`; explicit process environment values take precedence. Keep server attestation keys and RPC credentials out of version control. User spending keys remain in the user's wallet.

Remote operation needs explicit network/RPC settings, a deployment manifest with code hashes and roles, matching unit evidence, an invited reviewer list, a documented identity policy and stable HMAC secret, and the quote/assignment/delivery attestation keys. `ME_PUBLIC_RPC_URL` is optional public wallet configuration; do not place a private credential in it. The observed ME gas model is configured separately from ordinary local EVM gas accounting.

```bash
npm run me:preflight
```

Preflight is read only: it does not deploy, read a wallet spending key or transfer funds. The investigation confirmed testnet EVM chain ID **400** and working official HTTPS Cosmos REST/Tendermint services. The published EVM RPC uses HTTP; an officially supported HTTPS EVM endpoint remains unresolved. REST and Tendermint endpoints are not substitutes for EVM JSON-RPC, and the application's non-local HTTPS policy remains in force. The official faucet is documented, but this work did not request tokens. Details and pinned evidence are in [me-integration.md](docs/me-integration.md) and [network-verification.md](docs/network-verification.md).

Primary source pins include the [official JS SDK](https://github.com/openmetaearth/meta-earth-js-sdk/tree/a56f3e936396de8689c2fc8667ad7306765eee9f) and the [ME Hub release matching the observed testnet node](https://github.com/openmetaearth/me-hub/tree/e725a569564900d76681489540271227fce9649a). Source inspection and read-only observations do not substitute for a HumanDock deployment.

Before claiming remote ME completion:

1. Close **G0** with an authorized ME Pass/ecosystem capability comparison. Public search has not established that no complete equivalent exists.
2. Obtain supported secure EVM access and authorized test funds for the intended network.
3. Confirm the applicable official identity-level policy, including any HARBOR advanced-verification mapping, and test only authorized wallets.
4. Deploy the pinned contracts and retain code, role, transaction and canonical block evidence.
5. Exercise the full remote workflow, recovery and EVM/bank reconciliation with bounded test funds.
6. Complete hosted tenant isolation, storage, key management and recovery controls before admitting real customers or value.

### Canonical replay

For a configured deployment, stop other API/indexer processes and back up the database before running:

```bash
npm run me:reindex -- --execute
```

The command requires `APP_MODE=me` and the matching database/deployment configuration. It rebuilds derived state from canonical confirmed logs, archives old event evidence, and sends no transaction. It is not a refund, a redeployment or a substitute for backups of private text, reports and salts. Keep the service gated until replay succeeds; see [live-api.md](docs/live-api.md).

## AI assistance and privacy

AI assistance is optional. Without a configured provider, the UI labels the result as local rules. Neither provider output nor a local rule approves content, signs a contract action or authorizes payment. Use synthetic data for public demos; private receipts may contain the final manifest and salt and must stay private. No third-party DID record has been added to this repository.

## License

The repository is **UNLICENSED** pending an explicit licensing decision. No complete unlicensed ME SDK implementation has been vendored.
