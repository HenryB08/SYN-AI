/* Growth Engine widget shell — hostile-environment browser verification.
 *
 * Runs the REAL syn-growth Worker (backed by a node:sqlite D1 shim) behind a local HTTP
 * server, and serves the host pages from a SEPARATE origin, so the widget's cross-origin
 * CORS + install-key + origin-allowlist checks are exercised for real — not mocked.
 *
 * Verifies: renders inside deliberately hostile CSS; renders on a page with no CSS; renders
 * at 1440/768/375; below 480 the panel goes full-screen; a second <script> is a no-op; a
 * revoked key and a wrong origin render nothing and warn once; only one global is added
 * (__synGrowth); the shadow root is CLOSED; and conversation_started lands exactly once per
 * session. Screenshots are written to SHOTS.
 *
 * Run: node tests/growth-widget.mjs   (SQLite-experimental warning is expected)
 */
import pkg from "/tmp/node_modules/playwright-core/index.js";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
const { chromium } = pkg;

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const SHOTS = process.env.SHOTS || join(tmpdir(), "growth-widget-shots");
mkdirSync(SHOTS, { recursive: true });

// ---- import the worker (copy .js → .mjs so Node treats it as ESM) ----
const tmp = join(tmpdir(), "syn-growth-widget-under-test.mjs");
writeFileSync(tmp, readFileSync(join(ROOT, "worker/syn-growth.js"), "utf8"));
const worker = (await import("file://" + tmp)).default;

// ---- D1 shim over node:sqlite (same pattern as the worker unit tests) ----
function makeD1(){
  const db = new DatabaseSync(":memory:");
  const wrap = (sql) => { let args = [];
    return { bind(...a){ args = a; return this; },
      async first(){ const r = db.prepare(sql).get(...args); return r === undefined ? null : r; },
      async run(){ return db.prepare(sql).run(...args); },
      async all(){ return { results: db.prepare(sql).all(...args) }; } }; };
  return { prepare: (sql) => wrap(sql), batch: async (stmts) => { for (const s of stmts) await s.run(); }, _db: db };
}
const ADMIN = "widget-test-admin-secret";
const env = { SYN_DB: makeD1(), GROWTH_ADMIN_KEY: ADMIN };

let ok = 0, fail = 0;
const c = (n, cond) => { cond ? ok++ : fail++; console.log((cond ? "✓" : "✗ FAIL") + " " + n); };

// ---- run the worker in-process (for seeding) ----
function inproc(method, path, { origin, key, adminKey, body } = {}){
  const h = {};
  if (origin) h["Origin"] = origin;
  if (key) h["X-Install-Key"] = key;
  if (adminKey) h["Authorization"] = "Bearer " + adminKey;
  if (body !== undefined) h["Content-Type"] = "application/json";
  const req = new Request("http://inproc" + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  return worker.fetch(req, env);
}

// ---- serve the real worker over HTTP so the browser can talk to it cross-origin ----
function toWebRequest(req, host){
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      const init = { method: req.method, headers };
      if (req.method !== "GET" && req.method !== "HEAD" && chunks.length) init.body = Buffer.concat(chunks);
      resolve(new Request("http://" + host + req.url, init));
    });
  });
}
async function listen(handler){
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: server.address().port };
}

const workerSrv = await listen(async (req, res) => {
  const webReq = await toWebRequest(req, req.headers.host);
  const webRes = await worker.fetch(webReq, env);
  res.statusCode = webRes.status;
  webRes.headers.forEach((v, k) => res.setHeader(k, v));
  res.end(Buffer.from(await webRes.arrayBuffer()));
});
const WORKER = "http://127.0.0.1:" + workerSrv.port;

const hostileTpl = readFileSync(join(HERE, "fixtures/hostile.html"), "utf8");
const plainTpl = readFileSync(join(HERE, "fixtures/plain.html"), "utf8");
const pageSrv = await listen((req, res) => {
  const u = new URL(req.url, "http://x");
  const key = u.searchParams.get("key") || "";
  let html;
  if (u.pathname === "/plain") html = plainTpl.replace(/__WORKER__/g, WORKER).replace(/__KEY__/g, key);
  else if (u.pathname === "/double") {
    // Two identical script tags — the second load must be a no-op.
    const tag = `<script src="${WORKER}/w/widget.js" data-key="${key}" async></script>`;
    html = `<!doctype html><html><head><meta charset=utf-8><title>double</title></head><body><h1>double load</h1>${tag}${tag}</body></html>`;
  } else html = hostileTpl.replace(/__WORKER__/g, WORKER).replace(/__KEY__/g, key);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
});
const PAGE = "http://127.0.0.1:" + pageSrv.port;
const PAGE_ORIGIN = PAGE;   // browser sends this exact Origin

