/* P0-B: the AI's create-event and create-task tools accept a visibility field, so the model can
   make an event "private to just me" that does not show on other users' calendars — instead of
   telling the user to set it manually. */
import pkg from '/tmp/node_modules/playwright-core/index.js';
import { readFileSync, readdirSync } from 'node:fs';
const { chromium } = pkg;
const U = 'file:///home/user/SYN-AI/index.html';
const REPO = U.replace('file://', '').replace('/index.html', '');
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let ok = 0, fail = 0; const check = (n, c) => { (c ? ok++ : fail++); if (!c) console.log('FAIL', n); };

const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark' });
const p = await ctx.newPage();
await p.goto(U); await p.waitForSelector('#site.on');
await p.click('.site-nav-cta .site-btn.gold'); await p.waitForSelector('#authScreen.on');
await p.fill('#aCompany', 'Northwind Supply Co.'); await p.fill('#aName', 'Ada Owner'); await p.fill('#aEmail', 'ada@nw.test'); await p.fill('#aPass', 'pass1234');
await p.click('#authBtn'); await p.waitForSelector('#app.on');
await p.evaluate(() => { TEAM.push({ id: 'u_ben', name: 'Ben Member', email: 'ben@nw.test', role: 'Member' }); window.__A = currentUser.id; });

// normVisibility maps natural language to the app's real values
const nv = await p.evaluate(() => ({
  justme: normVisibility('just me', 'team'), personal: normVisibility('personal', 'team'),
  everyone: normVisibility('everyone', 'private'), team: normVisibility('the whole team', 'private'),
  blankEvt: normVisibility('', 'team'), blankTask: normVisibility('', 'private'), priv: normVisibility('private', 'team')
}));
check('normVisibility: "just me" -> private', nv.justme === 'private');
check('normVisibility: "personal" -> private', nv.personal === 'private');
check('normVisibility: "everyone" -> team', nv.everyone === 'team');
check('normVisibility: "the whole team" -> team', nv.team === 'team');
check('normVisibility: default respected (event blank -> team)', nv.blankEvt === 'team');
check('normVisibility: default respected (task blank -> private)', nv.blankTask === 'private');

// ===== EVENT: "add an event at 3:30 today, private to just me" =====
const evtPriv = await p.evaluate(() => {
  const today = todayISO();
  const before = Events.list().length;
  ingestAIEvents([`Focus block | ${today} | 15:30 |  | private`]);   // model output the model would emit
  const ev = Events.list()[Events.list().length - 1];
  const meSees = canSeeEvent(ev);
  const ada = currentUser; currentUser = { id: 'u_ben', name: 'Ben Member', role: 'Member' };
  const benSees = canSeeEvent(ev);
  currentUser = ada;
  return { made: Events.list().length - before, vis: ev.visibility, time: ev.startTime, createdBy: ev.createdBy === window.__A, meSees, benSees };
});
check('AI event created', evtPriv.made === 1);
check('AI private event has visibility "private"', evtPriv.vis === 'private');
check('AI event honored the 3:30pm time (15:30)', evtPriv.time === '15:30');
check('private event is owned by the creator', evtPriv.createdBy === true);
check('creator (Ada) SEES her private event', evtPriv.meSees === true);
check('other user (Ben) does NOT see the private event', evtPriv.benSees === false);

// ===== EVENT team/default is visible to everyone =====
const evtTeam = await p.evaluate(() => {
  const today = todayISO();
  ingestAIEvents([`Team standup | ${today} | 09:00 |  | everyone`]);
  const ev = Events.list()[Events.list().length - 1];
  const ada = currentUser; currentUser = { id: 'u_ben', name: 'Ben Member', role: 'Member' };
  const benSees = canSeeEvent(ev); currentUser = ada;
  return { vis: ev.visibility, benSees };
});
check('AI "everyone" event is team-visible', evtTeam.vis === 'team' && evtTeam.benSees === true);

// ===== TASK visibility =====
const taskVis = await p.evaluate(() => {
  ingestAITasks([`Private research |  |  | high |  | just me`]);
  const tp = Tasks.list()[Tasks.list().length - 1];
  ingestAITasks([`Shared rollout |  |  | med |  | team`]);
  const tt = Tasks.list()[Tasks.list().length - 1];
  const ada = currentUser; currentUser = { id: 'u_ben', name: 'Ben Member', role: 'Member' };
  const benSeesPriv = canSeeTask(tp), benSeesTeam = canSeeTask(tt);
  currentUser = ada;
  return { pv: tp.visibility, tv: tt.visibility, benSeesPriv, benSeesTeam };
});
check('AI task "just me" -> private', taskVis.pv === 'private');
check('AI task "team" -> team', taskVis.tv === 'team');
check('other user cannot see the private AI task', taskVis.benSeesPriv === false);
check('other user can see the team AI task', taskVis.benSeesTeam === true);

// ===== system prompt actually advertises the visibility field to the model =====
// Read the shipped app source. Historically this grepped document.documentElement.innerHTML,
// which only worked while the JS was inline in the page; after the JS was extracted to js/*.js
// the source lives in external files, so read those directly (index.html + every js/ file).
const promptOk = (() => {
  const src = readFileSync(REPO + '/index.html', 'utf8') +
    readdirSync(REPO + '/js').filter(f => f.endsWith('.js')).map(f => readFileSync(REPO + '/js/' + f, 'utf8')).join('\n');
  const hasTaskVis = /\[\[TASK: title \| assignee \| YYYY-MM-DD \| priority \| project \| visibility\]\]/.test(src);
  const hasEvtVis = /\[\[EVENT: title \| YYYY-MM-DD \| HH:MM \| attendees \| visibility\]\]/.test(src);
  return { hasTaskVis, hasEvtVis };
})();
check('system prompt documents TASK visibility field', promptOk.hasTaskVis === true);
check('system prompt documents EVENT visibility field', promptOk.hasEvtVis === true);

await ctx.close();
console.log(`CHECKS: ${ok} passed, ${fail} failed`);
console.log(fail ? 'ERRORS: PRESENT' : 'ERRORS: NONE');
if (fail) process.exitCode = 1;
await b.close();
