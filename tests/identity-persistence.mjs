/*
 * Identity + cloud persistence regression (syn-pilot-ready, Part 1).
 *
 * Root cause fixed: sGet silently fell through to (empty) localStorage when a cloud read failed,
 * so a transient failure made an existing cloud user look brand-new ("No match…") and re-onboard
 * into a fresh workspace. persistOrg could also overwrite the registry with an empty list.
 *
 * These tests run against a MOCK SYN Core (an in-page KV backed by localStorage under mc:*, so it
 * survives reloads and survives wiping the app's own syn5:* keys to simulate a fresh device).
 *
 * Covers: cold boot into an existing cloud org (both members, all data), wrong-password rejection,
 * transient read failure (must retry, never fabricate), full cloud outage at boot (block + retry +
 * recovery), and persistOrg never clobbering the registry.
 *
 * Run: PW=... CHROME=... node tests/identity-persistence.mjs
 */
import { fileURLToPath } from 'url';
import path from 'path';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PW = process.env.PW || '/tmp/node_modules/playwright-core/index.js';
const CHROME = process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const U = process.env.APP || ('file://' + path.resolve(HERE, '..', 'index.html'));
const { chromium } = (await import(PW)).default;

const MOCK = () => {
  const BASE = "https://syn-core.henrybello.workers.dev";
  const orig = window.fetch.bind(window);
  window.fetch = async (url, opts) => {
    url = (typeof url === "string") ? url : (url && url.url) || "";
    if (url.startsWith(BASE)){
      const down = localStorage.getItem("mc:__down") === "1";
      const fail = localStorage.getItem("mc:__fail") === "1";
      const path = url.slice(BASE.length);
      if (path === "/" || path === ""){
        if (down) throw new TypeError("Failed to fetch");
        return new Response(JSON.stringify({ ok:true }), { status:200, headers:{ "content-type":"application/json" } });
      }
      if (path.startsWith("/kv/")){
        if (fail) throw new TypeError("Failed to fetch");
        const key = decodeURIComponent(path.slice(4));
        if ((opts && opts.method) === "PUT"){ const body = JSON.parse(opts.body || "{}"); localStorage.setItem("mc:" + key, body.value); return new Response(JSON.stringify({ ok:true }), { status:200 }); }
        const v = localStorage.getItem("mc:" + key);
        return new Response(JSON.stringify({ value: v }), { status:200, headers:{ "content-type":"application/json" } });
      }
    }
    return orig(url, opts);
  };
};

const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext({ viewport:{width:1440,height:940}, colorScheme:'dark' });
await ctx.addInitScript(MOCK);
await ctx.addInitScript(() => { window.__GATE_BYPASS__ = true; });   // client-only: exercise app logic without the single-admin gate UI (Worker still enforces the token)
const p = await ctx.newPage();
let ok=0, fail=0; const check=(n,c)=>{ if(c)ok++; else {fail++; console.log('  ✗ FAIL:',n);} };
const errors=[]; p.on('pageerror',e=>errors.push('PAGEERROR: '+e.message));
const ev=(f,...a)=>p.evaluate(f,...a);
const freshDevice = async ()=>{ await ev(()=>{ Object.keys(localStorage).filter(k=>k.startsWith('syn5:')).forEach(k=>localStorage.removeItem(k)); }); };

