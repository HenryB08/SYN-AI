/* Unit tests for worker/syn-core.js — REAL AUTH (+ legacy gate, KV tenant-scoping).
 *
 * Uses node:sqlite (Node 22 built-in) as a D1-compatible shim so the tests exercise the REAL schema
 * (UNIQUE email, ON CONFLICT, indexes), not a mock. Email is captured via the RESEND_FETCH seam so
 * verify/reset tokens are read out of the actual link the flow would email.
 * Run: node worker/syn-core.test.mjs   (a "SQLite is experimental" warning is expected)
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const tmp = join(tmpdir(), "syn-core-under-test.mjs");
writeFileSync(tmp, readFileSync(join(HERE, "syn-core.js"), "utf8"));
const mod = await import("file://" + tmp);
const worker = mod.default;

// ---- D1 shim over node:sqlite ----
function makeD1(){
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = OFF;");
  const wrap = (sql) => { let args = [];
    return {
      bind(...a){ args = a; return this; },
      async first(){ const r = db.prepare(sql).get(...args); return r === undefined ? null : r; },
      async run(){ return db.prepare(sql).run(...args); },
      async all(){ return { results: db.prepare(sql).all(...args) }; },
    }; };
  return { prepare: (sql) => wrap(sql), batch: async (stmts) => { for (const s of stmts) await s.run(); }, _db: db };
}
function mkEnv(opts = {}){
  const outbox = [];
  const env = {
    SYN_DB: makeD1(),
    GATE_EMAIL: "admin@syn.test", GATE_PASSWORD: "gate-pass-123456", GATE_SIGNING_KEY: "gsk-secret",
    AUTH_SIGNING_KEY: "ask-secret", AUTH_EMAIL_FROM: "SYN <no-reply@syntrexio.com>",
    APP_BASE_URL: "https://syn.syntrexio.com",
    SIGNUP_MODE: opts.SIGNUP_MODE || "open",
    ADMIN_TENANT_ID: opts.ADMIN_TENANT_ID,
    RESEND_FETCH: async (_url, o) => { try { outbox.push(JSON.parse(o.body)); } catch (_){} return { ok: true, status: 200 }; },
  };
  Object.assign(env, opts.env || {});
  env._outbox = outbox;
  return env;
}
const ORIGIN = "https://syn.syntrexio.com";
function req(method, path, { origin = ORIGIN, ip = "1.2.3.4", token, body } = {}){
  const h = { "Origin": origin, "CF-Connecting-IP": ip };
  if (token) h["Authorization"] = "Bearer " + token;
  if (body !== undefined) h["Content-Type"] = "application/json";
  return new Request("https://syn-core.workers.dev" + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
}
const call = (e, ...a) => worker.fetch(req(...a), e);
const lastMail = (e) => e._outbox[e._outbox.length - 1] || null;
const tokenFrom = (mail, kind) => { const m = new RegExp("#" + kind + "=([^\"<\\s]+)").exec(mail ? mail.html : ""); return m ? m[1] : null; };

let ok = 0, fail = 0;
const c = (n, cond) => { cond ? ok++ : fail++; console.log((cond ? "✓" : "✗ FAIL") + " " + n); };

/* =================== health + origin =================== */
{
  const e = mkEnv();
  const r = await call(e, "GET", "/");
  c("GET / health ok", r.status === 200 && (await r.json()).ok === true);
  const bad = await worker.fetch(new Request("https://x/", { method: "GET", headers: { "Origin": "https://evil.example" } }), e);
  c("unknown origin → 403 (fail closed)", bad.status === 403);
}

