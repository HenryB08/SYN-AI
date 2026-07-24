/*
 * Tests for the per-seat pricing model (syn-pricing-model):
 *  - seat limit blocking on invite/join
 *  - seat freed on member removal
 *  - volume rate applied to the whole workspace at the 10 and 25 thresholds
 *  - AI allowance warning at 80% and soft throttle at 100% (smart->standard, image paused)
 *  - admin-only visibility of the Billing section + usage banner
 *  - public marketing pricing sells the Growth System (Growth Core/Pro + install, guarantee headline);
 *    the per-seat calculator is removed from the public site (seat math remains for in-app Billing only)
 *  - legacy grandfathering (no seat lock, no throttle)
 *
 * Run: PW=... CHROME=... node tests/pricing-model.mjs
 */
import { fileURLToPath } from 'url';
import path from 'path';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PW = process.env.PW || '/tmp/node_modules/playwright-core/index.js';
const CHROME = process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const U = process.env.APP || ('file://' + path.resolve(HERE, '..', 'index.html'));
const { chromium } = (await import(PW)).default;

const browser = await chromium.launch({ executablePath: CHROME });
const errors=[]; let ok=0,fail=0; const check=(n,c)=>{ if(c)ok++; else {fail++; console.log('  ✗ FAIL:',n);} };

async function newPage(){
  const ctx = await browser.newContext({viewport:{width:1440,height:940},colorScheme:'dark'});
  const p = await ctx.newPage();
  p.on('console',m=>{if(m.type()==='error'){const t=m.text(); if(!/Failed to load resource|net::|ERR_|favicon/.test(t)) errors.push(t);}});
  p.on('pageerror',e=>errors.push('PAGEERROR: '+e.message));
  return {ctx,p};
}
async function signup(p, company){
  await p.goto(U); await p.waitForSelector('#site.on');
  await p.evaluate(() => siteAuth('create')); await p.waitForSelector('#authScreen.on');
  await p.fill('#aCompany',company||'HALT Fire'); await p.fill('#aName','Ada Lovelace'); await p.fill('#aEmail','a@h.test'); await p.fill('#aPass','pass1234');
  await p.click('#authBtn'); await p.waitForSelector('#app.on');
}
const ev=(p,f,...a)=>p.evaluate(f,...a);

