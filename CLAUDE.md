# CLAUDE.md — SYN

> Read this file first, every session. It is the map that keeps you from
> re-deriving a ~1 MB single-file app from scratch. **Do not read `index.html`
> in full** — see [§4 How to read this repo efficiently](#4-how-to-read-this-repo-efficiently).

---

## 1. What this is

SYN is a brand-governed AI workspace and platform by **Syntrex LLC**
(syntrexio.com). Two surfaces live in this one repo, in a single
`index.html`:

- **The public marketing site** — the signed-out experience: hero, feature
  sections, per-seat pricing, legal pages, contact form, and a monochrome AI
  assistant. Its job is to explain SYN and convert visitors to sign-up.
- **The signed-in application** — the workspace itself: a brand engine, tasks &
  operations, calendar, spaces & DMs, assets with permissions, a
  compliance-aware AI teammate, plus settings/billing/team admin. Its job is to
  be the team's day-to-day operating system with the brand's memory built in.

Both surfaces are the same file. The marketing site is scoped under `#site`;
the app boots into `#app`. There is **no build step** — the file is served
as-is.

---

## 2. Stack and hosting

- **Frontend:** one static `index.html`, no bundler, no framework, all CSS/JS
  inline. Served from **GitHub Pages**, `main` branch of this repo
  (`HenryB08/SYN-AI`).
- **CDN / edge:** **Cloudflare** sits in front.
- **Backend — SYN Core:** a **Cloudflare Worker** at
  **`https://syn-core.henrybello.workers.dev`**, backed by **D1**. It exposes a
  tiny KV surface — `GET /kv/<key>` and `PUT /kv/<key>` (D1-backed, origin-locked,
  no auth header) — and also proxies Anthropic (`/v1/messages`) so the app's AI
  calls never carry a key in the browser. In `index.html` this is the constant
  `SYN_CORE_URL` (line 2745); `apiBase()` (2746) routes AI calls to it.
- **Marketing assistant — syn-assistant:** a **second Cloudflare Worker** at
  **`https://syn-assistant.henrybello.workers.dev`**. Source lives in
  `worker/syn-assistant.js`; it bakes the marketing system prompt in and proxies
  to Anthropic. In `index.html` this is `SYN_ASSISTANT_URL` (line 3221).
- **Bindings:** the app (browser) → SYN Core Worker (KV over D1 + Anthropic
  proxy). The marketing site (browser) → syn-assistant Worker → Anthropic.
  syn-assistant does **not** touch D1. Final billing activates with SYN Core via
  Stripe.
- **Secrets:** live **only** in each Worker's environment as Wrangler secrets
  (e.g. `ANTHROPIC_API_KEY` via `npx wrangler secret put`). **No secret value
  appears in this repo or in the browser.** Deploy steps are in
  `worker/README.md`.

---

## 3. File map

Every tracked file in the repo:

| Path | What it is | Touch it when… |
|---|---|---|
| `index.html` | The shell: `<head>`, the `<body>` DOM markup (marketing + app), and the `<link>`/`<script src>` tags. **~80 KB** — CSS is in `css/`, JS is in `js/`, guide shots in `img/guide/` | markup/DOM changes, or wiring a new css/js file |
| `js/01-boot-auth.js … 08-wiring.js` | The entire application JS, split into 8 order-dependent **classic scripts** (one shared global scope, not modules), loaded at end of body | any app-logic change — edit the file the function lives in; **never reorder, never add `type="module"`/`defer`/`async`** (see JS file map) |
| `css/01-tokens.css … 06-motion.css` | The entire stylesheet, split into 6 order-dependent files linked in `<head>` | any CSS change — edit the file the rule lives in; **never reorder the links** (see CSS file map) |
| `img/guide/*.webp` | The 12 in-app Guide screenshots (extracted from the old `GUIDE_IMGS` base64) | swapping a guide screenshot |
| `worker/syn-assistant.js` | Cloudflare Worker for the marketing assistant; system prompt baked in, proxies Anthropic | changing what the marketing assistant knows or how it's proxied |
| `worker/wrangler.toml` | Wrangler config for syn-assistant | changing the Worker name / compat date |
| `worker/README.md` | Deploy + wiring instructions for syn-assistant | onboarding a deployer; changing the endpoint |
| `tests/*.mjs` | 11 Playwright suites (see [§7](#7-testing)) | any behavior change — add/adjust a suite |
| `img/shot-tasks.webp` | One marketing screenshot asset (38 KB) | swapping that marketing image |
| `docs/luminous-identity.md` | Historical identity/design note | design-history reference only |
| `docs/syntrexio-identity-spec.md` | Syntrex brand/identity spec | brand-voice reference only |
| `AUDIT.md` | Prior full-audit report | historical QA reference |
| `FINAL-QA.md` | Demo-readiness QA report (monochrome rebuild) | historical QA reference |
| `ARCHITECTURE.md` | How data actually flows (sign-in, state, sync, privacy, AI path) | before changing sync, persistence, or privacy |
| `CLAUDE.md` | This file | keep current as the repo evolves |

### `index.html` composition (measured, not estimated)

> **Note:** the figures below describe the **original monolithic** `index.html`.
> **Three** extractions have since shrunk it: the 12 guide screenshots →
> `img/guide/*.webp`, the entire `<style>` block → `css/` (6 files), and the
> entire inline `<script>` block → `js/` (8 files). **Current `index.html` is
> ~79.9 KB** — essentially just the `<head>`, the `<body>` DOM, and the `<link>`
> + `<script src>` tags. It contains **no `<style>` block, no base64 screenshots,
> and no application JS**. The old line ranges below are historical; use the
> `css/` and `js/` file maps to locate code now.

- **Total (original): 989,257 bytes, 8,345 lines.**
- Base64 data URIs: **12 `image/webp` screenshots = 330,768 bytes (33.5%)** —
  all in the `GUIDE_IMGS` object, the in-app manual. There are also 2 tiny
  inline SVG (utf-8, non-base64) data URIs (~64 B).
- `<style>`: **176,649 B (17.9%)**, one block.
- `<script>`: **733,364 B (74.1%)**, one main block (plus 3 tiny head scripts).
  Of that, the embedded guide screenshots are 343 KB; **JS logic minus the
  embedded screenshots is ~390 KB (39.4%)**.
- HTML markup (`<body>` DOM): **76,725 B (7.8%)**.

### `index.html` top-level structure (read a range, not the file)

| Lines | Bytes | What |
|---|---|---|
| 1–27 | 2.5 KB | `<head>`: meta, preconnect, Inter font links, 3 tiny boot scripts |
| **28–2034** | ~~177 KB~~ | ~~`<style>`~~ — **extracted to `css/` (6 linked files); now six `<link>` tags** |
| 2036–2731 | 77 KB | `<body>` HTML markup (app + marketing DOM) — still inline |
| **2732–8342** | ~~733 KB~~ | ~~`<script>`~~ — **extracted to `js/` (8 files); now eight `<script src>` tags at end of body** |
| 8343–8345 | — | closing tags |

### Ten largest contiguous regions (for planned extraction)

| # | Lines | ~Bytes | What it is |
|---|---|---|---|
| 1 | **5913–6036** | **343 KB (34.7%)** | `GUIDE_IMGS` — 12 base64 webp manual screenshots + the `GUIDE` content array (the single biggest extraction target) |
| 2 | 1830–2034 | ~35 KB* | CSS tail: "DARK PRO Phase 6 — motion system" (through end of `<style>`) |
| 3 | 7415–8054 | ~51 KB | JS: profile + integrations click-delegation (Part 2) |
| 4 | 203–538 | ~33 KB | CSS: the `APP` component block |
| 5 | 1355–1552 | ~19 KB | CSS: stroke-icon system + chrome glyph rules |
| 6 | 3051–3370 | ~19 KB | JS: public marketing site routing |
| 7 | 6928–7143 | ~15 KB | JS: "Ask SYN to plan" (AI task planning) |
| 8 | 5740–5887 | ~13 KB | JS: Settings views |
| 9 | 6694–6849 | ~12 KB | JS: task modal |
| 10 | 4057–4275 | ~12 KB | JS: chat send + generate pipeline |

\* Region 2's raw segment (1830–2731) also swept the HTML body; the CSS-only
tail is ~35 KB, the body markup after `</style>` (2036–2731) is the 77 KB in the
structure table above.

### JS: extracted to `js/` (8 classic scripts, ~409 top-level functions)

The JS **no longer lives in `index.html`.** The old single inline `<script>`
block (404,197 B, ~5,627 lines) was moved verbatim into eight files under
`js/`, loaded at the end of `<body>` with plain `<script src>` tags. The move
was byte-exact: concatenating the eight files (minus their header comments)
reproduces the original inline script content character for character. The
three tiny head scripts (theme-before-paint, `logoFail`, and the two CDN
`<script src>` for marked/DOMPurify) stay inline in `<head>`.

> **⚠️ CLASSIC SCRIPTS, ONE SHARED GLOBAL SCOPE — NOT MODULES. DO NOT REORDER,
> DO NOT ADD `type="module"`/`defer`/`async`.** All ~409 functions live on one
> global scope and call each other freely with **no import/export graph**. They
> are plain `<script src>` tags executed **in order, synchronously**, exactly as
> the old inline block ran. Converting to ES modules would give each file its
> own scope and require building that dependency graph by hand — a refactor with
> real breakage risk, not a move. Adding `defer`/`async` changes execution
> timing. The tags **must** stay in order `01 → 08`; a later file's top-level
> code can read a `const` from an earlier file, but not vice-versa (temporal
> dead zone across files). Inline `onclick`/`onerror` handlers in the markup
> (e.g. `goSite`, `logoFail`, `guideImgFail`) work because function declarations
> still land on `window` — keep them global.

| # | File | ~Size | What lives in it (grep here) |
|---|---|---|---|
| 01 | `js/01-boot-auth.js` | 47 KB | `SYN_CORE_URL`/`apiBase`, the **storage adapter** (`sGet`/`sSet`/`saveSoon`/`cloudGet`/`cloudWrite`/`okey`), app **STATE** + `MODELS`/default data, helpers, **persistence**, **`boot()`** wiring, **public marketing-site routing** (`goSite`/`routeSite`), the **marketing AI assistant** (`synAsst*`, `SYN_ASSISTANT_URL`), workspace **join codes**, and **AUTH** (`siteAuth`/sign-in/create/join) |
| 02 | `js/02-chat.js` | 50 KB | threads, the **SYSTEM PROMPT** builder (`[[TASK:]]`/`[[EVENT:]]` templates), brand-select sidebar, **CHAT RENDER**, attachments, generated files, the **SEND / GENERATE** pipeline (thread AI call site), approvals, profile render |
| 03 | `js/03-assets-ops.js` | 62 KB | **ASSETS** (grid/list, upload pipeline, `canSee`, visibility modal), escalation, **ACTIVITY** view + AI transcript parse, **FOLLOW-UPS**, **DEPENDENCIES**, **WEEKLY RECAP**, **COMPANY ROLLUP**, CSV export, shared refresh/badges |
| 04 | `js/04-pricing-brand.js` | 41 KB | per-seat pricing state, pooled + per-user AI usage, **`AI_DAILY_CAPS`/`gateAI`/`recordCost`/`estMonthSpend`**, the marketing pricing calculator, admin **Billing**, the **BRAND MODAL** (`openBrandModal`), brand research auto-fill, **INTEGRATIONS UI** |
| 05 | `js/05-settings-data.js` | 49 KB | **SETTINGS** (`renderSettings`), view registry, the signed-in **GUIDE** (`renderGuide`/`guideImgFail`/`GUIDE_IMGS`), voice input, legacy chat + export, then the **core data layer**: global event bus, org-scoped **collections** (`coll`/`collSave`/`flushPendingWrites`), the **entity factory** (`Tasks`/`Events`/`Assets`…), notifications, due-soon scan, the **workspace sync poll** (`WS_POLL_MS`/`wsSyncOnce`), shared helpers |
| 06 | `js/06-tasks.js` | 38 KB | **TASKS**: `T_STATUS`, sidebar nav, tasks view (board/list), drag & drop (`setTaskStatus`), quick-add, assignment, the **task modal** (`openTaskModal`/`renderTaskModalBody`/`saveTask`), project modal, **AI task ingestion** (`ingestAITasks`/`normVisibility`/`canSeeTask`), Ask-SYN-to-plan |
| 07 | `js/07-calendar-views.js` | 52 KB | **CALENDAR** (`calView`/`renderCalendar`/month/week/day/agenda), the **event modal** (`openEventModal`/`saveEvent`), Google Calendar / ICS export, **AI event ingestion** (`ingestAIEvents`/`canSeeEvent`), the profile + integrations click-delegation (part 2), remaining view renderers |
| 08 | `js/08-wiring.js` | 57 KB | workspace **click delegation** (`data-wact` handlers incl. `newTask`/`newEvent`/`setStatus`/`calView`), bus subscriptions (wired once), **EVENT WIRING**, the **SHELL** (`applyTheme`/`toggleTheme`/`openSearch`/sidebar/focus/**centralized Escape handler**). **Ends with `boot();`** |

Split is by **source-order slice**, not tidy taxonomy — a few files straddle
concerns (05 carries both settings-UI and the core data layer because that is
their source order). Grouping of the ~409 functions is roughly: render/UI 58 ·
spaces/chat 56 · tasks 27 · utils 25 · calendar 24 · sync/cloud 23 · AI/cost 19
· assets 19 · billing/pricing 12 · brand 10 · settings/team 7 · guide 4 ·
auth/identity 3 · cross-domain helpers ~122. **To find a function: read the
table, open the one file, grep it** — never load all of `index.html`.

> Note for tests: `tests/ai-visibility.mjs` used to grep
> `document.documentElement.innerHTML` for the system-prompt templates, which
> only worked while the JS was inline. It now reads the shipped source files
> (`index.html` + `js/*.js`) instead — update in kind any test that assumes JS
> is inline in the DOM.

### CSS: extracted to `css/` (6 files, ~1,600 declaration blocks, 25 `@media`, 13 `@keyframes`)

The CSS **no longer lives in `index.html`.** The old single `<style>` block
(176,634 B) was moved verbatim into six files under `css/`, linked in `<head>`
in numeric order. The move was byte-exact: concatenating the six files (minus
their header comments) reproduces the original `<style>` content character for
character. Marketing is dark-only; the app supports light and dark via
`data-theme`.

> **⚠️ ORDER-DEPENDENT — DO NOT REORDER THE LINKS.** The six files are
> contiguous slices of the original stylesheet in source order, and **CSS
> cascade order is load-bearing here** (this repo has been bitten twice by
> later rules silently overriding earlier ones — the sticky-nav and the mobile
> media-query regressions). The `<link>` tags **must** stay in the exact order
> `01 → 02 → 03 → 04 → 05 → 06`. Reordering them, or moving a rule between
> files, changes which rule wins and can break rendering with no error. If you
> edit CSS, edit the file the rule already lives in; never move it earlier or
> later.

| # | File | Original lines | What it holds |
|---|---|---|---|
| 01 | `css/01-tokens.css` | 29–137 | design tokens — `:root`, `:root[data-theme="light"]`, `:root[data-theme="dark"]`, every custom property |
| 02 | `css/02-base.css` | 138–202 | shared foundation — AURORA ambient layers, BOOT / AUTH, the sign-in field |
| 03 | `css/03-app.css` | 203–1365 | signed-in app components (sidebar, chat, workspace suite, calendar, spaces, ops, integrations, assets, billing, micro-label pass). **The stroke-icon / chrome-glyph rules live inline here** (~orig L1015 and ~L1355) — they interleave with app components in source and can't be a separate file without reordering |
| 04 | `css/04-marketing.css` | 1366–1736 | shared button/accent/card primitives + everything scoped to `#site`: floating pill nav, hero, sections, pricing, footer, contact, AI assistant, legal, DESIGN SYSTEM v3, Phase-4 typography, Phase-5 pricing |
| 05 | `css/05-guide-premium.css` | 1737–1793 | late app coda — the GUIDE manual styles and the PREMIUM app hover-physics layer (they appear after the marketing block in source) |
| 06 | `css/06-motion.css` | 1794–2033 | motion system + late layer — PREMIUM motion/depth/density, DARK PRO Phase-6 motion + `@keyframes`, the flagship illustration band, the ambient layer, marketing nav chrome, the SYN 2.0 strip, the hero preview, the guide header, the pill-collapse media query |

The taxonomy is by **source-order slice, not tidy concern**: the source is
interleaved (marketing `#site` rules wrap around the motion system; icon rules
sit inside the app layer), so a few files straddle concerns. Preserving order
beats a tidy split — see the warning above.

---

## 4. How to read this repo efficiently

**Do NOT read `index.html` in full.** It is ~989 KB / 8,345 lines and a full
read is the single largest avoidable token cost in this project. Instead:

1. **Start from the region map above** — pick the line range for the area you
   need and read only that range.
2. **Grep for the specific symbol** (function name, CSS token, banner label)
   with `Grep`, get the line number, then read a **bounded range** around it.
3. The banner comments (`/* ---- LABEL ---- */`) are deliberate landmarks —
   grep the label to jump to a section.
4. Only widen the range if the bounded read genuinely doesn't contain what you
   need.

This is the entire point of this document: **map → grep → bounded read**, never
a blind full-file read.

---

## 5. Conventions

- **Every change on a new branch**, named for the work (e.g.
  `repo-claude-md`, `syn-mono`).
- **Never merge.** Henry reviews and merges. Do not merge to `main` unless he
  explicitly says so in a separate instruction.
- **Never touch files outside the stated scope of the brief.** If a
  documentation task has you editing `index.html`, stop — that's out of scope.
- **Screenshot before claiming a visual change works.** A visual claim without
  a screenshot is unverified.
- **Never mark a check PASS that was not actually executed.** Use **UNVERIFIED**
  with the specific reason.
- **The sandbox has no outbound network.** Do not attempt deploys and do not try
  to reach external hosts (Cloudflare, Anthropic, Formspree, Google Fonts, the
  logo CDN). When something requires the network, **report the blocker** and the
  exact command Henry should run — do not work around it or ask for secrets.

---

## 6. Design system

Current state: **monochrome.** No chromatic color on the marketing site;
functional **red and green only in the app**. Hairline borders instead of
shadows. **Inter** for UI, monospace for labels and numerals. A shared easing
token drives motion, and **all motion is disabled under
`prefers-reduced-motion`**.

Actual token names as they exist in the CSS today (`:root`, ~line 30, with a
`:root[data-theme="light"]` override, ~line 120):

- **Surfaces / lines:** `--bg`, `--surface-0..3`, `--hairline`,
  `--hairline-strong`.
- **Text:** `--text`, `--text-2`, `--text-3`, `--text-4` (primary→quaternary,
  all AA-tuned).
- **Accent (now monochrome):** `--gold` (`#E2E2E2` dark / `#111` light),
  `--gold-hover`, `--gold-active`, `--gold-ink`, `--accent` (= `--gold`),
  `--accent-soft`. The `--gold*` names are legacy — the *values* are grayscale.
- **Buttons:** `--btn`, `--btn-ink`, `--btn-hover`, `--btn-active`.
- **Escalation emphasis:** `--amber` (also monochrome now), `--amber-soft`.
- **Functional status (app only):** `--good` (`#7FD99A` dark / `#237A3A`
  light), `--bad` (`#FF7A6B` / `#C0392B`), `--info`.
- **Radii:** `--r-btn:4px`, `--r-input:4px`, `--r-img:4px`, `--r-xs:4px`,
  `--r-sm:6px`, `--r-md:6px`, `--r-lg:6px`, `--r-full:999px`. → **4px on buttons
  and inputs, 6px on cards, 999px only on status chips.**
- **Spacing scale:** `--s1:4px … --s8` (4/8/12/16/24/32/48/…).
- **Type scale:** `--t1..--t8` each with `-size/-lh/-ls/-wt`, plus `--body-*`,
  `--small-*`, `--mini-*`, `--micro-*`. Headlines are weight **600**, tight
  tracking (`--t1-ls:-0.03em`), tight line-height (`--t1-lh:1.0`); body is 400 at
  `--body-lh:1.62`. `--micro-*` is the uppercase mono label style.
- **Motion:** `--ease-reveal:cubic-bezier(0.16,1,0.3,1)` is the shared easing.
- **Depth:** `--shadow-pop` reserved for popovers only; chrome uses hairlines.

---

## 7. Testing

Suites live in `tests/` (Node + `playwright-core`, headless Chromium). Each
prints `CHECKS: N passed, M failed` and `ERRORS: NONE/PRESENT`.

| Suite | Covers |
|---|---|
| `ai-visibility.mjs` | AI-created events/tasks honor a visibility field (private stays private across users) |
| `audit-regression.mjs` | Regression guard for syn-audit findings (debounced-write data loss, etc.) |
| `chat-visibility.mjs` | Chat visibility is owner-only; re-keying never orphans a record |
| `cost-control.mjs` | Manual actions cost 0 API calls; per-user daily caps trip & reset; capped user keeps all non-AI features; cost meter + overrides |
| `cross-feature.mjs` | Cross-feature integration: task+due→calendar, complete→auto-activity, follow-ups→My Day, dependency→notify, AI items respect privacy |
| `guide-access.mjs` | In-app Guide: signed-out inaccessible, signed-in renders, search, deep links, checklist linkage, admin gating |
| `identity-persistence.mjs` | Identity + cloud persistence; a failed cloud read never silently falls back to empty localStorage |
| `ops-layer.mjs` | Operations layer: escalation thresholds, cross-user dependency notifications |
| `premium-motion.mjs` | Reveals/stagger, count-up, canvas lifecycle, parallax, hover physics, full reduced-motion degradation |
| `pricing-model.mjs` | Per-seat pricing: seat-limit blocking on invite/join, seat freed on removal, volume tiers |
| `privacy-sweep.mjs` | Two users on one mock SYN Core: per-type ACCESS **and** STORAGE (which cloud keys a non-authorized session fetches) |

**Run one:**

```sh
node tests/cost-control.mjs
```

**Run all:**

```sh
for f in tests/*.mjs; do echo "== $f =="; node "$f"; done
```

> There are additional ad-hoc canonical suites that have historically been kept
> in `/tmp` (audit, launch, v3, polish, cloud, shell, ia). They are not tracked
> in the repo; only the `tests/` suites above are canonical here.

**Known flake:** `premium-motion.mjs` intermittently fails **one** scroll-reveal
opacity check (observed ~1 run in 3) and passes 11/11 on re-run. It is a
headless animation-**timing** artifact, not a defect — the reveal fires a frame
later than the assertion samples it. Re-run to confirm green. In repeated runs
this pass, no other suite flaked; if the brief references a second timing flake,
it was **not reproduced here** (UNVERIFIED) — treat any lone failure in a
motion/timing-sensitive suite the same way: re-run before believing it.

---

## 8. AI and cost

- **Model routing** (`MODELS`, line 2916): `smart:"claude-sonnet-4-6"`,
  `fast:"claude-haiku-4-5-20251001"`. Cheap/fast work (routine chat, parsing)
  runs on Haiku; heavier reasoning routes to Sonnet. When a workspace pool is
  exhausted, `smart` is **soft-throttled down to `fast`** rather than blocked.
- **Prompt caching** (line 3758): the system prompt is built as a **stable,
  cacheable prefix** (identity + guardrails + brand profile + protocols) sent
  with `cache_control:{type:"ephemeral"}`, so repeat calls reuse the cached
  prefix.
- **History windowing:** thread chat sends only the last `HISTORY_WINDOW = 10`
  messages (line 4146); spaces send `SPACE_HISTORY_WINDOW = 12` (line 5202).
  Image-mode turns are filtered out of history.
- **Per-user daily caps** (`AI_DAILY_CAPS`, line 5196): `fast:50, smart:10,
  image:5, parse:5` per user per day, resetting at midnight; per-workspace
  overrides via `ORG.aiCaps`. Pooled monthly allowance is `AI_ALLOWANCE`
  (line 5188) `standard:500, smart:100, image:20, parse:20` × seats.
- **Unified gate** (`gateAI`, ~line 5300): every AI-consuming call passes through
  it — (1) per-user daily hard cap (a real cost firewall, applies to every
  workspace), (2) pooled soft throttle (legacy workspaces exempt), then records
  daily + monthly + cost. There are **6 Anthropic call sites** (thread send
  4183, activity braindump 4716, brand research 5587, plan-a-task 6943, event
  ingestion 7563, space send 7888), all funneled through the gate.
- **Live cost meter:** `recordCost(callType)` tallies per-call-type counts and
  `estMonthSpend()` renders a running dollar estimate in **admin → Settings →
  Billing** (section at line 5340).
- **The rule:** manual actions — creating a task, adding a calendar entry,
  sending a human-to-human message, navigating, searching — **must never trigger
  an API call.** This is verified by `tests/cost-control.mjs`, which wraps
  `fetch`, counts `/v1/messages` hits, and asserts a full manual workflow
  produces **0** calls (and that a capped user's non-AI actions also stay at 0).

---

## 9. Known constraints and gotchas

Traps a future session would otherwise rediscover the hard way:

- **The Syntrex logo is a remote URL on a third-party CDN** (mcusercontent.com)
  with a text **"S" fallback**. It is **unverifiable in-sandbox** (egress
  blocked) — screenshots show the "S". It renders on the live site; don't "fix"
  the fallback thinking it's broken.
- **Source render art was only ever 500px.** The original marketing render
  assets were 500px; don't expect higher-res source to exist, and don't upscale
  and claim crispness.
- **The ambient layer rule can override `position:sticky`.** The
  `#site > *:not(.site-ambient)…{position:relative}` blanket rule has higher
  specificity than `.site-nav{position:sticky}`; the sticky header only works
  because `.site-nav` is explicitly excluded from that rule. If sticky breaks,
  check that exclusion first.
- **Several test selectors depend on the current DOM structure** — e.g.
  `.site-nav-cta .site-btn.gold` (the nav CTA; note the legacy `.gold` class is
  monochrome now and is `display:none` on mobile, so drive sign-up via
  `siteAuth('create')` at ≤860px), `#site.on`, `#authScreen.on`, `#app.on`,
  `.modal-veil.open`, `#saBody`/`.sa-msg`. Renaming/restructuring these breaks
  suites silently — update the suite in the same change.
- **`:focus` styles don't apply in headless** unless the page is brought to
  front (`p.bringToFront()`); a "focus ring missing" failure is often the
  harness, not the CSS.
- **Legacy token names lie about color.** `--gold`, `--amber`, `.gold` are all
  **monochrome values** today; don't infer color from the name.
- **Escape handling is centralized** at ~line 8287: it closes search → chat menu
  → any `.modal-veil.open` → notifications panel → quick-add → focus mode, in
  that order. New overlays must be added there or Escape won't close them.
- **Cloud writes are debounced and per-key serialized** (`cloudWrite`/`saveSoon`,
  and `flushPendingWrites` on `visibilitychange`). A prior data-loss bug came
  from unflushed debounced writes — see `tests/audit-regression.mjs`. Don't
  remove the flush-on-hide.
- **`persistMode`** can be `cloud` (SYN Core), `shared` (preview), `device`, or
  `memory` (last-resort). A failed cloud read must **throw**, not silently fall
  back to empty localStorage (guarded by `tests/identity-persistence.mjs`).
- **The workspace sync poll** runs every `WS_POLL_MS = 12s` when visible,
  `WS_HIDDEN_MS = 60s` when hidden, and refetches on focus. Changing these
  affects perceived freshness and cost.

---

## 10. What is being built next

The **Growth Engine** — a separate Cloudflare Worker, **`syn-growth`**, that will
**bind the same D1 database** as SYN Core. The workspace app (this repo's
`index.html`) and the Growth Engine are **separate codebases that share a
database**: they integrate at the data layer, not the code layer. Keep that
boundary in mind — schema/key changes in SYN Core's D1 are shared surface with
`syn-growth`, so treat the D1 key conventions documented in `ARCHITECTURE.md` as
a contract, not a private detail.
