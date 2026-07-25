# AUDIT-A2 — Receipt verification audit

**Scope:** the monthly Receipt (`worker/syn-growth.js`, the Receipt module ~L1442–1785, plus its
schema and the `/w/book` write path it depends on).
**Type:** AUDIT. Every headline figure was **independently recomputed from raw events with fresh code
that never calls `computeReceiptMetrics`/`generateReceipt`**, then diffed against the Receipt the Worker
actually produces. Immutability, the job-value time machine, the guarantee verdict, and double-count /
undercount behaviour were each exercised with seeded scenarios and the observed output recorded.
**Product code changed:** none. No outright arithmetic error was found (see §7). All findings are flagged
for Henry to decide, per the brief — I do **not** decide any judgment call here.
**Verdict (short):** the Receipt's *arithmetic* is sound and reproducible. It is **not yet defensible
enough** to base a money-back guarantee on, because of **one factual wording bug** and **two definitional
choices** in the guarantee itself (§8). Fix those three and it is defensible.

Harnesses used (in the session scratchpad, not committed): `a2-recompute.mjs` (independent per-figure
recompute), `a2-edges.mjs` (D2–D12), `a2-d1.mjs` (clean D1). They run against the real schema via the
same `node:sqlite` D1 shim the unit suite uses.

---

## 1. Method — independent recomputation

I wrote a second implementation of every figure (raw synchronous SQL over `events`, my own pairing
loops, my own median/avg, my own Intl after-hours test, my own job-value lookup) deliberately structured
differently from the Worker so a shared bug can't hide in both. I seeded the canonical June 2026 month,
had the Worker generate the Receipt through the real `POST /admin/tenants/:id/receipts` route, and
compared field by field.

**Result: 15 / 15 figures agree, 0 mismatches.**

| Figure | Worker | Independent | Agree |
|---|---|---|---|
| inquiries_received | 4 | 4 | ✓ |
| inquiries_answered | 3 | 3 | ✓ |
| median_response_seconds | 90 | 90 | ✓ |
| avg_response_seconds | 80 | 80 | ✓ |
| after_hours_inquiries | 2 (`ev_i3`,`ev_i4`) | 2 (same ids) | ✓ |
| followups_sent | 2 | 2 | ✓ |
| followups_replied | 1 | 1 | ✓ |
| appointments_booked | 2 | 2 | ✓ |
| missed_calls_recovered | 1 | 1 | ✓ |
| leads_captured | 5 (`con1,2,3,5,6`) | 5 (same ids) | ✓ |
| job_value_cents (period) | 25000 | 25000 | ✓ |
| value_recovered_cents | 50000 | 50000 | ✓ |
| captured_value | true | true | ✓ |

Value line as rendered: `Appointments booked (2) × average job value ($250.00, in effect from
2026-05-01) = $500.00`. Hand-check: median of [30,90,120] = 90; avg = 240/3 = 80; after-hours = the
Saturday inquiry + the Wed-22:00 inquiry; value uses the **May** job value, not the **July** $900 that
becomes effective after the period. Every number traces to the seeded rows.

---

## 2. Job-value time machine — verified correct

`jobValueInEffect` selects the latest `job_values` row with `effective_from <= period_end`, snapshotted
into `receipts.job_value_cents` at generation.

- **Future value ignored.** With $250 (eff 2026-05-01) and $900 (eff 2026-07-01), the June Receipt uses
  **$250** — the July value's `effective_from` (Jul 1) is after Jun 30, so it is excluded. ✓
- **Later/backdated value does not rewrite a past Receipt.** Adding a $999.99 value backdated to
  2026-06-10 **after** generation and regenerating leaves the stored Receipt at **$250** (dedup returns
  the snapshot; see §3). ✓

