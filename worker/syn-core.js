/**
 * syn-core — SYN Core Worker: D1-backed KV + Anthropic proxy + REAL AUTH (+ the legacy gate).
 *
 * REAL AUTHENTICATION (this file, the "Prompt 26" work) replaces the temporary single-credential
 * gate with per-user accounts: sign up, verify email, log in, forgot/reset password, sessions.
 * Accounts live in a `users` table in syn-core's OWN D1 (the same binding that already holds the
 * KV surface) — see worker/AUTH.md for the full design, flows, and security notes.
 *
 * WHY syn-core (not a new service): the app already talks ONLY to syn-core for KV + AI, and every
 * protected request already carries a Bearer token that syn-core verifies. Putting auth here means
 * one Worker, one D1, one token-verification path — a session token slots into the exact place the
 * gate token occupied, so protected routes accept EITHER during the transition and the client is not
 * broken. No second origin to deploy, no cross-service trust to broker before the client dashboard.
 *
 * ⚠️ LEGACY ACCESS GATE (still present, still working, now SECONDARY). The old single-credential
 * bouncer (POST /gate → GATE_EMAIL/GATE_PASSWORD → 7-day token) keeps working during the cutover so
 * nothing that depends on it breaks. On a successful /gate login we ALSO seed/repair the real admin
 * account (see seedAdminUser), so the operator is never locked out. Real accounts are the primary
 * path; delete the /gate block once the client is fully migrated to /auth/login.
 *
 * SOURCE OF TRUTH: THIS FILE is authoritative — deploy it as the syn-core Worker (paste into the
 * dashboard, or `wrangler deploy`). Required configuration:
 *   • D1 binding:  SYN_DB — KV surface (`kv`), auth (`users`, `auth_invites`), rate limit (`gate_rl`).
 *   • Secrets:     ANTHROPIC_API_KEY, GATE_EMAIL, GATE_PASSWORD, GATE_SIGNING_KEY
 *   • Auth config: AUTH_SIGNING_KEY (falls back to GATE_SIGNING_KEY), RESEND_API_KEY (transactional
 *                  email — REQUIRED for verify/reset emails; set it on syn-core, NOT only syn-growth),
 *                  AUTH_EMAIL_FROM (a Resend-VERIFIED first-party sender; default
 *                  "SYN <no-reply@mail.syntrexio.com>"), APP_BASE_URL (link base, default the custom
 *                  domain), SIGNUP_MODE ("invite" default | "open"), ADMIN_TENANT_ID (optional — the
 *                  workspace/org id to link the seeded admin to).
 *   Set secrets with `npx wrangler secret put <NAME>` — never commit them, never log them.
 */

/* ---- config ---- */
const ALLOWED_ORIGINS = [
  "https://henryb08.github.io",   // current GitHub Pages host
  "https://syn.syntrexio.com",    // custom domain
];
const D1_BINDING = "SYN_DB";      // the live D1 binding name
const KV_TABLE = "kv";            // live KV schema: kv(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)
const KV_KEY_COL = "key";
const KV_VAL_COL = "value";
const KV_UPDATED_COL = "updated_at";   // stamped with an ISO timestamp on every write
const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;   // gate token lifetime: 7 days
const RL_MAX_FAILS = 5;                        // failed attempts from one IP+bucket…
const RL_WINDOW_MS = 15 * 60 * 1000;           // …within/for a 15-minute block

/* ---- auth config ---- */
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;  // session (access) token lifetime: 7 days (see AUTH.md §sessions)
const VERIFY_TTL_SECONDS  = 24 * 60 * 60;      // email-verify link: 24h
const RESET_TTL_SECONDS   = 60 * 60;           // password-reset link: 1h (expires fast)
const PBKDF2_ITERS = 100000;                   // HARD CEILING: the Cloudflare Workers runtime rejects
                                               // PBKDF2 iteration counts above 100000 ("iteration counts
                                               // above 100000 are not supported"). Do NOT raise this — a
                                               // higher value makes EVERY hash/verify throw at runtime.
