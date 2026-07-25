/*
 * Growth client dashboard (Prompt "Growth client dashboard"). Drives the REAL-auth login path in cloud
 * mode (no __GATE_BYPASS__): sign in via /auth/login → a product='growth' user lands on the self-contained
 * Growth dashboard (#growth), never the Workspace. Both workers are mocked: syn-core /auth/login + health,
 * and syn-growth /me/* (summary, receipt, leads, bookings, receipts, install, config GET/PUT). Asserts the
 * headline/receipt/leads/bookings/snippet/past-receipts render, config edits PUT back, the snippet copies,
 * the session token authorizes every /me call, and a Growth user cannot reach the Workspace (#app off).
 *
 * Run: PW=... CHROME=... node tests/growth-dashboard.mjs
 */
import { fileURLToPath } from 'url';
import path from 'path';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PW = process.env.PW || '/tmp/node_modules/playwright-core/index.js';
const CHROME = process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const U = process.env.APP || ('file://' + path.resolve(HERE, '..', 'index.html'));
const { chromium } = (await import(PW)).default;

// Mock both Workers. Records auth-header + PUT bodies + which endpoints were hit onto window.__gv.
const MOCK = () => {
  const CORE = "https://syn-core.henrybello.workers.dev";
  const GROW = "https://syn-growth.henrybello.workers.dev";
  const TOKEN = "eyJ0eXAiOiJzZXNzIn0.sig-mock";   // shape only; the mock trusts it
  window.__gv = { hits: [], puts: [], authHeaders: [], config: {
    brand_name: "Atlas Plumbing", voice: "warm", greeting: "Hi there", scheduling_url: "https://cal.example/atlas",
    job_value_cents: 25000, faq: [{ q: "Hours?", a: "9-5" }], business_hours: { days: [1,2,3,4,5], start: 9, end: 17 } } };
  const J = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: { "content-type": "application/json" } });
  const HTML = (s, status) => new Response(s, { status: status || 200, headers: { "content-type": "text/html; charset=utf-8" } });
  const orig = window.fetch.bind(window);
  window.fetch = async (url, opts) => {
    url = (typeof url === "string") ? url : (url && url.url) || "";
    opts = opts || {};
    const auth = (opts.headers && (opts.headers.Authorization || opts.headers.authorization)) || "";
    if (url.startsWith(CORE)){
      const p = url.slice(CORE.length);
      window.__gv.hits.push(p);
      if (p === "/" || p === "") return J({ ok: true });
      if (p === "/gate") return J({ error: "gate_disabled" }, 404);   // prove the old gate is NOT the path
      if (p === "/auth/login"){
        let b = {}; try { b = JSON.parse(opts.body || "{}"); } catch (_){}
        if (b.email === "owner@atlas.test" && b.password === "pw12345678")
          return J({ token: TOKEN, exp: Math.floor(Date.now()/1000) + 3600, user: { email: "owner@atlas.test", product: "growth", tenant_id: "ten_atlas", role: "member" } });
        return J({ error: "invalid_credentials" }, 401);
      }
      if (p === "/auth/verify") return J({ ok: true, verified: true });
      return J({ error: "not_found" }, 404);
    }
    if (url.startsWith(GROW)){
      const p = url.slice(GROW.length);
      window.__gv.hits.push(p);
      window.__gv.authHeaders.push(auth);
      const C = window.__gv.config;
      if (p.startsWith("/me/summary")) return J({ period: { label: "June 2026" }, headline: {
        inquiries_received: 12, inquiries_answered: 9, after_hours_inquiries: 3, leads_captured: 7,
        followups_sent: 5, appointments_booked: 4, value_recovered_cents: 100000, value_configured: true },
        guarantee: { captured_value: true, verdict: "Value captured this period — 7 captured leads and 4 bookings." } });
      // NOTE: check plural /me/receipts BEFORE singular /me/receipt (startsWith would otherwise swallow it).
      if (p.startsWith("/me/receipts/")) return HTML("<html><body>Past Receipt</body></html>");
      if (p.startsWith("/me/receipts")) return J({ receipts: [{ id: "rcp_may", label: "May 2026", period_start: "2026-05-01T00:00:00.000Z", captured_value: true, value_recovered_cents: 75000 }] });
      if (p.startsWith("/me/receipt?") && p.includes("format=html")) return HTML("<html><body>Value Receipt</body></html>");
      if (p.startsWith("/me/receipt")) return J({ receipt: { metrics: { value: { formula: "Appointments booked (4) × average job value ($250.00, in effect from 2026-05-01) = $1,000.00", value_recovered_cents: 100000 }, guarantee: { verdict: "Value captured this period." } } }, live: true });
      if (p.startsWith("/me/leads")) return J({ contacts: [
        { id: "c1", name: "Ada Lovelace", email: "ada@atlas.test", phone: "+15550001", status: "booked", source: "chat", first_seen: "2026-06-03T10:00:00.000Z" },
        { id: "c2", name: "Bo Peep", email: "bo@atlas.test", status: "new", source: "chat", first_seen: "2026-06-04T11:00:00.000Z" } ] });
      if (p.startsWith("/me/bookings")) return J({ count: 1, bookings: [{ id: "b1", name: "Ada Lovelace", email: "ada@atlas.test", when: "Tue 3pm", booked_at: "2026-06-07T15:00:00.000Z" }] });
      if (p.startsWith("/me/install")) return J({ install: { install_key: "syn_pk_live_ABC123", allowed_origins: ["https://atlas.com"], status: "active" }, snippet: '<script async src="' + GROW + '/w/widget.js" data-key="syn_pk_live_ABC123"></script>' });
      if (p === "/me/config" && (opts.method === "PUT")){
        let b = {}; try { b = JSON.parse(opts.body || "{}"); } catch (_){}
        window.__gv.puts.push(b);
        window.__gv.config = Object.assign({}, C, b);
        return J({ config: window.__gv.config });
      }
      if (p === "/me/config") return J({ config: C });
      return J({ error: "not_found" }, 404);
    }
    return orig(url, opts);
  };
};

