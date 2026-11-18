# HumanDock roadmap and acceptance gates

Planning baseline: **2026-11-18 UTC**. The product is limited to US English short advertising text, one final human review per service task, and controlled export of an exactly approved version. Expansion is conditional on the ecosystem-overlap gate.

## First implementation milestone

The initial repository separates three kinds of evidence:

| Layer | Scope | What it must not imply |
| --- | --- | --- |
| Local application | Next.js/Fastify demo, persistent PGlite or configured PostgreSQL, synthetic actors, immutable content workflow, isolated DEMO integer ledger | Real paid customers, live identity verification, or MEC custody |
| Contract implementation | Solidity sources, compilation, and tests on a local EVM with solc/Ganache/viem | A live ME deployment or an external audit |
| ME integration preparation | Explicit network configuration, identity/network adapters and read-only preflight, source evidence and gates | That unavailable credentials, test tokens, wallet support, or network semantics have been verified |

The project must keep `APP_MODE=me` money-changing application operations closed until live integration is ready. Preserve reproducible test output for the actual checkout. This roadmap does not assert that every future acceptance check is already passing.

## Milestones

### M0 — Local end-to-end feasibility

Run `npm run dev`, `npm test`, `npm run contracts:compile`, and `npm run test:contracts` from the repository root. Verify the exact commands and results in the checkout rather than inferring success from the presence of a test file.

Acceptance evidence:

- A synthetic brand creates input A and a review task with fixed terms; DEMO funds stay inside the local ledger.
- An assigned synthetic reviewer supplies one final structured report about exact version A or proposed B.
- Review completion and payment remain distinct from the brand's decision to approve export.
- `PASS` plus exact, current approval permits export; non-PASS, stale/mismatched/revoked approvals do not.
- Repeated export of the same approved artifact does not charge again, and a new version cannot reuse an old approval.
- Local contract tests execute the settlement and approval state machines; failures and unfinished cases are reported accurately.
- Demo mode, fixture identities, local transactions, and unavailable live integration are visibly identified.

### G0 — Close the ecosystem-overlap decision

Review the actual ME Pass application wall and credible ecosystem/partner inventory using authorized access. Compare candidates against the complete workflow in [ecosystem-gap.md](./ecosystem-gap.md). The current public search did not establish absence. If a complete equivalent exists, stop duplicating it and assess an integration or a missing component before expanding scope.

### G1 — Verify the target ME network and identity policy

Obtain the officially accepted hackathon network, secured RPC configuration, expected EVM chain ID, explorer/network fingerprint, test tokens, and authorized identity fixtures. Verify active/advanced identity semantics and main/sub-account linkage, then test the actual wallet's challenge, typed-data, and transaction signing flows. Document source versions, observed blocks/hashes, and unsupported cases. See [me-integration.md](./me-integration.md).

### M1 — Demonstrate real ME contract behavior

Deploy the pinned contracts to the confirmed target environment. Record compiler/EVM settings, code hashes, contract addresses, constructor roles, deployment receipts, and source commit. Test funding, assignment, delivery, a normal claim/withdrawal, an expired task refund, a dispute branch, and approval/revocation using authorized test funds.

Independently confirm denomination and bank/EVM conversion. The source-derived `q = 10^10` wei per bank atom remains a candidate until measured on the actual deployment. Validate amount conservation and no unrepresentable dust across all splits. Keep mainnet disabled while testing these behaviors.

### M2 — Connect the application to confirmed live state

Replace fixture authentication and local ledger authority with the verified wallet/identity adapter and confirmed contract projections for the target environment. Implement canonical event indexing, persisted cursors, transactional outbox processing, idempotent effects, transaction recovery, and balance reconciliation. Exercise unavailable RPCs, rejected wallet prompts, missing identity records, expired credentials, duplicate events, changed block hashes, and process restarts.

Move hosted multi-tenant operation behind real authentication, verified PostgreSQL role/RLS policies, scoped reviewer grants, protected immutable object storage, key management, backups, and recovery procedures. Test exact-blob export against current approval state and retain a private receipt with block number and hash. Do not treat PGlite persistence or a passing local domain test as proof of hosted security.

### M3 — Small, measured product validation

Recruit a small authorized group of brands and qualified reviewers. Use deliberately bounded ad categories and structured supplied facts. Measure time to usable review, factual issues found, revision rate, successful exact-version export, disputes, and completion/retry failures. Record actual observations; do not prefill customer numbers, revenue, accuracy, time saved, or acquisition claims.

Make clear that review is an editorial service, not a guarantee of platform approval or a legal certification. Reviewer skill screening is independent from identity verification. If users only value a fraction of the workflow, refine that component before adding channels or market features.

### M4 — Reproducible HARBOR submission

Freeze the tested commit and preserve the incremental work history. Package English project documentation, a 3–5 minute demonstration with English narration or subtitles, execution instructions, a usable experience, and real ME contract/transaction/call evidence. Prepare a local fallback for review if a provider is unavailable, labeled as a fallback rather than live network activity. Reserve the final 48 hours for submission and access checks.

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
