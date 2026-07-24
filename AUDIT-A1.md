# AUDIT-A1 — Doctrine Audit

**Branch:** `audit-a1-doctrine` · **Date:** 2026-07-24 · **Scope:** live product (marketing
site + widget) audited against the doctrine files. This is an audit. Mechanical copy
violations were fixed on this branch; every positioning/judgment call is FLAGGED for Henry,
not implemented.

---

## ⚠️ Source-of-truth blocker (read first)

The brief names three files to treat as source of truth. **Only one exists in the repo:**

| File | Status |
|---|---|
| `CLAUDE.md` | ✅ present |
| `SYNTREX_PRICING_CANONICAL.md` | ❌ **not in the repo, git history, or any branch** |
| `syntrex_foundation_2026_2032_third_edition.html` (Foundation doc) | ❌ **not in the repo, git history, or any branch** |

I searched the working tree, every tracked path, and all 30 branches (`git log --all`,
`git ls-files`, `find`). Neither the canonical pricing file nor the Foundation doc was ever
committed.

**How I proceeded, honestly:** rather than stall, I audited against (a) the canonical facts
the brief itself states verbatim — Growth Core **$397/mo + $597 install**, Growth Pro
**$547/mo**, the product being the *Growth System*; (b) the explicit copy rules in the brief
(no em dashes, no fabricated stats, directional pricing, reply-based CTAs, no "HALT" in
outreach); and (c) `CLAUDE.md` + the actual product code. **Every finding that depends on the
missing files being authoritative is marked `[unverified vs. canonical]`.** Henry should
confirm the canonical numbers below match the real file before acting on Section 1, and should
drop the Foundation doc into the repo so positioning (Section 3) can be checked against its
actual words rather than the brief's paraphrase.

---

## Section 1 — Pricing reconciliation `[FLAGGED — positioning decision, not implemented]`

### 1a. Every price / plan / number on the marketing surface

| # | Value | Where (file · location) | Kind |
|---|---|---|---|
| 1 | Headline "One simple price per seat. Volume rates as you grow." | `index.html` · `#site-pricing` `.sec-title` | plan framing |
| 2 | **$39 / seat / mo** — 1–9 seats | `index.html` · `.seat-tier` | price |
| 3 | **$35 / seat / mo** — 10–24 seats | `index.html` · `.seat-tier` | price |
| 4 | **$29 / seat / mo** — 25+ seats | `index.html` · `.seat-tier` | price |
| 5 | **$199 / mo** per additional brand (1 brand included) | `index.html` · `.seat-incl` | price |
| 6 | "AI usage is pooled and included, not billed separately" | `index.html` · `.seat-incl` / feature table | metering claim |
| 7 | Live calculator, default **$312/mo** (8 seats × $39) | `index.html` · `#pricingCalc` `#calcTotal` | derived price |
| 8 | "$39 per seat · 8 seats" | `index.html` · `#calcRate` | derived price |
| 9 | "Final billing activates with SYN Core (Stripe)" | `index.html` · `.price-note` | billing note |
| 10 | Same three seat rates + $199/brand + pooled AI, baked into the **marketing assistant** | `worker/syn-assistant.js` · `SYSTEM_PROMPT` "PRICING" block | price (AI-quoted) |
| 11 | `SEAT_PRICE = { s1: 39, s10: 35, s25: 29 }`, `BRAND_PRICE = 199` | `js/03-assets-ops.js:839–840` | price (source of truth for the calculator **and** the in-app admin Billing meter) |

The **same per-seat model is the app's real billing model**, not just marketing dressing:
`js/04-pricing-brand.js` computes seat cost, volume breaks, and the admin Billing estimate from
those constants, and `tests/pricing-model.mjs` enforces seat-limit blocking on invite/join.

### 1b. Every price / plan in the canonical file `[unverified vs. canonical — from brief]`

| Plan | Price | Install | Product |
|---|---|---|---|
| **Growth Core** | $397 / mo | + $597 one-time install | the *Growth System* |
| **Growth Pro** | $547 / mo | (install per canonical) | the *Growth System* |

### 1c. Where they contradict / are silent

- **Contradiction (severity: contradiction).** The site sells a **per-seat SaaS workspace**
  ($29–$39/seat, $199/brand, pooled AI). The canonical file sells a **flat-rate productized
  service with an install fee** ($397/$547 + $597). Different unit of sale, different numbers,
  different billing shape. They cannot both be "the price" of the same thing.
