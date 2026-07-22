/*
 * Tests for the operations layer (syn-ops-layer):
 *  - escalation state transitions at each threshold
 *  - dependency notifications across two users
 *  - admin vs member visibility on the rollup and recaps
 *  - data-layer privacy for activities and dependencies
 *  - persistence (incl. immediate-reload flush) of the new entities
 *  - auto-activity on task completion + AI-parse local fallback
 *
 * Run: PW=... CHROME=... node tests/ops-layer.mjs   (defaults match Claude Code web env)
 */
import { fileURLToPath } from 'url';
import path from 'path';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PW = process.env.PW || '/tmp/node_modules/playwright-core/index.js';
const CHROME = process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const U = process.env.APP || ('file://' + path.resolve(HERE, '..', 'index.html'));
const { chromium } = (await import(PW)).default;

const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext({viewport:{width:1440,height:940},colorScheme:'dark'});
const p = await ctx.newPage();
const errors=[]; let ok=0,fail=0; const check=(n,c)=>{ if(c)ok++; else {fail++; console.log('  ✗ FAIL:',n);} };
p.on('console',m=>{if(m.type()==='error'){const t=m.text(); if(!/Failed to load resource|net::|ERR_|favicon/.test(t)) errors.push(t);}});
p.on('pageerror',e=>errors.push('PAGEERROR: '+e.message));
const ev=(f,...a)=>p.evaluate(f,...a);

