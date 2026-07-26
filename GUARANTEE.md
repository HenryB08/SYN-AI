# The SYN Growth guarantee — single source of truth

This document defines exactly what the money-back guarantee pays out on. It is the authority; if any UI,
email, or code comment disagrees with it, this file wins. It is a **financial control**: SYN is liable for
the number, so every figure here is deterministic and reconstructable from raw events.

## The number

**Recovered value = bookings produced by SYN × the client-confirmed job value agreed at install.**

- **Never closed cash.** We do not count revenue actually collected — only bookings the system produced,
  valued at the client's own agreed job value.
- **Never industry averages.** The job value is the figure the client confirmed at install for *their*
  business. We never substitute a category/industry estimate.
- **The free-month rule:** if the recovered (booked) value in a period is **under the monthly fee**, that
  month is **free**.

The word **"estimated"** stays in all legal and guarantee wording — the recovered figure is an estimate of
value from bookings, not a claim of collected revenue.

## Mechanics

1. **Only system-produced bookings count.** Every `appointment_booked` row records a `source` in its
   payload. Only **`source = "syn"`** — a booking created by SYN's deterministic booking path and
   slot-validated — counts toward recovered value. `owner` (the owner handled the call personally) and
   `import` (migrated) are recorded but **excluded**, so nothing the owner did by hand inflates the number.
   The Receipt (`computeReceiptMetrics`) filters to `source === "syn"`.

2. **Bookings are deterministic, never generated.** A booking is written by **one code path only**
   (`wBook` → `POST /w/book`). Before any write it validates the slot: it must **parse**, be in the
   **future**, fall **inside configured business hours** (tenant timezone), and **not already be taken**
   (no existing system booking at that start). Any failure → **no `appointment_booked` row**; instead a
   non-counted `booking_requested` is recorded and the customer is told *"someone will confirm your time
   shortly"* — never a confirmed time that does not exist. The AI cannot create a booking by emitting text:
   the generic `POST /w/events` endpoint **rejects** `appointment_booked`/`booking_requested`.
   > *Known gap:* "exists in the connected calendar" is enforced today as "not double-booked against SYN's
   > own records." A live calendar-provider availability check requires the provider integration, which is
   > not built yet. Until it is, a self-asserted external booking with no valid slot is `booking_requested`
   > (pending), not a counted booking — the conservative, guarantee-safe default.

3. **Value is recognized at booking.** The dollar value is fixed when the booking is created.
   **Cancellations are not retroactively removed** from a period's number. Because a booking count can
   therefore diverge from eventual outcomes, the dashboard and the Receipt must **always display the
   booking count next to the dollar figure** — the count is the honest denominator behind the estimate.

4. **Client-confirmed job value is timestamped and versioned, locked for the period.** The job value lives
   in an append-only `job_values` ledger (`effective_from` + `created_at`, never updated in place). A
   Receipt uses the value in effect **during** its period. Changing the job value applies to the **next**
   period only — it can never retroactively move a past period's number.

5. **The immutable monthly Receipt snapshot is the payout document.** Generation snapshots the metrics, the
   per-figure event IDs, and the period's job value into the `receipts` row; it never changes afterward
   (proven in the test suite). **The guarantee pays out on that snapshot.** The live dashboard is
   **informational** — a real-time view that may still move; the Receipt is the record of account.

6. **`guarantee_mode` is a per-client field:** `booked_value | binary`.
   - **`booked_value`** (default): the number above — recovered value vs the monthly fee.
   - **`binary`**: for clients who cannot assign a booking value at install. The guarantee is pass/fail on
     whether SYN produced captured value at all (a booking or a captured lead), with no dollar figure.
   Stored on `tenants.guarantee_mode`.

## Attribution field (summary)

| Field | Where | Allowed values | Counts toward recovered value? |
|---|---|---|---|
| `source` | `appointment_booked` event payload | `syn` | **Yes** |
| | | `owner` | No (owner handled it personally) |
| | | `import` | No (migrated) |
| `guarantee_mode` | `tenants` row | `booked_value` (default) | value vs fee |
| | | `binary` | pass/fail, no dollar |

## Wording rule

Every legal and guarantee-facing surface keeps the word **"estimated"** on the recovered-value figure, and
shows the **booking count beside the dollar amount**. Recovered value is an estimate from bookings — not
collected cash, not an industry average.
