# MetaEarth integration: evidence, adapter boundary, and live gates

Evidence checked: **2026-11-18 UTC**. This document distinguishes official source-code defaults, read-only observations of a running network, and application deployment evidence. It is not a deployment attestation. Reproducible endpoint, identity, amount, and fee details are in [network-verification.md](./network-verification.md).

## Current implementation boundary

The first implementation provides a local application demo, an isolated **DEMO** ledger whose amounts are integer wei-style units, and Solidity contracts with a local EVM test suite. DEMO balances are not MEC, have no external withdrawal value, and do not establish activity on ME Network. The application defaults to persistent embedded PostgreSQL through PGlite at `.data/pglite`; `DATABASE_URL` selects a PostgreSQL server instead.

`APP_MODE=me` must fail closed for money-changing application operations until live integration is implemented and the gates below pass. Neither setting this variable nor running local contract tests enables a live wallet, funds an ME account, or deploys a contract. No live ME deployment, authorized ME identity fixture, ME Pass signing session, or test-token transfer has been verified for this delivery.

Repository commands:

| Command | What it can establish |
| --- | --- |
| `npm run dev` | Run the local Next.js and Fastify application |
| `npm test` | Run application/domain tests; inspect the actual result rather than assuming success |
| `npm run contracts:compile` | Compile the Solidity artifacts |
| `npm run test:contracts` | Exercise contracts on a local EVM using solc, Ganache, and viem |
| `npm run me:preflight` | Inspect the explicitly configured ME environment; a successful read-only check alone does not enable live funds |

## Official sources pinned for review

The SDK and Hub branch tips were checked through both `git ls-remote` and the public GitHub repository pages. Pin these commits for reproducibility; review newer upstream commits separately before updating dependencies.

