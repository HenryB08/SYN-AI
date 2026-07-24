/* Premium motion layer: reveals/stagger, count-up integrity, canvas lifecycle,
   parallax, hover physics, and full reduced-motion degradation. */
import pkg from '/tmp/node_modules/playwright-core/index.js';
const { chromium } = pkg;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let ok=0, fail=0; const check=(n,c)=>{ (c?ok++:fail++); if(!c) console.log('FAIL',n); };

// -- normal motion --
let ctx = await b.newContext({viewport:{width:1440,height:1000},colorScheme:'dark'});
let p = await ctx.newPage();
await p.goto('file:///home/user/SYN-AI/index.html'); await p.waitForSelector('#site.on'); await p.waitForTimeout(900);
// dark-pro: the hero is type-led (crystal/particle imagery retired); a real product preview drifts on parallax
check('hero is type-led (no legacy crystal hero)', await p.evaluate(()=>!document.getElementById('lumHero')));
check('hero reveals visible', await p.evaluate(()=>parseFloat(getComputedStyle(document.querySelector('.sh-title')).opacity)===1));
check('stagger delays assigned', await p.evaluate(()=>{
  const d=[...document.querySelectorAll('.step-card')].map(e=>parseInt(e.style.getPropertyValue('--rvd')));
  return d.length===3 && d[1]>d[0] && d[2]>d[1];
}));
// scroll to pricing -> count-up runs and lands on exact values
await p.evaluate(()=>document.getElementById('site-pricing').scrollIntoView());
let rates=[], prev='';
for(let i=0;i<14;i++){ await p.waitForTimeout(250);
  rates = await p.$$eval('.seat-tier .st-rate', e=>e.map(x=>x.textContent.replace(/\s+/g,'').trim()));
  if(rates.join()===prev) break; prev=rates.join(); }
check('count-up lands exact: '+rates.join(','), rates.join(',')==='$349/mo,$549/mo');
// hero is type-led: the particle canvas was retired with the photography, so no fx state exists
check('no hero particle canvas (type-led hero)', await p.evaluate(()=>_fxState===null && !document.getElementById('heroFx')));
// parallax applied to the hero product preview (drifts slower than the page)
await p.evaluate(()=>document.getElementById('site').scrollTo({top:500,behavior:'instant'}));
await p.waitForTimeout(300);
check('parallax transform set', await p.evaluate(()=>{ const i=document.querySelector('#sp-home .hero-preview img'); return !!i && /translateY/.test(i.style.transform); }));
// nothing dead under cursor: hover a step card raises it
await p.evaluate(()=>{ const s=document.querySelector('#sp-home .step-grid'); if(s) s.scrollIntoView(); });
await p.waitForTimeout(250);
const card = await p.$('.step-card');
await card.hover(); await p.waitForTimeout(350);
check('card hover lifts', await p.evaluate(()=>{
  const e=document.querySelector('.step-card:hover'); if(!e) return false;
  return getComputedStyle(e).transform !== 'none';
}));
await ctx.close();

// -- reduced motion --
ctx = await b.newContext({viewport:{width:1440,height:1000},colorScheme:'dark',reducedMotion:'reduce'});
p = await ctx.newPage();
await p.goto('file:///home/user/SYN-AI/index.html'); await p.waitForSelector('#site.on'); await p.waitForTimeout(500);
check('reduce: ambient grid animation off', await p.evaluate(()=>getComputedStyle(document.querySelector('#site .sa-grid')).animationName==='none'));
check('reduce: no fx state', await p.evaluate(()=>_fxState===null));
check('reduce: content visible immediately', await p.evaluate(()=>{
  const t=document.querySelector('.sh-title'); const st=getComputedStyle(t);
  return parseFloat(st.opacity)===1;
}));
await p.evaluate(()=>document.getElementById('site-pricing').scrollIntoView()); await p.waitForTimeout(200);
const r2 = await p.$$eval('.seat-tier .st-rate', e=>e.map(x=>x.textContent.replace(/\s+/g,'').trim()));
check('reduce: static rates intact', r2.join(',')==='$349/mo,$549/mo');
await ctx.close();
console.log(`CHECKS: ${ok} passed, ${fail} failed`);
console.log(fail? 'ERRORS: PRESENT' : 'ERRORS: NONE');
if(fail) process.exitCode=1;
await b.close();
