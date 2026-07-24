/* ============================================================
   js/02-chat.js — threads, the AI SYSTEM PROMPT builder, brand-select sidebar, CHAT RENDER, attachments, generated files, the SEND / GENERATE pipeline, approvals, and profile rendering.
   MOVE, not a refactor: a byte-identical slice of the original inline <script>.
   Order-dependent. Loads after 01-boot-auth.js and before 03-assets-ops.js. Shared global
   scope, not a module. Do not reorder these tags.
   ============================================================ */
/* ---------------- THREADS ---------------- */
function chats(){ return CHATS[activeBrandId] || []; }
function ensureThread(){
  if (!brand()) return null;
  const list = chats();
  if (!list.length){
    list.push({ id: uid("t"), name:"New chat", pinned:false, shared:false, ownerId: currentUser ? currentUser.id : null, ownerName: currentUser ? currentUser.name : "", createdAt:new Date().toISOString(), updatedAt:new Date().toISOString(), msgs:[] });
    CHATS[activeBrandId] = list;
  }
  let t = list.find(x => x.id === (brand()._activeThread || "") && canSee(x));
  if (!t) t = list.find(canSee) || null;
  if (!t){
    t = { id: uid("t"), name:"New chat", pinned:false, shared:false, ownerId: currentUser ? currentUser.id : null, ownerName: currentUser ? currentUser.name : "", createdAt:new Date().toISOString(), updatedAt:new Date().toISOString(), msgs:[] };
    list.push(t);
  }
  brand()._activeThread = t.id;
  return t;
}
function thread(){ return ensureThread(); }
// Everything loaded into memory is already visible to me (my private chats + shared chats),
// but keep an explicit guard: a chat is mine to see if it's shared or I own it.
function canSee(c){ return !!c.shared || (currentUser && c.ownerId === currentUser.id); }
/* DATA-LAYER PERMISSION: only the chat's OWNER may change its visibility — not admins, not other
   members. Callers must gate the UI on this too, but the data-layer function is the real fence. */
function canChangeChatVisibility(c){ return !!(c && currentUser && c.ownerId === currentUser.id); }
/* ATOMIC visibility re-key. Private chats live under the owner's per-user key; shared chats under a
   workspace key. Moving between them writes the NEW store first, verifies the record is readable
   there, and only THEN rewrites the OLD store without it — so a failure can never orphan the chat. */
