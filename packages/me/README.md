# ME integration boundary

This package contains independent ME identity and bank readers, exact EIP-712 signing helpers, contract deployment and receipt verification, replayable event reads, and withdrawal reconciliation. It does not import the upstream SDK or derive a DID from a wallet. Callers provide their own signer and explicit network configuration; the application never receives a user's spending key. The local fixture uses public test accounts and real local EVM transactions, and makes no claim to ME identity or ME funds.

## Explicit configuration

Run `npm run me:preflight` after setting the following deliberately unpopulated network values:

| Variable | Meaning |
| --- | --- |
| `ME_NETWORK` | `local`, `me-testnet`, or `me-mainnet` |
| `ME_EVM_RPC_URL` | Verified endpoint; HTTPS unless local loopback |
| `ME_EVM_CHAIN_ID` | Expected positive decimal EVM chain ID |
| `ME_NATIVE_SYMBOL` | Confirmed native currency symbol |
| `ME_BANK_DENOM` | Confirmed Cosmos bank denomination |
| `ME_BANK_DECIMALS` | Confirmed bank decimal precision, 0–18 |
| `ME_QUANTUM_WEI` | Decimal integer, `10^(18 - bankDecimals)` for this adapter |
| `ME_COSMOS_REST_URL` | Optional for RPC probe; required for identity reads |
| `ME_MIN_KYC_LEVEL` | Required for admission, 1–5 after official mapping confirmation |
| `ME_ID_POLICY_REFERENCE` | Recorded basis for the configured identity level |

No default chain ID, endpoint, denomination or quantum silently enables a network. RPC preflight queries `eth_chainId`, `web3_clientVersion` and `eth_getBlockByNumber`, verifies the configured chain ID, and reports a block/hash. It always returns `liveWritesEnabled: false`, `unitsVerifiedOnLiveChain: false`, and `identityVerified: false`; RPC reachability does not satisfy these independent gates.

The HTTPS policy does not alter the upstream HTTP address to an invented HTTPS URL. A separately authorized read-only research probe of the official HTTP test endpoint subsequently confirmed chain ID **400**, using a longer timeout. The older five-second timeouts in `observations/testnet-readonly-probe.json` were not proof of node failure. The current observations are in [the extended RPC probe](observations/testnet-readonly-probe-extended.json).

At block **5380384**, a nonzero public system-module account had **237583380 umec** and **2375833800000000000 EVM wei**, establishing **q = 10000000000** for that observed test network. Historical mapping, balance and metadata reads returned the requested height; the EVM, Tendermint and REST block hashes matched. [The machine-readable unit report](observations/testnet-units-verified.json) links the original observations. This is read-only evidence, with `liveWritesEnabled: false`; it is neither a contract deployment nor a deposit/withdrawal test. No official HTTPS EVM endpoint, authorized ME test identity, or completed ME write flow has been established by these modules. Application configuration continues to reject remote HTTP RPC endpoints.

## Official source evidence