// ---- seed installs (now that we know the page origin) ----
async function seedInstall({ slug, origins, config, revoke }){
  const t = (await (await inproc("POST", "/admin/tenants", { adminKey: ADMIN, body: { name: slug, slug } })).json()).tenant;
  const b = (await (await inproc("POST", `/admin/tenants/${t.id}/brands`, { adminKey: ADMIN, body: { name: "Brand " + slug } })).json()).brand;
  const ins = (await (await inproc("POST", `/admin/tenants/${t.id}/installs`, { adminKey: ADMIN, body: { brand_id: b.id, allowed_origins: origins, config } })).json()).install;
  if (revoke) await inproc("POST", `/admin/installs/${ins.id}/revoke`, { adminKey: ADMIN });
  return { tenant: t, install: ins };
}
const main = await seedInstall({ slug: "main", origins: [PAGE_ORIGIN], config: { greeting: "Welcome to Acme! Ask us anything.", accent: "#2f6df6", position: "bottom-right" } });
const evt = await seedInstall({ slug: "evtcount", origins: [PAGE_ORIGIN], config: { greeting: "hi" } });
const revoked = await seedInstall({ slug: "revoked", origins: [PAGE_ORIGIN], config: { greeting: "hi" }, revoke: true });
const wrong = await seedInstall({ slug: "wrongorigin", origins: ["https://not-this-site.example.com"], config: { greeting: "hi" } });

const eventCount = (installId, type) =>
  env.SYN_DB._db.prepare("SELECT COUNT(*) n FROM events WHERE install_id=? AND type=?").get(installId, type).n;

// ---- browser ----
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });

// capture the closed shadow root (keep it closed) + a window-keys baseline, before page scripts run
const INIT = `
  window.__roots = [];
  const __orig = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function(init){ const r = __orig.call(this, init); window.__roots.push(r); return r; };
  window.__winBefore = Object.getOwnPropertyNames(window);
`;

