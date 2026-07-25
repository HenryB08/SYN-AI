# syn-core — Real authentication

Real per-user accounts for the **SYN app itself** (who can log in), replacing the temporary
single-credential `/gate`. Accounts live in **syn-core's own D1** (the same binding that holds the KV
surface). This is the precondition for a client dashboard and for Stripe provisioning (pay → an account
exists). It does **not** touch the Growth widget worker (`syn-growth`), which is about a client's
website visitors, not app logins.

> **Where it lives & why:** all of this is in `worker/syn-core.js`. The app already talks **only** to
> syn-core for KV + AI, and every protected request already carries a Bearer token syn-core verifies. So
> a session token slots into the exact place the gate token occupied — one Worker, one D1, one
> verification path, no new service to deploy, and protected routes accept **either** token during the
> cutover so the client is never broken.

---

## Algorithm & lifetimes (the answers up front)

- **Password hashing:** **PBKDF2-HMAC-SHA256, 210,000 iterations**, per-user random 16-byte salt, via
  WebCrypto. *Why:* the Workers runtime ships no native bcrypt/scrypt/argon2; PBKDF2 is the strongest KDF
  that **is** native. The stored record is self-describing — `pbkdf2$<iters>$<saltB64>$<hashB64>` — so the
  cost can be raised later with no migration. The plaintext password is **never** stored or logged.
- **Session (access) token:** signed HMAC, **7-day** lifetime. Same envelope as the gate token, keyed by
  `AUTH_SIGNING_KEY` (falls back to `GATE_SIGNING_KEY`). Carries `{typ:"sess", uid, tid, role, epoch, exp}`.
  Refresh = re-login, or bump to a short access token + refresh token later (see weaknesses).
- **Email-verify link:** signed, **24h**, single-use.
- **Password-reset link:** signed, **1h** (expires fast), single-use.
- **Seeded admin email:** the value of the **`GATE_EMAIL`** secret — the operator's existing admin
  address. On a successful `/gate` login the real admin account is seeded/repaired from the gate
  credentials (see below), so retiring the gate never locks you out.
- **Invite flag:** env **`SIGNUP_MODE`** — `"invite"` (default, private beta) or `"open"` (public).

---

## Data model (D1, created idempotently by `ensureTables`)

```
users(
  id, email UNIQUE, password_hash,        -- password_hash is a PBKDF2 record, never plaintext
  email_verified INT, status, role,       -- status: active|disabled ; role: member|admin
  tenant_id,                              -- links a user to their workspace/org; NULL → onboarding state
  session_epoch INT,                      -- bump to revoke ALL of a user's outstanding sessions
  verify_jti, reset_jti,                  -- single-use nonces for the verify/reset links
  created_at, last_login_at)

auth_invites(id, email, code, tenant_id, role, used_by, used_at, created_at)
  -- email row  = reusable allowlist entry ; code row = single-use invite code (optionally carrying a
  --              tenant_id + role so signup joins a workspace with a role)

gate_rl(ip, fails, first_ms, blocked_until)   -- reused by the limiter, keyed "ip|bucket" per endpoint
```

## Endpoints

| Method + path | Auth | What it does |
|---|---|---|
| `POST /auth/signup` | none | email + password → **unverified** account, emails a verify link. Gated by `SIGNUP_MODE`. Generic response always (no enumeration). |
| `POST /auth/verify` · `GET /auth/verify?token=` | none | consumes a signed, 24h, **single-use** token → marks `email_verified`. |
| `POST /auth/login` | none | email + password → **7-day session token** `{token, exp, user}`. Wrong creds → generic `invalid_credentials`, rate-limited. Unverified (correct pw) → `email_not_verified`. |
| `POST /auth/forgot` | none | emails a signed, 1h, **single-use** reset link **if** the account exists; identical response either way. |
| `POST /auth/reset` | none | consumes the reset token → sets a new password, **bumps `session_epoch`** (logs out other sessions), confirms email. |
| `GET /auth/me` | session **or** gate | the authenticated user's profile (`id, email, verified, role, tenant_id`). |
| `POST /auth/logout` | session **or** gate | client drops its token; `{all:true}` on a session bumps `session_epoch` → **server-side revoke of every outstanding token** for that user. |
| `POST /auth/invite` · `GET /auth/invite` | **admin** (gate or admin session) | manage the private-beta allowlist: `{email}` to allowlist an address, `{code:true, tenant_id?, role?}` to mint a single-use invite code. |
| `POST /gate` | none | **legacy** single-credential login (still working during cutover); also **seeds/repairs the real admin account**. |
| `GET/PUT /kv/<key>` · `POST /v1/messages` | session **or** gate | protected surface — **tenant-scoped** for regular sessions (below). |

## Tenant scoping (data isolation)

KV keys are namespaced `syn5:<tenantId>:<sub>`. On a protected request:

- **Gate token** and **admin-role sessions** are **all-access** (operator / transition).
- A **regular session** may touch a key **only** when `keyTenant(key) === user.tenant_id`. A **global**
  key (e.g. `syn5:orgs`, no tenant segment) and any other tenant's keys → **403**.
- A user with **no tenant** (`tenant_id = NULL`) reaches **no** workspace data → the "appropriate
  empty/onboarding state, not someone else's workspace" guarantee. `/auth/me` still resolves for them.