async function run(){
  // ===== pure pricing math: volume applies to the WHOLE workspace at thresholds =====
  { const {ctx,p} = await newPage(); await signup(p);
    const m = await ev(p,()=>({ r1:seatRate(1),r9:seatRate(9),r10:seatRate(10),r24:seatRate(24),r25:seatRate(25),r40:seatRate(40),
      p9:priceFor(9,1).total,p10:priceFor(10,1).total,p24:priceFor(24,1).total,p25:priceFor(25,1).total,
      p10b3:priceFor(10,3).total,p8:priceFor(8,1).total }));
    check('rate: 1-9 seats = $39', m.r1===39 && m.r9===39);
    check('rate: 10-24 seats = $35 (volume at 10)', m.r10===35 && m.r24===35);
    check('rate: 25+ seats = $29 (volume at 25)', m.r25===29 && m.r40===29);
    check('10 seats billed at $35 for ALL seats (350, not mixed)', m.p10===350);
    check('9 seats stay at $39 (351)', m.p9===9*39);
    check('25 seats billed at $29 for ALL seats (725)', m.p25===725);
    check('extra brands add $199 each (10 seats, 3 brands = 748)', m.p10b3===350+2*199);
    await ctx.close();
  }

  // ===== public marketing pricing now sells the Growth System (per-seat calculator removed) =====
  // The site leads with the Growth System (Growth Core $349 + $497 install, Growth Pro $549 + $497),
  // with the first-month value guarantee as the headline. The old per-seat calculator is gone from the
  // public site; the seat math above still backs the in-app admin Billing meter (not public-facing).
  { const {ctx,p} = await newPage(); await p.goto(U); await p.waitForSelector('#site.on');
    const dom = await p.evaluate(()=>{
      const rates = [...document.querySelectorAll('#site-pricing .seat-tier.plan .st-rate')].map(e=>e.textContent.replace(/\s+/g,''));
      const names = [...document.querySelectorAll('#site-pricing .plan-name')].map(e=>e.textContent.trim());
      const installs = [...document.querySelectorAll('#site-pricing .plan-install')].map(e=>e.textContent);
      return { rates, names, installs,
        hasCalc: !!document.getElementById('pricingCalc'),
        gtee: (document.querySelector('#site-pricing .gtee-copy')||{}).textContent||'',
        body: document.getElementById('site-pricing').textContent };
    });
    check('growth plans priced $349 + $549', dom.rates.join(',')==='$349/mo,$549/mo');
    check('growth plan names present', dom.names.join(',')==='Growth Core,Growth Pro');
    check('both plans show the $497 install', dom.installs.every(t=>/\$497/.test(t)) && dom.installs.length===2);
    check('guarantee stated plainly (no captured value, free month)', /no captured value, free month/i.test(dom.gtee));
    check('per-seat calculator removed from public site', dom.hasCalc===false);
    check('no per-seat pricing in public pricing copy', !/\/seat\/mo|per seat/i.test(dom.body));
    await ctx.close();
  }

  // ===== seat freed on member removal =====
  { const {ctx,p} = await newPage(); await signup(p);
    const r = await ev(p,()=>{ ORG.seats=2; TEAM.push({id:'u_x',name:'Ex Member',email:'x@h.test',role:'Member'});
      const beforeUsed=seatsUsed(), beforeFull=seatLimitReached();
      TEAM=TEAM.filter(t=>t.id!=='u_x'); if(typeof saveTeam==='function') saveTeam();
      return { beforeUsed, beforeFull, afterUsed:seatsUsed(), afterFull:seatLimitReached() }; });
    check('seat is used up to the limit (2 of 2, full)', r.beforeUsed===2 && r.beforeFull===true);
    check('removing a member frees a seat (1 of 2, not full)', r.afterUsed===1 && r.afterFull===false);
    await ctx.close();
  }

  // ===== seat limit blocking on join (real UI end-to-end, shared-context second page) =====
  { const {ctx,p} = await newPage(); await signup(p, 'Seat Co');
    // shrink to 1 seat (admin is the only member), grab the live join code, persist to storage
    const code = await ev(p,()=>{ while(orgSeats()>1) billAdjustSeats(-1); return orgCode(ORG); });
    await ev(p,async()=>{ await persistOrg(); });
    // a would-be teammate joins from a fresh page in the SAME context (shared localStorage),
    // but logged out — strip the admin session before boot so it lands on the marketing site.
    await ctx.addInitScript(()=>{ try{ localStorage.removeItem('syn5:session'); }catch(e){} });
    const q = await ctx.newPage();
    await q.goto(U); await q.waitForSelector('#site.on',{timeout:15000});
    await q.evaluate(() => siteAuth('create')); await q.waitForSelector('#authScreen.on');
    await q.evaluate(()=>showAuth('join')); await q.waitForTimeout(80);
    await q.fill('#aName','Bea New'); await q.fill('#aEmail','bea@h.test'); await q.fill('#aPass','pass1234'); await q.fill('#aCode',code);
    await q.click('#authBtn'); await q.waitForTimeout(250);
    const err = await q.evaluate(()=>{ const e=document.getElementById('authErr'); return { shown:getComputedStyle(e).display!=='none', text:e.textContent }; });
    check('join beyond seat limit is blocked', err.shown && /seat limit/i.test(err.text));
    check('block message shows current usage ("1 of 1 seats used")', /1 of 1 seats used/.test(err.text));
    check('blocked join did NOT enter the app', !(await q.evaluate(()=>document.getElementById('app').classList.contains('on'))));
    await ctx.close();
  }

  // ===== AI allowance: 80% warning + 100% soft throttle =====
  { const {ctx,p} = await newPage(); await signup(p);
    // 1 seat -> allowances = per-seat (standard 500, smart 100, image 20, parse 20)
    await ev(p,()=>{ ORG.seats=1; ORG.legacy=false; USAGE={period:usagePeriod(),byUser:{}}; });
    const at = await ev(p,()=>{ USAGE.byUser[currentUser.id]={standard:0,smart:80,image:0,parse:0};
      return { smartRatio:usageRatio('smart'), warn:anyPoolWarn(), exhausted:poolExhausted('smart') }; });
    check('80% of a pool triggers the admin warning', Math.abs(at.smartRatio-0.8)<0.001 && at.warn===true && at.exhausted===false);
    check('usage banner warns admin at 80%', /80%\+/.test(await ev(p,()=>usageBannerHtml())));
    // push smart to 100% -> soft throttle downgrades to standard, never fails
    const thr = await ev(p,()=>{ USAGE.byUser[currentUser.id].smart=100;
      const g=gateAI('smart'); return { ok:g.ok, downgrade:g.downgrade, hasReason:!!g.reason, exhausted:poolExhausted('smart') }; });
    check('smart pool at 100% is exhausted', thr.exhausted===true);
    check('smart at 100% soft-throttles (still ok, downgraded to standard, reason given)', thr.ok===true && thr.downgrade===true && thr.hasReason);
    // image at 100% -> paused (blocked with reason, never silent)
    const img = await ev(p,()=>{ USAGE.byUser[currentUser.id].image=20; const g=gateAI('image'); return { ok:g.ok, hasReason:!!g.reason }; });
    check('image pool at 100% pauses generation with a clear reason (never silent)', img.ok===false && img.hasReason);
    check('usage banner shows throttle notice at 100%', /soft throttle/i.test(await ev(p,()=>usageBannerHtml())));
    await ctx.close();
  }

  // ===== admin-only visibility of billing =====
  { const {ctx,p} = await newPage(); await signup(p);
    await p.click('.nav-btn[data-view="settings"]'); await p.waitForSelector('#view-settings.active'); await p.waitForTimeout(120);
    check('admin sees the Billing section', await p.evaluate(()=>[...document.querySelectorAll('#settingsPanel .sb-head')].some(h=>/Billing/.test(h.textContent))));
    check('admin renderBilling returns content', (await ev(p,()=>renderBilling())).length>50);
    const member = await ev(p,()=>{ const real=currentUser; currentUser={id:'u_m',role:'Member',name:'Mem'}; const b=renderBilling(); const banner=usageBannerHtml(); renderSettings(); const hasBillingDom=[...document.querySelectorAll('#settingsPanel .sb-head')].some(h=>/Billing/.test(h.textContent)); currentUser=real; renderSettings(); return { billing:b, banner, hasBillingDom }; });
    check('member renderBilling returns nothing', member.billing==='');
    check('member has no billing in Settings DOM', member.hasBillingDom===false);
    check('member sees no usage banner', member.banner==='');
    await ctx.close();
  }

  // ===== legacy grandfathering: no seat lock, no throttle =====
  { const {ctx,p} = await newPage(); await signup(p);
    const r = await ev(p,()=>{ // simulate a pre-pricing workspace
      delete ORG.pricingModel; delete ORG.legacy; delete ORG.seats;
      const became = markLegacyIfNeeded(ORG);
      // fill past any seat count
      TEAM.push({id:'u_a',name:'A'},{id:'u_b',name:'B'},{id:'u_c',name:'C'},{id:'u_d',name:'D'},{id:'u_e',name:'E'},{id:'u_f',name:'F'});
      USAGE={period:usagePeriod(),byUser:{}}; USAGE.byUser[currentUser.id]={standard:0,smart:9999,image:9999,parse:0};
      const g=gateAI('smart'), gi=gateAI('image');
      return { became, legacy:isLegacyOrg(), seatLock:seatLimitReached(), smartOk:g.ok, smartThrottled:!!g.downgrade, imageOk:gi.ok }; });
    check('pre-pricing workspace is flagged legacy', r.became===true && r.legacy===true);
    check('legacy workspace has NO seat lock even when over count', r.seatLock===false);
    check('legacy workspace is never throttled (smart)', r.smartOk===true && r.smartThrottled===false);
    check('legacy workspace is never throttled (image)', r.imageOk===true);
    await ctx.close();
  }

  // ===== new workspaces are per-seat, not legacy =====
  { const {ctx,p} = await newPage(); await signup(p);
    check('new workspace defaults to per-seat model (not legacy)', await ev(p,()=>ORG.pricingModel==='per-seat' && ORG.legacy===false && typeof ORG.seats==='number'));
    await ctx.close();
  }
}
try{ await run(); }catch(e){ errors.push('FLOW: '+e.message+'\n'+(e.stack||'')); }
await browser.close();
console.log(`\nCHECKS: ${ok} passed, ${fail} failed`);
console.log('ERRORS:', errors.length?errors:'NONE');
process.exit(errors.length||fail?1:0);
