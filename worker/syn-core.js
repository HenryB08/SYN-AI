/**
 * syn-core — SYN Core Worker: D1-backed KV + Anthropic proxy + TEMPORARY ACCESS GATE.
 *
 * ⚠️ TEMPORARY ACCESS GATE — THIS IS NOT AN AUTH SYSTEM. It is a single-credential
 * bouncer so the private-beta app can be demoed to clients/investors safely. There
 * is ONE name on the list (GATE_EMAIL / GATE_PASSWORD). Real multi-user auth is a
 * later prompt (Prompt 26), which REPLACES this gate wholesale — do not build on it,
 * do not treat the token as an identity, and delete this block when Prompt 26 lands.
 *
 * SOURCE OF TRUTH: syn-core's source previously lived outside the repo. THIS FILE is
 * now authoritative — deploy it as the syn-core Worker (paste into the dashboard, or
 * `wrangler deploy`). Required configuration:
 *   • D1 binding:  DB   — holds the KV surface in a table matched by the KV_* consts
 *                         below. If your existing database uses different names, change
 *                         KV_TABLE / KV_KEY_COL / KV_VAL_COL to match so LIVE WORKSPACE
 *                         DATA IS PRESERVED. (A second table, gate_rl, is auto-created
 *                         for rate limiting and holds no workspace data.)
 *   • Secrets:     ANTHROPIC_API_KEY, GATE_EMAIL, GATE_PASSWORD, GATE_SIGNING_KEY
 *                  Set each with `npx wrangler secret put <NAME>` — never commit them.
 */

/* ---- config ---- */
const ALLOWED_ORIGINS = [
  "https://henryb08.github.io",   // current GitHub Pages host
  "https://syn.syntrexio.com",    // custom domain
];
const KV_TABLE = "kv";            // <-- match these three to your existing D1 schema
const KV_KEY_COL = "k";           //     so live workspace data keeps resolving.
const KV_VAL_COL = "v";
const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;   // gate token lifetime: 7 days
const RL_MAX_FAILS = 5;                        // failed /gate attempts from one IP…
const RL_WINDOW_MS = 15 * 60 * 1000;           // …within/for a 15-minute block

/* ---- CORS: explicit allowlist, reflect the specific origin, never "*", fail closed ---- */
function isAllowedOrigin(o){ return typeof o === "string" && ALLOWED_ORIGINS.includes(o); }
function cors(origin){
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin",
  };
}
function json(obj, status, origin){
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { ...cors(origin), "Content-Type": "application/json" } });
}

