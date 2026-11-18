# ME network endpoints and entry points

Checked **2026-11-18 UTC** against Meta Earth's current public developer documentation, official website, SDK configuration, and read-only testnet observations.

## Testnet network identity

| Item | Value | Use |
|---|---|---|
| Cosmos chain ID | `mechain_400-1` | Cosmos/Hub identity |
| Numeric EVM chain ID | `400` | EVM wallet/network configuration |
| Native symbol | `MEC` | User-facing asset |
| Bank denom | `umec` | Cosmos bank base unit |
| Bank decimals | `8` | MEC display conversion |
| Observed bank→EVM quantum | `1 umec = 10^10 wei` | Amount reconciliation |

## RPC endpoints

### EVM JSON-RPC — published test endpoint

**Endpoint:** `http://118.175.0.249:8545`

This endpoint is published by the official Meta Earth JS SDK and was read successfully on 2026-11-18. Read-only probes returned:

- `eth_chainId = 0x190 = 400`
- `net_version = 400`
- `eth_syncing = false`

**Important:** this is HTTP, not HTTPS. Do **not** use it for production wallet traffic or production signing. HumanDock therefore keeps the secure EVM transport gate closed until Meta Earth provides an official HTTPS EVM endpoint or we operate a controlled secure node connection.

Official SDK source:
https://github.com/openmetaearth/meta-earth-js-sdk/blob/a56f3e936396de8689c2fc8667ad7306765eee9f/src/config/define.ts

### Cosmos/Tendermint RPC — official HTTPS

**Endpoint:** `https://beta-hub-26657.explorer-testnet.me`

This is the official HTTPS Tendermint RPC endpoint documented by Meta Earth. It is suitable for Hub/Tendermint queries such as `/status`, `/block`, and other Cosmos RPC methods.

**It is NOT an EVM JSON-RPC endpoint.** Do not pass this URL to ethers/viem as an EVM provider.

### Cosmos REST — official HTTPS

**Endpoint:** `https://beta-hub-1317.explorer-testnet.me`

Use this for Cosmos REST queries such as node information, bank metadata, account/address mappings, DID/KYC-related Hub queries exposed through REST, and other documented Hub APIs.

## Public entry points

- Testnet explorer: https://www.explorer-testnet.me/
- Testnet faucet: https://www.mec.me/en-US/faucet
- ME Pass: https://www.mec.me/en-US/me-pass
- ME ID: https://www.mec.me/en-US/me-id
- ME Pass Open Platform: https://mepassportal-open.mec.me/en-US
- Developer Center: https://www.mec.me/en-US/developer-center
- Developer documentation: https://docs.mec.me/
- Official developer guide: https://github.com/openmetaearth/me-docs/blob/main/docs/development-guides/for-developers.md
- Official network details: https://github.com/openmetaearth/me-docs/blob/main/docs/getting-started-for-developers/network-details.md

## Faucet rules

The official faucet currently states:

- 2 test MEC per claim
- one claim per address per day
- reset at 00:00 UTC
- test tokens have no mainnet value

The faucet requires a testnet address plus email verification and anti-bot verification. HumanDock has **not** automated or stored the user's email code.

## Mainnet

The official developer guide currently documents:

- Cosmos chain ID: `me-chain`
- Currency: MEC
- Explorer: https://explorer.mec.me/

The reviewed official SDK/default configuration did **not** publish a numeric mainnet EVM chain ID or an EVM JSON-RPC URL. HumanDock therefore does not invent one.

## HumanDock configuration policy

Use:

```text
ME_EVM_CHAIN_ID=400
ME_EVM_RPC_URL=<secure official HTTPS EVM RPC, when available>
ME_COSMOS_REST_URL=https://beta-hub-1317.explorer-testnet.me
ME_TENDERMINT_RPC_URL=https://beta-hub-26657.explorer-testnet.me
ME_NETWORK=me-testnet
ME_NATIVE_SYMBOL=MEC
ME_BANK_DENOM=umec
ME_BANK_DECIMALS=8
ME_QUANTUM_WEI=10000000000
```

Do not substitute the Cosmos REST or Tendermint URL for the EVM URL.

## Acceptance sequence before enabling live funds

1. Connect a user-authorized wallet.
2. Verify numeric EVM chain ID 400.
3. Resolve EVM address → Cosmos account.
4. Resolve Cosmos sub-account → ME ID/DID binding.
5. Enforce an explicit KYC/identity policy.
6. Complete the official faucet claim with a controlled test wallet.
7. Deploy HumanDock escrow and release contracts.
8. Record contract addresses, bytecode hashes, constructor roles, and deployment block.
9. Execute a small controlled payment.
10. Wait for confirmations and independently verify EVM receipt + Hub bank event.
11. Execute delivery/settlement.
12. Execute withdrawal.
13. Reconcile EVM balance, bank balance, gas debit and withdrawal event.
14. Re-run the indexer from a checkpoint and prove the ledger is unchanged.

Until all fourteen steps pass, `APP_MODE=me` must not enable unrestricted production funds.
