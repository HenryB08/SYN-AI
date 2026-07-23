# Syntrexio.com Visual Identity — Extracted Spec

Source: full HTML of syntrexio.com as pasted into the brief (2026-07-22).
**Caveat, stated up front:** the paste references `styles.css`, which was NOT included. Everything
below marked **[extracted]** comes verbatim from inline styles, the inline `<style>` block, the
fonts `<link>`, or JS in the paste. Everything marked **[derived]** is inferred from strong evidence
in the paste and is flagged for review. If `styles.css` contradicts a derived value, correcting the
token layer is a one-line change per token.

## 1. Fonts [extracted]
Loaded from Google Fonts:
- **Outfit** 600 / 700 / 800 — display + headings (FAQ `<h3>` explicitly `font-family:'Outfit'`,
  `letter-spacing:-.2px`; section h2s render 800 weight, see §2).
- **Space Grotesk** 400 / 500 / 600 / 700 — loaded; the only candidate for body text (no other
  body-capable family is loaded). **[derived: body role]**
- **Exo 2** 400 / 600 / 700 — the label voice. Used inline everywhere for eyebrows, micro-labels,
  metadata: 9–13px, letter-spacing 0.5–2px (≈0.05–0.2em), uppercase, in accent or dim gray.
- No monospace family is loaded anywhere. **App consequence:** IBM Plex Mono leaves the label
  system; labels become Exo 2. True code blocks fall back to the `ui-monospace` system stack.

## 2. Type scale [extracted from inline styles]
- Section h2: `clamp(30px,3.2vw,52px)`, **weight 800**, `letter-spacing:-1.5px` (≈-0.03em), lh 1.1.
- Card/why titles: 17–22px, weight 600–800, ls -0.2 to -0.5px.
- Body: 14–16px, line-height 1.7–1.8, color #888888.
- Micro/eyebrow: Exo 2, 9–11px, ls 1–2px, uppercase.
- Stat numerals: 32px, weight 800, ls -1.5px.
**Identity:** bold, tightly-tracked headings (NOT light-weight); tall relaxed body; tiny wide labels.

## 3. Color palette
Dark, navy-tinted monochrome with white-alpha ladders and a single blue accent family.
- Backgrounds **[extracted]**: `#00020d` (hero), `#000000` (sections), `#06070d` (overlay navy,
  used at 0.70–0.78 alpha), `var(--nv)`/`var(--nv2)`/`var(--off)` [values in missing styles.css].
- Cards **[extracted]**: `#111111` bg, `#222222` border, occasionally `#2a2a2a`.
- Text **[extracted]**: `#e2e2e2` primary, `#888888` secondary, `#666666`/`#444444` dim,
  `rgba(255,255,255,.7/.55/.4/.35/.25/.18)` descending ladder.
- Hairlines **[extracted]**: `rgba(255,255,255,.06–.12)`; dropdown ring `rgba(255,255,255,.08)`.
- Light-context ink **[extracted from form-fallback JS]**: navy `#08152e`, gray-blue `#6b7a99` —
  syntrexio's own light-surface ink pair; used to derive the app's light theme.
- Accent `--bl` **[derived]**: value lives in missing styles.css; the var name ("bl"), nebula
  canvas colors `rgba(30,60,140) / rgba(20,40,100) / rgba(10,30,80)`, blue-white starfield, and
  the `#08152e / #6b7a99` navy-blue ink family all indicate an electric blue.
  **Chosen: `#5B8CFF`** (dark contexts; ≈5:1 on #111) / **`#1E4FD6`** (light contexts; ≈6.9:1 on
  white). Hover `#7FA5FF`, active `#3E6EE8`. FLAGGED FOR REVIEW.
- `grad-text` **[derived]**: gradient accent text; implemented as `linear-gradient(100deg,
  #7FA5FF, #E2E2E2)` clipped to text. FLAGGED FOR REVIEW.

## 4. Buttons & links
- Shape **[extracted]**: pill — mobile CTA is explicit: `background:#e2e2e2;color:#000;
  border-radius:999px;font-weight:600`.
- Primary (`.btn.bg`) **[derived]**: light pill, `#E2E2E2` bg / near-black ink (per the explicit
  mobile CTA). Padding 14–16px 36px, font-size 12px, letter-spacing 1px.
