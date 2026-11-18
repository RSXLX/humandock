# ME testnet verification record

Checked **2026-11-18 UTC**. This record covers public documentation, pinned official source code, and read-only network observations. It does not claim that HumanDock is deployed on ME, that a wallet has signed in, or that a HumanDock payment has settled. No test-token claim, identity application, transaction broadcast, or external message was performed during this investigation. No third-party DID records are stored in this repository.

## 1. What is now known

| Question | Evidence and conclusion | Remaining limit |
| --- | --- | --- |
| Does the published test EVM endpoint respond? | Yes. `eth_chainId` returned `0x190`, `net_version` returned `400`, and `eth_syncing` returned `false`. | The published URL uses HTTP. It is not an acceptable secure production endpoint. |
| Is there official HTTPS access to the Hub? | Yes. Official HTTPS Cosmos REST and Tendermint RPC endpoints responded successfully. | These are different protocols from EVM JSON-RPC. |
| Which test chain is running? | Tendermint reports `mechain_400-1`; EVM reports numeric chain ID `400`. A fixed-height block hash matched across both interfaces. | Node responses and source matching are not a cryptographic attestation of the deployed binary. |
| Which version does the node report? | REST node information reports `v2.0.18`, commit `e725a569564900d76681489540271227fce9649a`. | Recheck after upgrades or endpoint changes. |
| Are bank atoms six or eight decimals? | Live metadata uses base `umec`, display `MEC`, exponent `8`. | One official setup guide still contains a conflicting six-decimal example. |
| Does `1 umec = 10^10 wei` hold on the running testnet? | A nonzero system-module balance matched at one explicitly pinned block height, with response-height and address-mapping checks. | This establishes the observed balance representation, not all transfer, gas-refund, or contract edge cases. |
| Is a public faucet available? | The official website publishes a faucet and a separate simulated Testnet ME ID workflow. | Submission and delivery outcomes were not tested. |
| Is “advanced verification = numeric KYC level 2” established? | Official explorer labels associate level one with real-person authentication and level two with KYC authentication. The faucet has a separate advanced-auth string. | A direct, authoritative mapping to HARBOR's advanced-verification requirement and an authorized wallet fixture remain outstanding. |
| Did this verify HumanDock's live payment flow? | No. | Deployment, funding, assignment, delivery, split, withdrawal, and reconciliation receipts are still required. |

## 2. Official network configuration and observed responses

### Testnet endpoints

