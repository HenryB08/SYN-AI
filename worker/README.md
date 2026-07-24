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

## syn-core needs the SAME allowlist (source lives elsewhere)

`syn-core` (the D1-backed KV + Anthropic proxy at
`syn-core.henrybello.workers.dev`) is **not in this repo**, so it can't be edited
here. It is currently origin-locked to `henryb08.github.io` alone, which means the
app would be rejected on `syn.syntrexio.com`. Apply the same allowlist + specific-
origin reflection to syn-core's request handler. The shape (adapt to syn-core's
existing code):

```js
const ALLOWED_ORIGINS = [
  "https://henryb08.github.io",
  "https://syn.syntrexio.com",
];
function isAllowedOrigin(o) {
  return typeof o === "string" && ALLOWED_ORIGINS.includes(o);
}
function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,     // reflect the specific origin, never "*"
    "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}
export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    if (!isAllowedOrigin(origin)) {                        // fail closed
      if (request.method === "OPTIONS") return new Response(null, { status: 403 });
      return new Response("Forbidden origin", { status: 403 });
    }
    if (request.method === "OPTIONS")                       // preflight → reflect origin
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    // … existing KV GET/PUT + Anthropic proxy logic …
    // Make sure EVERY response merges { ...corsHeaders(origin) } into its headers.
  },
};
```

Deploy syn-core from wherever its source lives:

```sh
cd <syn-core-source-dir>
npx wrangler deploy
```
