# syn-growth — Compliance & consent mechanism

This documents the compliance **mechanism** built into the Growth Engine widget and Worker: a
privacy notice, a durable consent audit trail, opt-out handling, and data-rights routes. It is the
technical precondition for putting the widget on a paying client's public website.

> **Not legal advice.** I am not a lawyer and neither is whoever generated this. This builds the
> mechanism for compliance; it does not establish that the mechanism is legally sufficient for any
> jurisdiction, industry, or use case. **Everything here must go to a lawyer before launch.** The
> sections marked **⚠️ FLAG** are places where a legal requirement was *guessed at* rather than a
> clear technical fact implemented — those especially need review.

---

## What was built

| Area | Where |
|---|---|
| Privacy notice in the widget (persistent line + at-capture disclosure + policy link) | `worker/widget.js` |
| Live per-brand privacy page (`GET /w/privacy`) — names Syntrex processor, client controller | `wPrivacy` |
| Privacy policy template (fill-in) | `worker/legal/PRIVACY-POLICY-TEMPLATE.md` |
| `consent_events` append-only audit table | `ensureTables` |
| Consent write on grant (form) with exact `text_shown`, ip, user_agent | `wCapture` → `writeConsentEvent` |
| SMS STOP/UNSUBSCRIBE/QUIT opt-out | `processInboundSms` (+ `POST /admin/tenants/:id/sms-inbound` stand-in) |
| No-login email unsubscribe token | `ensureUnsubToken`, `GET /w/unsubscribe` |
| Manual admin withdrawal | `POST /admin/tenants/:id/contacts/:id/withdraw` |
| "Never re-queue a withdrawn channel" guard | `canQueueChannel` |
| Data-access export | `GET /admin/tenants/:id/contacts/:id/export` |
| Erasure (delete + anonymize) | `POST /admin/tenants/:id/contacts/:id/delete` |
| Client-agreement data-processing clause | `worker/legal/DATA-PROCESSING-CLAUSE.md` |

Everything is **tenant-scoped**: every admin route filters by `tenant_id`, so one tenant can never
read or write another's contacts, consent records, or data.

---

## Consent as a durable record

`consent_sms` on the contact is the live flag the sender checks. It is **not** the audit trail.
Every consent change also appends an immutable `consent_events` row:

```
id, tenant_id, contact_id, channel (sms|email), action (granted|withdrawn),
source (form|reply_stop|admin|unsubscribe_link), text_shown, ip, user_agent, created_at
```

`text_shown` is the **exact language the visitor saw**, sent by the widget (`consent_text` /
`disclosure_text`) so we can prove *what* they agreed to, not merely that a boolean was true. Same
immutability principle as `job_values` and `events` — rows are only ever inserted.

---

## Erasure: what is deleted vs. anonymized-but-kept

`POST /admin/tenants/:id/contacts/:id/delete` resolves the tension between an erasure request and the
obligations to keep (a) accurate metrics and (b) proof of consent.

**Hard-deleted (identifiable data):**
- the `contacts` row (name, email, phone, unsub token, meta),
- the contact's `conversations`,
- the `messages` in those conversations (free-text the visitor typed).

**Kept, anonymized:**
- `events` — rows retained so the **Receipt's counts don't change**; `payload` is nulled (a
  `guardrail_blocked` payload can contain what the visitor typed). `contact_id` is left as an
  **opaque token** — the `contacts` row it pointed to is gone, so it is no longer linkable to a
  person, but it keeps per-person event counts coherent.
- `consent_events` — rows retained as **proof consent was given and withdrawn**; `text_shown`,
  `action`, `channel`, `created_at` kept (the proof); `ip` and `user_agent` nulled (the personal
  identifiers).

The delete response reports the exact counts under `deleted` and `anonymized_kept`.

> **⚠️ FLAG (erasure vs. retention).** Keeping `consent_events` (including `text_shown`) after an
> erasure request is a deliberate choice: proof-of-consent and proof-of-opt-out are commonly retained
> under a legal-obligation / legitimate-interest basis even after erasure of the underlying contact.
> Whether that basis holds, and how long these records may be retained, is **jurisdiction-specific and
> must be confirmed by a lawyer.** The same applies to keeping anonymized `events`.

---

## Legal judgments flagged for review

- **⚠️ FLAG — email follow-up consent basis.** A form submission that includes an email writes a
  `granted / email` consent row (`source: form`). Treating "filled a contact form that says we'll
  follow up" as consent for email follow-up is a **judgment**, not a settled fact — the
  transactional-vs-marketing distinction, and whether a separate email opt-in is required, is
  jurisdiction- and content-dependent. **Detection-captured emails** (typed in chat, no form) write
  **no** email-consent row at all — the client would be relying on a transactional / legitimate-
  interest basis to email them, which a lawyer must confirm.
- **⚠️ FLAG — SMS consent language.** The default consent sentence ("follow-up messages, including
  texts … message and data rates may apply") is a reasonable A2P-style opt-in, but **CTIA / carrier /
  TCPA requirements for SMS consent wording, and the A2P campaign registration, are not something this
  code can guarantee.** The client's actual campaign terms must match what the checkbox says.
- **⚠️ FLAG — `unsubscribe_link` source.** The brief listed consent sources as
  `form | reply_stop | admin`. The no-login email unsubscribe needed its own source, so the enum was
  **extended** with `unsubscribe_link`. Noted so it isn't mistaken for a defined-set violation.
- **⚠️ FLAG — IP address as personal data.** We record an approximate IP with each consent action as
  audit evidence. IP is itself personal data in some regimes; retaining it needs a basis, and it is
  nulled on erasure. Confirm the retention basis.
- **⚠️ FLAG — the privacy page is a template.** `GET /w/privacy` renders a **template** with visible
  `[MANDATORY: …]` placeholders (controller legal name, privacy contact email, governing law) pulled
  from the install `config` when present. It is **not** a lawyer-drafted, jurisdiction-specific policy.
  A client must not go live with placeholders unfilled, and the finished text needs legal review.
- **⚠️ FLAG — processor disclosure in the widget UI.** The in-widget disclosure names only the client
  ("we"), not Syntrex, to honor the "the widget is the client's, not SYN-branded" rule. Syntrex (the
  processor) is disclosed on the linked privacy **page**, not in the widget chrome. Whether processor
  disclosure must be more prominent is a legal question.

---

## What the sender (a later prompt) must honor

`canQueueChannel(env, contactId, channel)` is the gate. **The follow-up sender must call it before
queuing to any channel** and skip the send if it returns false:
- `sms` → returns the live `consent_sms` flag (STOP / admin-withdraw both clear it).
- `email` → false if the latest `email` consent_event is `withdrawn`; otherwise true.

Once withdrawn, a channel is never queued again. This guard exists now, before the sender does.

## STOP handling — where the trigger lives

`processInboundSms` is the reusable mechanism (STOP / UNSUBSCRIBE / QUIT, case-insensitive, whole
message → clear `consent_sms`, write a `withdrawn / reply_stop` row). For now it is invoked via the
admin route `POST /admin/tenants/:id/sms-inbound` as a stand-in. **The SMS prompt will replace that
trigger with the real provider webhook** (with the provider's signature verification); the withdrawal
logic and the audit row do not change.
