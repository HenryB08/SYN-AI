# syn-growth — The Receipt (monthly proof of value)

The Receipt is the monthly statement that makes the Growth guarantee real: **"no captured value in your
first month, that month is free."** Everything the engine records — inquiries, responses, follow-ups,
bookings — has been writing append-only `events` for exactly this moment. The Receipt turns those events
into a defensible statement where **every headline number is reconstructable by hand from the raw event
rows.** Because a client can dispute a Receipt and invoke the guarantee, this is the most trust-critical
surface in the product, and it is built so a dispute is settled by **inspection, not argument.**

---

## 1. What it counts (all from `events`, tenant-scoped, over a period)

Default period is a **calendar month**. For a tenant over `[period_start, period_end]`:

| Figure | Computed from |
|---|---|
| **Inquiries received** | count of `inquiry_received` |
| **Inquiries answered** (+ speed) | each `inquiry_received` matched to a `first_response_sent` in the **same conversation**; response time = the gap between the two timestamps (median + average reported) |
| **After-hours inquiries caught** | `inquiry_received` whose time falls **outside business hours** (Mon–Fri 09:00–17:00 in the tenant's timezone by default) — the ones a human would have missed |
| **Follow-ups sent** | count of `followup_sent` |
| **Follow-ups that got a reply** | count of `followup_replied` |
| **Appointments booked** | count of `appointment_booked` |
| **Missed calls recovered** | `call_missed` paired with a `textback_sent` to the same conversation/contact (active once SMS ships) |
| **Captured leads** | distinct contacts (by `contact_id`) attached to any event in the period |
| **Estimated value recovered** | `appointments_booked × job value in effect during the period` |

**The value formula is stated on the Receipt in plain language**, e.g.
`Appointments booked (2) × average job value ($250.00, in effect from 2026-05-01) = $500.00`.
**If the job value is unset, the Receipt shows the captured activity and marks value "not yet
configured" — it never fabricates a dollar figure.**

**Business hours** come from the tenant's timezone (`tenants.timezone`, default UTC) plus an optional
per-install `config.business_hours = { "days":[1,2,3,4,5], "start":9, "end":17 }` (weekday numbers,
0=Sun … 6=Sat). Absent that, Mon–Fri 09:00–17:00.

## 2. Defensibility — why the numbers hold up

- **Every figure carries its evidence.** Generation snapshots the **exact event IDs** behind each number
  into the receipt. The drill-down (`GET …/receipts/:id/events`) returns precisely those rows, grouped
  by figure — so a disputed number is checked against the very events that produced it.
- **The period's job value, not the current one.** The value used is the latest `job_values` row whose
  `effective_from` is on/before the period end — looked up at generation and **snapshotted** into
  `receipts.job_value_cents`. A client cannot move it retroactively, and a value set later does not
  apply to a past period.
- **Immutable once generated.** Generation writes the numbers, the per-figure event IDs, and the job
  value into the `receipts` row. **Re-querying events later never changes a past Receipt** — the
  drill-down uses the snapshotted IDs, so an event that lands after generation simply is not on that
  Receipt. Proven in `worker/syn-growth.test.mjs` (a later event and a backdated higher job value both
  leave the past Receipt unchanged).
- **No black-box numbers.** The Receipt states its own period, generation date, and the plain-language
  method for each figure.

## 3. The guarantee verdict

**Captured value** is defined honestly against the canonical offer: **at least one captured lead (a
contact we obtained) OR at least one booked appointment in the period.** A **captured lead counts as
value on its own** — no booking is required. Anonymous chats that leave no contact do **not** count. The
Receipt states the verdict plainly and names what counted — *"Value captured this period — 5 captured
leads and 2 bookings."* (or *"— 1 captured lead."* when a single lead is the only value) or *"No value
captured this period — the first-month guarantee applies and this month is free."* The verdict is
computed, not curated; a Receipt that fudged toward "captured" to dodge a free month would destroy the
guarantee's credibility, so it does not.

## 4. Generation & delivery

- **Generate (idempotent):** `POST /admin/tenants/:id/receipts` with `{ "month":"YYYY-MM" }` or
  `{ "period_start", "period_end" }` (defaults to the prior calendar month). A **unique index on
  `(tenant_id, period_start, period_end)`** makes a second generate return the existing row — no
  duplicate, no drift.
- **Monthly cron (separate from the follow-up cron):** on **`0 8 1 * *`** (08:00 UTC on the 1st) the
  `scheduled()` handler generates the **prior month's** Receipt for every **active** tenant. The
  follow-up cron (`*/15 * * * *`) is unaffected — the handler branches on `event.cron`.
- **Auditable:** each generation writes a **`receipt_generated`** event (idempotent per period).
- **Render + deliver:** `GET …/receipts/:id?format=html` renders a clean, email-ready HTML statement
  (also for the client dashboard, Prompt 27). `POST …/receipts/:id/send` emails it from the **client's
  own sending identity** (same `followupIdentity` pattern as follow-ups — never `syntrexio.com`), to the
  client's inbox (`config.receipt_to` or `config.reply_to`), via Resend.

## 5. What the client and you see

```
POST /admin/tenants/:id/receipts              → generate (idempotent) for a period
GET  /admin/tenants/:id/receipts              → list a tenant's Receipts, newest first (+ compact summary)
GET  /admin/tenants/:id/receipts/:rid         → one Receipt (JSON), or ?format=html for the statement
GET  /admin/tenants/:id/receipts/:rid/events  → drill-down: the exact event rows behind each figure
POST /admin/tenants/:id/receipts/:rid/send    → email it from the client's identity
```
All strictly tenant-scoped (a receipt is only readable under its own tenant id). The numbers are stored
as JSON on the `receipts` row, ready for the eventual client dashboard.

## Cron setup (two triggers)

In the dashboard (Workers & Pages → `syn-growth` → Triggers → Cron), or `wrangler.syn-growth.toml`:
```toml
[triggers]
crons = ["*/15 * * * *", "0 8 1 * *"]   # follow-ups every 15 min · Receipts on the 1st at 08:00 UTC
```

## Worked example (hand-verifiable)

Seed June 2026 (tz UTC, business hours Mon–Fri 09:00–17:00, job value $250 effective 2026-05-01):
4 `inquiry_received` (Wed 10:00, Wed 11:00, Sat 12:00, Wed 22:00) · 3 `first_response_sent` (+30s, +90s,
+120s) · 2 `followup_sent` · 1 `followup_replied` · 2 `appointment_booked` · 1 `call_missed` + 1
`textback_sent`. The Receipt reads:

- Inquiries received **4** · answered **3** (median **90s**, avg **80s**) · after-hours **2** (the Sat
  and the Wed-22:00) · follow-ups sent **2**, replied **1** · appointments booked **2** · missed calls
  recovered **1** · captured leads **5**.
- Value recovered: **`Appointments booked (2) × average job value ($250.00, in effect from 2026-05-01)
  = $500.00`**.
- Verdict: **Value captured this period — 5 captured leads and 2 bookings.**

Every figure's `event_ids` point back to exactly those seeded rows; the drill-down returns them. See the
test suite for the full assertion set.
