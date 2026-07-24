/* ============================================================
   js/04-pricing-brand.js — per-seat pricing state, pooled + per-user AI usage, per-user DAILY caps + overrides, the live marketing pricing calculator, the admin Billing section, the BRAND MODAL, brand research auto-fill, and the INTEGRATIONS UI.
   MOVE, not a refactor: a byte-identical slice of the original inline <script>.
   Order-dependent. Loads after 03-assets-ops.js and before 05-settings-data.js. Shared global
   scope, not a module. Do not reorder these tags.
   ============================================================ */
/* ===================================================================
   AI COST CONTROL — one config block (steps 4-6 of the cost audit).
   Every AI-consuming feature is metered against a per-user DAILY cap.
   =================================================================== */
// Per-user, per-day hard caps on API-consuming features only. Non-AI work is never capped.
const AI_DAILY_CAPS = { fast: 50, smart: 10, image: 5, parse: 5 };
// Human labels for the four capped feature classes.
const AI_CAP_LABELS = { fast: "fast messages", smart: "smart messages", image: "image generations", parse: "transcript parses" };
// Max output tokens per feature — a task parse doesn't need 8000 (step 3). Central + self-documenting.
const AI_MAX_TOKENS = { chat: 4000, space: 3000, plan_tasks: 900, plan_day: 900, research: 2500, parse: 1200, recap: 700 };
// History windows (input trim): the AI space used to replay its ENTIRE thread on every call — a real cost bug.
const SPACE_HISTORY_WINDOW = 12;
// Estimated $/call at current pricing (Haiku $1/$5, Sonnet $3/$15 per MTok, cache reads ~0.1x),
// measured POST-optimization. The live cost meter multiplies real per-type call counts by these.
const AI_COST_EST = { fast_msg: 0.004, smart_msg: 0.024, space: 0.020, plan_tasks: 0.008, plan_day: 0.003, research: 0.045, parse: 0.002, recap: 0.0015, image: 0.040 };
const AI_COST_LABELS = { fast_msg: "Fast chat", smart_msg: "Smart chat", space: "AI space", plan_tasks: "Task planner", plan_day: "Plan my day", research: "Brand research", parse: "Transcript parse", recap: "Weekly recap", image: "Image generation" };
// Non-interactive generation that can move to the Batch API later for ~50% off.
const AI_BATCH_ELIGIBLE = { recap: true };

function seatRate(seats){ seats = Math.max(1, seats || 1); if (seats >= 25) return SEAT_PRICE.s25; if (seats >= 10) return SEAT_PRICE.s10; return SEAT_PRICE.s1; }
function priceFor(seats, brands){
  seats = Math.max(1, Math.floor(seats || 1)); brands = Math.max(1, Math.floor(brands || 1));
  const rate = seatRate(seats), seatCost = rate * seats, extraBrands = brands - 1, brandCost = extraBrands * BRAND_PRICE;
  return { seats, brands, rate, seatCost, extraBrands, brandCost, total: seatCost + brandCost };
}
function nextThreshold(seats){ seats = Math.max(1, seats || 1); if (seats < 10) return { at: 10, rate: SEAT_PRICE.s10 }; if (seats < 25) return { at: 25, rate: SEAT_PRICE.s25 }; return null; }
// What the next volume break saves, measured at the threshold seat count vs the current bracket rate.
function thresholdSavings(seats){ const nt = nextThreshold(seats); if (!nt) return null; const cur = seatRate(seats); return { at: nt.at, rate: nt.rate, saving: (cur - nt.rate) * nt.at }; }
function fmtMoney(n){ return "$" + Math.round(n).toLocaleString(); }
// Small-dollar formatter for the AI cost meter: cents-precision under $100, whole dollars above.
function fmtSpend(n){ n = n || 0; if (n === 0) return "$0.00"; if (n < 100) return "$" + n.toFixed(2); return "$" + Math.round(n).toLocaleString(); }

/* ---- workspace pricing state (seats, legacy grandfather flag) ---- */
function orgSeats(){ return (ORG && typeof ORG.seats === "number") ? ORG.seats : DEFAULT_SEATS; }
function seatsUsed(){ return (TEAM || []).length; }
function brandCount(){ return Math.max(1, (BRANDS || []).length || 1); }
function isLegacyOrg(o){ o = o || ORG; return !!(o && o.legacy); }
// A workspace with no pricingModel marker predates this change: grandfather it (no seat lock, no throttle).
function markLegacyIfNeeded(o){ if (o && o.pricingModel === undefined && o.legacy === undefined){ o.legacy = true; o.pricingModel = "legacy"; return true; } return false; }
async function persistOrg(){
  if (!ORG) return;
  // Read the live registry authoritatively. If the cloud can't be read, ABORT rather than
  // overwrite the registry with an empty/stale list (which could wipe every org). Also never
  // drop the current org from the list.
  let all;
  try{ all = (await sGetStrict("syn5:orgs")) || []; }
  catch(e){ console.error("persistOrg: registry unreachable, skipping write to avoid clobbering it"); return; }
  const i = all.findIndex(o => o.id === ORG.id);
  if (i >= 0) all[i] = Object.assign({}, all[i], { seats: ORG.seats, legacy: ORG.legacy, pricingModel: ORG.pricingModel });
  else all.push(ORG);   // registry lost track of this org somehow: re-add it, never leave it out
  ORGS = all; await sSet("syn5:orgs", all);
}
function seatLimitReached(){ return !isLegacyOrg() && seatsUsed() >= orgSeats(); }

