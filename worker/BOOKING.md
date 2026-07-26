# syn-growth — Booking in the widget

The widget answers inquiries and captures leads. Booking is the other half of "answer every inquiry and
convert the lead": it lets a visitor turn a conversation into an appointment without leaving the chat. A
booking is an append-only **`appointment_booked`** event with the contact linked — the same event the
Receipt and the value guarantee count.

Booking is **provider-backed**, not a calendar built from scratch. The client keeps using whatever
scheduler they already have (Cal.com, Calendly, Acuity, …); the widget surfaces it and records the
outcome.

> **⚠️ FINANCIAL CONTROL — bookings are deterministic, never generated (see `GUARANTEE.md`).** An
> `appointment_booked` row is written by **one path only** (`wBook` → `POST /w/book`), and only after the
> slot is **validated**: it must parse, be in the **future**, fall **inside business hours**, and **not be
> taken**. Any failure → **no booking row**; a non-counted **`booking_requested`** is recorded and the
> customer is told *"someone will confirm your time shortly"* — never a fake confirmed time. The generic
> `POST /w/events` endpoint **rejects** `appointment_booked`/`booking_requested`, so the AI can't forge a
> booking by emitting text. Every booking payload carries **`source`** (`syn` counts toward the Receipt;
> `owner`/`import` do not). Live calendar-provider availability is a documented follow-up; "not taken" is
> currently enforced against SYN's own records.

---

## 1. Two modes (set per install in `config.booking`)

Booking is armed **only** when the install config carries a valid **https** scheduling URL. Without one,
booking is silently off — no button, no BOOKING section in the system prompt, `offer_booking` never fires.

```json
{ "booking": {
    "enabled": true,                         // optional; set false to pause booking for this install
    "url": "https://cal.com/acme-co/intro",  // REQUIRED, must be https (the client's own scheduler)
    "mode": "link"                           // "link" (default) or "embed"
} }
```

### LINK mode — **fully implemented, ships first**
The default. The widget shows a persistent, low-key **"Book a time"** button and opens the client's
scheduler in a new tab. On return, an inline card asks the visitor to confirm they booked (and optionally
leave an email/phone so we can link the record). Confirmation posts to `POST /w/book`. This works for
**every client on day one** with zero calendar integration — Cal.com, Calendly, or anything else.

### EMBED mode — **implemented as a clean inline iframe; auto-detection is the follow-up**
When `mode: "embed"`, the same card renders the scheduler **inline in the panel** via a sandboxed
`<iframe>` (`sandbox="allow-scripts allow-same-origin allow-forms allow-popups"`), so the visitor never
leaves the widget. It is a plain iframe of the scheduling URL — **not** Cal.com's `embed.js` — which is
why it is clean inside our closed shadow root: nothing injects into the host page or fights the isolation.

What embed does **not** do yet: **automatic booking detection**. Reading a completed booking out of a
cross-origin iframe requires provider-specific `postMessage` handling (Cal.com and Calendly each emit
different events), which is brittle and per-provider. So embed mode still uses the same explicit "I booked
a time" confirmation as link mode. Wiring provider `postMessage` → auto-confirm is a small, well-scoped
follow-up (see below); it is deliberately not forced here.

**Cost/complexity of the remaining embed work:** low-to-moderate and provider-specific. Each scheduler
needs a tiny origin-checked `message` listener mapping its "booking successful" event to a `/w/book` call
(≈20–40 lines per provider, plus an allowlist of the provider's origin). No new tables, no new endpoints,
no schema change — it reuses `POST /w/book` exactly as link mode does.

---

## 2. The booking moment

Booking surfaces two ways:

- **Directly, always.** Whenever a scheduler is configured, the persistent **"Book a time"** button sits
  in the panel. A visitor who already knows they want to book taps it without negotiating a conversation.
- **Conversationally, when it's the right move.** The system prompt gains a **BOOKING** section (only when
  booking is armed) telling the model to invite booking when the visitor asks for an appointment, a quote,
  an estimate, a callback, or a time — or when the brand's escalation rules call for it. The model still
  only produces text; the server sets **`offer_booking: true`** on the `/w/messages` response (on visitor
  booking-intent or a booking-invite in the reply), and the widget renders the booking card. When booking
  is offered, the capture form is suppressed so the visitor sees one clear action, not two.

The model is explicitly told **not** to invent, promise, or confirm specific times — the scheduler owns
real availability.

---

## 3. Capture, consent, and follow-ups on booking (`POST /w/book`)

A booking is a strong signal and usually comes with contact details. On `POST /w/book` the worker:

1. **Captures/confirms the contact** via the existing dedupe path (`upsertContact`) when email/phone/name
   are supplied — the same one-record-per-person logic as chat capture and the form.
2. **Links** the contact to the conversation and backfills its events (`attachContact`), or falls back to
   the conversation's already-known contact.
3. **Writes `appointment_booked`** with the contact linked and any known time (`payload.when`),
   **idempotent per conversation** (`idempotency_key = "apt_<conversation_id>"`) so a double-confirm counts
   once — the Receipt must not double-count.
4. **Cancels pending follow-ups** for that contact (`cancelFollowups`, reason `booked`) — booking is
   engagement, wired into the same cancellation path as a reply / opt-out.

**Consent is untouched by booking.** The contact is upserted with `consent_sms = 0` and **no
`consent_event` is written** — booking through the client's own scheduler does not by itself grant SMS
(or email) consent. Prompt 17's consent rules stand exactly as they were; the SMS opt-in still comes only
from the explicit, ticked capture form.

Everything is **tenant-scoped**: the contact, the event, and the follow-up cancellation all resolve
through the install's own tenant.

---

## 4. What the client sees — `GET /admin/tenants/:id/bookings`

Admin-authed, tenant-scoped. Lists `appointment_booked` events for one tenant, newest first, filterable
by `?from=` / `?to=` (inclusive; a date-only bound expands to the whole day). Each row carries the linked
contact (`name`, `email`, `phone`, `contact_status`), when it was booked (`booked_at`), and any known
appointment time (`when`). `count` is the true total over the range, independent of the row `limit`.

```sh
SYN_GROWTH=https://syn-growth.<sub>.workers.dev
curl -fsS -H "Authorization: Bearer $GROWTH_ADMIN_KEY" \
  "$SYN_GROWTH/admin/tenants/<TENANT_ID>/bookings?from=2026-08-01&to=2026-08-31"
```

This is the per-tenant, per-date-range query the **Receipt** reads to count booked appointments.

---

## 5. Verify (unit-tested in `worker/syn-growth.test.mjs`)

- Link mode surfaces the scheduler and, on confirmation, writes `appointment_booked` with the contact linked.
- The direct "Book a time" affordance works with **zero** conversation.
- Booking **cancels** the contact's pending follow-ups.
- Booking **captures/links** the contact via dedupe (no duplicate record).
- `appointment_booked` is **queryable per tenant and date range** for the Receipt, and tenant-scoped.
- Consent is **unchanged** by booking (`consent_sms = 0`, no `consent_event`).
- Double-confirm in one conversation is **idempotent** (exactly one event).

**Mode status:** LINK mode is **fully live**. EMBED mode renders the scheduler inline (clean, shadow-safe
iframe) and shares link mode's confirmation path; provider `postMessage` auto-detection is the noted
follow-up.
