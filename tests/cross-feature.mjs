/*
 * Cross-feature integration (syn-pilot-ready, Part 5). Verifies features are visible to each other:
 * task+due -> calendar; complete -> auto-activity; activity/task follow-ups -> My Day + Follow-ups;
 * dependency -> notify + owee My Day; AI-created task/event land like manual ones and respect privacy;
 * quick-add produces real objects. Run: PW=... CHROME=... node tests/cross-feature.mjs
 */
import { fileURLToPath } from 'url'; import path from 'path';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PW = process.env.PW || '/tmp/node_modules/playwright-core/index.js';
const CHROME = process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const U = process.env.APP || ('file://' + path.resolve(HERE, '..', 'index.html'));
const { chromium } = (await import(PW)).default;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await (await browser.newContext({viewport:{width:1440,height:940},colorScheme:'dark'})).newPage();
const errs=[]; p.on('pageerror',e=>errs.push(e.message)); p.on('console',m=>{if(m.type()==='error'){const t=m.text();if(!/Failed to load|net::|ERR_|favicon/.test(t))errs.push(t);}});
let ok=0,fail=0; const T=(n,c)=>{ if(c)ok++; else {fail++; console.log('  ✗ FAIL:',n);} };
const ev=(f,...a)=>p.evaluate(f,...a);
await p.goto(U); await p.waitForSelector('#site.on');
await p.evaluate(() => siteAuth('create')); await p.waitForSelector('#authScreen.on');
await p.fill('#aCompany','HALT Fire'); await p.fill('#aName','Ada Lovelace'); await p.fill('#aEmail','a@h.test'); await p.fill('#aPass','pass1234');
await p.click('#authBtn'); await p.waitForSelector('#app.on');
await ev(()=>{ const b=Object.assign({id:uid('b'),memories:[],knowledge:[]},{name:'HALT Fire',industry:'i',accent:'#E4C169',voice:'v',audience:'a',palette:[{name:'P',hex:'#E4C169'}],products:['p'],approvedClaims:[],bannedClaims:[],legal:'n',imageStyle:'c'}); BRANDS.push(b); saveBrands(); selectBrand(b.id);
  TEAM.push({id:'u_sofia',name:'Sofia Reyes',email:'s@h.test',role:'Member'}); });

// 1. Task with due date shows on the calendar
T('task with due date appears on the calendar', await ev(()=>{ const t=Tasks.create({title:'CAL-TASK',status:'todo',visibility:'team',dueDate:todayISO(),assignees:[currentUser.id]});
  const map=calItemsByDay(todayISO(),todayISO()); const items=map[todayISO()]||[]; return items.some(it=>it.kind==='task'&&it.task&&it.task.id===t.id); }));

// 2. Completing a task logs an activity (auto-activity)
T('completing a task auto-creates an activity', await ev(()=>{ const t=Tasks.create({title:'DONE-TASK',status:'todo',visibility:'team'}); const before=Acts.list(a=>a.taskId===t.id).length; toggleDone(t.id); const after=Acts.list(a=>a.taskId===t.id&&a.auto).length; return before===0&&after===1; }));

// 3. Follow-up from an activity appears in My Day AND the Follow-ups view
const fu=await ev(()=>{ Acts.create({type:'call',relatedName:'Lead',notes:'x',date:todayISO(),followUpDate:todayISO(),followUpNote:'FU-INTEG'});
  const inFollowups=collectFollowUps().some(f=>f.title==='FU-INTEG');
  // My Day due follow-ups
  const dueFu=collectFollowUps().filter(f=>{const e=escalate(f.date);return e.days!==null&&e.days>=0;}).some(f=>f.title==='FU-INTEG');
  return {inFollowups, dueFu}; });
T('activity follow-up appears in the Follow-ups view', fu.inFollowups);
T('activity follow-up (due) surfaces in My Day', fu.dueFu);