- **Omission (severity: omission).** The words **Growth System / Growth Core / Growth Pro**,
  the **$397 / $547 / $597** figures, and the **install-fee** concept appear **nowhere** in
  `index.html`, `worker/syn-assistant.js`, or `js/`. The site is silent on the product the
  canonical file says Syntrex actually sells.
- **Inverse omission (severity: contradiction).** The site markets a product the canonical file
  **does not price** (per-seat SYN) while omitting the one it **does** (the Growth System).
- **Compounding:** the marketing assistant is *instructed* to quote the per-seat numbers and
  "**Do NOT quote any price you were not given here**" (`syn-assistant.js`), so it will actively
  refuse to discuss Growth pricing and will assert the per-seat model as fact.
- **Backend already speaks Growth, not seats.** `worker/syn-growth.js` + `worker/SCHEMA.md`
  implement the Growth System's economics — `tenants`/`installs`, `job_values`
  ("the guarantee depends on this"), `receipts` (recovered-value ROI receipts), `followups`.
  There is **no seat/subscription table** in that backend. So the data layer is built for the
  Growth System while the storefront sells per-seat SYN.

### 1d. Options and consequences (recommend, do not implement)

**Option A — Sell the Growth System only.** Replace the per-seat page with Growth Core/Pro +
install.
- *Consequences:* matches the canonical file and the `syn-growth` backend it's built on;
  requires rewriting the pricing section, the assistant's PRICING block, and reframing SYN as
  the delivery surface of a service. Orphans the per-seat calculator, `SEAT_PRICE`, the app
  Billing meter, and `tests/pricing-model.mjs`.

**Option B — Sell per-seat SYN only.** Treat the canonical Growth pricing as a different
(older or internal) line and keep the site as-is.
- *Consequences:* zero site churn, but directly contradicts the file the brief calls canonical,
  and leaves the entire `syn-growth` backend (receipts/guarantee/job-value) with no storefront.

**Option C — Sell both as distinct layers (recommended).** Position them as two products:
**SYN** = the per-seat brand-intelligence *workspace* (what the site sells today); **the Growth
System** = a done-for-you *service* ($397/$547 + $597 install) that runs on the `syn-growth`
widget/receipt backend. Give each its own page and let the assistant route by intent.
- *Consequences:* both existing codebases keep a purpose (index.html ← SYN; syn-growth ← Growth
  System), and it matches what the repo has actually built — two products sharing one D1. Cost:
  clear IA so a visitor isn't confused about which they're buying, and the assistant needs both
  price lists with a routing rule.

**Recommendation: Option C.** The repo is already two products (per-seat workspace + Growth
System service) sharing a database; the honest fix is to *name and separate* them, not to
delete either. But this is a positioning call for Henry — **not implemented here.**

---

## Section 2 — Copy rules `[FIXED where mechanical · FLAGGED where judgment]`

### 2a. Em dashes — **FIXED** (rule: none anywhere)

Every em dash (U+2014) in user-facing marketing-site + widget + marketing-assistant copy was
removed and replaced with a colon, comma, or period. **19 prose em dashes fixed across 4
files** (1:1 swaps, 36 ins / 36 del, no layout change). The widget fix was mirrored
byte-identically into the embedded `WIDGET_JS` in `syn-growth.js` (the `WIDGET_JS === widget.js`
guard still passes — 121/121 worker checks green).

