# Browser workflow checks

These are repository Playwright tests for a managed Chromium process, not automation of a user's existing Chrome session.

The suite starts `npm run dev` through Playwright's `webServer`. API and Next.js therefore share one parent process and network namespace. It waits for the proxied API health route, uses an in-memory database, disables AI-provider calls, and binds to loopback.

Once `@playwright/test` and its Chromium runtime are installed:

```sh
npx playwright install --with-deps chromium
npx playwright test
```

The lifecycle test operates through the real UI. It creates a unique fictional task, checks CSRF/idempotency headers, switches demo roles, verifies organization isolation, completes five human checks, approves before settling, downloads the exact approved text, checks a private local receipt, edits a new version, verifies API and UI rejection of old-approval reuse, accepts the service independently, and withdraws allocated DEMO credits. No real funds, external API keys, or ME identities are used.

The mobile test checks the navigation and explicit unavailable-wallet explanation. Tests do not request wallet accounts or signatures.

Retries: 1. Screenshots and traces are retained on failure. HTML report, failure artifacts, and the approved-text fixture are written below `artifacts/browser/`, which is git-ignored. A fresh server is required; do not reuse an arbitrary existing local service.

This suite has been authored from the implementation and API contract. Its execution status should be reported from the actual CI run, not inferred from the test source.
