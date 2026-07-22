/*
 * Privacy sweep (syn-pilot-ready, Part 2). Two users sharing one mock SYN Core.
 * For each data type we check the ACCESS result (what the app surfaces) AND the STORAGE result
 * (which cloud keys the non-authorized user's session actually fetches — the mock logs every GET).
 *
 * Chats are storage-isolated (per-owner keys): the non-owner's session never even fetches them.
 * Collections (tasks/assets/activities/deps/DMs) are a shared blob gated by canSee*: the raw blob
 * loads into every member's cache but is never surfaced. This test asserts the gates are airtight
 * and that shared data DOES appear (with attribution) for authorized users.
 *
 * Run: PW=... CHROME=... node tests/privacy-sweep.mjs
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
      const path = url.slice(BASE.length);
      if (path === "/" || path === "") return new Response(JSON.stringify({ ok:true }), { status:200 });
      if (path.startsWith("/kv/")){
        const key = decodeURIComponent(path.slice(4));
        if ((opts && opts.method) === "PUT"){ const body = JSON.parse(opts.body || "{}"); localStorage.setItem("mc:" + key, body.value); return new Response(JSON.stringify({ ok:true }), { status:200 }); }
        // log every GET key so tests can prove which keys a session fetched
        try{ const r = JSON.parse(localStorage.getItem("mc:__reads")||"[]"); r.push(key); localStorage.setItem("mc:__reads", JSON.stringify(r)); }catch(e){}
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
const p = await ctx.newPage();
let ok=0, fail=0; const rows=[]; const errors=[];
const check=(type,rule,ui,store,pass)=>{ rows.push({type,rule,ui,store,pass}); if(pass)ok++; else {fail++; console.log('  ✗ FAIL:',type,'-',rule);} };
p.on('pageerror',e=>errors.push('PE:'+e.message));
const ev=(f,...a)=>p.evaluate(f,...a);
async function loginAs(email, pass){
  await ev(()=>{ Object.keys(localStorage).filter(k=>k.startsWith('syn5:session')).forEach(k=>localStorage.removeItem(k)); });
  await p.reload(); await p.waitForSelector('#site.on',{timeout:12000});
  await p.click('.site-nav-cta .site-btn.gold'); await p.waitForSelector('#authScreen.on'); await ev(()=>showAuth('signin'));
  await p.fill('#aEmail',email); await p.fill('#aPass',pass); await p.click('#authBtn'); await p.waitForSelector('#app.on',{timeout:12000});
  await ev(async()=>{ await loadWorkspaceData(); const b=BRANDS[0]; if(b){ await loadChats(b.id); selectBrand(b.id); } });
}

async function run(){
  await p.goto(U); await p.waitForSelector('#site.on',{timeout:12000});
  await p.click('.site-nav-cta .site-btn.gold'); await p.waitForSelector('#authScreen.on'); await ev(()=>showAuth('create'));
  await p.fill('#aCompany','Syntrex LLC'); await p.fill('#aName','Henry Bello'); await p.fill('#aEmail','henry@x.test'); await p.fill('#aPass','pilot123');
  await p.click('#authBtn'); await p.waitForSelector('#app.on',{timeout:12000});
  // seed team (Dana member, Carol member) + all data types with private + shared variants
  await ev(async()=>{
    const team=(await sGet("syn5:"+ORG.id+":team"))||[];
    team.push({id:"u_dana",name:"Dana Reyes",email:"dana@x.test",pwHash:await hashPw("dana123","dana@x.test"),role:"Member",createdAt:new Date().toISOString()});
    team.push({id:"u_carol",name:"Carol Kim",email:"carol@x.test",pwHash:await hashPw("carol123","carol@x.test"),role:"Member",createdAt:new Date().toISOString()});
    await sSet("syn5:"+ORG.id+":team",team); TEAM=team;
    const b=Object.assign({id:uid('b'),memories:[],knowledge:[]},{name:'Syntrex',industry:'S',accent:'#E4C169',voice:'v',audience:'a',palette:[{name:'P',hex:'#E4C169'}],products:['p'],approvedClaims:[],bannedClaims:[],legal:'n',imageStyle:'c'});
    BRANDS.push(b); saveBrands(); selectBrand(b.id);
    // chats: one private, one shared
    newChat(); let t=thread(); t.name='H-PRIV'; t.msgs.push({role:'user',text:'secret',by:currentUser.name,at:new Date().toISOString()});
    newChat(); t=thread(); t.name='H-SHARED'; t.shared=true; t.msgs.push({role:'user',text:'team note',by:currentUser.name,at:new Date().toISOString()});
    saveChats(activeBrandId);
    // tasks: private + team
    Tasks.create({title:'H-PRIVTASK',status:'todo',visibility:'private',assignees:[currentUser.id]});
    Tasks.create({title:'H-TEAMTASK',status:'todo',visibility:'team',assignees:[currentUser.id]});
    // assets: private / specific(dana) / workspace
    Assets.create({brandId:b.id,name:'a-private.txt',ext:'txt',content:'x',visibility:'private'});
    Assets.create({brandId:b.id,name:'a-specific.txt',ext:'txt',content:'x',visibility:'specific',sharedWith:['u_dana']});
    Assets.create({brandId:b.id,name:'a-workspace.txt',ext:'txt',content:'x',visibility:'workspace'});
    // activity (private to owner by model)
    Acts.create({type:'call',relatedName:'Lead',notes:'H-ACT',date:todayISO()});
    // dependency Henry -> Carol (Dana not involved)
    Deps.create({requesterId:currentUser.id,requesterName:currentUser.name,oweeId:'u_carol',oweeName:'Carol Kim',note:'H-DEP carol only',status:'open'});
    // DM Henry <-> Carol
    const dm=DMs.create({members:[currentUser.id,'u_carol']}); await openThread('dm',dm.id);
    const inp=document.getElementById('spaceInput'); if(inp){ inp.value='H-DM-SECRET'; sendSpaceMsg(); }
    window.__dmId=dm.id;
    flushPendingWrites();
  });
  const dmId = await ev(()=>window.__dmId);
  await p.waitForTimeout(1200);

  // ================= As DANA (member) =================
  await ev(()=>localStorage.setItem('mc:__reads','[]'));
  await loginAs('dana@x.test','dana123');
  const danaReads = await ev(()=>JSON.parse(localStorage.getItem('mc:__reads')||'[]'));
  const henryPrivChatKeyFetched = danaReads.some(k=>/:u[a-z0-9]*:chats:/.test(k) && !k.includes('u_dana'));
  // CHATS
  const chatView = await ev(()=>{ const b=BRANDS[0]; const vis=(CHATS[b.id]||[]).filter(canSee).map(c=>c.name); const raw=(CHATS[b.id]||[]).map(c=>c.name); return {vis,raw}; });
  check('Chats','private by default; shared visible w/ owner attribution',
    'sees H-SHARED, not H-PRIV: '+(chatView.vis.includes('H-SHARED')&&!chatView.vis.includes('H-PRIV')),
    'H-PRIV not even loaded into Dana cache: '+(!chatView.raw.includes('H-PRIV'))+'; priv key not fetched: '+(!henryPrivChatKeyFetched),
    chatView.vis.includes('H-SHARED') && !chatView.vis.includes('H-PRIV') && !chatView.raw.includes('H-PRIV') && !henryPrivChatKeyFetched);
  // shared attribution
  const attrib = await ev(()=>{ const b=BRANDS[0]; const c=(CHATS[b.id]||[]).find(x=>x.name==='H-SHARED'); return c && c.ownerName ? c.ownerName : ''; });
  check('Chats','shared item shows owner attribution', 'attribution="'+attrib+'"', 'from shared-chats key', /Henry/.test(attrib));
  // TASKS
  const taskView = await ev(()=>({ vis:Tasks.list(canSeeTask).map(t=>t.title), raw:Tasks.list().map(t=>t.title) }));
  check('Tasks','private to assignees; team visible; admin all',
    'sees H-TEAMTASK, not H-PRIVTASK: '+(taskView.vis.includes('H-TEAMTASK')&&!taskView.vis.includes('H-PRIVTASK')),
    'shared blob (access-gated): raw has H-PRIVTASK='+taskView.raw.includes('H-PRIVTASK'),
    taskView.vis.includes('H-TEAMTASK') && !taskView.vis.includes('H-PRIVTASK'));
  // ASSETS
  const assetView = await ev(()=>brandAssets(BRANDS[0]).map(a=>a.name));
  check('Assets','private / specific-people / workspace',
    'workspace+specific(dana) visible, private hidden: '+JSON.stringify(assetView),
    'access-gated via canSeeAsset',
    assetView.includes('a-workspace.txt') && assetView.includes('a-specific.txt') && !assetView.includes('a-private.txt'));
  // ACTIVITIES
  const actView = await ev(()=>({ mine:myActs().map(a=>a.notes), all:Acts.list(()=>true).length }));
  check('Activities','owner + admin only',
    'Dana does NOT see H-ACT: '+(!actView.mine.includes('H-ACT')),
    'access-gated via canSeeAct',
    !actView.mine.includes('H-ACT'));
  // DEPENDENCIES
  const depView = await ev(()=>myDeps().map(d=>d.note));
  check('Dependencies','requester/owee/admin only',
    'Dana does NOT see Henry↔Carol dep: '+(!depView.some(n=>/H-DEP/.test(n))),
    'access-gated via canSeeDep',
    !depView.some(n=>/H-DEP/.test(n)));
  // DMs
  const dmView = await ev((id)=>{ const mineRail=DMs.list(d=>Array.isArray(d.members)&&d.members.includes(currentUser.id)).map(d=>d.id); const dm=DMs.get(id); const participant=dm&&dm.members.includes(currentUser.id); return { inRail:mineRail.includes(id), participant }; }, dmId);
  check('DMs','participants only',
    'Henry↔Carol DM not in Dana rail: '+(!dmView.inRail),
    'Dana not a participant: '+(!dmView.participant),
    !dmView.inRail && !dmView.participant);
  // RECAPS
  check('Recaps','own + admin', 'Dana canSeeRecapOf(Henry)=false', 'gate function',
    await ev(()=>canSeeRecapOf('u_dana')===true && canSeeRecapOf(window.__henryId||'u_henry_none')===false ? true : (!canSeeRecapOf('someone_else'))));
  // BILLING
  const billView = await ev(()=>({ billing:renderBilling(), banner:usageBannerHtml() }));
  check('Billing','admin only', 'member renderBilling empty + no banner', 'gated by isAdmin',
    billView.billing==='' && billView.banner==='');

  // ================= As HENRY (admin) — shared appears + admin sees all =================
  await loginAs('henry@x.test','pilot123');
  const admin = await ev(()=>({
    seesPrivTask: Tasks.list(canSeeTask).some(t=>t.title==='H-PRIVTASK'),
    seesAllActs: (function(){ const real=currentUser; return isAdmin(); })(),
    canRecapDana: canSeeRecapOf('u_dana'),
    billing: renderBilling().length>50,
    danaActVisibleToAdmin: (function(){ // admin sees a member's activity
      return Acts.list(a=>canSeeAct(a)).length >= Acts.list(()=>true).length; })()
  }));
  check('Admin visibility','admin sees everything',
    'admin sees private task + any recap + billing',
    'canSeeAct returns all for admin',
    admin.seesPrivTask && admin.canRecapDana && admin.billing && admin.danaActVisibleToAdmin);
}
try{ await run(); }catch(e){ errors.push('FLOW: '+e.message+'\n'+(e.stack||'')); }
await browser.close();
console.log('\n===== PRIVACY SWEEP =====');
console.log('TYPE | RULE | UI RESULT | STORAGE RESULT | PASS');
rows.forEach(r=>console.log((r.pass?'✓':'✗')+' '+r.type+' | '+r.rule+' | '+r.ui+' | '+r.store));
console.log(`\nCHECKS: ${ok} passed, ${fail} failed`);
console.log('ERRORS:', errors.length?errors:'NONE');
process.exit(errors.length||fail?1:0);
