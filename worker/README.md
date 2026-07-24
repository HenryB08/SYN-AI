# SYN marketing assistant — Cloudflare Worker

Proxies the public SYN site's assistant to the Anthropic API. The API key lives
only in the Worker (as a secret) and never reaches the browser. The SYN system
prompt is baked into `syn-assistant.js`, so the endpoint can't be repurposed.

## Deploy (run these yourself — the sandbox has no network)

```sh
cd worker

# 1. Publish the Worker
npx wrangler deploy

# 2. Set the API key as a secret (paste the key when prompted — do NOT commit it)
npx wrangler secret put ANTHROPIC_API_KEY
```

`wrangler deploy` prints the Worker URL, e.g.
`https://syn-assistant.<your-subdomain>.workers.dev`.

## Wire it to the site

The site calls the constant `SYN_ASSISTANT_URL` in `js/01-boot-auth.js`. It
defaults to `https://syn-assistant.henrybello.workers.dev`. If your deployed URL
differs, update that one line.

## Contract

- **Request** `POST` JSON `{ "messages": [{ "role": "user"|"assistant", "content": "…" }], "stream": true }`
- **Response** streamed Anthropic SSE (`text/event-stream`) when `stream` is true,
  otherwise the Anthropic JSON body. The client parses `content_block_delta`
  events for streaming and falls back to a contact-form message on any failure.

## CORS / origin lock

CORS is an **explicit allowlist** — never a wildcard. `syn-assistant.js` reflects
the specific requesting origin and **fails closed** (403, no CORS headers) when
the `Origin` header is absent or not on the list. The allowlist is at the top of
`syn-assistant.js`:

```js
const ALLOWED_ORIGINS = [
  "https://henryb08.github.io",   // current GitHub Pages host
  "https://syn.syntrexio.com",    // future custom domain
];
```

Keep both entries during the DNS cutover so the switch is zero-downtime and
reversible; remove the github.io entry once the domain is fully live.

## syn-core — now in this repo (`worker/syn-core.js` is the source of truth)

`syn-core` (the D1-backed KV + Anthropic proxy at
`syn-core.henrybello.workers.dev`) previously had **no source in this repo**. As of
the access-gate work, **`worker/syn-core.js` is the authoritative source** — deploy
that file as the syn-core Worker (paste into the dashboard, or `wrangler deploy`
from a dir containing it). It already includes the origin allowlist (same two
origins as above, reflecting the specific origin and failing closed).

⚠️ **It carries a TEMPORARY ACCESS GATE — not an auth system.** A single-credential
bouncer (`POST /gate`) so the private-beta app can be demoed safely. **Prompt 26
replaces this gate with real auth.**

### Required configuration (set in the Cloudflare dashboard)

- **D1 binding `DB`** — holds the KV surface. `worker/syn-core.js` reads/writes a
  table matched by the `KV_TABLE` / `KV_KEY_COL` / `KV_VAL_COL` constants at the top
  of the file. **If your existing D1 uses different names, change those three
  constants to match so live workspace data keeps resolving.** A second table,
  `gate_rl`, is auto-created for rate limiting and holds no workspace data.
- **Secrets** (set each with `npx wrangler secret put <NAME>`, never commit):

  | Secret | Purpose |
  |---|---|
  | `ANTHROPIC_API_KEY` | Anthropic key for the `/v1/messages` proxy |
  | `GATE_EMAIL` | the one allowed sign-in email (the single name on the list) |
  | `GATE_PASSWORD` | its password — **you choose it; never commit or hardcode it** |
  | `GATE_SIGNING_KEY` | random secret used to HMAC-sign the access token |

### How the gate works

- `POST /gate {email,password}` → constant-time compares against `GATE_EMAIL` /
  `GATE_PASSWORD`; on success returns a 7-day HMAC token (signed with
  `GATE_SIGNING_KEY`). Generic 401 on failure; **429 after 5 failed attempts per IP
  for 15 minutes**.
- **Every `/kv/` and `/v1/messages` request requires that token** (`Authorization:
  Bearer …`) and is 401'd without a valid one. The client posts to `/gate`, stores
  the token, and attaches it to every request; a 401 sends the app back to sign-in.
- `GET /` stays a public health probe (the app calls it at boot before login).

### Demo setup note

The gated sign-in signs in by **email only** after the gate passes (the gate is the
auth). So `GATE_EMAIL` should match the email of an **existing workspace admin** in
your demo data. Create that demo workspace **before** turning the gate on (the New
Workspace / Join tabs are hidden while gated). Set `GATE_PASSWORD` to whatever you
want the single login password to be.

### Deploy

```sh
# from a directory containing worker/syn-core.js (or paste it into the dashboard)
npx wrangler deploy
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put GATE_EMAIL
npx wrangler secret put GATE_PASSWORD
npx wrangler secret put GATE_SIGNING_KEY
```
