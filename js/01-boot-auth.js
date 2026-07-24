/* ============================================================
   js/01-boot-auth.js — deployment config, the storage adapter (localStorage/SYN-Core cloud tier), app STATE + default data, helpers, persistence, BOOT, public marketing-site routing, the marketing AI assistant, workspace join codes, and AUTH (sign-in / create / join).
   MOVE, not a refactor: a byte-identical slice of the original inline <script>.
   Order-dependent. Loads after (load first) and before 02-chat.js. Shared global
   scope, not a module. Do not reorder these tags.
   ============================================================ */

/* =====================================================================
   SYN PLATFORM v5 · Syntrex Brand Intelligence Engine · Multi-workspace
   Persistent workspace (accounts, brands, chats, memory, approvals,
   assets all saved), markdown rendering, live web research, model
   routing, stop/regenerate, voice dictation, portfolio dashboard.
   ===================================================================== */

/* ================= DEPLOYMENT CONFIG =================
   Set SYN_CORE_URL to your Cloudflare Worker URL (no trailing slash),
   e.g. "https://syn-core.henrybello.workers.dev"
   In the Claude preview this is not needed. On a live site it is required
   for chat and research to work. */
const SYN_CORE_URL = "https://syn-core.henrybello.workers.dev";
/* SITE_BASE_URL — the canonical public origin of this site. Single source of truth
   for any FULLY-QUALIFIED self-reference; the static <link rel="canonical">, og:url,
   and JSON-LD in index.html mirror this value. Every internal asset/route reference is
   RELATIVE (never rooted at SITE_BASE_URL) so the app runs unchanged at the current
   /SYN-AI/ subpath and at the domain root — use this only when an absolute URL is truly
   required (share links, canonical redirects), never for loading local assets. */
const SITE_BASE_URL = "https://syn.syntrexio.com";
function apiBase(){
  return (SYN_CORE_URL && SYN_CORE_URL.startsWith("http")) ? SYN_CORE_URL : "https://api.anthropic.com";
}

/* ============ TEMPORARY ACCESS GATE (client side) — NOT AN AUTH SYSTEM ============
   A single-credential bouncer for the private beta so the app can be demoed safely.
   The REAL check lives in the syn-core Worker (POST /gate); this side only holds the
   signed token the Worker issues and attaches it to every /kv and /v1/messages request.
   If the token is missing/invalid/expired, the data layer 401s and the app returns to
   the sign-in gate. Prompt 26 replaces this whole gate with real auth — do not build on
   it. The gate is only ACTIVE against real SYN Core (persistMode==="cloud"); in local /
   preview mode there is no Worker to gate against, so it stays inert and the normal
   create/join flow works (that path is not public). */
let gateToken = null;
try{ gateToken = localStorage.getItem("syn5:gate") || null; }catch(e){}
// The gate is active when talking to real SYN Core. __GATE_BYPASS__ is a CLIENT-ONLY test
// seam: the mock-cloud suites set it so they can exercise multi-user app logic (create/join/two
// users) without the single-admin gate UI. It is NOT a security bypass — the Worker still requires
// the signed token on every /kv and /v1/messages request, so nothing is reachable without passing
// the real gate. Production never sets it.
function gateActive(){ return persistMode === "cloud" && !(typeof window !== "undefined" && window.__GATE_BYPASS__); }
function gateHeaders(){ return gateToken ? { "Authorization": "Bearer " + gateToken } : {}; }
function gateReadExp(tok){ try{ const p = JSON.parse(atob(tok.split(".")[0].replace(/-/g,"+").replace(/_/g,"/"))); return (p && typeof p.exp === "number") ? p.exp : 0; }catch(e){ return 0; } }
function gateValid(){ return !!gateToken && gateReadExp(gateToken) > Math.floor(Date.now()/1000); }
function gateStore(tok){ gateToken = tok; try{ localStorage.setItem("syn5:gate", tok); }catch(e){} }
function gateClear(){ gateToken = null; try{ localStorage.removeItem("syn5:gate"); }catch(e){} }
let _gateLocking = false;
/* Missing/invalid/expired token → drop the app and return to the sign-in gate. */
function gateLock(msg){
  if (_gateLocking) return; _gateLocking = true;
  gateClear();
  try{ localStorage.removeItem("syn5:session"); }catch(e){}
  const app = document.getElementById("app"); if (app) app.classList.remove("on");
  hideSite();
  showAuth("signin");
  if (msg) authErr(msg);
  setTimeout(() => { _gateLocking = false; }, 50);
}
/* POST the single admin credential to the Worker gate. The Worker does the real check
   (constant-time, rate-limited) and returns a signed token on success. */
async function gateSignIn(email, password){
  try{
    const res = await fetch(cloudBase() + "/gate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });
    if (res.status === 429) return { rateLimited: true };
    if (!res.ok) return { failed: true };
    const j = await res.json().catch(() => null);
    if (!j || !j.token) return { failed: true };
    gateStore(j.token);
    return { ok: true };
  }catch(e){ return { error: true }; }
}
/* From the gated sign-in card back out to the public waitlist. */
function gateToWaitlist(){ const a = document.getElementById("authScreen"); if (a) a.classList.remove("on"); showSite(); goSite("home", "waitlist"); }

/* ---------------- STORAGE ADAPTER (persistent, team-shared) ---------------- */
const mem = {};                       // last-resort fallback
let persistOk = false;
let persistMode = "memory";           // "cloud" (SYN Core) | "shared" (Claude preview) | "device" (browser) | "memory"
let cloudOk = false;                  // set at boot by cloudHealth(); when true, shared data reads/writes go through SYN Core
function lsOk(){
  try{ const k = "__syn_t"; localStorage.setItem(k, "1"); localStorage.removeItem(k); return true; }catch(e){ return false; }
}

/* ----- SYN Core cloud tier: D1-backed KV over GET/PUT /kv/<key> (origin-locked, no auth header) ----- */
function cloudBase(){ return (SYN_CORE_URL && SYN_CORE_URL.startsWith("http")) ? SYN_CORE_URL : ""; }
const _sleep = ms => new Promise(r => setTimeout(r, ms));
async function cloudGet(key){
  // Retry transient failures (network blip, timeout, 5xx/429) so a momentary hiccup never
  // surfaces as "empty". Only a genuine, persistent failure throws — callers decide what to do.
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++){
    try{
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 6000);
      const res = await fetch(cloudBase() + "/kv/" + encodeURIComponent(key), { method:"GET", headers: gateHeaders(), signal: ctl.signal });
      clearTimeout(t);
      if (res.status === 401){ const err = new Error("gate 401"); err.gate401 = true; gateLock("Your access has expired. Sign in again."); throw err; }
      if (!res.ok) throw new Error("cloud get " + res.status);
      const j = await res.json();
      return (j && j.value != null) ? JSON.parse(j.value) : null;   // stored value is a JSON string, exactly like localStorage
    }catch(e){ lastErr = e; if (e.gate401) throw e; if (attempt < 2) await _sleep(350 * (attempt + 1)); }
  }
  throw lastErr || new Error("cloud get failed");
}
async function cloudPut(key, str){
  const res = await fetch(cloudBase() + "/kv/" + encodeURIComponent(key), {
    method:"PUT", headers:{ "Content-Type":"application/json", ...gateHeaders() }, body: JSON.stringify({ value: str })
  });
  if (res.status === 401){ gateLock("Your access has expired. Sign in again."); const err = new Error("gate 401"); err.gate401 = true; throw err; }
  if (!res.ok) throw new Error("cloud put " + res.status);
}
// Serialize writes per key so rapid PUTs to the same key can't overlap or land out of order.
const cloudChain = {};
function cloudWrite(key, str){
  const next = (cloudChain[key] || Promise.resolve()).catch(() => {}).then(() => cloudPut(key, str));
  cloudChain[key] = next;
  return next;
}
async function cloudHealth(){
  if (!cloudBase()) return false;
  try{
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4000);           // never let a dead backend hang boot
    const res = await fetch(cloudBase() + "/", { method:"GET", signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) return false;
    const j = await res.json().catch(() => null);
    return !!(j && j.ok === true);
  }catch(e){ return false; }
}
// One-time: push every shared syn5:* key from localStorage up to cloud when cloud is empty but this device has a workspace.
async function migrateLocalToCloud(){
  if (!lsOk()) return 0;
  let cloudOrgs = null;
  try{ cloudOrgs = await cloudGet("syn5:orgs"); }catch(e){ return 0; }
  if (cloudOrgs && cloudOrgs.length) return 0;              // cloud already has workspaces; never clobber
  let localOrgs = null;
  try{ const v = localStorage.getItem("syn5:orgs"); localOrgs = v ? JSON.parse(v) : null; }catch(e){}
  if (!localOrgs || !localOrgs.length) return 0;            // nothing here to migrate
  const keys = [];
  for (let i = 0; i < localStorage.length; i++){ const k = localStorage.key(i); if (k) keys.push(k); }
  let n = 0;
  for (const k of keys){
    if (!k.startsWith("syn5:")) continue;
    if (k === "syn5:session" || /:(prefs|seen):/.test(k)) continue;   // device-local by design; stays put
    const str = localStorage.getItem(k);
    if (str == null) continue;
    try{ await cloudWrite(k, str); n++; }catch(e){ /* keep the local copy intact on failure */ }
  }
  return n;
}

