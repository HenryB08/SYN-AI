/* Unit tests for worker/syn-growth.js.
 *
 * Uses node:sqlite (Node 22 built-in) as a D1-compatible shim so the tests exercise the REAL
 * schema — unique constraints, partial indexes, INSERT OR IGNORE, ON CONFLICT — not a mock.
 * Run: node worker/syn-growth.test.mjs   (a "SQLite is experimental" warning is expected)
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

// Import the worker (a .js ES module) by copying it to a temp .mjs so Node treats it as ESM.
const HERE = dirname(fileURLToPath(import.meta.url));
const tmp = join(tmpdir(), "syn-growth-under-test.mjs");
writeFileSync(tmp, readFileSync(join(HERE, "syn-growth.js"), "utf8"));
const worker = (await import("file://" + tmp)).default;

// ---- D1 shim over node:sqlite (async prepare/bind/first/run/all + batch) ----
function makeD1(){
  const db = new DatabaseSync(":memory:");
  const wrap = (sql) => {
    let args = [];
    return {
      bind(...a){ args = a; return this; },
      async first(){ const r = db.prepare(sql).get(...args); return r === undefined ? null : r; },
      async run(){ return db.prepare(sql).run(...args); },
      async all(){ return { results: db.prepare(sql).all(...args) }; },
    };
  };
  return { prepare: (sql) => wrap(sql), batch: async (stmts) => { for (const s of stmts) await s.run(); }, _db: db };
}
const ADMIN = "growth-admin-secret-abc123";
function env(opts = {}){ return { SYN_DB: makeD1(), GROWTH_ADMIN_KEY: "GROWTH_ADMIN_KEY" in opts ? opts.GROWTH_ADMIN_KEY : ADMIN }; }

function req(method, path, { origin, key, adminKey, body } = {}){
  const h = {};
  if (origin) h["Origin"] = origin;
  if (key) h["X-Install-Key"] = key;
  if (adminKey) h["Authorization"] = "Bearer " + adminKey;
  if (body !== undefined) h["Content-Type"] = "application/json";
  return new Request("https://syn-growth.workers.dev" + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
}
const call = (e, ...a) => worker.fetch(req(...a), e);

let ok = 0, fail = 0;
const c = (n, cond) => { cond ? ok++ : fail++; console.log((cond ? "✓" : "✗ FAIL") + " " + n); };

// ---- end-to-end seed: tenant → brand → install (also proves the admin write path) ----
async function seed(e, { slug = "acme", origin = "https://acme.com" } = {}){
  let r = await call(e, "POST", "/admin/tenants", { adminKey: ADMIN, body: { name: "Acme " + slug, slug } });
  const tenant = (await r.json()).tenant;
  r = await call(e, "POST", `/admin/tenants/${tenant.id}/brands`, { adminKey: ADMIN, body: { name: "Acme Brand", profile: { voice: "warm", banned_claims: ["#1 in the world"] } } });
  const brand = (await r.json()).brand;
  r = await call(e, "POST", `/admin/tenants/${tenant.id}/installs`, { adminKey: ADMIN, body: { brand_id: brand.id, allowed_origins: [origin], config: { greeting: "Hi!" } } });
  const install = (await r.json()).install;
  return { tenant, brand, install };
}

// ===== health =====
{
  const r = await call(env(), "GET", "/health");
  const j = await r.json();
  c("GET /health → {ok:true, service:'syn-growth'}", r.status === 200 && j.ok === true && j.service === "syn-growth");
}

// ===== end-to-end seed works and returns an install key once =====
{
  const e = env(); const { tenant, brand, install } = await seed(e);
  c("seed: tenant created (ten_ id, slug)", /^ten_/.test(tenant.id) && tenant.slug === "acme");
  c("seed: brand belongs to tenant", brand.tenant_id === tenant.id);
  c("seed: install returns a public key once (syn_pk_live_)", typeof install.install_key === "string" && install.install_key.startsWith("syn_pk_live_"));
  // GET tenant never re-exposes the install_key
  const r = await call(e, "GET", `/admin/tenants/${tenant.id}`, { adminKey: ADMIN });
  const body = await r.json();
  c("GET tenant does not re-expose install_key", !JSON.stringify(body).includes(install.install_key));
}

// ===== admin fails closed when GROWTH_ADMIN_KEY is unset =====
{
  const e = env({ GROWTH_ADMIN_KEY: undefined });
  const r1 = await call(e, "POST", "/admin/tenants", { adminKey: "anything", body: { name: "X", slug: "x" } });
  const r2 = await call(e, "POST", "/admin/tenants", { body: { name: "X", slug: "x" } });
  c("admin fail-closed (unset secret): with key → 401", r1.status === 401);
  c("admin fail-closed (unset secret): without key → 401", r2.status === 401);
}
// wrong admin key → 401
{
  const e = env();
  const r = await call(e, "POST", "/admin/tenants", { adminKey: "wrong-key", body: { name: "X", slug: "x2" } });
  c("admin wrong key → 401", r.status === 401);
}

// ===== install key rejected from a wrong origin (403) =====
{
  const e = env(); const { install } = await seed(e, { slug: "orig", origin: "https://good.com" });
  const good = await call(e, "GET", "/w/config", { origin: "https://good.com", key: install.install_key });
  const bad = await call(e, "GET", "/w/config", { origin: "https://evil.com", key: install.install_key });
  const noOrigin = await call(e, "GET", "/w/config", { key: install.install_key });
  c("install key + allowed origin → 200", good.status === 200);
  c("install key + WRONG origin → 403", bad.status === 403);
  c("403 does not reflect the rejected origin (no ACAO)", bad.headers.get("Access-Control-Allow-Origin") === null);
  c("install key + missing origin → 403", noOrigin.status === 403);
}

// ===== install key cannot read another tenant's data =====
{
  const e = env();
  const A = await seed(e, { slug: "tena", origin: "https://a.com" });
  const B = await seed(e, { slug: "tenb", origin: "https://b.com" });
  // A's /w/config returns A's brand only, never B's
  const cfg = await (await call(e, "GET", "/w/config", { origin: "https://a.com", key: A.install.install_key })).json();
  c("install A config shows A's brand, not B's", cfg.brand.name === "Acme Brand" && cfg.install_id === A.install.id);
  // A's public key cannot hit admin routes (list B's events) — admin secret required
  const adminWithInstallKey = await call(e, "GET", `/admin/tenants/${B.tenant.id}/events`, { adminKey: A.install.install_key });
  c("install key cannot use admin routes (read B's events) → 401", adminWithInstallKey.status === 401);
  // A's key cannot write an event referencing B's tenant contact
  const bContact = await (await call(e, "POST", "/w/contacts", { origin: "https://b.com", key: B.install.install_key, body: { email: "x@b.com" } })).json();
  const crossWrite = await call(e, "POST", "/w/events", { origin: "https://a.com", key: A.install.install_key, body: { type: "inquiry_received", contact_id: bContact.contact_id } });
  c("install A cannot attach B's contact to an event → 400", crossWrite.status === 400);
  // events A writes are scoped to A's tenant
  await call(e, "POST", "/w/events", { origin: "https://a.com", key: A.install.install_key, body: { type: "inquiry_received" } });
  const aEvents = e.SYN_DB._db.prepare("SELECT tenant_id FROM events").all();
  c("A's events are all tenant-scoped to A", aEvents.every(x => x.tenant_id === A.tenant.id));
}

// ===== revoked key returns 401 =====
{
  const e = env(); const { install } = await seed(e, { slug: "rev", origin: "https://rev.com" });
  await call(e, "POST", `/admin/installs/${install.id}/revoke`, { adminKey: ADMIN });
  const r = await call(e, "GET", "/w/config", { origin: "https://rev.com", key: install.install_key });
  c("revoked install key → 401", r.status === 401);
}

// ===== duplicate idempotency_key writes exactly one event =====
{
  const e = env(); const { tenant, install } = await seed(e, { slug: "idem", origin: "https://idem.com" });
  const opts = { origin: "https://idem.com", key: install.install_key };
  const r1 = await (await call(e, "POST", "/w/events", { ...opts, body: { type: "appointment_booked", idempotency_key: "abc-123" } })).json();
  const r2 = await (await call(e, "POST", "/w/events", { ...opts, body: { type: "appointment_booked", idempotency_key: "abc-123" } })).json();
  const count = e.SYN_DB._db.prepare("SELECT COUNT(*) n FROM events WHERE idempotency_key='abc-123'").get().n;
  c("duplicate idempotency_key → exactly one event row", count === 1);
  c("second call reports deduped + same id", r2.deduped === true && r2.id === r1.id && r1.deduped === false);
  // events without an idempotency_key are NOT deduped (multiple NULLs allowed)
  await call(e, "POST", "/w/events", { ...opts, body: { type: "conversation_started" } });
  await call(e, "POST", "/w/events", { ...opts, body: { type: "conversation_started" } });
  const nulls = e.SYN_DB._db.prepare("SELECT COUNT(*) n FROM events WHERE type='conversation_started'").get().n;
  c("null-idempotency events are not collapsed", nulls === 2);
  // invalid event type rejected
  const badType = await call(e, "POST", "/w/events", { ...opts, body: { type: "not_a_real_type" } });
  c("unknown event type → 400", badType.status === 400);
}

// ===== contact upsert dedupes on email and phone =====
{
  const e = env(); const { install } = await seed(e, { slug: "dedupe", origin: "https://d.com" });
  const opts = { origin: "https://d.com", key: install.install_key };
  const a1 = await (await call(e, "POST", "/w/contacts", { ...opts, body: { email: "Jo@D.com", name: "Jo" } })).json();
  const a2 = await (await call(e, "POST", "/w/contacts", { ...opts, body: { email: "jo@d.com", name: "Josephine" } })).json();
  c("contact dedupes on email (case-insensitive), same id", a1.deduped === false && a2.deduped === true && a2.contact_id === a1.contact_id);
  const p1 = await (await call(e, "POST", "/w/contacts", { ...opts, body: { phone: "(555) 111-2222" } })).json();
  const p2 = await (await call(e, "POST", "/w/contacts", { ...opts, body: { phone: "5551112222" } })).json();
  c("contact dedupes on phone (normalized), same id", p2.deduped === true && p2.contact_id === p1.contact_id);
  const total = e.SYN_DB._db.prepare("SELECT COUNT(*) n FROM contacts").get().n;
  c("only two distinct contacts stored", total === 2);
  // one contact with neither email nor phone → 400
  const empty = await call(e, "POST", "/w/contacts", { ...opts, body: { name: "Nobody" } });
  c("contact with no email or phone → 400", empty.status === 400);
}

// ===== job_values never updates in place (a change is a new row) =====
{
  const e = env(); const { tenant } = await seed(e, { slug: "jobval" });
  const r1 = await (await call(e, "POST", `/admin/tenants/${tenant.id}/job-value`, { adminKey: ADMIN, body: { average_job_value_cents: 25000, note: "initial" } })).json();
  await call(e, "POST", `/admin/tenants/${tenant.id}/job-value`, { adminKey: ADMIN, body: { average_job_value_cents: 40000, note: "raised" } });
  const rows = e.SYN_DB._db.prepare("SELECT * FROM job_values WHERE tenant_id=? ORDER BY created_at").all(tenant.id);
  c("job-value change inserts a new row (2 rows)", rows.length === 2);
  c("original job_value row is unchanged (still 25000)", rows.find(x => x.id === r1.job_value.id).average_job_value_cents === 25000);
  c("job_values are distinct rows with different amounts", rows.map(x => x.average_job_value_cents).sort().join(",") === "25000,40000");
}

// ===== rate limit trips (per-install requests/minute) =====
{
  const e = env(); const { install } = await seed(e, { slug: "rate", origin: "https://r.com" });
  const opts = { origin: "https://r.com", key: install.install_key };
  let limited = null;
  for (let i = 0; i < 65; i++){
    const r = await call(e, "POST", "/w/events", { ...opts, body: { type: "inquiry_received" } });
    if (r.status === 429){ limited = { at: i + 1, retryAfter: r.headers.get("Retry-After") }; break; }
  }
  c("rate limit trips within a minute", limited !== null && limited.at > 60 && limited.at <= 61);
  c("429 carries Retry-After", limited && !!limited.retryAfter);
}

// ===== admin events pagination =====
{
  const e = env(); const { tenant, install } = await seed(e, { slug: "page", origin: "https://p.com" });
  for (let i = 0; i < 5; i++) await call(e, "POST", "/w/events", { origin: "https://p.com", key: install.install_key, body: { type: "inquiry_received", idempotency_key: "k" + i } });
  const p1 = await (await call(e, "GET", `/admin/tenants/${tenant.id}/events?limit=2`, { adminKey: ADMIN })).json();
  c("admin events paginate (limit=2 → 2 + cursor)", p1.events.length === 2 && !!p1.next_cursor);
  const p2 = await (await call(e, "GET", `/admin/tenants/${tenant.id}/events?limit=2&cursor=${encodeURIComponent(p1.next_cursor)}`, { adminKey: ADMIN })).json();
  c("admin events next page returns different rows", p2.events.length === 2 && p2.events[0].id !== p1.events[0].id);
}

// ===== CORS preflight reflects only allowlisted origin =====
{
  const e = env(); const { install } = await seed(e, { slug: "cors", origin: "https://c.com" });
  const good = await worker.fetch(new Request("https://g/w/events?k=" + install.install_key, { method: "OPTIONS", headers: { Origin: "https://c.com" } }), e);
  const bad = await worker.fetch(new Request("https://g/w/events?k=" + install.install_key, { method: "OPTIONS", headers: { Origin: "https://evil.com" } }), e);
  c("OPTIONS from allowed origin → 204 + reflected origin", good.status === 204 && good.headers.get("Access-Control-Allow-Origin") === "https://c.com");
  c("OPTIONS ACAO is never a wildcard", good.headers.get("Access-Control-Allow-Origin") !== "*");
  c("OPTIONS from disallowed origin → 403, no CORS", bad.status === 403 && bad.headers.get("Access-Control-Allow-Origin") === null);
}

console.log(`\nCHECKS: ${ok} passed, ${fail} failed`);
console.log(fail ? "ERRORS: PRESENT" : "ERRORS: NONE");
if (fail) process.exitCode = 1;