| Protocol | Published endpoint | Source | Observed result |
| --- | --- | --- | --- |
| EVM JSON-RPC | `http://118.175.0.249:8545` | [JS SDK configuration](https://github.com/openmetaearth/meta-earth-js-sdk/blob/a56f3e936396de8689c2fc8667ad7306765eee9f/src/config/define.ts) | HTTP 200 for read-only EVM methods; numeric chain ID `400` |
| Cosmos REST | `https://beta-hub-1317.explorer-testnet.me` | [Official developer guide](https://github.com/openmetaearth/me-docs/blob/8d61beb6c8b1624510017333d3f1f59d5979ca60/docs/development-guides/for-developers.md) | Successful node-info, metadata, account-mapping, and bank queries |
| Tendermint RPC | `https://beta-hub-26657.explorer-testnet.me` | Same official guide | Successful `/status` and `/block?height=5380384` |
| Explorer | `https://www.explorer-testnet.me/` | Same official guide | Public page and published client assets accessible |
| Faucet | `https://www.mec.me/en-US/faucet` | [Official node setup guide](https://github.com/openmetaearth/me-docs/blob/8d61beb6c8b1624510017333d3f1f59d5979ca60/docs/development-guides/developer-guide/node-deployment/testnet-node-setup-guide.md) and live website | Public page accessible; no submission attempted |

The [Python SDK configuration](https://github.com/openmetaearth/meta-earth-python-sdk/blob/b864e6f13215cb9bdf4c759707fe6a1bfc9c3bb9/src/meta_earth_sdk/config.py) independently publishes the same HTTP EVM test endpoint. A bounded search of the official developer documentation, both SDKs, official explorer/faucet client assets, and official search results found no published HTTPS EVM endpoint. This is an unresolved discovery result, not proof that no HTTPS endpoint exists. No guessed hostnames or endpoint grids were probed.

The HTTPS Hub RPC must not be configured as an EVM RPC: `/status` is a Tendermint method, while `eth_chainId` is an EVM method. A relay that terminates HTTPS and forwards to the public HTTP EVM URL still leaves its upstream hop unprotected. Obtain an official HTTPS EVM endpoint or a controlled secure node connection before removing the transport gate. Do not change the deployment's HTTPS validation merely to make a preflight pass.

### EVM and node observations

The [extended EVM probe](../packages/me/observations/testnet-readonly-probe-extended.json) records:

- `eth_chainId`: `0x190` (`400`).
- `net_version`: `400`.
- `eth_syncing`: `false`.
- `eth_blockNumber`: `0x52191d` (`5380381`) at the recorded observation.
- `web3_clientVersion`: a development-labelled Go build string, including Go `1.24.11`.

These calls took approximately 6.5 seconds in this environment. The earlier [five-second probe](../packages/me/observations/testnet-readonly-probe.json) timed out on chain-ID reads; that result has been superseded by a successful longer read, not erased.

The [HTTPS service probe](../packages/me/observations/official-https-services-probe.json) records Tendermint network `mechain_400-1`, version `0.37.5`, and `catching_up = false`. REST `/cosmos/base/tendermint/v1beta1/node_info` reports application version `v2.0.18`, Git commit `e725a569564900d76681489540271227fce9649a`, and Cosmos SDK `v0.47.13`.

That commit is the checked-out commit of the official [Hub `v2.0.18` release](https://github.com/openmetaearth/me-hub/releases/tag/v2.0.18). Its [go.mod](https://github.com/openmetaearth/me-hub/blob/e725a569564900d76681489540271227fce9649a/go.mod) replaces upstream Ethermint with `openmetaearth/ethermint` at full commit `08a9eaaee0408f181c8213e7e90846fd068c6327`. The official [upgrade announcement](https://www.mec.me/en-US/developer-blog/meta-earth-beta-testnet-v2-0-18-upgrade) describes the November 13 testnet upgrade and RPC/REST changes. These are mutually consistent source and node observations; a malicious or misconfigured node could still misreport build information.

Mainnet EVM URL and numeric chain ID are not supplied in the reviewed SDK defaults. No mainnet EVM probe or mainnet amount inference was made.

## 3. Fixed-height balance and unit verification

### A shared block identity

The [fixed-height probe](../packages/me/observations/fixed-height-probe.json) requested height `5380384` (`0x521920`).

| Interface | Result |
| --- | --- |
| EVM `eth_getBlockByNumber` | `0x36ec2f1965492c7855244beb31ffb984795510fe2c7a9576c66df703d1fb7550` |
| Tendermint `/block?height=5380384` | Same bytes, returned as uppercase hexadecimal |
| REST `/cosmos/base/tendermint/v1beta1/blocks/5380384` | Same block ID, returned as base64 |

The EVM state-root field and Tendermint app-hash field also matched in these responses. This is a cross-interface consistency check; no light-client proof or independent validator verification was performed.

### Correct historical REST headers

Send `x-cosmos-block-height: 5380384`. The observed server returns the height as **`grpc-metadata-x-cosmos-block-height: 5380384`**. Do not silently compare an EVM historical balance with a latest REST balance just because both requests succeed.

The [header probe](../packages/me/observations/height-headers-probe.json) confirms the response header on account queries. A request for future height `999999999` returned an invalid-height error rather than latest state. Both `x-cosmos-block-height` and the gRPC-prefixed request form were rejected for that future height. The original fixed-height probe retained only a small header allowlist and therefore omitted the response's gRPC-prefixed height header; use the subsequent complete-header observations for height attestation.

The [fixed-height metadata probe](../packages/me/observations/metadata-fixed-height-probe.json) preserves the complete response headers and the denomination record.

### Public system-account sample

The sample is the chain's **fee_collector system module**, discovered through `/cosmos/auth/v1beta1/module_accounts`. It is not the user's wallet, a newly created account, or an identity fixture.

| Field | Observed value |
| --- | --- |
| Height | `5380384` |
| Bank account | `me17xpfvakm2amg962yls6f84z3kell8c5lr2wff2` |
| EVM account representation | `0xf1829676db577682e944fc3493d451b67ff3e29f` |
| Bank balance | `237583380 umec` |
| EVM balance | `2375833800000000000 wei` |
| Exact quotient | `10000000000 wei / umec` |

The [nonzero-balance evidence](../packages/me/observations/nonzero-balance-quantum-probe.json) includes the raw public responses and these checks:

1. The official EVM `CosmosAccount` endpoint returned the exact bank module address for the EVM representation.
2. Bank balance and mapping queries returned the requested historical height.
3. `eth_getBalance` used explicit block tag `0x521920`.
4. The bank value was positive, and `evmWei === bankAtoms * 10000000000`.

A second system module returned zero. Zero-to-zero agreement is recorded but is **not** used as evidence for a conversion ratio.

The machine-readable [unit verification summary](../packages/me/observations/testnet-units-verified.json) follows `humandock.units.v1`, records `status: matched`, and retains `liveWritesEnabled: false`. It was assembled from the saved observations, with all three historical REST headers checked and the EVM block read again afterwards. It includes source-file hashes. It was not generated by bypassing the application's HTTPS policy or by running a live money operation.

### Amount consequences

Live `/cosmos/bank/v1beta1/denoms_metadata/umec` declares base `umec`, display `MEC`, and exponent `8`. The pinned [`decimal_conversion.go`](https://github.com/openmetaearth/ethermint/blob/08a9eaaee0408f181c8213e7e90846fd068c6327/x/evm/keeper/decimal_conversion.go) defines EVM decimals `18` and conversion factor `10^10`. [`keeper.go`](https://github.com/openmetaearth/ethermint/blob/08a9eaaee0408f181c8213e7e90846fd068c6327/x/evm/keeper/keeper.go) expands a bank balance to wei; [`statedb.go`](https://github.com/openmetaearth/ethermint/blob/08a9eaaee0408f181c8213e7e90846fd068c6327/x/evm/keeper/statedb.go) truncates a wei balance when writing bank state.

The official node setup guide's `10^6` example conflicts with the live metadata, the [account-model document](https://github.com/openmetaearth/me-docs/blob/8d61beb6c8b1624510017333d3f1f59d5979ca60/docs/advanced-developer-topics/account-model.md), and the release's conversion code. Use the observed testnet value `q = 10^10`; do not extrapolate to a different deployment without checking it.

HumanDock must keep deposit amounts, service splits, credits, and withdrawals divisible by `q`. The amount check must cover every derived split, including dispute ratios. Balance equality alone does not establish how a sub-quantum transfer, failed call, or withdrawal behaves; actual contract receipts remain a separate acceptance test.

## 4. Gas debit and refund accounting

The pinned fork has two separate rounding operations:

- [`keeper/utils.go`](https://github.com/openmetaearth/ethermint/blob/08a9eaaee0408f181c8213e7e90846fd068c6327/x/evm/keeper/utils.go) takes the transaction's effective prepaid fee and rounds it **up** to bank atoms.
- [`keeper/gas.go`](https://github.com/openmetaearth/ethermint/blob/08a9eaaee0408f181c8213e7e90846fd068c6327/x/evm/keeper/gas.go) refunds unused gas at the message gas price and rounds the refund **down** to bank atoms.

For the normal single-message EVM path, the source-derived bank charge is:

```text
q = 10000000000
L = transaction gas limit
U = actual EVM gas used
p = effective gas price in wei

prepaidAtoms = ceil(L * p / q)
refundAtoms  = floor((L - U) * p / q)
netGasWei    = (prepaidAtoms - refundAtoms) * q
```

For type-2 transactions, [`dynamic_fee_tx.go`](https://github.com/openmetaearth/ethermint/blob/08a9eaaee0408f181c8213e7e90846fd068c6327/x/evm/types/dynamic_fee_tx.go) and [`types/utils.go`](https://github.com/openmetaearth/ethermint/blob/08a9eaaee0408f181c8213e7e90846fd068c6327/x/evm/types/utils.go) use `min(baseFee + tipCap, feeCap)`. [`MsgEthereumTx.AsMessage`](https://github.com/openmetaearth/ethermint/blob/08a9eaaee0408f181c8213e7e90846fd068c6327/x/evm/types/msg.go) uses the same effective-price rule. Legacy transactions use their transaction gas price. The [receipt builder](https://github.com/openmetaearth/ethermint/blob/08a9eaaee0408f181c8213e7e90846fd068c6327/rpc/backend/tx_info.go) explicitly adds `effectiveGasPrice` for dynamic-fee transactions; legacy receipts may omit it.

A [read-only public fee observation](../packages/me/observations/public-fee-rounding-observation.json) provides a concrete example at height `5379372`: a successful legacy transaction used its entire gas limit of `21000` at `8 wei` per gas. The multiplication is `168000 wei`, while the same transaction's Tendermint fee event is `1 umec`, or `10000000000 wei`. That agrees with prepaid-fee rounding. The receipt omitted `effectiveGasPrice`. This existing public transaction is not a HumanDock transaction; the retained projection excludes sender/recipient addresses, signature fields, input data, and identity information. It does not test a nonzero refund or attribute a wallet's complete balance change.

This is not a blanket formula for every failed or historical transaction. [`state_transition.go`](https://github.com/openmetaearth/ethermint/blob/08a9eaaee0408f181c8213e7e90846fd068c6327/x/evm/keeper/state_transition.go) has an early error path that can consume the full gas meter without the ordinary refund path, and the receipt builder contains a historical reverted-transaction gas adjustment. Reconciliation must reject an unclassified transaction instead of forcing it through a convenient fee equation. Confirm actual bank movements for successful, reverted, rejected, and replacement cases using controlled test wallets before enabling live funds.

## 5. Identity and address semantics

### Three distinct concepts

An EVM address, its Cosmos bank representation, and its registered DID main-account binding are different facts. The following source-backed sequence avoids conflating them:

1. Verify control of the EVM wallet with a single-use, domain-bound challenge. The challenge does not prove an ME identity.
2. Read `/ethermint/evm/v1/cosmos_account/{0xAddress}`. The official [query schema](https://github.com/openmetaearth/ethermint/blob/08a9eaaee0408f181c8213e7e90846fd068c6327/proto/ethermint/evm/v1/query.proto) and [handler](https://github.com/openmetaearth/ethermint/blob/08a9eaaee0408f181c8213e7e90846fd068c6327/x/evm/keeper/grpc_query.go) return the Cosmos representation of the same account bytes. This can succeed even without a DID.
3. Use that returned Bech32 `me…` address in `/metaearth/kyc/QuerySubAccountDidResponse?sub_account=…`. The Hub [handler](https://github.com/openmetaearth/me-hub/blob/e725a569564900d76681489540271227fce9649a/x/kyc/keeper/grpc_query.go) reads a registered string-key mapping; it does not convert an arbitrary raw `0x…` value.
4. Require `info.sub_account` to match the queried bank address. Resolve `info.address` through `/metaearth/did/did?address=…`, and confirm the same DID and binding at the same height. Reject mismatches or ambiguous results.
5. Enforce active status and an explicitly approved tier policy, then issue HumanDock's own short-lived application attestation. Keep that attestation distinct from an ME-issued credential.

The [binding transaction handler](https://github.com/openmetaearth/me-hub/blob/e725a569564900d76681489540271227fce9649a/x/kyc/keeper/msg_server_sub_account.go) requires an active main DID with KYC, a Cosmos secp256k1 main public key, and an Ethereum secp256k1 sub public key with the same underlying key bytes. The public-key-to-address derivations must match each submitted Bech32 address. A same-prefix address or a wallet with the same visible name cannot establish that relationship. HumanDock must never request a user's mnemonic or private key to perform this verification.

The [DID enum](https://github.com/openmetaearth/me-hub/blob/e725a569564900d76681489540271227fce9649a/proto/metaearth/did/did.proto) defines inactive `0`, active `1`, and KYC levels `0` through `5`. Known missing-DID errors in the official SDK are specific messages; the server uses an internal-error status for some missing bindings. Do not classify every HTTP 500 as “unverified user”: transport/server failure remains unavailable, while only the documented missing-binding result may be treated as absent.

### What the tier labels establish

The official test explorer's published [JavaScript asset](https://www.explorer-testnet.me/static/js/index.BRM7Isc6.js) maps `KYC_LEVEL_ONE` and `KYC_LEVEL_TWO` to labels for real-person authentication and KYC authentication, respectively. The faucet's published [page asset](https://www.mec.me/_next/static/chunks/pages/%5Blanguage%5D/faucet-3f3787260fe3aa45.js) uses `UNVERIFIED_AUTH`, `NORMAL_AUTH`, and `ADVANCED_AUTH`. The Hub's [KYC reward logic](https://github.com/openmetaearth/me-hub/blob/e725a569564900d76681489540271227fce9649a/x/kyc/keeper/msg_server.go) changes invitation rewards at level two or above.

The [public-source audit](../packages/me/observations/official-faucet-identity-source-audit.json) records asset URLs, content hashes, and the bounded observations. It contains no DID lookup result.

These facts make level two a reasonable candidate to investigate. They do not explicitly define the business meaning of every level, prove a universal `>= 2` advanced-verification policy, or establish HARBOR eligibility. Keep `ME_MIN_KYC_LEVEL` and the policy reference explicit; require an authorized wallet fixture or a direct authoritative policy mapping before claiming an advanced-verification gate is satisfied. No third-party DID query is needed to validate the eventual user-controlled login flow.

## 6. Test-token and simulated identity onboarding

Use the [official faucet page](https://www.mec.me/en-US/faucet) as the entry point. The public page advertises two test MEC per address per day, resetting at midnight UTC. Its token form offers Hub/DA selection, a testnet `me…` address, email and verification-code fields, and an anti-bot step. The client-side address validator expects the `me…` format rather than a raw EVM hex address. Actual backend acceptance, verification-code delivery, and token arrival remain untested.

For an EVM test account, obtain its bank representation through the verified `CosmosAccount` mapping and verify the credited balance on both interfaces after a user completes the claim. Do not infer funding success from the website's submitted state. Do not mix Hub test funds with a DA selection.

The separate Testnet ME ID workflow simulates identity tiers for development. Public page content says that an unverified address can choose real-person or advanced simulation, that real-person status can be upgraded, and that an already advanced address cannot apply again. The public client has a sub-address rejection case, `FAUCET30012`; the tier application therefore belongs to the main account, followed by the supported sub-account binding flow. It includes a human anti-bot step. These simulations are not verification of a legal identity and do not substitute for a participant's real ME Pass certification.

The website still contains a maintenance-message string referring to the November 13 upgrade. Its presence in the content dictionary alone does not prove that maintenance is currently active. No submission was made to settle that question. Use the actual visible state and user-completed result when onboarding a controlled test fixture.

## 7. Remaining gates for HumanDock

| Gate | Concrete next evidence |
| --- | --- |
| Secure EVM transport | Official HTTPS JSON-RPC or a controlled secure node connection; verified numeric chain ID, chain fingerprint, and current block |
| Controlled wallet fixture | User-authorized wallet challenge and transaction signatures, rejection/retry tests, public account binding checked by the application |
| Tier policy | Explicit scope and numeric rule; no claim that simulated test identity establishes HARBOR eligibility |
| Test funding | User-completed official faucet claim and observed Hub balance; no private key or email code in source control |
| Contract deployment | Address, code hash, ABI version, constructor roles, and successful receipt on the expected chain |
| Full payment lifecycle | Fund, accept, deliver, settle, withdraw, and reconcile; independent role wallets and observed bank/EVM outcomes |
| Exceptional paths | Missed deadlines, disputes, refund rounding, reverts, dropped/replaced transactions, and restart-safe event reconciliation |

A successful public read does not remove these gates. Evidence files contain public chain metadata, public system-module balances, and source references. They do not contain wallet credentials, identity documents, email verification codes, or third-party DID records.