async function sGet(key, shared = true){
  // Shared data reads from SYN Core when it's live; device-local data (session, per-device prefs) never does.
  if (shared && cloudOk){
    try{ return await cloudGet(key); }
    catch(e){ /* fall through to local so a read never hard-fails on a network blip */ }
  }
  if (window.storage){
    try{ const r = await window.storage.get(key, shared); return r && r.value ? JSON.parse(r.value) : null; }
    catch(e){ return null; }
  }
  if (lsOk()){
    try{ const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; }catch(e){ return null; }
  }
  return mem[key] || null;
}
/* Authoritative read for identity/registry keys (org registry, team rosters). When SYN Core is
   live it MUST come from the cloud — a failure THROWS so callers surface it and retry, and never
   silently fabricate an empty/stale registry (which was making existing users look brand-new and
   re-onboard into a fresh workspace). In device/local mode, local storage is authoritative. */
async function sGetStrict(key){
  if (cloudOk) return await cloudGet(key);   // throws (after retries) on persistent failure
  return await sGet(key, true);
}
async function sSet(key, val, shared = true){
  mem[key] = val;                       // keep the newest value in memory as a safety net
  const str = JSON.stringify(val);
  if (shared && cloudOk){
    try{ await cloudWrite(key, str); return; }
    catch(e){ console.error("cloud save failed, falling back to local", key, e); /* never silently lose: fall through */ }
  }
  if (window.storage){
    try{ await window.storage.set(key, str, shared); }catch(e){ console.error("save fail", key, e); }
    return;
  }
  if (lsOk()){
    try{ localStorage.setItem(key, str); }catch(e){ console.error("save fail", key, e); }
  }
}
const saveTimers = {};
const savePending = {};                 // key -> {getVal, shared} for any debounced write not yet flushed
function saveSoon(key, getVal, shared = true){
  savePending[key] = { getVal, shared };
  clearTimeout(saveTimers[key]);
  saveTimers[key] = setTimeout(() => { delete savePending[key]; sSet(key, getVal(), shared); }, 600);
}
/* Flush every pending debounced write immediately. Called when the tab is hidden or
   is being unloaded so a create/edit made moments earlier is never lost on a quick
   reload or tab close (previously the 500-600ms debounce could drop it). */
function flushPendingWrites(){
  // saveSoon-based writes (chats, brands, integrations, settings, prefs, session …)
  for (const key of Object.keys(savePending)){
    const pend = savePending[key]; delete savePending[key];
    clearTimeout(saveTimers[key]); saveTimers[key] = null;
    try{ sSet(key, pend.getVal(), pend.shared); }catch(e){}
  }
  // collection-based writes (tasks, projects, events, spaces, dms, notifications, assets, folders, profiles, activity)
  if (typeof collDirty !== "undefined"){
    for (const name of Array.from(collDirty)){
      clearTimeout(collTimers[name]);
      const c = coll(name);
      try{ sSet(okey(name), c.cache || [], c.shared); }catch(e){}
      collDirty.delete(name);
    }
  }
}
if (typeof window !== "undefined"){
  // visibilitychange fires reliably before the page is frozen/discarded on mobile and desktop;
  // pagehide covers bfcache + tab close. Both flush so no debounced write is lost.
  document.addEventListener("visibilitychange", () => { if (document.hidden) flushPendingWrites(); });
  window.addEventListener("pagehide", flushPendingWrites);
}

/* ---------------- STATE ---------------- */
let ORGS = [];
let ORG = null;
let TEAM = [];
let BRANDS = [];
let APPROVALS = [];
let SETTINGS = { motion:true };
let CHATS = {};                       // brandId -> array of chats
let currentUser = null;
let activeBrandId = null;
let mode = "copy";
let modelPick = "fast";               // default to the cheap model for general chat; Smart = brand/campaign work
let pendingAtts = [];
let busy = false;
let abortCtl = null;
let editingBrandId = null;
let authMode = "signin";

const MODELS = { smart:"claude-sonnet-4-6", fast:"claude-haiku-4-5-20251001" };
const LOGO = "https://mcusercontent.com/d9f0645acdcd85eb1ee1a8067/images/3d78fc3a-7b5f-d65d-afdf-494ef58e2a4f.png";

