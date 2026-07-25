# syn-growth — Observability & per-tenant cost tracking

The visibility layer for a Worker that now runs live traffic costing real money, per message, on real
client websites: **what each client is spending** (so margins are known, not assumed) and **whether a
widget is failing** on a client's site (so it is not invisible until they complain).

All routes are admin-authed (`GROWTH_ADMIN_KEY`, fail-closed if unset). Per-tenant routes are
tenant-scoped by `:id`. Nothing here is reachable with a public install key.

---

## What was built

| Piece | Where |
|---|---|
| `usage_events` append-only cost ledger (one row per Anthropic call) | `ensureTables`, `writeUsage` |
| `error_events` append-only failure log | `ensureTables`, `logError` |
| Cost model as editable constants | `PRICE_PER_MTOK`, `usageCostCents` |
| Usage capture on every `/w/messages` (before the guardrail, so blocked replies still count) | `wMessages` |
| Error capture: Anthropic failure, guardrail block, DB-write failure, install-key rejection, unhandled handler error | `wMessages`, router, `logError` |
| `GET /admin/tenants/:id/usage` — one client's spend over a range (totals + daily) | `tenantUsage` |
| `GET /admin/usage` — portfolio spend across all tenants (per-tenant breakdown) | `portfolioUsage` |
| `GET /admin/errors` — recent errors, newest first, `?tenant=` / `?kind=` filters | `listErrors` |
| `GET /admin/health-summary` — the one morning check (24h) | `healthSummary` |

Schema/route reference: `worker/SCHEMA.md`. Full test coverage: `worker/syn-growth.test.mjs`.

---

## The cost model

Held as named constants at the top of `syn-growth.js` so a price change is a one-line edit:

```js
const PRICE_PER_MTOK = { "claude-haiku-4-5-20251001": { input: 1.00, output: 5.00 } }; // USD / 1M tokens
```

`cost_cents` for a call = `input_tokens × price.input / 10000 + output_tokens × price.output / 10000`
(USD/MTok → cents/token is `price / 10000`). It is always **reproducible from the stored
`(model, input_tokens, output_tokens)`** — verified by the tests. `cost_cents` is a REAL column, not
INTEGER: one message costs a small fraction of a cent, which INTEGER cents would round to zero.

