# syn-growth — Growth Engine data model

The relational foundation the **widget**, **follow-up scheduler**, **booking**, and
**Receipt generator** all read and write. This is the schema + key model + write path;
no widget UI, follow-up sending, booking, receipt generation, or AI calls yet. The
tables are shaped so those four never need a rewrite.

- **Worker:** `worker/syn-growth.js` (single self-contained ES module, deployed separately).
- **Storage:** the **same D1 database as syn-core** (binding `SYN_DB`). These are **new
  relational tables alongside** syn-core's `kv` blob table — syn-core and `kv` are never
  touched. Tables are created idempotently by `ensureTables()` (dashboard-paste friendly;
  no migration runner needed).

---

## Key model — two credential types (Stripe publishable/secret pattern)

### 1. Install key (public) — `syn_pk_live_…`
Lives in a `<script>` tag on a client's public website. **Not a secret; never treated as
one.**
- Identifiable prefix (`syn_pk_live_`) so it's obvious in logs.
- Sent as `X-Install-Key` header, `Authorization: Bearer`, or `?k=` query param (the query
  form lets the **CORS preflight** resolve the install and check the origin).
- Validated against that install's `allowed_origins`; **origin mismatch = 403**, and a
  rejected origin is **never** reflected in CORS headers.
- **Write-scoped and tenant-scoped:** may create conversations, messages, contacts, and
  events **for its own install only**. Every write is stamped with the install's own
  `tenant_id`/`install_id`; a `contact_id` from another tenant is rejected (400).
- May **never** read another tenant's data, list contacts, read events, or read anything
  beyond the public widget config (`GET /w/config` returns brand name + display config only
  — never the brand profile, keys, origins, or other tenants).
- **Revocable:** `installs.status='revoked'` ⇒ **401** immediately.
- **Per-install rate limit:** `RATE_LIMIT_PER_MIN` (60) requests/minute, fixed window
  (`growth_rl`). A messages-per-conversation cap (`MAX_MESSAGES_PER_CONVERSATION`, 200) is
  reserved for the message-write path added in a later brief.

### 2. Admin secret — `GROWTH_ADMIN_KEY` (wrangler secret)
Syntrex-only. Creates tenants/brands/installs, rotates/revokes keys, reads everything.
**Never leaves the server.** Sent as `Authorization: Bearer` or `X-Admin-Key`, compared in
**constant time** (SHA-256 + XOR, mirroring syn-core). **Fails closed:** if
`GROWTH_ADMIN_KEY` is unset, every `/admin` route returns **401**.

> Install keys are random, DB-stored public identifiers (so they stay revocable), not signed
> tokens. The constant-time compare and `b64url` helpers are reused from syn-core; no signed
> HMAC tokens are issued in this brief.

---

## Tables

### `tenants`
A customer of the Growth Engine.

| column | type | notes |
|---|---|---|
| `id` | TEXT PK | `ten_…` |
| `name` | TEXT | |
| `slug` | TEXT | **UNIQUE**, `[a-z0-9-]` |
| `status` | TEXT | `active` \| `paused` \| `cancelled` |
| `timezone` | TEXT | IANA tz |
| `created_at` | TEXT | ISO |
| `plan` | TEXT | `core` \| `pro` |
| `notes` | TEXT | |

### `brands`
One-to-many from tenants (the rate card sells additional brands separately, so the
relationship exists from the start).

| column | type | notes |
|---|---|---|
| `id` | TEXT PK | `brd_…` |
| `tenant_id` | TEXT FK→tenants | index `idx_brands_tenant` |
| `name` | TEXT | |
| `profile` | TEXT (JSON) | voice, products/services, **approved claims**, **banned claims**, legal guardrails, tone rules, FAQ pairs, escalation rules |
| `created_at` / `updated_at` | TEXT | ISO |

### `installs`
A deployment of the widget for one brand. Holds the public key.

| column | type | notes |
|---|---|---|
| `id` | TEXT PK | `ins_…` |
| `tenant_id` | TEXT FK→tenants | |
| `brand_id` | TEXT FK→brands | |
| `install_key` | TEXT | **UNIQUE, public** (`syn_pk_live_…`) — returned once at create |
| `allowed_origins` | TEXT (JSON array) | CORS allowlist |
| `config` | TEXT (JSON) | widget display config |
| `status` | TEXT | `active` \| `revoked` |
| `created_at` / `revoked_at` | TEXT | |