async function setChatVisibility(chatId, shared){
  const brandId = activeBrandId;
  const list = CHATS[brandId] || [];
  const chat = list.find(c => c.id === chatId);
  if (!chat) return { ok:false, reason:"not_found" };
  if (!canChangeChatVisibility(chat)) return { ok:false, reason:"forbidden" };
  shared = !!shared;
  if (!!chat.shared === shared) return { ok:true, reason:"noop" };
  const uid = currentUser.id;
  const wasShared = !!chat.shared;
  chat.shared = shared;
  const newKey = shared ? sharedChatKey(brandId) : privChatKey(brandId);
  const oldKey = shared ? privChatKey(brandId)   : sharedChatKey(brandId);
  const inNew  = c => shared ? c.shared : (!c.shared && c.ownerId === uid);
  const inOld  = c => shared ? (!c.shared && c.ownerId === uid) : c.shared;
  // 1) write the NEW location
  await sSet(newKey, list.filter(inNew).map(stripChat));
  // 2) verify the record is actually readable there
  const check = (await sGet(newKey)) || [];
  if (!check.some(c => c.id === chatId)){
    chat.shared = wasShared;                                 // roll back in memory; old store untouched
    return { ok:false, reason:"verify_failed" };
  }
  // 3) only now rewrite the OLD location without the chat
  await sSet(oldKey, list.filter(inOld).map(stripChat));
  return { ok:true, shared };
}
function newChat(){
  const t = { id: uid("t"), name:"New chat", pinned:false, shared:false, ownerId: currentUser.id, ownerName: currentUser.name, createdAt:new Date().toISOString(), updatedAt:new Date().toISOString(), msgs:[] };
  chats().unshift(t);
  brand()._activeThread = t.id;
  saveChats(activeBrandId);
  renderChatList(); renderThread(); setView("chat");
}
function sortedChats(){
  const q = (document.getElementById("chatSearch").value || "").toLowerCase();
  let list = chats().filter(canSee);
  if (q) list = list.filter(c => c.name.toLowerCase().includes(q) || c.msgs.some(m => (m.text || "").toLowerCase().includes(q)));
  return list.sort((a,b) => (b.pinned - a.pinned) || (new Date(b.updatedAt) - new Date(a.updatedAt)));
}
function renderChatList(){
  const el = document.getElementById("chatList");
  el.innerHTML = "";
  if (!brand()) return;
  ensureThread();
  sortedChats().forEach(t => {
    const btn = document.createElement("button");
    btn.className = "chat-item" + (t.id === brand()._activeThread ? " active" : "");
    btn.dataset.tid = t.id;
    const shared = !!t.shared;
    const mine = t.ownerId === currentUser.id;
    const marker = shared
      ? '<span class="c-marker" style="color:var(--good)" title="Shared with the whole workspace">shared' + (t.ownerName && !mine ? " · " + esc(t.ownerName.split(" ")[0]) : "") + '</span>'
      : '<span class="c-marker" style="color:var(--text-3)">private</span>';
    // Full name on one line; all actions live in a hover-revealed ⋯ overflow menu so icons never crowd the name.
    btn.innerHTML = '<span class="c-glyph">' + (shared ? '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></svg>' : (t.pinned ? '<svg viewBox="0 0 24 24"><path d="M9 4h6l-1 6 3 3v2H7v-2l3-3-1-6Z"/><path d="M12 15v5"/></svg>' : '<svg viewBox="0 0 24 24"><rect x="5" y="10.5" width="14" height="9" rx="1.6"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>')) + '</span>' +
      '<span class="c-name" title="' + esc(t.name) + '">' + esc(t.name) + marker + '</span>' +
      '<button class="c-menu-btn" data-act="chatMenu" data-tid="' + t.id + '" aria-label="Chat options for ' + esc(t.name) + '" title="Options">⋯</button>';
    el.appendChild(btn);
  });
}
/* Hover-revealed chat overflow menu with labeled items (44px targets) */
function ico(name){ const M={ rename:'<svg viewBox="0 0 24 24"><path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3Z"/><path d="M13.5 6.5l3 3"/></svg>', share:'<svg viewBox="0 0 24 24"><circle cx="6" cy="12" r="2.4"/><circle cx="17" cy="6" r="2.4"/><circle cx="17" cy="18" r="2.4"/><path d="M8.2 10.9l6.6-3.6M8.2 13.1l6.6 3.6"/></svg>', pin:'<svg viewBox="0 0 24 24"><path d="M9 4h6l-1 6 3 3H7l3-3-1-6Z"/><path d="M12 16v4"/></svg>', del:'<svg viewBox="0 0 24 24"><path d="M5 7h14M9 7V5h6v2M7 7l1 12h8l1-12"/></svg>' }; return '<span class="ci-ico">' + (M[name]||"") + '</span>'; }
let ctxMenuEl = null;
function openChatMenu(tid, anchor){
  const t = chats().find(x => x.id === tid); if (!t) return;
  closeChatMenu();
  const canEdit = (t.ownerId === currentUser.id) || isAdmin();
  const canVis = canChangeChatVisibility(t);   // visibility is OWNER-ONLY, even for admins
  const shared = !!t.shared;
  const m = document.createElement("div"); m.className = "ctx-menu open"; m.setAttribute("role","menu"); m.id = "chatCtxMenu";
  let items = '<button class="ctx-item" role="menuitem" data-cact="rename" data-tid="' + tid + '">' + ico("rename") + 'Rename</button>';
  if (canVis) items += '<button class="ctx-item" role="menuitem" data-cact="share" data-tid="' + tid + '">' + ico("share") + (shared ? "Make private to you" : "Share to workspace") + '</button>';
  items += '<button class="ctx-item" role="menuitem" data-cact="pin" data-tid="' + tid + '">' + ico("pin") + (t.pinned ? "Unpin" : "Pin") + '</button>';
  if (canEdit) items += '<button class="ctx-item danger" role="menuitem" data-cact="delchat" data-tid="' + tid + '">' + ico("del") + 'Delete</button>';
  m.innerHTML = items;
  document.body.appendChild(m); ctxMenuEl = m;
  const r = anchor.getBoundingClientRect();
  m.style.top = Math.min(r.bottom + 6, window.innerHeight - m.offsetHeight - 10) + "px";
  m.style.left = Math.min(r.left - 160, window.innerWidth - m.offsetWidth - 10) + "px";
  const first = m.querySelector(".ctx-item"); if (first) first.focus();
}
function closeChatMenu(){ if (ctxMenuEl){ ctxMenuEl.remove(); ctxMenuEl = null; } }
function chatMenuAction(act, tid){
  const t = chats().find(x => x.id === tid); if (!t) return;
  closeChatMenu();
  if (act === "rename"){ startRename(tid); }
  else if (act === "share"){
    if (!canChangeChatVisibility(t)){ toast("Only the chat owner can change who can see it."); return; }
    setChatVisibility(t.id, !t.shared).then(res => {
      if (!res.ok){ toast(res.reason === "forbidden" ? "Only the chat owner can change who can see it." : "Couldn't change visibility — nothing was lost, please try again."); renderChatList(); return; }
      renderChatList(); toast(res.shared ? "Chat shared to the workspace." : "Chat is private to you again.");
    });
  }
  else if (act === "pin"){ t.pinned = !t.pinned; saveChats(activeBrandId); renderChatList(); }
  else if (act === "delchat"){ if (t.ownerId !== currentUser.id && !isAdmin()){ toast("Only the chat owner can delete this."); return; }
    if (!t._armDel){ t._armDel = true; toast("Tap Delete again to remove “" + (t.name || "chat") + "”."); openChatMenu(tid, document.querySelector('.chat-item[data-tid="' + tid + '"] .c-menu-btn') || document.body); setTimeout(() => { t._armDel = false; }, 3000); return; }
    CHATS[activeBrandId] = chats().filter(x => x.id !== tid);
    if (brand() && brand()._activeThread === tid) brand()._activeThread = null;
    saveChats(activeBrandId); renderChatList(); renderThread(); updatePendBadge(); toast("Chat deleted.");
  }
}
document.addEventListener("click", e => {
  const item = e.target.closest(".ctx-item");
  if (item && item.dataset.cact){ e.stopPropagation(); chatMenuAction(item.dataset.cact, item.dataset.tid); return; }
  if (ctxMenuEl && !e.target.closest("#chatCtxMenu") && !e.target.closest('[data-act="chatMenu"]')) closeChatMenu();
});
function startRename(tid){
  const t = chats().find(x => x.id === tid);
  const item = document.querySelector('.chat-item[data-tid="' + tid + '"]');
  if (!t || !item) return;
  item.innerHTML = "";
  const inp = document.createElement("input");
  inp.className = "chat-rename"; inp.value = t.name;
  inp.onclick = e => e.stopPropagation();
  inp.onkeydown = e => { if (e.key === "Enter") inp.blur(); if (e.key === "Escape"){ inp.value = t.name; inp.blur(); } };
  inp.onblur = () => { t.name = inp.value.trim() || t.name; saveChats(activeBrandId); renderChatList(); };
  item.appendChild(inp); inp.focus(); inp.select();
}

