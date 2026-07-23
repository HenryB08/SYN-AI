# SYN Visual + Functional Audit

Branch: `syn-visual-audit`. This audit was run against the built `index.html` in a
headless Chromium (Playwright), toggling light/dark on every route and exercising
interactive elements directly. Nothing below is marked **PASS** unless it was actually
run; anything only inferred from the code is marked **UNVERIFIED** with the reason.

## Summary

- **Theme audit (6a):** 0 real contrast failures remaining in **either** theme across
  every marketing and app view, after fixes. Automated scan of every rendered text node
  vs. its effective background, both `colorScheme:light` and `colorScheme:dark`.
- **Functional audit (6b):** 50/50 exercised interactions PASS. 2 items UNVERIFIED
  (live AI generation; cross-browser/cloud sync) — both blocked by the sandbox egress
  policy, not app defects. Corroborated by the full test suite: **16 suites, 367 checks,
  all green.**
- **State audit (6c):** per-user privacy holds (a member cannot see an admin's private
  task); device-local persistence + flush-on-unload verified. Cross-device/cloud sync is
  UNVERIFIED (requires SYN Core, network-blocked here).
- **Console (6d):** 0 errors and 0 warnings on every route in both themes (third-party
  CDN/font/API requests that the sandbox blocks are excluded — they are environment
  limits, not app errors).
- **Responsive:** every audited view holds from 1440px to 375px with no horizontal
  overflow (one 6px topbar overflow was found and fixed).

## Pass / Fail / Unverified

### 6a — Theme (light + dark, every view)
| Check | Result |
|---|---|
| Marketing home, all sections, both themes | PASS |
| Legal pages (terms / privacy / acceptable-use), both themes | PASS |
| Sign-in scene, both themes (pinned dark by design) | PASS |
| All 16 app views, both themes | PASS |
| Placeholder / muted / secondary text meets AA | PASS (after fixes) |
| Badges, priority labels, status chips meet AA | PASS (after fixes) |
| New dark illustration band (labels, titles, dividers) meets AA | PASS (after fix) |
| Focus rings visible in both themes | PASS |
| Console clean on every route, both themes | PASS |
| No horizontal overflow 1440→375 | PASS (after fix) |

### 6b — Functional (each interaction exercised)
| Area | Result |
|---|---|
| Marketing: nav (Product/Pricing), legal pages, back-to-home | PASS |
| Marketing: pricing calculator updates, footer links, SYN 2.0 banner clickthrough | PASS |
| Auth: Get Started/Sign In → auth; tabs (Sign In / New Workspace / Join Team) | PASS |
| Auth: forgot-password affordance (info; full reset needs SYN Core) | PASS |
| New workspace creation; admin role assigned | PASS |
| Brand profile: create, select, edit + save (memory) | PASS |
| Tasks: create, edit, assign, move status, complete | PASS |
| Tasks: board view + list view render | PASS |
| Calendar: create event; renders; `.ics` builder + per-event/workspace export | PASS |
| Spaces: create; post human message (active thread) | PASS |
| DMs: start + post | PASS |
| People directory renders | PASS |
| Assets: upload (create); permission change (private→workspace) | PASS |
| Follow-ups: create + complete | PASS |
| Dependencies: create | PASS |
| Activity: log + renders | PASS |
| Weekly Recap: renders (template narrative) | PASS |
| Rollup: renders (admin); CSV export present | PASS |
| Global search returns results | PASS |
| Notifications bell present | PASS |
| Settings: renders, live team code, admin billing | PASS |
| AI chat: private compose UI + mode toggles; shared AI space creatable | PASS |
| AI chat: **live model generation output** | **UNVERIFIED** — Anthropic API blocked by sandbox egress (proxy 403). UI flow, metering/gating, and offline fallback verified; model output not exercisable here. |

### 6c — State
| Check | Result |
|---|---|
| Per-user privacy: member cannot see admin's private task (canSee=false, not listed) | PASS |
| Persistence mode active (device / localStorage here) | PASS |
| Flush-on-unload handlers (`visibilitychange` hidden + `pagehide` → `flushPendingWrites`) intact | PASS |
| Data persists across in-browser reload | PASS |
| **Cross-browser / cross-device sync** | **UNVERIFIED** — requires SYN Core cloud (worker URL blocked by sandbox egress). Device-local persistence verified; cloud sync not exercisable here. |