**Flag 2A (judgment call, not an error):** when the job value **changes mid-period**, the Receipt applies
the **single latest-in-period value to every booking in the month**, not the value in effect on each
booking's date. Observed (D5): $200 eff Jun 1, $600 eff Jun 20, bookings on Jun 5 and Jun 25 →
`value_recovered = 2 × $600 = $1,200`. A per-booking-date reading would be $200 + $600 = **$800**. This
matches `RECEIPT.md` ("latest whose `effective_from` is on/before the period end"), so it is a documented
choice, not a bug — but it can **overstate** (or understate) recovered value in any month the client
changes their average job value. Henry decides: keep whole-period-latest, or value each booking at the
rate in effect on its own date.

---

## 3. Immutability — verified

Proven with observed output (D9):

- Second and third generate calls for the same period **dedup** (`deduped: true`), and the `receipts`
  table holds exactly **1** row for the period.
- The stored `metrics` JSON + `job_value_cents` are **byte-stable** across regeneration (`snap1 === snap2`).
- After inserting a **late in-period event** (an inquiry dated inside the closed period but written after
  generation) **and** a backdated higher job value, regeneration is still byte-identical
  (`snap1 === snap3`): `inquiries_received` stays 4, `job_value_cents` stays 25000, and the drill-down
  (which reads only the snapshotted event IDs) never surfaces the late row.

Immutability holds because `generateReceipt` returns the existing row **before** recomputing, and the
drill-down is keyed to snapshotted IDs. This is the property a dispute relies on, and it is solid.

**One narrow caveat (not a defect):** immutability is enforced by the unique index on
`(tenant_id, period_start, period_end)` **plus** the "return existing first" check. A Receipt generated
for a *custom* `period_start/period_end` that differs by even a millisecond from the canonical month
bounds would be a **different** row (a second Receipt for an overlapping window). The admin route accepts
arbitrary bounds, so two overlapping Receipts for the same calendar month are possible if someone passes
`{period_start,period_end}` that doesn't exactly match `{month}`. The monthly cron always uses canonical
bounds, so this only arises from manual custom-period calls. Flag for awareness; no change recommended.

---

## 4. Per-figure notes (all arithmetic confirmed)

- **Period query** is inclusive on both bounds (`created_at >= start AND created_at <= end`), start
  `…T00:00:00.000Z`, end `…T23:59:59.999Z`. D11 confirms an event at exactly the start ms and exactly the
  end ms are **in**, and `2026-05-31T23:59:59.999Z` is **out**. Correct. (Relies on all timestamps being
  `…Z` ISO strings so lexical compare = chronological; every insert path uses `nowIso()`/`normBound`,
  which guarantee that.)
- **inquiries_answered** pairs each `inquiry_received` to the first `first_response_sent` in the same
  `conversation_id`, counting the gap only when `secs >= 0`. D12 confirms a response timestamped *before*
  its inquiry (clock skew) is correctly dropped.
- **median/avg** — `medianOf` averages the two middle values on an even count and rounds; `avgOf` rounds
  the mean. Both verified against hand values.
- **after_hours** uses a half-open window `hour >= start && hour < end` in the tenant timezone via `Intl`
  (DST-correct). Note the boundary: an inquiry at exactly **17:00** counts as after-hours (business
  "closes at 17:00"), and one at exactly **09:00** counts as in-hours. Defensible; noted so it isn't a
  surprise.

---

## 5. Double-counting — findings

| # | Scenario | Observed | Reachable in production? | Severity |
|---|---|---|---|---|
| D1 | Two `inquiry_received` share one `conversation_id`, one response after both | `answered = 2`, the one response is referenced **twice** in `event_ids`, both gaps counted in the speed sample | **No.** `inquiry_received` is written `INSERT OR IGNORE` with unique key `inq_<convId>`, and `first_response_sent` with `frs_<convId>` — one each per conversation. Only a raw admin/DB insert could create this. | Low / theoretical |
| D4 | Two `call_missed` to one contact, one `textback_sent` | `missed_calls_recovered = 2` from a single textback (both pair to the same textback) | **Not yet.** No code path emits `call_missed`/`textback_sent` — SMS hasn't shipped. Becomes reachable when it does. | Deferred — **fix before SMS ships** |
| **D10** | **Two `appointment_booked` with no `conversation_id` (direct booking), same contact** | **`appointments_booked = 2`, `value_recovered` doubles ($600 = 2 × $300)** | **Yes.** `wBook` sets `idempotency_key: convId ? "apt_"+convId : null`. A booking posted to `/w/book` **without** a `conversation_id` gets a **null** key → `insertEvent` takes the plain-INSERT branch → **no dedupe**. Two such posts both land. | **Medium — real, and it inflates the headline dollar** |