/* ---------------- SYSTEM PROMPT ---------------- */
// General Q&A doesn't need the full brand payload. Send it only when the request is brand/campaign work.
function isBrandRelevant(text, m){
  if (m === "image") return true;
  if (modelPick === "smart") return true;
  const b = brand();
  const s = (text || "").toLowerCase();
  if (b && b.name && s.includes(b.name.toLowerCase())) return true;
  return /\b(brand|voice|tone|campaign|copy|tagline|slogan|claim|palette|colou?rs?|logo|audience|products?|posts?|ads?|email|newsletter|caption|social|instagram|linkedin|tweet|thread|headline|write|draft|rewrite|generate|create|design|content|one[- ]?pager|brief|landing|press release|blog|script)\b/.test(s);
}
function buildSystemPrompt(b, brandRelevant){
  const t = thread();
  // ---- STABLE, CACHEABLE PREFIX: identity + guardrails + (brand profile when relevant) + protocols ----
  const sp = [
    "You are SYN, the proprietary brand intelligence platform built by Syntrex, an AI-native digital studio. You are a full-capability assistant: strategy, research, analysis, writing, documents, spreadsheets, code, planning, math. You format answers with clean markdown (headers, bold, lists, tables, code blocks) like a world-class assistant.",
    "You are LOCKED to the brand \"" + b.name + "\" (" + b.industry + "). All brand-facing content ships as this brand.",
    "You have LIVE WEB SEARCH. Use it for research, competitors, trends, current facts, prices, and anything you are unsure of. Name sources in plain text (publication or site). Do not announce that you are searching; deliver the researched answer.",
    // Guardrails travel on EVERY call, even general Q&A, so nothing unsafe can slip through.
    "BANNED CLAIMS AND PHRASES you must NEVER use, including close variants: " + (b.bannedClaims.join("; ") || "none recorded"),
    "LEGAL CONSTRAINTS: " + b.legal
  ];

  if (brandRelevant){
    sp.push(
      "",
      "BRAND VOICE: " + b.voice,
      "AUDIENCE: " + b.audience,
      "PALETTE: " + b.palette.map(p => p.name + " " + p.hex).join(", "),
      "PRODUCTS: " + b.products.join("; "),
      "APPROVED CLAIMS: " + (b.approvedClaims.join("; ") || "none recorded")
    );
    if (b.memories.length){
      sp.push("", "PERMANENT BRAND MEMORY (facts and decisions saved across all chats; treat as truth):");
      b.memories.slice(-40).forEach(m => sp.push("- " + m.text));
    }
    const textKnow = b.knowledge.filter(k => k.kind === "text");
    if (textKnow.length){
      sp.push("", "BRAND KNOWLEDGE LIBRARY:");
      textKnow.forEach(k => sp.push("--- FILE: " + k.name + " ---\n" + (k.text || "").slice(0, 6000)));
    }
  }

  sp.push("",
    "PROTOCOLS:",
    "1. Never use a banned claim or phrase in brand-facing content. If asked for one, use the closest compliant alternative and add one short line prefixed 'GUARDRAIL:' noting the swap.",
    "2. FILES: when asked to create a document, report, one-pager, sheet, tracker, or any file, wrap it EXACTLY as:",
    "[[FILE:filename.ext]]",
    "content",
    "[[/FILE]]",
    "Default documents to a fully designed, self-contained .html file in the brand's colors and typography, editorial-quality, print-ready. Use .csv for sheets/calendars/data (header row first). Use .doc only when Word is requested, built from SIMPLE Word-compatible HTML (h1, h2, p, table, short inline styles, no grid/flex/webfonts). Use .md or .txt only when plain text is requested. Keep files lean. Never mention the markers.",
    "3. MEMORY: when the user states a lasting fact, decision, preference, or correction about the brand or how they work (not small talk), save it by emitting on its own line: [[REMEMBER: the fact, under 25 words]] . Maximum 2 per response, only genuinely durable facts. It is stored permanently and silently.",
    "4. TASKS: when the user asks you to plan, organize, launch, or break down a project or effort, decompose it into concrete tasks and emit each on its own line EXACTLY as: [[TASK: title | assignee | YYYY-MM-DD | priority | project | visibility]] . Assignee is a team member's name or blank. Priority is one of low, med, high, urgent. Project is a short project name (reuse the same name for all tasks in one plan). Date is optional but realistic. Visibility is either private (only the assignees and creator can see it) or team (the whole workspace can see it); set it from the user's words — private/just me/personal → private, everyone/the whole team/shared → team; if they don't say, use private. Keep the empty slot with the surrounding pipes if a field is blank. Each of these lines creates a real task on the team board, so make titles action-oriented and specific. Team members: " + TEAM.map(u => u.name).join(", ") + ".",
    "5. EVENTS: when the user asks you to schedule, book, or set up a meeting, call, or calendar item, emit each on its own line EXACTLY as: [[EVENT: title | YYYY-MM-DD | HH:MM | attendees | visibility]] . Time is 24-hour and optional (omit for all-day; still keep the empty slot with the surrounding pipes). Attendees is a comma-separated list of team member names or blank. Visibility is either private (only you, the creator, sees it — it will NOT appear on other users' calendars) or team (everyone in the workspace sees it); set it from the user's words — private/just me/personal → private, everyone/the whole team/shared → team; if they don't say, use team. NEVER tell the user to set visibility manually — always set it yourself via this field. Each line creates a real event on the team calendar. Today is " + (typeof todayISO === "function" ? todayISO() : "") + ".",
    "6. DIRECT MESSAGES: when the user asks you to message, DM, tell, or notify a specific teammate, actually send it by emitting on its own line EXACTLY as: [[DM: person | message]] . Person is a team member's name; message is what to send. This posts a real direct message from " + currentUser.name + " to that teammate. Never claim you cannot send messages. Team members: " + TEAM.map(u => u.name).join(", ") + ".",
    "7. TASK STATUS: you may be given a snapshot of task state below. Use it to answer questions about who is doing what and how far along they are. Only report on tasks that appear in that snapshot.",
    "8. Deliver finished, usable work. No preambles like 'Here is'. Keep responses tight; go long only when the task demands it.",
    "9. Never use em dashes.");

  // The stable prefix is marked for prompt caching so we don't pay full input price for the brand
  // profile + instructions on every message. The dynamic tail (who you're talking to, cross-chat
  // context) is kept out of the cached block so it never busts the cache.
  const blocks = [{ type:"text", text: sp.join("\n"), cache_control:{ type:"ephemeral" } }];
  const dyn = ["You are working with " + currentUser.name + " (" + currentUser.role + " at Syntrex)" + (isAdmin() ? ", who is a workspace ADMIN." : ".")];
  const taskCtx = taskContextForAI();
  if (taskCtx) dyn.push("", taskCtx);
  if (brandRelevant){
    const others = chats().filter(x => x.id !== t.id && x.msgs.length && canSee(x));
    if (others.length){
      dyn.push("", "SHARED CONTEXT from this brand's other chats (for continuity):");
      others.slice(0, 4).forEach(o => {
        const recent = o.msgs.filter(m => m.mode !== "image").slice(-4)
          .map(m => (m.role === "user" ? "Teammate: " : "SYN: ") + (m.text || "").slice(0, 200)).join("\n");
        if (recent) dyn.push("[Chat: " + o.name + "]\n" + recent);
      });
    }
  }
  blocks.push({ type:"text", text: dyn.join("\n") });
  return blocks;
}
function buildImagePrompt(b, scene){
  return "BRAND: " + b.name + "\nSTYLE DNA: " + b.imageStyle +
    "\nPALETTE: " + b.palette.map(p => p.name + " " + p.hex).join(", ") +
    "\nSCENE: " + scene + "\nCONSTRAINTS: " + b.legal;
}

