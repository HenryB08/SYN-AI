/*
 * Auth experience (Prompt "Complete the authentication experience"). Drives the real-auth UI in cloud
 * mode (no __GATE_BYPASS__): the finished sign-in surface (email/password + Google + forgot + signup),
 * the email deep links (#verify / #reset), the Google return (#token) and failure (#autherror), and
 * every failure state as human copy. syn-core /auth/* is mocked; the Google return also mocks syn-growth
 * /me/* so a Google user lands logged in with no verification step.
 *
 * Run: PW=... CHROME=... node tests/auth-experience.mjs
 */
import { fileURLToPath } from 'url';
import path from 'path';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PW = process.env.PW || '/tmp/node_modules/playwright-core/index.js';
const CHROME = process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const U = process.env.APP || ('file://' + path.resolve(HERE, '..', 'index.html'));
const { chromium } = (await import(PW)).default;

const MOCK = () => {
  const CORE = "https://syn-core.henrybello.workers.dev";
  const GROW = "https://syn-growth.henrybello.workers.dev";
  window.__m = { login: "ok", verify: "ok", reset: "ok" };   // per-test knobs
  window.__calls = [];
  const J = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { "content-type": "application/json" } });
  const orig = window.fetch.bind(window);
  window.fetch = async (url, opts) => {
    url = (typeof url === "string") ? url : (url && url.url) || ""; opts = opts || {};
    if (url.startsWith(CORE)){
      const p = url.slice(CORE.length); window.__calls.push(p);
      if (p === "/" || p === "") return J({ ok: true });
      if (p === "/auth/login"){
        if (window.__m.login === "wrong") return J({ error: "invalid_credentials" }, 401);
        if (window.__m.login === "unverified") return J({ error: "email_not_verified" }, 403);
        if (window.__m.login === "ratelimited") return J({ error: "too_many_attempts" }, 429);
        return J({ token: "sess.tok", exp: Math.floor(Date.now()/1000)+3600, user: { email: "owner@atlas.test", product: "growth", tenant_id: "ten_atlas", role: "member" } });
      }
      if (p === "/auth/signup") return J({ ok: true, message: "If that email can sign up, a verification link is on its way." });
      if (p === "/auth/forgot") return J({ ok: true, message: "If that account exists, a reset link is on its way." });
      if (p === "/auth/verify") return window.__m.verify === "ok" ? J({ ok: true, verified: true }) : J({ error: "invalid_token" }, 400);
      if (p === "/auth/reset")  return window.__m.reset === "ok" ? J({ ok: true, reset: true }) : J({ error: "invalid_token" }, 400);
      if (p === "/auth/me") return J({ user: { email: "owner@atlas.test", product: "growth", tenant_id: "ten_atlas", role: "member" } });
      return J({ error: "not_found" }, 404);
    }
    if (url.startsWith(GROW)){   // minimal /me/* so a Google/growth user can render the dashboard
      const p = url.slice(GROW.length);
      if (p.startsWith("/me/summary")) return J({ period: { label: "June 2026" }, headline: { inquiries_received: 0, leads_captured: 0, followups_sent: 0, appointments_booked: 0, value_recovered_cents: 0, value_configured: false }, guarantee: { captured_value: false, verdict: "No value captured this period." } });
      if (p.startsWith("/me/receipts")) return J({ receipts: [] });
      if (p.startsWith("/me/receipt")) return J({ receipt: { metrics: { value: { formula: "" } } }, live: true });
      if (p.startsWith("/me/leads")) return J({ contacts: [] });
      if (p.startsWith("/me/bookings")) return J({ count: 0, bookings: [] });
      if (p.startsWith("/me/install")) return J({ install: { install_key: "syn_pk_live_X" }, snippet: '<script src="x" data-key="syn_pk_live_X"></script>' });
      if (p === "/me/config") return J({ config: { brand_name: "Atlas", voice: "", faq: [], business_hours: { days:[1,2,3,4,5], start:9, end:17 }, scheduling_url: "", job_value_cents: null } });
      return J({ error: "nf" }, 404);
    }
    return orig(url, opts);
  };
};

const results = [];
const R = (n, ok, d) => { results.push(ok); console.log((ok ? "✓" : "✗ FAIL") + " " + n + (ok ? "" : "  — " + (d || ""))); };

const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, colorScheme: 'dark' });
await ctx.addInitScript(MOCK);   // no __GATE_BYPASS__ → gateActive() true → real-auth UI
const errText = async (page) => { await page.waitForTimeout(350); return page.evaluate(() => { const e = document.getElementById("authErr"); return e ? e.textContent : ""; }); };

