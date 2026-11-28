# AutoRevenue AI 2.0 — Independent Code Audit

**Scope:** GitHub branch `autorevenue-ai-2.0-test` only  
**Audit date:** 2026-11-28  
**Production:** Not modified  
**Method:** Static review of `server.js`, `public/app.js`, `public/index.html`, `public/style.css`, `package.json`, and `README.md`; route/authentication inventory; JavaScript parse checks; targeted validation-regex test. No live customer data, secrets, or production systems were accessed.

## Executive summary

The application has a useful approval-first foundation: authenticated workspace APIs, a PostgreSQL persistence path, hashed server-side session tokens, Stripe webhook signature verification, endpoint rate limits, and explicit separation of internal recommendations from external actions.

It is not yet ready to be described as a fully autonomous revenue operator. Its current scheduler is best-effort while the Render web service is awake, task planning creates plans rather than executing them, and the repository has no automated test script or CI workflow visible in the reviewed root files.

## Findings

### Fixed in this audit

- **High — Public lead intake rejected normal email addresses.** The email validation regex contained an extra backslash before the dot, so a normal address such as `person@example.com` failed validation. Corrected in commit `c6433f2` on this test branch. Server syntax was rechecked after the edit; the regex was separately tested against a normal email address.

### Remaining recommendations

1. **High — Add automated tests and CI before expanding features.** `package.json` defines only a start script. Add unit tests for validation, state normalization, task deduplication/status transitions, Stripe webhook idempotency, and API authorization; add a CI workflow that runs syntax checks and tests on every pull request.
2. **High — Enforce an AI usage budget, not just request-count limits.** AI endpoints have per-route request limits and usage recording, but the reviewed code does not enforce a hard daily/monthly dollar or token ceiling. Add a configurable hard cap and stop AI calls when reached. Do not rely on estimated usage pricing as an enforcement mechanism.
3. **High — Verify database-backed persistence is mandatory in the deployed test service.** The app deliberately falls back to local JSON storage if `DATABASE_URL` is absent. On an ephemeral web-service filesystem, that fallback risks losing workspace data on restart/redeploy. Add a production/test deployment startup guard requiring PostgreSQL, or display a prominent non-persistent warning and disable writes.
4. **Medium — Re-enable a restrictive Content Security Policy.** Helmet is enabled, but `contentSecurityPolicy: false` disables CSP. The frontend includes inline event handling, so first move inline handlers to registered JavaScript listeners, then deploy a restrictive CSP (prefer nonces or hashes) and test all dashboard workflows.
5. **Medium — Harden session lifecycle.** Tokens are random and stored hashed in PostgreSQL, with a 12-hour expiry. Add periodic deletion of expired session rows and consider shorter idle expiry / session rotation after sensitive actions. The in-memory fallback is not suitable for multiple instances or durable sessions.
6. **Medium — Make webhook idempotency explicit.** The Stripe handler checks for existing orders and revenue entries, which helps avoid duplicate records. Add a durable Stripe event-ID ledger with a unique constraint so every webhook event is processed exactly once, including subscription and fulfillment side effects.
7. **Medium — Make scheduler guarantees explicit in product UX.** The current timer runs on startup and every 15 minutes only while the web process is awake. Render free-service sleep can interrupt it. Use a dedicated worker or external scheduler for dependable daily execution; do not label this as continuous autonomy until that exists.
8. **Medium — Separate workspace state writes from system-owned records.** The authenticated `PUT /api/state` endpoint accepts a full normalized workspace payload, including automation/task history. Consider moving agent task status, execution logs, and billing events behind dedicated server-side APIs so browser state saves cannot overwrite system-owned records.
9. **Medium — Add stricter input validation and output schemas to AI plans.** The plan endpoint checks a few required fields but should validate every step field, cap array/string lengths, validate numeric ranges, and reject malformed output before saving.
10. **Low — Add operational observability.** Add structured request IDs, route latency/error metrics, scheduler heartbeat age, database health, and a safe diagnostic view that never exposes credentials or customer data.

## Positive controls observed

- Admin password comparison uses constant-time comparison after checking equal buffer lengths.
- Session tokens are random and their hashes are stored in PostgreSQL when configured.
- Protected workspace, Stripe transaction, commerce, and agent routes use authentication.
- Login and many expensive AI/commerce routes use rate limiting.
- Stripe webhook signature verification is performed against the raw request body.
- The test build explicitly rejects live Stripe secret keys in the webhook path.
- Public lead intake requires explicit consent and includes a honeypot and rate limit.
- AI prompts generally instruct the model not to fabricate sales, market evidence, or execution claims.
- The task workflow is approval-first; planning does not itself publish, spend, or contact customers.

## Validation performed

- `server.js`: JavaScript parse check passed after the email-regex fix.
- `public/app.js`: JavaScript parse check passed at audit time.
- Email regex: verified that a standard email address failed before the fix and matches the corrected expression.
- Route inventory: 37 Express routes identified; protected workspace routes were reviewed for authentication middleware.
- This was a static audit, not a full penetration test, dependency vulnerability scan, or browser end-to-end test. No claim is made that every UI control or external integration was exercised.

## Recommended order of work

1. Add automated tests/CI and test the public lead intake fix.
2. Enforce AI spend/token ceilings.
3. Require durable database storage in the deployed test service.
4. Add durable webhook event idempotency.
5. Restore CSP after removing inline handlers.
6. Add a reliable scheduled worker only after its hosting cost is approved.

**Safety boundary:** No spending, customer outreach, publication, production deployment, or production data changes were performed as part of this audit.