/* ---------------- BRAND SELECT / SIDEBAR ---------------- */
function renderBrands(){
  const el = document.getElementById("brandList");
  el.innerHTML = "";
  BRANDS.forEach(b => {
    const btn = document.createElement("button");
    btn.className = "brand-item" + (b.id === activeBrandId ? " active" : "");
    btn.dataset.bid = b.id;
    btn.style.setProperty("--bi-accent", b.accent);
    btn.style.setProperty("--bi-glow", hexToSoft(b.accent));
    btn.innerHTML = '<span class="brand-dot"></span><span><span class="b-name">' + esc(b.name) + '</span><br><span class="b-ind">' + esc(b.industry) + "</span></span>";
    el.appendChild(btn);
  });
}
function refreshFraming(){
  const lbl = document.getElementById("brandsLabel");
  if (lbl) lbl.textContent = BRANDS.length > 1 ? "Brands" : "Your Brand";
  const dash = document.querySelector('.nav-btn[data-view="dashboard"]');
  if (dash) dash.style.display = BRANDS.length > 1 ? "flex" : "none";
}
async function selectBrand(id){
  activeBrandId = id;
  const b = brand();
  refreshFraming();
  await loadChats(id);
  document.documentElement.style.setProperty("--accent", b.accent);
  document.documentElement.style.setProperty("--accent-soft", hexToSoft(b.accent));
  document.getElementById("lockName").textContent = b.name.toUpperCase();
  document.getElementById("guardCount").textContent = b.bannedClaims.length;
  document.getElementById("esBrand").textContent = b.name;
  renderBrands(); renderChatList(); renderThread(); renderStarters(); updatePendBadge();
  setView("chat");
  if (window.innerWidth <= 900) document.getElementById("sidebar").classList.remove("open");
}

/* ---------------- CHAT RENDER ---------------- */
const STARTERS = {
  copy: ["Research our competitors online","3 Instagram captions for our flagship product","Build a 2-week content calendar as a sheet","Design a one-page brand overview"],
  image: ["Hero product shot for the website","Lifestyle scene for social","Seasonal promo visual"]
};
function renderStarters(){
  const row = document.getElementById("starterRow");
  row.innerHTML = "";
  STARTERS[mode].forEach(s => {
    const btn = document.createElement("button");
    btn.className = "starter"; btn.textContent = s;
    btn.onclick = () => { document.getElementById("input").value = s; send(); };
    row.appendChild(btn);
  });
}
function renderThread(){
  const inner = document.getElementById("chatInner");
  inner.innerHTML = "";
  const onboard = !BRANDS.length;
  document.getElementById("onboardState").style.display = onboard ? "block" : "none";
  document.querySelector("#view-chat .composer-wrap").style.display = onboard ? "none" : "block";
  if (onboard){
    document.getElementById("emptyState").style.display = "none";
    document.getElementById("lockName").textContent = "—";
    document.getElementById("guardCount").textContent = "0";
    return;
  }
  const t = thread();
  document.getElementById("emptyState").style.display = t.msgs.length ? "none" : "block";
  t.msgs.forEach((m, i) => inner.appendChild(buildMsgNode(m, i)));
  scrollBottom();
}
function buildMsgNode(m, idx){
  const d = document.createElement("div");
  d.className = "msg " + m.role;
  const who = m.role === "user" ? esc(m.by || "You") : "SYN · " + esc(brand().name);
  let html = '<div class="who">' + who + (m.at ? '<span class="w-time">' + esc(fmtTime(m.at)) + "</span>" : "") + "</div>";

  if (m.atts && m.atts.length){
    html += '<div class="att-strip">' + m.atts.map(a =>
      a.stub ? '<span class="att-chip"><span class="a-ico">≣</span>' + esc(a.name) + " (session file)</span>"
      : a.kind === "image" ? '<img class="att-thumb" src="data:' + a.media + ';base64,' + a.data + '" alt="' + esc(a.name) + '">'
      : '<span class="att-chip"><span class="a-ico">' + (a.kind === "pdf" ? "⌘" : "≣") + '</span>' + esc(a.name) + "</span>"
    ).join("") + "</div>";
  }

  if (m.mode === "image" && m.role === "syn"){
    html += '<div class="img-card"><div class="ic-head">Imagery Request<span class="route">→ gpt-image-1 · SYN Core</span></div>' +
      '<div class="ic-body"><div class="ic-label">Prompt compiled from brand profile</div>' +
      '<div class="ic-prompt">' + esc(m.text) + '</div>' +
      '<div class="ic-status">Queued · imagery renders when SYN Core connects</div></div></div>';
    if (needsVerdict(m)){
      let acts = "";
      if (m.verdict === "ap") acts += '<button class="act-btn done-approve">✓ Approved</button>';
      else if (m.verdict === "rj") acts += '<button class="act-btn done-reject">✕ Rejected</button>';
      else acts += '<button class="act-btn approve" data-act="approve" data-idx="' + idx + '">Approve</button>' +
                   '<button class="act-btn reject" data-act="reject" data-idx="' + idx + '">Reject</button>';
      if (!m.verdict) acts += '<span class="act-note">Imagery ships only with a verdict</span>';
      html += '<div class="actions">' + acts + "</div>";
    }
    d.innerHTML = html; return d;
  }

  const bodyText = m.displayText != null ? m.displayText : (m.text || "");
  if (bodyText){
    if (m.role === "syn") html += '<div class="bubble md">' + renderMD(bodyText) + "</div>";
    else html += '<div class="bubble">' + esc(bodyText) + "</div>";
  }

  (m.files || []).forEach((f, fi) => {
    html += '<div class="file-card"><div class="fc-ico">.' + esc(extOf(f.name) || "txt") + '</div>' +
      '<div><div class="fc-name">' + esc(f.name) + '</div><div class="fc-meta">Generated by SYN · ' + esc(brand().name) + '</div></div>' +
      '<div class="fc-btns"><button class="fc-prev" data-act="preview" data-idx="' + idx + '" data-fi="' + fi + '">Preview</button>' +
      '<button class="fc-dl" data-act="download" data-idx="' + idx + '" data-fi="' + fi + '">Download</button></div></div>';
  });

  if (m.savedMemories && m.savedMemories.length){
    html += '<div class="mem-flag">◈ Saved to brand memory: ' + esc(m.savedMemories.join(" · ")) + "</div>";
  }

  if (m.role === "syn" && m.mode !== "image"){
    const isLast = idx === thread().msgs.length - 1;
    const gated = needsVerdict(m);
    let acts = "";
    if (gated){
      if (m.verdict === "ap") acts += '<button class="act-btn done-approve">✓ Approved</button>';
      else if (m.verdict === "rj") acts += '<button class="act-btn done-reject">✕ Rejected</button>';
      else acts += '<button class="act-btn approve" data-act="approve" data-idx="' + idx + '">Approve</button>' +
                   '<button class="act-btn reject" data-act="reject" data-idx="' + idx + '">Reject</button>';
    }
    acts += '<button class="act-btn" data-act="copy" data-idx="' + idx + '">Copy</button>';
    if (isLast && !busy) acts += '<button class="act-btn" data-act="regen">Regenerate</button>';
    if (gated && !m.verdict) acts += '<span class="act-note">Nothing ships without a verdict</span>';
    html += '<div class="actions">' + acts + "</div>";
  }
  d.innerHTML = html;
  d.querySelectorAll("pre").forEach(pre => {
    const btn = document.createElement("button");
    btn.className = "copy-code"; btn.textContent = "Copy";
    btn.onclick = () => { copyText(pre.innerText); btn.textContent = "Copied"; setTimeout(() => btn.textContent = "Copy", 1500); };
    pre.appendChild(btn);
  });
  return d;
}
function scrollBottom(){
  const sc = document.getElementById("chatScroll");
  requestAnimationFrame(() => { sc.scrollTop = sc.scrollHeight; });
}
function copyText(txt){
  if (navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(txt).catch(() => fallbackCopy(txt)); }
  else fallbackCopy(txt);
}
function fallbackCopy(txt){
  const ta = document.createElement("textarea");
  ta.value = txt; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  try{ document.execCommand("copy"); }catch(e){}
  ta.remove();
}