**On D10:** this is the one double-count that is both reachable today and touches the guarantee-facing
dollar figure. It is **not a Receipt arithmetic error** — the Receipt correctly counts the events it is
given — so it is out of scope for "fix only arithmetic errors," and the fix lives in `wBook` (booking
code), not the Receipt module. But it is the thing most likely to produce a Receipt a client can dispute
("you charged me for two bookings that were one"). Flag: decide whether direct (no-conversation) bookings
should carry a dedupe key (e.g. derive one from contact + a coarse time bucket, or require a
conversation/booking id).

**On D1/D4:** the Receipt's answered/recovered pairing has no defence of its own against duplicate source
events — it trusts upstream idempotency. Today that trust is justified for `inquiry_received` /
`first_response_sent` (unique keys) but **not** for `appointment_booked` without a conversation (D10), and
**not** for `call_missed`/`textback_sent` once those start being written. Flag as a standing invariant to
keep: *every* event type the Receipt counts must be idempotent at its write site.

---

## 6. Undercounting — findings

- **D2 (boundary undercount, conservative).** An inquiry received at `2026-06-30T23:59:00Z` whose
  `first_response_sent` lands at `2026-07-01T00:01:00Z` (2 minutes later, across the month boundary) is
  counted as **received but unanswered** in June: the response is outside the period window, so the pair
  never forms. Observed: `inquiries_received = 1, inquiries_answered = 0`. This **understates** answered
  and drops that fast response from the speed sample. It only bites inquiries near midnight on the last
  day, and it errs *against* the client's good numbers (safe direction for a guarantee), so it is low
  severity — but it is a real inaccuracy. Flag; no fix recommended unless Henry wants boundary-straddling
  pairs pulled in.
- **leads counted, not under-counted:** `leads_captured` is distinct non-null `contact_id` across **all**
  events in the period — see §8 for the opposite concern (it counts *too many*, not too few).

---

## 7. Arithmetic errors found: NONE

Across §1–§6 every figure the Receipt computes matches an independent recomputation, boundary handling is
correct, median/avg/rounding are correct, the negative-gap guard is correct, the time machine is correct,
and immutability holds byte-for-byte. **There is no outright arithmetic error to fix, so I changed no
product code.** The issues that remain (§5 D10, §8) are **definitional and wording** choices, plus one
booking-side idempotency gap — none of them a miscalculation inside the Receipt.

---

## 8. The guarantee verdict — judgment calls to decide (I do not decide these)

The verdict hinges on one boolean: `captured_value = (distinct leads > 0) OR (appointments_booked > 0)`.
The dollar `value_recovered` is a **separate, explicitly "Estimated"** marketing figure and is *not* what
the free-month decision reads — good separation. But three things need Henry's ruling before this backs a
money-back promise:

**8A — TOP ISSUE: the verdict claims the first-month guarantee on *every* zero-value month.**
The string is unconditional:
`"No value captured this period — the first-month guarantee applies and this month is free."`
There is **no month-index / first-month awareness anywhere** in the Worker (grep confirms this is the
only occurrence, with no `created_at`/subscription/first-month gate). The monthly cron generates a
Receipt for **every** active tenant **every** month. So a client in month 5 with a slow month receives a
Receipt that literally states *"the first-month guarantee applies and this month is free"* — a **factual
misstatement** if the guarantee is first-month-only (which `SYNTREX_PRICING_CANONICAL.md` and
`RECEIPT.md` say it is). This is the single biggest defensibility problem: the Receipt over-promises free
months it isn't offering. **Decide:** either (a) scope the free-month language to the client's actual
first billing month (requires the Receipt to know which month is first — a field it does not have today),
or (b) change the wording so a zero-value month in month N doesn't assert a guarantee that doesn't apply.

