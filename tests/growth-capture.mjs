/* Growth Engine widget — lead capture (browser). Drives the inline capture form against the REAL
 * Worker (node:sqlite D1 shim) with a MOCKED Anthropic upstream, from a separate page origin.
 *
 * Verifies: the form appears when the assistant offers to connect; the consent checkbox is UNTICKED
 * by default; submitting with the box ticked stores consent (consent_sms=1 + consent_at); submitting
 * with it unticked stores the contact but no consent; empty email+phone is rejected inline; "Not now"
 * dismisses; and a detected email (typed in chat) is captured without a form and without consent.
 *
 * Run: node tests/growth-capture.mjs   (SQLite-experimental warning is expected)
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

const tmp = join(tmpdir(), "syn-growth-capture-under-test.mjs");
writeFileSync(tmp, readFileSync(join(ROOT, "worker/syn-growth.js"), "utf8"));
const worker = (await import("file://" + tmp)).default;

function makeD1(){
  const db = new DatabaseSync(":memory:");
  const wrap = (sql) => { let args = [];
    return { bind(...a){ args = a; return this; },
      async first(){ const r = db.prepare(sql).get(...args); return r === undefined ? null : r; },
      async run(){ return db.prepare(sql).run(...args); },
      async all(){ return { results: db.prepare(sql).all(...args) }; } }; };
  return { prepare: (sql) => wrap(sql), batch: async (stmts) => { for (const s of stmts) await s.run(); }, _db: db };
}
const ADMIN = "capture-browser-admin";
const ai = { reply: "I can connect you with our team — share your name and email and we'll follow up.", status: 200 };
const env = {
  SYN_DB: makeD1(), GROWTH_ADMIN_KEY: ADMIN, ANTHROPIC_API_KEY: "sk-server-only",
  ANTHROPIC_FETCH: async () => {
    if (ai.status !== 200) return new Response("boom", { status: ai.status });
    return new Response(JSON.stringify({ content: [{ type: "text", text: ai.reply }], stop_reason: "end_turn", usage: {} }),
      { status: 200, headers: { "content-type": "application/json" } });
  },
};

let ok = 0, fail = 0;
const c = (n, cond) => { cond ? ok++ : fail++; console.log((cond ? "✓" : "✗ FAIL") + " " + n); };

function inproc(method, path, { origin, key, adminKey, body } = {}){
  const h = {};
  if (origin) h["Origin"] = origin;
  if (key) h["X-Install-Key"] = key;
  if (adminKey) h["Authorization"] = "Bearer " + adminKey;
  if (body !== undefined) h["Content-Type"] = "application/json";
  return worker.fetch(new Request("http://inproc" + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined }), env);
}
function toWebRequest(req, host){
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (x) => chunks.push(x));
    req.on("end", () => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      const init = { method: req.method, headers };
      if (req.method !== "GET" && req.method !== "HEAD" && chunks.length) init.body = Buffer.concat(chunks);
      resolve(new Request("http://" + host + req.url, init));
    });
  });
}
async function listen(handler){ const s = http.createServer(handler); await new Promise((r) => s.listen(0, "127.0.0.1", r)); return { s, port: s.address().port }; }

const workerSrv = await listen(async (req, res) => {
  const webRes = await worker.fetch(await toWebRequest(req, req.headers.host), env);
  res.statusCode = webRes.status;
  webRes.headers.forEach((v, k) => res.setHeader(k, v));
  res.end(Buffer.from(await webRes.arrayBuffer()));
});
const WORKER = "http://127.0.0.1:" + workerSrv.port;
const tpl = readFileSync(join(HERE, "fixtures/plain.html"), "utf8");
const pageSrv = await listen((req, res) => {
  const u = new URL(req.url, "http://x");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(tpl.replace(/__WORKER__/g, WORKER).replace(/__KEY__/g, u.searchParams.get("key") || ""));
});
const PAGE = "http://127.0.0.1:" + pageSrv.port;

const t = (await (await inproc("POST", "/admin/tenants", { adminKey: ADMIN, body: { name: "Acme", slug: "acme" } })).json()).tenant;
const b = (await (await inproc("POST", `/admin/tenants/${t.id}/brands`, { adminKey: ADMIN, body: { name: "Acme Co", profile: { voice: "friendly", banned_claims: ["cheapest in town"] } } })).json()).brand;
const install = (await (await inproc("POST", `/admin/tenants/${t.id}/installs`, { adminKey: ADMIN, body: { brand_id: b.id, allowed_origins: [PAGE], config: { greeting: "Hi! How can we help?" } } })).json()).install;

const contactByEmail = (email) => env.SYN_DB._db.prepare("SELECT * FROM contacts WHERE email=?").get(email);

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const INIT = "window.__roots=[];const o=Element.prototype.attachShadow;Element.prototype.attachShadow=function(i){const r=o.call(this,i);window.__roots.push(r);return r;};";

async function open(){
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await ctx.newPage();
  await page.addInitScript(INIT);
  await page.goto(PAGE + "/plain?key=" + encodeURIComponent(install.install_key));
  await page.waitForFunction(() => !!document.querySelector("syn-growth-root") && window.__roots.length, null, { timeout: 4000 });
  await page.evaluate(() => window.__roots[0].querySelector(".launcher").click());
  await page.waitForTimeout(80);
  return { ctx, page };
}
function send(page, text){
  return page.evaluate((v) => {
    const r = window.__roots[0], ta = r.querySelector(".composer textarea");
    ta.value = v; ta.focus();
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }, text);
}
const hasForm = (page) => page.evaluate(() => !!window.__roots[0].querySelector(".capform"));
const waitForm = (page) => page.waitForFunction(() => !!window.__roots[0].querySelector(".capform"), null, { timeout: 4000 });

/* 1. Assistant offers → the inline form appears with an UNTICKED consent box */
{
  ai.reply = "I can connect you with our team — share your name and email and we'll follow up."; ai.status = 200;
  const { ctx, page } = await open();
  await send(page, "can someone reach out to me?");
  await waitForm(page).catch(() => {});
  c("form appears when the assistant offers to connect", await hasForm(page));
  const ticked = await page.evaluate(() => window.__roots[0].querySelector(".capform .cf-consent input").checked);
  c("consent checkbox is UNTICKED by default", ticked === false);
  await page.screenshot({ path: join(SHOTS, "12-capture-form.png") });
  await ctx.close();
}