- Ghost (`.btn.bb`) **[derived]**: bordered white-alpha pill on dark.
- Links **[extracted]**: dim gray → `#e2e2e2` on hover, `transition:color .15s`; footer links
  underlined by 1px `rgba(255,255,255,.15)` borders.
- FLAGGED: `.bg` could plausibly mean "blue gradient"; light-pill has the only hard evidence.

## 5. Radii [extracted]
16px (dropdown panel, example cards) · 14px (FAQ items) · 12px (why-cards, images) · 10px (social
buttons) · 8px (card images) · 999px (pill buttons) · 50% (avatars/orbs). Soft, generous system.

## 6. Elevation & shadows [extracted]
`box-shadow:0 16px 48px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.08)` (dropdown) — large soft
drops + a 1px white ring on floating elements. Subtle white glows on featured elements.

## 7. Motion [extracted]
- Hovers: `.15s`–`.2s`, property-specific (`color .15s`, `background .2s`, `all .2s`).
- Page transition: `opacity 0.3s ease`.
- Reveals: `0.85s cubic-bezier(0.16,1,0.3,1)` translate/wipe; IntersectionObserver-staggered.
- Respects `prefers-reduced-motion`.

## 8. Iconography [extracted]
Inline SVG. Chrome icons stroke-based (`stroke-width` 1.8–2, round caps); decorative card icons
white fill at layered opacities. **App keeps its single-weight stroke system** (matches the chrome
style) at 1.6–1.8.

## 9. Voice [extracted]
Plain-spoken, confident, outcome-first, short declaratives. "You describe the problem. We build
the system that fixes it." "We build it. We hand it over. It works." "No surprises, no hidden
fees." Sentence case, no exclamation marks, benefits before mechanics. Motto: "INNOVATE.
AUTOMATE. ELEVATE."

## 10. App token mapping (implemented in `index.html`)
| App token | Dark value | Light value (derived — syntrexio is single-theme; FLAGGED) |
|---|---|---|
| `--bg` | `#020409` (blend of #00020d/#000) | `#EEF1F6` (cool paper from the #08152e family) |
| `--surface-0..3` | `#06070D → #101114 → #16181D → #1D2026` (#111 card anchor) | `#FFFFFF → #F8FAFD → #EFF2F7 → #E4E9F1` |
| `--hairline` / strong | `rgba(255,255,255,.08)` / `.14` (#222-on-#111 ≈ .08–.13) | `rgba(8,21,46,.10)` / `.20` |
| `--text` /2/3/4 | `#E2E2E2` / `rgba(226,.72)` / `.55` / `.40` | `#08152E` / `.76` / `.58` / `.44` — their own light ink |
| `--gold` (accent; name kept for diff-safety) | `#5B8CFF` | `#1E4FD6` |
| `--btn` / `--btn-ink` (new: primary button) | `#E2E2E2` / `#050608` | `#08152E` / `#FFFFFF` |
| `--amber` (new: escalation/warn — semantics preserved, never blue) | `#E8B44C` | `#8A6414` (AA on light) |
| `--good` / `--bad` / `--info` | kept `#7FD99A` / `#FF7A6B`; info = accent | `#2E7D46` / `#C0392B` (AA) |
| Radii | `--r-xs 6 · --r-sm 8 · --r-md 12 · --r-lg 16 · --r-full 999` | same |
| Elevation | `--shadow-pop: 0 16px 48px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.08)` | `0 16px 48px rgba(8,21,46,.18), ring rgba(8,21,46,.06)` |
| Motion | hovers .18s; reveals `cubic-bezier(0.16,1,0.3,1)` | same |
Focus rings: 2px `--gold` (accent blue) — derived; site shows no custom focus style.
Escalation ladder (Follow-ups/Dependencies): upcoming neutral → today/1-3d `--amber` → 4+/14+ red.
AA notes: #888 on #111 = 4.79:1 ✓; accent #5B8CFF on #111 ≈ 5:1 ✓; light accent #1E4FD6 on white
≈ 6.9:1 ✓; light amber darkened to #8A6414 for AA as text (site never shows amber — derived).
