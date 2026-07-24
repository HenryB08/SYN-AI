/* AI cost control: manual actions cost nothing, per-user daily caps trip and reset,
   a capped user keeps every non-AI feature, cost meter + per-workspace overrides. */
import pkg from '/tmp/node_modules/playwright-core/index.js';
const { chromium } = pkg;
const U = 'file:///home/user/SYN-AI/index.html';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let ok = 0, fail = 0; const check = (n, c) => { (c ? ok++ : fail++); if (!c) console.log('FAIL', n); };
const ev = (p, fn, ...a) => p.evaluate(fn, ...a);

const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark' });
const p = await ctx.newPage();
await p.goto(U); await p.waitForSelector('#site.on');
await p.evaluate(() => siteAuth('create')); await p.waitForSelector('#authScreen.on');
await p.fill('#aCompany', 'HALT Fire'); await p.fill('#aName', 'Ada Lovelace'); await p.fill('#aEmail', 'a@h.test'); await p.fill('#aPass', 'pass1234');
await p.click('#authBtn'); await p.waitForSelector('#app.on');
await ev(p, () => {
  const bnd = Object.assign({ id: uid('b'), memories: [], knowledge: [] }, { name: 'HALT Fire', industry: 'Fire', accent: '#E4C169', voice: 'v', audience: 'a', palette: [], products: [], approvedClaims: [], bannedClaims: [], legal: '', imageStyle: '' });
  BRANDS.push(bnd); saveBrands(); selectBrand(bnd.id);
  TEAM.push({ id: 'u_sofia', name: 'Sofia Reyes', email: 's@h.test', role: 'Member' });
  ORG.legacy = false; ORG.pricingModel = 'per-seat'; ORG.seats = 5;
  USAGE = { period: usagePeriod(), byUser: {}, daily: {}, calls: {} };
});

// ---- instrument fetch: count only /v1/messages calls ----
await ev(p, () => { window.__api = 0; const of = window.fetch; window.fetch = (u, o) => { if (String(u).includes('/v1/messages')) window.__api++; return of(u, o); }; });

// ===== 1. manual actions produce zero API calls =====
const manual1 = await ev(p, () => {
  window.__api = 0;
  const t = Tasks.create({ title: 'Manual task', assignees: [currentUser.id], status: 'todo', visibility: 'team' });   // create
  Tasks.update(t.id, { title: 'Manual task edited', priority: 'high' });                                                // edit
  setTaskStatus(t.id, 'inprogress');                                                                                     // move
  Events.create({ title: 'Standup', startDate: todayISO(), endDate: todayISO(), allDay: true, attendees: [currentUser.id] }); // event
  const dm = startDM('u_sofia'); postHumanMessage('dm', activeSpaceId || (dm && dm.id) || 'x', 'hi there', []);          // human DM
  const sp = Spaces.create({ name: 'general', icon: '#', color: '#8E959F', type: 'team', members: 'all' });             // normal space
  postHumanMessage('space', sp.id, 'team message, no AI', []);                                                          // human space msg
  Assets.create({ brandId: BRANDS[0].id, name: 'f.pdf', ext: 'pdf', size: 1000, visibility: 'workspace', createdBy: currentUser.id, createdByName: currentUser.name }); // upload
  const fu = Tasks.create({ title: 'FU', assignees: [currentUser.id], followUpDate: todayISO(), status: 'todo', visibility: 'team' });
  fuSnooze('task', fu.id); fuComplete('task', fu.id);                                                                    // follow-up snooze/complete
  Deps.create({ requesterId: currentUser.id, requesterName: currentUser.name, oweeId: 'u_sofia', oweeName: 'Sofia', note: 'need X', status: 'open' }); // dependency
  ['myday','tasks','calendar','spaces','assets','activity','followups','deps','recap','settings','guide'].forEach(v => setView(v)); // navigation
  searchAll('manual');                                                                                                   // search
  return window.__api;
});
check('manual task/event/DM/space/asset/follow-up/dep/nav/search = 0 API calls', manual1 === 0);

// ===== 2. daily caps trip and reset =====
const capTrip = await ev(p, () => {
  USAGE = { period: usagePeriod(), byUser: {}, daily: {}, calls: {} };
  const out = {};
  for (const [kind, cap] of Object.entries(AI_DAILY_CAPS)) {
    let lastOk = true, trippedAt = -1, reason = '';
    for (let i = 0; i < cap + 2; i++) { const g = gateAI(kind); if (!g.ok && trippedAt < 0) { trippedAt = i; reason = g.reason; } lastOk = g.ok; }
    out[kind] = { cap, trippedAt, reason, lastOk };
  }
  return out;
});
check('fast cap trips exactly at 50', capTrip.fast.trippedAt === 50);
check('smart cap trips exactly at 10', capTrip.smart.trippedAt === 10);
check('image cap trips exactly at 5', capTrip.image.trippedAt === 5);
check('parse cap trips exactly at 5', capTrip.parse.trippedAt === 5);
check('cap message is polite + names midnight reset', /resets at midnight/.test(capTrip.fast.reason) && /everything else keeps working/.test(capTrip.fast.reason));

