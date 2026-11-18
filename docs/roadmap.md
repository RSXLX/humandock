# HumanDock roadmap and acceptance gates

Planning baseline: **2026-11-18 UTC**. The product is limited to US-English short advertising text, one final human review per service task, and controlled export of an exactly approved version. Expansion remains conditional on the ecosystem-overlap gate.

## Current implementation and evidence

| Layer | Implemented scope | Remaining boundary |
|---|---|---|
| DEMO application | Next.js/Fastify, persistent PGlite or PostgreSQL, synthetic actors, immutable review workflow, isolated integer ledger | No real identity or MEC custody |
| Local chain application | Browser wallet sign-in, injected local identity fixture, actual contract deployment, signed intents, funding/delivery/settlement/withdrawal, confirmed event projection and replay | Local Ganache, no actual ME ID or Cosmos bank; test files are not a passing test result |
| ME adapters and observations | Network/deployment checks, official account/identity routes, read-only testnet chain/height/hash/unit evidence, reconciliation adapters | No HumanDock remote deployment or remote payment flow; supported HTTPS EVM and official advanced-tier mapping remain open |
| Hosted operation | Application authorization, sessions, idempotency and private storage interfaces | Production RLS rollout, immutable object storage, key management, operational recovery and full security review remain gates |

`APP_MODE=me` now selects the chain-backed application path. It does not certify readiness: configured network/deployment checks and a healthy confirmed event cursor gate writes, with additional unit and identity requirements for admissions. The explicit local runner injects a fixture identity only into that development process. No production environment switch enables it. Details: [live-api.md](./live-api.md), [security-model.md](./security-model.md).

## Milestones

### M0 — Reproducible local feasibility

Two local execution modes are implemented:

- `npm run dev`: persistent DEMO workflow without a wallet or blockchain transaction.
- `npm run dev:me-local`: local Ganache, actual contracts, real wallet signatures, chain-backed API and UI, and an explicitly labeled `local_test` identity fixture. Chain and in-memory database reset together.

Keep actual command outputs for the tested commit. Relevant commands are `npm test`, `npm run test:contracts`, `npm run test:me`, `npm run test:wallet`, `npm run test:live`, and `npm run test:browser:live`, plus typecheck/build. This roadmap does not assert that CI or every scenario has passed.

Acceptance evidence should demonstrate:

- A brand freezes input A and the terms; a reviewer delivers one immutable report about exact A or proposed B.
- Wallet login proves wallet control; local identity is visibly a fixture and does not claim ME verification.
- Funding, assignment, double-signed delivery, settlement/refund and withdrawal use actual local contract receipts in chain mode.
- Broadcast, receipt confirmation, canonical event application, and balance reconciliation are distinct states.
- PASS plus an exact unexpired, unrevoked approval permits export; changed/non-PASS content cannot pass the gate.
- Repeated authorized downloads do not charge again; both download and private receipt recheck current authorization.
- Retry, rejected prompts, wrong chain/account, transaction replacement, changed block hashes and restart recovery are exercised by the relevant tests or recorded manual checks.

Local event indexing, persisted cursors, receipt checks and operator replay are implemented. `npm run me:reindex -- --execute` reconstructs derived projections for a configured deployment; stop competing API/indexer processes and back up the database first. It neither sends transactions nor recreates missing private source content.

### G0 — Close the ecosystem-overlap decision

Review the actual ME Pass application wall and credible ecosystem/partner inventory using authorized access. Compare candidates against the complete workflow in [ecosystem-gap.md](./ecosystem-gap.md). The current public search did not establish absence. If a complete equivalent exists, stop duplicating it and assess an integration or a missing component before expanding scope. Local prototype work is not evidence that this product decision has been closed.

### G1 — Complete target-network and identity verification

Read-only observations have established testnet EVM chain ID **400**, Cosmos chain `mechain_400-1`, official HTTPS REST/Tendermint services, and a nonzero system-account balance comparison at one canonical height supporting **8 bank decimals** and **10^10 wei per umec**. See [network-verification.md](./network-verification.md) for source pins, heights, hashes and raw observations. These observations apply to the observed testnet deployment; they do not establish mainnet behavior or HumanDock transaction behavior.

Still obtain a supported secure EVM endpoint, the accepted hackathon target environment, authorized test funds and authorized identity fixtures. The official faucet is known, but no token claim was made. Confirm the numeric identity policy and the meaning of HARBOR “advanced” verification; publicly observed enum names do not establish that equivalence. Validate the actual wallet's challenge, typed-data and transaction flows. Keep unsupported routes and unresolved policy explicit.