/* ---------------- DEFAULT DATA ---------------- */
function defaultBrands(){
  return [
    { id:"halt", name:"HALT Fire", industry:"Fire Safety · Regulated", accent:"#FF6B3D",
      voice:"Bold, direct, protective. Authority without fear-mongering. Short declarative sentences. Speaks like a firefighter, not a marketer. Safety is stated as fact, never hyped.",
      audience:"Homeowners, contractors, facility managers, and distributors who need certified fire protection they can trust.",
      palette:[{hex:"#E8400A",name:"Fire"},{hex:"#B8300A",name:"Ember"},{hex:"#1A1A1A",name:"Char"},{hex:"#FFFFFF",name:"Ash"}],
      products:["Heat Barrier — 32oz pump spray","Pro Defense — professional-grade suppressant line","Fire suppression collateral & SDS documentation"],
      approvedClaims:["UL Classified","Manufactured by Halt Industrial Inc.","513 Main Street, Windermere FL"],
      bannedClaims:["UL Tested","UL Approved","UL Certified","fireproof","guarantees your safety","prevents all fires","FSI","2.5G tote"],
      legal:"All certification language must read exactly 'UL Classified.' Manufacturer is Halt Industrial Inc. (never FSI). No absolute safety guarantees. Product claims must match current SDS sheets.",
      imageStyle:"High-contrast product photography. Charcoal and deep-black environments, dramatic rim lighting, fire-orange accent glow. Industrial, premium, serious. No cartoonish flames, no people in danger, no visible fire touching products.",
      memories:[], knowledge:[] },
    { id:"wavers", name:"Doughbrik's Wavers", industry:"Consumer Snacks · DTC", accent:"#A78BFF",
      voice:"Playful, punchy, internet-native. Big flavor energy, zero corporate speak. Sounds like your funniest friend recommending a snack. Emoji-light, hype-forward, always fun.",
      audience:"Gen Z and young millennial snackers, David Dobrik's audience, DTC impulse buyers.",
      palette:[{hex:"#8A5CF6",name:"Wave Purple"},{hex:"#FFD23F",name:"Crunch Gold"},{hex:"#FF5D8F",name:"Pop Pink"},{hex:"#101014",name:"Night"}],
      products:["Wavers — wavy-cut snack chips, multiple flavors","DTC store bundles & drops"],
      approvedClaims:["From the Doughbrik's universe","Bold wavy crunch"],
      bannedClaims:["healthy","diet","weight loss","guilt-free","better than [competitor]"],
      legal:"No health or nutrition claims of any kind. Celebrity references stay within approved brand language. No comparative superiority claims against named competitors.",
      imageStyle:"Saturated, high-energy product scenes. Bold color blocking with purple and gold, floating chips, dynamic motion, studio-pop lighting. Fun and premium at once. Never muted, never minimal.",
      memories:[], knowledge:[] },
    { id:"karlo", name:"Karlo Financial", industry:"Financial Services · Regulated", accent:"#5FD4B0",
      voice:"Calm, precise, trustworthy. Plain-English explanations of complex things. Warm but never casual. Confidence through clarity, not promises.",
      audience:"Families and business owners planning long-term finances who value a steady, personal advisor relationship.",
      palette:[{hex:"#3E7C6F",name:"Ledger Green"},{hex:"#0E1B18",name:"Vault"},{hex:"#D9CDB8",name:"Parchment"},{hex:"#9AA3B2",name:"Slate"}],
      products:["Financial planning & advisory services","Retirement and long-term strategy engagements"],
      approvedClaims:["Personalized financial guidance","Long-term planning focus"],
      bannedClaims:["guaranteed returns","risk-free","beat the market","double your money","can't lose"],
      legal:"No promises of returns or performance. No specific investment advice in marketing content. All claims must be compliant with financial marketing regulations. Educational framing only.",
      imageStyle:"Quiet, editorial, warm-professional. Natural light, deep greens and parchment tones, real-life planning moments. Trust through calm, never stock-photo handshakes or money imagery.",
      memories:[], knowledge:[] }
  ];
}

/* ---------------- HELPERS ---------------- */
function esc(s){ const d = document.createElement("div"); d.textContent = s == null ? "" : s; return d.innerHTML; }
function toast(msg){
  const w = document.getElementById("toastWrap");
  const t = document.createElement("div");
  t.className = "toast"; t.textContent = msg;
  w.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}
function escHtml(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function uid(p){ return (p || "x") + Date.now().toString(36) + Math.random().toString(36).slice(2,6); }
function brand(){ return BRANDS.find(b => b.id === activeBrandId) || BRANDS[0] || null; }
function isAdmin(){ return currentUser && currentUser.role === "Admin"; }
function hexToSoft(hex){ try{ const n = parseInt(hex.slice(1),16); return "rgba(" + ((n>>16)&255) + "," + ((n>>8)&255) + "," + (n&255) + ",.18)"; }catch(e){ return "rgba(136,136,136,.16)"; } }
function fmtSize(b){ return b > 1048576 ? (b/1048576).toFixed(1)+" MB" : Math.max(1,Math.round(b/1024))+" KB"; }
function extOf(name){ const i = name.lastIndexOf("."); return i < 0 ? "" : name.slice(i+1).toLowerCase(); }
function fmtTime(iso){ const d = new Date(iso); return d.toLocaleDateString([], {month:"short",day:"numeric"}) + " · " + d.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}); }
/* logoFail is defined in <head> so it exists before any image onerror fires */
async function hashPw(pw, salt){
  const s = salt.toLowerCase() + "::" + pw;
  if (window.crypto && crypto.subtle){
    try{
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,"0")).join("");
    }catch(e){}
  }
  let h1 = 5381, h2 = 52711;
  for (let i = 0; i < s.length; i++){ const c = s.charCodeAt(i); h1 = (h1 * 33) ^ c; h2 = (h2 * 31) ^ c; }
  return (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16);
}
function renderMD(text){
  if (window.marked && window.DOMPurify){
    try{ return DOMPurify.sanitize(marked.parse(text, { breaks:true })); }catch(e){}
  }
  return esc(text).replace(/\n/g, "<br>");
}

/* ---------------- PERSISTENCE ---------------- */
function okey(sub){ return "syn5:" + (ORG ? ORG.id : "none") + ":" + sub; }
const saveBrands    = () => saveSoon(okey("brands"), () => BRANDS.map(b => ({ ...b, knowledge: b.knowledge.filter(k => !k.tooBig) })));
const saveTeam      = () => saveSoon(okey("team"), () => TEAM);
const saveApprovals = () => saveSoon(okey("approvals"), () => APPROVALS);
const saveSettings  = () => saveSoon(okey("settings"), () => SETTINGS);
/* Chats split into two physical stores per brand so a member's PRIVATE chats never sit in
   a blob other members read: private chats live under a per-user key; shared chats under a
   shared key. Team visibility is enforced by the key namespace, not by client-side filtering. */
function privChatKey(brandId){ return okey((currentUser ? currentUser.id : "anon") + ":chats:" + brandId); }
function sharedChatKey(brandId){ return okey("shared-chats:" + brandId); }
function stripChat(c){
  return { ...c, msgs: c.msgs.map(m => ({
    ...m,
    atts: (m.atts || []).map(a => (a.data && a.data.length > 400000) ? { kind:a.kind, name:a.name, stub:true } : a)
  })) };
}
function saveChats(brandId){
  const all = CHATS[brandId] || [];
  const uid = currentUser ? currentUser.id : "anon";
  // Defense-in-depth: only chats THIS user owns may be written under this user's private key.
  // A private chat owned by someone else must never be re-filed into the wrong namespace (that
  // was how a visibility toggle by a non-owner orphaned the record for everyone).
  const mine   = all.filter(c => !c.shared && c.ownerId === uid).map(stripChat);
  const shared = all.filter(c =>  c.shared).map(stripChat);           // shared chats visible to the whole workspace
  saveSoon(privChatKey(brandId),  () => mine);
  saveSoon(sharedChatKey(brandId), () => shared);
}
const migratedChats = new Set();
async function migrateChatsBrand(brandId){
  if (migratedChats.has(brandId)) return;
  migratedChats.add(brandId);
  const old = await sGet(okey("chats:" + brandId));                   // legacy single shared blob
  if (!old || !old.length) return;
  // Assign every legacy chat to its ORIGINAL author's private store and expose it to no one else.
  const byOwner = {};
  old.forEach(c => {
    const oid = c.ownerId || (c.ownerName ? (TEAM.find(u => u.name === c.ownerName) || {}).id : null) || currentUser.id;
    (byOwner[oid] = byOwner[oid] || []).push({ ...c, shared:false, ownerId:oid, ownerName:c.ownerName || teamName(oid) });
  });
  for (const oid of Object.keys(byOwner)){
    const key = okey(oid + ":chats:" + brandId);
    const existing = (await sGet(key)) || [];
    if (!existing.length) await sSet(key, byOwner[oid].map(stripChat));
  }
  await sSet(okey("chats:" + brandId), []);                           // clear the legacy blob so it is no longer exposed
}
async function loadChats(brandId){
  if (CHATS[brandId]) return CHATS[brandId];
  await migrateChatsBrand(brandId);
  const mine   = (await sGet(privChatKey(brandId)))   || [];
  const shared = (await sGet(sharedChatKey(brandId))) || [];
  mine.forEach(c => { c.shared = false; if (!c.ownerId && currentUser) c.ownerId = currentUser.id; });
  shared.forEach(c => { c.shared = true; });
  CHATS[brandId] = shared.concat(mine);
  return CHATS[brandId];
}