| Repository | Observed branch | Commit |
| --- | --- | --- |
| `openmetaearth/meta-earth-js-sdk` | `master` | [`a56f3e936396de8689c2fc8667ad7306765eee9f`](https://github.com/openmetaearth/meta-earth-js-sdk/commit/a56f3e936396de8689c2fc8667ad7306765eee9f) |
| `openmetaearth/me-hub` | `main` | [`1e9eff8a5feae166fe9d72ad4bcc904622b078a1`](https://github.com/openmetaearth/me-hub/commit/1e9eff8a5feae166fe9d72ad4bcc904622b078a1) |
| `openmetaearth/me-hub` | Release `v2.0.18`; matches the test node's self-reported build commit | [`e725a569564900d76681489540271227fce9649a`](https://github.com/openmetaearth/me-hub/commit/e725a569564900d76681489540271227fce9649a) |
| `openmetaearth/ethermint` | Dependency selected by both Hub commits above | [`08a9eaaee0408f181c8213e7e90846fd068c6327`](https://github.com/openmetaearth/ethermint/commit/08a9eaaee0408f181c8213e7e90846fd068c6327), Go pseudo-version `v0.0.0-20261109073745-08a9eaaee040` |
| `openmetaearth/me-docs` | `main` | [`8d61beb6c8b1624510017333d3f1f59d5979ca60`](https://github.com/openmetaearth/me-docs/commit/8d61beb6c8b1624510017333d3f1f59d5979ca60) |
| `openmetaearth/meta-earth-python-sdk` | `main` | [`b864e6f13215cb9bdf4c759707fe6a1bfc9c3bb9`](https://github.com/openmetaearth/meta-earth-python-sdk/commit/b864e6f13215cb9bdf4c759707fe6a1bfc9c3bb9) |

The [official Developer Center](https://www.mec.me/en-US/developer-center) links the ME documentation and GitHub ecosystem. Its capability descriptions support investigating an integration; they do not replace testing the specific deployed chain, wallet, or identity service. The [official EVM announcement](https://www.mec.me/en-US/developer-blog/me-network-goes-evm-compatible-embracing-the-ethereum-ecosys) describes EVM compatibility, while the SDK's pinned [README](https://github.com/openmetaearth/meta-earth-js-sdk/blob/a56f3e936396de8689c2fc8667ad7306765eee9f/README.md) explicitly says the included EVM write workflow has not been validated through a live mainnet deployment.

## Network defaults found in the SDK

Source: [`src/config/define.ts` at the pinned SDK commit](https://github.com/openmetaearth/meta-earth-js-sdk/blob/a56f3e936396de8689c2fc8667ad7306765eee9f/src/config/define.ts), also available as a [raw file](https://raw.githubusercontent.com/openmetaearth/meta-earth-js-sdk/a56f3e936396de8689c2fc8667ad7306765eee9f/src/config/define.ts).

The table below records **published source defaults**. A later [read-only probe with a longer timeout](../packages/me/observations/testnet-readonly-probe-extended.json) confirmed `eth_chainId = 0x190` and `net_version = 400` on the listed test EVM endpoint. The earlier five-second timeouts in [the original probe](../packages/me/observations/testnet-readonly-probe.json) did not establish that the node was unavailable. The observed calls needed roughly 6.5 seconds. No transaction was broadcast. Availability at a recorded time does not establish transport security or HARBOR acceptance.

| Setting | SDK `testnet` | SDK `mainnet` |
| --- | --- | --- |
| EVM JSON-RPC | `http://118.175.0.249:8545` | **Not supplied** |
| Expected EVM chain ID | `400` | **Not supplied** |
| Hub REST | `http://118.175.0.249:1317` | `http://118.175.0.247:11317` |
| Hub Tendermint RPC | `http://118.175.0.249:26657` | `http://118.175.0.247:16657` |
| Hub gRPC | `http://118.175.0.249:9090` | `http://118.175.0.247:19090` |
| Rollup REST | `http://118.175.0.249:3317` | `http://118.175.0.247:23013` |
| Rollup Tendermint RPC | `http://118.175.0.249:46657` | `http://118.175.0.247:23011` |
| Rollup gRPC | `http://118.175.0.249:9290` | `http://118.175.0.247:23012` |

The same file contains `CHAIN_ID = 'me-chain'` and address prefix `me`. The string is a Cosmos-side SDK constant, not the EVM numeric chain ID. The running test Hub reports Cosmos network `mechain_400-1`. Do not substitute either string for `eth_chainId`, infer a mainnet EVM ID from the testnet value, or infer an identity binding by replacing an address prefix. Mainnet EVM configuration remains unspecified in the reviewed SDK defaults and was not probed.

The official [developer guide](https://github.com/openmetaearth/me-docs/blob/8d61beb6c8b1624510017333d3f1f59d5979ca60/docs/development-guides/for-developers.md) also publishes usable HTTPS test-Hub services:

| Service | Official URL | Read-only observation |
| --- | --- | --- |
| Cosmos REST | `https://beta-hub-1317.explorer-testnet.me` | Node information, denomination metadata, account mapping, and fixed-height bank queries returned successfully |
| Tendermint RPC | `https://beta-hub-26657.explorer-testnet.me` | `/status` and fixed-height `/block` returned successfully |
| Public faucet | `https://www.mec.me/en-US/faucet` | Public page and client assets inspected; no claim, email code, or identity application sent |

These HTTPS endpoints are **not EVM JSON-RPC substitutes**. A bounded review of the official documentation, both SDKs, and public explorer/faucet assets did not locate a published HTTPS EVM URL. The currently observed EVM URL uses HTTP and therefore does not satisfy HumanDock's non-local HTTPS configuration rule. Secure EVM access remains an explicit deployment gate; an HTTPS proxy in front of an HTTP upstream does not make that upstream transport secure.

The SDK README's instruction to contact the team for tokens is incomplete relative to the live official faucet. Its page advertises two test MEC per address per UTC day and uses a testnet `me…` address, email verification, and an anti-bot step. A separate Testnet ME ID workflow offers simulated verification tiers and rejects sub-addresses for direct tier applications. This does not verify a real person's legal identity, and it does not satisfy a competition participant's real advanced-verification requirement. Claim and application outcomes have not been tested.

The pinned [`src/api/evm-contract.ts`](https://github.com/openmetaearth/meta-earth-js-sdk/blob/a56f3e936396de8689c2fc8667ad7306765eee9f/src/api/evm-contract.ts) checks the configured chain ID in `getProvider()` and supports deployment, execution, and queries using an Ethers signer. HumanDock must additionally check the actual user's signer network before every write; an SDK read-provider check is not proof that an externally supplied signer uses the same network. The SDK's example bytecode targets Paris, which is a compatibility clue, not proof that every new EVM opcode is supported by the target deployment.

## HumanDock preflight configuration

The adapter intentionally does not silently copy the SDK's HTTP defaults. `npm run me:preflight` reads explicit environment variables through `packages/me/src/config.ts` and runs the read-only probe in `scripts/me-preflight.ts`.

| Variable | Meaning and validation |
| --- | --- |
| `ME_NETWORK` | `local`, `me-testnet`, or `me-mainnet` |
| `ME_EVM_RPC_URL` | Explicit endpoint; HTTPS required outside local loopback |
| `ME_EVM_CHAIN_ID` | Explicit positive numeric expected EVM ID |
| `ME_NATIVE_SYMBOL` | Configured native currency symbol, not an observed proof |
| `ME_BANK_DENOM` | Configured bank denomination, not an observed proof |
| `ME_BANK_DECIMALS` | Explicit integer from 0 through 18 |
| `ME_QUANTUM_WEI` | Explicit integer; must equal `10^(18 - ME_BANK_DECIMALS)` |
| `ME_COSMOS_REST_URL` | Optional identity-query endpoint; the same transport restrictions apply |
| `ME_MIN_KYC_LEVEL` | Admission-policy value from 1 through 5, only after its business mapping is established |
| `ME_ID_POLICY_REFERENCE` | Reference identifying the confirmed identity policy; required for a verified admission decision |

The EVM-side decimals are fixed at 18 in this adapter. Config validation establishes internal consistency, not that a network actually uses the supplied denomination or quantum. The probe reports the observed chain ID, latest block/hash, and client version; monetary metadata remains marked as configured-only, and `liveWritesEnabled` remains false. It does not read a private key, issue an identity attestation, broadcast a transaction, or deploy a contract. Do not put credentials into query parameters or committed examples.

## Identity adapter

The pinned [`src/api/identity.ts`](https://github.com/openmetaearth/meta-earth-js-sdk/blob/a56f3e936396de8689c2fc8667ad7306765eee9f/src/api/identity.ts) exposes these queries:

| SDK operation | Hub-relative REST path | Use in HumanDock |
| --- | --- | --- |
| `getMeIdByAddress(address)` | `/metaearth/did/did?address={address}` | Resolve the main address's identity record |
| `getMeIdByDid(did)` | `/metaearth/did/didInfo?did={did}` | Resolve a known DID and its account fields |
| EVM `CosmosAccount` query | `/ethermint/evm/v1/cosmos_account/{0xAddress}` | Resolve the bank representation of the same 20-byte EVM account; this alone does not prove DID binding |
| `getMeIdBySubAccount(address)` | `/metaearth/kyc/QuerySubAccountDidResponse?sub_account={meAddress}` | Resolve a registered **Bech32** EVM sub-account to its main identity |

Returned fields include `did`, `address`, `pubkey`, `status`, `regionId`, `kycLevel`, and `subAccount`/`sub_account`. `hasMeId` is true when a DID is present; it does not by itself assert an active identity, HARBOR advanced verification, or reviewer competence. The generated [DID types](https://github.com/openmetaearth/meta-earth-js-sdk/blob/a56f3e936396de8689c2fc8667ad7306765eee9f/src/me-client-ts/metaearth.did/types/metaearth/did/did.ts) define active status as enum value `1` and KYC levels `0` through `5`.

The release's [binding handler](https://github.com/openmetaearth/me-hub/blob/e725a569564900d76681489540271227fce9649a/x/kyc/keeper/msg_server_sub_account.go) validates Bech32 main/sub addresses, their respective Cosmos/Ethereum public-key derivations, and equality of the underlying public-key bytes. Its [sub-account query](https://github.com/openmetaearth/me-hub/blob/e725a569564900d76681489540271227fce9649a/x/kyc/keeper/grpc_query.go) reads the registered sub-address string directly. Passing a raw `0x…` string to that DID query is not a valid substitute for the mapping step. Require the returned `sub_account` to equal the mapped bank address and re-query the returned main address to verify the same DID and binding.

Public explorer labels associate level one with real-person authentication and level two with KYC authentication; the faucet separately uses `NORMAL_AUTH` and `ADVANCED_AUTH`. This supports investigating a level-two policy, but no reviewed official source explicitly equates the numeric enum with HARBOR's advanced-verification requirement. Keep that distinction and obtain an authorized fixture/policy reference before asserting compliance with that requirement.

Required live behavior:

1. Verify a single-use wallet-control challenge with the exact domain, URI, network, nonce, and expiry. Do not request a user's private key or mnemonic.
2. Query the proper main/sub-account route, normalize known enum representations, and reject missing or ambiguous data. Treat a service error as unavailable, not as an absent identity and never as verified.
3. Resolve a private canonical principal from the authoritative main/sub-account binding. Within one task, the same principal must produce the same application alias regardless of wallet or role; freeze the alias-key version for that task.
4. Snapshot identity source, checked time/block, policy version, and observed status when an assignment is accepted. A reviewer identity is not a skill credential; language and review qualification are a separate record.
5. Issue short-lived, purpose-specific application attestations only after these checks. An application-issued attestation must never be presented as an ME-issued proof.

The public SDK's local key support and the ME Pass portal's QR authorization flow do not establish a general third-party browser signing API. Wallet connection, challenge signing, typed-data support, chain switching, rejected prompts, and session expiry all need an actual ME Pass integration test.

## Monetary units: source and read-only testnet confirmation

The running node reports build commit `e725a569…`; that release's [Hub `go.mod`](https://github.com/openmetaearth/me-hub/blob/e725a569564900d76681489540271227fce9649a/go.mod) selects the Ethermint fork above. Its [`decimal_conversion.go`](https://github.com/openmetaearth/ethermint/blob/08a9eaaee0408f181c8213e7e90846fd068c6327/x/evm/keeper/decimal_conversion.go) defines EVM amounts with 18 decimals and bank `umec` with 8 decimals, converting by `10^10`. The node's self-reported version is supporting evidence, not a binary attestation.

These units are now also supported by [live denomination metadata](../packages/me/observations/official-https-services-probe.json) and a [nonzero fixed-height balance comparison](../packages/me/observations/nonzero-balance-quantum-probe.json). At testnet height `5380384`, the public `fee_collector` system account held `237583380 umec` and its EVM representation returned `2375833800000000000 wei`, a ratio of exactly `10000000000`. The bank response's `grpc-metadata-x-cosmos-block-height` matched the requested height, and the same-height EVM and Tendermint block hashes matched. This is a system-module account, not a user's wallet.

For this observed testnet, `bankDecimals=8`, `evmDecimals=18`, and `quantumWei=10000000000` have read-only evidence. A stale node-setup document's six-decimal example conflicts with both live metadata and the pinned conversion code. Mainnet units and actual HumanDock deposit/split/withdraw behavior remain unverified. Do not assume arbitrary single wei transfers survive conversion.

For a deployment whose metadata, network fingerprint, and unit checks match, enforce:

```text
F = W + P
W mod q = 0; P mod q = 0
normal settlement: reviewer = W; platform = P
disputed settlement:
  reviewer = floor((W / q) * alphaBps / 10000) * q
  buyer = F - reviewer
  platform = 0
```

Use integers end to end, serialize large values as decimal strings, and test conservation plus representability. Gas is a separate cost: the pinned fork rounds the prepaid fee **up** to bank atoms and refunds unused gas **down** to bank atoms. Consequently `gasUsed * effectiveGasPrice` alone may understate the bank debit. The exact source paths and limits of fee evidence are documented in [network-verification.md](./network-verification.md). The local DEMO ledger and a generic local EVM cannot prove ME's transfer or refund behavior.

## Gates before live ME writes

| Gate | Required evidence | Current state |
| --- | --- | --- |
| Ecosystem scope | Complete-equivalent review and explicit retain/integrate/stop decision; see [ecosystem-gap.md](./ecosystem-gap.md) | Open |
| Target network | Official target network; secured RPC access; expected EVM ID; genesis/network fingerprint; node version; current block and hash | Test EVM ID, Cosmos chain, version, and cross-interface block identity observed; secure EVM URL unresolved |
| Identity policy | Confirmed advanced-tier mapping, authorized active/inactive/main/sub-account fixtures, failure cases, API access terms | Unverified |
| Wallet signing | Actual supported wallet protocol, account binding, challenge and typed-data signatures, transaction rejection/retry behavior | Unverified |
| Funds and quantum | Test tokens; deployed denom metadata; same-account bank/EVM balance comparison; deposit/split/withdraw receipts; measured `q` | Testnet metadata and nonzero `q=10^10` comparison verified read-only; no owned test funds or HumanDock transaction receipts |
| Contract deployment | Compiler and EVM target pinned; contract address and code hash; constructor roles; deployment transaction; source/ABI version | Local-only coverage |
| Indexing | Canonical block/hash verification, duplicate-log handling, restart cursor, dropped/replaced transaction handling, reconciliation | Live behavior unverified |
| Submission evidence | A core feature actually runs on the accepted ME network, with reproducible contracts/transactions/call records | Not achieved by a local demo |

A source update, read-only preflight, or imported faucet balance is insufficient to pass all gates. Keep a deployment record containing the observed facts and receipt hashes; redact credentials. No message has been sent to MetaEarth and no registration, listing, funding, or deployment action is implied by this document.
