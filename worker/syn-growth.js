/**
 * syn-growth — SYN Growth Engine Worker (data foundation).
 *
 * The relational data layer the widget, follow-up scheduler, booking, and Receipt
 * generator all read and write. This brief is SCHEMA + KEYS + WRITE PATH only —
 * no widget UI, no follow-up sending, no booking, no receipt generation, no AI.
 * The tables anticipate all four; nothing here should need rewriting later.
 *
 * DEPLOY: single self-contained ES module (paste into the Cloudflare dashboard, or
 * `wrangler deploy` with worker/wrangler.syn-growth.toml). It binds the SAME D1
 * database as syn-core (binding SYN_DB) so growth data is unified with the workspace
 * app. It NEVER touches syn-core's `kv` table — these are new relational tables
 * alongside it, created idempotently by ensureTables().
 *
 * CONFIG:
 *   • D1 binding:  SYN_DB              (the same database syn-core uses)
 *   • Secret:      GROWTH_ADMIN_KEY    — admin credential. Set with
 *                  `npx wrangler secret put GROWTH_ADMIN_KEY`. If UNSET, every
 *                  /admin route fails closed (401).
 *
 * TWO CREDENTIAL TYPES (Stripe publishable/secret pattern):
 *   1. INSTALL KEY (public, `syn_pk_live_…`) — lives in a <script> on a client site.
 *      NOT a secret. Validated against the install's allowed_origins (mismatch=403),
 *      write-scoped and tenant-scoped to ITS OWN install, revocable (status=revoked
 *      ⇒ 401), per-install rate-limited. It may create conversations/messages/
 *      contacts/events for its own install ONLY; it may never read another tenant's
 *      data or anything beyond the public widget config.
 *   2. ADMIN SECRET (GROWTH_ADMIN_KEY) — Syntrex-only; creates tenants/brands/
 *      installs, rotates keys, reads everything. Never leaves the server.
 *
 * Crypto helpers (b64url / sha256 / constant-time compare) mirror worker/syn-core.js
 * — same patterns, same rigor. Admin auth uses the constant-time compare; install
 * keys are random public identifiers looked up in D1 (so they stay revocable).
 */

/* ============================ config / constants ============================ */
const SERVICE = "syn-growth";
const INSTALL_KEY_PREFIX = "syn_pk_live_";
const RATE_LIMIT_PER_MIN = 60;                 // public requests per install per minute
const RATE_WINDOW_MS = 60 * 1000;
const MAX_MESSAGES_PER_CONVERSATION = 200;     // enforced on the (future) message-write path
const EVENTS_PAGE_MAX = 200;                   // admin events pagination cap

// Append-only event vocabulary the Receipt reads from. Define once, here.
const EVENT_TYPES = [
  "inquiry_received", "first_response_sent", "followup_scheduled", "followup_sent",
  "followup_replied", "appointment_booked", "appointment_completed",
  "call_missed", "textback_sent", "conversation_started", "conversation_ended",
  "escalated_to_human", "guardrail_blocked",
];
const EVENT_TYPE_SET = new Set(EVENT_TYPES);

const TENANT_STATUS = new Set(["active", "paused", "cancelled"]);
const TENANT_PLAN = new Set(["core", "pro"]);
const CONTACT_STATUS = new Set(["new", "contacted", "booked", "closed", "lost"]);
const CONTACT_SOURCE = new Set(["chat", "form", "call", "sms"]);