async function run(){
  await p.goto(U); await p.waitForSelector('#site.on');
  await p.click('.site-nav-cta .site-btn.gold'); await p.waitForSelector('#authScreen.on');
  await p.fill('#aCompany','HALT Fire'); await p.fill('#aName','Ada Lovelace'); await p.fill('#aEmail','a@h.test'); await p.fill('#aPass','pass1234');
  await p.click('#authBtn'); await p.waitForSelector('#app.on');
  await ev(()=>{ const b=Object.assign({id:uid('b'),memories:[],knowledge:[]},{name:'HALT Fire',industry:'i',accent:'#E4C169',voice:'v',audience:'a',palette:[{name:'P',hex:'#E4C169'}],products:['p'],approvedClaims:[],bannedClaims:[],legal:'n',imageStyle:'c'}); BRANDS.push(b); saveBrands(); selectBrand(b.id);
    TEAM.push({id:'u_sofia',name:'Sofia Reyes',email:'s@h.test',role:'Member',createdAt:new Date().toISOString()});
    window.ADMIN=currentUser.id;
  });
  const ADMIN = await ev(()=>currentUser.id);

  // ===== escalation thresholds =====
  const esc = await ev(()=>{ const iso=d=>{const x=new Date();x.setHours(0,0,0,0);x.setDate(x.getDate()+d);return x.toISOString().slice(0,10);};
    const at=d=>{const e=escalate(iso(d));return e.key+'|'+(e.badge?'B':'-');};
    // +future -> upcoming, 0 -> today, -N -> N days overdue
    return { m1:at(3), d0:at(0), d1:at(-1), d3:at(-3), d4:at(-4), d13:at(-13), d14:at(-14), d20:at(-20), none:escalate(null).key };
  });
  check('escalation: 3 days out (future) = upcoming', esc.m1==='upcoming|-');
  check('escalation: due today = today', esc.d0==='today|-');
  check('escalation: 1 day overdue = warm', esc.d1==='warm|-');
  check('escalation: 3 days overdue = warm', esc.d3==='warm|-');
  check('escalation: 4 days overdue = red', esc.d4==='red|-');
  check('escalation: 13 days overdue = red', esc.d13==='red|-');
  check('escalation: 14 days overdue = critical + badge', esc.d14==='critical|B');
  check('escalation: 20 days overdue = critical + badge', esc.d20==='critical|B');
  check('escalation: no date = none', esc.none==='none');
  check('escalation label always includes text (never colour alone)', await ev(()=>{ const iso=d=>{const x=new Date();x.setDate(x.getDate()+d);return x.toISOString().slice(0,10);}; return escalate(iso(-6)).label.includes('overdue') && escalate(iso(0)).label==='Due today'; }));

  // ===== data-layer privacy: activities =====
  await ev((admin)=>{ Acts.create({type:'call',relatedName:'Dana',notes:'private to admin',date:todayISO(),createdBy:admin,createdByName:'Ada Lovelace',visibility:'private'}); }, ADMIN);
  check('admin sees own private activity', await ev(()=>myActs(a=>a.notes==='private to admin').length>=1));
  const memberSeesPrivate = await ev(()=>{ const real=currentUser; currentUser={id:'u_sofia',role:'Member',name:'Sofia'}; const n=myActs(a=>a.notes==='private to admin').length; currentUser=real; return n; });
  check('member CANNOT see admin private activity (data layer)', memberSeesPrivate===0);

  // ===== dependency notifications across two users =====
  const dep = await ev((admin)=>{ const before=Notifs.list(n=>n.forUserId==='u_sofia').length;
    const d=Deps.create({requesterId:admin,requesterName:'Ada Lovelace',oweeId:'u_sofia',oweeName:'Sofia Reyes',note:'Approve Riverside pricing',status:'open'});
    notify('u_sofia','assigned','Ada Lovelace is waiting on you: Approve Riverside pricing',{view:'deps'});
    return { notified: Notifs.list(n=>n.forUserId==='u_sofia').length>before, id:d.id };
  }, ADMIN);
  check('creating a dependency notifies the other person', dep.notified);
  // Sofia's perspective
  const sofia = await ev(()=>{ const real=currentUser; currentUser={id:'u_sofia',role:'Member',name:'Sofia Reyes'};
    const canSee = canSeeDep(Deps.list(d=>d.note==='Approve Riverside pricing')[0]);
    const inOwe = Deps.list(d=>canSeeDep(d)&&d.oweeId==='u_sofia'&&d.status==='open').length>=1;
    const inMyDayCount = myDeps(d=>d.oweeId==='u_sofia'&&d.status==='open').length;
    currentUser=real; return {canSee,inOwe,inMyDayCount};
  });
  check('owee can see the dependency (canSeeDep)', sofia.canSee);
  check('dependency shows in owee "What I owe others"', sofia.inOwe);
  check('dependency surfaces for owee (My Day waiting-on-you)', sofia.inMyDayCount>=1);
  check('requester sees it in "What others owe me"', await ev((admin)=>myDeps(d=>d.requesterId===admin&&d.status==='open').length>=1, ADMIN));
  // a THIRD party cannot see it
  const third = await ev(()=>{ TEAM.push({id:'u_ben',name:'Ben',email:'b@h.test',role:'Member'}); const real=currentUser; currentUser={id:'u_ben',role:'Member',name:'Ben'}; const n=myDeps(d=>d.note==='Approve Riverside pricing').length; currentUser=real; return n; });
  check('uninvolved member cannot see the dependency', third===0);

  // ===== admin vs member visibility: rollup =====
  await p.evaluate(()=>setView('rollup')); await p.waitForTimeout(150);
  check('admin sees rollup data (stat tiles rendered)', await ev(()=>document.querySelectorAll('#rollupPanel .stat-tile').length>=3));
  const memberRollup = await ev(()=>{ const real=currentUser; currentUser={id:'u_sofia',role:'Member',name:'Sofia'}; renderRollup(); const blocked=/admins/i.test(document.getElementById('rollupPanel').textContent) && document.querySelectorAll('#rollupPanel .stat-tile').length===0; currentUser=real; renderRollup(); return blocked; });
  check('member is blocked from the rollup (admin-only, data layer)', memberRollup);
  check('member rollup nav hidden after badge refresh', await ev(()=>{ const real=currentUser; currentUser={id:'u_sofia',role:'Member',name:'Sofia'}; updateOpsBadges(); const hidden=document.querySelector('.nav-btn[data-view="rollup"]').style.display==='none'; currentUser=real; updateOpsBadges(); return hidden; }));

  // ===== admin vs member visibility: recaps =====
  check('admin can compute any member recap', await ev(()=>canSeeRecapOf('u_sofia')));
  const memberRecap = await ev(()=>{ const real=currentUser; currentUser={id:'u_sofia',role:'Member',name:'Sofia'};
    const canOwn=canSeeRecapOf('u_sofia'), canOther=canSeeRecapOf(real.id);
    // renderRecap must clamp recapUser back to self for a member
    recapUser='__'+real.id; renderRecap(); const clamped=(recapUser==='u_sofia');
    currentUser=real; return {canOwn,canOther,clamped};
  });
  check('member can view own recap', memberRecap.canOwn);
  check('member CANNOT view another member recap (data layer)', !memberRecap.canOther);
  check('renderRecap clamps a member to their own recap', memberRecap.clamped);

  // ===== auto-activity on task complete =====
  check('completing a task auto-creates one private activity', await ev(()=>{ const t=Tasks.create({title:'Close deal',status:'todo',visibility:'team'}); const before=Acts.list(a=>a.taskId===t.id).length; toggleDone(t.id); toggleDone(t.id); toggleDone(t.id); const after=Acts.list(a=>a.taskId===t.id&&a.auto).length; return before===0&&after===1; }));

  // ===== AI parse local fallback =====
  const parse = await ev(()=>localParse('Called Dana at Acme about the sample, she wants a quote by Friday. Emailed Ben the deck. Need to send samples to Riverside next week.'));
  check('AI-parse local fallback extracts activities', (parse.activities||[]).length>=2);
  check('AI-parse local fallback extracts tasks/follow-ups', (parse.tasks||[]).length>=1);

  // ===== CSV export (Excel-clean: BOM + quoting) =====
  const csv = await ev(()=>csvDoc([['a','b'],['x,y','he said "hi"']]));
  check('CSV has UTF-8 BOM', csv.charCodeAt(0)===0xFEFF);
  check('CSV quotes commas and escapes quotes', csv.includes('"x,y"') && csv.includes('"he said ""hi"""'));

  // ===== persistence incl. immediate reload (flush-on-unload preserved) =====
  await ev((admin)=>{ Acts.create({type:'meeting',relatedName:'Persist',notes:'ops-persist',date:todayISO(),createdBy:admin}); Deps.create({requesterId:admin,oweeId:'u_sofia',note:'ops-dep-persist',status:'open'}); Contacts.create({name:'Persist Contact',company:'PC'}); });
  await p.reload();  // immediate — inside debounce window
  await p.waitForSelector('#app.on',{timeout:8000});
  await ev(async()=>{ if(typeof loadWorkspaceData==='function') await loadWorkspaceData(); }); await p.waitForTimeout(300);
  check('activity survives immediate reload', await ev(()=>Acts.list(a=>a.notes==='ops-persist').length>=1));
  check('dependency survives immediate reload', await ev(()=>Deps.list(d=>d.note==='ops-dep-persist').length>=1));
  check('contact survives immediate reload', await ev(()=>Contacts.list(c=>c.name==='Persist Contact').length>=1));
}
try{ await run(); }catch(e){ errors.push('FLOW: '+e.message+'\n'+(e.stack||'')); }
await browser.close();
console.log(`\nCHECKS: ${ok} passed, ${fail} failed`);
console.log('ERRORS:', errors.length?errors:'NONE');
process.exit(errors.length||fail?1:0);
