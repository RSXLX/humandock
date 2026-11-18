# HumanDock

**Human review, version-bound approvals, and MEC escrow for AI-generated content.**

HumanDock is an early MVP for teams reviewing short US-English advertising copy. A brand submits a fact sheet and draft, an invited reviewer produces an immutable report, and the brand separately accepts the service and approves the exact reviewed version for export.

**Status: runnable local MVP + independently tested Solidity contracts. Not deployed to ME Network. No live MEC transfers or verified ME identities are claimed.**

[中文快速说明](README.zh-CN.md) · [ME integration evidence](docs/me-integration.md) · [API contract](docs/api-contract.md) · [Security boundaries](docs/security-model.md) · [Roadmap](docs/roadmap.md)

## What works in this version

- A Next.js review workspace with brand/reviewer role switching, task creation, a five-criterion report, and version history.
- A Fastify API with persistent PostgreSQL-compatible storage, session cookies, CSRF checks, tenant-scoped reads, optimistic concurrency and transactional idempotency.
- An explicitly isolated **DEMO** ledger for the UI workflow: fund, accept, deliver, accept service, refund on eligible timeout, dispute and withdraw local credits.
- Exact-byte approval and export checks. A modified version cannot borrow an older approval. Every download rechecks expiry and revocation.
- Independent content verdict and service payment: a completed BLOCK review can be paid, while its content cannot be approved.
- `ReviewEscrow` and `ReleaseRegistry`: signed quotes and task-specific assignments, double-signed deliveries, native-asset custody, dispute deadlines, refunds, pull withdrawals, and version-bound brand approvals.
- A strict ME network configuration/identity adapter, typed-data helpers, generated ABIs, and a read-only RPC preflight command based on pinned official source references.

## Quick start

Requirements: Node.js **22 or 24**, npm, and a supported desktop browser. No wallet, token, model API key or Docker installation is required for the local demo.

```bash
git clone https://github.com/RSXLX/humandock.git
cd humandock
npm ci
cp .env.example .env
npm run dev
```

Open **http://localhost:3000**. The API runs on **http://127.0.0.1:4000** and is proxied through the web app at `/api/v1`. Both services must run together. The demo binds to loopback; keep it private to your development machine.

The default database is embedded PostgreSQL (PGlite), persisted under `.data/pglite`. To use a separate PostgreSQL server, set `DATABASE_URL` before starting the API. This first milestone uses seven compact persistence tables; it does not claim the complete production schema, RLS rollout, immutable object store or chain indexer is implemented.

### Try the complete story

1. Choose **Brand studio** and create a task with a synthetic fact sheet and short draft.
2. Generate a quote, review the terms, and fund it with **DEMO** credits.
3. Switch to **Invited reviewer**, accept the assigned task, and complete all five review criteria. Submit a PASS report only when every criterion is OK.
4. Switch back to the brand. **Accept the review service** and **approve the exact version** are independent controls.
5. Export the approved copy and private demo receipt.
6. Create a changed version and try to export it using the old approval. The API rejects it with `APPROVAL_VERSION_MISMATCH`.
7. Revoke the approval. Previously created download URLs now fail authorization too.
8. Switch to the reviewer to withdraw allocated **local test credits**. No blockchain transaction is fabricated.

The other-organization fixture is available to exercise tenant isolation. Changing roles invalidates the old browser session and clears private workspace state.

## Architecture

| Area | Implementation |
|---|---|
| `apps/web` | Next.js 16 / React 19 UI |
| `apps/api` | Fastify API, sessions, PostgreSQL/PGlite persistence |
| `packages/domain` | State machine, immutable manifests, precise integer allocation |
| `packages/me` | ME configuration, identity mapping, RPC probe, EIP-712 types and ABI |
| `contracts` | Solidity escrow and approval registry |
| `tests` | Domain, API, local EVM, adapter and browser acceptance tests |
| `docs` | API, source evidence, security model and gated roadmap |

The UI demo and the local EVM tests are deliberately distinct execution environments. UI credits are never labelled MEC or represented as real chain receipts. Switching `APP_MODE=me` does **not** enable live money movement; unimplemented live authentication and transaction paths fail closed.

### Money and review rules

`F = W + P`, where W is reviewer compensation and P is the platform fee. The demo quote is 0.8 + 0.2 = **1.0 DEMO**, with integer accounting. A normal acceptance allocates W to the reviewer and P to the platform. Pre-assignment cancellation or undelivered expiry refunds F. Arbitration allocates W and refunds P; after a 72-hour arbitration timeout, the pre-agreed fallback allocates 50% of W to the reviewer and refunds the remainder to the buyer. This fallback is a limited pilot policy, not an objective fairness guarantee.

