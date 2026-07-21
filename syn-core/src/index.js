// SYN Core v1 — Cloudflare Worker backend for the SYN platform.
// Jobs: AI proxy (Anthropic), shared KV storage (D1), email invites (Resend).

const ALLOWED_MODELS = new Set(["claude-sonnet-4-6", "claude-haiku-4-5-20251001"]);
const MAX_TOKENS_CAP = 8000;
const MAX_VALUE_BYTES = 2 * 1024 * 1024; // 2MB

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, x-syn-app",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
};

function withCors(headers = {}) {
  return { ...CORS_HEADERS, ...headers };
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: withCors({ "Content-Type": "application/json", ...headers }),
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: withCors() });
    }

    // Health check — the only unauthenticated route.
    if (request.method === "GET" && pathname === "/") {
      return json({ ok: true, service: "syn-core" });
    }

    if (!env.APP_TOKEN || request.headers.get("x-syn-app") !== env.APP_TOKEN) {
      return json({ error: "unauthorized" }, 401);
    }

    try {
      if (request.method === "POST" && pathname === "/v1/messages") {
        return await handleMessages(request, env);
      }
      if (pathname.startsWith("/kv/")) {
        const key = decodeURIComponent(pathname.slice("/kv/".length));
        if (!key) return json({ error: "missing key" }, 400);
        if (request.method === "GET") return await handleKvGet(key, env);
        if (request.method === "PUT") return await handleKvPut(key, request, env);
        return json({ error: "method not allowed" }, 405);
      }
      if (request.method === "POST" && pathname === "/invite") {
        return await handleInvite(request, env);
      }
      return json({ error: "not found" }, 404);
    } catch (err) {
      return json({ error: "internal_error", message: err.message }, 500);
    }
  },
};

// --- AI proxy ---

async function handleMessages(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  if (!ALLOWED_MODELS.has(body.model)) {
    return json(
      { error: "model not allowed", allowed: [...ALLOWED_MODELS] },
      400
    );
  }

  if (typeof body.max_tokens !== "number" || body.max_tokens > MAX_TOKENS_CAP) {
    body.max_tokens = MAX_TOKENS_CAP;
  }

  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  // Pass the body straight through (SSE streams stay unbuffered), add CORS.
  const headers = withCors({
    "Content-Type": upstream.headers.get("Content-Type") || "application/json",
  });
  return new Response(upstream.body, { status: upstream.status, headers });
}

// --- Shared storage (D1) ---

async function handleKvGet(key, env) {
  const row = await env.SYN_DB.prepare("SELECT value FROM kv WHERE key = ?")
    .bind(key)
    .first();
  return json({ value: row ? row.value : null });
}

async function handleKvPut(key, request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  if (typeof body.value !== "string") {
    return json({ error: "value must be a string" }, 400);
  }
  if (new TextEncoder().encode(body.value).length > MAX_VALUE_BYTES) {
    return json({ error: "value exceeds 2MB limit" }, 413);
  }

  await env.SYN_DB.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
    .bind(key, body.value, new Date().toISOString())
    .run();

  return json({ ok: true });
}

// --- Email invites (Resend) ---

async function handleInvite(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const { toEmail, orgName, inviterName, joinCode, appUrl } = body;
  for (const [name, value] of Object.entries({ toEmail, orgName, inviterName, joinCode, appUrl })) {
    if (typeof value !== "string" || !value.trim()) {
      return json({ error: `missing or invalid field: ${name}` }, 400);
    }
  }

  if (!env.RESEND_API_KEY) {
    return json({ ok: false, reason: "email_not_configured" });
  }

  const subject = `${inviterName} invited you to ${orgName} on SYN`;
  const esc = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const html = `
    <div style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #1a1a1a;">
      <h2 style="margin: 0 0 16px;">Join ${esc(orgName)} on SYN</h2>
      <p>${esc(inviterName)} has invited you to join <strong>${esc(orgName)}</strong> on SYN.</p>
      <p style="margin: 24px 0;">
        <a href="${esc(appUrl)}" style="background: #1a1a1a; color: #ffffff; padding: 12px 24px; border-radius: 6px; text-decoration: none; display: inline-block;">Open SYN</a>
      </p>
      <p>Once you're in, choose <strong>Join Team</strong> and enter this code:</p>
      <p style="font-size: 24px; font-weight: bold; letter-spacing: 2px; margin: 16px 0;">${esc(joinCode)}</p>
      <p style="color: #666; font-size: 14px;">Join codes rotate every 30 minutes — join soon, or ask ${esc(inviterName)} for a fresh one.</p>
    </div>`;

  const text = [
    `${inviterName} has invited you to join ${orgName} on SYN.`,
    ``,
    `Open SYN: ${appUrl}`,
    ``,
    `Once you're in, choose "Join Team" and enter this code: ${joinCode}`,
    ``,
    `Join codes rotate every 30 minutes — join soon, or ask ${inviterName} for a fresh one.`,
  ].join("\n");

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: "SYN by Syntrex <invites@syntrexio.com>",
      to: [toEmail],
      subject,
      html,
      text,
    }),
  });

  if (!resp.ok) {
    const detail = await resp.text();
    return json({ ok: false, reason: "send_failed", detail }, 502);
  }

  return json({ ok: true });
}