/* ---------------- ATTACHMENTS ---------------- */
function handleFiles(fileList, target){
  Array.from(fileList).forEach(f => {
    if (f.size > 4.5 * 1048576){ toast(f.name + " is over 4.5 MB. Keep drops under that."); return; }
    const r = new FileReader();
    const push = obj => {
      if (obj.data && obj.data.length > 700000) obj.tooBig = true;
      if (target === "knowledge"){ if (!brand()) return; brand().knowledge.push(obj); saveBrands(); renderProfile(); }
      else { pendingAtts.push(obj); renderPending(); }
    };
    if (f.type.startsWith("image/")){
      r.onload = () => push({ kind:"image", name:f.name, media:f.type, data:r.result.split(",")[1], size:f.size });
      r.readAsDataURL(f);
    } else if (f.type === "application/pdf"){
      r.onload = () => push({ kind:"pdf", name:f.name, media:"application/pdf", data:r.result.split(",")[1], size:f.size });
      r.readAsDataURL(f);
    } else {
      r.onload = () => push({ kind:"text", name:f.name, text:String(r.result).slice(0, 60000), size:f.size });
      r.readAsText(f);
    }
  });
}
function renderPending(){
  document.getElementById("pendingStrip").innerHTML = pendingAtts.map((a, i) =>
    '<span class="p-chip"><span class="a-ico">' + (a.kind === "image" ? "▣" : a.kind === "pdf" ? "⌘" : "≣") + '</span>' +
    esc(a.name) + '<button class="p-x" data-act="unatt" data-i="' + i + '" aria-label="Remove">✕</button></span>').join("");
}

