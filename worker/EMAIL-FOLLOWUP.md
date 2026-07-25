# syn-growth — Follow-up email sequencer

When the widget captures a lead and the conversation goes quiet, a short sequence of **brand-voiced**
follow-up emails goes out — a few hours after capture, the next day, a few days later — and **stops the
moment the lead engages** (replies, books, unsubscribes, or is marked closed/lost). This is the "nothing
goes cold" piece of the Growth System.

Sends go through **Resend**. Consent, opt-out, and the tokenized unsubscribe link come from the existing
consent layer; this document covers the two things **you** set up on the domain and in the dashboard.

---

## 1. Sending identity — DO THIS ON THE DOMAIN BEFORE GO-LIVE

**Email must send from a VERIFIED, dedicated sending domain — never from `syntrexio.com`.** One client's
cold list bouncing must never damage the deliverability of the primary domain or every other client's
mail. The code **hard-refuses** any `from_email` on `syntrexio.com` (or a subdomain of it) and will not
send until a verified sender is configured.

Use a **subdomain dedicated to sending** — either the client's own (e.g. `mail.clientdomain.com`) or a
Syntrex-operated sending domain that is **not** the primary (e.g. `mail.syntrexsend.com`). Reputation
lives on that subdomain, isolated from everything else.

### Steps
1. In the **Resend dashboard → Domains → Add Domain**, add the sending subdomain.
2. Resend shows the exact DNS records to add. Add them at the domain's DNS host, then click **Verify**.
   The records are (values come from Resend — copy them exactly):

   | Type | Host (example) | Value | Purpose |
   |---|---|---|---|
   | **MX** | `send.clientdomain.com` | `feedback-smtp.<region>.amazonses.com` (priority 10) | bounce/complaint feedback (Resend runs on SES) |
   | **TXT (SPF)** | `send.clientdomain.com` | `v=spf1 include:amazonses.com ~all` | authorizes the sender |
   | **TXT/CNAME (DKIM)** | `resend._domainkey.clientdomain.com` (Resend gives the exact host + value) | *(from Resend)* | signs every message so it can't be forged |
   | **TXT (DMARC)** | `_dmarc.clientdomain.com` | `v=DMARC1; p=none; rua=mailto:dmarc@clientdomain.com` | policy + reporting; **start at `p=none`**, watch reports, then tighten to `p=quarantine` and later `p=reject` |

   - **SPF, DKIM, DMARC must all exist and pass** before this goes live. DKIM is what actually
     authenticates the mail; SPF authorizes the path; DMARC ties them together and tells receivers what
     to do on failure.
   - Start DMARC at `p=none` (monitor-only) so you don't blackhole real mail while the domain warms up;
     move to `quarantine`/`reject` once reports are clean.
3. Only once the domain shows **Verified** in Resend, configure the install (below). **Do not hardcode
   or point at an unverified domain** — the sender refuses to send from one.

> This DNS setup is a real, one-time step done by a human on the domain. It is intentionally not
> automated here.

---

## 2. Worker configuration

**Secrets / vars on the `syn-growth` Worker** (`npx wrangler secret put …`, or the dashboard):

| Name | Kind | Purpose |
|---|---|---|
| `RESEND_API_KEY` | **secret** | Resend API key. Lives only in the Worker — never in the browser. |
| `PUBLIC_BASE_URL` | var | The Worker's public origin (e.g. `https://syn-growth.<sub>.workers.dev`). Used to build the **working unsubscribe link**. If unset, sends fail closed — a follow-up without a real unsubscribe link is never sent. |
| `FOLLOWUP_FROM_EMAIL` | var *(optional)* | A Syntrex-operated verified sending address used as a fallback when an install doesn't set its own `from_email`. Must NOT be on `syntrexio.com`. |

**Per-install config** (`config.followup` on the install, set via `POST /admin/tenants/:id/installs`):

```json
{ "followup": {
    "enabled": true,
    "from_email": "hello@mail.clientdomain.com",   // VERIFIED sending domain (never syntrexio.com)
    "from_name":  "Client Business Name",           // shown to the recipient; the client, never Syntrex
    "reply_to":   "owner@clientdomain.com",         // the client's real inbox (optional)
    "steps_hours": [3, 24, 72]                       // cadence after capture; optional, this is the default
} }
```