### M1 — Demonstrate HumanDock on remote ME

After G1, deploy the pinned contracts to the confirmed target environment using the explicit deployment tooling. Record compiler/EVM settings, code hashes, contract addresses, constructor roles, deployment transactions, confirmation policy and source commit. Deployment is not an automatic effect of starting the API.

Use authorized, bounded test funds to exercise funding, assignment, delivery, normal settlement and withdrawal, undelivered refunds, a dispute branch, and approval/revocation. Repeat same-height balance checks for the configured deployment, then reconcile actual HumanDock EVM and bank movements, quantum-aligned splits, fee prepayment/refund behavior and conservation. Read-only unit evidence alone does not close this milestone. Keep mainnet disabled during these tests.

### M2 — Hosted security and operational acceptance

Run the implemented wallet, identity, intent and indexing code against that verified remote deployment. Exercise historical RPC unavailability, missing or rejected identity, expired attestations, duplicate logs, replacement transactions, reorganization, replay and process restarts. Require exact transaction matches and canonical confirmed state; do not treat a wallet transaction hash as final payment.

Complete the remaining hosting controls: actual PostgreSQL non-owner roles/RLS and compound tenant constraints, private immutable object storage and backup/restore, narrowly scoped reviewer grants, protected issuer keys, alerting, and a durable outbox if background external side effects are introduced. Test deployment-scoped recovery with the private reports and salts needed for projection. A local PGlite or Ganache result is not hosted security evidence.

### M3 — Small, measured product validation

Recruit a small authorized group of brands and qualified reviewers. Use deliberately bounded ad categories and structured supplied facts. Measure time to usable review, factual issues found, revision rate, successful exact-version export, disputes, and completion/retry failures. Record actual observations; do not prefill customer numbers, revenue, accuracy, time saved, or acquisition claims.

Review is an editorial service, not a guarantee of platform approval or a legal certification. Reviewer skill screening is independent from identity verification. Refine the demonstrated need before expanding channels or market features.

### M4 — Reproducible HARBOR submission

Freeze the tested commit and preserve the incremental work history. Package English project documentation, a 3–5 minute demonstration with English narration or subtitles, execution instructions, a usable experience, and actual ME contract/transaction/call evidence for the core integration claim. Prepare a clearly labeled local fallback if a provider is unavailable. Reserve the final 48 hours for submission and access checks.

## HARBOR facts affecting this schedule

Source: [official event page](https://www.mec.me/zh-TW/hackathon/harbor), checked 2026-11-18, and [official announcement](https://www.mec.me/en-US/developer-blog/harbor-2026-a-total-prize-pool-of-100-000-usdt-build-the-nex).

| Item | Published rule or date |
| --- | --- |
| Team | 2–5 members; every member completes advanced ME ID verification |
| Registration deadline | 2026-11-27 15:59 UTC |
| Project submission deadline | 2026-12-21 15:59 UTC |
| Scoring | Technical 30; ME integration 25; product value 20; innovation 15; user experience 10 |
| Materials | English; repository/final commit/run instructions; 3–5 minute demo; experience access; ME execution records |
| Existing work | Declare prior work and identify hackathon-period increments through versions/commits |
| Core requirement | At least one core function actually runs on ME Network |

The detailed event schedule and official announcement use **2027-01-15** for Demo Day; the event-page banner still shows an end date of **2027-01-05**. This discrepancy does not move the December submission deadline. The event page and announcement also contain differing wording about participation in another regional event; do not infer cross-registration eligibility from this roadmap. Recheck current official rules for any relevant registration decision. No registration or message to the organizer has been performed by this project documentation task.

## Deliberately deferred scope

- External advertising-platform publishing, OAuth integrations, and on-chain consume-per-export operations.
- IP licensing, copyright adjudication, legal-compliance certification, and unrestricted ad categories.
- Open reviewer marketplaces, token incentives, staking/slashing, reputation trading, or a new token.
- Microservice decomposition, multiple chains, and a custom Rollapp unless an independently validated requirement emerges.
- Automatic live deployment or money movement merely because configuration values are present.

## Release evidence checklist

For each milestone, keep the code commit, test commands and outcome, environment mode, source/deployment configuration, known gaps, and evidence owner. Before any live claim, verify the chain/network identity, deployed bytecode, actual receipt, canonical block/hash, and the exact feature exercised. Before any public uniqueness claim, close G0 with a dated capability comparison. Before calling the application production ready, complete the operational and security checks in [security-model.md](./security-model.md).
