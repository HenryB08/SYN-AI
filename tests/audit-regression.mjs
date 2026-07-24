/*
 * Regression suite for the syn-audit findings.
 *
 * Defect #1 (P0, data loss): debounced writes (collSave 500ms, saveSoon 600ms) were
 * lost if the tab was reloaded or closed inside the debounce window, because there was
 * no flush-on-unload. Fixed by flushPendingWrites() bound to visibilitychange:hidden and
 * pagehide. These tests reload the page immediately after a write and assert survival.
 *
 * Run:
 *   PW=/path/to/playwright-core CHROME=/path/to/chrome node tests/audit-regression.mjs
 * Defaults match the Claude Code web environment:
 *   PW=/tmp/node_modules/playwright-core/index.js
 *   CHROME=/opt/pw-browsers/chromium-1194/chrome-linux/chrome
 *   APP=file://<repo>/index.html
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

async function newPage(theme='dark',width=1440){
  const ctx = await browser.newContext({viewport:{width,height:940},colorScheme:theme});
  const p = await ctx.newPage();
  p.on('console',m=>{if(m.type()==='error'){const t=m.text(); if(!/Failed to load resource|net::|ERR_|favicon/.test(t)) errors.push(t);}});
  p.on('pageerror',e=>errors.push('PAGEERROR: '+e.message));
  return {ctx,p};
}
async function signup(p){
  await p.goto(U); await p.waitForSelector('#site.on');
  await p.evaluate(() => siteAuth('create')); await p.waitForSelector('#authScreen.on');
  await p.fill('#aCompany','HALT Fire'); await p.fill('#aName','Ada Lovelace'); await p.fill('#aEmail','a@h.test'); await p.fill('#aPass','pass1234');
  await p.click('#authBtn'); await p.waitForSelector('#app.on');
  await p.evaluate(()=>{ const b=Object.assign({id:uid('b'),memories:[],knowledge:[]},{name:'HALT Fire',industry:'Fire',accent:'#E4C169',voice:'v',audience:'a',palette:[{name:'P',hex:'#E4C169'}],products:['p'],approvedClaims:[],bannedClaims:[],legal:'n',imageStyle:'c'}); BRANDS.push(b); saveBrands(); selectBrand(b.id); });
}

async function run(){
  // ===== defect #1: no data loss on immediate reload (both debounce paths) =====
  {
    const {ctx,p} = await newPage();
    await signup(p);
    await p.click('.nav-btn[data-view="chat"]'); await p.waitForSelector('#view-chat.active'); await p.waitForTimeout(300);
    const bid = await p.evaluate(()=>activeBrandId);
    await p.evaluate(()=>{
      newChat(); const t=thread(); t.name='REG-CHAT'; t.msgs.push({role:'user',text:'reg-msg',by:currentUser.name,at:new Date().toISOString()}); saveChats(activeBrandId); // saveSoon
      Tasks.create({title:'REG-TASK',status:'todo',visibility:'team'});                 // collSave
      Events.create({title:'REG-EVENT',startDate:todayISO(),endDate:todayISO()});       // collSave
      Assets.create({brandId:brand().id,name:'reg-asset.txt',ext:'txt',content:'x',visibility:'private'}); // collSave
      INTS.zapier={url:'https://x',connectedAt:new Date().toISOString(),on:{}}; saveIntegrations(); // saveSoon
    });
    await p.reload();                                       // reload INSIDE the debounce window
    await p.waitForSelector('#app.on',{timeout:8000});
    await p.evaluate(async(bid)=>{ await loadChats(bid); if(typeof loadWorkspaceData==='function') await loadWorkspaceData(); }, bid);
    await p.waitForTimeout(300);
    const r = await p.evaluate((bid)=>({
      chat:(CHATS[bid]||[]).some(c=>c.name==='REG-CHAT'&&c.msgs.some(m=>m.text==='reg-msg')),
      task:Tasks.list(t=>t.title==='REG-TASK').length>=1,
      event:Events.list(e=>e.title==='REG-EVENT').length>=1,
      asset:Assets.list(a=>a.name==='reg-asset.txt').length>=1,
      integration:!!(INTS.zapier&&INTS.zapier.url)
    }),bid);
    check('chat survives immediate reload (saveSoon flush)', r.chat);
    check('task survives immediate reload (collSave flush)', r.task);
    check('event survives immediate reload (collSave flush)', r.event);
    check('asset survives immediate reload (collSave flush)', r.asset);
    check('integration survives immediate reload (saveSoon flush)', r.integration);
    check('flushPendingWrites is defined', await p.evaluate(()=>typeof flushPendingWrites==='function'));
    check('flushPendingWrites is idempotent', await p.evaluate(()=>{ try{ flushPendingWrites(); flushPendingWrites(); return true; }catch(e){ return false; } }));
    await ctx.close();
  }

  // ===== guard: visibilitychange(hidden) also flushes =====
  {
    const {ctx,p} = await newPage();
    await signup(p);
    await p.evaluate(()=>{ Tasks.create({title:'REG-VIS-TASK',status:'todo',visibility:'team'}); });
    await p.evaluate(()=>{ Object.defineProperty(document,'visibilityState',{get:()=>'hidden',configurable:true}); Object.defineProperty(document,'hidden',{get:()=>true,configurable:true}); document.dispatchEvent(new Event('visibilitychange')); });
    await p.waitForTimeout(50);
    await p.reload(); await p.waitForSelector('#app.on',{timeout:8000});
    await p.evaluate(async()=>{ if(typeof loadWorkspaceData==='function') await loadWorkspaceData(); }); await p.waitForTimeout(200);
    check('write flushed on visibilitychange:hidden', await p.evaluate(()=>Tasks.list(t=>t.title==='REG-VIS-TASK').length>=1));
    await ctx.close();
  }

  // ===== guard: normal (post-debounce) reload still persists (no regression) =====
  {
    const {ctx,p} = await newPage();
    await signup(p);
    await p.evaluate(()=>{ Tasks.create({title:'REG-NORMAL',status:'todo',visibility:'team'}); });
    await p.waitForTimeout(1000);
    await p.reload(); await p.waitForSelector('#app.on',{timeout:8000});
    await p.evaluate(async()=>{ if(typeof loadWorkspaceData==='function') await loadWorkspaceData(); }); await p.waitForTimeout(200);
    check('normal post-debounce reload still persists', await p.evaluate(()=>Tasks.list(t=>t.title==='REG-NORMAL').length>=1));
    await ctx.close();
  }
}
try{ await run(); }catch(e){ errors.push('FLOW: '+e.message); }
await browser.close();
console.log(`\nCHECKS: ${ok} passed, ${fail} failed`);
console.log('ERRORS:', errors.length?errors:'NONE');
process.exit(errors.length||fail?1:0);