> **Refinement flagged, not yet done:** Anthropic returns `cache_read`/`cache_creation` token counts
> separately (the widget's system prefix is cache-controlled). We store the plain `input_tokens`/
> `output_tokens` and price those. Cache reads are billed at ~0.1×, so ignoring them slightly
> *under*-counts by a negligible amount in steady state; the worst-case ceiling below assumes fully
> uncached input, so it *over*-counts and stays a true ceiling. Add cache-aware pricing when it matters.

---

## Cost per message observed in the tests

The test harness's Anthropic mock returns `input_tokens: 20, output_tokens: 8`:

- **Per message: `0.006¢`** ( = 20×1/10000 + 8×5/10000 = 0.002 + 0.004 ). Asserted exactly.
- **Realistic production estimate** (uncached input ~150 tok + output ~150 tok on Haiku): **≈ 0.09¢/msg**
  ( 150×1/10000 + 150×5/10000 = 0.015 + 0.075 ). Still well under a tenth of a cent.

### The proven per-conversation ceiling (Part 4)

The message endpoint caps output tokens (`MSG_MAX_TOKENS = 500`), history (`HISTORY_WINDOW = 12`), the
single-turn input (~4000 chars), and messages per conversation (`MAX_MESSAGES_PER_CONVERSATION = 200`,
i.e. **100 model calls**). Driving one conversation to its hard cap with per-call usage pinned at the
worst case the code allows (`input 4000 / output 500`) and summing `usage_events`:

- worst-case per call = `0.65¢`, × 100 calls = **`65¢` = `$0.65` absolute ceiling per conversation.**

The test asserts the conversation hit its 409 cap at exactly 100 calls, one `usage_events` row per call,
and `sum(cost_cents) == 100 × per-call` and `≤ ceiling`. The cost ceiling is now **verified, not
assumed.**

---

## Reconciliation with the ~$14/client/month floor

**Honest answer: the widget's text-AI token cost is a tiny fraction of the $14 floor, which confirms it
is comfortably within — but is not the driver of — that number.**

- At the realistic ~0.09¢/message, a client would need **~15,500 widget messages/month** for the text
  AI alone to reach $14. Real inbound chat volume is orders of magnitude below that, so per-client
  Anthropic-text spend is **cents, not dollars.**
- The `$14/client/month` figure in the canonical pricing file is a **blended floor** — it is dominated
  by the other cost centers of the Growth System (Growth Pro's **AI voice answering** telephony
  minutes, SMS/messaging fees, and platform/infra), **not** by widget chat tokens. This observability
  layer meters **only the Anthropic calls `/w/messages` makes today**; voice and SMS metering will be
  added the same way (a `usage_events`-style row per billable unit) when those cost centers land.

> ⚠️ **Cannot fully verify against the canonical file:** `SYNTREX_PRICING_CANONICAL.md` is still not
> committed to the repo, so the exact composition of the $14 floor could not be checked. The claim
> above (widget text cost ≪ $14; floor is voice/SMS/infra-dominated) is the correct order-of-magnitude
> reconciliation from the token math, and should be confirmed once the canonical file is in the repo.

**What this delivers for margins:** `GET /admin/tenants/:id/usage` is the number to check per client —
it will read in cents. Against $349–$549/mo revenue, the widget AI is not a margin risk; the value of
this layer is catching the *exception* (a runaway conversation, a misconfigured brand, a voice cost
once metered) before it silently eats a month.

---

## Part 3 — the alert, and how it becomes a push

`GET /admin/health-summary` returns, for the last 24h: total messages, total cost, error count by
kind, and any install that threw **more than N** errors (default 10, `?threshold=` overridable). This
is the single endpoint to check each morning.

**It is polled today. To make it push** (out of scope here, but a small next step): a **Cloudflare Cron
Trigger** runs the same three queries on a schedule; if `errors_by_kind` or `noisy_installs` is
non-empty, it `POST`s a formatted summary to a **Slack incoming webhook** (or sends email via a
provider) with the noisy install ids and error kinds. No new data model is needed — the tables and the
query set are already here; only the scheduled sender and the webhook secret would be added. That turns
"remember to check it" into "it tells you."

---

## Privacy / safety of the trail

- `error_events.detail` is capped at 500 chars and **never** stores a visitor's message body or any
  secret. Anthropic-failure detail is the upstream error code/text; guardrail-block detail is the
  matched **banned claim** (brand-profile data), never the visitor text or the blocked model output;
  install-key detail is `path`+`origin`, **never the key itself**. All asserted in tests.
- Install-key rejections are logged only for **prefixed** keys (a real, wrong/revoked/misconfigured
  widget), so random internet scanners hitting `/w/*` with garbage do not flood the trail.

---

## Verify — every brief checkpoint, mapped to a test (`worker/syn-growth.test.mjs`)

| Requirement | Test assertion |
|---|---|
| One `usage_events` row per message, correct token counts | "usage: exactly one row per message" / "token counts captured (20/8)" |
| `cost_cents` matches token counts at constant prices | "usage: cost_cents matches … (0.006c)" |
| Per-tenant usage aggregates over a range | "tenant usage: totals / daily / date range filters" |
| Portfolio route sums across tenants | "portfolio: total across tenants / per-tenant breakdown / sum" |
| Forced Anthropic failure logs an error + no crash + no bill | "error: anthropic failure 502 / logged / no usage row" |
| Guardrail block logs an error (and still bills the call) | "error: guardrail block logged / still recorded one usage row" |
| Install-key rejection logged (garbage not logged) | "error: install-key rejection logged / garbage not logged" |
| `health-summary` 24h totals + flags a noisy install | "health: totals / errors by kind / flags the noisy install" |
| Cost ceiling: a conversation cannot exceed its maximum | "ceiling: hit 409 cap / 100 calls / summed == ceiling / ≤ ceiling" |
| Every route admin-authed + tenant-scoped | "admin-only (401 without key)" on each route; per-tenant "strictly scoped" |

**Worker unit suite: 162 checks, 0 failed** (was 121; +41 for observability). Canonical `npm test`
suite green (see the PR notes; the one pre-existing `growth-widget-ai` typing-indicator timing flake
was hardened to a race-free MutationObserver in the same change).