/* =================== end-to-end: signup → unverified → verify → login =================== */
{
  const e = mkEnv({ SIGNUP_MODE: "open" });
  const su = await call(e, "POST", "/auth/signup", { ip: "10.0.0.1", body: { email: "Alice@Example.com", password: "hunter2hunter2" } });
  c("signup → generic 200", su.status === 200 && (await su.json()).ok === true);
  const u = e.SYN_DB._db.prepare("SELECT * FROM users WHERE email=?").get("alice@example.com");
  c("signup: account created, unverified, email lowercased", !!u && u.email_verified === 0 && u.email === "alice@example.com");
  c("signup: password stored as PBKDF2 record @ 100000 iters (runtime ceiling), never plaintext", /^pbkdf2\$100000\$/.test(u.password_hash) && !u.password_hash.includes("hunter2"));

  // login before verify → 403 email_not_verified
  const pre = await call(e, "POST", "/auth/login", { ip: "10.0.0.1", body: { email: "alice@example.com", password: "hunter2hunter2" } });
  c("login before verify → 403 email_not_verified", pre.status === 403 && (await pre.json()).error === "email_not_verified");

  // verify via the emailed link token
  const vtok = tokenFrom(lastMail(e), "verify");
  c("verify email dispatched with a #verify= token", !!vtok);
  const vr = await call(e, "POST", "/auth/verify", { ip: "10.0.0.1", body: { token: vtok } });
  c("verify → 200 verified", vr.status === 200 && (await vr.json()).verified === true);
  c("verify: DB marks email_verified, clears jti", e.SYN_DB._db.prepare("SELECT email_verified, verify_jti FROM users WHERE id=?").get(u.id).email_verified === 1 && e.SYN_DB._db.prepare("SELECT verify_jti FROM users WHERE id=?").get(u.id).verify_jti === null);

  // verify token is single-use
  const reuse = await call(e, "POST", "/auth/verify", { ip: "10.0.0.1", body: { token: vtok } });
  c("verify token is single-use (reuse rejected)", reuse.status === 400 && (await reuse.json()).error === "invalid_token");

  // login now works → session token
  const li = await call(e, "POST", "/auth/login", { ip: "10.0.0.1", body: { email: "alice@example.com", password: "hunter2hunter2" } });
  const lj = await li.json();
  c("login after verify → 200 with session token + exp", li.status === 200 && typeof lj.token === "string" && lj.token.includes(".") && lj.exp > Math.floor(Date.now() / 1000));
  c("login: last_login_at stamped", !!e.SYN_DB._db.prepare("SELECT last_login_at FROM users WHERE id=?").get(u.id).last_login_at);

  // /auth/me with the session
  const me = await call(e, "GET", "/auth/me", { token: lj.token });
  const mj = await me.json();
  c("/auth/me returns the authenticated user", me.status === 200 && mj.user.email === "alice@example.com" && mj.user.email_verified === true);
  c("login/me expose product (default 'workspace')", lj.user.product === "workspace" && mj.user.product === "workspace");
}