### `contacts`
A person who interacted with a widget.

| column | type | notes |
|---|---|---|
| `id` | TEXT PK | `con_…` |
| `tenant_id` | TEXT FK→tenants | |
| `install_id` | TEXT FK→installs | |
| `name` / `email` / `phone` | TEXT | email lowercased, phone normalized to `[\d+]` |
| `first_seen` / `last_seen` | TEXT | |
| `source` | TEXT | `chat` \| `form` \| `call` \| `sms` |
| `status` | TEXT | `new` \| `contacted` \| `booked` \| `closed` \| `lost` |
| `consent_sms` | INTEGER | 0/1 |
| `consent_at` | TEXT | |
| `meta` | TEXT (JSON) | |

**Dedupe:** partial unique indexes `(tenant_id, email) WHERE email IS NOT NULL` and
`(tenant_id, phone) WHERE phone IS NOT NULL`. `POST /w/contacts` upserts: matches an existing
contact on email **or** phone within the tenant and updates it, else inserts.

### `conversations`
| column | type | notes |
|---|---|---|
| `id` | TEXT PK | `cnv_…` |
| `install_id` | TEXT FK→installs | index `idx_conversations_install` |
| `contact_id` | TEXT FK→contacts | nullable |
| `channel` | TEXT | `chat` \| `sms` |
| `started_at` / `last_message_at` | TEXT | |
| `status` | TEXT | |

### `messages`
| column | type | notes |
|---|---|---|
| `id` | TEXT PK | `msg_…` |
| `conversation_id` | TEXT FK→conversations | index `(conversation_id, created_at)` |
| `role` | TEXT | `visitor` \| `assistant` \| `human` |
| `body` | TEXT | |
| `created_at` | TEXT | |
| `meta` | TEXT (JSON) | |

### `events` — the Receipt reads from this; most important table
**Append-only. Never updated, never deleted.**

| column | type | notes |
|---|---|---|
| `id` | TEXT PK | `evt_…` |
| `tenant_id` | TEXT FK→tenants | |
| `install_id` | TEXT FK→installs | |
| `contact_id` | TEXT FK→contacts | nullable |
| `type` | TEXT | one of the constants below |
| `payload` | TEXT (JSON) | |
| `created_at` | TEXT | |
| `idempotency_key` | TEXT | **UNIQUE, nullable** — a duplicate writes exactly one row |

Indexes: `(install_id, created_at)` and `(tenant_id, type, created_at)`.

**Event types** (defined as `EVENT_TYPES` in the Worker):
`inquiry_received`, `first_response_sent`, `followup_scheduled`, `followup_sent`,
`followup_replied`, `appointment_booked`, `appointment_completed`, `call_missed`,
`textback_sent`, `conversation_started`, `conversation_ended`, `escalated_to_human`,
`guardrail_blocked`.

### `followups`
| column | type | notes |
|---|---|---|
| `id` | TEXT PK | `fup_…` |
| `tenant_id` / `contact_id` | TEXT FK | |
| `channel` | TEXT | `email` \| `sms` |
| `sequence_step` | INTEGER | |
| `due_at` | TEXT | index `(status, due_at)` |
| `status` | TEXT | `pending` \| `sent` \| `cancelled` \| `failed` |
| `attempts` | INTEGER | |
| `template_key` / `sent_at` / `error` | TEXT | |

### `job_values` — the guarantee depends on this being trustworthy
**Append-only ledger. NEVER updated in place, NEVER deleted.** Changing the value inserts a
new row. The Receipt computes recovered value using the value **in effect during the
reporting period**, so a client cannot retroactively move the number the guarantee is
calculated against — in either direction. `POST /admin/tenants/:id/job-value` only ever
INSERTs.

| column | type | notes |
|---|---|---|
| `id` | TEXT PK | `jbv_…` |
| `tenant_id` | TEXT FK→tenants | index `(tenant_id, effective_from)` |
| `average_job_value_cents` | INTEGER | |
| `effective_from` | TEXT | |
| `created_at` | TEXT | |
| `set_by` / `note` | TEXT | |