- **From name** defaults to the brand name. **Reply-to** falls back to `config.reply_to` if
  `followup.reply_to` is absent. To the recipient this is the business they contacted — it is **never**
  branded as Syntrex.
- Omit `from_email` (and leave `FOLLOWUP_FROM_EMAIL` unset) and follow-ups simply aren't scheduled or
  sent for that install — fail-safe.
- Set `"enabled": false` to pause the sequence for an install.

---

## 3. The cron trigger — SET THE INTERVAL IN THE DASHBOARD

Follow-ups are due at a time, so a **Cloudflare Cron Trigger** drives the sending: it wakes the Worker's
`scheduled()` handler, which sends everything that is `pending` and past its `due_at`.

**Recommended interval: every 15 minutes — `*/15 * * * *`.** Steps are hours apart, so 15-minute
granularity is plenty prompt, and it keeps well clear of Resend's rate limits.

Set it either way:
- **Dashboard:** Workers & Pages → `syn-growth` → **Settings → Triggers → Cron Triggers → Add Cron
  Trigger** → `*/15 * * * *`.
- **wrangler:** in `wrangler.syn-growth.toml`:
  ```toml
  [triggers]
  crons = ["*/15 * * * *"]
  ```

**Safety properties of the run:**
- **Idempotent.** Each due row is claimed with an atomic `pending → sending` update; two overlapping cron
  runs can both read the row, but only the first claim wins (the rest skip). No email is ever sent twice.
- **Rate-limited.** At most `FOLLOWUP_BATCH` (25) sends per run, spaced ~120 ms apart (~8/sec) so a burst
  of due mail neither trips Resend nor looks like spam. More than a batch's worth simply goes on the next
  run.
- **Transient-failure aware.** A model or Resend hiccup returns the row to `pending` for the next run,
  up to `FOLLOWUP_MAX_ATTEMPTS` (5), after which it's marked `failed` and logged to `error_events`.

---

## 4. Each step, and what stops it

Every step, at send time, re-checks (never assumes):
- the contact **still has email consent** (`canQueueChannel` — the same gate the sender must honor),
- the contact is **not** `closed`/`lost`,
- and the row is still `pending` (not already sent/claimed).

It then drafts the body **in the brand's voice** from the brand profile (same governance as the widget,
including the banned-claim guardrail — a tripped draft is swapped for a safe, claim-free body), appends
the **tokenized unsubscribe link**, sends via Resend from the client identity, marks the row `sent`, and
writes a **`followup_sent`** event (append-only, for the Receipt).

**A sequence is cancelled the moment the lead engages**, wired into the existing paths:
| Engagement | Where it's cancelled |
|---|---|
| Sends another widget message | `wMessages` (a visitor message = active) |
| Books / completes / conversation ends | `wEvents` (`appointment_booked` / `appointment_completed` / `conversation_ended`) |
| Unsubscribes (email link) | `wUnsubscribe` |
| Admin withdraws email consent | `adminWithdraw` (email channel) |
| Closed/lost, or consent withdrawn by any path | caught again at **send time** (the authoritative last gate) |

Cancellation flips pending rows to `cancelled`; the send-time re-checks are the belt-and-suspenders that
catch anything a cancellation path missed.

---

## Reply detection — scope note

Full **inbound email** parsing (someone replying to the follow-up in their mail client) is a later
concern and is **not** built here. What is built is engagement-based cancellation through the widget and
admin paths above, plus the authoritative send-time gate. When inbound email lands, route a reply for a
contact to `cancelFollowups(env, contactId, "email_reply")` and the sequence stops the same way.

## Everything else

Tenant-scoped throughout (every row carries `tenant_id`; sends resolve the contact's own install/brand).
Follow-up drafting is an Anthropic call, so it's metered into `usage_events` like the widget. Detection-
captured contacts (an email typed in chat, no form submitted) are **not** auto-sequenced — that path has
no explicit follow-up opt-in, a deliberate consent-conservative choice; only the explicit capture form
arms a sequence.