### 6d — Console
| Check | Result |
|---|---|
| Zero errors on every marketing + app route, both themes | PASS |
| Zero warnings on every route, both themes | PASS |

## What was fixed in this audit

**Phase 1 — Images**
- Re-exported all 8 WebP at quality 90 (were crushed to 4–12KB). Sources are 500px
  (see limitation below).
- Killed the systemic over-zoom: every image container's `aspect-ratio` now matches its
  source, so `object-fit:cover` no longer crops into a corner; foreground art (hero) is
  sized near-native (~1.3×, was ~3×), atmospheric backgrounds anchored at natural aspect.
  Native dimensions are commented above every image rule.
- Brand-engine feature card now shows a real dark-mode Brand Profile screenshot (matching
  its siblings) instead of the abstract monolith render.

**Phase 2 — Logo**
- Replaced the remote-URL mark (which failed offline → faint "S", and rendered white-on-
  white in light mode) with a self-contained lockup: white Syntrex aperture ring on a
  `#2A2A2A` tile, inline SVG, identical in both themes. Applied to header, footer,
  sign-in, boot, sidebar, empty states, favicon, and a rendered `img/og-lockup.png`.

**Phase 3 — Sign-in**
- Rebuilt as a full-viewport dark scene (no dead black); pinned dark in both themes,
  fixing the light-mode pearl-card / faint-text bug. Holds 1440→375.

**Phase 4 — Announcement + unused art**
- SYN 2.0 announcement strip under the header; monolith re-homed in the CTA band;
  brand-ring placed as the Proof emblem. All 8 renders now have a visible position.

**Phase 5 — Feature section**
- Rebuilt as a Linear-style dark illustration band: six original solid-lit isometric
  figures (not wireframes), FIG labels, hairline column dividers, drift + hover animation
  (reduced-motion safe).

**Phase 6 — Audit fixes**
- Primary "Get Started" button: champagne fill `#B8892E` + charcoal ink (5.2:1; was the
  darker `--gold` at 3.07:1).
- `--text-4` muted-label token bumped in all three scopes (app light .46→.60, app dark
  .40→.54, luminous .48→.62) so muted/secondary labels (guide counts, cost-meter caption,
  section numbers) clear AA as text.
- `--faint` (luminous) .62→.66 and auth-scene `--faint` .42→.60 (legal meta, auth note).
- Light-theme `.pri-high` priority label darkened `#EE9A5B`→`#A8551A` (was 1.9:1 on white).
- App-light `--good` darkened for the approved-claim tag AA margin.
- SYN 2.0 strip scrim strengthened so the gold CTA stays AA over the bright ring art.
- Dark illustration band section-number opacity .4→.6 (was 3.74:1 on the dark band).
- Topbar 6px horizontal overflow at ≤430px fixed (min-width:0 + tightened mobile gaps).

## Found but not fixable here (with reason)

| Item | Reason |
|---|---|
| Live AI chat / image / recap **generation output** | The Anthropic API host is blocked by this session's egress policy (proxy returns 403). The UI, metering/daily-caps, and offline-fallback paths are verified; actual model output cannot be exercised in this sandbox. Needs a session with network access to confirm. |
| Cross-browser / cross-device persistence (SYN Core cloud sync) | The SYN Core worker URL is blocked by the same egress policy, so the app runs in device/localStorage mode here. In-browser reload persistence and the flush-on-unload path are verified; true multi-browser sync needs SYN Core reachable. |
| Genuinely high-resolution / large-format hero art | The only image sources in git history (repo root + `img/`) are **500px** on the long edge — there are no higher-res originals. Quality is maxed for the source and over-zoom is fixed, but razor-sharp large-format treatments would require new high-res source files from the owner. |

## Notes on the automated contrast scan

The scanner walks every rendered text node and computes contrast against the nearest
opaque ancestor background. It cannot read **gradient** or **image** backgrounds, which
produces false positives that were each verified by hand and excluded:
- `#site` marketing/legal pages in dark-`colorScheme`: the page renders on the pearl
  radial-gradient (verified by screenshot — dark text on pearl), but the scanner falls
  through to the dark document body. Not a real miss.
- Avatars: gradient fills — light-theme is white text on a dark gradient, dark-theme is
  dark text on a light gradient; both high-contrast (verified by reading computed styles).
- Gradient-clipped headline text (`.grad`, `.accent`): the visible color is the gradient,
  not the `transparent` fill the scanner reads.