async function run(){
  // ---- Seed: Henry creates "Syntrex LLC" in the cloud, adds Dana + brand + task + chat ----
  await p.goto(U); await p.waitForSelector('#site.on',{timeout:12000});
  check('boots in Synced (cloud) mode with the mock core', (await ev(()=>document.getElementById('storagePill').textContent))==='Synced');
  await p.evaluate(() => siteAuth('create')); await p.waitForSelector('#authScreen.on');
  await ev(()=>showAuth('create'));
  await p.fill('#aCompany','Syntrex LLC'); await p.fill('#aName','Henry Bello'); await p.fill('#aEmail','henry@syntrexio.com'); await p.fill('#aPass','pilot123');
  await p.click('#authBtn'); await p.waitForSelector('#app.on',{timeout:12000});
  const orgId = await ev(()=>ORG.id);
  await ev(async ()=>{
    const team=(await sGet("syn5:"+ORG.id+":team"))||[];
    team.push({ id:"u_dana", name:"Dana Reyes", email:"dana@syntrexio.com", pwHash: await hashPw("member123","dana@syntrexio.com"), role:"Member", createdAt:new Date().toISOString() });
    await sSet("syn5:"+ORG.id+":team", team); TEAM=team;
    const b=Object.assign({id:uid('b'),memories:[],knowledge:[]},{name:'Syntrex',industry:'SaaS',accent:'#E4C169',voice:'v',audience:'a',palette:[{name:'P',hex:'#E4C169'}],products:['p'],approvedClaims:[],bannedClaims:[],legal:'n',imageStyle:'c'});
    BRANDS.push(b); saveBrands(); selectBrand(b.id);
    Tasks.create({title:'PILOT-EXISTING-TASK',status:'todo',visibility:'team'});
    newChat(); const t=thread(); t.name='PILOT-CHAT'; t.msgs.push({role:'user',text:'existing message',by:currentUser.name,at:new Date().toISOString()}); saveChats(activeBrandId);
    flushPendingWrites();
  });
  await p.waitForTimeout(1200);

  // ---- A. Cold boot: Henry signs in on a fresh device -> EXISTING org + all data ----
  await freshDevice(); await p.reload(); await p.waitForSelector('#site.on',{timeout:12000});
  await p.evaluate(() => siteAuth('create')); await p.waitForSelector('#authScreen.on'); await ev(()=>showAuth('signin'));
  await p.fill('#aEmail','henry@syntrexio.com'); await p.fill('#aPass','pilot123'); await p.click('#authBtn'); await p.waitForSelector('#app.on',{timeout:12000});
  check('Henry cold-boots into his EXISTING org (not a new one)', (await ev(()=>ORG.id))===orgId);
  const hData = await ev(async()=>{ await loadWorkspaceData(); const b=BRANDS[0]; if(b) await loadChats(b.id); return { team:TEAM.length, task:Tasks.list(t=>t.title==='PILOT-EXISTING-TASK').length, chat:(b?(CHATS[b.id]||[]):[]).some(c=>c.name==='PILOT-CHAT'), brand:BRANDS.length }; });
  check('all prior data loads (team=2, task, chat, brand)', hData.team===2 && hData.task>=1 && hData.chat && hData.brand>=1);

  // ---- B. The second member (Dana) lands in the SAME org ----
  await freshDevice(); await p.reload(); await p.waitForSelector('#site.on',{timeout:12000});
  await p.evaluate(() => siteAuth('create')); await p.waitForSelector('#authScreen.on'); await ev(()=>showAuth('signin'));
  await p.fill('#aEmail','dana@syntrexio.com'); await p.fill('#aPass','member123'); await p.click('#authBtn'); await p.waitForSelector('#app.on',{timeout:12000});
  check('Dana lands in the SAME org as Henry', (await ev(()=>ORG.id))===orgId);
  check('Dana sees the shared brand + team task', await ev(async()=>{ await loadWorkspaceData(); const b=BRANDS[0]; return BRANDS.length>=1 && Tasks.list(t=>t.title==='PILOT-EXISTING-TASK').length>=1; }));

  // ---- C. Wrong password is genuinely rejected (No match), not a server error ----
  await freshDevice(); await p.reload(); await p.waitForSelector('#site.on',{timeout:12000});
  await p.evaluate(() => siteAuth('create')); await p.waitForSelector('#authScreen.on'); await ev(()=>showAuth('signin'));
  await p.fill('#aEmail','henry@syntrexio.com'); await p.fill('#aPass','WRONGPASS'); await p.click('#authBtn'); await p.waitForTimeout(800);
  const wrong = await ev(()=>({ inApp:document.getElementById('app').classList.contains('on'), err:document.getElementById('authErr').textContent }));
  check('wrong password is rejected with "No match"', !wrong.inApp && /No match/.test(wrong.err));

  // ---- D. Transient cloud read failure: retry message, NEVER a false "No match" / new org ----
  await freshDevice(); await p.reload(); await p.waitForSelector('#site.on',{timeout:12000});
  await ev(()=>localStorage.setItem('mc:__fail','1'));
  await p.evaluate(() => siteAuth('create')); await p.waitForSelector('#authScreen.on'); await ev(()=>showAuth('signin'));
  await p.fill('#aEmail','henry@syntrexio.com'); await p.fill('#aPass','pilot123'); await p.click('#authBtn'); await p.waitForTimeout(1200);
  const trans = await ev(()=>({ inApp:document.getElementById('app').classList.contains('on'), orgId:(typeof ORG!=='undefined'&&ORG)?ORG.id:null, err:document.getElementById('authErr').textContent }));
  check('transient failure does NOT sign into any app/org', !trans.inApp);
  check('transient failure does NOT falsely report "No match"', !/No match/.test(trans.err));
  check('transient failure surfaces a reach/retry message', /reach|connection|try again/i.test(trans.err));
  // registry in the cloud is intact (never fabricated/wiped)
  check('cloud registry still holds the org after a failed read', await ev((oid)=>{ const raw=localStorage.getItem('mc:syn5:orgs'); const arr=raw?JSON.parse(raw):[]; return Array.isArray(arr)&&arr.some(o=>o.id===oid); }, orgId));
  // recover: clear the failure and retry -> now signs in to the existing org
  await ev(()=>localStorage.removeItem('mc:__fail'));
  await p.click('#authBtn'); await p.waitForSelector('#app.on',{timeout:12000});
  check('after recovery the retry signs into the EXISTING org', (await ev(()=>ORG.id))===orgId);

  // ---- E. Full cloud outage at boot (device has synced before): block + retry, not marketing ----
  // Henry is signed in now (session present). Take the cloud fully down and reload.
  await ev(()=>localStorage.setItem('mc:__down','1'));
  await p.reload(); await p.waitForTimeout(1500);
  const outage = await ev(()=>({ boot:document.getElementById('bootScreen').classList.contains('on'), retry:!!document.getElementById('bootRetry'), inApp:document.getElementById('app').classList.contains('on'), site:document.getElementById('site').classList.contains('on') }));
  check('cloud outage at boot shows the block+retry screen', outage.boot && outage.retry);
  check('cloud outage at boot does NOT enter the app or the marketing site', !outage.inApp && !outage.site);
  // recover + click Retry -> back into the existing org
  await ev(()=>localStorage.removeItem('mc:__down'));
  await p.click('#bootRetry'); await p.waitForSelector('#app.on',{timeout:12000});
  check('Retry after recovery restores the existing org', (await ev(()=>ORG.id))===orgId);

  // ---- F. persistOrg never overwrites the registry from a failed read ----
  const beforeReg = await ev(()=>localStorage.getItem('mc:syn5:orgs'));
  await ev(async()=>{ localStorage.setItem('mc:__fail','1'); try{ await persistOrg(); }catch(e){} localStorage.removeItem('mc:__fail'); });
  const afterReg = await ev(()=>localStorage.getItem('mc:syn5:orgs'));
  check('persistOrg aborts (does not clobber the registry) when the cloud read fails', beforeReg===afterReg);
}
try{ await run(); }catch(e){ errors.push('FLOW: '+e.message+'\n'+(e.stack||'')); }
await browser.close();
console.log(`\nCHECKS: ${ok} passed, ${fail} failed`);
console.log('ERRORS:', errors.length?errors:'NONE');
process.exit(errors.length||fail?1:0);