/* ---- AI usage: per-workspace + per-user, pooled, monthly ---- */
let USAGE = null;
function usagePeriod(){ const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0"); }
function usageKey(){ return okey("usage:" + usagePeriod()); }
async function loadUsage(){ USAGE = (await sGet(usageKey())) || { period: usagePeriod(), byUser: {} }; normalizeUsage(); }
function normalizeUsage(){ if (!USAGE) USAGE = { period: usagePeriod(), byUser:{} }; if (!USAGE.byUser) USAGE.byUser = {}; if (!USAGE.daily) USAGE.daily = {}; if (!USAGE.calls) USAGE.calls = {}; }
function saveUsage(){ if (USAGE) saveSoon(usageKey(), () => USAGE); }
function recordAI(kind, uid){
  normalizeUsage();
  uid = uid || (currentUser && currentUser.id); if (!uid) return;
  const u = USAGE.byUser[uid] = USAGE.byUser[uid] || { standard:0, smart:0, image:0, parse:0 };
  u[kind] = (u[kind] || 0) + 1;
  saveUsage();
  if (isAdmin()) maybeWarnUsage(kind);
}
function pooledUsed(kind){ let n = 0; if (USAGE && USAGE.byUser) Object.values(USAGE.byUser).forEach(u => n += (u[kind] || 0)); return n; }
function pooledAllowance(kind){ return AI_ALLOWANCE[kind] * Math.max(orgSeats(), seatsUsed()); }   // pool scales with paid seats
function usageRatio(kind){ const a = pooledAllowance(kind); return a ? pooledUsed(kind) / a : 0; }
function anyPoolWarn(){ return !isLegacyOrg() && Object.keys(AI_ALLOWANCE).some(k => usageRatio(k) >= 0.8); }
function poolExhausted(kind){ return !isLegacyOrg() && usageRatio(kind) >= 1; }
let _usageWarned = {};
function maybeWarnUsage(kind){
  if (isLegacyOrg()) return;
  const r = usageRatio(kind);
  if (r >= 1 && !_usageWarned[kind + ":100"]){ _usageWarned[kind + ":100"] = 1; toast("Workspace " + AI_LABELS[kind].toLowerCase() + " allowance reached — SYN keeps working on a soft throttle. Add seats in Settings › Billing to lift it."); }
  else if (r >= 0.8 && r < 1 && !_usageWarned[kind + ":80"]){ _usageWarned[kind + ":80"] = 1; toast("Heads up: the workspace has used " + Math.round(r*100) + "% of its " + AI_LABELS[kind].toLowerCase() + " for this period."); }
}

/* ---- Per-user DAILY caps (step 4) + per-workspace overrides (step 5) + cost tracking (step 6) ---- */
// Effective daily cap for a feature; a paid tier can raise it per workspace via ORG.aiCaps (AI credits).
function dailyCap(kind){
  const base = AI_DAILY_CAPS[kind] || 0;
  const over = ORG && ORG.aiCaps && typeof ORG.aiCaps[kind] === "number" ? ORG.aiCaps[kind] : null;
  return over != null ? Math.max(base, over) : base;   // overrides only ever raise the ceiling
}
function dailyBucket(uid){
  normalizeUsage();
  const day = todayISO();
  // keep only today's bucket set — daily counts reset at midnight and old days are pruned
  Object.keys(USAGE.daily).forEach(d => { if (d !== day) delete USAGE.daily[d]; });
  const d = USAGE.daily[day] = USAGE.daily[day] || {};
  return d[uid] = d[uid] || { fast:0, smart:0, image:0, parse:0 };
}
function dailyUsed(kind, uid){ uid = uid || (currentUser && currentUser.id); if (!uid) return 0; const day = (USAGE && USAGE.daily && USAGE.daily[todayISO()]) || {}; return (day[uid] && day[uid][kind]) || 0; }
function dailyExhausted(kind, uid){ return dailyUsed(kind, uid) >= dailyCap(kind); }
function recordDaily(kind, uid){ uid = uid || (currentUser && currentUser.id); if (!uid || !kind) return; const b = dailyBucket(uid); b[kind] = (b[kind] || 0) + 1; saveUsage(); }
function recordCost(callType){ if (!callType) return; normalizeUsage(); USAGE.calls[callType] = (USAGE.calls[callType] || 0) + 1; saveUsage(); }
function estMonthSpend(){ normalizeUsage(); let d = 0; Object.keys(USAGE.calls).forEach(k => d += (USAGE.calls[k] || 0) * (AI_COST_EST[k] || 0)); return d; }
const CAP_MSG = "You've used today's AI allowance, resets at midnight; everything else keeps working.";

/* Unified gate for every AI-consuming call. capKind ∈ {fast,smart,image,parse}; callType keys AI_COST_EST.
   Order: (1) per-user DAILY hard cap — a real cost firewall, applies to every workspace; (2) pooled MONTHLY
   soft throttle (legacy workspaces exempt); then record daily + monthly + cost. NEVER silently fails. */
function gateAI(capKind, callType){
  const monthlyKind = capKind === "fast" ? "standard" : capKind;   // monthly ledger uses "standard" for fast
  callType = callType || (capKind === "fast" ? "fast_msg" : capKind === "smart" ? "smart_msg" : capKind);
  // (1) daily hard cap — enforced for AI features only; everything non-AI is untouched
  if (dailyExhausted(capKind)){
    return { ok:false, capped:true, reason:"You've used today's " + (AI_CAP_LABELS[capKind] || "AI") + " allowance (" + dailyCap(capKind) + "/day). " + CAP_MSG };
  }
  // (2) pooled monthly logic (unchanged behavior; legacy exempt from throttle)
  if (isLegacyOrg()){ recordDaily(capKind); recordAI(monthlyKind); recordCost(callType); return { ok:true }; }
  if (capKind === "image" && poolExhausted("image")){
    return { ok:false, reason:"Your workspace has used all " + pooledAllowance("image") + " image generations for this period. Image generation is paused until the period resets or you add seats in Settings › Billing. Text and brand replies still work." };
  }
  if (capKind === "smart" && poolExhausted("smart")){
    recordDaily("fast"); recordAI("standard"); recordCost("fast_msg");   // soft throttle: runs on the standard model
    return { ok:true, downgrade:true, reason:"Smart / brand-message allowance is used up for this period, so SYN answered on the standard model. Add seats in Settings › Billing to restore brand-smart replies." };
  }
  recordDaily(capKind); recordAI(monthlyKind); recordCost(callType);
  return { ok:true };
}

/* ---- marketing pricing calculator (live) ---- */
function updateCalc(){
  const si = document.getElementById("calcSeats"), bi = document.getElementById("calcBrands");
  if (!si || !bi) return;
  let seats = Math.max(1, Math.floor(+si.value || 1)), brands = Math.max(1, Math.floor(+bi.value || 1));
  const price = priceFor(seats, brands);
  const el = id => document.getElementById(id);
  el("calcTotal").textContent = fmtMoney(price.total);
  el("calcRate").textContent = fmtMoney(price.rate) + " per seat · " + seats + " seat" + (seats===1?"":"s");
  el("calcBreakdown").innerHTML = seats + " × " + fmtMoney(price.rate) + " = " + fmtMoney(price.seatCost) + (price.brandCost ? " &nbsp;+&nbsp; " + price.extraBrands + " extra brand" + (price.extraBrands===1?"":"s") + " × " + fmtMoney(BRAND_PRICE) + " = " + fmtMoney(price.brandCost) : " &nbsp;·&nbsp; 1 brand included");
  const sv = thresholdSavings(seats);
  el("calcSave").innerHTML = sv
    ? '<span class="cs-tag">Volume break</span> At <b>' + sv.at + ' seats</b> every seat is <b>' + fmtMoney(sv.rate) + '</b> — about <b>' + fmtMoney(sv.saving) + '/mo</b> less than ' + sv.at + ' seats at ' + fmtMoney(price.rate) + '.'
    : '<span class="cs-tag">Best rate</span> You are at the lowest per-seat rate (' + fmtMoney(price.rate) + ').';
}
function wireCalc(){
  const c = document.getElementById("pricingCalc"); if (!c || c._wired) return; c._wired = true;
  c.addEventListener("click", e => { const b = e.target.closest("[data-calc]"); if (!b) return; const inp = document.getElementById(b.dataset.calc === "seats" ? "calcSeats" : "calcBrands"); inp.value = Math.max(1, (+inp.value||1) + (+b.dataset.d)); updateCalc(); });
  c.addEventListener("input", e => { if (e.target.id === "calcSeats" || e.target.id === "calcBrands") updateCalc(); });
  updateCalc();
}

/* ---- admin Billing section (Settings) ---- */
function renderBilling(){
  if (!isAdmin()) return "";
  const used = seatsUsed(), seats = orgSeats(), legacy = isLegacyOrg();
  const rate = seatRate(seats), brands = brandCount();
  const price = priceFor(seats, brands);
  const sv = thresholdSavings(seats);
  let h = '<div class="spec-block"><div class="sb-head">Billing' + (legacy ? ' <span class="bill-legacy">Legacy plan</span>' : '') + '</div><div class="sb-body">';
  // seats
  h += '<div class="bill-row"><div class="bill-k">Seats</div><div class="bill-v"><b>' + used + '</b> of ' + seats + ' used' +
    (seatLimitReached() ? ' <span class="bill-full">Full</span>' : '') + '</div>' +
    '<div class="bill-ctl"><button class="mini-btn" data-act="billSeats" data-d="-1"' + (seats <= Math.max(1, used) ? " disabled" : "") + '>–</button>' +
    '<span class="bill-seatnum">' + seats + '</span>' +
    '<button class="mini-btn gold" data-act="billSeats" data-d="1">+ Add seat</button></div></div>';
  h += '<div class="bill-bar"><span class="bill-fill" style="width:' + Math.min(100, used/seats*100) + '%"></span></div>';
  // rate + threshold
  h += '<div class="bill-row"><div class="bill-k">Rate per seat</div><div class="bill-v"><b>' + fmtMoney(rate) + '</b> / seat / mo' +
    ' <span class="ops-dim">(' + (seats>=25?"25+":seats>=10?"10–24":"1–9") + ' seats)</span></div></div>';
  if (sv) h += '<div class="bill-note">Reach <b>' + sv.at + ' seats</b> and every seat drops to <b>' + fmtMoney(sv.rate) + '</b> — about <b>' + fmtMoney(sv.saving) + '/mo</b> less than ' + sv.at + ' seats at today\'s rate.</div>';
  else h += '<div class="bill-note">You are on the best volume rate (' + fmtMoney(rate) + '/seat).</div>';
  // brands
  h += '<div class="bill-row"><div class="bill-k">Brands</div><div class="bill-v"><b>' + brands + '</b> · 1 included' + (price.extraBrands > 0 ? ' · ' + price.extraBrands + ' extra × ' + fmtMoney(BRAND_PRICE) + ' = ' + fmtMoney(price.brandCost) + '/mo' : '') + '</div></div>';
  // total
  h += '<div class="bill-total"><span>Monthly total</span><b>' + fmtMoney(price.total) + '<span class="ops-dim">/mo</span></b></div>';
  h += '<div class="bill-breakdown">' + used + '–' + seats + ' seats × ' + fmtMoney(rate) + ' = ' + fmtMoney(price.seatCost) + (price.brandCost ? '  +  ' + fmtMoney(price.brandCost) + ' brands' : '') + '</div>';
  // AI usage
  h += '<div class="bill-sub">AI fair use · this period (' + usagePeriod() + ')</div>';
  if (legacy) h += '<div class="f-hint">This is a grandfathered workspace — usage is tracked but never throttled.</div>';
  Object.keys(AI_ALLOWANCE).forEach(k => {
    const usedK = pooledUsed(k), allow = pooledAllowance(k), r = allow ? usedK/allow : 0;
    const cls = r >= 1 ? "over" : r >= 0.8 ? "warn" : "";
    h += '<div class="bill-usage ' + cls + '"><div class="bu-top"><span>' + AI_LABELS[k] + '</span><span>' + usedK + ' / ' + allow + (r>=1?' · throttled':r>=0.8?' · '+Math.round(r*100)+'%':'') + '</span></div>' +
      '<div class="bill-bar"><span class="bill-fill" style="width:' + Math.min(100, r*100) + '%"></span></div></div>';
  });
  // ---- Live cost meter (step 6): estimated $ this month from actual tracked per-type call counts ----
  normalizeUsage();
  const spend = estMonthSpend();
  const callTypes = Object.keys(AI_COST_EST).filter(k => (USAGE.calls[k] || 0) > 0);
  h += '<div class="bill-sub">Estimated AI spend · this month</div>';
  h += '<div class="bill-spend"><span class="bs-amt">' + fmtSpend(spend) + '</span><span class="bs-cap">estimated actual API cost</span></div>';
  if (callTypes.length){
    h += '<table class="roll-table bill-cost"><thead><tr><th>Feature</th><th>Calls</th><th>Est. cost</th></tr></thead><tbody>' +
      callTypes.sort((a,b)=>(USAGE.calls[b]*AI_COST_EST[b])-(USAGE.calls[a]*AI_COST_EST[a])).map(k =>
        '<tr><td>' + esc(AI_COST_LABELS[k] || k) + (AI_BATCH_ELIGIBLE[k] ? ' <span class="ops-auto">batch-eligible</span>' : '') + '</td><td>' + USAGE.calls[k] + '</td><td>' + fmtSpend(USAGE.calls[k]*AI_COST_EST[k]) + '</td></tr>').join("") +
      '</tbody></table>';
  } else h += '<div class="f-hint">No AI calls yet this month.</div>';
  h += '<div class="f-hint" style="margin-top:6px">Estimated from tracked call counts at current model pricing — a live read on real burn, no Anthropic console needed.</div>';

  // ---- Per-member usage: today (daily caps) + this month ----
  const dayBucket = (USAGE.daily && USAGE.daily[todayISO()]) || {};
  const capKinds = Object.keys(AI_DAILY_CAPS);
  h += '<div class="bill-sub">Per-member usage · today</div>';
  h += '<table class="roll-table"><thead><tr><th>Person</th>' + capKinds.map(k => '<th>' + AI_CAP_LABELS[k].replace(/s$/,"").replace("fast message","Fast").replace("smart message","Smart").replace("image generation","Images").replace("transcript parse","Parses") + '</th>').join("") + '</tr></thead><tbody>' +
    (TEAM||[]).map(u => { const d = dayBucket[u.id] || {}; return '<tr><td>' + esc(u.name) + '</td>' + capKinds.map(k => { const used = d[k]||0, cap = dailyCap(k); return '<td' + (used>=cap ? ' class="cap-hit"' : '') + '>' + used + ' / ' + cap + '</td>'; }).join("") + '</tr>'; }).join("") +
    '</tbody></table>';

  // per-person monthly breakdown (unchanged)
  const rows = (TEAM||[]).map(u => { const uu = (USAGE&&USAGE.byUser&&USAGE.byUser[u.id]) || {}; return { u, s:uu.standard||0, sm:uu.smart||0, im:uu.image||0, pa:uu.parse||0 }; });
  h += '<details class="bill-people"><summary>Per-person usage · this month</summary><table class="roll-table"><thead><tr><th>Person</th><th>Standard</th><th>Smart</th><th>Images</th><th>Parses</th></tr></thead><tbody>' +
    rows.map(r => '<tr><td>' + esc(r.u.name) + '</td><td>' + r.s + '</td><td>' + r.sm + '</td><td>' + r.im + '</td><td>' + r.pa + '</td></tr>').join("") + '</tbody></table></details>';
  h += '<div class="f-hint" style="margin-top:10px">Every seat includes all features. Per-user daily caps keep AI cost bounded; a future paid tier can raise them per workspace. AI usage is pooled and included, not billed separately. Final billing activates with SYN Core (Stripe).</div>';
  return h + '</div></div>';
}
// Admin-only banner surfacing the pooled AI usage state (warn at 80%, throttle notice at 100%).
function usageBannerHtml(){
  if (!isAdmin() || isLegacyOrg()) return "";
  const over = Object.keys(AI_ALLOWANCE).filter(k => usageRatio(k) >= 1);
  const warn = Object.keys(AI_ALLOWANCE).filter(k => usageRatio(k) >= 0.8 && usageRatio(k) < 1);
  if (over.length){
    return '<div class="usage-banner over"><span class="ub-ico">!</span><div><b>AI allowance reached for ' + over.map(k => AI_LABELS[k].toLowerCase()).join(", ") + '.</b> SYN keeps working on a soft throttle (standard model; image generation paused). Add seats in Settings › Billing to lift it.</div></div>';
  }
  if (warn.length){
    return '<div class="usage-banner warn"><span class="ub-ico">•</span><div>The workspace has used 80%+ of its ' + warn.map(k => AI_LABELS[k].toLowerCase()).join(", ") + ' allowance this period. Consider adding seats to grow the pool.</div></div>';
  }
  return "";
}
function billAdjustSeats(delta){
  if (!isAdmin() || !ORG) return;
  const cur = orgSeats(), used = seatsUsed();
  let next = cur + delta;
  if (next < Math.max(1, used)){ toast("You have " + used + " member" + (used===1?"":"s") + " — remove someone before dropping below " + used + " seats."); return; }
  if (next < 1) next = 1;
  ORG.seats = next; if (ORG.legacy){ ORG.legacy = false; ORG.pricingModel = "per-seat"; }  // adjusting seats opts a legacy ws into the new model
  persistOrg();
  renderSettings();
  toast(delta > 0 ? "Seat added — " + next + " seats." : "Seat removed — " + next + " seats.");
}
async function renderDashboard(){
  for (const b of BRANDS) await loadChats(b.id);
  const p = document.getElementById("dashPanel");
  let totChats = 0, totAssets = 0, totMem = 0, totPend = 0;
  const cards = BRANDS.map(b => {
    const cs = CHATS[b.id] || [];
    const assets = brandAssets(b).length;
    let pend = 0;
    cs.filter(canSee).forEach(c => c.msgs.forEach(m => { if (m.role === "syn" && m.mode !== "image" && !m.verdict && m.rawText) pend++; }));
    totChats += cs.length; totAssets += assets; totMem += b.memories.length; totPend += pend;
    return { b, chats: cs.length, assets, pend };
  });
  let html = '<div class="panel-head"><div><h2>Portfolio</h2><p class="sub">Every brand in the workspace, one command view. This is the screen a house of brands buys.</p></div></div>';
  html += '<div class="stat-strip">' +
    '<div class="stat-tile"><b>' + BRANDS.length + '</b><span>Brands Encoded</span></div>' +
    '<div class="stat-tile"><b>' + totChats + '</b><span>Active Chats</span></div>' +
    '<div class="stat-tile"><b>' + totAssets + '</b><span>Assets Produced</span></div>' +
    '<div class="stat-tile"><b>' + totMem + '</b><span>Memories Held</span></div>' +
    '<div class="stat-tile"><b>' + APPROVALS.length + '</b><span>Verdicts Logged</span></div></div>';
  if (!BRANDS.length){
    html += '<div class="empty-log">No brands encoded yet. ' + (isAdmin() ? "Encode your first brand from the Workspace tab or the + Add button." : "Your Admin can encode the first brand.") + '</div>';
    p.innerHTML = html; return;
  }
  html += '<div class="dash-grid">';
  cards.forEach(x => {
    html += '<button class="dash-card" data-act="openBrand" data-bid="' + x.b.id + '" style="--dc-accent:' + esc(x.b.accent) + ';--dc-glow:' + hexToSoft(x.b.accent) + '">' +
      '<div class="dc-top"><span class="dc-dot"></span><span><span class="dc-name">' + esc(x.b.name) + '</span><br><span class="dc-ind">' + esc(x.b.industry) + '</span></span></div>' +
      '<div class="dc-stats"><span class="dc-stat"><b>' + x.chats + '</b><span>Chats</span></span>' +
      '<span class="dc-stat"><b>' + x.assets + '</b><span>Assets</span></span>' +
      '<span class="dc-stat"><b>' + x.b.memories.length + '</b><span>Memory</span></span></div>' +
      (x.pend ? '<div class="dc-pending">● ' + x.pend + ' awaiting approval</div>' : '<div class="dc-pending" style="color:var(--faint)">Queue clear</div>') +
      '</button>';
  });
  html += "</div>";
  p.innerHTML = html;
}

/* ---------------- BRAND MODAL ---------------- */
function normHex(v){
  v = (v || "").trim();
  if (!v.startsWith("#")) v = "#" + v;
  return /^#[0-9a-fA-F]{6}$/.test(v) ? v : null;
}
function paletteRow(name, hex){
  const row = document.createElement("div");
  row.className = "pal-row";
  row.innerHTML = '<input type="color" class="pr-pick" value="' + esc(normHex(hex) || "#8E959F") + '">' +
    '<input class="f-input pr-name" placeholder="Color name" value="' + esc(name || "") + '" style="flex:1">' +
    '<input class="f-input pr-hex" placeholder="#hex" value="' + esc(normHex(hex) || "#8E959F") + '" style="width:110px">' +
    '<button class="k-del pr-del" type="button" aria-label="Remove">✕</button>';
  const pick = row.querySelector(".pr-pick"), hx = row.querySelector(".pr-hex");
  pick.addEventListener("input", () => { hx.value = pick.value.toUpperCase(); });
  hx.addEventListener("input", () => { const h = normHex(hx.value); if (h) pick.value = h; });
  row.querySelector(".pr-del").addEventListener("click", () => row.remove());
  return row;
}
function buildPaletteRows(palette){
  const wrap = document.getElementById("bmPaletteRows");
  wrap.innerHTML = "";
  (palette && palette.length ? palette : [{ name:"Primary", hex:"#8E959F" }]).forEach(p => wrap.appendChild(paletteRow(p.name, p.hex)));
}
function collectPaletteRows(){
  const out = [];
  document.querySelectorAll("#bmPaletteRows .pal-row").forEach(row => {
    const hex = normHex(row.querySelector(".pr-hex").value) || row.querySelector(".pr-pick").value;
    out.push({ name: row.querySelector(".pr-name").value.trim() || "Color", hex: hex.toUpperCase() });
  });
  return out.length ? out : [{ name:"Primary", hex:"#8E959F" }];
}
function openBrandModal(editId){
  if (!isAdmin()) return;
  editingBrandId = editId || null;
  const b = editId ? BRANDS.find(x => x.id === editId) : null;
  document.getElementById("bmTitle").textContent = b ? "Edit " + b.name : (BRANDS.length ? "Add another brand" : "Set up your brand");
  document.getElementById("bmSave").textContent = b ? "Save Changes" : "Save Brand";
  document.getElementById("bmDelete").style.display = b && BRANDS.length > 1 ? "block" : "none";
  const set = (id, v) => document.getElementById(id).value = v || "";
  set("bmName", b ? b.name : (!BRANDS.length && ORG ? ORG.name : ""));
  set("bmInd", b && b.industry);
  set("bmSite", "");
  document.getElementById("bmResearchStatus").textContent = "Enter your company name or paste your website URL. SYN reads the live web (and that site if you give one) and fills everything below. You correct anything it gets wrong.";
  const accent = b ? b.accent : "#8E959F";
  set("bmAccent", accent);
  const ap = document.getElementById("bmAccentPick");
  ap.value = normHex(accent) || "#8E959F";
  set("bmVoice", b && b.voice); set("bmAud", b && b.audience);
  buildPaletteRows(b ? b.palette : null);
  set("bmProd", b ? b.products.join("\n") : ""); set("bmOk", b ? b.approvedClaims.join("\n") : "");
  set("bmBan", b ? b.bannedClaims.join("\n") : ""); set("bmLegal", b && b.legal); set("bmImg", b && b.imageStyle);
  document.getElementById("brandVeil").classList.add("open");
}
function saveBrandModal(){
  const name = document.getElementById("bmName").value.trim();
  if (!name){ document.getElementById("bmName").focus(); return; }
  const lines = id => document.getElementById(id).value.split("\n").map(s => s.trim()).filter(Boolean);
  const paletteLines = collectPaletteRows();
  const data = {
    name, industry: document.getElementById("bmInd").value.trim() || "General",
    accent: normHex(document.getElementById("bmAccent").value) || document.getElementById("bmAccentPick").value || "#8E959F",
    voice: document.getElementById("bmVoice").value.trim() || "Clear, confident, human.",
    audience: document.getElementById("bmAud").value.trim() || "The brand's core customers.",
    palette: paletteLines,
    products: lines("bmProd").length ? lines("bmProd") : ["Core product line"],
    approvedClaims: lines("bmOk"), bannedClaims: lines("bmBan"),
    legal: document.getElementById("bmLegal").value.trim() || "No special constraints recorded yet.",
    imageStyle: document.getElementById("bmImg").value.trim() || "Clean, premium product-forward photography aligned to the brand palette."
  };
  if (editingBrandId){ Object.assign(BRANDS.find(x => x.id === editingBrandId), data); }
  else {
    const nb = Object.assign({ id: uid("b"), memories:[], knowledge:[] }, data);
    BRANDS.push(nb); activeBrandId = nb.id;
  }
  saveBrands();
  document.getElementById("brandVeil").classList.remove("open");
  selectBrand(editingBrandId || activeBrandId).then(() => renderProfile());
}
function deleteBrandNow(){
  if (!editingBrandId || BRANDS.length <= 1) return;
  const btn = document.getElementById("bmDelete");
  if (!btn.dataset.armed){
    btn.dataset.armed = "1"; btn.textContent = "Click again to permanently delete";
    setTimeout(() => { btn.dataset.armed = ""; btn.textContent = "Delete brand"; }, 3000);
    return;
  }
  btn.dataset.armed = ""; btn.textContent = "Delete brand";
  const i = BRANDS.findIndex(x => x.id === editingBrandId);
  const bid = BRANDS[i].id;
  BRANDS.splice(i, 1);
  delete CHATS[bid];
  sSet(okey("chats:" + bid), []);                 // legacy blob
  sSet(privChatKey(bid), []);                     // my private chats for this brand
  sSet(sharedChatKey(bid), []);                   // shared chats for this brand
  saveBrands();
  document.getElementById("brandVeil").classList.remove("open");
  selectBrand(BRANDS[0].id);
}

/* ---------------- BRAND RESEARCH AUTO-FILL ---------------- */
let researching = false;
function looksLikeUrl(v){ return /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/[^\s]*)?$/i.test(v) && !/\s/.test(v); }
function nameFromUrl(u){ try{ const h = u.replace(/^https?:\/\//i, "").split("/")[0].replace(/^www\./i, ""); const root = h.split(".")[0]; return root ? root.charAt(0).toUpperCase() + root.slice(1) : ""; }catch(e){ return ""; } }
async function researchBrand(){
  if (researching) return;
  const raw = document.getElementById("bmSite").value.trim();
  const nameField = document.getElementById("bmName").value.trim();
  const status = document.getElementById("bmResearchStatus");
  // The auto-fill field accepts EITHER a company name OR a website URL.
  let site = "", typedName = "";
  if (raw && looksLikeUrl(raw)){ site = raw.startsWith("http") ? raw : ("https://" + raw); }
  else { typedName = raw; }
  const name = typedName || nameField || (site ? nameFromUrl(site) : "") || (ORG ? ORG.name : "");
  if (!name && !site){ status.textContent = "Enter a company name or a website URL first."; return; }
  const rGate = gateAI("smart", "research");   // Sonnet + live web search; counts against the smart cap
  if (!rGate.ok){ status.textContent = rGate.reason; return; }
  if (rGate.reason) toast(rGate.reason);
  researching = true;
  const btn = document.getElementById("bmResearch");
  btn.textContent = "Researching…";
  status.textContent = "Searching the web for " + (site || name) + "…";
  try{
    const res = await fetch(apiBase() + "/v1/messages", {
      method:"POST", headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({
        model: MODELS.smart, max_tokens: AI_MAX_TOKENS.research,
        system: "You are a brand researcher. Research the company on the live web and return ONLY a JSON object, no markdown fences, no commentary, with exactly these keys: name (the company's proper display name), industry (short string), voice (2-3 sentence brand voice description), audience (1-2 sentences), products (array of strings), approvedClaims (array of strings, verifiable claims from their site), bannedClaims (array of strings, phrases this company should avoid for legal or accuracy reasons), legal (1-3 sentences of legal/regulatory constraints for this industry), imageStyle (2-3 sentences describing photography/visual style fitting the brand), palette (array of up to 5 objects {name, hex} matching the brand's real colors), accent (single hex string, the brand's primary color). If unsure of a field, give a sensible industry-appropriate value. Never invent certifications.",
        messages: [{ role:"user", content: "Research this company from the live web" + (site ? ", reading their website directly at " + site : "") + ", and fill the brand profile. " + (site ? ("Website: " + site + (typedName || nameField ? (" (company: " + (typedName || nameField) + ")") : "")) : ("Company: " + name)) }],
        tools: [{ type:"web_search_20250305", name:"web_search" }]
      })
    });
    const data = await res.json();
    const txt = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("");
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("no json");
    const j = JSON.parse(m[0]);
    const set = (id, v) => { if (v) document.getElementById(id).value = String(v); };
    if (!nameField){ const nm = j.name || typedName || (site ? nameFromUrl(site) : ""); if (nm) document.getElementById("bmName").value = String(nm); }
    set("bmInd", j.industry);
    set("bmVoice", j.voice);
    set("bmAud", j.audience);
    set("bmProd", (j.products || []).join("\n"));
    set("bmOk", (j.approvedClaims || []).join("\n"));
    set("bmBan", (j.bannedClaims || []).join("\n"));
    set("bmLegal", j.legal);
    set("bmImg", j.imageStyle);
    if (j.accent && normHex(j.accent)){ document.getElementById("bmAccent").value = normHex(j.accent); document.getElementById("bmAccentPick").value = normHex(j.accent); }
    if (j.palette && j.palette.length) buildPaletteRows(j.palette.map(p => ({ name: p.name, hex: normHex(p.hex) || "#8E959F" })));
    status.textContent = "Filled from live web research. Review every field and correct anything wrong before saving.";
    toast("Brand profile drafted from the web.");
  }catch(e){
    status.textContent = "Research didn't come back cleanly. You can retry or fill the fields manually.";
  }
  researching = false;
  btn.textContent = "Research & Fill";
}

/* ---------------- INTEGRATIONS UI ---------------- */
/* Real brand marks as inline SVG */
const INT_SVG = {
  slack: '<svg viewBox="0 0 24 24"><path d="M6 14.5a1.9 1.9 0 1 1-1.9-1.9H6v1.9Z" fill="#E01E5A"/><path d="M7 14.5a1.9 1.9 0 0 1 3.8 0v4.6a1.9 1.9 0 0 1-3.8 0v-4.6Z" fill="#E01E5A"/><path d="M9.5 6a1.9 1.9 0 1 1 1.9-1.9V6H9.5Z" fill="#36C5F0"/><path d="M9.5 7a1.9 1.9 0 0 1 0 3.8H4.9a1.9 1.9 0 0 1 0-3.8h4.6Z" fill="#36C5F0"/><path d="M18 9.5a1.9 1.9 0 1 1 1.9 1.9H18V9.5Z" fill="#2EB67D"/><path d="M17 9.5a1.9 1.9 0 0 1-3.8 0V4.9a1.9 1.9 0 0 1 3.8 0v4.6Z" fill="#2EB67D"/><path d="M14.5 18a1.9 1.9 0 1 1-1.9 1.9V18h1.9Z" fill="#ECB22E"/><path d="M14.5 17a1.9 1.9 0 0 1 0-3.8h4.6a1.9 1.9 0 0 1 0 3.8h-4.6Z" fill="#ECB22E"/></svg>',
  teams: '<svg viewBox="0 0 24 24"><circle cx="16.7" cy="6.2" r="2.3" fill="#7B83EB"/><path d="M13.5 9.2h6.4c.6 0 1.1.5 1.1 1.1v3.4a3.1 3.1 0 0 1-3.1 3.1 3.1 3.1 0 0 1-3.1-3.1V9.2Z" fill="#5059C9"/><rect x="3" y="6.6" width="11" height="11" rx="1.6" fill="#4B53BC"/><path d="M5.7 9.4h5.6M8.5 9.4v6" stroke="#fff" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>',
  zoom: '<svg viewBox="0 0 24 24"><rect x="2.5" y="6" width="19" height="12" rx="3.4" fill="#2D8CFF"/><path d="M6 10.3h6.1c.9 0 1.6.7 1.6 1.6v2.2c0 .9-.7 1.6-1.6 1.6H6c-.9 0-1.6-.7-1.6-1.6v-2.2c0-.9.7-1.6 1.6-1.6Z" fill="#fff"/><path d="M15 12.2l3.2-2.1a.5.5 0 0 1 .8.4v3.6a.5.5 0 0 1-.8.4L15 12.8v-.6Z" fill="#fff"/></svg>',
  googlecal: '<svg viewBox="0 0 24 24"><rect x="5" y="5.5" width="14" height="13.5" rx="1.8" fill="#fff" stroke="#dadce0" stroke-width="0.8"/><path d="M5 7.3c0-1 .8-1.8 1.8-1.8h10.4c1 0 1.8.8 1.8 1.8v1.4H5V7.3Z" fill="#4285F4"/><path d="M5 15.3h14v1.9c0 1-.8 1.8-1.8 1.8H6.8c-1 0-1.8-.8-1.8-1.8v-1.9Z" fill="#34A853"/><rect x="4" y="8.7" width="1.8" height="6.6" fill="#EA4335"/><rect x="18.2" y="8.7" width="1.8" height="6.6" fill="#FBBC04"/><text x="12" y="14.3" font-size="6.2" font-weight="700" fill="#4285F4" text-anchor="middle" font-family="Arial,sans-serif">31</text></svg>',
  notion: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2.4" fill="#fff" stroke="#111" stroke-width="1.3"/><path d="M9 15.5v-7l6 7v-7" stroke="#111" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  stripe: '<svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="17" height="17" rx="3.6" fill="#635BFF"/><path d="M11.4 9.3c0-.55.46-.86 1.2-.86 1.06 0 2.4.32 3.46.9V6.05A9 9 0 0 0 12.6 5.5c-2.32 0-3.87 1.2-3.87 3.22 0 3.15 4.32 2.64 4.32 4 0 .65-.57.86-1.36.86-1.15 0-2.63-.47-3.8-1.1v3.06c1.3.56 2.62.8 3.8.8 2.38 0 4.02-1.16 4.02-3.22-.02-3.4-4.33-2.79-4.33-4.12Z" fill="#fff"/></svg>',
  zapier: '<svg viewBox="0 0 24 24"><path d="M12 3.5v17M3.5 12h17M6 6l12 12M18 6L6 18" stroke="#FF4F00" stroke-width="2.3" stroke-linecap="round"/><circle cx="12" cy="12" r="3" fill="#FF4F00"/></svg>'
};
const INT_CATALOG = [
  { key:"slack",     name:"Slack",            color:"#611f69", kind:"webhook", desc:"Post workspace notifications straight to a Slack channel." },
  { key:"teams",     name:"Microsoft Teams",  color:"#5059C9", kind:"webhook", desc:"Send activity updates to a Microsoft Teams channel." },
  { key:"zoom",      name:"Zoom",             color:"#2D8CFF", kind:"webhook", desc:"Get a ping with the meeting link whenever an event is scheduled." },
  { key:"googlecal", name:"Google Calendar",  color:"#4285F4", kind:"native",  desc:"Add events to Google Calendar and export your workspace as .ics." },
  { key:"notion",    name:"Notion",           color:"#111111", kind:"webhook", desc:"Mirror tasks and deliverables into a Notion database." },
  { key:"stripe",    name:"Stripe",           color:"#635BFF", kind:"webhook", desc:"Receive billing and subscription events in the workspace feed." },
  { key:"zapier",    name:"Zapier",           color:"#FF4F00", kind:"webhook", desc:"Fire a webhook to Zapier, Make, or any endpoint you choose." }
];
function intMeta(key){ return INT_CATALOG.find(x => x.key === key) || { key, name:key, color:"#888", kind:"webhook", desc:"" }; }
function intConnected(key){ const c = INTS[key]; const m = intMeta(key); return m.kind === "native" ? !!(c && c.connected) : !!(c && c.url); }
function intLogo(key){ return '<span class="int-logo2">' + (INT_SVG[key] || "") + '</span>'; }

function intCard(m){
  const key = m.key, cfg = INTS[key] || {}, connected = intConnected(key), admin = isAdmin();
  let h = '<div class="int-card2"><div class="ic-top">' + intLogo(key) +
    '<div style="flex:1"><div class="ic-name">' + esc(m.name) + '</div><div class="ic-desc">' + esc(m.desc) + '</div></div>' +
    '<span class="int-status2' + (connected ? " on" : "") + '">' + (connected ? "Connected" : "Available") + '</span></div>';
  if (!connected){
    h += admin
      ? '<button class="btn-gold ic-connect" data-wact="intConnect" data-k="' + key + '">Connect</button>'
      : '<div class="int-note" style="margin-top:12px">Managed by a workspace admin.</div>';
    return h + '</div>';
  }
  // connected state
  h += '<div class="int-conn-state"><div class="int-conn-row"><span class="int-dot"></span>Connected' +
    (cfg.connectedAt ? '<span class="int-conn-date">' + esc(fmtTime(cfg.connectedAt)) + '</span>' : '') + '</div>';
  if (m.kind === "webhook"){
    const on = cfg.on || {};
    h += '<div class="int-checks"><div class="icl">Notify on</div>' +
      INT_EVENTS.map(ev => '<label class="chk"><input type="checkbox" data-wact="intToggle" data-k="' + key + '" data-e="' + ev[0] + '"' + (on[ev[0]] !== false ? " checked" : "") + (admin ? "" : " disabled") + '><span class="box"><svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg></span>' + esc(ev[1]) + '</label>').join("") +
      '</div>';
  } else {
    h += '<div style="margin-top:12px"><button class="btn-ghost" data-act="exportIcs">Export workspace .ics</button></div>';
  }
  if (admin){
    h += '<div class="int-conn-foot">' +
      (m.kind === "webhook" ? '<button class="btn-ghost" data-wact="intTest" data-k="' + key + '">Send test</button>' : '') +
      '<button class="btn-ghost" data-wact="intDisconnect" data-k="' + key + '">Disconnect</button></div>';
  }
  return h + '</div></div>'; // close .int-conn-state and .int-card2
}
function renderIntegrations(){
  const connected = INT_CATALOG.filter(m => intConnected(m.key));
  const available = INT_CATALOG.filter(m => !intConnected(m.key));
  let h = '<div class="spec-block"><div class="sb-head">Integrations</div><div class="sb-body">';
  if (!isAdmin() && !connected.length){
    h += '<div class="int-note">Workspace integrations are managed by an admin. None are connected yet.</div>';
    return h + '</div></div>';
  }
  if (connected.length){
    h += '<div class="int-section-lbl">Connected <span class="isl-count">' + connected.length + '</span></div>';
    h += '<div class="int-grid">' + connected.map(intCard).join("") + '</div>';
  }
  if (isAdmin() && available.length){
    h += '<div class="int-section-lbl">Available <span class="isl-count">' + available.length + '</span></div>';
    h += '<div class="int-grid">' + available.map(intCard).join("") + '</div>';
  }
  h += '<div class="int-note">Webhook posts go directly from your browser (fire-and-forget; delivery confirmation and retries arrive with SYN Core).</div>';
  return h + '</div></div>';
}
/* Connect modal */
let intModalKey = null;
function openIntegrationModal(key){
  const m = intMeta(key); intModalKey = key;
  const cfg = INTS[key] || {};
  document.getElementById("imTitle").textContent = "Connect " + m.name;
  const bullets = {
    webhook: ['Paste an incoming webhook URL from ' + m.name + '.', 'SYN posts a short message for each event you enable below.', 'Nothing is sent until you pick which events notify.'],
    native:  ['Adds a one-click "Add to Google Calendar" link to every event.', 'Exports your whole workspace calendar as a standard .ics file.', 'No account connection or webhook required.']
  }[m.kind];
  let body = '<div class="intm-hero">' + intLogo(key) + '<div><div class="ic-name" style="font-size:16px">' + esc(m.name) + '</div><div class="ic-desc">' + esc(m.desc) + '</div></div></div>';
  body += '<ul class="intm-list">' + bullets.map(b => '<li><span class="ib">✓</span>' + esc(b) + '</li>').join("") + '</ul>';
  if (m.kind === "webhook"){
    body += '<label class="f-label" for="imUrl">Webhook URL</label>' +
      '<input class="f-input" id="imUrl" placeholder="https://hooks.' + esc(key) + '.com/…" value="' + esc(cfg.url || "") + '" autocomplete="off">';
  }
  document.getElementById("imBody").innerHTML = body;
  document.getElementById("imConnect").textContent = "Connect " + m.name;
  document.getElementById("intVeil").classList.add("open");
  if (m.kind === "webhook") setTimeout(() => { const u = document.getElementById("imUrl"); if (u) u.focus(); }, 60);
}
function intConnectSave(){
  const key = intModalKey; if (!key) return;
  const m = intMeta(key);
  INTS[key] = INTS[key] || { on:{} };
  if (m.kind === "webhook"){
    const inp = document.getElementById("imUrl");
    const url = inp ? inp.value.trim() : "";
    if (!url){ toast("Paste a webhook URL to connect."); return; }
    INTS[key].url = url;
  } else {
    INTS[key].connected = true;
  }
  INTS[key].connectedAt = nowISO();
  saveIntegrations();
  document.getElementById("intVeil").classList.remove("open");
  renderSettings();
  toast(m.name + " connected.");
}
function intDisconnect(key){
  const m = intMeta(key);
  if (INTS[key]){ INTS[key].url = ""; INTS[key].connected = false; INTS[key].connectedAt = null; }
  saveIntegrations(); renderSettings();
  toast(m.name + " disconnected.");
}