/* ---------------- GENERATED FILES ---------------- */
function parseSpecial(raw){
  const files = [], memories = [], aiTasks = [], aiEvents = [], aiDMs = [];
  let clean = raw.replace(/\[\[FILE:([^\]]+)\]\]([\s\S]*?)\[\[\/FILE\]\]/g, (m, name, content) => {
    files.push({ name: name.trim(), content: content.replace(/^\n+|\n+$/g, "") }); return "";
  });
  const open = clean.match(/\[\[FILE:([^\]]+)\]\]([\s\S]*)$/);
  if (open){ files.push({ name: open[1].trim(), content: open[2].replace(/^\n+/, "") }); clean = clean.slice(0, open.index); }
  clean = clean.replace(/\[\[REMEMBER:\s*([\s\S]*?)\]\]/g, (m, fact) => { memories.push(fact.trim()); return ""; });
  clean = clean.replace(/\[\[TASK:\s*([^\]]+?)\]\]/g, (m, body) => { aiTasks.push(body.trim()); return ""; });
  clean = clean.replace(/\[\[EVENT:\s*([^\]]+?)\]\]/g, (m, body) => { aiEvents.push(body.trim()); return ""; });
  clean = clean.replace(/\[\[DM:\s*([^\]]+?)\]\]/g, (m, body) => { aiDMs.push(body.trim()); return ""; });
  return { clean: clean.trim(), files, memories, aiTasks, aiEvents, aiDMs };
}
// SYN can actually send a DM: [[DM: person | message]] -> posts from the current user to that teammate.
function ingestAIDMs(lines){
  if (!lines || !lines.length || !currentUser) return 0;
  let made = 0;
  lines.forEach(line => {
    const parts = line.split("|"); const who = (parts[0] || "").trim(); const msg = parts.slice(1).join("|").trim();
    if (!who || !msg) return;
    const u = (TEAM || []).find(x => x.id !== currentUser.id && (x.name.toLowerCase() === who.toLowerCase() || x.name.toLowerCase().split(" ")[0] === who.toLowerCase()));
    if (!u) return;
    let dm = DMs.list(d => Array.isArray(d.members) && d.members.length === 2 && d.members.includes(currentUser.id) && d.members.includes(u.id))[0];
    if (!dm) dm = DMs.create({ members:[currentUser.id, u.id], msgCount:0 });
    const key = msgKey("dm", dm.id);
    collLoad(key).then(() => {
      const arr = collAll(key);
      const m = { id: uid("m"), by: currentUser.name, byId: currentUser.id, at: nowISO(), text: msg, atts:[], reactions:{}, mentions:[] };
      arr.push(m); if (arr.length > 800) arr.splice(0, arr.length - 800); collSave(key);
      if (typeof bumpThreadRecord === "function") bumpThreadRecord("dm", dm.id, m);
      updateSpacesBadge();
    });
    notify(u.id, "dm", currentUser.name + ": " + msg.slice(0, 60), { view:"spaces", dm: dm.id });
    if (typeof fireIntegrations === "function") fireIntegrations("dm", currentUser.name + " messaged " + u.name);
    made++;
  });
  return made;
}
// Compact task snapshot for the AI. Admins get the whole workspace; everyone else only their own tasks.
function taskContextForAI(){
  const admin = isAdmin();
  const list = Tasks.list(t => !isArchived(t) && (admin || (t.assignees || []).includes(currentUser.id))).slice(0, 60);
  if (!list.length) return "";
  const S = { todo:"To do", inprogress:"In progress", review:"Review", done:"Done" };
  const lines = list.map(t => {
    const who = (t.assignees || []).map(id => teamName(id) || "?").join(", ") || "unassigned";
    return "- " + (t.title || "Untitled") + " [" + (S[t.status] || t.status) + "] assignee: " + who + (t.dueDate ? ", due " + t.dueDate : "") + (t.projectId && projectById(t.projectId) ? ", project " + projectById(t.projectId).name : "");
  });
  return (admin
    ? "WORKSPACE TASK STATE (you are talking to an ADMIN, so you may report on anyone's tasks and progress):"
    : "YOUR TASKS (the person you're talking to is not an admin; only their own tasks are visible to you):") + "\n" + lines.join("\n");
}
function mimeFor(ext){
  return { csv:"text/csv", html:"text/html", htm:"text/html", md:"text/markdown", txt:"text/plain", doc:"application/msword", json:"application/json", ics:"text/calendar" }[ext] || "text/plain";
}
function doDownload(f){
  const ext = extOf(f.name);
  let content = f.content;
  if (ext === "doc" && !/^\s*</.test(content)) content = "<html><body><pre style='font-family:Calibri'>" + content + "</pre></body></html>";
  const blob = new Blob([content], { type: mimeFor(ext) + ";charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = f.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function splitCsv(line){
  const out = []; let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++){
    const ch = line[i];
    if (inQ){ if (ch === '"'){ if (line[i+1] === '"'){ cur += '"'; i++; } else inQ = false; } else cur += ch; }
    else { if (ch === '"') inQ = true; else if (ch === ","){ out.push(cur); cur = ""; } else cur += ch; }
  }
  out.push(cur); return out;
}
function doPreview(f){
  const ext = extOf(f.name);
  let html;
  if (ext === "html" || ext === "htm" || ext === "doc") html = f.content;
  else if (ext === "csv"){
    const rows = f.content.trim().split(/\r?\n/).map(splitCsv);
    html = "<html><body style='font-family:Arial,sans-serif;background:#fff;padding:26px;color:#1a1a1a'><table style='border-collapse:collapse;width:100%'>" +
      rows.map((r, i) => "<tr>" + r.map(c =>
        (i === 0 ? "<th" : "<td") + " style='border:1px solid #e2ddd4;padding:10px 13px;text-align:left;" +
        (i === 0 ? "background:#101114;color:#E2E2E2;font-size:11px;letter-spacing:.08em;text-transform:uppercase" : "font-size:13px") +
        "'>" + escHtml(c) + (i === 0 ? "</th>" : "</td>")).join("") + "</tr>").join("") + "</table></body></html>";
  } else html = "<html><body style='font-family:Arial,sans-serif;background:#fff;color:#1a1a1a;padding:38px;line-height:1.75;max-width:760px;margin:0 auto;white-space:pre-wrap'>" + escHtml(f.content) + "</body></html>";
  document.getElementById("prevTitle").textContent = f.name;
  document.getElementById("prevFrame").srcdoc = html;
  document.getElementById("prevVeil").classList.add("open");
}

/* ---------------- SEND / GENERATE ---------------- */
function setMode(m){
  mode = m;
  document.getElementById("modeCopy").classList.toggle("active", m === "copy");
  document.getElementById("modeImage").classList.toggle("active", m === "image");
  document.getElementById("modeHint").textContent = m === "copy" ? "Text · Files · Live Web · Memory" : "Imagery · Routed via SYN Core";
  document.getElementById("input").placeholder = m === "copy" ? "Ask SYN, or drop files anywhere…" : "Describe the scene. SYN compiles the on-brand prompt…";
  renderStarters();
}
function setModel(m){
  modelPick = m;
  document.getElementById("mSmart").classList.toggle("active", m === "smart");
  document.getElementById("mFast").classList.toggle("active", m === "fast");
}
async function send(){
  if (busy) return;
  if (!brand()){ setView("chat"); return; }
  const input = document.getElementById("input");
  const text = input.value.trim();
  if (!text && !pendingAtts.length) return;
  input.value = ""; input.style.height = "auto";

  const t = thread();
  const atts = pendingAtts; pendingAtts = []; renderPending();
  t.msgs.push({ role:"user", text: text || "(files attached)", atts, mode, by: currentUser.name, at: new Date().toISOString() });
  if (t.name === "New chat" && text) t.name = text.slice(0, 34) + (text.length > 34 ? "…" : "");
  t.updatedAt = new Date().toISOString();
  saveChats(activeBrandId);
  renderChatList(); renderThread();

  if (mode === "image"){
    const imgGate = gateAI("image", "image");
    if (!imgGate.ok){   // daily cap or pool spent: explain in-thread rather than silently failing
      t.msgs.push({ role:"syn", displayText: imgGate.reason, rawText: imgGate.reason, verdict:null, at: new Date().toISOString() });
      saveChats(activeBrandId); renderThread(); return;
    }
    t.msgs.push({ role:"syn", text: buildImagePrompt(brand(), text || "See attached reference files."), mode:"image", verdict:null, needsApproval:true, at: new Date().toISOString() });
    saveChats(activeBrandId); renderThread(); return;
  }
  await generate();
}
async function regenerate(){
  if (busy) return;
  const t = thread();
  if (t.msgs.length && t.msgs[t.msgs.length - 1].role === "syn"){ t.msgs.pop(); saveChats(activeBrandId); renderThread(); }
  await generate();
}
async function generate(){
  const b = brand();
  const t = thread();
  busy = true;
  abortCtl = new AbortController();
  const sendBtn = document.getElementById("sendBtn");
  sendBtn.textContent = "■"; sendBtn.classList.add("stop"); sendBtn.title = "Stop";

  const live = document.createElement("div");
  live.className = "msg syn";
  live.innerHTML = '<div class="who">SYN · ' + esc(b.name) + '</div>' +
    '<div class="status-line"><span class="s-dot"></span><span class="s-txt">Thinking…</span></div>' +
    '<div class="bubble md" style="display:none"></div>';
  document.getElementById("chatInner").appendChild(live);
  scrollBottom();
  const statusEl = live.querySelector(".status-line");
  const statusTxt = live.querySelector(".s-txt");
  const bubbleEl = live.querySelector(".bubble");
  const setStatus = s => { statusEl.style.display = "flex"; statusTxt.textContent = s; scrollBottom(); };
  const hideStatus = () => { statusEl.style.display = "none"; };
  let lastPaint = 0;
  const paintVisible = accum => {
    const i = accum.indexOf("[[FILE:");
    let vis = (i < 0 ? accum : accum.slice(0, i)).replace(/\[\[REMEMBER:[\s\S]*?(\]\]|$)/g, "").trim();
    if (i >= 0){
      const nm = accum.slice(i).match(/\[\[FILE:([^\]]+)\]\]/);
      setStatus(nm ? "Designing " + nm[1].trim() + "…" : "Designing your file…");
    } else hideStatus();
    const now = Date.now();
    if (vis && now - lastPaint > 120){
      lastPaint = now;
      bubbleEl.style.display = "block";
      bubbleEl.innerHTML = renderMD(vis);
      scrollBottom();
    }
  };

  // Cost control: only the full brand payload when the request is brand/campaign work, and only a
  // trailing window of the conversation instead of the entire transcript on every call.
  const lastUser = [...t.msgs].reverse().find(m => m.role === "user");
  const brandRelevant = isBrandRelevant(lastUser ? lastUser.text : "", mode);
  const brandWork = (modelPick === "smart") || mode === "image";
  const HISTORY_WINDOW = 10;

  // AI metering: daily hard cap first (a real cost firewall), then the monthly soft throttle.
  let effModelPick = modelPick;
  const gate = gateAI(modelPick === "smart" ? "smart" : "fast", modelPick === "smart" ? "smart_msg" : "fast_msg");
  if (!gate.ok){                       // daily cap hit — explain in-thread, everything non-AI still works
    live.remove();
    t.msgs.push({ role:"syn", text: gate.reason, displayText: gate.reason, rawText:"", files:[], mode:"copy", verdict:null, needsApproval:false, at:new Date().toISOString() });
    saveChats(activeBrandId);
    busy = false; abortCtl = null;
    sendBtn.textContent = "↑"; sendBtn.classList.remove("stop"); sendBtn.title = "Send";
    renderThread();
    return;
  }
  if (gate.downgrade) effModelPick = "fast";
  if (gate.reason) toast(gate.reason);

  let raw = "";
  try{
    const history = t.msgs.filter(m => m.mode !== "image").slice(-HISTORY_WINDOW).map(m => {
      if (m.role === "user"){
        const blocks = [];
        (m.atts || []).forEach(a => {
          if (a.stub) blocks.push({ type:"text", text:"[A file named " + a.name + " was attached in an earlier session but is no longer available.]" });
          else if (a.kind === "image") blocks.push({ type:"image", source:{ type:"base64", media_type:a.media, data:a.data } });
          else if (a.kind === "pdf") blocks.push({ type:"document", source:{ type:"base64", media_type:"application/pdf", data:a.data } });
          else blocks.push({ type:"text", text:"[Attached file: " + a.name + "]\n" + (a.text || "") });
        });
        blocks.push({ type:"text", text: m.text });
        return { role:"user", content: blocks };
      }
      return { role:"assistant", content: m.rawText || m.text || " " };
    });

    let tries = 0, stopReason = "";
    while (true){
      const msgs = raw ? history.concat([{ role:"assistant", content: raw }]) : history;
      const res = await fetch(apiBase() + "/v1/messages", {
        method:"POST", headers:{ "Content-Type":"application/json", ...gateHeaders() },
        signal: abortCtl.signal,
        body: JSON.stringify({
          model: MODELS[effModelPick], max_tokens: AI_MAX_TOKENS.chat, stream: true,
          system: buildSystemPrompt(b, brandRelevant), messages: msgs,
          tools: [{ type:"web_search_20250305", name:"web_search" }]
        })
      });
      if (!res.ok || !res.body) throw new Error("net");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "", searchInput = "";
      stopReason = "";
      while (true){
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream:true });
        const lines = buf.split("\n"); buf = lines.pop();
        for (const line of lines){
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          let ev; try{ ev = JSON.parse(payload); }catch(e){ continue; }
          if (ev.type === "content_block_start"){
            const cb = ev.content_block || {};
            if (cb.type === "server_tool_use"){ searchInput = ""; setStatus("Searching the web…"); }
            if (cb.type === "web_search_tool_result") setStatus("Reading sources…");
          } else if (ev.type === "content_block_delta"){
            const d = ev.delta || {};
            if (d.type === "text_delta"){ raw += d.text; paintVisible(raw); }
            else if (d.type === "input_json_delta"){
              searchInput += d.partial_json || "";
              const q = searchInput.match(/"query"\s*:\s*"([^"]*)/);
              if (q && q[1]) setStatus("Searching: " + q[1]);
            }
          } else if (ev.type === "message_delta"){
            if (ev.delta && ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
          }
        }
      }
      if (stopReason !== "max_tokens" || ++tries >= 3) break;
      setStatus("Continuing the document…");
    }
    raw = raw.trim();
    live.remove();
    finishSyn(raw || "", null, brandWork);
  }catch(err){
    live.remove();
    if (err && err.name === "AbortError"){ finishSyn(raw, "stopped", brandWork); }
    else finishSyn(raw, raw ? null : "net", brandWork);
  }
  busy = false;
  abortCtl = null;
  sendBtn.textContent = "↑"; sendBtn.classList.remove("stop"); sendBtn.title = "Send";
  renderThread();
}
function finishSyn(raw, errKind, brandWork){
  const t = thread();
  const b = brand();
  if (errKind === "stopped" && !(raw && raw.trim())){
    t.msgs.push({ role:"syn", text:"Stopped.", displayText:"Stopped.", rawText:"Stopped.", files:[], mode:"copy", verdict:null, needsApproval:false, at:new Date().toISOString() });
  } else if (errKind === "stopped"){
    const { clean, files, memories, aiTasks, aiEvents, aiDMs } = parseSpecial(raw);
    const madeS = ingestAITasks(aiTasks); const madeES = ingestAIEvents(aiEvents); ingestAIDMs(aiDMs);
    const display = (clean || (files.length ? "Your file is ready." : ((madeS || madeES) ? "Added to your workspace." : raw))) + "\n\n*(stopped early)*";
    t.msgs.push({ role:"syn", text: display, displayText: display, rawText: raw, files, savedMemories: memories, mode:"copy", verdict:null, needsApproval: (!!brandWork || files.length > 0), at:new Date().toISOString() });
    if (madeS) toast("SYN created " + madeS + " task" + (madeS > 1 ? "s" : "") + ".");
    if (madeES) toast("SYN scheduled " + madeES + " event" + (madeES > 1 ? "s" : "") + ".");
  } else if (errKind === "net"){
    t.msgs.push({ role:"syn", text:"The intelligence layer isn't reachable from here. Live generation runs in the Claude preview now, and everywhere once SYN Core is connected.", displayText:"The intelligence layer isn't reachable from here. Live generation runs in the Claude preview now, and everywhere once SYN Core is connected.", rawText:"", files:[], mode:"copy", verdict:null, needsApproval:false, at:new Date().toISOString() });
  } else if (!raw){
    t.msgs.push({ role:"syn", text:"SYN returned an empty response. Try rephrasing.", displayText:"SYN returned an empty response. Try rephrasing.", rawText:"", files:[], mode:"copy", verdict:null, needsApproval:false, at:new Date().toISOString() });
  } else {
    const { clean, files, memories, aiTasks, aiEvents, aiDMs } = parseSpecial(raw);
    if (memories.length){
      memories.forEach(mm => b.memories.push({ id: uid("m"), text: mm, by: currentUser.name, at: new Date().toISOString() }));
      saveBrands();
    }
    const made = ingestAITasks(aiTasks); const madeE = ingestAIEvents(aiEvents); const madeDM = ingestAIDMs(aiDMs);
    const display = clean || (files.length ? "Your file is ready." : ((made || madeE) ? "Added to your workspace." : raw));
    // Only content that ships needs a verdict: brand/campaign work (Smart mode) or a generated file.
    const needsApproval = (!!brandWork || files.length > 0);
    t.msgs.push({ role:"syn", text: display, displayText: display, rawText: raw, files, savedMemories: memories, mode:"copy", verdict:null, needsApproval, at:new Date().toISOString() });
    if (made) toast("SYN created " + made + " task" + (made > 1 ? "s" : "") + ".");
    if (madeE) toast("SYN scheduled " + madeE + " event" + (madeE > 1 ? "s" : "") + ".");
    if (needsApproval && typeof fireIntegrations === "function") fireIntegrations("approval", currentUser.name + " generated content for " + b.name + " awaiting approval");
  }
  t.updatedAt = new Date().toISOString();
  saveChats(activeBrandId);
  updatePendBadge();
}