/* =================== wrong password: generic + rate-limited =================== */
{
  const e = mkEnv({ SIGNUP_MODE: "open" });
  // seed a verified user directly
  await mod.ensureTables(e);
  const now = new Date().toISOString();
  const hash = await mod.hashPassword("correct-horse-battery");
  e.SYN_DB._db.prepare("INSERT INTO users (id,email,password_hash,email_verified,status,role,tenant_id,session_epoch,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("usr_wp", "bob@example.com", hash, 1, "active", "member", null, 1, now);
  const bad = await call(e, "POST", "/auth/login", { ip: "77.0.0.1", body: { email: "bob@example.com", password: "wrong" } });
  c("wrong password → generic 401 invalid_credentials", bad.status === 401 && (await bad.json()).error === "invalid_credentials");
  // 5 fails from one IP → 6th is 429
  for (let i = 0; i < 4; i++) await call(e, "POST", "/auth/login", { ip: "77.0.0.1", body: { email: "bob@example.com", password: "x" } });
  const blocked = await call(e, "POST", "/auth/login", { ip: "77.0.0.1", body: { email: "bob@example.com", password: "correct-horse-battery" } });
  c("login rate-limited after 5 fails (even correct pw) → 429", blocked.status === 429 && !!blocked.headers.get("Retry-After"));
  // a different IP is unaffected + correct pw works
  const good = await call(e, "POST", "/auth/login", { ip: "77.0.0.9", body: { email: "bob@example.com", password: "correct-horse-battery" } });
  c("different IP unaffected; correct password logs in", good.status === 200 && typeof (await good.json()).token === "string");
}

/* =================== forgot → single-use, expiring reset → actually resets =================== */
{
  const e = mkEnv({ SIGNUP_MODE: "open" });
  await mod.ensureTables(e);
  const now = new Date().toISOString();
  e.SYN_DB._db.prepare("INSERT INTO users (id,email,password_hash,email_verified,status,role,tenant_id,session_epoch,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("usr_fp", "carol@example.com", await mod.hashPassword("oldpassword1"), 1, "active", "member", null, 1, now);
  const fg = await call(e, "POST", "/auth/forgot", { ip: "22.0.0.1", body: { email: "carol@example.com" } });
  c("forgot → generic 200", fg.status === 200 && (await fg.json()).ok === true);
  const rtok = tokenFrom(lastMail(e), "reset");
  c("reset email dispatched with a #reset= token", !!rtok);
  const rs = await call(e, "POST", "/auth/reset", { ip: "22.0.0.1", body: { token: rtok, password: "newpassword9" } });
  c("reset → 200", rs.status === 200 && (await rs.json()).reset === true);
  // old password no longer works, new one does
  const oldTry = await call(e, "POST", "/auth/login", { ip: "22.0.0.2", body: { email: "carol@example.com", password: "oldpassword1" } });
  c("old password rejected after reset", oldTry.status === 401);
  const newTry = await call(e, "POST", "/auth/login", { ip: "22.0.0.3", body: { email: "carol@example.com", password: "newpassword9" } });
  c("new password works after reset", newTry.status === 200);
  // reset token single-use
  const rReuse = await call(e, "POST", "/auth/reset", { ip: "22.0.0.4", body: { token: rtok, password: "another12" } });
  c("reset token is single-use (reuse rejected)", rReuse.status === 400 && (await rReuse.json()).error === "invalid_token");
}

/* =================== expired verify/reset tokens rejected =================== */
{
  const e = mkEnv({ SIGNUP_MODE: "open" });
  await mod.ensureTables(e);
  const now = new Date().toISOString();
  e.SYN_DB._db.prepare("INSERT INTO users (id,email,password_hash,email_verified,status,role,tenant_id,session_epoch,verify_jti,reset_jti,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run("usr_exp", "dave@example.com", await mod.hashPassword("password12"), 0, "active", "member", null, 1, "jv", "jr", now);
  const expiredVerify = await mod.signAuthToken(e, "verify", { uid: "usr_exp", jti: "jv" }, -100);   // already expired
  const ev = await call(e, "POST", "/auth/verify", { ip: "33.0.0.1", body: { token: expiredVerify } });
  c("expired verify token → 400 invalid_token", ev.status === 400);
  const expiredReset = await mod.signAuthToken(e, "reset", { uid: "usr_exp", jti: "jr" }, -100);
  const er = await call(e, "POST", "/auth/reset", { ip: "33.0.0.2", body: { token: expiredReset, password: "password34" } });
  c("expired reset token → 400 invalid_token", er.status === 400);
  // wrong-typ replay: a session token cannot be used as a verify token
  const sess = await mod.signAuthToken(e, "sess", { uid: "usr_exp", epoch: 1 }, 3600);
  const cross = await call(e, "POST", "/auth/verify", { ip: "33.0.0.3", body: { token: sess } });
  c("token type is enforced (session token rejected as verify)", cross.status === 400);
}

/* =================== no account enumeration (same response real vs fake) =================== */
{
  const e = mkEnv({ SIGNUP_MODE: "open" });
  await mod.ensureTables(e);
  const now = new Date().toISOString();
  e.SYN_DB._db.prepare("INSERT INTO users (id,email,password_hash,email_verified,status,role,tenant_id,session_epoch,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("usr_en", "real@example.com", await mod.hashPassword("realpassword1"), 1, "active", "member", null, 1, now);
  // signup: existing vs brand-new → identical body/status
  const s1 = await call(e, "POST", "/auth/signup", { ip: "44.0.0.1", body: { email: "real@example.com", password: "whatever12" } });
  const s2 = await call(e, "POST", "/auth/signup", { ip: "44.0.0.2", body: { email: "brandnew@example.com", password: "whatever12" } });
  c("signup: existing vs new email → identical response", s1.status === s2.status && JSON.stringify(await s1.json()) === JSON.stringify(await s2.json()));
  // login: wrong email vs wrong password → identical
  const l1 = await call(e, "POST", "/auth/login", { ip: "44.0.0.3", body: { email: "nope@example.com", password: "whatever12" } });
  const l2 = await call(e, "POST", "/auth/login", { ip: "44.0.0.4", body: { email: "real@example.com", password: "wrongpass12" } });
  c("login: unknown email vs wrong password → identical generic error", l1.status === l2.status && JSON.stringify(await l1.json()) === JSON.stringify(await l2.json()));
  // forgot: existing vs non-existing → identical
  const f1 = await call(e, "POST", "/auth/forgot", { ip: "44.0.0.5", body: { email: "real@example.com" } });
  const f2 = await call(e, "POST", "/auth/forgot", { ip: "44.0.0.6", body: { email: "ghost@example.com" } });
  c("forgot: existing vs non-existing → identical response", f1.status === f2.status && JSON.stringify(await f1.json()) === JSON.stringify(await f2.json()));
}

/* =================== tenant-scoped data access =================== */
{
  const e = mkEnv({ SIGNUP_MODE: "open" });
  await mod.ensureTables(e);
  const now = new Date().toISOString();
  // user A → tenant o_A; user B → tenant o_B; user N → no tenant
  e.SYN_DB._db.prepare("INSERT INTO users (id,email,password_hash,email_verified,status,role,tenant_id,session_epoch,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("usr_A", "a@x.com", await mod.hashPassword("passwordAA1"), 1, "active", "member", "o_A", 1, now);
  e.SYN_DB._db.prepare("INSERT INTO users (id,email,password_hash,email_verified,status,role,tenant_id,session_epoch,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("usr_B", "b@x.com", await mod.hashPassword("passwordBB1"), 1, "active", "member", "o_B", 1, now);
  e.SYN_DB._db.prepare("INSERT INTO users (id,email,password_hash,email_verified,status,role,tenant_id,session_epoch,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("usr_N", "n@x.com", await mod.hashPassword("passwordNN1"), 1, "active", "member", null, 1, now);
  const tokA = (await (await call(e, "POST", "/auth/login", { ip: "55.0.0.1", body: { email: "a@x.com", password: "passwordAA1" } })).json()).token;
  const tokB = (await (await call(e, "POST", "/auth/login", { ip: "55.0.0.2", body: { email: "b@x.com", password: "passwordBB1" } })).json()).token;
  const tokN = (await (await call(e, "POST", "/auth/login", { ip: "55.0.0.3", body: { email: "n@x.com", password: "passwordNN1" } })).json()).token;

  // A writes into its own namespace
  const wA = await call(e, "PUT", "/kv/" + encodeURIComponent("syn5:o_A:secret"), { token: tokA, body: { value: "A-data" } });
  c("session A can write its own tenant key", wA.status === 200);
  const rA = await call(e, "GET", "/kv/" + encodeURIComponent("syn5:o_A:secret"), { token: tokA });
  c("session A reads back its own tenant key", (await rA.json()).value === "A-data");
  // B cannot read A's key
  const rBA = await call(e, "GET", "/kv/" + encodeURIComponent("syn5:o_A:secret"), { token: tokB });
  c("session B CANNOT read tenant A's key → 403", rBA.status === 403);
  const wBA = await call(e, "PUT", "/kv/" + encodeURIComponent("syn5:o_A:secret"), { token: tokB, body: { value: "hax" } });
  c("session B CANNOT write tenant A's key → 403", wBA.status === 403);
  // global key denied to a regular session
  const rGlobal = await call(e, "GET", "/kv/" + encodeURIComponent("syn5:orgs"), { token: tokA });
  c("regular session CANNOT read a global (non-tenant) key → 403", rGlobal.status === 403);
  // no-tenant user sees nothing (empty/onboarding), never someone else's workspace
  const rN = await call(e, "GET", "/kv/" + encodeURIComponent("syn5:o_A:secret"), { token: tokN });
  c("no-tenant session reaches no workspace data → 403", rN.status === 403);
  const meN = await call(e, "GET", "/auth/me", { token: tokN });
  c("no-tenant user still resolves via /auth/me with tenant_id null", meN.status === 200 && (await meN.json()).user.tenant_id === null);
}

/* =================== seeded admin logs in + retains full access =================== */
{
  const e = mkEnv({ SIGNUP_MODE: "invite", ADMIN_TENANT_ID: "o_HQ" });
  // gate login seeds the admin account (and still returns a gate token)
  const g = await call(e, "POST", "/gate", { ip: "66.0.0.1", body: { email: "admin@syn.test", password: "gate-pass-123456" } });
  const gj = await g.json();
  c("gate login still works + issues a token", g.status === 200 && typeof gj.token === "string");
  const seeded = e.SYN_DB._db.prepare("SELECT * FROM users WHERE email=?").get("admin@syn.test");
  c("gate login seeded a real admin account (verified, role=admin, product=both, tenant linked)", !!seeded && seeded.role === "admin" && seeded.email_verified === 1 && seeded.product === "both" && seeded.tenant_id === "o_HQ");
  // the seeded admin logs in via real auth with the same credentials
  const li = await call(e, "POST", "/auth/login", { ip: "66.0.0.2", body: { email: "admin@syn.test", password: "gate-pass-123456" } });
  const lj = await li.json();
  c("seeded admin logs in via /auth/login", li.status === 200 && typeof lj.token === "string" && lj.user.role === "admin");
  // admin session is all-access (like the gate) — can read ANY tenant's key
  await call(e, "PUT", "/kv/" + encodeURIComponent("syn5:o_OTHER:x"), { token: gj.token, body: { value: "cross" } });   // seed via gate (all-access)
  const adminRead = await call(e, "GET", "/kv/" + encodeURIComponent("syn5:o_OTHER:x"), { token: lj.token });
  c("admin session retains full (all-tenant) access", adminRead.status === 200 && (await adminRead.json()).value === "cross");
  // gate token itself is all-access on /kv
  const gateRead = await call(e, "GET", "/kv/" + encodeURIComponent("syn5:o_OTHER:x"), { token: gj.token });
  c("legacy gate token still all-access during transition", gateRead.status === 200);
}

/* =================== operator lockout safety net: /auth/login seeds the admin from gate creds =================== */
{
  const e = mkEnv({ SIGNUP_MODE: "invite", ADMIN_TENANT_ID: "o_HQ" });
  await mod.ensureTables(e);
  // FRESH DB, /gate was NEVER hit (the app cut over to /auth/login). Gate creds must still log the admin in.
  const before = e.SYN_DB._db.prepare("SELECT COUNT(*) n FROM users").get().n;
  const li = await call(e, "POST", "/auth/login", { ip: "111.0.0.1", body: { email: "admin@syn.test", password: "gate-pass-123456" } });
  const lj = await li.json();
  c("fresh DB: /auth/login with gate creds seeds + logs in the admin (no lockout)", before === 0 && li.status === 200 && typeof lj.token === "string" && lj.user.role === "admin" && lj.user.product === "both");
  // Once seeded, a WRONG password 401s (the gate password is not a standing backdoor past seeding).
  const wrong = await call(e, "POST", "/auth/login", { ip: "111.0.0.2", body: { email: "admin@syn.test", password: "not-the-gate-pw" } });
  c("after seed, a wrong password is rejected (no permanent gate backdoor)", wrong.status === 401);
  // A non-admin unknown email + gate password does NOT create anything (safety net is gate-email-only).
  const other = await call(e, "POST", "/auth/login", { ip: "111.0.0.3", body: { email: "stranger@syn.test", password: "gate-pass-123456" } });
  c("safety net is gate-email-only (a stranger with the gate password gets nothing)", other.status === 401 && !e.SYN_DB._db.prepare("SELECT id FROM users WHERE email=?").get("stranger@syn.test"));
}

/* =================== invite/allowlist flag gates public signup =================== */
{
  const e = mkEnv({ SIGNUP_MODE: "invite" });
  // not allowlisted → generic response, but NO account created
  const s = await call(e, "POST", "/auth/signup", { ip: "88.0.0.1", body: { email: "stranger@example.com", password: "password12" } });
  c("invite mode: stranger signup → generic 200 (no enumeration)", s.status === 200);
  c("invite mode: stranger account NOT created", !e.SYN_DB._db.prepare("SELECT id FROM users WHERE email=?").get("stranger@example.com"));
  // admin (gate) adds an allowlist email → that email can now sign up
  await call(e, "POST", "/gate", { ip: "88.0.0.2", body: { email: "admin@syn.test", password: "gate-pass-123456" } });
  const gtok = (await (await call(e, "POST", "/gate", { ip: "88.0.0.2", body: { email: "admin@syn.test", password: "gate-pass-123456" } })).json()).token;
  const inv = await call(e, "POST", "/auth/invite", { token: gtok, body: { email: "friend@example.com" } });
  c("admin can add an allowlist email via /auth/invite", inv.status === 201);
  const s2 = await call(e, "POST", "/auth/signup", { ip: "88.0.0.3", body: { email: "friend@example.com", password: "password12" } });
  c("invite mode: allowlisted email signup creates the account", s2.status === 200 && !!e.SYN_DB._db.prepare("SELECT id FROM users WHERE email=?").get("friend@example.com"));
  // invite CODE path: single-use, and can carry a tenant + role
  const codeRes = await (await call(e, "POST", "/auth/invite", { token: gtok, body: { code: true, tenant_id: "ten_TEAM", role: "member", product: "growth" } })).json();
  const code = codeRes.invite.code;
  const s3 = await call(e, "POST", "/auth/signup", { ip: "88.0.0.4", body: { email: "coded@example.com", password: "password12", invite_code: code } });
  const codedUser = e.SYN_DB._db.prepare("SELECT * FROM users WHERE email=?").get("coded@example.com");
  c("invite code signup creates the account, joined to the invite's tenant/role/product", s3.status === 200 && !!codedUser && codedUser.tenant_id === "ten_TEAM" && codedUser.role === "member" && codedUser.product === "growth");
  const codeReuse = await call(e, "POST", "/auth/signup", { ip: "88.0.0.5", body: { email: "second@example.com", password: "password12", invite_code: code } });
  c("invite code is single-use (second signup with same code not created)", codeReuse.status === 200 && !e.SYN_DB._db.prepare("SELECT id FROM users WHERE email=?").get("second@example.com"));
  // non-admin cannot manage invites
  const noauth = await call(e, "POST", "/auth/invite", { body: { email: "x@x.com" } });
  c("/auth/invite requires admin (403 without a token)", noauth.status === 403);
}

/* =================== logout (server-side revoke-all bumps session epoch) =================== */
{
  const e = mkEnv({ SIGNUP_MODE: "open" });
  await mod.ensureTables(e);
  const now = new Date().toISOString();
  e.SYN_DB._db.prepare("INSERT INTO users (id,email,password_hash,email_verified,status,role,tenant_id,session_epoch,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("usr_lo", "log@x.com", await mod.hashPassword("passwordLO1"), 1, "active", "member", "o_L", 1, now);
  const tok = (await (await call(e, "POST", "/auth/login", { ip: "99.0.0.1", body: { email: "log@x.com", password: "passwordLO1" } })).json()).token;
  const before = await call(e, "GET", "/auth/me", { token: tok });
  c("session valid before logout-all", before.status === 200);
  const lo = await call(e, "POST", "/auth/logout", { token: tok, body: { all: true } });
  c("logout-all → revokes all sessions", lo.status === 200 && (await lo.json()).revoked === "all_sessions");
  const after = await call(e, "GET", "/auth/me", { token: tok });
  c("old session token no longer verifies after logout-all (epoch bumped)", after.status === 401);
}

/* =================== break-glass admin password reset (GATE_SIGNING_KEY) =================== */
{
  const e = mkEnv({ ADMIN_TENANT_ID: "o_HQ" });
  await mod.ensureTables(e);
  const setPw = (key, body, ip = "121.0.0.1") => worker.fetch(new Request("https://x.dev/auth/admin/set-password", { method: "POST", headers: { "CF-Connecting-IP": ip, ...(key ? { "Authorization": "Bearer " + key } : {}), "Content-Type": "application/json" }, body: JSON.stringify(body) }), e);
  // works with NO Origin header (plain curl) — handled before the origin gate
  c("break-glass with no Origin is not blocked by the origin gate", (await setPw("gsk-secret", { email: "admin@syn.test", new_password: "brandnewpw1" })).status === 200);
  const u = e.SYN_DB._db.prepare("SELECT * FROM users WHERE email=?").get("admin@syn.test");
  c("break-glass seeded + set the admin (verified, admin, session_epoch bumped)", !!u && u.email_verified === 1 && u.role === "admin" && u.session_epoch === 2);
  // the new password logs in via real auth
  const li = await call(e, "POST", "/auth/login", { ip: "121.0.0.2", body: { email: "admin@syn.test", password: "brandnewpw1" } });
  c("admin logs in with the new password via /auth/login", li.status === 200 && typeof (await li.json()).token === "string");
  // wrong signing key is rejected; short password rejected
  c("break-glass rejects a wrong signing key", (await setPw("nope", { email: "admin@syn.test", new_password: "another12" })).status === 401);
  c("break-glass rejects a short password", (await setPw("gsk-secret", { email: "admin@syn.test", new_password: "short" })).status === 400);
}

/* =================== migration: legacy users table (pre-`product`) is back-filled =================== */
{
  const e = mkEnv({ GATE_EMAIL: "henry@syntrexio.test", GATE_PASSWORD: "gatepw12345678", ADMIN_TENANT_ID: "o_HQ" });
  // Simulate a LIVE DB created by an earlier deploy WITHOUT the product column (CREATE IF NOT EXISTS = no-op).
  e.SYN_DB._db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, email_verified INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active', role TEXT NOT NULL DEFAULT 'member', tenant_id TEXT, session_epoch INTEGER NOT NULL DEFAULT 1, verify_jti TEXT, reset_jti TEXT, created_at TEXT NOT NULL, last_login_at TEXT)`);
  e.SYN_DB._db.exec(`CREATE TABLE auth_invites (id TEXT PRIMARY KEY, email TEXT, code TEXT, tenant_id TEXT, role TEXT, used_by TEXT, used_at TEXT, created_at TEXT NOT NULL)`);
  c("pre-migration: legacy users table has NO product column", !e.SYN_DB._db.prepare("PRAGMA table_info(users)").all().some(x => x.name === "product"));
  const setPw = (body, ip = "131.0.0.1") => worker.fetch(new Request("https://x.dev/auth/admin/set-password", { method: "POST", headers: { "CF-Connecting-IP": ip, "Authorization": "Bearer gsk-secret", "Content-Type": "application/json" }, body: JSON.stringify(body) }), e);
  const r = await setPw({ email: "henry@syntrexio.test", new_password: "brandnewpw1" });
  c("migration back-fills product; break-glass then SEEDS the admin (no user_not_found)", r.status === 200 && (await r.json()).ok === true);
  c("product column now exists after ensureTables migration", e.SYN_DB._db.prepare("PRAGMA table_info(users)").all().some(x => x.name === "product"));
  const li = await call(e, "POST", "/auth/login", { ip: "131.0.0.2", body: { email: "henry@syntrexio.test", password: "brandnewpw1" } });
  c("admin logs in on the migrated DB", li.status === 200 && (await li.json()).user.role === "admin");
}

/* =================== protected surface still rejects no/invalid token =================== */
{
  const e = mkEnv();
  const noTok = await call(e, "GET", "/kv/" + encodeURIComponent("syn5:o_A:x"));
  c("no token → 401 on /kv", noTok.status === 401);
  const badTok = await call(e, "GET", "/kv/" + encodeURIComponent("syn5:o_A:x"), { token: "garbage.token" });
  c("invalid token → 401 on /kv", badTok.status === 401);
}

console.log("\nCHECKS: " + ok + " passed, " + fail + " failed");
console.log("ERRORS: " + (fail ? "PRESENT" : "NONE"));
process.exit(fail ? 1 : 0);