/* ============================ crypto helpers (mirror syn-core) ============================ */
const _enc = new TextEncoder();
function b64url(bytes){
  let s = ""; const b = new Uint8Array(bytes);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function sha256(str){ return new Uint8Array(await crypto.subtle.digest("SHA-256", _enc.encode(str))); }
function ctEqualBytes(a, b){                         // constant-time compare of equal-length arrays
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
async function ctEqualStr(a, b){                     // hash first → constant-time AND length-independent
  const [ha, hb] = await Promise.all([sha256(String(a)), sha256(String(b))]);
  return ctEqualBytes(ha, hb);
}
function randBytes(n){ const a = new Uint8Array(n); crypto.getRandomValues(a); return a; }
function newId(prefix){ return prefix + "_" + b64url(randBytes(12)); }
function genInstallKey(){ return INSTALL_KEY_PREFIX + b64url(randBytes(24)); }   // public, revocable identifier
function nowIso(){ return new Date().toISOString(); }

/* ============================ HTTP helpers ============================ */
function corsFor(origin){                            // reflect ONE allowed origin, never "*"
  return origin ? {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Install-Key, Authorization",
    "Vary": "Origin",
  } : {};
}
function json(obj, status, extra){
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { "Content-Type": "application/json", ...(extra || {}) } });
}
async function readJson(request){ try { return await request.json(); } catch (_){ return null; } }
function bearer(request){ const h = request.headers.get("Authorization") || ""; return h.startsWith("Bearer ") ? h.slice(7) : ""; }

/* ============================ D1 schema (idempotent) ============================ */
async function ensureTables(env){
  const DB = env.SYN_DB;
  await DB.batch([
    DB.prepare(`CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active', timezone TEXT,
      created_at TEXT NOT NULL, plan TEXT NOT NULL DEFAULT 'core', notes TEXT)`),
    DB.prepare(`CREATE TABLE IF NOT EXISTS brands (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
      name TEXT NOT NULL, profile TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`),
    DB.prepare(`CREATE INDEX IF NOT EXISTS idx_brands_tenant ON brands(tenant_id)`),
    DB.prepare(`CREATE TABLE IF NOT EXISTS installs (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
      brand_id TEXT NOT NULL REFERENCES brands(id), install_key TEXT NOT NULL UNIQUE,
      allowed_origins TEXT, config TEXT, status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL, revoked_at TEXT)`),
    DB.prepare(`CREATE INDEX IF NOT EXISTS idx_installs_tenant ON installs(tenant_id)`),
    DB.prepare(`CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
      install_id TEXT REFERENCES installs(id), name TEXT, email TEXT, phone TEXT,
      first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, source TEXT,
      status TEXT NOT NULL DEFAULT 'new', consent_sms INTEGER NOT NULL DEFAULT 0,
      consent_at TEXT, meta TEXT)`),
    // Dedupe rules: unique per tenant on email and on phone, only where present.
    DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_email ON contacts(tenant_id, email) WHERE email IS NOT NULL`),
    DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(tenant_id, phone) WHERE phone IS NOT NULL`),
    DB.prepare(`CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY, install_id TEXT NOT NULL REFERENCES installs(id),
      contact_id TEXT REFERENCES contacts(id), channel TEXT NOT NULL,
      started_at TEXT NOT NULL, last_message_at TEXT, status TEXT NOT NULL DEFAULT 'open')`),
    DB.prepare(`CREATE INDEX IF NOT EXISTS idx_conversations_install ON conversations(install_id)`),
    DB.prepare(`CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
      role TEXT NOT NULL, body TEXT, created_at TEXT NOT NULL, meta TEXT)`),
    DB.prepare(`CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at)`),
    // events — append-only; the Receipt reads from here. Never updated, never deleted.
    DB.prepare(`CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
      install_id TEXT NOT NULL REFERENCES installs(id), contact_id TEXT REFERENCES contacts(id),
      type TEXT NOT NULL, payload TEXT, created_at TEXT NOT NULL, idempotency_key TEXT UNIQUE)`),
    DB.prepare(`CREATE INDEX IF NOT EXISTS idx_events_install_created ON events(install_id, created_at)`),
    DB.prepare(`CREATE INDEX IF NOT EXISTS idx_events_tenant_type_created ON events(tenant_id, type, created_at)`),
    DB.prepare(`CREATE TABLE IF NOT EXISTS followups (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
      contact_id TEXT NOT NULL REFERENCES contacts(id), channel TEXT NOT NULL,
      sequence_step INTEGER, due_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0, template_key TEXT, sent_at TEXT, error TEXT)`),
    DB.prepare(`CREATE INDEX IF NOT EXISTS idx_followups_status_due ON followups(status, due_at)`),
    // job_values — append-only ledger. NEVER updated in place, NEVER deleted: a change is a new row.
    DB.prepare(`CREATE TABLE IF NOT EXISTS job_values (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
      average_job_value_cents INTEGER NOT NULL, effective_from TEXT NOT NULL,
      created_at TEXT NOT NULL, set_by TEXT, note TEXT)`),
    DB.prepare(`CREATE INDEX IF NOT EXISTS idx_job_values_tenant ON job_values(tenant_id, effective_from)`),
    // receipts — immutable once generated; numbers must not drift.
    DB.prepare(`CREATE TABLE IF NOT EXISTS receipts (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
      period_start TEXT NOT NULL, period_end TEXT NOT NULL, metrics TEXT,
      job_value_cents INTEGER, generated_at TEXT NOT NULL, sent_at TEXT, status TEXT NOT NULL DEFAULT 'draft')`),
    DB.prepare(`CREATE INDEX IF NOT EXISTS idx_receipts_tenant ON receipts(tenant_id, period_start)`),
    // per-install fixed-window rate limiter (public routes)
    DB.prepare(`CREATE TABLE IF NOT EXISTS growth_rl (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL)`),
  ]);
}