/* ---- crypto: Web Crypto, constant-time comparisons (never ===) ---- */
const _enc = new TextEncoder();
function b64url(bytes){
  let s = ""; const b = new Uint8Array(bytes);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToStr(s){ s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return atob(s); }
async function sha256(str){ return new Uint8Array(await crypto.subtle.digest("SHA-256", _enc.encode(str))); }
function ctEqualBytes(a, b){                       // constant-time compare of equal-length arrays
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
async function ctEqualStr(a, b){                   // hash first → constant-time AND length-independent
  const [ha, hb] = await Promise.all([sha256(String(a)), sha256(String(b))]);
  return ctEqualBytes(ha, hb);
}
async function hmac(payloadB64, key){
  const k = await crypto.subtle.importKey("raw", _enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, _enc.encode(payloadB64));
  return b64url(sig);
}
// Token = base64url(JSON {e:email, exp}) + "." + HMAC-SHA256(payload, GATE_SIGNING_KEY).
// It is a SIGNED assertion of "email + expiry", not a random string and not the credentials.
async function makeToken(email, key){
  const payloadB64 = b64url(_enc.encode(JSON.stringify({ e: email, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS })));
  return payloadB64 + "." + (await hmac(payloadB64, key));
}
async function verifyToken(token, key){
  if (typeof token !== "string" || token.indexOf(".") < 0) return null;
  const [payloadB64, sig] = token.split(".");
  if (!payloadB64 || !sig) return null;
  const expected = await hmac(payloadB64, key);
  if (!ctEqualBytes(_enc.encode(sig), _enc.encode(expected))) return null;   // constant-time
  let payload; try { payload = JSON.parse(b64urlToStr(payloadB64)); } catch (_){ return null; }
  if (!payload || typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}
function bearer(request){
  const h = request.headers.get("Authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

/* ---- D1: KV surface + per-IP rate-limit table ---- */
async function ensureTables(env){
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS ${KV_TABLE} (${KV_KEY_COL} TEXT PRIMARY KEY, ${KV_VAL_COL} TEXT)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS gate_rl (ip TEXT PRIMARY KEY, fails INTEGER, first_ms INTEGER, blocked_until INTEGER)`),
  ]);
}
async function rateBlocked(env, ip){
  const now = Date.now();
  const row = await env.DB.prepare("SELECT blocked_until FROM gate_rl WHERE ip=?").bind(ip).first();
  if (row && row.blocked_until && row.blocked_until > now) return Math.ceil((row.blocked_until - now) / 1000);
  return 0;
}
async function rateFail(env, ip){
  const now = Date.now();
  const row = await env.DB.prepare("SELECT fails, first_ms FROM gate_rl WHERE ip=?").bind(ip).first();
  if (!row || (now - row.first_ms) > RL_WINDOW_MS){
    await env.DB.prepare("INSERT OR REPLACE INTO gate_rl (ip, fails, first_ms, blocked_until) VALUES (?,?,?,0)").bind(ip, 1, now).run();
    return;
  }
  const fails = (row.fails || 0) + 1;
  const blockedUntil = fails >= RL_MAX_FAILS ? now + RL_WINDOW_MS : 0;
  await env.DB.prepare("UPDATE gate_rl SET fails=?, blocked_until=? WHERE ip=?").bind(fails, blockedUntil, ip).run();
}
async function rateClear(env, ip){ await env.DB.prepare("DELETE FROM gate_rl WHERE ip=?").bind(ip).run(); }

export default {
  async fetch(request, env){
    const origin = request.headers.get("Origin");

    // Origin allowlist — fail closed on absent/unknown origin.
    if (!isAllowedOrigin(origin)){
      if (request.method === "OPTIONS") return new Response(null, { status: 403 });
      return new Response("Forbidden origin", { status: 403 });
    }
    // Preflight (no auth needed) — reflect the specific origin.
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });

    const path = new URL(request.url).pathname;

    // Public health probe — the app calls this at boot BEFORE login, so no token.
    if (path === "/" && request.method === "GET") return json({ ok: true }, 200, origin);

    // ---- GATE LOGIN (no token; rate-limited) ----
    if (path === "/gate" && request.method === "POST"){
      await ensureTables(env);
      const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
      const retry = await rateBlocked(env, ip);
      if (retry > 0){
        return new Response(JSON.stringify({ error: "too_many_attempts" }), {
          status: 429, headers: { ...cors(origin), "Content-Type": "application/json", "Retry-After": String(retry) },
        });
      }
      let body; try { body = await request.json(); } catch (_){ body = {}; }
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      // Constant-time on BOTH fields; evaluate both before branching so timing can't reveal which failed.
      const emailOk = await ctEqualStr(email, String(env.GATE_EMAIL || "").trim().toLowerCase());
      const passOk  = await ctEqualStr(password, String(env.GATE_PASSWORD || ""));
      if (emailOk && passOk){
        await rateClear(env, ip);
        return json({ token: await makeToken(email, env.GATE_SIGNING_KEY), exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS }, 200, origin);
      }
      await rateFail(env, ip);
      return json({ error: "invalid_credentials" }, 401, origin);   // generic; never says which field was wrong
    }

    // ---- EVERYTHING BELOW REQUIRES A VALID GATE TOKEN ----
    const payload = await verifyToken(bearer(request), env.GATE_SIGNING_KEY);
    if (!payload) return json({ error: "unauthorized" }, 401, origin);

    // KV surface (D1-backed): GET/PUT /kv/<key>
    if (path.startsWith("/kv/")){
      await ensureTables(env);
      const key = decodeURIComponent(path.slice(4));
      if (request.method === "GET"){
        const row = await env.DB.prepare(`SELECT ${KV_VAL_COL} AS v FROM ${KV_TABLE} WHERE ${KV_KEY_COL}=?`).bind(key).first();
        return json({ value: row ? row.v : null }, 200, origin);   // stored value is a JSON string, like localStorage
      }
      if (request.method === "PUT"){
        let body; try { body = await request.json(); } catch (_){ return json({ error: "bad_request" }, 400, origin); }
        const v = typeof body.value === "string" ? body.value : JSON.stringify(body.value ?? null);
        await env.DB.prepare(`INSERT INTO ${KV_TABLE} (${KV_KEY_COL}, ${KV_VAL_COL}) VALUES (?,?) ON CONFLICT(${KV_KEY_COL}) DO UPDATE SET ${KV_VAL_COL}=excluded.${KV_VAL_COL}`).bind(key, v).run();
        return json({ ok: true }, 200, origin);
      }
      return json({ error: "method_not_allowed" }, 405, origin);
    }

    // Anthropic proxy: POST /v1/messages (key injected here, never in the browser)
    if (path === "/v1/messages" && request.method === "POST"){
      const reqBody = await request.text();
      let upstream;
      try {
        upstream = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
          body: reqBody,
        });
      } catch (_){ return json({ error: "upstream_unreachable" }, 502, origin); }
      const ct = upstream.headers.get("Content-Type") || "";
      if (upstream.ok && ct.includes("text/event-stream") && upstream.body){
        return new Response(upstream.body, { headers: { ...cors(origin), "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" } });
      }
      const text = await upstream.text();
      return new Response(text, { status: upstream.status, headers: { ...cors(origin), "Content-Type": "application/json" } });
    }

    return json({ error: "not_found" }, 404, origin);
  },
};