/* ---------------- APPROVALS ---------------- */
// Only content that ships requires a verdict: imagery and brand/campaign copy (and generated files).
// General Q&A gets no approval UI. Legacy messages fall back to files/imagery so old items still show.
// Approvals now apply to generated IMAGERY ONLY (quiet approve/reject, still audit-logged).
// Text/chat/copy no longer carries an approval gate.
function needsVerdict(m){
  return !!(m && m.role === "syn" && m.mode === "image");
}
function pendingCount(){
  let n = 0;
  BRANDS.forEach(b => (CHATS[b.id] || []).filter(canSee).forEach(c => c.msgs.forEach(m => { if (needsVerdict(m) && !m.verdict) n++; })));
  return n;
}
function updatePendBadge(){
  const n = pendingCount();
  const badge = document.getElementById("pendBadge");
  if (!badge) return;
  badge.style.display = n ? "inline-block" : "none";
  badge.textContent = n;
}
function setVerdict(idx, approved){
  const t = thread();
  const m = t.msgs[idx];
  if (!m || m.verdict) return;
  m.verdict = approved ? "ap" : "rj";
  APPROVALS.unshift({ id: uid("a"), brand: brand().name, chat: t.name, user: currentUser.name, text: (m.displayText || m.text || "").slice(0, 400), approved, at: new Date().toISOString() });
  saveApprovals(); saveChats(activeBrandId);
  renderThread(); updatePendBadge();
}
/* The standalone Approvals PANEL was removed in the v3 migration — verdicts now happen inline in
   chat (setVerdict, above) and the audit trail is recorded in APPROVALS (surfaced as "Verdicts
   Logged" on the Portfolio dashboard and included in the workspace backup). The old renderApprovals/
   queueVerdict/exportApprovals wrote to a #apprPanel element that no longer exists and were
   unreachable (no nav, no view). Removed as dead code. */

