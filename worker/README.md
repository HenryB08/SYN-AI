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

The site calls the constant `SYN_ASSISTANT_URL` in `index.html`. It defaults to
`https://syn-assistant.henrybello.workers.dev`. If your deployed URL differs,
update that one line.

## Contract

- **Request** `POST` JSON `{ "messages": [{ "role": "user"|"assistant", "content": "…" }], "stream": true }`
- **Response** streamed Anthropic SSE (`text/event-stream`) when `stream` is true,
  otherwise the Anthropic JSON body. The client parses `content_block_delta`
  events for streaming and falls back to a contact-form message on any failure.
- CORS is open (`Access-Control-Allow-Origin: *`); tighten to the site origin if
  you prefer.