const SIGNUP_MODE_DEFAULT = "invite";          // "invite" (private beta) | "open" (public)
// A fixed, valid PBKDF2 record used ONLY to equalize login timing when the email does not exist, so a
// missing account and a wrong password take the same work (no account enumeration via timing).
const DUMMY_PBKDF2 = "pbkdf2$100000$eWuqF8XIsam08BtYEREypA$fhOgDW52UkmL6PpbgrmhOZNgk5UttVCoxEiGlOqF05M";
// Google OAuth 2.0 (Authorization Code). Client secret lives ONLY in env (never the browser). The
// GOOGLE_FETCH seam lets tests stub the token exchange; production uses the real endpoints over TLS.
const GOOGLE_AUTH_URL  = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const OAUTH_STATE_TTL  = 600;                  // signed CSRF state token: 10 minutes

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
function nowSec(){ return Math.floor(Date.now() / 1000); }
function b64url(bytes){
  let s = ""; const b = new Uint8Array(bytes);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToStr(s){ s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return atob(s); }
function b64urlToBytes(s){ const bin = b64urlToStr(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
function randToken(n){ return b64url(crypto.getRandomValues(new Uint8Array(n || 18))); }
function newId(prefix){ return prefix + "_" + randToken(12); }
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

/* ---- password hashing: PBKDF2-HMAC-SHA256 via WebCrypto ----
 * The Workers runtime ships no native bcrypt/scrypt/argon2, so we use the strongest KDF that IS
 * native — PBKDF2 — with a per-user random 16-byte salt and a high iteration count. The stored record
 * is self-describing ("pbkdf2$<iters>$<saltB64>$<hashB64>") so the cost can be raised later without a
 * migration. The plaintext password is NEVER stored or logged; only this derived record is.
 */
async function pbkdf2(password, salt, iters){
  const key = await crypto.subtle.importKey("raw", _enc.encode(String(password)), { name: "PBKDF2" }, false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: iters, hash: "SHA-256" }, key, 256);
  return new Uint8Array(bits);
}
async function hashPassword(password){
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERS);
  return "pbkdf2$" + PBKDF2_ITERS + "$" + b64url(salt) + "$" + b64url(hash);
}
async function verifyPassword(password, record){
  try {
    const parts = String(record || "").split("$");
    if (parts.length !== 4 || parts[0] !== "pbkdf2") { await pbkdf2(password, new Uint8Array(16), PBKDF2_ITERS); return false; }
    const iters = parseInt(parts[1], 10) || PBKDF2_ITERS;
    const salt = b64urlToBytes(parts[2]);
    const expected = b64urlToBytes(parts[3]);
    const got = await pbkdf2(password, salt, iters);
    return ctEqualBytes(got, expected);   // constant-time
  } catch (_){ return false; }
}

/* ---- signed tokens ---- */
// Gate token = base64url(JSON {e:email, exp}) + "." + HMAC. A SIGNED assertion of "email + expiry".
async function makeToken(email, key){
  const payloadB64 = b64url(_enc.encode(JSON.stringify({ e: email, exp: nowSec() + TOKEN_TTL_SECONDS })));
  return payloadB64 + "." + (await hmac(payloadB64, key));
}
async function verifyToken(token, key){
  if (typeof token !== "string" || token.indexOf(".") < 0) return null;
  const [payloadB64, sig] = token.split(".");
  if (!payloadB64 || !sig) return null;
  const expected = await hmac(payloadB64, key);
  if (!ctEqualBytes(_enc.encode(sig), _enc.encode(expected))) return null;   // constant-time
  let payload; try { payload = JSON.parse(b64urlToStr(payloadB64)); } catch (_){ return null; }
  if (!payload || typeof payload.exp !== "number" || payload.exp < nowSec()) return null;
  return payload;
}
// Auth tokens (session / verify / reset) share the same signed envelope, keyed by AUTH_SIGNING_KEY
// (falls back to GATE_SIGNING_KEY so no new secret is strictly required). `typ` prevents a token minted
// for one purpose being replayed as another.
function authKey(env){ return env.AUTH_SIGNING_KEY || env.GATE_SIGNING_KEY || ""; }
async function signAuthToken(env, typ, claims, ttl){
  const payload = { ...claims, typ, iat: nowSec(), exp: nowSec() + ttl };
  const b = b64url(_enc.encode(JSON.stringify(payload)));
  return b + "." + (await hmac(b, authKey(env)));
}
async function readAuthToken(env, token, typ){
  if (typeof token !== "string" || token.indexOf(".") < 0) return null;
  const [b, sig] = token.split(".");
  if (!b || !sig) return null;
  const expected = await hmac(b, authKey(env));
  if (!ctEqualBytes(_enc.encode(sig), _enc.encode(expected))) return null;
  let p; try { p = JSON.parse(b64urlToStr(b)); } catch (_){ return null; }
  if (!p || p.typ !== typ || typeof p.exp !== "number" || p.exp < nowSec()) return null;
  return p;
}
function bearer(request){
  const h = request.headers.get("Authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

/* ---- D1: KV surface + auth tables + per-IP rate-limit table ---- */
async function ensureTables(env){
  await env[D1_BINDING].batch([
    env[D1_BINDING].prepare(`CREATE TABLE IF NOT EXISTS ${KV_TABLE} (${KV_KEY_COL} TEXT PRIMARY KEY, ${KV_VAL_COL} TEXT, ${KV_UPDATED_COL} TEXT)`),
    env[D1_BINDING].prepare(`CREATE TABLE IF NOT EXISTS gate_rl (ip TEXT PRIMARY KEY, fails INTEGER, first_ms INTEGER, blocked_until INTEGER)`),
    // Real accounts. email is UNIQUE (stored lowercased). password_hash is a PBKDF2 record, never plaintext.
    // tenant_id links a user to their workspace/org (nullable → no workspace yet → onboarding state).
    // session_epoch is bumped to revoke ALL of a user's outstanding sessions (logout-all / password change).
    // verify_jti / reset_jti make the email-verify and password-reset tokens single-use (cleared on consume).
    env[D1_BINDING].prepare(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      email_verified INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      role TEXT NOT NULL DEFAULT 'member',
      tenant_id TEXT,
      product TEXT NOT NULL DEFAULT 'workspace',   -- 'workspace' | 'growth' | 'both' — the EXPLICIT field the
                                                   -- app routes on (Growth client → Growth dashboard; Workspace
                                                   -- user → the full app). Set at provisioning (invite/Stripe).
      session_epoch INTEGER NOT NULL DEFAULT 1,
      verify_jti TEXT,
      reset_jti TEXT,
      created_at TEXT NOT NULL,
      last_login_at TEXT)`),
    // Private-beta signup control: an email allowlist and/or single-use invite codes. Ignored when
    // SIGNUP_MODE="open". An email row is a reusable allowlist entry; a code row is single-use (used_by).
    // An invite may carry tenant_id/role/product so a provisioned account lands correctly on first login.
    env[D1_BINDING].prepare(`CREATE TABLE IF NOT EXISTS auth_invites (
      id TEXT PRIMARY KEY, email TEXT, code TEXT, tenant_id TEXT, role TEXT, product TEXT,
      used_by TEXT, used_at TEXT, created_at TEXT NOT NULL)`),
    env[D1_BINDING].prepare(`CREATE INDEX IF NOT EXISTS idx_invites_email ON auth_invites(email)`),
    env[D1_BINDING].prepare(`CREATE INDEX IF NOT EXISTS idx_invites_code ON auth_invites(code)`),
  ]);
  // MIGRATIONS — CREATE TABLE IF NOT EXISTS never alters an already-created table, so columns added after
  // the first deploy must be back-filled with ALTER TABLE ... ADD COLUMN. Each is idempotent: a re-run on
  // a table that already has the column throws "duplicate column name", which we swallow. Runs OUTSIDE the
  // batch (a failed statement would abort the whole batch). Add new post-launch columns here.
  const migrations = [
    `ALTER TABLE users ADD COLUMN product TEXT NOT NULL DEFAULT 'workspace'`,
    `ALTER TABLE auth_invites ADD COLUMN product TEXT`,
    `ALTER TABLE users ADD COLUMN google_sub TEXT`,   // Google account link (one person, one account by email)
  ];
  for (const sql of migrations){ try { await env[D1_BINDING].prepare(sql).run(); } catch (_){ /* column already exists */ } }
}
// Rate limiter, keyed by "ip|bucket" so each endpoint has its own budget (reuses the gate_rl table).
async function rateBlocked(env, rlKey){
  const now = Date.now();
  const row = await env[D1_BINDING].prepare("SELECT blocked_until FROM gate_rl WHERE ip=?").bind(rlKey).first();
  if (row && row.blocked_until && row.blocked_until > now) return Math.ceil((row.blocked_until - now) / 1000);
  return 0;
}
async function rateFail(env, rlKey){
  const now = Date.now();
  const row = await env[D1_BINDING].prepare("SELECT fails, first_ms FROM gate_rl WHERE ip=?").bind(rlKey).first();
  if (!row || (now - row.first_ms) > RL_WINDOW_MS){
    await env[D1_BINDING].prepare("INSERT OR REPLACE INTO gate_rl (ip, fails, first_ms, blocked_until) VALUES (?,?,?,0)").bind(rlKey, 1, now).run();
    return;
  }
  const fails = (row.fails || 0) + 1;
  const blockedUntil = fails >= RL_MAX_FAILS ? now + RL_WINDOW_MS : 0;
  await env[D1_BINDING].prepare("UPDATE gate_rl SET fails=?, blocked_until=? WHERE ip=?").bind(fails, blockedUntil, rlKey).run();
}
async function rateClear(env, rlKey){ await env[D1_BINDING].prepare("DELETE FROM gate_rl WHERE ip=?").bind(rlKey).run(); }
function tooMany(retry, origin){
  return new Response(JSON.stringify({ error: "too_many_attempts" }), {
    status: 429, headers: { ...cors(origin), "Content-Type": "application/json", "Retry-After": String(retry) } });
}

/* ---- user helpers ---- */
function normEmail(e){ return String(e || "").trim().toLowerCase(); }
function validEmail(e){ return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e); }
function publicUser(u){ return u ? { id: u.id, email: u.email, email_verified: !!u.email_verified, status: u.status, role: u.role, tenant_id: u.tenant_id || null, product: u.product || "workspace" } : null; }
async function getUserByEmail(env, email){ return env[D1_BINDING].prepare("SELECT * FROM users WHERE email=?").bind(normEmail(email)).first(); }
async function getUserById(env, id){ return env[D1_BINDING].prepare("SELECT * FROM users WHERE id=?").bind(id).first(); }

// Transactional email via Resend. RESEND_FETCH is a TEST SEAM (unset in production → global fetch).
// Auth mail is FIRST-PARTY (SYN's own verify/reset to SYN's own users), so it sends from a
// Syntrex-VERIFIED sender (AUTH_EMAIL_FROM) — distinct from the follow-up rule that forbids
// syntrexio.com for a CLIENT's cold outreach. A missing sender/key is a soft failure (see AUTH.md).
async function sendAuthEmail(env, to, subject, html){
  // Default sender is on the Resend-VERIFIED domain (mail.syntrexio.com). Override with AUTH_EMAIL_FROM,
  // but it MUST be an address on a domain verified in Resend or the send is rejected.
  const from = env.AUTH_EMAIL_FROM || "SYN <no-reply@mail.syntrexio.com>";
  if (!env.RESEND_API_KEY && !env.RESEND_FETCH) return { ok: false, error: "resend_not_configured" };
  try {
    const doFetch = env.RESEND_FETCH || fetch;
    const resp = await doFetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": "Bearer " + (env.RESEND_API_KEY || ""), "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html }),
    });
    return { ok: !!resp.ok, status: resp.status };
  } catch (_){ return { ok: false, error: "send_failed" }; }
}
function appBase(env){ return (env.APP_BASE_URL && String(env.APP_BASE_URL).replace(/\/+$/, "")) || "https://syn.syntrexio.com"; }
function verifyEmailHtml(link){ return '<div style="font-family:sans-serif;line-height:1.5"><h2>Confirm your email</h2><p>Confirm your SYN account by opening this link (valid 24 hours):</p><p><a href="' + link + '">' + link + '</a></p><p>If you did not create a SYN account, ignore this email.</p></div>'; }
function resetEmailHtml(link){ return '<div style="font-family:sans-serif;line-height:1.5"><h2>Reset your password</h2><p>Open this link to set a new SYN password (valid 1 hour, single use):</p><p><a href="' + link + '">' + link + '</a></p><p>If you did not request this, ignore this email — your password is unchanged.</p></div>'; }

// Seed / repair the real admin account from the gate credentials, so the operator is never locked out
// when the gate is retired. Called on a successful /gate login (we have the plaintext there) and
// exported for tests. Never overwrites an existing password (the admin may have reset it) — it only
// ensures the account exists, is verified+active+admin, and (optionally) linked to ADMIN_TENANT_ID.
async function seedAdminUser(env, email, password){
  const em = normEmail(email);
  if (!em) return null;
  const existing = await getUserByEmail(env, em);
  const tid = env.ADMIN_TENANT_ID || null;
  if (existing){
    // Admin sees everything → product 'both'; back-fill without clobbering an existing tenant link.
    await env[D1_BINDING].prepare("UPDATE users SET email_verified=1, status='active', role='admin', product='both', tenant_id=COALESCE(tenant_id, ?) WHERE id=?").bind(tid, existing.id).run();
    return existing.id;
  }
  const id = newId("usr");
  await env[D1_BINDING].prepare("INSERT INTO users (id,email,password_hash,email_verified,status,role,tenant_id,product,session_epoch,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .bind(id, em, await hashPassword(password), 1, "active", "admin", tid, "both", 1, new Date().toISOString()).run();
  return id;
}

// Is this email permitted to sign up right now? Open mode → always. Invite mode → an allowlisted email
// row OR a valid unused invite code. Returns { allowed, invite } (invite row when matched by code).
async function signupAllowed(env, email, code){
  const mode = (env.SIGNUP_MODE || SIGNUP_MODE_DEFAULT).toLowerCase();
  if (mode === "open") return { allowed: true, invite: null };
  const em = normEmail(email);
  const byEmail = await env[D1_BINDING].prepare("SELECT * FROM auth_invites WHERE email=? LIMIT 1").bind(em).first();
  if (byEmail) return { allowed: true, invite: byEmail };
  if (code){
    const byCode = await env[D1_BINDING].prepare("SELECT * FROM auth_invites WHERE code=? AND used_by IS NULL LIMIT 1").bind(String(code)).first();
    if (byCode) return { allowed: true, invite: byCode };
  }
  return { allowed: false, invite: null };
}

/* ---- authenticate a protected request: accept a SESSION token OR a legacy GATE token ---- */
// Returns a normalized principal: {kind:'session', user} or {kind:'gate', email} or null. For a
// session, the DB is the authority (status must be active, token epoch must match the user's current
// session_epoch — that is how logout-all / password change revoke outstanding tokens).
async function authenticate(request, env){
  const tok = bearer(request);
  if (!tok) return null;
  const s = await readAuthToken(env, tok, "sess");
  if (s && s.uid){
    const user = await getUserById(env, s.uid);
    if (user && user.status === "active" && Number(user.session_epoch) === Number(s.epoch)) return { kind: "session", user };
    return null;   // revoked / disabled / stale epoch
  }
  const g = await verifyToken(tok, env.GATE_SIGNING_KEY);
  if (g && g.e) return { kind: "gate", email: g.e };
  return null;
}
// Tenant a KV key belongs to: keys are namespaced "syn5:<tenantId>:<sub>". A bare/global key
// (e.g. "syn5:orgs") has no tenant and is NOT reachable by a tenant-scoped session.
function keyTenant(key){ const m = /^syn5:([^:]+):/.exec(String(key || "")); return m ? m[1] : null; }
// May this principal touch this KV key? Gate + admin sessions are all-access (transition/operator).
// A regular session may ONLY touch keys inside its own tenant's namespace; a user with no tenant (or a
// global key) is denied → the "empty/onboarding state, not someone else's workspace" guarantee.
function canAccessKey(principal, key){
  if (principal.kind === "gate") return true;
  const u = principal.user;
  if (u.role === "admin") return true;
  if (!u.tenant_id) return false;
  return keyTenant(key) === u.tenant_id;
}

// BREAK-GLASS: set/reset a user's password directly, authenticated by GATE_SIGNING_KEY (a secret that is
// already required config). Anyone holding GATE_SIGNING_KEY can already forge an admin session, so gating
// a password-set behind it grants no new power — it is a server-to-server operator escape hatch for when
// the operator has no way into the UI (no reset button / unknown password). Seeds the admin if the email
// is absent, sets the password (min 8), verifies the email, and bumps session_epoch (revokes old
// sessions). Rate-limited. Handled BEFORE the browser Origin gate so a plain curl (no Origin) works.
async function adminSetPassword(request, env){
  const plain = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: { "Content-Type": "application/json" } });
  await ensureTables(env);
  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
  const rk = ip + "|adminpw";
  const retry = await rateBlocked(env, rk);
  if (retry > 0) return new Response(JSON.stringify({ error: "too_many_attempts" }), { status: 429, headers: { "Content-Type": "application/json", "Retry-After": String(retry) } });
  const key = env.GATE_SIGNING_KEY || "";
  if (!key || !(await ctEqualStr(bearer(request), key))){ await rateFail(env, rk); return plain({ error: "unauthorized" }, 401); }
  let body; try { body = await request.json(); } catch (_){ body = {}; }
  const email = normEmail(body.email || env.GATE_EMAIL);
  const pw = String(body.new_password || "");
  if (!email || pw.length < 8) return plain({ error: "invalid_input", hint: "{ email, new_password (>= 8 chars) }" }, 400);
  let user = await getUserByEmail(env, email);
  if (!user){
    let seedErr = null;
    try { await seedAdminUser(env, email, pw); } catch (e){ seedErr = String((e && e.message) || e); }
    user = await getUserByEmail(env, email);
    // Surface the real reason instead of masking a failed seed as a bare "user_not_found".
    if (!user) return plain({ error: "seed_failed", detail: seedErr || "insert produced no row", hint: "run ensureTables migrations / check the users schema" }, 500);
  }
  if (!user) return plain({ error: "user_not_found" }, 404);
  await env[D1_BINDING].prepare("UPDATE users SET password_hash=?, email_verified=1, status='active', session_epoch=session_epoch+1 WHERE id=?")
    .bind(await hashPassword(pw), user.id).run();
  await rateClear(env, rk);
  return plain({ ok: true, email, note: "password set; email verified; existing sessions revoked" }, 200);
}

// DIAGNOSTIC (break-glass, Bearer GATE_SIGNING_KEY): actually attempt a Resend send and report the REAL
// result — so "is syn-core wired to send email?" is answerable without the anti-enumeration silence of
// /auth/forgot. Returns whether RESEND_API_KEY is configured, the resolved `from`, and Resend's status.
async function adminTestEmail(request, env){
  const plain = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: { "Content-Type": "application/json" } });
  await ensureTables(env);
  const key = env.GATE_SIGNING_KEY || "";
  if (!key || !(await ctEqualStr(bearer(request), key))) return plain({ error: "unauthorized" }, 401);
  let body; try { body = await request.json(); } catch (_){ body = {}; }
  const to = normEmail(body.to || env.GATE_EMAIL);
  if (!to) return plain({ error: "invalid_input", hint: "{ to: \"you@example.com\" }" }, 400);
  const configured = !!(env.RESEND_API_KEY || env.RESEND_FETCH);
  const from = env.AUTH_EMAIL_FROM || "SYN <no-reply@mail.syntrexio.com>";
  const r = await sendAuthEmail(env, to, "SYN email test", '<p>This is a SYN email deliverability test. If you received it, verify/reset emails will send.</p>');
  return plain({ ok: !!r.ok, resend_configured: configured, from, to, resend_status: r.status || null, error: r.error || null }, r.ok ? 200 : 502);
}

/* ---- Google OAuth 2.0 (Authorization Code) ---- */
function appBaseUrl(env){ return (env.APP_BASE_URL && String(env.APP_BASE_URL).replace(/\/+$/, "")) || "https://syn.syntrexio.com"; }
function googleRedirectUri(env, request){
  if (env.GOOGLE_REDIRECT_URI) return env.GOOGLE_REDIRECT_URI;
  return new URL(request.url).origin + "/auth/google/callback";   // default: this Worker's own callback
}
function redirectTo(url){ return new Response(null, { status: 302, headers: { "Location": url, "Cache-Control": "no-store" } }); }
// A top-level browser navigation (no Origin, no CORS). Start the OAuth dance: sign a short-lived CSRF
// state and bounce to Google's consent screen. Missing config → bounce back to the app with an error.
async function googleStart(request, env){
  if (!env.GOOGLE_CLIENT_ID || !(env.GOOGLE_CLIENT_SECRET) || !authKey(env))
    return redirectTo(appBaseUrl(env) + "#autherror=google_not_configured");
  const state = await signAuthToken(env, "oauth", { n: randToken(12) }, OAUTH_STATE_TTL);
  const p = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID, redirect_uri: googleRedirectUri(env, request),
    response_type: "code", scope: "openid email profile", state,
    access_type: "online", prompt: "select_account", include_granted_scopes: "true",
  });
  return redirectTo(GOOGLE_AUTH_URL + "?" + p.toString());
}
// Google bounces the visitor back here with ?code&state. Exchange the code server-side (client secret
// stays in env), read the VERIFIED email from the id_token, find-or-create/LINK the user by email, and
// bounce to the app with a session token in the fragment. GOOGLE_FETCH is a test seam.
async function googleCallback(request, env){
  const back = (frag) => redirectTo(appBaseUrl(env) + frag);
  const url = new URL(request.url);
  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
  const rk = ip + "|google";
  if (await rateBlocked(env, rk)) return back("#autherror=rate_limited");
  const err = url.searchParams.get("error");
  if (err){ await rateFail(env, rk); return back("#autherror=google_denied"); }
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  const st = await readAuthToken(env, state, "oauth");   // CSRF: state must be our signed, unexpired token
  if (!code || !st){ await rateFail(env, rk); return back("#autherror=google_state"); }
  await ensureTables(env);
  // Exchange the authorization code for tokens.
  let tok;
  try {
    const doFetch = env.GOOGLE_FETCH || fetch;
    const r = await doFetch(GOOGLE_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: googleRedirectUri(env, request), grant_type: "authorization_code" }).toString() });
    if (!r.ok){ await rateFail(env, rk); return back("#autherror=google_exchange"); }
    tok = await r.json();
  } catch (_){ await rateFail(env, rk); return back("#autherror=google_exchange"); }
  // The id_token is a JWT from Google's token endpoint over TLS; read its claims (middle segment).
  let claims = null;
  try { const parts = String(tok.id_token || "").split("."); if (parts.length >= 2) claims = JSON.parse(b64urlToStr(parts[1])); } catch (_){ claims = null; }
  const email = normEmail(claims && claims.email);
  const emailVerified = !!(claims && (claims.email_verified === true || claims.email_verified === "true"));
  const sub = claims && claims.sub ? String(claims.sub) : null;
  if (!email || !emailVerified){ await rateFail(env, rk); return back("#autherror=google_email"); }
  await rateClear(env, rk);
  // Find-or-create/LINK by verified email. email is UNIQUE, so this is one-account-per-person: an
  // existing email/password account is LINKED (google_sub set, email marked verified) — never duplicated.
  let user = await getUserByEmail(env, email);
  if (user){
    await env[D1_BINDING].prepare("UPDATE users SET email_verified=1, status='active', google_sub=COALESCE(google_sub, ?), last_login_at=? WHERE id=?")
      .bind(sub, new Date().toISOString(), user.id).run();
    user = await getUserById(env, user.id);
  } else {
    // New Google user: verified (Google verified it → no email-verification step), with an UNUSABLE random
    // password hash (NOT NULL) so password login is impossible until they set one via forgot-password.
    const id = newId("usr");
    await env[D1_BINDING].prepare("INSERT INTO users (id,email,password_hash,email_verified,status,role,tenant_id,product,google_sub,session_epoch,created_at,last_login_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(id, email, await hashPassword(randToken(24)), 1, "active", "member", null, "workspace", sub, 1, new Date().toISOString(), new Date().toISOString()).run();
    user = await getUserById(env, id);
  }
  if (!user) return back("#autherror=google_account");
  const token = await signAuthToken(env, "sess", { uid: user.id, tid: user.tenant_id || null, role: user.role, ver: 1, epoch: Number(user.session_epoch) }, SESSION_TTL_SECONDS);
  return back("#token=" + encodeURIComponent(token) + "&product=" + encodeURIComponent(user.product || "workspace"));
}

export default {
  async fetch(request, env){
    // BREAK-GLASS admin password reset — before the browser Origin gate (curl carries no Origin).
    if (new URL(request.url).pathname === "/auth/admin/set-password" && request.method === "POST") return adminSetPassword(request, env);
    // DIAGNOSTIC: attempt a real Resend send and report the result (Bearer GATE_SIGNING_KEY; no Origin).
    if (new URL(request.url).pathname === "/auth/admin/test-email" && request.method === "POST") return adminTestEmail(request, env);
    // Google OAuth — top-level navigations (no Origin header), so they run before the Origin gate.
    {
      const p0 = new URL(request.url).pathname;
      if (p0 === "/auth/google/start" && request.method === "GET") return googleStart(request, env);
      if (p0 === "/auth/google/callback" && request.method === "GET") return googleCallback(request, env);
    }

    const origin = request.headers.get("Origin");

    // Origin allowlist — fail closed on absent/unknown origin.
    if (!isAllowedOrigin(origin)){
      if (request.method === "OPTIONS") return new Response(null, { status: 403 });
      return new Response("Forbidden origin", { status: 403 });
    }
    // Preflight (no auth needed) — reflect the specific origin.
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });

    const path = new URL(request.url).pathname;
    const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";

    // Public health probe — the app calls this at boot BEFORE login, so no token.
    if (path === "/" && request.method === "GET") return json({ ok: true }, 200, origin);

    /* ======================= REAL AUTH (public endpoints; rate-limited) ======================= */
    if (path === "/auth/signup" && request.method === "POST"){
      await ensureTables(env);
      const rk = ip + "|signup";
      const retry = await rateBlocked(env, rk); if (retry > 0) return tooMany(retry, origin);
      await rateFail(env, rk);   // every signup attempt counts (email-send abuse control)
      let body; try { body = await request.json(); } catch (_){ body = {}; }
      const email = normEmail(body.email);
      const password = String(body.password || "");
      // Generic response no matter what, so signup never reveals whether an email already exists.
      const generic = json({ ok: true, message: "If that email can sign up, a verification link is on its way." }, 200, origin);
      if (!validEmail(email) || password.length < 8) return json({ error: "invalid_input", hint: "valid email and password ≥ 8 chars" }, 400, origin);
      const gate = await signupAllowed(env, email, body.invite_code);
      if (!gate.allowed) return generic;   // not on the allowlist → look identical to a fresh signup
      const existing = await getUserByEmail(env, email);
      if (existing){
        // Do not leak existence. If unverified, quietly re-send the verify link; if verified, do nothing.
        if (!existing.email_verified){ await issueVerify(env, existing); }
        return generic;
      }
      const id = newId("usr");
      const invite = gate.invite;
      await env[D1_BINDING].prepare("INSERT INTO users (id,email,password_hash,email_verified,status,role,tenant_id,product,session_epoch,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .bind(id, email, await hashPassword(password), 0, "active", (invite && invite.role) || "member", (invite && invite.tenant_id) || null, (invite && invite.product) || "workspace", 1, new Date().toISOString()).run();
      if (invite && invite.code){ await env[D1_BINDING].prepare("UPDATE auth_invites SET used_by=?, used_at=? WHERE id=?").bind(id, new Date().toISOString(), invite.id).run(); }
      const fresh = await getUserById(env, id);
      await issueVerify(env, fresh);
      return generic;
    }

    if (path === "/auth/verify" && (request.method === "POST" || request.method === "GET")){
      await ensureTables(env);
      const rk = ip + "|verify";
      const retry = await rateBlocked(env, rk); if (retry > 0) return tooMany(retry, origin);
      let token = "";
      if (request.method === "GET") token = new URL(request.url).searchParams.get("token") || "";
      else { let b; try { b = await request.json(); } catch (_){ b = {}; } token = String(b.token || ""); }
      const p = await readAuthToken(env, token, "verify");
      if (!p || !p.uid || !p.jti){ await rateFail(env, rk); return json({ error: "invalid_token" }, 400, origin); }
      const user = await getUserById(env, p.uid);
      // Single-use: the token's jti must match the one stored at issue; clear it on success so a reuse fails.
      if (!user || user.verify_jti !== p.jti){ await rateFail(env, rk); return json({ error: "invalid_token" }, 400, origin); }
      await env[D1_BINDING].prepare("UPDATE users SET email_verified=1, verify_jti=NULL WHERE id=?").bind(user.id).run();
      await rateClear(env, rk);
      return json({ ok: true, verified: true }, 200, origin);
    }

    if (path === "/auth/login" && request.method === "POST"){
      await ensureTables(env);
      const rk = ip + "|login";
      const retry = await rateBlocked(env, rk); if (retry > 0) return tooMany(retry, origin);
      let body; try { body = await request.json(); } catch (_){ body = {}; }
      const email = normEmail(body.email);
      const password = String(body.password || "");
      let user = await getUserByEmail(env, email);
      // OPERATOR LOCKOUT SAFETY NET: if the admin account was never seeded (fresh D1, or the app cut over
      // to /auth/login without ever hitting /gate) and the GATE credentials are presented, create the
      // admin here so the operator can log in via real auth and can NEVER be locked out. Fires ONLY when
      // no account exists for this email — once seeded, the gate password is not a standing backdoor (a
      // later password reset stands; a wrong password just 401s). Constant-time on both fields.
      if (!user && env.GATE_EMAIL && env.GATE_PASSWORD){
        const gEmailOk = await ctEqualStr(email, normEmail(env.GATE_EMAIL));
        const gPassOk  = await ctEqualStr(password, String(env.GATE_PASSWORD));
        if (gEmailOk && gPassOk){ try { await seedAdminUser(env, env.GATE_EMAIL, env.GATE_PASSWORD); } catch (_){} user = await getUserByEmail(env, email); }
      }
      // Always run a PBKDF2 verify (real hash, or the dummy) so missing-account and wrong-password cost
      // the same → no enumeration by timing. Wrong email OR wrong password → the SAME generic error.
      const passOk = await verifyPassword(password, user ? user.password_hash : DUMMY_PBKDF2);
      if (!user || !passOk){ await rateFail(env, rk); return json({ error: "invalid_credentials" }, 401, origin); }
      if (user.status !== "active"){ await rateFail(env, rk); return json({ error: "invalid_credentials" }, 401, origin); }
      // Only AFTER the password is proven correct do we reveal "verify first" — this leaks nothing to
      // someone who does not already hold the password.
      if (!user.email_verified) return json({ error: "email_not_verified" }, 403, origin);
      await rateClear(env, rk);
      await env[D1_BINDING].prepare("UPDATE users SET last_login_at=? WHERE id=?").bind(new Date().toISOString(), user.id).run();
      const token = await signAuthToken(env, "sess", { uid: user.id, tid: user.tenant_id || null, role: user.role, ver: 1, epoch: Number(user.session_epoch) }, SESSION_TTL_SECONDS);
      return json({ token, exp: nowSec() + SESSION_TTL_SECONDS, user: publicUser(user) }, 200, origin);
    }

    if (path === "/auth/forgot" && request.method === "POST"){
      await ensureTables(env);
      const rk = ip + "|forgot";
      const retry = await rateBlocked(env, rk); if (retry > 0) return tooMany(retry, origin);
      await rateFail(env, rk);   // count every request (email-send abuse control)
      let body; try { body = await request.json(); } catch (_){ body = {}; }
      const email = normEmail(body.email);
      const user = email ? await getUserByEmail(env, email) : null;
      if (user && user.status === "active"){
        const jti = randToken(16);
        await env[D1_BINDING].prepare("UPDATE users SET reset_jti=? WHERE id=?").bind(jti, user.id).run();
        const token = await signAuthToken(env, "reset", { uid: user.id, jti }, RESET_TTL_SECONDS);
        await sendAuthEmail(env, user.email, "Reset your SYN password", resetEmailHtml(appBase(env) + "/#reset=" + token));
      }
      // Identical response whether or not the account exists — no enumeration on forgot-password.
      return json({ ok: true, message: "If that account exists, a reset link is on its way." }, 200, origin);
    }

    if (path === "/auth/reset" && request.method === "POST"){
      await ensureTables(env);
      const rk = ip + "|reset";
      const retry = await rateBlocked(env, rk); if (retry > 0) return tooMany(retry, origin);
      let body; try { body = await request.json(); } catch (_){ body = {}; }
      const token = String(body.token || "");
      const password = String(body.password || "");
      if (password.length < 8) return json({ error: "invalid_input", hint: "password ≥ 8 chars" }, 400, origin);
      const p = await readAuthToken(env, token, "reset");
      if (!p || !p.uid || !p.jti){ await rateFail(env, rk); return json({ error: "invalid_token" }, 400, origin); }
      const user = await getUserById(env, p.uid);
      if (!user || user.reset_jti !== p.jti){ await rateFail(env, rk); return json({ error: "invalid_token" }, 400, origin); }
      // Set the new password, clear the single-use jti, and bump session_epoch → every existing session
      // is invalidated by the password change. Verifying via reset also confirms the email.
      await env[D1_BINDING].prepare("UPDATE users SET password_hash=?, reset_jti=NULL, email_verified=1, session_epoch=session_epoch+1 WHERE id=?")
        .bind(await hashPassword(password), user.id).run();
      await rateClear(env, rk);
      return json({ ok: true, reset: true }, 200, origin);
    }

    /* ======================= REAL AUTH (token-authenticated) ======================= */
    if (path === "/auth/me" && request.method === "GET"){
      await ensureTables(env);
      const principal = await authenticate(request, env);
      if (!principal) return json({ error: "unauthorized" }, 401, origin);
      if (principal.kind === "gate") return json({ user: { email: principal.email, role: "admin", tenant_id: env.ADMIN_TENANT_ID || null, product: "both", via: "gate" } }, 200, origin);
      return json({ user: publicUser(principal.user) }, 200, origin);
    }

    if (path === "/auth/logout" && request.method === "POST"){
      await ensureTables(env);
      const principal = await authenticate(request, env);
      if (!principal) return json({ error: "unauthorized" }, 401, origin);
      // The client drops its stored token (client-side invalidation). Optionally revoke server-side:
      // {all:true} bumps session_epoch so EVERY outstanding token for this user stops verifying.
      let body; try { body = await request.json(); } catch (_){ body = {}; }
      if (principal.kind === "session" && body && body.all === true){
        await env[D1_BINDING].prepare("UPDATE users SET session_epoch=session_epoch+1 WHERE id=?").bind(principal.user.id).run();
        return json({ ok: true, revoked: "all_sessions" }, 200, origin);
      }
      return json({ ok: true, revoked: "client" }, 200, origin);
    }

    // Admin: manage the private-beta allowlist / invite codes (gate or an admin session).
    if (path === "/auth/invite" && (request.method === "POST" || request.method === "GET")){
      await ensureTables(env);
      const principal = await authenticate(request, env);
      const isAdmin = principal && (principal.kind === "gate" || (principal.user && principal.user.role === "admin"));
      if (!isAdmin) return json({ error: "forbidden" }, 403, origin);
      if (request.method === "GET"){
        const rows = (await env[D1_BINDING].prepare("SELECT id,email,code,tenant_id,role,used_by,used_at,created_at FROM auth_invites ORDER BY created_at DESC LIMIT 200").all()).results || [];
        return json({ invites: rows, signup_mode: (env.SIGNUP_MODE || SIGNUP_MODE_DEFAULT).toLowerCase() }, 200, origin);
      }
      let body; try { body = await request.json(); } catch (_){ body = {}; }
      const em = body.email ? normEmail(body.email) : null;
      const wantCode = body.code === true || (!em && !body.code);   // generate a code if asked, or if no email given
      const code = wantCode ? randToken(9) : (typeof body.code === "string" ? body.code : null);
      if (!em && !code) return json({ error: "invalid_input", hint: "pass {email} to allowlist, or {code:true} to mint an invite code" }, 400, origin);
      const id = newId("inv");
      const product = (body.product === "growth" || body.product === "both" || body.product === "workspace") ? body.product : null;
      await env[D1_BINDING].prepare("INSERT INTO auth_invites (id,email,code,tenant_id,role,product,created_at) VALUES (?,?,?,?,?,?,?)")
        .bind(id, em, code, body.tenant_id || null, body.role || null, product, new Date().toISOString()).run();
      return json({ ok: true, invite: { id, email: em, code, tenant_id: body.tenant_id || null, role: body.role || null, product } }, 201, origin);
    }

    /* ======================= LEGACY GATE LOGIN (still working during cutover) ======================= */
    if (path === "/gate" && request.method === "POST"){
      await ensureTables(env);
      const rk = ip + "|gate";
      const retry = await rateBlocked(env, rk);
      if (retry > 0) return tooMany(retry, origin);
      let body; try { body = await request.json(); } catch (_){ body = {}; }
      const email = normEmail(body.email);
      const password = String(body.password || "");
      // Constant-time on BOTH fields; evaluate both before branching so timing can't reveal which failed.
      const emailOk = await ctEqualStr(email, normEmail(env.GATE_EMAIL));
      const passOk  = await ctEqualStr(password, String(env.GATE_PASSWORD || ""));
      if (emailOk && passOk){
        await rateClear(env, rk);
        // Seed/repair the real admin account so retiring the gate never locks the operator out.
        try { await seedAdminUser(env, env.GATE_EMAIL, env.GATE_PASSWORD); } catch (_){ /* best-effort */ }
        return json({ token: await makeToken(email, env.GATE_SIGNING_KEY), exp: nowSec() + TOKEN_TTL_SECONDS }, 200, origin);
      }
      await rateFail(env, rk);
      return json({ error: "invalid_credentials" }, 401, origin);   // generic; never says which field was wrong
    }

    /* ======================= PROTECTED SURFACE (session token OR gate token) ======================= */
    const principal = await authenticate(request, env);
    if (!principal) return json({ error: "unauthorized" }, 401, origin);

    // KV surface (D1-backed): GET/PUT /kv/<key> — tenant-scoped for regular sessions.
    if (path.startsWith("/kv/")){
      await ensureTables(env);
      const key = decodeURIComponent(path.slice(4));
      if (!canAccessKey(principal, key)) return json({ error: "forbidden" }, 403, origin);
      if (request.method === "GET"){
        const row = await env[D1_BINDING].prepare(`SELECT ${KV_VAL_COL} AS v FROM ${KV_TABLE} WHERE ${KV_KEY_COL}=?`).bind(key).first();
        return json({ value: row ? row.v : null }, 200, origin);   // stored value is a JSON string, like localStorage
      }
      if (request.method === "PUT"){
        let body; try { body = await request.json(); } catch (_){ return json({ error: "bad_request" }, 400, origin); }
        const v = typeof body.value === "string" ? body.value : JSON.stringify(body.value ?? null);
        const nowIso = new Date().toISOString();   // stamp updated_at on every write, matching the live worker
        await env[D1_BINDING].prepare(`INSERT INTO ${KV_TABLE} (${KV_KEY_COL}, ${KV_VAL_COL}, ${KV_UPDATED_COL}) VALUES (?,?,?) ON CONFLICT(${KV_KEY_COL}) DO UPDATE SET ${KV_VAL_COL}=excluded.${KV_VAL_COL}, ${KV_UPDATED_COL}=excluded.${KV_UPDATED_COL}`).bind(key, v, nowIso).run();
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

/* ---- issue an email-verification token (single-use jti stored on the user) + send the link ---- */
async function issueVerify(env, user){
  const jti = randToken(16);
  await env[D1_BINDING].prepare("UPDATE users SET verify_jti=? WHERE id=?").bind(jti, user.id).run();
  const token = await signAuthToken(env, "verify", { uid: user.id, jti }, VERIFY_TTL_SECONDS);
  await sendAuthEmail(env, user.email, "Confirm your SYN email", verifyEmailHtml(appBase(env) + "/#verify=" + token));
  return token;
}

/* ---- named exports for the unit suite (worker/syn-core.test.mjs) ---- */
export {
  ensureTables, hashPassword, verifyPassword, signAuthToken, readAuthToken, verifyToken, makeToken,
  seedAdminUser, signupAllowed, authenticate, keyTenant, canAccessKey, getUserByEmail, getUserById,
  normEmail, validEmail, publicUser, issueVerify, googleStart, googleCallback,
  PBKDF2_ITERS, SESSION_TTL_SECONDS, VERIFY_TTL_SECONDS, RESET_TTL_SECONDS, RL_MAX_FAILS, SIGNUP_MODE_DEFAULT,
};
