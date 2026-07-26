# Stripe billing — subscriptions, webhooks, gating, the guarantee credit

This is the gate to taking money. It bills the **Growth System only** (SYN Workspace is not priced yet).
Canonical pricing (see `SYNTREX_PRICING_CANONICAL.md`): **Growth Core $349/mo, Growth Pro $549/mo**, both
with a **$497 one-time install fee** charged on the first payment. `GUARANTEE.md` governs the money-back
guarantee that the credit flow pays out on.

Everything here runs in **Stripe test mode** until you deploy live keys yourself (see [§7 Go live](#7-go-live)).

---

## 1. Architecture — who owns what

- **syn-core owns ALL Stripe.** Checkout, the signature-verified webhook, and the guarantee-credit release
  all live in `worker/syn-core.js`. The **Stripe secret key never leaves syn-core** — not the browser, not
  syn-growth.
- **State is derived from Stripe, never guessed.** Every subscription fact on a tenant
  (`subscription_status`, `plan`, `stripe_customer_id`, …) is written **only** by the webhook reconciler
  from Stripe's own event payloads. Nothing flips a tenant to `canceled`/`past_due` locally.
- **The tenant row is the shared contract.** syn-core writes the billing columns onto the shared `tenants`
  table (the same D1 both workers bind). **syn-growth only reads them** — to gate the widget and to know
  whether a tenant is billable when queuing a guarantee credit. syn-growth holds **no Stripe key**.
- **The fee lives in exactly one place.** `tenants.plan` (`core`|`pro`) drives `monthlyFeeFor()`
  (Core $349 / Pro $549), with an optional per-tenant `monthly_fee_cents` override. The webhook sets `plan`;
  it **never** writes a second copy of the fee.

```
browser ──/billing/checkout──▶ syn-core ──▶ Stripe Checkout (hosted card capture)
Stripe  ──/billing/webhook───▶ syn-core ──▶ UPDATE tenants (subscription state)  ┐
                                                                                 ├─ shared D1
syn-growth /w/* (widget) ◀── reads tenants.subscription_status (gate)  ──────────┘
syn-growth receipt gen ──▶ INSERT guarantee_credits (pending)  ──▶ admin release on syn-core ──▶ Stripe credit
```

---

## 2. Data model (added to the shared D1)

Billing columns on **`tenants`** (added idempotently by `ensureBillingTables` in syn-core, mirrored in
syn-growth's `ensureTables` so it can read them):

| Column | Meaning |
|---|---|
| `stripe_customer_id` | Stripe customer. **NULL ⇒ the tenant is EXEMPT** (internal/HALT) — see §5. |
| `stripe_subscription_id` | Stripe subscription. NULL ⇒ exempt. |
| `subscription_status` | Mirrors Stripe: `active`,`trialing`,`past_due`,`canceled`,`unpaid`,`incomplete`,… |
| `stripe_price_id` | The current recurring price (maps to `plan`). |
| `current_period_end` | Unix seconds (informational). |
| `install_fee_charged` | `0/1` — set once so the $497 install is never re-charged. |
| `billing_updated_at` | ISO timestamp of the last webhook write. |

syn-core-owned tables:

- **`stripe_events`** `(id PK, type, created_at)` — the webhook **idempotency ledger**. An event id already
  present ⇒ the webhook is a no-op.
- **`guarantee_credits`** `(id PK, tenant_id, receipt_id UNIQUE, period_start, period_end, amount_cents,
  status, created_at, approved_by, approved_at, applied_at, stripe_txn_id, note)` — the free-month credit
  queue. Written `pending` by syn-growth on receipt generation; released to `applied` by an admin on syn-core.

---

## 3. Secrets — exact names (set on the **syn-core** Worker only)

Set each with `npx wrangler secret put <NAME> --config worker/wrangler.toml` (or in the Cloudflare dashboard,
syn-core Worker → Settings → Variables → **Secret**). **No Stripe secret goes in the repo or the browser.**

| Secret | What it is | Test value shape |
|---|---|---|
| `STRIPE_SECRET_KEY` | Stripe API secret key | `sk_test_…` (live: `sk_live_…`) |
| `STRIPE_WEBHOOK_SECRET` | Signing secret of the webhook endpoint | `whsec_…` |
| `STRIPE_PRICE_CORE` | Price id — Growth Core $349/mo (recurring) | `price_…` |
| `STRIPE_PRICE_PRO` | Price id — Growth Pro $549/mo (recurring) | `price_…` |
| `STRIPE_PRICE_INSTALL` | Price id — $497 one-time install fee | `price_…` |

Reused (already set): `APP_BASE_URL` (Checkout success/cancel return), `ADMIN_TENANT_ID` (default tenant for a
gate-admin call), `AUTH_SIGNING_KEY` + `GATE_*` (auth). **syn-growth needs no new secret** — it holds no
Stripe key.

---

## 4. Stripe dashboard setup — step by step (test mode)

1. **Toggle test mode** (top-right of the Stripe dashboard — "Test mode" on).
2. **Create the products & prices** (Product catalogue → Add product):
   - **Growth Core** → price **$349.00 / month, recurring**. Save → copy the price id → `STRIPE_PRICE_CORE`.
   - **Growth Pro** → price **$549.00 / month, recurring**. Save → copy the price id → `STRIPE_PRICE_PRO`.
   - **Growth Install** → price **$497.00 one-time**. Save → copy the price id → `STRIPE_PRICE_INSTALL`.
3. **Copy the API secret key** (Developers → API keys → **Secret key**, `sk_test_…`) → `STRIPE_SECRET_KEY`.
4. **Create the webhook endpoint** (Developers → Webhooks → Add endpoint):
   - **Endpoint URL:** `https://syn-core.henrybello.workers.dev/billing/webhook`
   - **Events to send** (select exactly these):
     - `checkout.session.completed`
     - `customer.subscription.created`
     - `customer.subscription.updated`
     - `customer.subscription.deleted`
     - `invoice.payment_succeeded`
     - `invoice.payment_failed`
   - Add endpoint → click it → **Signing secret** → reveal (`whsec_…`) → `STRIPE_WEBHOOK_SECRET`.
5. **Set the five secrets** on syn-core (§3).
6. **Smoke test** with a test card: run a checkout (§6), pay with `4242 4242 4242 4242`, any future expiry /
   CVC / ZIP. The webhook should flip the tenant to `active` and mark `install_fee_charged`.

> The **install fee is added to the first invoice only** via Checkout's `subscription_data.add_invoice_items`
> — it is never part of the recurring price, so it can never recur. On a plan change we only swap the
> recurring item, so it is never re-charged.

---

## 5. Endpoints & behaviour

All billing routes are on **syn-core**. `/billing/webhook` is public (Stripe-signed, runs before the Origin
gate). The rest require an authenticated session or the gate/admin token and enforce the app Origin allowlist.

| Route | Who | Does |
|---|---|---|
| `POST /billing/checkout` | admin, or a user for their own tenant | Creates a Checkout Session (subscription mode). `{plan:"core"\|"pro", tenant_id?}`. Adds the install fee to the first invoice **only if `install_fee_charged` is 0**. Returns `{url}` to redirect the client to. |
| `POST /billing/change-plan` | admin / own tenant | `{plan}`. Swaps the subscription's recurring item with **`proration_behavior:create_prorations`**. Never re-adds the install fee. `plan` is reconciled by the webhook, not written here. |
| `GET /billing/status?tenant_id=` | admin / own tenant | The tenant's subscription facts + `exempt` + `serving`. |
| `GET /billing/credits?status=&tenant_id=` | admin | The guarantee-credit queue. |
| `POST /billing/credits/:id/approve` | admin | **Releases** a queued credit: logs `approved_by`+`approved_at`, then applies it to the next invoice (a negative Stripe customer balance transaction). Idempotent. |
| `POST /billing/webhook` | Stripe | Signature-verified, idempotent reconcile (§6). |
| `GET /admin/tenants/:id/credits` | GROWTH_ADMIN_KEY (syn-growth) | Read-only view of a tenant's credit queue (release is on syn-core). |

### Webhook reconciliation (state derived from Stripe)

- `checkout.session.completed` → link `stripe_customer_id` + `stripe_subscription_id`, set
  `install_fee_charged=1` (the first invoice carried it).
- `customer.subscription.created` / `updated` → set `subscription_status`, `stripe_price_id`,
  `current_period_end`, and `plan` (from the price id → Core/Pro). **plan → fee; no fee duplication.**
- `customer.subscription.deleted` → `subscription_status = canceled`.
- `invoice.payment_failed` → `subscription_status = past_due`.
- `invoice.payment_succeeded` → `subscription_status = active`.

**Idempotency:** the first thing the webhook does after verifying the signature is check `stripe_events` for
the event id. Already seen ⇒ 200 `{duplicate:true}` and **nothing is re-applied**. A replayed event changes
nothing. (A reconcile that throws returns 500 *without* recording the id, so Stripe safely retries.)

### Access gating (PART 3)

- The **widget stops serving new value** — `/w/messages`, `/w/capture`, `/w/contacts`, `/w/book` return
  **402** — when the tenant has a subscription that is **not** `active`/`trialing` (so `past_due`, `canceled`,
  `unpaid`, `incomplete` all stop it). `/w/config` still loads and carries `serving:false` so the widget can
  render a graceful "temporarily unavailable" state instead of erroring.
- The **dashboard and past Receipts stay fully readable** in every state — `/me/*` is **not** gated on
  subscription. A `past_due` or `canceled` client can still sign in, see their numbers, and read their
  Receipts; only the public widget pauses. (Rationale: the client must be able to see what they're paying
  for and fix billing; cutting their own dashboard would be user-hostile and self-defeating.)
- **Exemption:** a tenant with **no `stripe_subscription_id`** is exempt and always serves. This covers HALT,
  internal test tenants, and every tenant that existed before Stripe — no flag or migration needed; the
  absence of a subscription *is* the exemption.

### The guarantee credit (PART 4)

1. When a **Receipt closes `free_month_owed`** (`GUARANTEE.md`), syn-growth writes **one `pending`
   `guarantee_credits` row** for the free month's fee — but only for a **billable** tenant (has a
   `stripe_customer_id`). Exempt tenants and `met` Receipts queue nothing. It is idempotent per Receipt
   (`receipt_id` is UNIQUE) and the immutable Receipt snapshot is untouched.
2. **Nothing is auto-applied.** The credit sits `pending` until **you release it**:
   `POST /billing/credits/:id/approve` on syn-core. That logs **who** (`approved_by`) and **when**
   (`approved_at`), then applies the amount as a **negative customer balance transaction** — a credit Stripe
   automatically deducts from the client's **next invoice**. The call is idempotency-keyed (`gcredit_<id>`),
   so a re-approve never double-credits.

---

## 6. Operator flows (curl)

`$CORE = https://syn-core.henrybello.workers.dev`, `$ORIGIN = https://syn.syntrexio.com`,
`$TOKEN` = a gate/admin token (or an admin session token).

```sh
# 1) New client checkout → returns a Stripe Checkout URL to send the client
curl -sS -X POST "$CORE/billing/checkout" -H "Origin: $ORIGIN" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"plan":"core","tenant_id":"ten_..."}'
#  → client opens {url}, pays with 4242 4242 4242 4242 → webhook activates + charges install once

# 2) Upgrade Core → Pro (prorated; install NOT re-charged)
curl -sS -X POST "$CORE/billing/change-plan" -H "Origin: $ORIGIN" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"plan":"pro","tenant_id":"ten_..."}'

# 3) See a tenant's billing state
curl -sS "$CORE/billing/status?tenant_id=ten_..." -H "Origin: $ORIGIN" -H "Authorization: Bearer $TOKEN"

# 4) Review + release a guarantee credit
curl -sS "$CORE/billing/credits?status=pending" -H "Origin: $ORIGIN" -H "Authorization: Bearer $TOKEN"
curl -sS -X POST "$CORE/billing/credits/gcr_.../approve" -H "Origin: $ORIGIN" -H "Authorization: Bearer $TOKEN"
```

---

## 7. Go live

1. Recreate the three prices in **live mode** (same amounts) and copy the **live** price ids.
2. Swap the secrets on syn-core to live values: `STRIPE_SECRET_KEY=sk_live_…`, the three live `price_…` ids.
3. Create a **live** webhook endpoint at the same URL with the same six events; set `STRIPE_WEBHOOK_SECRET`
   to the **live** signing secret.
4. Verify a real card in live mode, then confirm the tenant flips to `active` and `install_fee_charged=1`.

Nothing in the code changes between test and live — only the secret values do.

---

## 8. Verify (covered by `worker/syn-core.test.mjs` + `worker/syn-growth.test.mjs`)

- **Checkout** creates a subscription-mode session with the install fee on the first invoice; a second
  checkout after `install_fee_charged` omits it. The webhook lands the tenant `active`, `install_fee_charged=1`.
- **Plan change** swaps the item with `create_prorations` and never adds an install line; the webhook
  reconciles `plan` to `pro`.
- **Replayed webhook** is a no-op (idempotency ledger); tenant state is unchanged.
- **Signature**: unsigned / wrong-secret / stale-timestamp webhooks are rejected 400.
- **past_due** stops `/w/messages` / `/w/book` / `/w/capture` (402) and `/w/config.serving=false`, while
  `/me/*` (dashboard) stays open. An **exempt** tenant (no subscription) serves throughout.
- **Free-month Receipt** queues exactly one `pending` credit for a billable tenant (none for exempt / met),
  and it is not applied until an admin release (which logs who + when and credits the next invoice once).