Contract amounts are EVM wei and must be multiples of the immutable deployment quantum. Do not equate Cosmos bank atoms with EVM wei. The source candidate `q = 10^10 wei` is documented, not accepted as a verified live network parameter.

The contracts are non-upgradeable and accept EOA typed signatures in this milestone. The owner can pause new funding and new assignments; existing delivery, dispute, settlement, refund and withdrawal paths remain callable. Production contract review is still required before handling real value.

## Verification

```bash
npm run typecheck
npm test
npm run contracts:compile
npm run test:contracts
npm run build
```

The test suite targets meaningful failure cases: repeated funding and withdrawal, cross-tenant reads, self-review, signed-data replay, exact deadline boundaries, BLOCK-but-payable reports, revocation, version replacement, storage integrity, and amount conservation. Contract tests compile and deploy the actual Solidity bytecode to an isolated local Ganache EVM.

Browser tests are provided for GitHub Actions. They start the API and web app together and walk the brand → reviewer → brand flow. A passing API test is not represented as a passing browser test; see the Actions run for its actual status.

When updating the lockfile, preserve the `optional: true` metadata for Ganache's nested `fsevents` dependency. It is a macOS-only optional package in the upstream shrinkwrap; npm can lose that marker while generating a root lockfile ([npm/cli#7622](https://github.com/npm/cli/issues/7622)). Always check a clean `npm ci` on Linux after dependency changes.

## ME integration

The implementation references the official JS SDK revision [`a56f3e936396de8689c2fc8667ad7306765eee9f`](https://github.com/openmetaearth/meta-earth-js-sdk/tree/a56f3e936396de8689c2fc8667ad7306765eee9f), ME Hub revision [`1e9eff8a5feae166fe9d72ad4bcc904622b078a1`](https://github.com/openmetaearth/me-hub/tree/1e9eff8a5feae166fe9d72ad4bcc904622b078a1), and the corresponding Ethermint source. No complete unlicensed SDK implementation has been vendored.

After obtaining verified configuration, populate the ME variables in `.env` and run:

```bash
npm run me:preflight
```

This command is **read only**. It does not read a wallet private key, deploy a contract or send funds. A successful RPC probe does not certify ME ID, denomination mapping, contract deployment or hackathon eligibility. The adapter requires HTTPS for non-local endpoints; the historical HTTP defaults in the official SDK are evidence, not automatically trusted deployment settings.

Before live ME activation:

1. Verify the ecosystem gap, including the ME Pass application wall. Public search alone does not establish that a complete competing product is absent.
2. Confirm the accepted network, HTTPS endpoint, actual chain ID and test-token source with the official documentation/support path.
3. Verify the live bank/EVM denomination mapping and a small deposit → split → withdrawal reconciliation.
4. Establish official ME ID status/advanced-level mapping and prove wallet control and parent/child account relationships.
5. Deploy reviewed contracts, configure purpose-specific attestation keys, and implement receipt validation and canonical event indexing.
6. Replace demo identities and ledger actions with wallet authentication and verified transactions; add production tenant isolation and operational recovery.

The current scope intentionally stops at the first runnable development milestone, not at a commercial mainnet release.

## AI assistance

Without credentials, the UI says **Local rules**. This deterministic helper flags some absolute claims and asks a human to inspect every rubric item. It is not presented as a model-generated or certified assessment.

An optional HTTPS chat-completions-compatible provider can be configured with `AI_API_URL`, `AI_API_KEY` and `AI_MODEL`. The backend caps input, output, request rate and timeout, validates the response, and falls back to labelled local rules on failure. Customer text is treated as data. Assistance cannot sign, pay, approve, arbitrate, or fetch arbitrary customer-supplied URLs.

## Configuration and safety

- Never commit `.env`, user content, real identity records, account credentials, model keys or funded wallet keys.
- Demo fixtures are synthetic. Keep demo mode local; do not publish it as a production service.
- A private receipt can contain a salt and manifest. Treat it as deliberately shared verification material, not public telemetry.
- Public repository visibility does not imply that ME integration or security review is complete.

## License

A project distribution license has not yet been selected. New project code is marked **UNLICENSED**. Third-party dependencies retain their own licenses; OpenZeppelin is imported as a dependency. Public visibility alone is not a license grant.