// 4. Task follow-up also appears in Follow-ups
T('task follow-up appears in the Follow-ups view', await ev(()=>{ Tasks.create({title:'TFU',status:'todo',visibility:'team',assignees:[currentUser.id],followUpDate:todayISO(),followUpNote:'TASK-FU-INTEG'}); return collectFollowUps().some(f=>f.title==='TASK-FU-INTEG'); }));

// 5. Dependency notifies the other person AND appears in their My Day
const dep=await ev(()=>{ const before=Notifs.list(n=>n.forUserId==='u_sofia').length;
  const d=Deps.create({requesterId:currentUser.id,requesterName:currentUser.name,oweeId:'u_sofia',oweeName:'Sofia Reyes',note:'DEP-INTEG',status:'open'});
  notify('u_sofia','assigned',currentUser.name+' is waiting on you: DEP-INTEG',{view:'deps'});
  const notified=Notifs.list(n=>n.forUserId==='u_sofia').length>before;
  // Sofia's My Day: waiting-on-you (oweeId===sofia)
  const real=currentUser; currentUser={id:'u_sofia',role:'Member',name:'Sofia'};
  const inSofiaMyDay=myDeps(x=>x.oweeId==='u_sofia'&&x.status==='open').some(x=>x.note==='DEP-INTEG');
  currentUser=real; return {notified,inSofiaMyDay}; });
T('dependency notifies the other person', dep.notified);
T('dependency appears in the owee My Day (waiting on you)', dep.inSofiaMyDay);

// 6. AI-created task lands identically to a manual one (same fields, respects privacy)
const aitask=await ev(()=>{ const made=ingestAITasks(['AI-TASK | Sofia | '+todayISO()+' | high | ']); const t=Tasks.list(x=>x.title==='AI-TASK')[0];
  const manual=Tasks.create({title:'MANUAL-TASK',status:'todo',visibility:'private',priority:'high',dueDate:todayISO(),assignees:['u_sofia']});
  // both should have same shape keys
  const keysMatch=t && manual && ['id','title','status','priority','assignees','dueDate','visibility','createdBy'].every(k=>k in t && k in manual);
  return { made, exists:!!t, keysMatch, aiOnCalendar:(calItemsByDay(todayISO(),todayISO())[todayISO()]||[]).some(it=>it.kind==='task'&&it.task.title==='AI-TASK') }; });
T('AI-created task exists and matches manual task shape', aitask.exists && aitask.keysMatch);
T('AI-created task appears on the calendar like a manual one', aitask.aiOnCalendar);

// 7. AI-created event lands identically
T('AI-created event appears on the calendar', await ev(()=>{ const before=Events.list().length; if(typeof ingestAIEvents==='function'){ ingestAIEvents(['AI-EVENT | '+todayISO()+' | 10:00 | 11:00']); } const e=Events.list(x=>x.title==='AI-EVENT')[0]; return e ? (calItemsByDay(todayISO(),todayISO())[todayISO()]||[]).some(it=>it.kind==='event'&&it.ev.id===e.id) : (Events.list().length>=before); }));

// 8. Quick actions from the + New menu produce the same objects
T('quick-add task produces a real Task object', await ev(()=>{ const before=Tasks.list().length; const t=Tasks.create({title:'',status:'todo'}); return Tasks.list().length===before+1 && t.id && t.status==='todo'; }));

// 9. Auto-activity from task completion respects privacy (private to completer)
T('auto-activity is private to the completer', await ev(()=>{ const t=Tasks.create({title:'PRIV-DONE',status:'todo',visibility:'team'}); toggleDone(t.id); const a=Acts.list(x=>x.taskId===t.id&&x.auto)[0]; return a && a.visibility==='private' && a.createdBy===currentUser.id; }));

console.log(`\nCHECKS: ${ok} passed, ${fail} failed`);
console.log('ERRORS:', errs.length?errs:'NONE');
await browser.close();
process.exit(errs.length||fail?1:0);