const resetTest = await ev(p, () => {
  USAGE = { period: usagePeriod(), byUser: {}, daily: {}, calls: {} };
  for (let i = 0; i < 50; i++) gateAI('fast');
  const before = gateAI('fast').ok;                        // 51st blocked
  // simulate midnight rollover: the new day has no bucket for this user
  const day = todayISO(); USAGE.daily = { '2000-01-01': USAGE.daily[day] };
  const after = gateAI('fast').ok;                         // fresh day allows again
  return { before, after };
});
check('daily cap blocks when exhausted', resetTest.before === false);
check('daily cap resets on new day', resetTest.after === true);

// ===== 3. capped user can still use everything non-AI =====
const capped = await ev(p, () => {
  // max out every daily cap for the current user
  const bkt = dailyBucket(currentUser.id);
  Object.keys(AI_DAILY_CAPS).forEach(k => bkt[k] = AI_DAILY_CAPS[k]);
  window.__api = 0;
  const aiBlocked = !gateAI('fast').ok && !gateAI('smart').ok && !gateAI('image').ok && !gateAI('parse').ok;
  // non-AI still fully works
  const t = Tasks.create({ title: 'still works', assignees: [currentUser.id], status: 'todo', visibility: 'team' });
  const e = Events.create({ title: 'ev', startDate: todayISO(), endDate: todayISO(), allDay: true, attendees: [currentUser.id] });
  const sp = Spaces.create({ name: 'chan', icon: '#', color: '#8E959F', type: 'team', members: 'all' });
  const m = postHumanMessage('space', sp.id, 'human msg while capped', []);
  const d = Deps.create({ requesterId: currentUser.id, requesterName: currentUser.name, oweeId: 'u_sofia', oweeName: 'S', note: 'x', status: 'open' });
  const a = Assets.create({ brandId: BRANDS[0].id, name: 'c.pdf', ext: 'pdf', size: 10, visibility: 'private', createdBy: currentUser.id, createdByName: currentUser.name });
  return { aiBlocked, madeAll: !!(t && e && sp && m && d && a), api: window.__api };
});
check('capped user: all AI features blocked', capped.aiBlocked === true);
check('capped user: every non-AI action still succeeds', capped.madeAll === true);
check('capped user: non-AI actions still cost 0 API calls', capped.api === 0);

// ===== 4. cost meter reflects tracked usage =====
const meter = await ev(p, () => {
  USAGE = { period: usagePeriod(), byUser: {}, daily: {}, calls: {} };
  recordCost('fast_msg'); recordCost('fast_msg'); recordCost('smart_msg'); recordCost('research'); recordCost('recap');
  const expected = 2 * AI_COST_EST.fast_msg + AI_COST_EST.smart_msg + AI_COST_EST.research + AI_COST_EST.recap;
  return { spend: estMonthSpend(), expected, billing: renderBilling() };
});
check('estMonthSpend = counts x per-type estimate', Math.abs(meter.spend - meter.expected) < 1e-9);
check('billing shows estimated AI spend', /Estimated AI spend/.test(meter.billing) && new RegExp('\\$' + meter.expected.toFixed(2).replace('.', '\\.')).test(meter.billing));
check('billing flags recap as batch-eligible', /batch-eligible/.test(meter.billing));
check('billing shows per-member today table', /Per-member usage · today/.test(meter.billing));

// ===== 5. per-workspace override (AI credits scaffolding) =====
const override = await ev(p, () => {
  const base = dailyCap('fast');
  ORG.aiCaps = { fast: 200 };
  const raised = dailyCap('fast');
  USAGE = { period: usagePeriod(), byUser: {}, daily: {}, calls: {} };
  let okAt60 = true; for (let i = 0; i < 60; i++) { if (!gateAI('fast').ok) okAt60 = false; }
  delete ORG.aiCaps;
  return { base, raised, okAt60 };
});
check('override raises the per-workspace cap', override.base === 50 && override.raised === 200);
check('with raised cap, 60 fast calls all allowed', override.okAt60 === true);

// ===== 6. monthly soft-throttle downgrade still works under the daily cap =====
const downgrade = await ev(p, () => {
  USAGE = { period: usagePeriod(), byUser: {}, daily: {}, calls: {} };
  ORG.legacy = false; ORG.seats = 1;
  USAGE.byUser[currentUser.id] = { standard: 0, smart: 100000, image: 0, parse: 0 };   // blow the monthly smart pool
  const g = gateAI('smart', 'smart_msg');
  return { downgrade: !!g.downgrade, ok: g.ok };
});
check('monthly smart exhaustion still soft-downgrades (not a hard cap)', downgrade.ok === true && downgrade.downgrade === true);

await ctx.close();
console.log(`CHECKS: ${ok} passed, ${fail} failed`);
console.log(fail ? 'ERRORS: PRESENT' : 'ERRORS: NONE');
if (fail) process.exitCode = 1;
await b.close();
