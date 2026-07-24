# syn-growth widget shell

The client-side widget a customer pastes into their website. This is the **shell** — it renders,
it is isolated from the host page, it is styled per brand, and it logs that it loaded. **No AI, no
message sending, no capture, no booking** — those land in later prompts. Sending is wired in Prompt 15.

## Embed

One tag, this exact shape:

```html
<script src="https://syn-growth.henrybello.workers.dev/w/widget.js"
        data-key="syn_pk_live_…" async></script>
```

On load the script reads its own `data-key`, calls `GET /w/config?k=…`, and renders. If the key is
**missing, invalid, revoked, or the origin is not allowlisted**, it renders **nothing** and logs one
clear `console.warn`. It never paints a broken or half-styled panel on a live site.

## Where the source lives

- **`worker/widget.js`** — the readable, lint/test-friendly source (this is what you edit).
- **`worker/syn-growth.js`** — embeds a **byte-identical** copy as the `WIDGET_JS` constant and
  serves it at `GET /w/widget.js`, so the Worker stays a single self-contained module (no bundler,
  dashboard-paste friendly). `worker/syn-growth.test.mjs` asserts the embed equals the file, so they
  can never drift. After editing `worker/widget.js`, re-embed with:

  ```sh
  node -e 'const fs=require("fs");const w=fs.readFileSync("worker/widget.js","utf8");
    if(w.includes("`")||w.includes("${"))throw new Error("widget must contain no backtick or ${");
    let s=fs.readFileSync("worker/syn-growth.js","utf8");
    s=s.replace(/const WIDGET_JS = String\.raw`[\s\S]*?`;/, "const WIDGET_JS = String.raw`"+w+"`;");
    fs.writeFileSync("worker/syn-growth.js",s);'
  ```

  (The widget deliberately uses no backtick and no `${` so `String.raw` reproduces it exactly.)

## Isolation — why every choice exists

The widget runs inside CSS it does not control. Defenses:

- **Closed shadow DOM** (`attachShadow({mode:"closed"})`), not an iframe (too heavy, breaks
  positioning) and not a plain div (inherits everything). All widget CSS is injected **inside** the
  shadow root; nothing lands in the host document.
- **Custom-element host** (`<syn-growth-root>`) so host stylesheets targeting `div`/`.class`/`#id`
  don't match it. On the host we set `all: initial` (resets inherited props that would otherwise
  leak through the shadow boundary), then `position: fixed`, `z-index: 2147483000` (just under the
  max, with headroom), and nothing else.
- **No `!important` as a substitute for isolation.** The only `!important` in the file is a local
  `.hidden{ display:none }` visibility toggle — not a defense against the host.
- **One global only:** `window.__synGrowth`. No `$`, no polyfills, no library.
- **Idempotent:** a second `<script>` on the same page is a no-op (guarded by `__synGrowth.loaded`).

Verified against a deliberately hostile page (`tests/fixtures/hostile.html`): `* { box-sizing:
content-box !important; font-family: Comic Sans !important }`, a lime-dashed element reset, and a
`z-index: 999999999` fixed box parked over the launcher. The widget renders clean and on top.

## What it renders

- A **launcher** — 56px circular control, 20px from the bottom + chosen side, `aria-label` = brand name.
- A **panel** (~380×600, clamped to `calc(100vw − 40px)` / `calc(100vh − 40px)`) with a header
  (brand name + close), a scrollable message area (one greeting bubble), and a composer (textarea +
  send). **Send does nothing yet** — Prompt 15.
- Closes on the close control, on **Escape**, and on **click-outside**.
- **Below 480px the panel goes full-screen** (inset 0, no radius) instead of floating.
- Open/closed state is remembered **for the session only** (`sessionStorage`).

## Styling from config

`GET /w/config` returns `{ install_id, brand:{name}, config }`. The widget reads:

| config key | meaning | default |
|---|---|---|
| `accent` | header/launcher/send color (validated: hex / rgb / rgba / hsl / named only) | `#111111` |
| `position` | `bottom-right` \| `bottom-left` | `bottom-right` |
| `greeting` | first bubble text (rendered via `textContent`, never `innerHTML`) | `Hi! How can we help?` |

Brand name and greeting are untrusted text and are always set with `textContent`. The accent is
sanitized against a small allowlist of color syntaxes before it enters any stylesheet. The widget is
neutral/light — it is the **client's** widget, not SYN-branded.

## The one write

On successful render the widget POSTs `/w/events` with `type: "conversation_started"` and an
idempotency key scoped to the session (`sessionStorage`). A page refresh does **not** double-count
(the server dedupes on the unique `idempotency_key`, and the widget also skips the re-POST once the
session flag is set); a genuinely new session counts once more. This is the **only** network write
in this shell.

## Verification

`node tests/growth-widget.mjs` runs the real Worker (node:sqlite D1 shim) behind a local HTTP server
and drives Chromium through: hostile-CSS render, no-CSS render, 1440/768/375 viewports, mobile
full-screen, double-load no-op, revoked key → nothing + one warn, wrong origin → nothing + one warn,
missing key → nothing + one warn, "only `__synGrowth` added to `window`", closed shadow root, and
`conversation_started` exactly once per session. Screenshots go to `$SHOTS`.