**8B — what counts as a "captured lead."** `leads_captured` = any distinct `contact_id` on **any** event
in the period, and any one of them flips the verdict to "Value captured." Consequences observed:
- **D3:** a contact whose *only* activity this period is a `followup_sent` (they were captured in a prior
  month) counts as a captured lead **and** makes the month "value captured." For months 2+, "leads
  captured this period" therefore over-counts — it means "contacts with any activity," not "contacts
  first obtained this period." (Month 1 is unaffected — no prior contacts exist.)
- **D7:** a single inquiry that left one contact and went nowhere (no booking, no reply) →
  "Value captured this period," guarantee not invoked. **Is one captured email enough to deny a
  money-back month?** That is the guarantee's whole threshold, and it's currently "≥ 1 contact." Decide.

**8C — active service with no contact = a free month.** **D8:** three inquiries answered in ~20 seconds
each, but none left a contact → `captured_value = false` → "No value captured … this month is free."
Honest per the definition (chats with no contact don't count), and it errs in the client's favour, but it
means a month where the assistant demonstrably worked can still be free. Confirm this is the intended
generosity.

**8D — booking present, job value unset.** **D6:** one booking, no `job_values` row → verdict
"Value captured this period" while the value line reads "Not yet configured / no dollar figure is
claimed." Correct (a booking is captured value regardless of dollar), but confirm the pairing of
"Value captured" with "$ not configured" reads right to a client.

**8E — `value_recovered` counts *booked*, not *kept*.** The dollar figure is `bookings × job value` with
no notion of cancellation, no-show, or completion (there is no `appointment_completed`/`cancelled`
event). A booked-then-cancelled appointment still adds its full job value. The word "Estimated" and the
plain-language formula mitigate this, and it doesn't affect the free-month boolean, but it can overstate
the headline dollar. Flag.

---

## 9. Plain verdict

**Is the Receipt defensible enough to base a money-back guarantee on? — Not yet. Three things must change
first:**

1. **Fix the month-agnostic guarantee wording (8A).** The Receipt asserts the first-month free guarantee
   on every zero-value month, in every month, for every tenant. Either scope it to the real first month
   (the Receipt needs to *know* the client's first billing month — it doesn't today) or reword it so it
   stops promising a free month it isn't offering. This is a factual misstatement in client-facing text
   and is the most likely thing to blow up in a dispute.
2. **Rule on the "captured value" threshold (8B / 8C / 8D).** Decide whether one captured contact — or a
   prior-month contact who merely got a follow-up — should count as "value captured," and whether an
   active-but-no-contact month should be free. The math is correct; the *definition* is a business call
   that has to be settled and then stated on the Receipt exactly as it will be enforced.
3. **Close the direct-booking double-count (D10) before it reaches a Receipt.** A `/w/book` call with no
   `conversation_id` writes a non-idempotent `appointment_booked`; two of them double the booking count
   and the recovered-value dollar. It's a `wBook` idempotency gap, not a Receipt bug, but it feeds the
   Receipt. Also give `call_missed`/`textback_sent` idempotency keys before SMS ships (D4).

Everything else is solid: independent recomputation matches to the number, the job-value time machine
uses the period's value and cannot be rewritten retroactively, immutability is byte-stable against late
and backdated events, boundaries are inclusive and correct, and the "Estimated value recovered" figure is
honestly separated from the guarantee boolean. **The engine is right; the guarantee's wording and
definition are what need Henry's decision before it can carry money.**