Authority is always the **DB row**, never the token's claims: `authenticate()` loads the user, checks
`status='active'` and that the token's `epoch` matches the user's current `session_epoch`.

## The seeded admin (no lock-out)

On a successful `/gate` login syn-core calls `seedAdminUser(GATE_EMAIL, GATE_PASSWORD)`: if no user
exists it inserts one (verified, `role='admin'`, `tenant_id = ADMIN_TENANT_ID` if set); if it exists it
only ensures verified/active/admin and back-fills the tenant — it **never overwrites the password**, so a
later self-service reset sticks. **Result:** the admin logs in through `/auth/login` with the *same*
credentials as the gate. Set `ADMIN_TENANT_ID` to the operator's existing org id to link the admin
account to the existing workspace; otherwise the admin is all-access by role.

## The private-beta flag (you control when public signup opens)

`SIGNUP_MODE` (Wrangler secret/var):

- **`invite`** (default) — signup succeeds only for an **allowlisted email** or a **valid unused invite
  code**. Everyone else gets the same generic "check your email" response but **no account is created**.
  Add entries with `POST /auth/invite`.
- **`open`** — public signup. Flip by setting `SIGNUP_MODE=open` (`npx wrangler secret put SIGNUP_MODE`)
  and redeploying. That single switch opens the doors; set it back to `invite` to close them.

## Configuration (Wrangler)

Secrets/vars on the syn-core Worker:
`ANTHROPIC_API_KEY`, `GATE_EMAIL`, `GATE_PASSWORD`, `GATE_SIGNING_KEY` (existing) · **`AUTH_SIGNING_KEY`**
(new; falls back to `GATE_SIGNING_KEY`) · **`RESEND_API_KEY`** + **`AUTH_EMAIL_FROM`** (a Resend-**verified**
first-party sender, e.g. `SYN <no-reply@syntrexio.com>`) · **`APP_BASE_URL`** (link base, default
`https://syn.syntrexio.com`) · **`SIGNUP_MODE`** · **`ADMIN_TENANT_ID`** (optional).

> **Email identity note:** auth mail is **first-party transactional** (SYN's own verify/reset to SYN's own
> users), so it correctly sends from a **Syntrex-verified** domain. This is distinct from the follow-up
> rule in `syn-growth` that forbids `syntrexio.com` — that rule protects the primary domain from a
> *client's cold outreach*, which is a different sender and a different risk.

## Security posture

- Tokens are **signed, expiring, and verified server-side** — client claims are never trusted; the DB
  row is authoritative for tenant/role/epoch.
- Verify and reset tokens are **single-use** (a nonce stored on the user, cleared on consume) and
  **short-lived** (24h / 1h). A `typ` field stops a token minted for one purpose being replayed as another.
- **No account enumeration** on signup, login, or forgot (identical responses; login runs a real PBKDF2
  verify against a fixed **dummy hash** when the email is unknown so timing matches).
- **Every** auth endpoint is **rate-limited** per `ip|bucket` (5 fails / 15 min; signup & forgot count
  every request to curb email-send abuse).
- **No secret, token, or password is ever logged.** Passwords exist only as PBKDF2 records.

## Client migration (follow-up — NOT wired in this change)

This change is **server-side only**; the 8-file app JS still uses the gate (it keeps working). To cut the
client over, the `gate*` helpers in `js/01-boot-auth.js` map 1:1:

- `gateSignIn(email,pw)` → `POST /auth/login`; store `token`/`exp` exactly as today (the token is a Bearer
  and slots into `gateHeaders()` unchanged).
- New UI: signup → `POST /auth/signup`; a `#verify=<t>` route → `POST /auth/verify`; forgot → `POST
  /auth/forgot`; a `#reset=<t>` route → `POST /auth/reset`.
- Stop reading the global `syn5:orgs` registry to locate a workspace — `/auth/login` (and `/auth/me`)
  return the user's `tenant_id`; load `syn5:<tenant_id>:*` directly. A tenant-scoped session **cannot**
  read `syn5:orgs`, by design.

## Weaknesses I did NOT fully close (honest list)

1. **7-day bearer sessions, revocable only per-user (epoch), not per-session.** Logout-all works;
   revoking one device while keeping others requires a `sessions` table (session id per token). Hardening
   path: short (~15 min) access tokens + a rotating refresh token in the `sessions` table.
2. **No brute-force lockout on the *account*, only per IP.** A distributed attacker rotating IPs isn't
   slowed by the IP limiter. PBKDF2 (210k) makes offline cracking costly, but add per-account throttling
   / captcha for online guessing at scale.
3. **Rate-limit state is best-effort** (a D1 row per `ip|bucket`); it isn't atomic under high
   concurrency and an attacker on a huge IP pool sidesteps it. Cloudflare WAF/Turnstile in front is the
   real defense.
4. **Deliverability of auth email is unproven in-sandbox** (no network here) — verify the `AUTH_EMAIL_FROM`
   domain in Resend and send a live test before relying on it. If email isn't configured, `sendAuthEmail`
   fails soft (signup/forgot still return their generic response); wire an admin "resend verification"
   path for support.
5. **Email verification does not block a stale unverified account from being re-claimed** — a second
   signup for an unverified email silently re-sends the verify link (no enumeration), which is intended,
   but there's no account-takeover concern only because nothing is granted before verification.
6. **No password strength policy beyond length ≥ 8**, no breached-password check (HIBP), no MFA. All are
   future hardening, none are wired here.
