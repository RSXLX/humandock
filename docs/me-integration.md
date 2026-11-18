# MetaEarth integration: evidence, adapter boundary, and live gates

Evidence checked: **2026-11-18 UTC**. This document distinguishes official source-code defaults from a verified running network. It is not a deployment attestation.

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
| `openmetaearth/ethermint` | Dependency selected by the Hub commit above | [`08a9eaaee040`](https://github.com/openmetaearth/ethermint/commit/08a9eaaee040), Go pseudo-version `v0.0.0-20261109073745-08a9eaaee040` |

The [official Developer Center](https://www.mec.me/en-US/developer-center) links the ME documentation and GitHub ecosystem. Its capability descriptions support investigating an integration; they do not replace testing the specific deployed chain, wallet, or identity service. The [official EVM announcement](https://www.mec.me/en-US/developer-blog/me-network-goes-evm-compatible-embracing-the-ethereum-ecosys) describes EVM compatibility, while the SDK's pinned [README](https://github.com/openmetaearth/meta-earth-js-sdk/blob/a56f3e936396de8689c2fc8667ad7306765eee9f/README.md) explicitly says the included EVM write workflow has not been validated through a live mainnet deployment.

## Network defaults found in the SDK

Source: [`src/config/define.ts` at the pinned SDK commit](https://github.com/openmetaearth/meta-earth-js-sdk/blob/a56f3e936396de8689c2fc8667ad7306765eee9f/src/config/define.ts), also available as a [raw file](https://raw.githubusercontent.com/openmetaearth/meta-earth-js-sdk/a56f3e936396de8689c2fc8667ad7306765eee9f/src/config/define.ts).

These are **published source defaults**, not an endorsement of endpoint availability, transport security, or their acceptance for HARBOR. A separate [read-only probe](../packages/me/observations/testnet-readonly-probe.json) of the listed test EVM endpoint returned HTTP 200 and block number `0x52178d` for `eth_blockNumber`; two `eth_chainId` calls timed out. The endpoint therefore responded partially, but chain ID `400` remains an SDK configuration value that has not been confirmed by this probe. No transaction was broadcast, and amount units and deployment behavior remain unverified.

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

The same file contains `CHAIN_ID = 'me-chain'` and address prefix `me`. The string is a Cosmos-side SDK constant, not the EVM numeric chain ID. Do not substitute it for `eth_chainId`, infer a mainnet EVM ID from the testnet value, or infer an address binding by replacing a prefix. The README requires explicit `evmRpcUrl` **and** `evmChainId` for mainnet EVM operations and directs developers to the MetaEarth team for test tokens; it does not supply a public self-service faucet URL.

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
| `getMeIdBySubAccount(address)` | `/metaearth/kyc/QuerySubAccountDidResponse?sub_account={address}` | Resolve a bound EVM sub-account to its main identity |

Returned fields include `did`, `address`, `pubkey`, `status`, `regionId`, `kycLevel`, and `subAccount`. `hasMeId` is true when a DID is present; it does not by itself assert an active identity, HARBOR advanced verification, or reviewer competence. The generated [DID types](https://github.com/openmetaearth/meta-earth-js-sdk/blob/a56f3e936396de8689c2fc8667ad7306765eee9f/src/me-client-ts/metaearth.did/types/metaearth/did/did.ts) define active status as enum value `1` and KYC levels `0` through `5`. The mapping from those enums to the product's required verification tier still needs authoritative confirmation and authorized account fixtures.

Required live behavior:

1. Verify a single-use wallet-control challenge with the exact domain, URI, network, nonce, and expiry. Do not request a user's private key or mnemonic.
2. Query the proper main/sub-account route, normalize known enum representations, and reject missing or ambiguous data. Treat a service error as unavailable, not as an absent identity and never as verified.
3. Resolve a private canonical principal from the authoritative main/sub-account binding. Within one task, the same principal must produce the same application alias regardless of wallet or role; freeze the alias-key version for that task.
4. Snapshot identity source, checked time/block, policy version, and observed status when an assignment is accepted. A reviewer identity is not a skill credential; language and review qualification are a separate record.
5. Issue short-lived, purpose-specific application attestations only after these checks. An application-issued attestation must never be presented as an ME-issued proof.

The public SDK's local key support and the ME Pass portal's QR authorization flow do not establish a general third-party browser signing API. Wallet connection, challenge signing, typed-data support, chain switching, rejected prompts, and session expiry all need an actual ME Pass integration test.

## Monetary units: a deployment gate, not an assumption

The pinned [Hub `go.mod`](https://github.com/openmetaearth/me-hub/blob/1e9eff8a5feae166fe9d72ad4bcc904622b078a1/go.mod) selects the Ethermint fork above. Its [`statedb.go`](https://github.com/openmetaearth/ethermint/blob/08a9eaaee040/x/evm/keeper/statedb.go) describes EVM amounts with 18 decimals and bank `umec` with 8 decimals, converting by `10^10`; [`keeper.go`](https://github.com/openmetaearth/ethermint/blob/08a9eaaee040/x/evm/keeper/keeper.go) converts the bank balance back to EVM wei.

Thus the **source-derived candidate** is `bankDecimals=8`, `evmDecimals=18`, and `quantumWei=10000000000`. This is not a measurement of the running ME deployment. Do not assume six decimals because the denomination starts with `u`, and do not assume arbitrary single wei transfers survive the bank conversion.

After deployment-specific confirmation, enforce:

```text
F = W + P
W mod q = 0; P mod q = 0
normal settlement: reviewer = W; platform = P
disputed settlement:
  reviewer = floor((W / q) * alphaBps / 10000) * q
  buyer = F - reviewer
  platform = 0
```

Use integers end to end, serialize large values as decimal strings, and test conservation plus representability. Gas is a separate cost. The local DEMO ledger and a generic local EVM cannot prove ME's bank/EVM rounding behavior.

## Gates before live ME writes

| Gate | Required evidence | Current state |
| --- | --- | --- |
| Ecosystem scope | Complete-equivalent review and explicit retain/integrate/stop decision; see [ecosystem-gap.md](./ecosystem-gap.md) | Open |
| Target network | Official target network; secured RPC access; expected EVM ID; genesis/network fingerprint; node version; current block and hash | Unverified |
| Identity policy | Confirmed advanced-tier mapping, authorized active/inactive/main/sub-account fixtures, failure cases, API access terms | Unverified |
| Wallet signing | Actual supported wallet protocol, account binding, challenge and typed-data signatures, transaction rejection/retry behavior | Unverified |
| Funds and quantum | Test tokens; deployed denom metadata; same-account bank/EVM balance comparison; deposit/split/withdraw receipts; measured `q` | Unverified |
| Contract deployment | Compiler and EVM target pinned; contract address and code hash; constructor roles; deployment transaction; source/ABI version | Local-only coverage |
| Indexing | Canonical block/hash verification, duplicate-log handling, restart cursor, dropped/replaced transaction handling, reconciliation | Live behavior unverified |
| Submission evidence | A core feature actually runs on the accepted ME network, with reproducible contracts/transactions/call records | Not achieved by a local demo |

A source update, read-only preflight, or imported faucet balance is insufficient to pass all gates. Keep a deployment record containing the observed facts and receipt hashes; redact credentials. No message has been sent to MetaEarth and no registration, listing, funding, or deployment action is implied by this document.