/* ============================ auth ============================ */
// Admin: fail closed if the secret is unset; constant-time compare otherwise.
async function isAdmin(request, env){
  const provided = bearer(request) || request.headers.get("X-Admin-Key") || "";
  if (!env.GROWTH_ADMIN_KEY) return false;            // fail closed
  if (!provided) return false;
  return ctEqualStr(provided, env.GROWTH_ADMIN_KEY);
}
function installKeyFrom(request, url){
  return request.headers.get("X-Install-Key") || bearer(request) || url.searchParams.get("k") || "";
}
// Resolve the install for a public request: key exists, not revoked, and the Origin is allowlisted.
// Returns { install } on success, or { error, status } to send back.
async function resolveInstall(env, key, origin){
  if (!key || !key.startsWith(INSTALL_KEY_PREFIX)) return { error: "missing_install_key", status: 401 };
  const install = await env.SYN_DB.prepare("SELECT * FROM installs WHERE install_key=?").bind(key).first();
  if (!install) return { error: "invalid_install_key", status: 401 };
  if (install.status === "revoked") return { error: "revoked", status: 401 };
  let origins = [];
  try { origins = JSON.parse(install.allowed_origins || "[]"); } catch (_){ origins = []; }
  if (!origin || !origins.includes(origin)) return { error: "origin_not_allowed", status: 403 };
  return { install };
}
async function rateHit(env, bucket){
  const now = Date.now();
  const row = await env.SYN_DB.prepare("SELECT count, window_start FROM growth_rl WHERE bucket=?").bind(bucket).first();
  if (!row || (now - row.window_start) >= RATE_WINDOW_MS){
    await env.SYN_DB.prepare("INSERT OR REPLACE INTO growth_rl (bucket, count, window_start) VALUES (?,?,?)").bind(bucket, 1, now).run();
    return { limited: false };
  }
  if (row.count >= RATE_LIMIT_PER_MIN) return { limited: true, retryAfter: Math.ceil((row.window_start + RATE_WINDOW_MS - now) / 1000) };
  await env.SYN_DB.prepare("UPDATE growth_rl SET count = count + 1 WHERE bucket=?").bind(bucket).run();
  return { limited: false };
}