/* ---------------- BOOT ---------------- */
/* ---------------- PUBLIC MARKETING SITE ROUTING ---------------- */
const SITE_PAGES = ["home","terms","privacy","acceptable-use"];
let _skipHash = false;
function appIsOn(){ return document.getElementById("app").classList.contains("on"); }
function showSite(){ document.getElementById("site").classList.add("on"); document.getElementById("authScreen").classList.remove("on"); document.getElementById("app").classList.remove("on"); initSiteMotion(); if (typeof wireCalc === "function") wireCalc(); }
/* Premium motion layer: staggered reveals, count-up, hero particle field, parallax.
   Presentation only; every path respects prefers-reduced-motion. No libraries. */
let _revObs = null, _fxState = null;
function reduceMotion(){ return window.matchMedia && window.matchMedia("(prefers-reduced-motion:reduce)").matches; }
function initNavScroll(){
  const site = document.getElementById("site");
  const nav = site && site.querySelector(".site-nav");
  if (!site || !nav || site.dataset.navWired) return;
  site.dataset.navWired = "1";
  const on = () => nav.classList.toggle("scrolled", site.scrollTop > 8);
  site.addEventListener("scroll", on, { passive: true });
  on();
}
function initSiteMotion(){
  initNavScroll();
  const reduce = reduceMotion();
  const secs = document.querySelectorAll("#site .site-hero, #site .site-sec, #site .lum-banner, #site .iso-band");
  if (!_revObs && !reduce && "IntersectionObserver" in window){
    _revObs = new IntersectionObserver((entries) => {
      entries.forEach(en => {
        if (!en.isIntersecting) return;
        _revObs.unobserve(en.target);
        // imagery: blur-to-sharp entrance (kept — never removed, so parallax/hover stay live)
        if (en.target.matches(".img-rise")) en.target.classList.add("in");
        en.target.querySelectorAll(".img-rise").forEach(el => el.classList.add("in"));
        en.target.querySelectorAll(".rv").forEach(el => {
          el.classList.add("in");
          const settle = () => { el.classList.remove("rv", "in"); el.style.removeProperty("--rvd"); };
          el.addEventListener("transitionend", settle, { once:true });
          setTimeout(settle, 1500 + (parseInt(el.style.getPropertyValue("--rvd")) || 0));
        });
        en.target.querySelectorAll(".count-up:not(.done)").forEach(runCountUp);
      });
    }, { threshold: 0.1, rootMargin: "0px 0px -6% 0px" });
  }
  secs.forEach(sec => {
    if (sec.dataset.rvWired) return;
    sec.dataset.rvWired = "1";
    /* stagger: headline block first, then supporting text, then cards 70ms apart */
    const groups = [
      sec.querySelectorAll(":scope .sh-badge, :scope .sec-eyebrow"),
      sec.querySelectorAll(":scope .sh-eyebrow, :scope .sh-title, :scope .sec-title, :scope .site-cta-band h2"),
      sec.querySelectorAll(":scope .sh-sub, :scope .sec-sub, :scope .sh-cta, :scope .seat-incl"),
      sec.querySelectorAll(":scope .sh-points, :scope .pillar-card, :scope .cmp-col, :scope .step-card, :scope .proof-card, :scope .seat-tier, :scope .calc, :scope .logo-row, :scope .price-note, :scope .site-cta-band .sh-cta, :scope .hero-preview")
    ];
    let d = 0;
    groups.forEach((g, gi) => g.forEach(el => {
      el.classList.add("rv"); el.style.setProperty("--rvd", Math.min(d, 620) + "ms");
      d += gi < 3 ? 50 : 55;
    }));
    sec.querySelectorAll(".st-rate").forEach(el => el.classList.add("count-up"));
    if (reduce || !_revObs){ sec.querySelectorAll(".rv, .img-rise").forEach(el => el.classList.add("in")); return; }
    _revObs.observe(sec);
  });
  initHeroFx();
  initParallax();
}
/* numbers count up on first view; final text is identical to the static markup */
function runCountUp(el){
  el.classList.add("done");
  const tn = el.firstChild; if (!tn || tn.nodeType !== 3) return;
  const m = /^(\$?)(\d[\d,]*)/.exec(tn.textContent); if (!m) return;
  const pre = m[1], fin = parseInt(m[2].replace(/,/g, ""), 10), t0 = performance.now(), D = 650;
  const iv = setInterval(() => {
    const k = Math.min(1, (performance.now() - t0) / D), e = 1 - Math.pow(1 - k, 3);
    tn.textContent = pre + Math.round(fin * e).toLocaleString("en-US");
    if (k >= 1) clearInterval(iv);
  }, 16);
}
/* slow-drifting field of fine white particles, 3–6% alpha; paused off-screen and when hidden */
function initHeroFx(){
  const cv = document.getElementById("heroFx");
  if (!cv || _fxState || reduceMotion()) return;
  const ctx = cv.getContext("2d"), DPR = Math.min(window.devicePixelRatio || 1, 1.5);
  const st = _fxState = { run:false, raf:0, pts:[], W:0, H:0 };
  function size(){
    const r = cv.parentElement.getBoundingClientRect();
    st.W = cv.width = Math.max(1, Math.round(r.width * DPR));
    st.H = cv.height = Math.max(1, Math.round(r.height * DPR));
    const n = Math.min(90, Math.round(st.W / 24));
    st.pts = Array.from({ length: n }, () => ({
      x: Math.random() * st.W, y: Math.random() * st.H,
      r: (0.5 + Math.random()) * DPR, a: 0.03 + Math.random() * 0.03,
      vx: (Math.random() - .5) * 0.06 * DPR, vy: (Math.random() - .5) * 0.05 * DPR,
      p: Math.random() * 6.2832
    }));
  }
  function tick(){
    if (!st.run) return;
    ctx.clearRect(0, 0, st.W, st.H); ctx.fillStyle = (document.documentElement.dataset.theme === "light") ? "#131313" : "#fff";
    for (const p of st.pts){
      p.x += p.vx; p.y += p.vy; p.p += 0.004;
      if (p.x < -4) p.x = st.W + 4; else if (p.x > st.W + 4) p.x = -4;
      if (p.y < -4) p.y = st.H + 4; else if (p.y > st.H + 4) p.y = -4;
      ctx.globalAlpha = p.a * (0.75 + 0.25 * Math.sin(p.p));
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.2832); ctx.fill();
    }
    ctx.globalAlpha = 1; st.raf = requestAnimationFrame(tick);
  }
  function play(on){ const was = st.run; st.run = on && !document.hidden; if (st.run && !was) st.raf = requestAnimationFrame(tick); }
  size(); window.addEventListener("resize", size);
  new IntersectionObserver(en => play(en[0].isIntersecting), { threshold: 0.01 }).observe(cv);
  document.addEventListener("visibilitychange", () => play(!document.hidden && st.vis !== false));
  play(true);
}
/* Parallax: the product screenshot drifts slower than the page for a subtle depth cue. */
let _parWired = false;
function initParallax(){
  if (_parWired || reduceMotion()) return;
  const site = document.getElementById("site");
  const img = document.querySelector("#sp-home .hero-preview img");
  const hero = document.getElementById("lumHero");
  const heroSec = document.querySelector("#sp-home .site-hero");
  if (!site) return;
  _parWired = true;
  let raf = 0;
  const onScroll = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const y = site.scrollTop;
      if (img) img.style.transform = "translateY(" + Math.min(y * 0.05, 24) + "px)";
      if (hero && heroSec){
        const h = heroSec.offsetHeight || 1;
        const p = Math.min(1, y / h);                 // 0 at top → 1 when hero fully scrolled
        hero.style.transform = "translateY(" + (y * 0.05).toFixed(1) + "px)";   // 5% drift
        hero.style.opacity = (1 - p * 0.9).toFixed(3); // crossfade: dissolves into the next section
      }
    });
  };
  site.addEventListener("scroll", onScroll, { passive: true });
}
function hideSite(){ document.getElementById("site").classList.remove("on"); }
/* Per-route <head> metadata (SEO). The site is hash-routed, so one static head ships with the
   page and this updates title / description / canonical / og:url / og:title / og:description on
   route change — so a JS-running client and the browser tab/history present each public route
   correctly. NOTE: social scrapers do NOT run JS; they read the STATIC head, which is why the
   static head carries the primary (home) values. Only public marketing routes are handled here. */
