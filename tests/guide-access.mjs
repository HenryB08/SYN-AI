/* Guide: signed-out inaccessibility (incl. forced setView/hash), signed-in rendering,
   search, deep links, checklist linkage, admin gating. */
import pkg from '/tmp/node_modules/playwright-core/index.js';
const { chromium } = pkg;
const U = 'file:///home/user/SYN-AI/index.html';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let ok = 0, fail = 0; const check = (n, c) => { (c ? ok++ : fail++); if (!c) console.log('FAIL', n); };
const visible = el => el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);

// ===== signed out =====
let ctx = await b.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark' });
let p = await ctx.newPage();
await p.goto(U); await p.waitForSelector('#site.on');
check('signed out: app shell hidden', await p.evaluate(() => !document.getElementById('app').classList.contains('on') && document.getElementById('app').offsetParent === null));
check('signed out: guide panel not visible', await p.evaluate(() => {
  const g = document.getElementById('view-guide');
  return !g || !(g.offsetWidth || g.offsetHeight || g.getClientRects().length);
}));
check('signed out: no guide text on screen', await p.evaluate(() => !(document.body.innerText || '').includes('How to use SYN')));
// forced attempts
await p.evaluate(() => { try { setView('guide'); } catch (e) {} });
await p.waitForTimeout(200);
check('signed out: forced setView(guide) exposes nothing', await p.evaluate(() => {
  const g = document.getElementById('view-guide');
  return !(g.offsetWidth || g.offsetHeight || g.getClientRects().length) && !document.getElementById('app').classList.contains('on');
}));
await p.evaluate(() => { location.hash = '#/guide'; });
await p.waitForTimeout(300);
check('signed out: #/guide hash stays on public site', await p.evaluate(() => {
  const g = document.getElementById('view-guide');
  return document.getElementById('site').classList.contains('on') && !(g.offsetWidth || g.offsetHeight);
}));
check('signed out: marketing page has no Guide nav', await p.evaluate(() => !document.querySelector('#site [data-view="guide"]')));
await ctx.close();

// ===== signed in (admin) =====
ctx = await b.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark' });
p = await ctx.newPage();
await p.goto(U); await p.waitForSelector('#site.on');
await p.click('.site-nav-cta .site-btn.gold'); await p.waitForSelector('#authScreen.on');
await p.fill('#aCompany', 'HALT Fire'); await p.fill('#aName', 'Ada Lovelace'); await p.fill('#aEmail', 'a@h.test'); await p.fill('#aPass', 'pass1234');
await p.click('#authBtn'); await p.waitForSelector('#app.on');
await p.evaluate(() => {
  const bnd = Object.assign({ id: uid('b'), memories: [], knowledge: [] }, { name: 'HALT Fire', industry: 'Fire', accent: '#E4C169', voice: 'v', audience: 'a', palette: [], products: [], approvedClaims: [], bannedClaims: [], legal: '', imageStyle: '' });
  BRANDS.push(bnd); saveBrands(); selectBrand(bnd.id);
  Tasks.create({ title: 'T1', assignees: [currentUser.id], status: 'todo', visibility: 'team' });
});
check('nav shows Guide', await p.evaluate(() => !!document.querySelector('.nav-btn[data-view="guide"]')));
await p.click('.nav-btn[data-view="guide"]'); await p.waitForTimeout(300);
check('guide renders 12 sections', await p.evaluate(() => document.querySelectorAll('.gd-sec').length === 12));
check('guide heading present', await p.evaluate(() => (document.getElementById('guidePanel').innerText).includes('How to use SYN')));
check('annotated shots present', await p.evaluate(() => document.querySelectorAll('.gd-shot img').length === 12 && document.querySelectorAll('.gd-dot').length >= 30));
check('admin sees Rollup try-it', await p.evaluate(() => !!document.querySelector('.gd-try[data-v="rollup"]')));
// checklist reflects state (brand yes, task yes, teammate no)
check('checklist live state', await p.evaluate(() => {
  const rows = [...document.querySelectorAll('.gd-check-row')];
  const g = t => rows.find(r => r.innerText.includes(t));
  return g('Encode your brand').classList.contains('done') && g('Create your first task').classList.contains('done') && !g('Invite a teammate').classList.contains('done');
}));
// checklist "How →" jumps to guide section
await p.click('.gd-check-row a[data-sec="assets"]'); await p.waitForTimeout(400);
check('checklist link scrolls to section', await p.evaluate(() => {
  const el = document.getElementById('gd-assets'); const r = el.getBoundingClientRect();
  return r.top >= -40 && r.top < 400;
}));
// search
await p.fill('#gdSearch', 'permissions'); await p.waitForTimeout(150);
check('search filters', await p.evaluate(() => {
  const n = document.querySelectorAll('.gd-sec').length;
  return n >= 1 && n < 12 && !!document.getElementById('gd-assets');
}));
await p.fill('#gdSearch', 'zzzznothing'); await p.waitForTimeout(150);
check('search empty state', await p.evaluate(() => document.querySelectorAll('.gd-sec').length === 0 && document.getElementById('gdSecs').innerText.includes('Nothing matches')));
await p.fill('#gdSearch', ''); await p.waitForTimeout(150);
// try-it deep link
await p.click('.gd-try[data-v="tasks"]'); await p.waitForTimeout(300);
check('try-it opens Tasks', await p.evaluate(() => document.getElementById('view-tasks').classList.contains('active')));
// onboarding surface links to guide
await p.evaluate(() => { BRANDS.length = 0; saveBrands(); setView('chat'); renderThread(); });
await p.waitForTimeout(300);
check('chat onboarding links to guide', await p.evaluate(() => !!document.querySelector('#onboardState [data-wact="guideGo"]')));
await p.click('#onboardState [data-wact="guideGo"]'); await p.waitForTimeout(400);
check('onboarding link lands on guide', await p.evaluate(() => document.getElementById('view-guide').classList.contains('active')));
await ctx.close();

// ===== signed in (member, non-admin) =====
ctx = await b.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark' });
p = await ctx.newPage();
await p.goto(U); await p.waitForSelector('#site.on');
await p.click('.site-nav-cta .site-btn.gold'); await p.waitForSelector('#authScreen.on');
await p.fill('#aCompany', 'HALT Fire'); await p.fill('#aName', 'Sofia Reyes'); await p.fill('#aEmail', 's@h.test'); await p.fill('#aPass', 'pass1234');
await p.click('#authBtn'); await p.waitForSelector('#app.on');
await p.evaluate(() => { currentUser.role = 'Member'; setView('guide'); });
await p.waitForTimeout(300);
check('member: guide renders', await p.evaluate(() => document.querySelectorAll('.gd-sec').length === 12));
check('member: no Rollup try-it', await p.evaluate(() => !document.querySelector('.gd-try[data-v="rollup"]')));
check('member: Recap try-it still there', await p.evaluate(() => !!document.querySelector('.gd-try[data-v="recap"]')));
await ctx.close();

console.log(`CHECKS: ${ok} passed, ${fail} failed`);
console.log(fail ? 'ERRORS: PRESENT' : 'ERRORS: NONE');
if (fail) process.exitCode = 1;
await b.close();