The SDK default branch was rechecked against immutable revision [`a56f3e936396de8689c2fc8667ad7306765eee9f`](https://github.com/openmetaearth/meta-earth-js-sdk/tree/a56f3e936396de8689c2fc8667ad7306765eee9f). Query paths are verified in [`src/api/identity.ts`](https://github.com/openmetaearth/meta-earth-js-sdk/blob/a56f3e936396de8689c2fc8667ad7306765eee9f/src/api/identity.ts):

- `/metaearth/did/did?address=...`
- `/metaearth/did/didInfo?did=...`
- `/metaearth/kyc/QuerySubAccountDidResponse?sub_account=...`

The subaccount query takes the registered **Bech32 account string**, not an EVM hex address. `verifyMeIdentityForWallet` first reads `/ethermint/evm/v1/cosmos_account/{hexAddress}`, validates the returned `me1` address against the same 20 bytes, and then queries the subaccount DID and its main-address record at one response-attested height. The mapping operation alone is not proof of a registered DID relationship. The live node's reported revision [`e725a569564900d76681489540271227fce9649a`](https://github.com/openmetaearth/me-hub/blob/e725a569564900d76681489540271227fce9649a/x/kyc/keeper/msg_server_sub_account.go) supplies the binding rules.

Known protobuf vocabulary is `DID_STATUS_INACTIVE/ACTIVE` or numeric 0/1, and `KYC_LEVEL_NONE/ONE/TWO/THREE/FOUR/FIVE` or numeric 0–5. Unknown response shapes, states, levels, missing height evidence and inconsistent main/subaccount bindings fail closed. An admission requires an explicit KYC threshold and a recorded official policy basis; this package does not invent which enum means advanced verification. The caller must first verify a separate wallet-control challenge. An identity read does not prove current liveness, English ability, honesty or lack of AI assistance. Raw DID results are private server data and must not be placed in public logs, public receipts or onchain storage.

ME Hub source revision [`1e9eff8a5feae166fe9d72ad4bcc904622b078a1`](https://github.com/openmetaearth/me-hub/blob/1e9eff8a5feae166fe9d72ad4bcc904622b078a1/go.mod) and the running node's reported revision both pin Ethermint [`08a9eaaee0408f181c8213e7e90846fd068c6327`](https://github.com/openmetaearth/ethermint/tree/08a9eaaee0408f181c8213e7e90846fd068c6327). Source and the independent balance observation agree on EVM 18 decimals and bank 8 decimals (`q=10^10`). The SDK test defaults remain chain 400 / HTTP `118.175.0.249:8545`; mainnet EVM fields are not populated in that configuration, and its README qualifies live mainnet write verification.

The fork charges normal successful EVM transactions by rounding prepaid `gasLimit × effectiveGasPrice` **up** to bank atoms and unused-gas refunds **down** to bank atoms. The net charge is therefore not generally `gasUsed × effectiveGasPrice`, nor is it simply that product rounded up. A [public read-only transaction observation](observations/public-fee-rounding-observation.json) confirmed a 1 umec charge for a 168000 wei nominal gas product; the unused-gas boundary remains source-confirmed rather than live-transaction-tested. Failed execution paths are not assumed to share the successful withdrawal formula.

## Integration contract

`src/contracts.ts` is the shared signed-data definition. Its salted commitment helper matches the domain package exactly:

```text
taskCommitment     = keccak256(abi.encode(keccak256('HumanDock/SOURCE/v1'), manifestHash, independentSourceSalt))
deliveryCommitment = keccak256(abi.encode(keccak256('HumanDock/FINAL/v1'), manifestHash, independentFinalSalt))
```

Manifest hashes and both 256-bit random salts stay in authorized private storage. `src/generated-abis.ts` is generated by contract compilation. Use `bigint` for EVM wei, decimal strings across JSON boundaries, and reject unrepresentable conversions rather than truncate them. Demo ledger entries and confirmed chain events are separate execution modes.

| Module | Responsibility and verification boundary |
| --- | --- |
| `chain.ts` | Verify chain ID, pinned runtime code hashes, escrow/registry link, quantum and expected role addresses; match an exact persisted transaction intent to a canonical receipt; scan bounded confirmed ranges with stable event identities. Cursor persistence and application reorg handling remain the caller's responsibility. |
| `signing.ts` | Sign the exact quote, assignment, delivery, approval and revocation EIP-712 structures with an explicitly supplied local account. The helper never reads environment keys. |
| `bank.ts` | Validate account representation, response-attested historical heights, fixed-block balances and denomination metadata. Produce a machine-readable unit report without enabling writes. |
| `balances.ts` | Compare withdrawal before/after balance snapshots and the actual gas payer. A local EVM result is labelled `evm-only`; a busy block or unavailable historical bank evidence is not claimed to be an isolated, verified bank transfer. |
| `deployment.ts` | Deploy the existing compiled Paris-target contracts and record actual runtime code hashes, constructor roles, quantum and deployment receipts. Remote deployment requires explicit authorization supplied by the caller. |
| `local-fixture.ts` | Development/test-only Ganache fixture, public mnemonic and local accounts. It is deliberately not exported by the production package entry point. |

## Local development and read-only checks

Run commands from the repository root:

```sh
# All services in one local process tree: Ganache, contracts, ephemeral API database and Next.
node --import tsx scripts/dev-me-local.ts

# Standalone local EVM, with deployed contracts and no identity service.
node --import tsx scripts/me-local-chain.ts

# Recorded-response bank tests and actual local EVM contract integration.
node --import tsx --test tests/me/*.test.ts tests/contracts/me-adapter.test.ts

# Read-only unit evidence. Explicit ME configuration and a public nonzero account are required.
ME_UNIT_PROBE_ADDRESS=0x... node --import tsx scripts/me-verify-units.ts --output unit-report.json

# Prints a deployment plan. No transaction is sent without --execute.
node --import tsx scripts/me-deploy.ts
```

The unified local runner defaults to web `127.0.0.1:3000`, API `127.0.0.1:4000` and RPC `127.0.0.1:18545` on chain 31337 with one confirmation. Override `WEB_PORT`, `API_PORT` or `ME_LOCAL_PORT` when needed. The wallet keys are the standard publicly known test mnemonic; never fund them on a real network. Buyer index 6 and reviewer index 7 are listed in `.data/local-me-runner/fixture.json`. The identity verifier is injected only into this explicit local process and labels its result `local_test`; ordinary product configuration does not enable it. The chain and in-memory database reset together on each start.

`me-deploy.ts` takes explicit owner, quote, assignment, delivery-gate, arbitrator and platform addresses. A remote execute also requires the expected chain acknowledgment and an explicitly supplied deployer key. This repository has not executed that remote path. A successful deployment alone is not authorization to admit money: reviewed configuration, matching nonzero unit evidence, signer roles, identity policy, wallet control, receipt confirmation and synchronized event indexing remain separate requirements.