| File | Location | Before → After |
|---|---|---|
| `index.html` | meta description | `by Syntrex — your brand's` → `by Syntrex: your brand's` |
| `index.html` | og:description | `knows your brand — your` → `knows your brand: your` |
| `index.html` | og:image:alt | `SYN — a brand-governed` → `SYN: a brand-governed` |
| `index.html` | twitter:description | `knows your brand — your` → `knows your brand: your` |
| `index.html` | JSON-LD description | `by Syntrex — your brand's` → `by Syntrex: your brand's` |
| `index.html` | SYN 2.0 strip aria-label | `SYN 2.0 — see what` → `SYN 2.0: see what` |
| `index.html` | hero image alt | `task board — Northwind` → `task board, Northwind` |
| `index.html` | waitlist success | `Thanks — we'll email` → `Thanks. We'll email` |
| `index.html` | features intro | `live together — and nothing` → `live together, and nothing` |
| `index.html` | Brand engine desc | `legal guardrails — encoded` → `legal guardrails, encoded` |
| `index.html` | Assets desc | `real permissions — private` → `real permissions: private` |
| `index.html` | how-it-works step 03 | `something once — it carries` → `something once. It carries` |
| `index.html` | proof sub | `as they clear — this space` → `as they clear. This space` |
| `index.html` | pricing sub | `only meters — no tiers` → `only meters: no tiers` |
| `index.html` | feature row (brand) | `Brand engine — voice` → `Brand engine: voice` |
| `index.html` | feature row (AI) | `Pooled AI usage — included` → `Pooled AI usage: included` |
| `index.html` | price note | `private beta — join` → `private beta. Join` |
| `index.html` | contact sub | `team set up — send a note` → `team set up? Send a note` |
| `index.html` | contact success | `reaching out — we'll reply` → `reaching out. We'll reply` |
| `worker/syn-assistant.js` | SYSTEM_PROMPT (ABOUT) | `memory built in — "the AI` → `memory built in: "the AI` |
| `worker/syn-assistant.js` | SYSTEM_PROMPT (6 feature lines) | `Brand engine — …` etc. → `Brand engine: …` (×6) |
| `worker/syn-assistant.js` | SYSTEM_PROMPT (behave) | `results/metrics — SYN is early` → `results/metrics. SYN is early` |
| `js/01-boot-auth.js` | assistant greeting | `Hi — I'm the SYN assistant` → `Hi, I'm the SYN assistant` |
| `js/01-boot-auth.js` | beta gate copy | `private beta — <button>join` → `private beta: <button>join` |
| `js/01-boot-auth.js` | gate access error | `private beta — join` → `private beta. Join` |
| `js/01-boot-auth.js` | SYN Core unreachable (×2) | `try again — your workspace` → `try again. Your workspace` |
| `worker/widget.js` + `worker/syn-growth.js` (`WIDGET_JS`) | failCopy "full" | `with our team — share your` → `with our team. Share your` |
| `worker/widget.js` + `worker/syn-growth.js` (`WIDGET_JS`) | failCopy "rate" | `keep up with — give me` → `keep up with. Give me` |
| `worker/widget.js` + `worker/syn-growth.js` (`WIDGET_JS`) | capture error | `go through — please try` → `go through. Please try` |

**Em dashes deliberately NOT touched (out of scope / not prose), listed for completeness:**

| Location | Why left | Severity |
|---|---|---|
| `index.html:8` HTML comment | code comment, not copy | cosmetic |
| `index.html:158,282` Formspree `_subject` hidden fields | internal email-subject strings the visitor never sees; touching them risks Henry's inbox filters | cosmetic — **flag** |
| `index.html:429,436` `uName`/`uRole`/`lockName` placeholders (`—`) | empty-state **glyph**, not a sentence dash | cosmetic |
| `index.html:478` in-app onboarding tip `Read the guide — two minutes` | **signed-in app**, outside the "marketing site + widget" scope | drift — **flag** |
| all `//` comments in `js/`, `worker/*.js` | code comments, not user copy | n/a |

> Note: signed-in **app** copy (js/02–08) contains many more em dashes but is explicitly outside
> this brief's scope (marketing site + widget). If Henry wants the whole product em-dash-clean,
> that is a follow-up sweep, flagged not done.

### 2b. En dashes — checked, **left as-is** (correct usage)

`index.html` seat bands `1–9` / `10–24` and the calculator stepper `–` glyphs use en dashes for
ranges/minus. The rule prohibits em dashes; en-dash ranges are standard typography. No change.

### 2c. Fabricated statistics / results / client counts — **FLAGGED**

