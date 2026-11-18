# HumanDock web

Next.js 16 / React 19 client for the HumanDock local MVP. English workspace with short Chinese boundary notes. All task, ledger, and receipt data comes from the API; no fabricated task completions or blockchain transactions.

From the repository root, after installing the workspace dependencies:

```sh
npm run dev --workspace @humandock/web
npm run typecheck --workspace @humandock/web
npm run build --workspace @humandock/web
```

The server binds to `127.0.0.1:3000`. Start the backend separately on `127.0.0.1:4000`. Browser requests use `/api/v1`; Next rewrites them to the backend's `/v1`. `API_PROXY_ORIGIN` can override the backend origin for a controlled local setup. Do not expose this demonstration to the public internet with its demo authentication enabled.

## Included workflow

- Brand, invited reviewer, and other-organization demo sessions.
- Create brief, immutable quote, explicit DEMO funding, reviewer assignment.
- Five human-reviewed criteria, optional clearly labelled rule/AI suggestions, immutable report.
- Service acceptance and content approval as separate actions.
- Exact-version export, private receipt, changed-version rejection, approval revocation.
- Actual local balance entries, allocation and withdrawal separately displayed.
- Session and CSRF handling, idempotency keys, stale request isolation on role changes.

ME connection is intentionally unavailable until genuine network, deployed contract, and identity checks pass. The button explains the missing integration and does not request any account or wallet signature. Demo accounts are not language-certified or ME-verified.

The API contract lives at `docs/api-contract.md` in the repository root. Backend validation and authorization remain authoritative; UI checks support the workflow but never replace them.
