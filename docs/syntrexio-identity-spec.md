# Syntrexio.com Visual Identity — Extracted Spec (v2, corrected)

Source: the current syntrexio.com `index.html` uploaded from the syntrexio GitHub repo
(2026-07-23), replacing the stale cached paste that carried an old blue identity.
**Caveat:** `styles.css` is still referenced but not present in the upload, so token values
behind `var(--bl)` etc. are resolved from this file's own inline evidence plus the owner's
direct statement that the live site has **no blue anywhere**. Every value is marked
**[extracted]** (verbatim in the file) or **[derived]** (inferred, flagged).

## 1. The corrected core finding
The old paste's blue accent was stale. The real identity is **monochrome white-on-dark**:
- 71 occurrences of `rgba(255,255,255,…)` washes/borders/glows; `#e2e2e2` ×45 is the single
  dominant chrome color (headlines, accents, hover states, button fills, light panels).
- Zero blue accent hexes; zero warm accent hexes. The only chromatic content is
  **photography** (golden-hour imagery under `rgba(6,7,13,.70–.78)` overlays) and a
  sub-perceptual starfield nebula (indigo at 2.8–4.5% alpha — atmosphere, not accent).
- Hover accents are literally white: `onmouseover … borderLeftColor='#e2e2e2'`,
  `background='rgba(255,255,255,0.15)'`; the avatar glow is white.
- Therefore **`--bl` (label/rule-line/card-number accent) = `#E2E2E2`** [derived — owner
  confirmed no-blue; all in-file accent literals are #e2e2e2/white].

## 2. Fonts [extracted]
Outfit 600/700/800 (headlines), Space Grotesk 400–700 (body), Exo 2 400/600/700 (labels).
No monospace loaded. Unchanged from v1.

## 3. Type [extracted]
h2 `clamp(30px,3.2vw,52px)` weight 800 ls −1.5px lh 1.1; card titles 17–22px/600–800;
body 14–16px lh 1.7–1.8 `#888888`; labels Exo 2 9–11px ls 1–2px uppercase.
Label pattern: **short rule line + label** — `28px × 2px` bar in the accent, 12px gap,
then the uppercase Exo 2 label (— BUILD YOUR PRESENCE). Numbered cards (01–12).

## 4. Palette
- Darks [extracted]: `#00020d` hero, `#000000` sections, `#06070d` overlay dark,
  cards `#111111` with `#222222`/`#2a2a2a` borders.
- Text [extracted]: `#e2e2e2` primary, `#888888` secondary, `#666/#444` dim,
  `rgba(255,255,255,.7/.55/.4/.35/.25/.18)` ladder.
- Accent [derived, per §1]: **white `#E2E2E2`** — labels, rule lines, card numbers, link
  hovers. Soft wash `rgba(255,255,255,.08)` [extracted: FAQ chip, socials, section glows].
- Light panels [extracted]: `#e2e2e2` backgrounds with dark ink (`var(--gr)/var(--grd)`),
  `#dde3f0` border seen once in a light context.
- `grad-text` [derived]: a light shimmer, not a color — implemented white→gray.

## 5. Buttons [extracted]
Pills (999px). Primary: light `#e2e2e2` fill, black ink (mobile CTA explicit). Ghost:
bordered white-alpha pill. 12px, ls 1px, padding 14–16px 34–36px. Hovers lighten
(`rgba(255,255,255,0.15)` fills), `transition .2s`.

## 6. Radii / elevation / motion [extracted]
Radii 8/10/12/14/16 + 999 pills + 50% circles. Elevation `0 16px 48px rgba(0,0,0,.6)` +
1px `rgba(255,255,255,.08)` ring. Section glows: radial white 8%. Hovers .15–.2s; page fade
.3s; reveals `.85s cubic-bezier(0.16,1,0.3,1)`.

## 7. Voice [extracted]
Unchanged: plain, confident, outcome-first. "We build it. We hand it over. It works."
Motto "INNOVATE. AUTOMATE. ELEVATE."

## 8. App token mapping (implemented)
| Token | Dark | Light (derived — site is single-theme; FLAGGED FOR REVIEW) |
|---|---|---|
| `--bg` / surfaces | `#020409 / #06070D / #101114 / #16181D / #1D2026` (#111-card anchor, kept) | neutral paper `#ECEBE7 / #FFFFFF / #F8F7F4 / #EFEEEA / #E4E3DE` |
| hairlines | `rgba(255,255,255,.08)/.14` | `rgba(17,17,17,.10)/.20` |
| text ladder | `#E2E2E2` /.72/.55/.40 | `#131313` /.74/.62/.46 |
| **accent** (`--gold` name kept) | **`#E2E2E2`** hover `#FFFFFF` active `#C9CDD6`; ink-on-accent `#0A0A0A` | **`#111111`** hover `#000` active `#333`; ink `#FFFFFF` — light theme inverts the monochrome accent, mirroring the site's own light panels (dark ink on `#e2e2e2`) |
| `--accent-soft` | `rgba(255,255,255,.08)` [extracted] | `rgba(17,17,17,.08)` |
| primary button | `#E2E2E2` pill / black ink [extracted] | `#111111` pill / white ink (inversion, documented) |
| `--amber` (escalation/warn — semantics preserved) | `#E8B44C` | `#8A6414` |
| `--good`/`--bad` | `#7FD99A`/`#FF7A6B` | `#2E7D46`/`#C0392B` |
| `--info` | neutral `#9AA3B2` (no blue) | `#4A5560` |
| neutral rings (was accent-ring literals) | `rgba(136,136,136,α)` — visible in both themes, monochrome | same |
| default entity color (projects/events) | `#8E959F` neutral slate (site defines no equivalent; a white dot would vanish on light surfaces — documented) | same |
| focus ring | 2px `--gold` → white on dark / near-black on light — always visible | — |
AA spot-measurements: accent `#E2E2E2` on `#101114` 14.6:1; ink `#0A0A0A` on `#E2E2E2`
15.4:1; light accent `#111111` on `#F8F7F4` 16.9:1; amber pairs unchanged from v1 (9.9:1
dark / 5.1:1 light); light `text-3` kept at the raised .62 (5.1:1).