- **`index.html` proof section — severity: contradiction (with the assistant) / overclaim.**
  Headline **"Running in real workspaces now."** and sub **"SYN is live with pilot teams
  today."** are claims of real client usage. The proof cards and logo row beneath them are
  **empty placeholders** (`aria-hidden`), and the marketing assistant is explicitly told
  **"SYN is early and has none to cite"** (`syn-assistant.js`). So the site asserts live pilots
  while the assistant is instructed to deny customers exist. **I cannot verify whether pilots
  are real** — if they are not, "Running in real workspaces now / live with pilot teams today"
  is a fabricated-usage claim and should be softened to future/aspirational ("Built for real
  workspaces", "Pilots opening now"). **Flagged, not changed** — this is a truth-of-fact Henry
  must confirm, not a typo.
- **"Fifteen minutes, once"** (encode your brand, `index.html` step 01) and **"two minutes"**
  (guide length, app) — soft process-time estimates, not results/metrics. Low severity; leave
  unless Henry considers them unsupported.
- No percentages, ROI figures, customer counts, or named case studies were found in marketing
  body copy. Clean on that front.

### 2d. Specific pricing in body copy — **FLAGGED** (tied to Section 1)

The rule (per brief) is *directional pricing only* in body copy. The site states exact seat
prices ($39/$35/$29, $199) in the pricing section, the calculator, **and** hard-codes them into
the marketing assistant's prompt with "only quote these exact numbers." Whether that violates
"directional only" depends entirely on the Section 1 positioning decision, so it is **flagged
there**, not fixed here.

### 2e. Reply-based CTAs / no scheduling or phone language — **checked, clean**

Marketing CTAs are **"Join the waitlist"**, **"Sign In"**, and an email contact form → replies
from `henry@syntrexio.com`. No scheduling links (Calendly etc.), no "call us"/phone-number CTAs
anywhere on the site or in the widget. The widget's own capture is reply/leave-details based.
**No violation.**

### 2f. "HALT" as a word in outreach copy — **checked, clean**

`HALT` appears only as the **demo brand name "HALT Fire"** (`js/01-boot-auth.js:259` seed data;
`js/05-settings-data.js:126` "Load Syntrex demo brands"). That is a fixture brand (Henry's own
`haltfire.com`), not outreach-style copy. The Growth follow-up **sender does not exist yet**
(per `COMPLIANCE.md`), so there are no outreach templates to contain "HALT". **No violation.**

---

## Section 3 — Positioning consistency `[FLAGGED — Foundation doc missing, see blocker]`

> The Foundation doc is not in the repo, so "does the site match what the doc *says* SYN is?"
> cannot be checked against its real words. The below checks the site against the brief's
> paraphrase and for the specific overclaims the brief names.

- **What SYN is:** the site consistently frames SYN as "a brand-governed AI workspace / full
  team operating system with your brand's memory built in," a **Syntrex product**. Internally
  consistent (hero, features, assistant, footer, Terms all agree). Whether that matches the
  Foundation doc's definition is **unverifiable until the doc is in the repo** — flagged.
- **"We do everything" positioning:** **not found.** No "do everything / anything / any
  industry / all your tools" language. The site actually positions *against* generality
  (`#site` comparison strip: "Generic PM tools… Generic AI chat… SYN knows both"). Clean.
- **Perfect Skin (or any conceptual example presented as delivered work):** **not found**
  anywhere in `index.html`, `js/`, or `worker/`. The only example workspaces are clearly
  labelled **demo** ("Northwind Supply Co. demo workspace"; the HALT Fire / Doughbrik's / Karlo
  seed brands are behind a "Load Syntrex **demo** brands" control). No conceptual example is
  passed off as a real client deliverable. Clean.
- **Overclaim on capability / client count:** the only overclaim risk is the **"live with pilot
  teams today"** proof claim (see 2c). Everything else is described as beta ("SYN is in private
  beta", waitlist CTAs). Flagged with 2c.

**Fixes made in this section: none** (no outright-false capability claim could be confirmed
false in-sandbox). The pilot-usage claim is flagged for Henry to confirm or soften.

---

## Section 4 — Internal consistency

### 4a. Widget brand-governance vs. what's promised — **consistent (minor note)**

The site promises "a compliance-aware AI that drafts in your voice and ships everything with a
verdict and an audit trail." The `syn-growth` widget backs this: `buildSystemPrompt` encodes
voice/approved/banned/legal/escalation per brand; `screenBanned` is a hard post-generation
banned-claim backstop; `guardrail_blocked` events form the audit trail; failures degrade to a
safe offer, never a raw error. Behavior matches the promise. *Minor:* the marketing site (SYN
per-seat workspace) and the widget (Growth System surface) are technically **two products**, so
"the widget does what the site says" holds only under Option C framing (Section 1).

### 4b. SCHEMA / COMPLIANCE / pricing docs agree? — **partial**

- `SCHEMA.md` ↔ `COMPLIANCE.md`: **agree.** Both describe the same append-only model
  (`events`, `consent_events`, `job_values`), tenant scoping, and the erasure/anonymize split.
  `syn-growth.test.mjs` (121 checks) enforces it. No contradiction on what's collected.
- **What it collects:** consistent across `SCHEMA.md`, `COMPLIANCE.md`, `widget.js`, and the
  privacy page (name/email/phone, consent + exact text_shown, IP/UA for audit).
- **What it charges / guarantees:** **inconsistent with the marketing site.** `SCHEMA.md`
  documents a **recovered-value "guarantee"** and ROI **receipts** (the Growth System's promise)
  — a value proposition the marketing site never mentions and that has no counterpart in the
  per-seat pricing story. This is the same Section-1 split surfacing in the docs: the backend
  docs describe the Growth System; the site describes per-seat SYN. Flagged with Section 1.

### 4c. Is CLAUDE.md stale after 17 prompts? — **yes, drift (severity: drift)**

- **§10 "What is being built next":** calls the Growth Engine (`syn-growth`) the *next* thing
  and "SCHEMA + KEYS + WRITE PATH only." It is now substantially **built** — widget shell, AI,
  lead capture, and full compliance/consent infrastructure have all landed. Stale.
- **§3 file map:** does **not** list `worker/widget.js`, `worker/syn-growth.js`,
  `worker/SCHEMA.md`, `worker/WIDGET.md`, `worker/COMPLIANCE.md`, `worker/legal/*`,
  `worker/wrangler.syn-growth.toml`, `worker/seed-syn-growth.mjs`, or `worker/syn-growth.test.mjs`.
  Incomplete.
- **§7 testing:** says **"11 Playwright suites"** and lists 11; there are now **15**
  (`growth-widget`, `growth-widget-ai`, `growth-capture` added, plus the worker unit suite).
  Stale count.
- **Positioning:** CLAUDE.md describes SYN *only* as the per-seat workspace and never mentions
  the Growth System / Growth Core-Pro pricing at all — the same doctrine gap as the site.
- These are documentation-drift items. **Not fixed here** (CLAUDE.md upkeep wasn't in the fix
  scope of this brief, and §10/positioning shouldn't be rewritten until the Section 1 decision
  is made). Flagged for a CLAUDE.md refresh once positioning is settled.

---

## What Henry must decide vs. what was already corrected

### ✅ Already corrected on `audit-a1-doctrine` (mechanical, verified)
1. **All 19 prose em dashes** in marketing-site, marketing-assistant, and widget copy removed
   (index.html, syn-assistant.js, js/01, widget.js + mirrored into syn-growth.js's WIDGET_JS).
   Byte-identity guard green (121/121), size-guard green (21/21), growth suites green
   (widget 39/39, capture 14/14; widget-ai's one failure is the **pre-existing** headless
   typing-indicator flake — reproduced on the clean baseline, not caused by these edits).

### 🔷 Henry must decide (flagged, nothing implemented)
1. **PRICING / POSITIONING (biggest).** Per-seat SYN vs. the canonical Growth System
   ($397/$547 + $597). Pick Option A / B / C (recommend **C** — sell both as named layers).
   This one decision also resolves 2d (exact prices in body copy) and 4b (docs vs. site).
2. **Pilot-usage claim.** Confirm or soften "Running in real workspaces now" / "live with pilot
   teams today" — it contradicts the assistant's "SYN is early and has none to cite." Truth of
   fact only Henry knows.
3. **Put the two missing doctrine files in the repo** (`SYNTREX_PRICING_CANONICAL.md`, the
   Foundation doc) so Section 1 numbers and Section 3 positioning can be checked against the
   real source, not the brief's paraphrase.
4. **Optional follow-ups:** em-dash sweep of the signed-in **app** (js/02–08, index.html:478);
   the two Formspree `_subject` em dashes; a **CLAUDE.md refresh** (§3 file map, §7 suite count,
   §10 Growth status) once positioning is settled.

---

*Fixes are on `audit-a1-doctrine`. The pricing decision is not. Not merged — awaiting review.*