/* ---------------- PROFILE ---------------- */
function renderProfile(){
  const b = brand();
  const p = document.getElementById("profilePanel");
  if (!b){ p.innerHTML = '<div class="empty-log">No brands encoded yet. ' + (isAdmin() ? "Use + Add in the sidebar to encode your first brand." : "Your Admin can encode the first brand.") + '</div>'; return; }
  let html = '<div class="panel-head"><div><h2>' + esc(b.name) + '</h2><p class="sub">' + esc(b.industry) + " · Encoded once. Enforced everywhere. Remembered forever.</p></div>" +
    (isAdmin() ? '<button class="head-btn" data-act="editBrand">Edit Profile</button>' : "") + "</div>";

  html += '<div class="spec-block"><div class="sb-head">Permanent Brand Memory <span style="color:var(--faint)">' + b.memories.length + ' saved</span></div><div class="sb-body">';
  if (!b.memories.length) html += '<div class="k-empty">Nothing yet. When you tell SYN lasting facts or decisions in any chat, it saves them here automatically. You can also count on it to carry corrections forward.</div>';
  else b.memories.slice().reverse().forEach(m => {
    html += '<div class="mem-chip"><span class="m-dot">◈</span><div style="flex:1">' + esc(m.text) +
      '<div class="m-meta">' + esc(m.by || "") + " · " + esc(fmtTime(m.at)) + '</div></div>' +
      '<button class="k-del" data-act="delMem" data-mid="' + m.id + '" aria-label="Forget">✕</button></div>';
  });
  html += "</div></div>";

  html += '<div class="spec-block"><div class="sb-head">Brand Knowledge Library <button class="add-btn" data-act="upKnow">+ Upload</button></div><div class="sb-body">';
  if (!b.knowledge.length) html += '<div class="k-empty">Upload brand guides, product sheets, past campaigns, packaging shots. Every chat for this brand draws on them.</div>';
  else b.knowledge.forEach((k, i) => {
    html += '<div class="k-row"><div class="k-ico">' + (k.kind === "image" ? "▣" : k.kind === "pdf" ? "⌘" : "≣") + '</div>' +
      '<div><div class="k-name">' + esc(k.name) + '</div><div class="k-meta">' + k.kind.toUpperCase() + " · " + fmtSize(k.size || 0) + (k.tooBig ? " · session only" : "") + '</div></div>' +
      '<button class="k-del" data-act="delKnow" data-i="' + i + '" aria-label="Remove">✕</button></div>';
  });
  html += '</div></div><input type="file" id="kInput" multiple style="display:none">';

  const blockHtml = (title, body) => '<div class="spec-block"><div class="sb-head">' + esc(title) + '</div><div class="sb-body">' + body + "</div></div>";
  html +=
    blockHtml("Voice & Tone", "<p>" + esc(b.voice) + "</p>") +
    blockHtml("Audience", "<p>" + esc(b.audience) + "</p>") +
    blockHtml("Palette", '<div class="swatch-row">' + b.palette.map(c => '<span class="swatch"><i style="background:' + esc(c.hex) + '"></i>' + esc(c.name) + " · " + esc(c.hex) + "</span>").join("") + "</div>") +
    blockHtml("Products", '<div class="tag-row">' + b.products.map(x => '<span class="tag">' + esc(x) + "</span>").join("") + "</div>") +
    blockHtml("Approved Claims", '<div class="tag-row">' + (b.approvedClaims.map(x => '<span class="tag ok">' + esc(x) + "</span>").join("") || '<span class="k-empty">None recorded</span>') + "</div>") +
    blockHtml("Banned Claims · Guardrails", '<div class="tag-row">' + (b.bannedClaims.map(x => '<span class="tag banned">' + esc(x) + "</span>").join("") || '<span class="k-empty">None recorded</span>') + "</div>") +
    blockHtml("Legal & Regulatory Constraints", "<p>" + esc(b.legal) + "</p>") +
    blockHtml("Imagery Style DNA", "<p>" + esc(b.imageStyle) + "</p>");
  p.innerHTML = html;
  const kIn = document.getElementById("kInput");
  if (kIn) kIn.onchange = function(){ handleFiles(this.files, "knowledge"); this.value = ""; };
}

