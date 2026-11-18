# HumanDock web

Next.js 16 / React 19 review workspace. English UI with concise Chinese boundary notes. Tasks, balances, approval status, receipts, and transaction states come from the API. No invented chain activity or statistics.

## Run and check

From the repository root, after installing dependencies:

```sh
npm run dev
npm run typecheck --workspace @humandock/web
npm run build --workspace @humandock/web
node --import tsx --test apps/web/lib/wallet.test.ts
```

The shared development runner starts API and web together. The web server binds to `127.0.0.1:3000`; requests to `/api/v1` are rewritten to the API's `/v1`. `API_PROXY_ORIGIN` overrides the default `http://127.0.0.1:4000`. Browser and rewrite timeouts are 120 seconds to accommodate remote chain/identity reads. A query timeout never means a broadcast failed.

The disposable chain runner is `node --import tsx scripts/dev-me-local.ts`. It uses a local EVM chain and explicitly labelled `local_test` identity fixtures. This does not demonstrate real ME identity verification. Keep the demo and local fixture servers on loopback.

## Two explicit execution modes

The API chooses the mode. There is no browser switch that turns demo funds or identities into real ones.

**DEMO:** Brand, Reviewer and Other org buttons create isolated test sessions. Quotes and withdrawals use DEMO credits. The ME connection button explains that mode's boundaries without requesting a wallet.

**Wallet mode:** EIP-6963 discovery with an EIP-1193 injected-wallet fallback. Connecting only requests account access. The user explicitly switches/adds the configured chain, previews the server-issued SIWE message, signs in, and refreshes the configured identity policy. Reviewer role and invitations are assigned by the server; ME identity never certifies language expertise.

Both modes support brief creation, a fixed quote, invited reviewer acceptance, five human review criteria, an immutable report, separate service acceptance and content approval, exact-version export, revocation, and version mismatch rejection. AI/rule suggestions do not decide the verdict.

## Wallet transactions and recovery

1. A task action prepares an intent through the API. It does not send a transaction.
2. Delivery, approval, and revocation require a typed commitment signature. The text itself is not included in typed data or chain calldata.
3. After signature verification, a separate user click opens the wallet's transaction prompt.
4. The browser checks the signed-in account, chain, deployment target, allowed contract method, and exact native value. Withdrawal receivers are restricted to the signed-in wallet.
5. Before opening the send prompt, session storage records an unresolved request. A returned hash is preserved before it is registered with the API. A rejection can be retried explicitly; an ambiguous broadcast cannot be blindly resent.
6. Receipt confirmation and application reconciliation are displayed separately. Allocation is never labelled as a withdrawal. Wallet balance, claimable funds, recorded withdrawals and reconciliation status are separate fields.

Recent intents are loaded on sign-in and can be resumed in Workspace. Registration failures retry registration of the same hash. Unknown sends allow a hash from wallet activity to be verified. A speed-up, cancellation, or corrected hash uses the same registration endpoint; the server verifies sender, original nonce and call details. Rejected or replaced requests are not described as successful payments. Account changes clear private data immediately and invalidate the application session; network changes block signing/sending while read reconciliation remains available.

Network/deployment verification gates writes. Identity admission gates new task creation, quotes, funding and assignment acceptance. Delivery for an existing assignment, service settlement and eligible exits do not require a fresh identity refresh; the server still validates the delivery gate signer for a report. Backend authorization and current canonical chain evidence remain authoritative.

## Verification

```sh
npx playwright test --config playwright.config.ts
npx playwright test --config playwright.live.config.ts
```

The demo suite and local-chain suite have separate configurations and artifact directories. The local-chain fixture's public development accounts are used only in the Playwright Node process. An injected test provider forwards wallet requests to that process; private keys are never put in the browser or product bundle. The test signs actual SIWE/EIP-712 payloads and sends actual transactions only to the disposable local chain.

API contracts: `docs/api-contract.md` and `docs/live-api.md` at the repository root.
