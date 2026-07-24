/* Growth Engine widget — AI messaging (browser). Drives the wired composer against the REAL
 * Worker (node:sqlite D1 shim) with a MOCKED Anthropic upstream, from a separate page origin.
 *
 * Verifies: Enter sends + renders visitor→typing→reply; Shift+Enter inserts a newline (no send);
 * the send button works; an upstream failure renders as COPY (never a raw error); a guardrail-
 * blocked reply shows the safe offer; the conversation persists across a page reload. The
 * Anthropic key never leaves the server (the browser only ever calls /w/messages).
 *
 * Run: node tests/growth-widget-ai.mjs   (SQLite-experimental warning is expected)
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

const tmp = join(tmpdir(), "syn-growth-ai-under-test.mjs");
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
const ADMIN = "ai-browser-admin";
// Mutable upstream mock — tests set reply/status before each interaction.
const ai = { reply: "Thanks for reaching out — how can we help with our services?", status: 200 };
const env = {
  SYN_DB: makeD1(), GROWTH_ADMIN_KEY: ADMIN, ANTHROPIC_API_KEY: "sk-server-only-never-in-browser",
  ANTHROPIC_FETCH: async () => {
    if (ai.status !== 200) return new Response("upstream boom", { status: ai.status });
    return new Response(JSON.stringify({ content: [{ type: "text", text: ai.reply }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } }),
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

// Seed a brand with a real profile + banned claims, allowlisting the page origin.
const t = (await (await inproc("POST", "/admin/tenants", { adminKey: ADMIN, body: { name: "Acme", slug: "acme" } })).json()).tenant;
const b = (await (await inproc("POST", `/admin/tenants/${t.id}/brands`, { adminKey: ADMIN, body: { name: "Acme Co", profile: {
  voice: "friendly", faq: [{ q: "Hours?", a: "9 to 5, Monday to Friday." }], banned_claims: ["cheapest in town"],
} } })).json()).brand;
const install = (await (await inproc("POST", `/admin/tenants/${t.id}/installs`, { adminKey: ADMIN, body: { brand_id: b.id, allowed_origins: [PAGE], config: { greeting: "Hi! How can we help?" } } })).json()).install;

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const INIT = "window.__roots=[];const o=Element.prototype.attachShadow;Element.prototype.attachShadow=function(i){const r=o.call(this,i);window.__roots.push(r);return r;};";

async function freshPage(){
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await ctx.newPage();
  await page.addInitScript(INIT);
  await page.goto(PAGE + "/plain?key=" + encodeURIComponent(install.install_key));
  await page.waitForFunction(() => !!document.querySelector("syn-growth-root") && window.__roots.length, null, { timeout: 4000 });
  await page.evaluate(() => window.__roots[0].querySelector(".launcher").click());   // open panel
  await page.waitForTimeout(100);
  return { ctx, page };
}
const rootEval = (page, fn, arg) => page.evaluate(fn, arg);
// bubble texts inside the closed shadow root
const bubbles = (page) => page.evaluate(() => [...window.__roots[0].querySelectorAll(".bubble")].map(b => b.textContent));
const hasTyping = (page) => page.evaluate(() => !!window.__roots[0].querySelector(".typing"));
function typeAndKey(page, text, shift){
  return page.evaluate(({ text, shift }) => {
    const r = window.__roots[0], ta = r.querySelector(".composer textarea");
    ta.value = text; ta.focus();
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: !!shift, bubbles: true }));
  }, { text, shift });
}

/* 1. Enter sends: visitor bubble immediately, typing indicator, then the reply */
{
  ai.reply = "We're open 9 to 5, Monday to Friday."; ai.status = 200;
  const { ctx, page } = await freshPage();
  await typeAndKey(page, "What are your hours?", false);
  // visitor bubble shows right away
  const early = await bubbles(page);
  c("send: visitor message shows immediately", early.includes("What are your hours?"));
  const typingSeen = await hasTyping(page);
  // wait for reply
  await page.waitForFunction((txt) => [...window.__roots[0].querySelectorAll(".bubble")].some(b => b.textContent === txt), "We're open 9 to 5, Monday to Friday.", { timeout: 4000 }).catch(() => {});
  const after = await bubbles(page);
  c("send: typing indicator appeared then the reply rendered", typingSeen && after.includes("We're open 9 to 5, Monday to Friday.") && !(await hasTyping(page)));
  c("send: greeting + visitor + reply all present", after[0] === "Hi! How can we help?" && after.includes("What are your hours?"));
  await page.screenshot({ path: join(SHOTS, "10-ai-conversation.png") });
  await ctx.close();
}