let _homeMeta = null;
function _metaEl(sel){ return document.head.querySelector(sel); }
function _setMeta(sel, attr, val){ const el = _metaEl(sel); if (el && val != null) el.setAttribute(attr, val); }
function applyRouteMeta(page){
  if (!_homeMeta){                                   // capture the static home values once, before any overwrite
    const g = sel => { const el = _metaEl(sel); return el ? (el.getAttribute("content") || el.getAttribute("href")) : null; };
    _homeMeta = { title: document.title, desc: g('meta[name="description"]'),
      ogTitle: g('meta[property="og:title"]'), ogDesc: g('meta[property="og:description"]') };
  }
  const R = {
    home: { title: _homeMeta.title, desc: _homeMeta.desc, ogTitle: _homeMeta.ogTitle, ogDesc: _homeMeta.ogDesc, path: "/" },
    terms: { title: "Terms of Service · SYN", desc: "The terms that govern use of SYN, a Syntrex product.", path: "/#/terms" },
    privacy: { title: "Privacy Policy · SYN", desc: "How SYN and Syntrex LLC collect, use, and protect your data.", path: "/#/privacy" },
    "acceptable-use": { title: "Acceptable Use Policy · SYN", desc: "What is and isn't allowed when using SYN.", path: "/#/acceptable-use" },
  };
  const r = R[page] || R.home;
  const url = SITE_BASE_URL + r.path;
  document.title = r.title;
  _setMeta('meta[name="description"]', "content", r.desc);
  _setMeta('link[rel="canonical"]', "href", url);
  _setMeta('meta[property="og:url"]', "content", url);
  _setMeta('meta[property="og:title"]', "content", r.ogTitle || r.title);
  _setMeta('meta[property="og:description"]', "content", r.ogDesc || r.desc);
  _setMeta('meta[name="twitter:title"]', "content", r.ogTitle || r.title);
  _setMeta('meta[name="twitter:description"]', "content", r.ogDesc || r.desc);
}
function showSitePage(page, anchor){
  if (!SITE_PAGES.includes(page)) page = "home";
  applyRouteMeta(page);
  document.getElementById("site").classList.add("on");
  document.querySelectorAll(".site-page").forEach(p => p.classList.remove("on"));
  (document.getElementById("sp-" + page) || document.getElementById("sp-home")).classList.add("on");
  const site = document.getElementById("site");
  if (anchor){ const a = document.getElementById("site-" + anchor); requestAnimationFrame(() => { if (a) a.scrollIntoView({ behavior:"smooth", block:"start" }); }); }
  else site.scrollTop = 0;
}
function goSite(page, anchor){
  if (!SITE_PAGES.includes(page)) page = "home";
  showSitePage(page, anchor);
  const target = page === "home" ? "/" : "/" + page;
  if (location.hash.replace(/^#/, "") !== target){ _skipHash = true; location.hash = target; }
}
function routeSite(){
  if (appIsOn()) return;
  const h = (location.hash || "").replace(/^#\/?/, "");
  showSitePage(SITE_PAGES.includes(h) ? h : "home");
}
function siteAuth(mode){ closeSiteMenu(); hideSite(); showAuth(mode); }
/* Floating-header mobile menu */
function toggleSiteMenu(e){ if (e) e.stopPropagation(); const n = document.getElementById("siteNav"); if (!n) return; const open = n.classList.toggle("menu-open"); const btn = n.querySelector(".site-menu-btn"); if (btn) btn.setAttribute("aria-expanded", open ? "true" : "false"); }
function closeSiteMenu(){ const n = document.getElementById("siteNav"); if (!n) return; n.classList.remove("menu-open"); const btn = n.querySelector(".site-menu-btn"); if (btn) btn.setAttribute("aria-expanded", "false"); }
document.addEventListener("click", e => { const n = document.getElementById("siteNav"); if (n && n.classList.contains("menu-open") && !e.target.closest("#siteNav")) closeSiteMenu(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") closeSiteMenu(); });

/* ---------- marketing AI assistant ----------
   Calls the SYN Cloudflare Worker (which holds the API key and the SYN system prompt).
   No key ever lives in this client. Streams the reply; conversation is session-only
   (a plain array, cleared on reload); any failure shows a contact-form fallback,
   never a raw error or a blank panel. */
const SYN_ASSISTANT_URL = "https://syn-assistant.henrybello.workers.dev";
let synAsstHist = [], synAsstBusy = false, synAsstGreeted = false;
function synAsstToggle(){
  const el = document.getElementById("synAsst"); if (!el) return;
  const open = el.classList.toggle("open");
  const launch = document.getElementById("synAsstLaunch"); if (launch) launch.style.display = open ? "none" : "";
  if (open){
    if (!synAsstGreeted){ synAsstGreeted = true; synAsstBubble("bot", "Hi, I'm the SYN assistant. Ask me what SYN does, how pricing works, or anything about the product."); }
    setTimeout(() => { const i = document.getElementById("saInput"); if (i) i.focus(); }, 40);
  }
}
function synAsstFmt(t){
  const esc = s => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  return esc(t).replace(/\n/g,"<br>").replace(/(henry@syntrexio\.com)/g,'<a href="mailto:$1">$1</a>');
}
function synAsstBubble(role, text){
  const b = document.getElementById("saBody"); if (!b) return null;
  const d = document.createElement("div"); d.className = "sa-msg " + (role === "user" ? "user" : "bot");
  d.innerHTML = synAsstFmt(text); b.appendChild(d); b.scrollTop = b.scrollHeight; return d;
}
async function synAsstSend(e){
  if (e) e.preventDefault();
  if (synAsstBusy) return;
  const inp = document.getElementById("saInput"); const text = (inp.value || "").trim(); if (!text) return;
  inp.value = ""; synAsstBubble("user", text); synAsstHist.push({ role:"user", content:text });
  synAsstBusy = true;
  const btn = document.querySelector(".sa-foot button"); if (btn) btn.disabled = true;
  const b = document.getElementById("saBody");
  const typing = document.createElement("div"); typing.className = "sa-typing"; typing.innerHTML = "<i></i><i></i><i></i>";
  b.appendChild(typing); b.scrollTop = b.scrollHeight;
  let botEl = null, acc = "";
  const ensureBot = () => { if (!botEl){ if (typing.parentNode) typing.remove(); botEl = synAsstBubble("bot", ""); } };
  try {
    const res = await fetch(SYN_ASSISTANT_URL, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ messages: synAsstHist, stream:true }) });
    if (!res.ok || !res.body) throw new Error("unreachable");
    const reader = res.body.getReader(), dec = new TextDecoder(); let buf = "";
    for(;;){
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream:true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0){
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const p = line.slice(5).trim(); if (!p || p === "[DONE]") continue;
        try { const ev = JSON.parse(p);
          if (ev.type === "content_block_delta" && ev.delta && ev.delta.text){ ensureBot(); acc += ev.delta.text; botEl.innerHTML = synAsstFmt(acc); b.scrollTop = b.scrollHeight; }
        } catch(_){}
      }
    }
    if (!acc) throw new Error("empty");
    synAsstHist.push({ role:"assistant", content:acc });
  } catch(err){
    if (typing.parentNode) typing.remove();
    if (acc){ synAsstHist.push({ role:"assistant", content:acc }); }
    else { synAsstBubble("bot", "I can't reach the assistant right now. Email henry@syntrexio.com or use the contact form on this page and we'll get right back to you."); }
  } finally {
    synAsstBusy = false; if (btn) btn.disabled = false;
    const i = document.getElementById("saInput"); if (i) i.focus();
  }
}
document.addEventListener("keydown", e => { if (e.key === "Escape"){ const el = document.getElementById("synAsst"); if (el && el.classList.contains("open")) synAsstToggle(); } });
document.addEventListener("click", e => { const el = document.getElementById("synAsst"); if (el && el.classList.contains("open") && !e.target.closest("#synAsst") && !e.target.closest("#synAsstLaunch")) synAsstToggle(); });
/* Contact form → Formspree. Native validation gates required fields; on success the
   form is replaced in place with a confirmation panel; on failure an inline hairline
   error points to email. No alert() dialogs. The hidden source=SYN + _subject fields
   distinguish these from syntrexio.com leads in the shared Formspree inbox. */
async function synContactSubmit(e){
  e.preventDefault();
  const form = e.target;
  const btn = form.querySelector(".cf-submit");
  const err = document.getElementById("cfError");
  err.style.display = "none";
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = "Sending…";
  try {
    const res = await fetch("https://formspree.io/f/xkopyzln", {
      method: "POST",
      body: new FormData(form),
      headers: { "Accept": "application/json" }
    });
    if (!res.ok) throw new Error("bad status " + res.status);
    form.style.display = "none";
    document.getElementById("cfDone").style.display = "block";
  } catch (_) {
    btn.disabled = false; btn.textContent = label;
    err.style.display = "block";
  }
}
/* Waitlist form → same Formspree endpoint as contact, but with a hidden
   source=SYN_WAITLIST field (set in the markup) so signups are distinguishable
   from contact-form leads in the shared inbox. Same UX as synContactSubmit:
   native validation gates the required email, success replaces the form in place
   with the confirmation panel, failure shows an inline hairline error pointing to
   email. No alert() dialogs. Until syn-growth exists, Formspree is the store. */
async function synWaitlistSubmit(e){
  e.preventDefault();
  const form = e.target;
  const btn = form.querySelector(".cf-submit");
  const err = document.getElementById("wlError");
  err.style.display = "none";
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = "Joining…";
  try {
    const res = await fetch("https://formspree.io/f/xkopyzln", {
      method: "POST",
      body: new FormData(form),
      headers: { "Accept": "application/json" }
    });
    if (!res.ok) throw new Error("bad status " + res.status);
    form.style.display = "none";
    document.getElementById("wlDone").style.display = "block";
  } catch (_) {
    btn.disabled = false; btn.textContent = label;
    err.style.display = "block";
  }
}
function backToSite(){ document.getElementById("authScreen").classList.remove("on"); showSite(); routeSite(); }
window.addEventListener("hashchange", () => { if (appIsOn()) return; if (_skipHash){ _skipHash = false; return; } routeSite(); });

async function boot(){
  loadThemePref();
  cloudOk = await cloudHealth();
  if (cloudOk){
    persistMode = "cloud"; persistOk = true;
    try{ localStorage.setItem("syn5:cloudSeen", "1"); }catch(e){}   // remember this device has reached SYN Core
    try{ const moved = await migrateLocalToCloud(); if (moved) console.log("SYN Core: migrated " + moved + " local key(s) to the cloud."); }catch(e){}
  } else {
    // If SYN Core is configured AND this device has reached it before, its data lives in the cloud —
    // do NOT silently drop to device mode and offer a fresh workspace during an outage. Block + retry.
    let seen = false; try{ seen = localStorage.getItem("syn5:cloudSeen") === "1"; }catch(e){}
    if (cloudBase() && seen) return bootCloudError();
    persistMode = window.storage ? "shared" : (lsOk() ? "device" : "memory");
    persistOk = persistMode !== "memory";
  }
  const pill = document.getElementById("storagePill");
  pill.textContent = persistMode === "cloud" ? "Synced" : persistMode === "shared" ? "Saved" : persistMode === "device" ? "This Device" : "Session";
  pill.className = "storage-pill " + (persistOk ? "ok" : "no");
  pill.title = persistMode === "cloud" ? "Synced to SYN Core. Everything is saved to the cloud and shared with your team across devices."
    : persistMode === "shared" ? "Team workspace storage is live. Everything persists and is shared."
    : persistMode === "device" ? "Saved to this browser only. SYN Core wasn't reachable, so cross-device team sync is off right now."
    : "Storage unavailable; this session is in-memory only.";

  // ACCESS GATE (temporary — see the gate block up top): with real SYN Core, every /kv read
  // needs a valid token. Without one, don't attempt token-gated reads (they'd 401) — the public
  // marketing site stays open and Sign In routes to the gate. Registry + session load only after
  // the gate passes (in authSubmit). Prompt 26 replaces this.
  if (gateActive() && !gateValid()){
    document.getElementById("bootScreen").classList.remove("on");
    showSite(); routeSite();
    return;
  }

  // Registry is identity-critical: never fabricate an empty one from a failed cloud read.
  try{ ORGS = (await sGetStrict("syn5:orgs")) || []; }
  catch(e){ return bootCloudError(); }
  document.getElementById("bootScreen").classList.remove("on");

  const sess = await sGet("syn5:session", false);
  if (sess && sess.orgId){
    const org = ORGS.find(o => o.id === sess.orgId);
    if (org){
      let team;
      try{ team = (await sGetStrict("syn5:" + org.id + ":team")) || []; }
      catch(e){ return bootCloudError(); }   // logged-in user + unreachable cloud: block+retry, don't dump to marketing
      const u = team.find(t => t.id === sess.userId);
      if (u){ await enterOrg(org, u); return; }
    }
    // session's org/user was readable but is genuinely gone -> stale session, fall through to the site
  }
  showSite(); routeSite();     // logged-out visitors land on the public marketing site
}
// SYN Core is live but unreachable right now: block on a retry screen. Never sign an existing user
// out to the marketing site (where they'd re-onboard) and never proceed with an empty registry.
function bootCloudError(){
  const bs = document.getElementById("bootScreen");
  bs.classList.add("on");
  bs.innerHTML = '<div style="text-align:center;max-width:360px;padding:0 24px">' +
    synMark(86, 'boot-mark') +
    '<div class="boot-txt" style="margin-top:16px">Can’t reach SYN Core right now.</div>' +
    '<div style="font-size:13px;color:var(--muted);line-height:1.6;margin:10px 0 20px">Your workspace is safe in the cloud. We won’t sign you in until we can load it, so nothing is lost or duplicated.</div>' +
    '<button class="site-btn gold" id="bootRetry">Retry</button></div>';
  const btn = document.getElementById("bootRetry");
  if (btn) btn.addEventListener("click", () => { bs.innerHTML = '<div>' + synMark(86, 'boot-mark') + '<div class="boot-txt">Reconnecting…</div></div>'; boot(); });
  // also auto-retry a few times in the background
  if (!bootCloudError._tries) bootCloudError._tries = 0;
  if (bootCloudError._tries < 4){ bootCloudError._tries++; setTimeout(() => { if (document.getElementById("bootScreen").classList.contains("on")) boot(); }, 3000); }
}

/* ---------------- WORKSPACE JOIN CODES (rotate every 30 min) ---------------- */
function orgCode(org, offset = 0){
  const win = Math.floor(Date.now() / 1800000) + offset;
  const s = org.secret + ":" + win;
  let h1 = 2166136261, h2 = 40503;
  for (let i = 0; i < s.length; i++){ const c = s.charCodeAt(i); h1 = ((h1 ^ c) * 16777619) >>> 0; h2 = ((h2 * 31) + c) >>> 0; }
  const A = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let code = "", n = (h1 ^ h2) >>> 0;
  for (let i = 0; i < 6; i++){ code += A[n % A.length]; n = Math.floor(n / A.length) + ((h2 >> i) & 255); }
  return code;
}
function codeMinutesLeft(){ return Math.max(1, Math.ceil((1800000 - (Date.now() % 1800000)) / 60000)); }

/* ---------------- AUTH ---------------- */
function showAuth(m){
  // ACCESS GATE (temporary): while the gate is on, only the single-admin Sign In exists.
  // The New Workspace and Join Team tabs — the public routes into workspace creation — are
  // hidden entirely, and any attempt to open them is coerced back to Sign In. Prompt 26 removes this.
  const gated = gateActive();
  if (gated) m = "signin";
  authMode = m;
  const f = document.getElementById("authFields");
  const sub = document.getElementById("authSub");
  const btn = document.getElementById("authBtn");
  const sw = document.getElementById("authSwitch");
  const tabs = document.getElementById("authTabs");
  document.getElementById("authErr").style.display = "none";
  tabs.innerHTML = gated ? "" :
    ('<button class="mode-btn ' + (m === "signin" ? "active" : "") + '" onclick="showAuth(\'signin\')">Sign In</button>' +
    '<button class="mode-btn ' + (m === "create" ? "active" : "") + '" onclick="showAuth(\'create\')">New Workspace</button>' +
    '<button class="mode-btn ' + (m === "join" ? "active" : "") + '" onclick="showAuth(\'join\')">Join Team</button>');
  if (m === "create"){
    sub.textContent = "Start your company workspace";
    f.innerHTML = '<input class="f-input" id="aCompany" placeholder="Company name"><input class="f-input" id="aName" placeholder="Your full name"><input class="f-input" id="aEmail" placeholder="Work email" autocomplete="off"><input class="f-input" id="aPass" type="password" placeholder="Create a password">';
    btn.textContent = "Create Workspace";
    sw.innerHTML = "You become the workspace Admin. Your team joins with your live team code.";
  } else if (m === "join"){
    sub.textContent = "Join your company workspace";
    f.innerHTML = '<input class="f-input" id="aCode" placeholder="Team code (from your admin)" autocomplete="off" style="text-transform:uppercase;letter-spacing:.2em"><input class="f-input" id="aName" placeholder="Your full name"><input class="f-input" id="aEmail" placeholder="Work email" autocomplete="off"><input class="f-input" id="aPass" type="password" placeholder="Create a password">';
    btn.textContent = "Join Workspace";
    sw.innerHTML = "The team code rotates every 30 minutes. Get the current one from your workspace admin.";
  } else {
    sub.textContent = gated ? "Private beta" : "Welcome back";
    f.innerHTML = '<input class="f-input" id="aEmail" placeholder="Work email" autocomplete="off"><input class="f-input" id="aPass" type="password" placeholder="Password">';
    btn.textContent = "Sign In";
    sw.innerHTML = gated
      ? 'SYN is in private beta: <button onclick="gateToWaitlist()">join the waitlist</button> for access.'
      : '<button onclick="forgotInfo()">Forgot password?</button>';
  }
  document.getElementById("authScreen").classList.add("on");
  f.querySelectorAll("input").forEach(i2 => i2.addEventListener("keydown", e => { if (e.key === "Enter") authSubmit(); }));
}
function forgotInfo(){
  const e = document.getElementById("authErr");
  e.textContent = "Ask your workspace Admin to reset your password from Settings → Team. Email reset links arrive with SYN Core.";
  e.style.display = "block"; e.style.color = "var(--gold)";
}
function authErr(msg){ const e = document.getElementById("authErr"); e.style.color = "var(--bad)"; e.textContent = msg; e.style.display = "block"; }

async function authSubmit(){
  const val = id => { const el = document.getElementById(id); return el ? el.value : ""; };
  const em = val("aEmail").trim().toLowerCase();
  const pass = val("aPass");
  if (!em) return authErr("Enter your email.");
  if (!pass) return authErr("Enter your password.");

  // ACCESS GATE (temporary): when on, the Worker validates the single admin credential FIRST and
  // issues the token that unlocks every data request. Only signin exists while gated. On success we
  // then locate the workspace by email — the gate already proved identity, so no second password.
  // Prompt 26 replaces this with real per-user auth.
  if (gateActive()){
    const btn = document.getElementById("authBtn");
    const lbl = btn ? btn.textContent : "";
    if (btn){ btn.disabled = true; btn.textContent = "Checking…"; }
    const g = await gateSignIn(em, pass);
    if (btn){ btn.disabled = false; btn.textContent = lbl; }
    if (g.rateLimited) return authErr("Too many attempts. Wait a few minutes and try again.");
    if (!g.ok) return authErr("Access is restricted. SYN is in private beta. Join the waitlist for access.");
    let orgs;
    try{ orgs = (await sGetStrict("syn5:orgs")) || []; }
    catch(e){ return authErr("Signed in, but couldn’t reach SYN Core to load your workspace. Try again."); }
    ORGS = orgs;
    for (const org of ORGS){
      let team;
      try{ team = (await sGetStrict("syn5:" + org.id + ":team")) || []; }
      catch(e){ return authErr("Signed in, but couldn’t load your workspace. Try again."); }
      const u = team.find(t => (t.email || "").trim().toLowerCase() === em);
      if (u){ await sSet("syn5:session", { orgId: org.id, userId: u.id }, false); await enterOrg(org, u); return; }
    }
    return authErr("Access granted, but no workspace is set up for this account yet. Contact henry@syntrexio.com.");
  }

  // Always work from the latest workspace registry (cloud when live) so sign-in and join
  // see workspaces created in another browser, not just whatever was loaded at boot.
  // Identity-critical: a failed cloud read must surface as "retry", never as an empty registry
  // that makes an existing user look brand-new.
  try{ ORGS = (await sGetStrict("syn5:orgs")) || []; }
  catch(e){ return authErr("Couldn’t reach SYN Core to verify your account. Check your connection and try again. Your workspace is safe."); }

  if (authMode === "signin"){
    for (const org of ORGS){
      let team;
      try{ team = (await sGetStrict("syn5:" + org.id + ":team")) || []; }
      catch(e){ return authErr("Couldn’t reach SYN Core to verify your account. Check your connection and try again. Your workspace is safe."); }
      const u = team.find(t => (t.email || "").trim().toLowerCase() === em);
      if (u && (await hashPw(pass, em)) === u.pwHash){
        await sSet("syn5:session", { orgId: org.id, userId: u.id }, false);
        await enterOrg(org, u); return;
      }
    }
    return authErr("No match for that email and password. Check both, or create or join a workspace.");
  }

  const name = val("aName").trim();
  if (!name) return authErr("Enter your name.");
  if (pass.length < 4) return authErr("Password needs at least 4 characters.");

  if (authMode === "create"){
    const company = val("aCompany").trim();
    if (!company) return authErr("Enter your company name.");
    const org = { id: uid("o"), name: company, secret: uid("s") + Math.random().toString(36).slice(2) + Date.now().toString(36), createdAt: new Date().toISOString(), seats: DEFAULT_SEATS, pricingModel: "per-seat", legacy: false };
    ORGS.push(org);
    await sSet("syn5:orgs", ORGS);
    const u = { id: uid("u"), name, email: em, pwHash: await hashPw(pass, em), role: "Admin", createdAt: new Date().toISOString() };
    await sSet("syn5:" + org.id + ":team", [u]);
    await sSet("syn5:session", { orgId: org.id, userId: u.id }, false);
    await enterOrg(org, u); return;
  }

  if (authMode === "join"){
    const code = val("aCode").trim().toUpperCase();
    if (!code) return authErr("Enter your team code.");
    const org = ORGS.find(o => orgCode(o, 0) === code || orgCode(o, -1) === code);
    if (!org) return authErr("That team code isn't valid right now. Codes rotate every 30 minutes; get the current one from your admin.");
    let team;
    try{ team = (await sGetStrict("syn5:" + org.id + ":team")) || []; }
    catch(e){ return authErr("Couldn’t reach SYN Core to join right now. Check your connection and try again."); }   // never overwrite the roster from an empty read
    if (team.find(t => (t.email || "").trim().toLowerCase() === em)) return authErr("That email already has an account in " + org.name + ". Sign in instead.");
    // Seat enforcement (non-legacy workspaces): admitting past the paid seat count is blocked.
    const paidSeats = (typeof org.seats === "number") ? org.seats : DEFAULT_SEATS;
    if (!org.legacy && org.pricingModel !== "legacy" && team.length >= paidSeats){
      return authErr(org.name + " is at its seat limit (" + team.length + " of " + paidSeats + " seats used). Ask a workspace admin to add a seat in Settings › Billing, then try again.");
    }
    const u = { id: uid("u"), name, email: em, pwHash: await hashPw(pass, em), role: "Member", createdAt: new Date().toISOString() };
    team.push(u);
    await sSet("syn5:" + org.id + ":team", team);
    await sSet("syn5:session", { orgId: org.id, userId: u.id }, false);
    await enterOrg(org, u); return;
  }
}
async function signOut(){
  await sSet("syn5:session", {}, false);
  location.reload();
}

async function enterOrg(org, u){
  ORG = org;
  currentUser = u;
  TEAM      = (await sGet(okey("team"))) || [u];
  BRANDS    = (await sGet(okey("brands"))) || [];
  APPROVALS = (await sGet(okey("approvals"))) || [];
  SETTINGS  = (await sGet(okey("settings"))) || { motion:true };
  BRANDS.forEach(b => { b.memories = b.memories || []; b.knowledge = b.knowledge || []; });
  CHATS = {};
  document.body.classList.toggle("no-motion", SETTINGS.motion === false);

  document.getElementById("authScreen").classList.remove("on");
  hideSite();
  document.getElementById("app").classList.add("on");
  document.getElementById("orgName").textContent = org.name;
  document.getElementById("obOrg").textContent = org.name;
  document.getElementById("uName").textContent = u.name;
  document.getElementById("uRole").textContent = u.role + " · " + org.name;
  document.getElementById("uAvatar").textContent = u.name.split(" ").map(w => w[0]).join("").slice(0,2).toUpperCase();
  document.getElementById("uAvatar").dataset.uid = u.id;
  document.getElementById("addBrandBtn").disabled = !isAdmin();
  document.getElementById("obText").textContent = isAdmin()
    ? "Set up your brand: SYN can research your company on the web and fill in your voice, colors, products, and guardrails automatically. From then on, everything your team makes here ships on-brand."
    : "No brands are encoded yet. Your workspace Admin can encode the first brand, then everything your team makes here ships on-brand.";
  document.getElementById("obAddBrand").style.display = isAdmin() ? "inline-block" : "none";

  await loadTeamChat();

  await loadWorkspaceData();
  await loadSeen();
  await loadPrefs();
  await loadIntegrations();
  await loadUsage();
  if (markLegacyIfNeeded(ORG)) await persistOrg();   // grandfather any pre-pricing workspace: no seat lock, no throttle
  await initSpaces();
  wireWorkspaceBus();
  refreshMyAvatar();
  applyPersonalAccent();
  renderProjectsNav();
  renderBell();
  updateTasksBadge();
  updateSpacesBadge();
  updateOpsBadges();
  checkDueSoon();
  startWorkspacePoll();
  startSpacePoll();
  loadShellPrefs();                       // restore collapsed-sidebar choice
  checkDueSoon();                         // surface due-soon / overdue task reminders on load
  renderBell();

  refreshFraming();
  if (BRANDS.length){ activeBrandId = BRANDS[0].id; await selectBrand(activeBrandId); }
  else { activeBrandId = null; renderBrands(); renderChatList(); renderThread(); }
  setView("myday");
}

