# Luminous Tech — marketing imagery + light-first skin

A major visual milestone: the **marketing site** is re-derived light-first from a family of
bright pearl/champagne crystal renders ("Luminous Tech"). The **app keeps dark as its default**
(with the existing light theme) — the luminous skin is scoped to `#site` only, so the app tokens
are never touched. The sign-in screen is the deliberate seam where dark begins.

## Images (`img/`)
Committed to the repo (source URLs were temporary). Each shipped as **WebP with PNG fallback**
via `<picture>`; a 320w variant exists for below-the-fold economy. Source renders are ≤500px on
their long edge, so the srcset tops out at native — genuine 2560/1440 variants aren't possible
without upscaling (which adds bytes for no quality), and this is intentional.

| File | Role |
|---|---|
| `hero-core.png` | Hero full-bleed crystal field, dissolved into pearl at left + bottom, parallax + scroll crossfade |
| `syn2-banner.png` | SYN 2.0 announcement banner, full-bleed, typographic overlay in the calm sky region |
| `monolith.png` | "What SYN does" brand-engine pillar visual, soft-masked vertical |
| `weave.png` | "How it works" full-bleed background behind the steps, top/bottom edges dissolved |
| `ledger.png` | Pricing — feathered behind the calculator at 15% opacity |
| `threshold.png` | Sign-in side panel; bridges the luminous site into the dark workspace |
| `first-light.png` | Guide header band (app side), dissolved edge |
| `brand-ring.png` | `og:image` + `twitter:image` for link previews |

## Palette (sampled from the imagery)
- Pearl base `#FBF4E9`; surfaces `#FFFFFF / #FBF6EE / #F5ECDD / #EDE0CC`.
- Warm charcoal text `#241E17` (ladder .76 / .62 / .48); warm-grey hairlines `rgba(74,58,36,.12/.22)`.
- **Champagne-gold accent**: `#8A6410` for text/links (AA-safe on pearl); primary buttons fill
  `#B8892E` with charcoal ink `#241E17`. Hero headline gradient `#B8892E → #7A560C`.

## Integration rules (enforced)
No image is ever a hard-edged rectangle. Every placement is either a **full-bleed section
background** with content overlaid and edges dissolved via `mask-image` gradients into the page
background, or a **soft-masked feature visual** with a large radius and a feathered edge. Product
micro-screenshots (dark UI) are top-feathered into their cards so no hard line survives. The dark
hero product screenshot is retired on the luminous hero — the crystal field is the hero visual.

## Motion (reuses the existing system)
Images enter with a **blur-to-sharp reveal** (`filter: blur(12px)` / `opacity:0` → resolved over
600–800ms on first view via IntersectionObserver). Hero parallax drifts ~5% and **crossfades out
on scroll** so the crystal melts into the next section. Everything collapses to static under
`prefers-reduced-motion`.

## Performance
Eight WebP total **62KB** (95% smaller than the PNGs). Above-the-fold added image weight is the
hero alone (~8KB WebP, preloaded); everything below the fold is `loading="lazy"`. Well under the
400KB above-fold budget. Added JS: parallax/crossfade extends the existing motion functions (a few
hundred bytes), no new libraries.

## AA
All 13 measured luminous pairs pass WCAG AA (see `/tmp/lum_aa.mjs`); the app's dark + light themes
are unchanged and still pass.