async function openPage({ path = "/hostile", key, viewport }){
  const ctx = await browser.newContext({ viewport: viewport || { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const warns = [];
  page.on("console", (m) => { const t = m.text(); if (t.indexOf("[syn-growth widget]") !== -1) warns.push(t); });
  await page.addInitScript(INIT);
  await page.goto(PAGE + path + "?key=" + encodeURIComponent(key));
  return { ctx, page, warns };
}
const mounted = (page, timeout = 4000) => page.waitForFunction(() => !!document.querySelector("syn-growth-root") && window.__roots.length > 0, null, { timeout }).then(() => true).catch(() => false);
// evaluate inside the closed root by index
const inRoot = (page, expr) => page.evaluate((e) => { const r = window.__roots[0]; return (new Function("r", "return (" + e + ")"))(r); }, expr);

/* ========================= 1. hostile page renders correctly ========================= */
{
  const { ctx, page, warns } = await openPage({ path: "/hostile", key: main.install.install_key });
  const didMount = await mounted(page);
  c("hostile: widget mounts", didMount);
  c("hostile: shadow root is CLOSED (host.shadowRoot === null)", await page.evaluate(() => document.querySelector("syn-growth-root").shadowRoot === null));
  // launcher present with brand aria-label, panel starts hidden
  c("hostile: launcher has brand aria-label", await inRoot(page, "r.querySelector('.launcher').getAttribute('aria-label')") === "Brand main");
  c("hostile: panel starts hidden", await inRoot(page, "r.querySelector('.panel').classList.contains('hidden')"));
  // isolation: font is NOT Comic Sans, no lime borders leaked in
  const font = await inRoot(page, "getComputedStyle(r.querySelector('.wrap')).fontFamily");
  c("hostile: font is our sans stack, not Comic Sans (isolation): " + font, /-apple-system|BlinkMacSystemFont|sans-serif/.test(font) && !/comic/i.test(font));
  const brd = await inRoot(page, "getComputedStyle(r.querySelector('.launcher')).borderStyle");
  c("hostile: launcher border not the host's lime dashed (isolation): " + brd, brd !== "dashed");
  const bs = await inRoot(page, "getComputedStyle(r.querySelector('.panel')).boxSizing");
  c("hostile: box-sizing is border-box inside shadow, not host's content-box: " + bs, bs === "border-box");
  // stacking: our launcher wins over the z-999999999 intruder at its own center point
  const onTop = await page.evaluate(() => {
    const r = window.__roots[0]; const rect = r.querySelector(".launcher").getBoundingClientRect();
    const el = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return el === document.querySelector("syn-growth-root");
  });
  c("hostile: launcher sits ON TOP of the z-999999999 intruder", onTop);
  await page.screenshot({ path: join(SHOTS, "01-hostile-closed.png") });
  // open it
  await page.evaluate(() => window.__roots[0].querySelector(".launcher").click());
  await page.waitForTimeout(120);
  c("hostile: clicking launcher opens the panel", !(await inRoot(page, "r.querySelector('.panel').classList.contains('hidden')")));
  c("hostile: greeting renders from config", await inRoot(page, "r.querySelector('.msgs .bubble').textContent") === "Welcome to Acme! Ask us anything.");
  c("hostile: header shows brand name", await inRoot(page, "r.querySelector('.head .name').textContent") === "Brand main");
  c("hostile: composer has input + send", await inRoot(page, "!!r.querySelector('.composer textarea') && !!r.querySelector('.composer .send')"));
  await page.screenshot({ path: join(SHOTS, "02-hostile-open.png") });
  // Escape closes
  await page.keyboard.press("Escape");
  await page.waitForTimeout(80);
  c("hostile: Escape closes the panel", await inRoot(page, "r.querySelector('.panel').classList.contains('hidden')"));
  // reopen, click outside closes
  await page.evaluate(() => window.__roots[0].querySelector(".launcher").click());
  await page.waitForTimeout(80);
  await page.mouse.click(30, 200);   // far from the panel
  await page.waitForTimeout(80);
  c("hostile: click-outside closes the panel", await inRoot(page, "r.querySelector('.panel').classList.contains('hidden')"));
  c("hostile: no widget warnings on the happy path", warns.length === 0);
  // no global leaks beyond the one namespaced object
  const leaked = await page.evaluate(() => Object.getOwnPropertyNames(window).filter((k) => !window.__winBefore.includes(k) && k !== "__roots" && k !== "__winBefore"));
  c("hostile: only global added is __synGrowth — leaked=[" + leaked.join(",") + "]", leaked.length === 1 && leaked[0] === "__synGrowth");
  await ctx.close();
}

/* ========================= 2. no-CSS page ========================= */
{
  const { ctx, page, warns } = await openPage({ path: "/plain", key: main.install.install_key });
  c("no-CSS: widget mounts", await mounted(page));
  c("no-CSS: panel opens and greets", await (async () => { await page.evaluate(() => window.__roots[0].querySelector(".launcher").click()); await page.waitForTimeout(100); return await inRoot(page, "r.querySelector('.msgs .bubble').textContent") === "Welcome to Acme! Ask us anything."; })());
  c("no-CSS: no warnings", warns.length === 0);
  await page.screenshot({ path: join(SHOTS, "03-plain-open.png") });
  await ctx.close();
}

/* ========================= 3. viewports 1440 / 768 / 375 + mobile full-screen ========================= */
for (const vp of [{ width: 1440, height: 900 }, { width: 768, height: 1024 }, { width: 375, height: 720 }]) {
  const { ctx, page } = await openPage({ path: "/hostile", key: main.install.install_key, viewport: vp });
  const m = await mounted(page);
  c(`viewport ${vp.width}: mounts`, m);
  await page.evaluate(() => window.__roots[0].querySelector(".launcher").click());
  await page.waitForTimeout(120);
  const box = await inRoot(page, "(function(){var p=r.querySelector('.panel');var b=p.getBoundingClientRect();return JSON.stringify({w:Math.round(b.width),h:Math.round(b.height),vw:window.innerWidth,vh:window.innerHeight,radius:getComputedStyle(p).borderTopLeftRadius});})()");
  const b = JSON.parse(box);
  c(`viewport ${vp.width}: panel within viewport (w=${b.w}<=${b.vw}, h=${b.h}<=${b.vh})`, b.w <= b.vw && b.h <= b.vh);
  if (vp.width < 480) {
    c(`viewport ${vp.width}: panel is FULL-SCREEN (w==vw, h==vh, radius 0)`, b.w === b.vw && b.h === b.vh && b.radius === "0px");
  } else {
    c(`viewport ${vp.width}: panel floats ~380 wide (not full-screen)`, b.w <= 380 && b.w < b.vw);
  }
  await page.screenshot({ path: join(SHOTS, `04-viewport-${vp.width}.png`) });
  await ctx.close();
}

/* ========================= 4. double load is a no-op ========================= */
{
  const { ctx, page } = await openPage({ path: "/double", key: main.install.install_key });
  await mounted(page);
  await page.waitForTimeout(300);
  const hosts = await page.evaluate(() => document.querySelectorAll("syn-growth-root").length);
  c("double-load: exactly one host element rendered", hosts === 1);
  await ctx.close();
}

/* ========================= 5. revoked key renders nothing, warns once ========================= */
{
  const { ctx, page, warns } = await openPage({ path: "/hostile", key: revoked.install.install_key });
  const m = await mounted(page, 2500);
  c("revoked: widget renders NOTHING", m === false && (await page.evaluate(() => !document.querySelector("syn-growth-root"))));
  await page.waitForTimeout(200);
  c("revoked: warns exactly once — [" + warns.join(" | ") + "]", warns.length === 1);
  await ctx.close();
}

/* ========================= 6. wrong origin renders nothing, warns once ========================= */
{
  const { ctx, page, warns } = await openPage({ path: "/hostile", key: wrong.install.install_key });
  const m = await mounted(page, 2500);
  c("wrong-origin: widget renders NOTHING", m === false && (await page.evaluate(() => !document.querySelector("syn-growth-root"))));
  await page.waitForTimeout(200);
  c("wrong-origin: warns exactly once — [" + warns.join(" | ") + "]", warns.length === 1);
  await ctx.close();
}

/* ========================= 7. missing key renders nothing, warns once ========================= */
{
  const { ctx, page, warns } = await openPage({ path: "/hostile", key: "" });
  const m = await mounted(page, 2000);
  c("missing-key: renders NOTHING", m === false);
  c("missing-key: warns exactly once — [" + warns.join(" | ") + "]", warns.length === 1);
  await ctx.close();
}

/* ========================= 8. conversation_started lands exactly once per session ========================= */
{
  c("event: 0 before any load", eventCount(evt.install.id, "conversation_started") === 0);
  // session A
  const a = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const pa = await a.newPage(); await pa.addInitScript(INIT);
  await pa.goto(PAGE + "/hostile?key=" + encodeURIComponent(evt.install.install_key));
  await pa.waitForFunction(() => !!document.querySelector("syn-growth-root"), null, { timeout: 4000 });
  await pa.waitForTimeout(400);
  c("event: 1 after first mount", eventCount(evt.install.id, "conversation_started") === 1);
  // reload in the SAME context (session persists) — must NOT double count
  await pa.reload();
  await pa.waitForFunction(() => !!document.querySelector("syn-growth-root"), null, { timeout: 4000 });
  await pa.waitForTimeout(400);
  c("event: still 1 after refresh in the same session", eventCount(evt.install.id, "conversation_started") === 1);
  await a.close();
  // a NEW session (new context) counts once more
  const bctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const pb = await bctx.newPage(); await pb.addInitScript(INIT);
  await pb.goto(PAGE + "/hostile?key=" + encodeURIComponent(evt.install.install_key));
  await pb.waitForFunction(() => !!document.querySelector("syn-growth-root"), null, { timeout: 4000 });
  await pb.waitForTimeout(400);
  c("event: 2 after a fresh session mounts", eventCount(evt.install.id, "conversation_started") === 2);
  await bctx.close();
}

await browser.close();
workerSrv.server.close();
pageSrv.server.close();

console.log("\nScreenshots in " + SHOTS);
console.log(`\nCHECKS: ${ok} passed, ${fail} failed`);
console.log(fail ? "ERRORS: PRESENT" : "ERRORS: NONE");
if (fail) process.exitCode = 1;
