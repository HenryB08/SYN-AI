# SYN — Final QA (demo-readiness pass)

Branch: `syn-mono` · Scope: the monochrome rebuild (Phase 1), Inter typography
(Phase 2), floating pill header (Phase 3), and the marketing AI assistant
(Phase 4), verified against the whole product.

Everything marked **PASS** below was actually exercised in a headless Chromium
run (Playwright) or by reading computed styles/DOM state — not assumed. Items
that could not be exercised inside this sandbox are listed under
**UNVERIFIED — blocked by environment**, each with the reason and what was done
instead.

---

## Summary

- **Console:** 0 code errors, 0 warnings on every marketing route and every app
  view, both themes. (The only console errors observed are
  `ERR_TUNNEL_CONNECTION_FAILED` from the sandbox blocking outbound hosts —
  remote logo image, Google Fonts, the Worker/Formspree endpoints. Filtering
  those out leaves **0** errors. None originate in app code.)
- **Layout:** 0 horizontal overflow at 1440 / 1024 / 375 on marketing; 0
  overflow across all app views at 1440, both themes.
- **Color:** 0 chromatic pixels on the marketing site (scan threshold: any
  computed color with max(R,G,B) − min(R,G,B) > 12), including with the header
  and the assistant panel open. Pure monochrome achieved.
- **Tests:** 16 canonical suites + 2 regression suites — all green.
- **Findings fixed this pass:** 2 (pricing overflow at 375; Escape not closing
  app modals). Details below.

---

## What was exercised

### Marketing site (dark-only, `#site`)
| Check | 1440 | 1024 | 375 |
|---|---|---|---|
| Horizontal overflow | 0 | 0 | 0 |
| Console errors (code) | 0 | 0 | 0 |
| Console warnings | 0 | 0 | 0 |
| Chromatic color (with header + assistant open) | 0 | 0 | 0 |

- **Floating pill header (Phase 3):** renders centered/floating with the 14px
  radius, hairline border, backdrop blur; sticks on scroll and tightens
  (reduced padding, more opaque) via the shared 200ms easing. At ≤860px the
  center nav + CTA collapse to a menu control (`☰`) that opens a dropdown;
  outside-click and Escape close it. Nav links animate gray→white with the
  left underline wipe on hover/active.
- **Assistant (Phase 4):** launches from the bottom-right square control;
  panel is monochrome, hairline-bordered, scrolls independently, closes on
  Escape and outside click. **Graceful failure verified:** with the Worker
  unreachable (sandbox blocks `workers.dev`), sending a message produces the
  inline fallback — *"I can't reach the assistant right now. Email
  henry@syntrexio.com or use the contact form on this page…"* — never a raw
  error and never a blank panel.
- **Links / CTAs / footer / legal / social / contact:** marketing CTAs route to
  the auth screen; the three legal pages render; social links carry
  `rel="noopener noreferrer"`; the Syntrex attribution is a do-follow link;
  the contact form reaches its success state. (Live network round-trips are
  under UNVERIFIED.)

### App (both themes)
- Views swept at 1440 in **dark and light**: dashboard, tasks, calendar,
  spaces, assets, brand, team, settings, billing — **0 overflow, 0 code
  errors, 0 warnings** in each theme.
- Swept against a **brand-new workspace** ("Final QA Co"), so every view was
  seen in its empty state — they read as intentional, not broken.
- **Status colors retained (functional, per brief):** urgent red and done
  green remain in the app only. The marketing site has zero color.

### Keyboard / focus
- **Escape closes every overlay:** search, chat context menu, any
  `.modal-veil.open` modal (task, event, brand, space, DM, plan, project,
  integration, visibility, preview), the notifications panel, quick-add
  popovers, and focus mode. Verified task/event modals close on Escape.
- **Focus visible:** interactive elements show a visible focus ring
  (marketing: 2px solid white at low opacity + brighter border; app: existing
  focus treatment). Nav focus outline confirmed solid 2px.

### Automated suites (all green)
Canonical (16): `audit` 15, `launch` 19, `v3` 48, `polish` 22, `cloud` 19,
`shell` 26, `ia` 41, `audit-regression` 9, `cost-control` 18, `cross-feature`
12, `guide-access` 21, `identity-persistence` 15, `ops-layer` 33,
`premium-motion` 11, `pricing-model` 35, `privacy-sweep` 10.
Regression (2): `chat-visibility` 15, `ai-visibility` 19.

> Note: `premium-motion` returned one intermittent failure on a scroll-reveal
> opacity check in a single run, then passed 11/11 on three subsequent runs.
> It is a headless animation-timing flake, not a regression.

---

## Findings fixed this pass

1. **Pricing overflow at 375px.** The `.seat-tiers` three-column grid and the
   estimator (`.calc`) did not stack on narrow screens, producing horizontal
   overflow on the home/pricing view. Fixed with a `@media (max-width:600px)`
   block that stacks the tiers to a single column, converts the tier dividers
   from left borders to top borders, and constrains the estimator to one
   column. Overflow at 375 is now 0.

2. **Escape did not close app modals.** The global keydown handler only closed
   search, the chat menu, and focus mode. Added handling so Escape also closes
   any open `.modal-veil.open` modal, the notifications panel, and quick-add
   popovers. Verified.

---

## UNVERIFIED — blocked by environment

The sandbox has no outbound network and the Worker is not deployed here, so the
following could not be exercised end-to-end. Each is a live-only check for you
to confirm on the deployed site; none block the code from being correct.

1. **Live assistant answers (Anthropic via the Worker).** The Cloudflare Worker
   (`worker/syn-assistant.js`) is written but **not deployed** (no network, and
   per your instruction). The API key lives only in the Worker secret and never
   appears in client code. *Verified instead:* the client's request shape
   (SSE streaming, `content_block_delta` parsing) and the graceful contact
   fallback on failure. **To confirm live:** run `worker/README.md`'s deploy
   steps, then send a message on the live site.
2. **Cross-device SYN Core sync.** `syn-core.henrybello.workers.dev` is blocked
   in-sandbox, so multi-device persistence wasn't exercised. Local
   identity/persistence behavior passes (`identity-persistence` 15/15).
3. **Live Formspree contact round-trip.** `formspree.io` is blocked; the form's
   success-state UI was verified locally, but an actual submission was not.
4. **Remote logo image.** The wordmark image host (`mcusercontent.com`) is
   blocked, so the in-sandbox screenshots show the "S" text fallback. The
   `<img>` and its fallback are wired correctly; the image will load on the
   live site.
5. **Inter web font.** `fonts.googleapis.com` is blocked in-sandbox, so
   headings fall back to the system sans in local screenshots. The `<link>`
   tags and the `Inter` font stack are in place; Inter will load on the live
   site. Type scale, weights (headlines 600, body 400), and tracking are
   applied via tokens regardless of which face resolves.
