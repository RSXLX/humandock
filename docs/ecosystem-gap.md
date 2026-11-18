# Ecosystem overlap review

Last limited public review: **2026-11-18 UTC**.

## Decision status

**G0 is open. Public research has not established that MetaEarth has no complete equivalent.** This repository is a bounded feasibility implementation while that question is unresolved. It must not be marketed as the first or only such product on ME.

The product constraint is to avoid rebuilding an already complete on-chain equivalent. If a working equivalent is found, compare it by actually exercising its documented workflow, then stop duplicating the complete product. Prefer an integration, an extension, or a genuinely missing component where justified. Changing the name or interface does not create a product gap.

## What counts as a complete equivalent?

HumanDock's current narrow use case is an independent human review of **US English short advertising text**, with service settlement separate from a brand's permission to export an exact version. Evaluate a candidate against the connected workflow, not a matching keyword:

| Capability | Evidence to request or inspect |
| --- | --- |
| Verified reviewer assignment | Identity/main-sub-account handling and independence checks |
| Paid review service | Escrow or equivalent settlement with usable cancellation, delivery, dispute, and withdrawal behavior |
| Immutable input and final report | Exact reviewed version, structured verdict, evidence, and signatures or verifiable records |
| Brand decision distinct from payment | Completed review can be paid even if verdict is `BLOCK` or `CHANGES_REQUIRED`; export is separately approved |
| Exact-version controlled export | Only a `PASS` version with a current matching approval can be exported; new content cannot borrow an old approval |
| Working ME integration | Actual network, contract/call records, and a demonstrable end-to-end user journey |

A wallet, identity SDK, app-listing portal, content generator, or generic task board may be an important dependency or adjacent competitor. Alone, its existence does not demonstrate the whole workflow. Conversely, a closed-source or wallet-only product can be a complete equivalent even if no public repository exists.

## Public evidence examined

| Source | Observation | Limit |
| --- | --- | --- |
| [Official Developer Center](https://www.mec.me/en-US/developer-center) | Public entry point to developer documentation, SDKs, infrastructure, and ecosystem support | It is not a comprehensive product inventory |
| [ME Pass Open Platform announcement](https://www.mec.me/en-US/developer-blog/me-pass-open-platform-is-now-live-calling-all-developers-to) | Officially describes developer authorization, application submission, review, and listing in the app wall and ME Pass | Describes a distribution channel; does not list every approved or pending app |
| [Public Open Platform landing page](https://mepassportal-open.mec.me/en-US) | Current anonymous HTML describes the listing process and shows login/submission entry points | The fetched public page did not provide a complete app catalogue; no signed-in wallet/session was inspected |
| [Official GitHub repositories](https://github.com/orgs/openmetaearth/repositories?type=all) | Public repository names/descriptions include SDKs, chain implementations, forks, documentation, and adapters | Names and public index results cannot exclude code in a private repository, partner app, or unreleased project |
| [HARBOR page](https://www.mec.me/zh-TW/hackathon/harbor) and [official event announcement](https://www.mec.me/en-US/developer-blog/harbor-2026-a-total-prize-pool-of-100-000-usdt-build-the-nex) | The competition includes AI/trust and consumer workflows and requires real ME integration | A track's existence says nothing about the absence of an existing product |

The current organization listing exposed these 16 repository names: `DefiLlama-Adapters`, `cometbft`, `cosmos-sdk`, `ethermint`, `evmos`, `go-log`, `kaspa-go-secp256k1`, `me-docs`, `me-hub`, `meta-earth`, `meta-earth-js-sdk`, `meta-earth-python-sdk`, `openroll`, `osmosis`, `rpc`, and `solana-go`. This is an observed public listing, not a claim that MetaEarth or its partners maintain only these projects. Individual repositories were not exhaustively audited for hidden product implementations.

Public search queries included:

```text
site:mec.me ("HumanTask" OR "HumanDock" OR "human review" OR "review marketplace")
site:mec.me ("task marketplace" OR "human-in-the-loop" OR "人工审核" OR "真人审核")
site:github.com/openmetaearth ("marketplace" OR "human" OR "review")
site:mec.me "ME Pass Open Platform"
```

The retrieved results did not identify a working complete equivalent. Some results concerned application-listing review or generic infrastructure, which are different workflows. This negative search result is weak evidence: search indexing is incomplete, terminology differs, and wallet-only, partner, private, and in-progress products may be absent.

## Required closure work

Before materially expanding beyond this feasibility milestone, record a review of the actual ME Pass app wall and available partner/application inventory using an authorized account. Collect candidate product URLs, network/contract identifiers when public, an observed workflow, exact overlapping capabilities, and the remaining gap. A registry entry or product description should be followed by a runnable demo where possible.

If a direct ecosystem inquiry is authorized later, ask whether there is an already deployed or actively supported paid human-review workflow with fixed-version reporting, escrow/dispute settlement, and independent brand export approval. The question is prepared here; **no inquiry has been sent**.

Use the following decision record without filling it with invented observations:

| Field | Required value |
| --- | --- |
| Reviewed on / reviewer | Date and responsible project role; no unnecessary personal data |
| Candidate | Official/product URL and version |
| Evidence | Demo result, published docs, public contracts, or an attributable response |
| Coverage | Each capability above: supported, absent, or unverified |
| Decision | Retain narrow scope, integrate, extend, or stop duplicate development |
| Remaining uncertainty | Private/pending products, inaccessible functions, or unsupported claims |

The current record has no verified complete-equivalent candidate and no closed G0 approval. Keep both statements together whenever reporting the ecosystem conclusion.