/* ============================ admin handlers ============================ */
async function createTenant(env, body){
  const name = (body && body.name || "").trim();
  const slug = (body && body.slug || "").trim().toLowerCase();
  if (!name || !slug) return json({ error: "name_and_slug_required" }, 400);
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)) return json({ error: "invalid_slug" }, 400);
  const status = TENANT_STATUS.has(body.status) ? body.status : "active";
  const plan = TENANT_PLAN.has(body.plan) ? body.plan : "core";
  const existing = await env.SYN_DB.prepare("SELECT id FROM tenants WHERE slug=?").bind(slug).first();
  if (existing) return json({ error: "slug_taken" }, 409);
  const t = { id: newId("ten"), name, slug, status, timezone: body.timezone || null, created_at: nowIso(), plan, notes: body.notes || null };
  await env.SYN_DB.prepare("INSERT INTO tenants (id,name,slug,status,timezone,created_at,plan,notes) VALUES (?,?,?,?,?,?,?,?)")
    .bind(t.id, t.name, t.slug, t.status, t.timezone, t.created_at, t.plan, t.notes).run();
  return json({ tenant: t }, 201);
}
async function getTenant(env, id){
  const t = await env.SYN_DB.prepare("SELECT * FROM tenants WHERE id=?").bind(id).first();
  if (!t) return json({ error: "not_found" }, 404);
  const { results: brands } = await env.SYN_DB.prepare("SELECT id,name,created_at,updated_at FROM brands WHERE tenant_id=?").bind(id).all();
  const { results: installs } = await env.SYN_DB.prepare("SELECT id,brand_id,status,created_at,revoked_at FROM installs WHERE tenant_id=?").bind(id).all();
  return json({ tenant: t, brands, installs });   // install_key is intentionally NOT returned here
}
async function createBrand(env, tenantId, body){
  const t = await env.SYN_DB.prepare("SELECT id FROM tenants WHERE id=?").bind(tenantId).first();
  if (!t) return json({ error: "tenant_not_found" }, 404);
  const name = (body && body.name || "").trim();
  if (!name) return json({ error: "name_required" }, 400);
  const profile = body.profile != null ? JSON.stringify(body.profile) : null;
  const ts = nowIso();
  const b = { id: newId("brd"), tenant_id: tenantId, name, profile, created_at: ts, updated_at: ts };
  await env.SYN_DB.prepare("INSERT INTO brands (id,tenant_id,name,profile,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .bind(b.id, b.tenant_id, b.name, b.profile, b.created_at, b.updated_at).run();
  return json({ brand: { ...b, profile: body.profile ?? null } }, 201);
}
async function patchBrand(env, brandId, body){
  const b = await env.SYN_DB.prepare("SELECT * FROM brands WHERE id=?").bind(brandId).first();
  if (!b) return json({ error: "not_found" }, 404);
  const name = (body && typeof body.name === "string") ? body.name.trim() : b.name;
  const profile = (body && body.profile !== undefined) ? JSON.stringify(body.profile) : b.profile;
  const updated = nowIso();
  await env.SYN_DB.prepare("UPDATE brands SET name=?, profile=?, updated_at=? WHERE id=?").bind(name, profile, updated, brandId).run();
  return json({ brand: { id: brandId, tenant_id: b.tenant_id, name, profile: profile ? JSON.parse(profile) : null, created_at: b.created_at, updated_at: updated } });
}
async function createInstall(env, tenantId, body){
  const t = await env.SYN_DB.prepare("SELECT id FROM tenants WHERE id=?").bind(tenantId).first();
  if (!t) return json({ error: "tenant_not_found" }, 404);
  const brandId = body && body.brand_id;
  const brand = brandId ? await env.SYN_DB.prepare("SELECT id,tenant_id FROM brands WHERE id=?").bind(brandId).first() : null;
  if (!brand || brand.tenant_id !== tenantId) return json({ error: "brand_not_found_for_tenant" }, 400);
  const allowed = Array.isArray(body.allowed_origins) ? body.allowed_origins : [];
  const config = body.config != null ? JSON.stringify(body.config) : "{}";
  const key = genInstallKey();
  const ins = { id: newId("ins"), tenant_id: tenantId, brand_id: brandId, install_key: key,
    allowed_origins: JSON.stringify(allowed), config, status: "active", created_at: nowIso(), revoked_at: null };
  await env.SYN_DB.prepare("INSERT INTO installs (id,tenant_id,brand_id,install_key,allowed_origins,config,status,created_at,revoked_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .bind(ins.id, ins.tenant_id, ins.brand_id, ins.install_key, ins.allowed_origins, ins.config, ins.status, ins.created_at, ins.revoked_at).run();
  // The plaintext install_key is returned ONCE, here. It's public (goes in a script tag) but is
  // never surfaced again by GET routes, matching Stripe's "shown once" ergonomics.
  return json({ install: { id: ins.id, tenant_id: tenantId, brand_id: brandId, install_key: key,
    allowed_origins: allowed, config: JSON.parse(config), status: "active", created_at: ins.created_at } }, 201);
}
async function revokeInstall(env, installId){
  const ins = await env.SYN_DB.prepare("SELECT id,status FROM installs WHERE id=?").bind(installId).first();
  if (!ins) return json({ error: "not_found" }, 404);
  await env.SYN_DB.prepare("UPDATE installs SET status='revoked', revoked_at=? WHERE id=?").bind(nowIso(), installId).run();
  return json({ ok: true, id: installId, status: "revoked" });
}
async function addJobValue(env, tenantId, body){
  const t = await env.SYN_DB.prepare("SELECT id FROM tenants WHERE id=?").bind(tenantId).first();
  if (!t) return json({ error: "tenant_not_found" }, 404);
  const cents = body && Number.isInteger(body.average_job_value_cents) ? body.average_job_value_cents : null;
  if (cents == null || cents < 0) return json({ error: "average_job_value_cents_required_int" }, 400);
  // NEVER updates an existing row: a change is always a new row, so the guarantee's number can't be
  // retroactively moved. The Receipt selects the value in effect during its reporting period.
  const row = { id: newId("jbv"), tenant_id: tenantId, average_job_value_cents: cents,
    effective_from: body.effective_from || nowIso(), created_at: nowIso(), set_by: body.set_by || null, note: body.note || null };
  await env.SYN_DB.prepare("INSERT INTO job_values (id,tenant_id,average_job_value_cents,effective_from,created_at,set_by,note) VALUES (?,?,?,?,?,?,?)")
    .bind(row.id, row.tenant_id, row.average_job_value_cents, row.effective_from, row.created_at, row.set_by, row.note).run();
  return json({ job_value: row }, 201);
}
async function listEvents(env, tenantId, url){
  const t = await env.SYN_DB.prepare("SELECT id FROM tenants WHERE id=?").bind(tenantId).first();
  if (!t) return json({ error: "tenant_not_found" }, 404);
  const limit = Math.min(EVENTS_PAGE_MAX, Math.max(1, parseInt(url.searchParams.get("limit") || "50", 10) || 50));
  const cursor = url.searchParams.get("cursor");   // opaque: the created_at||id of the last row seen
  let rows;
  if (cursor){
    rows = await env.SYN_DB.prepare(
      "SELECT * FROM events WHERE tenant_id=? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?")
      .bind(tenantId, cursor.split("|")[0], cursor.split("|")[0], cursor.split("|")[1] || "", limit + 1).all();
  } else {
    rows = await env.SYN_DB.prepare("SELECT * FROM events WHERE tenant_id=? ORDER BY created_at DESC, id DESC LIMIT ?").bind(tenantId, limit + 1).all();
  }
  const results = rows.results || [];
  const hasMore = results.length > limit;
  const page = results.slice(0, limit).map(e => ({ ...e, payload: e.payload ? JSON.parse(e.payload) : null }));
  const next = hasMore ? (page[page.length - 1].created_at + "|" + page[page.length - 1].id) : null;
  return json({ events: page, next_cursor: next });
}

/* ============================ public (install-key) handlers ============================ */
async function wConfig(env, install){
  // Widget DISPLAY config only — nothing sensitive. Brand name + the public config blob; never the
  // brand profile (banned claims / legal / escalation rules), keys, origins, or other tenants' data.
  const brand = await env.SYN_DB.prepare("SELECT name FROM brands WHERE id=?").bind(install.brand_id).first();
  let config = {};
  try { config = JSON.parse(install.config || "{}"); } catch (_){ config = {}; }
  return { install_id: install.id, brand: { name: brand ? brand.name : null }, config };
}
async function wEvents(env, install, body, cors){
  const type = body && body.type;
  if (!EVENT_TYPE_SET.has(type)) return json({ error: "invalid_event_type" }, 400, cors);
  const contactId = body.contact_id || null;
  if (contactId){   // a contact_id must belong to this install's tenant — never another tenant's
    const c = await env.SYN_DB.prepare("SELECT tenant_id FROM contacts WHERE id=?").bind(contactId).first();
    if (!c || c.tenant_id !== install.tenant_id) return json({ error: "contact_not_in_tenant" }, 400, cors);
  }
  const payload = body.payload != null ? JSON.stringify(body.payload) : null;
  const idk = body.idempotency_key ? String(body.idempotency_key) : null;
  const id = newId("evt");
  if (idk){
    // INSERT OR IGNORE on the unique idempotency_key → a duplicate key writes exactly one event.
    await env.SYN_DB.prepare("INSERT OR IGNORE INTO events (id,tenant_id,install_id,contact_id,type,payload,created_at,idempotency_key) VALUES (?,?,?,?,?,?,?,?)")
      .bind(id, install.tenant_id, install.id, contactId, type, payload, nowIso(), idk).run();
    const row = await env.SYN_DB.prepare("SELECT id,type,created_at FROM events WHERE idempotency_key=?").bind(idk).first();
    return json({ ok: true, id: row.id, type: row.type, deduped: row.id !== id }, row.id !== id ? 200 : 201, cors);
  }
  await env.SYN_DB.prepare("INSERT INTO events (id,tenant_id,install_id,contact_id,type,payload,created_at,idempotency_key) VALUES (?,?,?,?,?,?,?,NULL)")
    .bind(id, install.tenant_id, install.id, contactId, type, payload, nowIso()).run();
  return json({ ok: true, id, type, deduped: false }, 201, cors);
}
async function wContacts(env, install, body, cors){
  const email = body && body.email ? String(body.email).trim().toLowerCase() : null;
  const phone = body && body.phone ? String(body.phone).replace(/[^\d+]/g, "") : null;
  if (!email && !phone) return json({ error: "email_or_phone_required" }, 400, cors);
  const source = CONTACT_SOURCE.has(body.source) ? body.source : "chat";
  const consent = body.consent_sms ? 1 : 0;
  const meta = body.meta != null ? JSON.stringify(body.meta) : null;
  const ts = nowIso();
  // Dedupe within THIS tenant on email OR phone (whichever is present). Update in place if found.
  const existing = await env.SYN_DB.prepare(
    "SELECT * FROM contacts WHERE tenant_id=? AND ((email IS NOT NULL AND email=?) OR (phone IS NOT NULL AND phone=?)) LIMIT 1")
    .bind(install.tenant_id, email, phone).first();
  if (existing){
    await env.SYN_DB.prepare(
      "UPDATE contacts SET name=COALESCE(?,name), email=COALESCE(?,email), phone=COALESCE(?,phone), last_seen=?, source=COALESCE(source,?), consent_sms=MAX(consent_sms,?), consent_at=COALESCE(consent_at,?), meta=COALESCE(?,meta) WHERE id=?")
      .bind(body.name || null, email, phone, ts, source, consent, consent ? ts : null, meta, existing.id).run();
    return json({ contact_id: existing.id, deduped: true }, 200, cors);
  }
  const id = newId("con");
  try {
    await env.SYN_DB.prepare("INSERT INTO contacts (id,tenant_id,install_id,name,email,phone,first_seen,last_seen,source,status,consent_sms,consent_at,meta) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(id, install.tenant_id, install.id, body.name || null, email, phone, ts, ts, source, "new", consent, consent ? ts : null, meta).run();
    return json({ contact_id: id, deduped: false }, 201, cors);
  } catch (e){
    // Lost a race against the partial unique index — re-find and treat as an update.
    const row = await env.SYN_DB.prepare(
      "SELECT id FROM contacts WHERE tenant_id=? AND ((email IS NOT NULL AND email=?) OR (phone IS NOT NULL AND phone=?)) LIMIT 1")
      .bind(install.tenant_id, email, phone).first();
    if (row) return json({ contact_id: row.id, deduped: true }, 200, cors);
    return json({ error: "contact_write_failed" }, 500, cors);
  }
}

/* ============================ router ============================ */
export default {
  async fetch(request, env){
    const url = new URL(request.url);
    const path = url.pathname;
    const seg = path.split("/").filter(Boolean);
    const method = request.method;
    const origin = request.headers.get("Origin");

    // Health — public, no auth, no DB.
    if (path === "/health" && method === "GET") return json({ ok: true, service: SERVICE });

    // ---- public widget routes (/w/*): install key + origin check + CORS ----
    if (seg[0] === "w"){
      // Preflight: resolve the install from the key (query ?k= makes it available on OPTIONS) and
      // reflect the origin only if it's allowlisted. Never a wildcard; fail closed otherwise.
      if (method === "OPTIONS"){
        await ensureTables(env);
        const r = await resolveInstall(env, installKeyFrom(request, url), origin);
        if (r.error) return new Response(null, { status: r.status });
        return new Response(null, { status: 204, headers: corsFor(origin) });
      }
      await ensureTables(env);
      const r = await resolveInstall(env, installKeyFrom(request, url), origin);
      // On failure, only send CORS headers if the origin is actually allowlisted (i.e. not a 403
      // origin mismatch) — never reflect an origin we rejected.
      if (r.error) return json({ error: r.error }, r.status, r.status === 403 ? {} : corsFor(origin));
      const install = r.install;
      const cors = corsFor(origin);
      // Per-install fixed-window rate limit (a public key on a public page gets hit).
      const rl = await rateHit(env, "req:" + install.id);
      if (rl.limited) return json({ error: "rate_limited" }, 429, { ...cors, "Retry-After": String(rl.retryAfter) });

      if (seg[1] === "config" && method === "GET") return json(await wConfig(env, install), 200, cors);
      if (seg[1] === "events" && method === "POST"){ const b = await readJson(request); if (!b) return json({ error: "bad_json" }, 400, cors);
        return wEvents(env, install, b, cors); }
      if (seg[1] === "contacts" && method === "POST"){ const b = await readJson(request); if (!b) return json({ error: "bad_json" }, 400, cors);
        return wContacts(env, install, b, cors); }
      return json({ error: "not_found" }, 404, cors);
    }

    // ---- admin routes (/admin/*): admin secret required; fail closed if unset ----
    if (seg[0] === "admin"){
      if (method === "OPTIONS") return new Response(null, { status: 204 });
      if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
      await ensureTables(env);
      const body = (method === "POST" || method === "PATCH") ? await readJson(request) : null;

      if (seg[1] === "tenants" && seg.length === 2 && method === "POST") return createTenant(env, body || {});
      if (seg[1] === "tenants" && seg.length === 3 && method === "GET") return getTenant(env, seg[2]);
      if (seg[1] === "tenants" && seg[3] === "brands" && method === "POST") return createBrand(env, seg[2], body || {});
      if (seg[1] === "brands" && seg.length === 3 && method === "PATCH") return patchBrand(env, seg[2], body || {});
      if (seg[1] === "tenants" && seg[3] === "installs" && method === "POST") return createInstall(env, seg[2], body || {});
      if (seg[1] === "installs" && seg[3] === "revoke" && method === "POST") return revokeInstall(env, seg[2]);
      if (seg[1] === "tenants" && seg[3] === "job-value" && method === "POST") return addJobValue(env, seg[2], body || {});
      if (seg[1] === "tenants" && seg[3] === "events" && method === "GET") return listEvents(env, seg[2], url);
      return json({ error: "not_found" }, 404);
    }

    return json({ error: "not_found" }, 404);
  },
};

// Exported for tests/seed (harmless in the Worker runtime).
export { EVENT_TYPES, INSTALL_KEY_PREFIX, ensureTables };