/* 2. Empty email+phone → inline error, nothing captured */
{
  const { ctx, page } = await open();
  await send(page, "reach out?");
  await waitForm(page).catch(() => {});
  await page.evaluate(() => window.__roots[0].querySelector(".capform .cf-submit").click());
  await page.waitForTimeout(150);
  const errShown = await page.evaluate(() => { const e = window.__roots[0].querySelector(".capform .cf-err"); return e && e.style.display !== "none" && !!e.textContent; });
  c("empty email+phone shows an inline error and does not submit", errShown && (await hasForm(page)));
  await ctx.close();
}

/* 3. Ticked consent → contact stored WITH consent */
{
  const { ctx, page } = await open();
  await send(page, "please follow up");
  await waitForm(page).catch(() => {});
  await page.evaluate(() => {
    const f = window.__roots[0].querySelector(".capform");
    f.querySelector("input[type=email]").value = "ticked@ex.com";
    f.querySelector(".cf-consent input").checked = true;
    f.querySelector(".cf-submit").click();
  });
  await page.waitForFunction(() => [...window.__roots[0].querySelectorAll(".bubble")].some(x => /be in touch/i.test(x.textContent)), null, { timeout: 4000 }).catch(() => {});
  c("ticked form: shows a thank-you bubble and removes the form", !(await hasForm(page)) && await page.evaluate(() => [...window.__roots[0].querySelectorAll(".bubble")].some(x => /be in touch/i.test(x.textContent))));
  const row = contactByEmail("ticked@ex.com");
  c("ticked form: contact stored with consent_sms=1 + consent_at", !!row && row.consent_sms === 1 && !!row.consent_at);
  await ctx.close();
}

/* 4. Unticked consent → contact stored WITHOUT consent */
{
  const { ctx, page } = await open();
  await send(page, "follow up please");
  await waitForm(page).catch(() => {});
  await page.evaluate(() => {
    const f = window.__roots[0].querySelector(".capform");
    f.querySelector("input[type=email]").value = "unticked@ex.com";   // box left unticked
    f.querySelector(".cf-submit").click();
  });
  await page.waitForFunction(() => [...window.__roots[0].querySelectorAll(".bubble")].some(x => /be in touch/i.test(x.textContent)), null, { timeout: 4000 }).catch(() => {});
  const row = contactByEmail("unticked@ex.com");
  c("unticked form: contact stored, consent_sms=0, consent_at null", !!row && row.consent_sms === 0 && row.consent_at === null);
  await ctx.close();
}

/* 5. "Not now" dismisses the form */
{
  const { ctx, page } = await open();
  await send(page, "maybe later");
  await waitForm(page).catch(() => {});
  await page.evaluate(() => window.__roots[0].querySelector(".capform .cf-skip").click());
  await page.waitForTimeout(120);
  c("'Not now' dismisses the form", !(await hasForm(page)));
  await ctx.close();
}

/* 6. A detected email (typed in chat) is captured with NO form and NO consent */
{
  ai.reply = "Thanks! Someone from our team will be in touch."; ai.status = 200;
  const { ctx, page } = await open();
  await send(page, "sure, my email is chatuser@ex.com");
  await page.waitForFunction(() => [...window.__roots[0].querySelectorAll(".bubble")].some(x => /be in touch/i.test(x.textContent)), null, { timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(150);
  c("detected email: no capture form is shown (already have details)", !(await hasForm(page)));
  const row = contactByEmail("chatuser@ex.com");
  c("detected email: contact stored server-side with consent_sms=0", !!row && row.consent_sms === 0 && row.consent_at === null);
  await ctx.close();
}

await browser.close();
workerSrv.s.close();
pageSrv.s.close();

console.log("\nScreenshots in " + SHOTS);
console.log(`\nCHECKS: ${ok} passed, ${fail} failed`);
console.log(fail ? "ERRORS: PRESENT" : "ERRORS: NONE");
if (fail) process.exitCode = 1;