/* 2. Shift+Enter inserts a newline and does NOT send */
{
  const { ctx, page } = await freshPage();
  const before = (await bubbles(page)).length;
  await typeAndKey(page, "line one", true);
  await page.waitForTimeout(200);
  const after = (await bubbles(page)).length;
  const val = await page.evaluate(() => window.__roots[0].querySelector(".composer textarea").value);
  c("Shift+Enter does not send", after === before);
  c("Shift+Enter keeps the text in the box", val === "line one");
  await ctx.close();
}

/* 3. The send button also sends */
{
  ai.reply = "Sure, happy to help!"; ai.status = 200;
  const { ctx, page } = await freshPage();
  await page.evaluate(() => { const r = window.__roots[0]; r.querySelector(".composer textarea").value = "hello there"; r.querySelector(".composer .send").click(); });
  await page.waitForFunction(() => [...window.__roots[0].querySelectorAll(".bubble")].some(b => b.textContent === "Sure, happy to help!"), null, { timeout: 4000 }).catch(() => {});
  const t2 = await bubbles(page);
  c("send button: sends and renders the reply", t2.includes("hello there") && t2.includes("Sure, happy to help!"));
  await ctx.close();
}

/* 4. Upstream failure renders as copy, never a raw error */
{
  ai.status = 500;
  const { ctx, page } = await freshPage();
  await typeAndKey(page, "anything", false);
  await page.waitForFunction(() => window.__roots[0].querySelectorAll(".bubble").length >= 3, null, { timeout: 4000 }).catch(() => {});
  const t3 = await bubbles(page);
  const last = t3[t3.length - 1];
  c("failure: a copy line is shown, not a raw error", /follow up|trouble responding/i.test(last) && !/500|error|undefined|null/i.test(last));
  c("failure: no typing indicator left hanging", !(await hasTyping(page)));
  await page.screenshot({ path: join(SHOTS, "11-ai-failure-copy.png") });
  await ctx.close();
  ai.status = 200;
}

/* 5. A guardrail-blocked reply shows the safe offer (never the banned claim) */
{
  ai.reply = "We are the cheapest in town, hands down!"; ai.status = 200;
  const { ctx, page } = await freshPage();
  await typeAndKey(page, "are you cheap?", false);
  await page.waitForFunction(() => window.__roots[0].querySelectorAll(".bubble").length >= 3, null, { timeout: 4000 }).catch(() => {});
  const t4 = await bubbles(page);
  const last = t4[t4.length - 1];
  c("guardrail: visitor never sees the banned claim", !/cheapest/i.test(last) && /connect you with our team/i.test(last));
  await ctx.close();
}

/* 6. Conversation persists across a page reload (same session) */
{
  ai.reply = "Reply A"; ai.status = 200;
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await ctx.newPage();
  await page.addInitScript(INIT);
  await page.goto(PAGE + "/plain?key=" + encodeURIComponent(install.install_key));
  await page.waitForFunction(() => !!document.querySelector("syn-growth-root"), null, { timeout: 4000 });
  await page.evaluate(() => window.__roots[0].querySelector(".launcher").click());
  await typeAndKey(page, "first turn", false);
  await page.waitForFunction(() => [...window.__roots[0].querySelectorAll(".bubble")].some(b => b.textContent === "Reply A"), null, { timeout: 4000 }).catch(() => {});
  const conv1 = await page.evaluate((id) => sessionStorage.getItem("syn_gw_conv_" + id), install.id);
  // reload (same context → sessionStorage persists)
  await page.reload();
  await page.waitForFunction(() => !!document.querySelector("syn-growth-root"), null, { timeout: 4000 });
  const conv2 = await page.evaluate((id) => sessionStorage.getItem("syn_gw_conv_" + id), install.id);
  c("persistence: conversation id survives a reload in the same session", !!conv1 && conv1 === conv2);
  // the second turn continues the SAME conversation → inquiry_received still fires only once
  ai.reply = "Reply B";
  await page.evaluate(() => window.__roots[0].querySelector(".launcher").click());
  await typeAndKey(page, "second turn", false);
  await page.waitForFunction(() => [...window.__roots[0].querySelectorAll(".bubble")].some(b => b.textContent === "Reply B"), null, { timeout: 4000 }).catch(() => {});
  const inq = env.SYN_DB._db.prepare("SELECT COUNT(*) n FROM events WHERE type='inquiry_received' AND payload LIKE ?").get('%' + conv1 + '%').n;
  c("persistence: continuing the conversation does not re-fire inquiry_received", inq === 1);
  await ctx.close();
}

await browser.close();
workerSrv.s.close();
pageSrv.s.close();

console.log("\nScreenshots in " + SHOTS);
console.log(`\nCHECKS: ${ok} passed, ${fail} failed`);
console.log(fail ? "ERRORS: PRESENT" : "ERRORS: NONE");
if (fail) process.exitCode = 1;
