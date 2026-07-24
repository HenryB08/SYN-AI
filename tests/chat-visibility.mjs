/* P0-A regression: chat visibility is owner-only and re-keying never orphans the record.
   Repro being guarded against: a non-owner toggling a shared chat to private deleted it for
   BOTH users because saveChats re-filed it under the wrong per-user key. */
import pkg from '/tmp/node_modules/playwright-core/index.js';
const { chromium } = pkg;
const U = 'file:///home/user/SYN-AI/index.html';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let ok = 0, fail = 0; const check = (n, c) => { (c ? ok++ : fail++); if (!c) console.log('FAIL', n); };

const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark' });
const p = await ctx.newPage();
await p.goto(U); await p.waitForSelector('#site.on');
await p.evaluate(() => siteAuth('create')); await p.waitForSelector('#authScreen.on');
await p.fill('#aCompany', 'Northwind Supply Co.'); await p.fill('#aName', 'Ada Owner'); await p.fill('#aEmail', 'ada@nw.test'); await p.fill('#aPass', 'pass1234');
await p.click('#authBtn'); await p.waitForSelector('#app.on');

// Seed a brand + a second member (Ben, non-owner), and one private chat owned by Ada.
await p.evaluate(async () => {
  const bnd = Object.assign({ id: uid('b'), memories: [], knowledge: [] }, { name: 'NW', industry: 'Supply', accent: '#6E8FB0', voice: 'v', audience: 'a', palette: [], products: [], approvedClaims: [], bannedClaims: [], legal: '', imageStyle: '' });
  BRANDS.push(bnd); saveBrands(); selectBrand(bnd.id);
  await loadChats(activeBrandId);                       // let selectBrand's async load settle before we seed
  TEAM.push({ id: 'u_ben', name: 'Ben Member', email: 'ben@nw.test', role: 'Member' });
  window.__A = currentUser.id;
  const chat = { id: 'c_test', name: 'Ada private notes', pinned: false, shared: false, ownerId: currentUser.id, ownerName: currentUser.name, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), msgs: [{ role: 'user', text: 'secret', at: new Date().toISOString(), atts: [] }] };
  CHATS[activeBrandId] = [chat];
  await sSet(privChatKey(activeBrandId), [chat].map(stripChat));   // deterministic: storage matches memory now
  await sSet(sharedChatKey(activeBrandId), []);
});
const key = k => p.evaluate(kk => (typeof sGet === 'function') ? sGet(kk) : null, k);
const readBack = () => p.evaluate(async () => {
  const bId = activeBrandId;
  const mine = (await sGet(privChatKey(bId))) || [];       // current user's private store
  const shared = (await sGet(sharedChatKey(bId))) || [];
  return { mineIds: mine.map(c => c.id), sharedIds: shared.map(c => c.id) };
});

// ---- OWNER shares the chat (private -> shared): atomic, survives, readable ----
const r1 = await p.evaluate(async () => { const res = await setChatVisibility('c_test', true); return res; });
check('owner can share (private -> shared)', r1.ok === true);
let rb = await readBack();
check('after share: chat is in the SHARED store', rb.sharedIds.includes('c_test'));
check('after share: chat is NOT left behind in owner private store', !rb.mineIds.includes('c_test'));

// ---- OWNER makes it private again (shared -> private): survives, readable, back in private store ----
const r2 = await p.evaluate(async () => await setChatVisibility('c_test', false));
check('owner can un-share (shared -> private)', r2.ok === true);
rb = await readBack();
check('after un-share: chat is back in owner private store', rb.mineIds.includes('c_test'));
check('after un-share: chat is NOT left behind in shared store', !rb.sharedIds.includes('c_test'));
check('after both toggles: owner can still SEE the chat', await p.evaluate(() => canSee(CHATS[activeBrandId].find(c => c.id === 'c_test'))));

// ---- Share it again, then a NON-OWNER (Ben) tries to make it private ----
await p.evaluate(async () => { await setChatVisibility('c_test', true); });   // shared again, owned by Ada
const nonOwner = await p.evaluate(async () => {
  // become Ben in this session; the shared chat is visible to him (shared store)
  const ada = currentUser; window.__ada = ada;
  currentUser = { id: 'u_ben', name: 'Ben Member', role: 'Member' };
  const chat = CHATS[activeBrandId].find(c => c.id === 'c_test');
  const gate = canChangeChatVisibility(chat);                 // must be false for a non-owner
  const res = await setChatVisibility('c_test', false);       // must be refused at the data layer
  return { gate, res, stillShared: !!chat.shared };
});
check('non-owner canChangeChatVisibility = false', nonOwner.gate === false);
check('non-owner setChatVisibility is refused (forbidden)', nonOwner.res.ok === false && nonOwner.res.reason === 'forbidden');
check('non-owner attempt leaves the chat shared (not orphaned)', nonOwner.stillShared === true);

// ---- The chat is still present and readable for everyone who should see it ----
rb = await readBack();
check('chat survives the non-owner attempt: still in the shared store', rb.sharedIds.includes('c_test'));
check('non-owner (Ben) can still SEE the shared chat', await p.evaluate(() => canSee(CHATS[activeBrandId].find(c => c.id === 'c_test'))));
const ownerSees = await p.evaluate(() => { currentUser = window.__ada; return canSee(CHATS[activeBrandId].find(c => c.id === 'c_test')); });
check('owner (Ada) can still SEE the chat', ownerSees === true);

// ---- UI: the visibility control is not offered to a non-owner ----
const menu = await p.evaluate(() => {
  currentUser = { id: 'u_ben', name: 'Ben Member', role: 'Member' };
  const t = CHATS[activeBrandId].find(c => c.id === 'c_test');
  const anchor = document.createElement('button'); document.body.appendChild(anchor);
  openChatMenu('c_test', anchor);
  const has = !!document.querySelector('#chatCtxMenu [data-cact="share"]');
  closeChatMenu(); anchor.remove(); currentUser = window.__ada;
  return has;
});
check('non-owner sees NO visibility control in the chat menu', menu === false);
const ownerMenu = await p.evaluate(() => {
  const anchor = document.createElement('button'); document.body.appendChild(anchor);
  openChatMenu('c_test', anchor);
  const has = !!document.querySelector('#chatCtxMenu [data-cact="share"]');
  closeChatMenu(); anchor.remove();
  return has;
});
check('owner DOES see the visibility control', ownerMenu === true);

await ctx.close();
console.log(`CHECKS: ${ok} passed, ${fail} failed`);
console.log(fail ? 'ERRORS: PRESENT' : 'ERRORS: NONE');
if (fail) process.exitCode = 1;
await b.close();