### `receipts`
**Immutable once generated.** Numbers must not drift when events are re-queried, so the
`metrics` and `job_value_cents` in effect at generation are frozen into the row.

| column | type | notes |
|---|---|---|
| `id` | TEXT PK | `rcp_…` |
| `tenant_id` | TEXT FK→tenants | index `(tenant_id, period_start)` |
| `period_start` / `period_end` | TEXT | |
| `metrics` | TEXT (JSON) | frozen computed metrics |
| `job_value_cents` | INTEGER | the value used, snapshotted |
| `generated_at` / `sent_at` | TEXT | |
| `status` | TEXT | `draft` \| … |

### `growth_rl` (internal)
Per-install fixed-window rate limiter — `bucket` (`req:<install_id>`), `count`,
`window_start`. Holds no business data.

---

## Routes

**Admin (admin secret required; fail closed if `GROWTH_ADMIN_KEY` unset):**
```
POST   /admin/tenants
GET    /admin/tenants/:id
POST   /admin/tenants/:id/brands
PATCH  /admin/brands/:id
POST   /admin/tenants/:id/installs        → returns install_key ONCE
POST   /admin/installs/:id/revoke
POST   /admin/tenants/:id/job-value       → inserts a new job_values row
GET    /admin/tenants/:id/events          → paginated (?limit=&cursor=)
```

**Public (install key + origin check + CORS):**
```
GET    /w/config          → widget display config only (brand name + config)
POST   /w/events          → write an event, honors idempotency_key
POST   /w/contacts        → upsert a contact, dedupes on email / phone per tenant
POST   /w/messages        → brand-governed AI turn (see WIDGET.md § Brand-governed AI)
```

`POST /w/messages` builds the brand system prompt server-side from `brands.profile`, calls Anthropic
(`claude-haiku-4-5-20251001`, `max_tokens` 500, last 12 turns, prompt-cached system prefix), screens
the output against the profile's banned claims, and returns the reply. It writes `inquiry_received`
(first visitor message), `first_response_sent` (first reply), and `guardrail_blocked` (on a trip).
Per-conversation rate limit (8/min) is enforced on top of the per-install limit. **Needs the
`ANTHROPIC_API_KEY` secret; the key never reaches the browser.**

**Widget shell (public, no auth, no DB):**
```
GET    /w/widget.js         → the client-side widget script (see WIDGET.md)
```
Served before any key is used on the page, so it precedes the `/w/*` auth block. Cacheable
(`max-age=600, s-maxage=3600`), `application/javascript`, ~13 KB raw / ~4.5 KB gzipped. It
carries no secrets; the key/origin checks happen when it later calls `/w/config` and `/w/events`.

**Health:** `GET /health → {ok:true, service:"syn-growth"}` (public, no DB).

CORS on public routes handles `OPTIONS` preflight and reflects the **specific** requesting
origin when it is in `allowed_origins` — never a wildcard.

---

## Deploy

```sh
# 1. Publish the Worker (binds the SAME D1 as syn-core; edit the D1 ids in the toml first)
npx wrangler deploy --config worker/wrangler.syn-growth.toml

# 2. Set the admin secret (choose it yourself; never commit it)
npx wrangler secret put GROWTH_ADMIN_KEY --config worker/wrangler.syn-growth.toml

# 3. Seed one tenant/brand/install end to end (against the deployed URL)
SYN_GROWTH_URL="https://syn-growth.<subdomain>.workers.dev" \
GROWTH_ADMIN_KEY="<the secret you just set>" \
ORIGIN="https://a-test-client.example.com" \
  node worker/seed-syn-growth.mjs
```

Or paste `worker/syn-growth.js` into the Cloudflare dashboard, add the **`SYN_DB`** D1
binding (the existing syn-core database) and the **`GROWTH_ADMIN_KEY`** secret there.

**Secrets to set:**
- `GROWTH_ADMIN_KEY` — admin credential; every `/admin` route fails closed (401) if unset.
- `ANTHROPIC_API_KEY` — the Anthropic key the AI proxy uses for `POST /w/messages`. Set with
  `npx wrangler secret put ANTHROPIC_API_KEY`. It lives only in the Worker env and never reaches
  the browser; without it, `/w/messages` returns a copy-mappable `502 upstream_failed`.

**D1 binding to attach:** `SYN_DB` (the same database syn-core uses).