try {
  // ---- the finished sign-in surface ----
  {
    const page = await ctx.newPage();
    await page.goto(U); await page.waitForSelector('#site.on', { timeout: 15000 });
    await page.evaluate(() => siteAuth('signin')); await page.waitForSelector('#authScreen.on');
    await page.waitForSelector('#gAuthBtn');
    const has = await page.evaluate(() => ({
      google: !!document.getElementById('gAuthBtn'), email: !!document.getElementById('aEmail'), pass: !!document.getElementById('aPass'),
      forgot: /Forgot password/.test(document.getElementById('authSwitch').innerText), signup: /Create an account/.test(document.getElementById('authSwitch').innerText) }));
    R("sign-in shows Google + email/password + forgot + signup", has.google && has.email && has.pass && has.forgot && has.signup, JSON.stringify(has));

    // wrong password → human copy
    await page.evaluate(() => { window.__m.login = "wrong"; });
    await page.fill('#aEmail', 'owner@atlas.test'); await page.fill('#aPass', 'nope'); await page.evaluate(() => authSubmit());
    R("wrong password → human copy", /don’t match|don't match/.test(await errText(page)));
    // unverified → human copy
    await page.evaluate(() => { window.__m.login = "unverified"; }); await page.evaluate(() => authSubmit());
    R("unverified account → human copy (verify your email)", /verify your email/i.test(await errText(page)));
    // rate limited → human copy
    await page.evaluate(() => { window.__m.login = "ratelimited"; }); await page.evaluate(() => authSubmit());
    R("rate-limited → human copy", /Too many attempts/i.test(await errText(page)));
    await page.close();
  }

  // ---- signup flow (+ invite-gate generic copy) ----
  {
    const page = await ctx.newPage();
    await page.goto(U); await page.waitForSelector('#site.on'); await page.evaluate(() => siteAuth('signin')); await page.waitForSelector('#authScreen.on');
    await page.evaluate(() => showCloudAuth('signup')); await page.waitForSelector('#gAuthBtn');
    // short password → validation copy, no network
    await page.fill('#aEmail', 'new@atlas.test'); await page.fill('#aPass', 'short'); await page.evaluate(() => authSubmit());
    R("signup rejects a <8 char password with copy", /at least 8/i.test(await errText(page)));
    // valid → generic 'check your inbox' (same whether allowed or invite-blocked → no enumeration)
    await page.fill('#aPass', 'longenough1'); await page.evaluate(() => authSubmit());
    R("signup → generic 'check your inbox' copy (invite gate honored server-side)", /confirm your email|check your inbox/i.test(await errText(page)));
    await page.close();
  }

  // ---- forgot-password flow (the thing missing when Henry got locked out) ----
  {
    const page = await ctx.newPage();
    await page.goto(U); await page.waitForSelector('#site.on'); await page.evaluate(() => siteAuth('signin')); await page.waitForSelector('#authScreen.on');
    await page.evaluate(() => showCloudAuth('forgot')); await page.waitForTimeout(150);
    await page.fill('#aEmail', 'owner@atlas.test'); await page.evaluate(() => authSubmit());
    R("forgot-password → 'reset link is on its way' copy", /reset link is on its way/i.test(await errText(page)));
    const called = await page.evaluate(() => window.__calls.includes('/auth/forgot'));
    R("forgot-password actually calls /auth/forgot", called);
    await page.close();
  }

  // ---- email verification landing (#verify=) ----
  {
    const page = await ctx.newPage();
    await page.goto(U + '#verify=abc123'); await page.waitForSelector('#authScreen.on', { timeout: 15000 });
    R("verify link confirms + routes to sign-in with copy", /Email confirmed/i.test(await errText(page)));
    await page.close();
  }

  // ---- password reset landing (#reset=) — in-card, no prompt() ----
  {
    const page = await ctx.newPage();
    await page.goto(U + '#reset=tok999'); await page.waitForSelector('#authScreen.on', { timeout: 15000 });
    await page.waitForSelector('#aPass');
    const isReset = await page.evaluate(() => document.getElementById('authSub').textContent);
    R("reset link opens an in-card 'set a new password' view", /Set a new password/i.test(isReset));
    await page.fill('#aPass', 'freshpass12'); await page.evaluate(() => authSubmit());
    R("reset → success copy + back to sign-in", /Password updated/i.test(await errText(page)));
    // invalid reset token → human copy
    const p2 = await ctx.newPage();
    await p2.addInitScript(() => { window.__resetBad = true; });
    await p2.goto(U + '#reset=tokbad'); await p2.waitForSelector('#aPass', { timeout: 15000 });
    await p2.evaluate(() => { window.__m.reset = "bad"; });
    await p2.fill('#aPass', 'freshpass12'); await p2.evaluate(() => authSubmit());
    R("invalid reset token → human copy", /invalid or has expired/i.test(await errText(p2)));
    await p2.close(); await page.close();
  }

  // ---- Google return: #token → logged in, no verify step (growth user lands on dashboard) ----
  {
    const page = await ctx.newPage();
    await page.goto(U + '#token=sess.tok&product=growth');
    const landed = await page.waitForSelector('#growth.on', { timeout: 15000 }).then(() => true).catch(() => false);
    R("Google return (#token) lands the user logged in — no verification step", landed);
    const stored = await page.evaluate(() => { try { return !!JSON.parse(localStorage.getItem('syn5:auth')).token; } catch(e){ return false; } });
    R("Google return stores the session token", stored);
    await page.close();
  }

  // ---- Google failure return: #autherror → human copy ----
  {
    const page = await ctx.newPage();
    await page.goto(U + '#autherror=google_denied'); await page.waitForSelector('#authScreen.on', { timeout: 15000 });
    R("Google #autherror renders as human copy, never a raw code", /Google sign-in was cancelled/i.test(await errText(page)));
    await page.close();
  }

} catch (e) {
  R("suite ran without fatal error", false, String(e && e.stack || e));
}

await browser.close();
const passed = results.filter(Boolean).length, failed = results.filter(x => !x).length;
console.log(`\nCHECKS: ${passed} passed, ${failed} failed`);
console.log("ERRORS: " + (failed ? "PRESENT" : "NONE"));
process.exit(failed ? 1 : 0);
