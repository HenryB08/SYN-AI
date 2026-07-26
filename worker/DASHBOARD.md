# Growth client dashboard

The Growth client's own view of their results — the first surface built on the real auth from Prompt 26.
Per the locked architecture it is **an area of the same app**: a Growth client signs in at
`syn.syntrexio.com` like any user and lands on a Growth dashboard instead of the full Workspace.

Two halves:
- **syn-growth `/me/*`** — session-scoped, read-mostly endpoints that serve the client's own tenant data.
- **The `#growth` scene** — a self-contained top-level view in the app (`index.html` + `js/01-boot-auth.js`
  + `css/03-app.css`) that renders those endpoints.

---

## Routing: what the user IS (§PART 2)

Routing is by the **explicit `product` field** on the syn-core user (`users.product`, added this change):
`'workspace' | 'growth' | 'both'`. It is set at provisioning (invite/Stripe), never guessed.

- `/auth/login` and `/auth/me` return `product`. In `authSubmit` (cloud mode):
  - `product === 'growth'` → **`enterGrowth(user)`** → the `#growth` scene. A Growth user **cannot** enter
    the Workspace (`#app` is never turned on for them).
  - `'workspace'` / `'both'` → the Workspace app (located by email, as before).
- On boot, a valid session with `product === 'growth'` restores straight to `#growth`.
- The seeded admin is `product: 'both'`.

## The frontend (real auth is now the login path — §PART 1)

`js/01-boot-auth.js`:
- Cloud sign-in posts to **`/auth/login`** (not `/gate`), storing a signed session token in `syn5:auth`
  (and the gate Bearer slot, so token-gated `/kv` reads keep working for Workspace users). The gate
  remains only as a fallback.
- `authSignup` / `authForgot` / `authReset` / `authVerify` wrap the matching `/auth/*` endpoints. Email
  deep links `#verify=<token>` and `#reset=<token>` are handled at boot by `handleAuthHashRoutes()`.
- The dashboard reads syn-growth via `SYN_GROWTH_URL` with `growthGet`/`growthPut` (Bearer session token);
  a 401 signs the client out. `renderGrowth()` builds the whole scene.
- **Dollar layer (§recovered-revenue).** `renderGrowthBody` shows dollars recovered this period with the
  **booking count always beside the dollar** and the word **"estimated"** on every dollar (never a dollar
  alone — `GUARANTEE.md`), a **guarantee gauge** (recovered vs the monthly fee, `met`/`free month owed`),
  and past-Receipt rows tagged by `guarantee_outcome`. The whole live view is labelled **informational**;
  the immutable Receipt is the record of account. A client with **no confirmed job value** sees counts and
  **no dollar figure** (not a guessed one). Admin sets the fee/mode via `POST /admin/tenants/:id/guarantee`
  (`monthly_fee_cents` and/or `guarantee_mode`); the fee in force is snapshotted into each Receipt.

## syn-growth `/me/*` (session-scoped, tenant-isolated)

Authenticated by a **syn-core session token** (`verifyMeSession`): syn-growth **binds the same D1** as
syn-core, so it verifies the token's HMAC with the shared **`AUTH_SIGNING_KEY`** and resolves the user
from the shared `users` table (DB is authority — active status + matching `session_epoch`, so a
logged-out/rotated token stops verifying here too). Everything is scoped to **`user.tenant_id`** — never a
tenant id from the request. A non-growth user (or one with no tenant) gets 403.

| Method + path | Serves |
|---|---|
| `GET /me/summary` | headline strip for the month (`?month=YYYY-MM`, default current): inquiries, answered, after-hours, leads, follow-ups, bookings, value recovered, and the **dollar/guarantee layer** — `guarantee_mode`, `monthly_fee_cents`, `guarantee_outcome` (`met`\|`free_month_owed`), `guarantee_met`, `evaluated_on` (`dollars`\|`captured`); response is flagged `informational:true` (the Receipt governs) |
| `GET /me/receipt` | the current month's Receipt, **live** (JSON, or `?format=html` rendered) — the month isn't closed yet |
| `GET /me/receipts` · `GET /me/receipts/:id` | past (generated, immutable) Receipts, newest first · one Receipt (`?format=html`) |
| `GET /me/leads` | recent captured contacts (name/email/phone/status/source/when) |
| `GET /me/bookings` | recent bookings with linked contact |
| `GET /me/install` | the public install key + the ready-to-paste embed snippet |
| `GET /me/config` · `PUT /me/config` | the brand brain the widget runs on: voice, business name, greeting, FAQ, business hours, scheduling link, job value — editable; writes go live |

**Consistency (§PART 4).** `/me/summary` and `/me/receipt` both compute from **`computeReceiptMetrics`** —
the exact function the Receipt generates from — for the same period, so the dashboard headline and the
Receipt can never disagree. A generated (past) Receipt used the same function at generation. The unit
suite asserts headline == live receipt == generated receipt.

**Config write-back.** `PUT /me/config` updates the brand (`brands.profile.voice`, `brands.name`),
`installs.config` (FAQ / business hours / greeting / scheduling link — what the live widget's `GET
/w/config` reads), and appends a **new `job_values` row** when the job value changes (the guarantee's
number is never moved in place). Tenant-guarded: the target install/brand is always the session's tenant's.

## Security / isolation

- The session token authorizes every `/me/*` call; there is **no tenant id in any request** — a client
  can only ever read/write their own tenant.
- Cross-tenant is impossible by construction (scoped to `user.tenant_id`); the suite proves tenant B sees
  only B and never A's leads/keys.
- CORS on `/me/*` is the app-origin allowlist (`APP_ORIGINS`), not `*`.
- The install key re-shown here is the **public, revocable, origin-locked** key that already lives in the
  client's site HTML — safe to show the tenant owner; the admin listing still never re-exposes it.

## Configuration (new)

syn-growth now needs the **`AUTH_SIGNING_KEY`** secret — the **same value** as syn-core's — to verify
session tokens (`npx wrangler secret put AUTH_SIGNING_KEY` on the syn-growth Worker). Optional
`WIDGET_BASE_URL` overrides the base in the embed snippet (defaults to the syn-growth workers.dev URL).
No new D1: the `users` table is syn-core's, in the shared database.

## Tests

- `worker/syn-growth.test.mjs` — the `/me/*` suite: auth gates, tenant isolation, headline ==
  live == generated Receipt, leads/bookings, install snippet, config get + write-back reflected in the
  live `/w/config`, append-only job value, session revocation. Plus the **dollar layer**: the admin
  guarantee setter (fee override + mode + validation), dollars = bookings × period-start job value,
  free-month-owed when recovered < fee, binary-mode evaluation, a **mid-period job-value change moving
  neither the current live period nor a past Receipt**, and the summary carrying the dollar/guarantee
  fields (with no dollar invented when the job value is unset).
- `worker/syn-core.test.mjs` — `product` threaded through login/me/invite/seeded-admin.
- `tests/growth-dashboard.mjs` — Playwright: real-auth login → `#growth`, headline/receipt/leads/bookings/
  past-receipts render, snippet copy, config edit PUT, session token on every `/me` call, Growth user can't
  reach the Workspace, wrong password rejected.