const results = [];
const R = (name, pass, detail) => { results.push({ name, pass, detail }); console.log((pass ? "✓" : "✗ FAIL") + " " + name + (pass ? "" : "  — " + (detail || ""))); };

const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
await ctx.addInitScript(MOCK);   // NOTE: no __GATE_BYPASS__ → gateActive() is true → the real-auth path runs
const page = await ctx.newPage();
page.on('pageerror', e => R("no page errors", false, String(e)));

try {
  await page.goto(U);
  await page.waitForSelector('#site.on', { timeout: 15000 });   // logged-out, cloud healthy → marketing site
  await page.evaluate(() => siteAuth('signin'));
  await page.waitForSelector('#authScreen.on', { timeout: 8000 });
  await page.fill('#aEmail', 'owner@atlas.test');
  await page.fill('#aPass', 'pw12345678');
  await page.evaluate(() => authSubmit());

  // Real-auth login → Growth dashboard scene
  await page.waitForSelector('#growth.on', { timeout: 12000 });
  R("real-auth login lands a Growth user on #growth (no gate)", true);

  const hits = await page.evaluate(() => window.__gv.hits);
  R("login used /auth/login, never /gate", hits.includes('/auth/login') && !hits.some(h => h === '/gate'), JSON.stringify(hits));

  // Growth user must NOT be in the Workspace app
  const appOn = await page.evaluate(() => document.getElementById('app').classList.contains('on'));
  R("Growth user cannot reach the Workspace (#app off)", appOn === false);

  await page.waitForSelector('#gvBody .gv-strip', { timeout: 8000 });

  // Headline strip numbers
  const stripText = await page.evaluate(() => document.querySelector('#gvBody .gv-strip').innerText);
  R("headline strip renders real numbers (12 inquiries, 7 leads, 4 bookings)", /12/.test(stripText) && /\b7\b/.test(stripText) && /\b4\b/.test(stripText), stripText.replace(/\n/g, ' '));
  R("headline shows value recovered ($1,000.00)", /\$1,000\.00/.test(stripText), stripText.replace(/\n/g, ' '));

  // Guarantee verdict shown plainly
  const verdict = await page.evaluate(() => { const el = document.querySelector('.gv-verdict'); return el ? el.textContent : ""; });
  R("current Receipt guarantee verdict shown plainly", /Value captured this period/.test(verdict), verdict);

  // Every /me call carried the session token (tenant scoping is by the session)
  const auths = await page.evaluate(() => window.__gv.authHeaders);
  R("every /me request carried the Bearer session token", auths.length > 0 && auths.every(a => /^Bearer /.test(a)), JSON.stringify(auths.slice(0,3)));

  // Recent leads + bookings
  const bodyText = await page.evaluate(() => document.getElementById('gvBody').innerText);
  R("recent leads render (Ada Lovelace, booked)", /Ada Lovelace/.test(bodyText) && /booked/.test(bodyText));
  R("recent bookings render", /Tue 3pm/.test(bodyText) || /Ada Lovelace/.test(bodyText));
  R("past Receipts render (May 2026)", /May 2026/.test(bodyText));

  // Install snippet + copy
  const snippet = await page.evaluate(() => { const el = document.getElementById('gvSnippet'); return el ? el.textContent : ""; });
  R("install snippet shows the embed with data-key", /data-key="syn_pk_live_ABC123"/.test(snippet) && /\/w\/widget\.js/.test(snippet));
  await page.evaluate(() => document.getElementById('gvCopy').click());
  const copied = await page.evaluate(() => window.__gvCopied || "");
  R("copy snippet button copies the exact embed code", copied === snippet && copied.length > 0);

  // Config edit writes back (job value + voice)
  await page.fill('#gvJob', '300');
  await page.fill('#gvVoice', 'crisp and direct');
  await page.fill('#gvSched', 'https://cal.example/new');
  await page.evaluate(() => document.getElementById('gvSave').click());
  await page.waitForFunction(() => window.__gv.puts.length > 0, { timeout: 6000 });
  const put = await page.evaluate(() => window.__gv.puts[window.__gv.puts.length - 1]);
  R("config PUT writes job value back (300 → 30000 cents)", put && put.job_value_cents === 30000, JSON.stringify(put));
  R("config PUT writes voice + scheduling link back", put && put.voice === 'crisp and direct' && put.scheduling_url === 'https://cal.example/new', JSON.stringify(put));
  const savedTxt = await page.evaluate(() => { const el = document.getElementById('gvSaved'); return el ? el.textContent : ""; });
  R("config save shows a confirmation", /Saved/.test(savedTxt), savedTxt);

  // Sign out returns to the auth screen, clears the session
  await page.evaluate(() => document.getElementById('gvSignout').click());
  await page.waitForSelector('#authScreen.on', { timeout: 6000 });
  const cleared = await page.evaluate(() => { try { return !localStorage.getItem('syn5:auth'); } catch (e) { return true; } });
  R("sign out clears the session and returns to sign-in", cleared);

  // Wrong password is rejected generically (still real-auth)
  await page.fill('#aEmail', 'owner@atlas.test');
  await page.fill('#aPass', 'wrongpass');
  await page.evaluate(() => authSubmit());
  const errTxt = await page.evaluate(async () => { await new Promise(r => setTimeout(r, 400)); const el = document.getElementById('authErr'); return el ? el.textContent : ""; });
  R("wrong password rejected generically", /Wrong email or password/.test(errTxt), errTxt);

} catch (e) {
  R("suite ran without fatal error", false, String(e && e.stack || e));
}

await browser.close();
const passed = results.filter(r => r.pass).length, failed = results.filter(r => !r.pass).length;
console.log(`\nCHECKS: ${passed} passed, ${failed} failed`);
console.log("ERRORS: " + (failed ? "PRESENT" : "NONE"));
process.exit(failed ? 1 : 0);
