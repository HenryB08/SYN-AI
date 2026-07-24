/* ============================================================
   js/08-wiring.js — workspace click delegation (data-wact), bus subscriptions (wired once), EVENT WIRING, and the SHELL (theme + collapsible sidebar + focus mode). Ends with the boot() call that starts the app.
   MOVE, not a refactor: a byte-identical slice of the original inline <script>.
   Order-dependent. Loads after 07-calendar-views.js and before (load last). Shared global
   scope, not a module. Do not reorder these tags.
   ============================================================ */
/* =====================================================================
   STAGE 3 · SPACES (channels) + DIRECT MESSAGES + AI SPACES
   ===================================================================== */
let activeSpaceKind = null;                 // "space" | "dm"
let activeSpaceId = null;
let showArchived = false;
let spacePending = [];
let editingSpaceId = null, smDraft = null;
let SEEN = {};
let spacePollTimer = null;
let spaceBusy = false, spaceAbort = null;
const QUICK_EMOJI = ["👍","❤️","🎉","✅","😂","🔥"];

function msgKey(kind, id){ return (kind === "space" ? "space:" : "dm:") + id + ":msgs"; }
function loadThreadMsgs(kind, id){ return collLoad(msgKey(kind, id)); }
function threadMsgs(kind, id){ return collAll(msgKey(kind, id)); }
function isMember(s){ return s.members === "all" || (Array.isArray(s.members) && s.members.includes(currentUser.id)) || isAdmin(); }
function dmOther(rec){ return (rec.members || []).find(x => x !== currentUser.id); }
function dmName(rec){ return teamName(dmOther(rec)) || "Direct message"; }
function aiReady(){ return (typeof SYN_CORE_URL === "string" && SYN_CORE_URL.startsWith("http")) || persistMode === "cloud" || persistMode === "shared"; }
function escapeRe(s){ return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/* seen state (per user, device-local) */
async function loadSeen(){ SEEN = (await sGet(okey("seen:" + currentUser.id), false)) || {}; }
function saveSeen(){ saveSoon(okey("seen:" + currentUser.id), () => SEEN, false); }
function recFor(kind, id){ return kind === "space" ? Spaces.get(id) : DMs.get(id); }
function unreadFor(kind, id){ const rec = recFor(kind, id); const total = rec ? (rec.msgCount || 0) : 0; return Math.max(0, total - (SEEN[kind + ":" + id] || 0)); }
function markSeen(kind, id){ const rec = recFor(kind, id); const total = Math.max(rec ? (rec.msgCount || 0) : 0, threadMsgs(kind, id).length); SEEN[kind + ":" + id] = total; saveSeen(); }
function hasUnreadMention(spaceId){ return notifAllowed("mention") && Notifs.list(n => n.forUserId === currentUser.id && n.type === "mention" && !n.read && n.link && n.link.space === spaceId).length > 0; }
function clearSpaceMentions(spaceId){
  let changed = false;
  collAll("notifications").forEach(n => { if (n.forUserId === currentUser.id && n.type === "mention" && !n.read && n.link && n.link.space === spaceId){ n.read = true; changed = true; } });
  if (changed){ collSave("notifications"); BUS.emit("change:notifications", {}); renderBell(); }
}
function updateSpacesBadge(){
  const badge = document.getElementById("spacesBadge"); if (!badge || !currentUser) return;
  let n = 0;
  Spaces.list(s => isMember(s) && !s.archived).forEach(s => n += unreadFor("space", s.id));
  DMs.list(d => Array.isArray(d.members) && d.members.includes(currentUser.id)).forEach(d => n += unreadFor("dm", d.id));
  badge.style.display = n ? "inline-block" : "none"; badge.textContent = n > 99 ? "99+" : n;
}

/* ensure every workspace has a default General space; migrate legacy team chat once */
async function initSpaces(){
  if (Spaces.list().length) return;                      // never leave the workspace without a space
  const legacy = (!SETTINGS.spacesInit && TEAMCHAT && TEAMCHAT.length) ? TEAMCHAT : [];
  const gen = Spaces.create({ name:"General", icon:"◆", color:"#8E959F", description:"Workspace-wide team chat, open to everyone", type:"team", members:"all" });
  const key = msgKey("space", gen.id); await collLoad(key);
  coll(key).cache = legacy.map(m => ({ id: m.id || uid("m"), by:m.by, byId:m.byId, at:m.at, text:m.text, atts:[], reactions:{} }));
  collSave(key);
  Spaces.update(gen.id, { msgCount: legacy.length, lastMsgAt: legacy.length ? legacy[legacy.length-1].at : null });
  SETTINGS.spacesInit = true; saveSettings();
}

/* mentions */
function parseMentions(text){
  const ids = [];
  TEAM.forEach(u => { const first = u.name.split(" ")[0]; if (new RegExp("@" + escapeRe(first) + "\\b", "i").test(text)) ids.push(u.id); });
  return Array.from(new Set(ids));
}
function renderMentions(text){
  let h = esc(text);
  TEAM.forEach(u => { const first = u.name.split(" ")[0]; h = h.replace(new RegExp("@" + escapeRe(first) + "\\b", "gi"), '<span class="mention">@' + esc(first) + '</span>'); });
  return h;
}

/* rail */
function renderSpaceRail(){
  const el = document.getElementById("spaceRail"); if (!el) return;
  const spaces = Spaces.list(s => isMember(s) && (showArchived || !s.archived)).sort((a,b) => (a.createdAt < b.createdAt ? -1 : 1));
  const dms = DMs.list(d => Array.isArray(d.members) && d.members.includes(currentUser.id)).sort((a,b) => new Date(b.lastMsgAt || b.createdAt) - new Date(a.lastMsgAt || a.createdAt));
  let h = '<div class="space-sec"><span class="space-sec-lbl">Spaces</span>' + (isAdmin() ? '<button class="add-btn" data-wact="newSpace">+ New</button>' : "") + '</div><div class="space-list">';
  if (!spaces.length) h += '<div class="space-empty-rail">No spaces yet.' + (isAdmin() ? " Create one with + New." : " An admin can create the first space.") + '</div>';
  spaces.forEach(s => { const un = unreadFor("space", s.id); const men = hasUnreadMention(s.id);
    h += '<button class="space-item' + (activeSpaceKind === "space" && activeSpaceId === s.id ? " active" : "") + (s.archived ? " arch" : "") + (men ? " has-mention" : "") + '" data-wact="openSpace" data-id="' + s.id + '">' +
      '<span class="space-ico" style="--si:' + esc(s.color) + ';--si-soft:' + hexToSoft(s.color) + '">' + esc(s.icon || "◆") + '</span><span class="space-nm">' + esc(s.name) + '</span>' +
      (s.type === "ai" ? '<span class="space-ai-tag">AI</span>' : "") +
      (men ? '<span class="space-mention" title="You were mentioned">@</span>' : "") +
      (un ? '<span class="space-unread">' + un + '</span>' : "") + '</button>';
  });
  h += '</div><div class="space-sec"><span class="space-sec-lbl">Direct Messages</span><button class="add-btn" data-wact="newDM">+ New</button></div><div class="space-list">';
  if (!dms.length) h += '<div class="space-empty-rail">No direct messages yet.</div>';
  dms.forEach(d => { const other = dmOther(d), un = unreadFor("dm", d.id);
    h += '<button class="space-item' + (activeSpaceKind === "dm" && activeSpaceId === d.id ? " active" : "") + '" data-wact="openDM" data-id="' + d.id + '">' +
      '<span class="space-ico">' + esc(initials(teamName(other))) + '</span><span class="space-nm">' + esc(teamName(other)) + '</span>' + (un ? '<span class="space-unread">' + un + '</span>' : "") + '</button>';
  });
  h += '</div>';
  if (Spaces.list(s => isMember(s) && s.archived).length) h += '<div class="space-sec"><button class="add-btn" data-wact="toggleArchived">' + (showArchived ? "Hide archived" : "Show archived") + '</button></div>';
  el.innerHTML = h;
}

/* main pane */
function spaceEmptyMain(){
  return '<div class="space-empty-main">' + synMark(70, 'empty-mark') +
    '<h1 style="font-family:\'Inter\',sans-serif;font-size:20px;margin-bottom:8px">Spaces</h1>' +
    '<p style="max-width:380px">Channels for your team, plus AI spaces where the whole workspace talks to SYN. ' + (isAdmin() ? "Create your first space with + New." : "Pick a space on the left to start.") + '</p></div>';
}
function spaceComposerHtml(isAI){
  return '<div class="space-composer"><div class="composer"><div class="pending-strip" id="spacePending"></div>' +
    '<div class="input-shell"><button class="tool-btn" data-wact="spaceAttach" title="Attach files" aria-label="Attach">✦</button>' +
    '<textarea id="spaceInput" rows="1" placeholder="' + (isAI ? "Ask SYN — the whole team sees this…" : "Message the space…  use @name to mention") + '"></textarea>' +
    '<button class="send-btn" id="spaceSend" data-wact="spaceSend" aria-label="Send">↑</button></div>' +
    '<input type="file" id="spaceFile" multiple style="display:none"></div></div>';
}
function renderSpaceMain(){
  const main = document.getElementById("spaceMain"); if (!main) return;
  if (!activeSpaceKind){ main.innerHTML = spaceEmptyMain(); return; }
  const kind = activeSpaceKind, id = activeSpaceId, rec = recFor(kind, id);
  if (!rec){ activeSpaceKind = null; main.innerHTML = spaceEmptyMain(); return; }
  const isAI = kind === "space" && rec.type === "ai";
  const title = kind === "dm" ? dmName(rec) : rec.name;
  const icon = kind === "dm" ? initials(dmName(rec)) : (rec.icon || "◆");
  const archived = kind === "space" && rec.archived;
  const canPost = kind === "dm" || isMember(rec);
  const desc = kind === "dm" ? "Direct message · private"
    : (rec.description || (rec.members === "all" ? "Whole workspace" : (Array.isArray(rec.members) ? rec.members.length + " members" : "")));
  let head = '<div class="space-head"><div class="space-ico" style="--si:' + (kind === "dm" ? "var(--gold)" : esc(rec.color || "#8E959F")) + ';--si-soft:' + hexToSoft(kind === "dm" ? "#8E959F" : (rec.color || "#8E959F")) + '">' + esc(icon) + '</div>' +
    '<div class="space-head-info"><h3>' + esc(title) + (isAI ? ' <span class="space-ai-tag">AI</span>' : "") + (archived ? ' <span class="space-ai-tag" style="color:var(--muted);border-color:var(--glass-border-soft)">ARCHIVED</span>' : "") + '</h3>' +
    '<div class="sh-desc">' + esc(desc) + '</div></div><div class="space-head-acts">' +
    (kind === "space" && isAdmin() ? '<button class="mode-btn" data-wact="editSpace" data-id="' + id + '">Manage</button>' : "") +
    (isAI ? '<span class="mode-hint" style="margin:0">' + (aiReady() ? "Full SYN · web + files" : "AI offline") + '</span>' : "") + '</div></div>';
  const msgs = '<div class="space-msgs" id="spaceMsgs"><div class="space-msgs-inner" id="spaceMsgsInner"></div></div>';
  const composer = archived ? '<div class="space-composer"><div class="composer"><div class="space-empty-rail" style="text-align:center">This space is archived. Unarchive it from Manage to post again.</div></div></div>'
    : (canPost ? spaceComposerHtml(isAI) : '<div class="space-composer"><div class="composer"><div class="space-empty-rail" style="text-align:center">You are not a member of this space.</div></div></div>');
  main.innerHTML = head + msgs + composer;
  renderSpaceThread();
  if (canPost && !archived) wireSpaceComposer();
}
function attChipHtml(a){
  if (a.kind === "image" && a.data) return '<img class="att-thumb" src="data:' + a.media + ';base64,' + a.data + '" alt="' + esc(a.name) + '">';
  return '<span class="att-chip"><span class="a-ico">' + (a.kind === "pdf" ? "⌘" : "≣") + '</span>' + esc(a.name) + '</span>';
}
function renderReactions(m){
  const r = m.reactions || {}; let pills = "";
  Object.keys(r).forEach(em => { const users = r[em] || []; if (!users.length) return; const mine = users.includes(currentUser.id);
    pills += '<button class="react-pill' + (mine ? " mine" : "") + '" data-wact="react" data-mid="' + m.id + '" data-emoji="' + em + '" title="' + esc(users.map(teamName).join(", ")) + '">' + em + ' ' + users.length + '</button>'; });
  const pal = QUICK_EMOJI.map(em => '<button data-wact="react" data-mid="' + m.id + '" data-emoji="' + em + '">' + em + '</button>').join("");
  return pills + '<span class="react-wrap"><button class="react-add" data-wact="reactAdd" title="React">＋</button><span class="react-palette">' + pal + '</span></span>';
}
function spaceMsgHtml(m){
  if (m.note === "ai-offline") return '<div class="ai-offline-note">◍ SYN is offline · this space still works as a normal channel</div>';
  const isSyn = m.role === "syn";
  const mine = !isSyn && m.byId === currentUser.id;
  const av = isSyn ? '<div class="avatar">S</div>' : avatarBig(m.byId);
  let h = '<div class="tmsg' + (mine ? " me" : "") + (isSyn ? " syn" : "") + '">' + av + '<div class="tmsg-b">' +
    '<div class="tmsg-h">' + esc(m.by || "") + ' · ' + esc(fmtTime(m.at)) + '</div>';
  if ((m.atts || []).length) h += '<div class="tmsg-atts">' + m.atts.map(attChipHtml).join("") + '</div>';
  const body = m.displayText != null ? m.displayText : (m.text || "");
  if (body) h += isSyn ? '<div class="tmsg-t md">' + renderMD(body) + '</div>' : '<div class="tmsg-t">' + renderMentions(body) + '</div>';
  (m.files || []).forEach((f, fi) => {
    h += '<div class="file-card" style="margin-top:8px"><div class="fc-ico">.' + esc(extOf(f.name) || "txt") + '</div>' +
      '<div><div class="fc-name">' + esc(f.name) + '</div><div class="fc-meta">Generated by SYN</div></div>' +
      '<div class="fc-btns"><button class="fc-prev" data-wact="spFilePrev" data-mid="' + m.id + '" data-fi="' + fi + '">Preview</button>' +
      '<button class="fc-dl" data-wact="spFileDl" data-mid="' + m.id + '" data-fi="' + fi + '">Download</button></div></div>';
  });
  h += '<div class="msg-react">' + renderReactions(m) + '</div></div></div>';
  return h;
}
function renderSpaceThread(){
  const inner = document.getElementById("spaceMsgsInner"); if (!inner) return;
  const arr = threadMsgs(activeSpaceKind, activeSpaceId);
  inner.innerHTML = arr.length ? arr.map(spaceMsgHtml).join("") : '<div class="space-empty-rail" style="text-align:center;padding:40px">No messages yet. Say hello.</div>';
  inner.querySelectorAll("pre").forEach(pre => { const b = document.createElement("button"); b.className = "copy-code"; b.textContent = "Copy"; b.onclick = () => { copyText(pre.innerText); b.textContent = "Copied"; setTimeout(() => b.textContent = "Copy", 1400); }; pre.appendChild(b); });
  scrollSpace();
}
function scrollSpace(){ const sc = document.getElementById("spaceMsgs"); if (sc) requestAnimationFrame(() => { sc.scrollTop = sc.scrollHeight; }); }
function wireSpaceComposer(){
  const inp = document.getElementById("spaceInput");
  if (inp){ inp.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey){ e.preventDefault(); sendSpaceMsg(); } }); inp.addEventListener("input", function(){ this.style.height = "auto"; this.style.height = Math.min(this.scrollHeight, 150) + "px"; }); inp.focus(); }
  const fi = document.getElementById("spaceFile"); if (fi) fi.onchange = function(){ spaceAttachFiles(this.files); this.value = ""; };
}
function renderSpacePending(){
  const el = document.getElementById("spacePending"); if (!el) return;
  el.innerHTML = spacePending.map((a, i) => '<span class="p-chip"><span class="a-ico">' + (a.kind === "image" ? "▣" : a.kind === "pdf" ? "⌘" : "≣") + '</span>' + esc(a.name) + '<button class="p-x" data-wact="spaceUnatt" data-i="' + i + '" aria-label="Remove">✕</button></span>').join("");
}
function spaceAttachFiles(fileList){
  Array.from(fileList).forEach(f => {
    if (f.size > 4.5 * 1048576){ toast(f.name + " is over 4.5 MB."); return; }
    const r = new FileReader();
    const push = o => { spacePending.push(o); renderSpacePending(); };
    if (f.type.startsWith("image/")){ r.onload = () => push({ kind:"image", name:f.name, media:f.type, data:r.result.split(",")[1], size:f.size }); r.readAsDataURL(f); }
    else if (f.type === "application/pdf"){ r.onload = () => push({ kind:"pdf", name:f.name, media:"application/pdf", data:r.result.split(",")[1], size:f.size }); r.readAsDataURL(f); }
    else { r.onload = () => push({ kind:"text", name:f.name, text:String(r.result).slice(0, 40000), size:f.size }); r.readAsText(f); }
  });
}
async function openThread(kind, id){
  activeSpaceKind = kind; activeSpaceId = id; spacePending = [];
  await loadThreadMsgs(kind, id);
  markSeen(kind, id);
  if (kind === "space") clearSpaceMentions(id);
  renderSpaceMain(); renderSpaceRail(); updateSpacesBadge();
  if (window.innerWidth <= 900) document.getElementById("sidebar").classList.remove("open");
}
function renderSpaces(){
  renderSpaceRail();
  if (!activeSpaceKind){
    const spaces = Spaces.list(s => isMember(s) && !s.archived).sort((a,b) => (a.createdAt < b.createdAt ? -1 : 1));
    if (spaces.length){ openThread("space", spaces[0].id); return; }
  }
  renderSpaceMain();
}

/* posting */
function bumpThreadRecord(kind, id, msg){
  const rec = recFor(kind, id); if (!rec) return;
  const patch = { msgCount:(rec.msgCount || 0) + 1, lastMsgAt: msg.at, lastMsgBy: msg.byId };
  if (kind === "space") Spaces.update(id, patch); else DMs.update(id, patch);
}
function postHumanMessage(kind, id, text, atts){
  const rec = recFor(kind, id); if (!rec) return null;
  const mentions = kind === "space" ? parseMentions(text) : [];
  const m = { id:uid("m"), by:currentUser.name, byId:currentUser.id, at:nowISO(), text, atts:atts || [], reactions:{}, mentions };
  const key = msgKey(kind, id); const arr = collAll(key); arr.push(m); if (arr.length > 800) arr.splice(0, arr.length - 800); collSave(key);
  bumpThreadRecord(kind, id, m);
  if (kind === "dm"){ const other = dmOther(rec); if (other && other !== currentUser.id) notify(other, "dm", currentUser.name + ": " + text.slice(0, 60), { view:"spaces", dm:id }); }
  mentions.forEach(uid2 => { if (uid2 !== currentUser.id){ notify(uid2, "mention", currentUser.name + " mentioned you in " + rec.name + ": " + text.slice(0, 50), { view:"spaces", space:id }); fireIntegrations("mention", currentUser.name + " mentioned " + teamName(uid2) + " in " + rec.name + ": " + text.slice(0, 80)); } });
  markSeen(kind, id);
  renderSpaceThread(); renderSpaceRail(); updateSpacesBadge();
  return m;
}
function sendSpaceMsg(){
  const inp = document.getElementById("spaceInput"); if (!inp) return;
  const text = (inp.value || "").trim(); const atts = spacePending;
  if (!text && !atts.length) return;
  inp.value = ""; inp.style.height = "auto";
  const kind = activeSpaceKind, id = activeSpaceId;
  const space = kind === "space" ? Spaces.get(id) : null;
  spacePending = []; renderSpacePending();
  postHumanMessage(kind, id, text || "(files attached)", atts);
  if (space && space.type === "ai" && !spaceBusy) spaceGenerate(space, atts);
}
function toggleReaction(kind, id, mid, emoji){
  const key = msgKey(kind, id); const m = collAll(key).find(x => x.id === mid); if (!m) return;
  m.reactions = m.reactions || {};
  const u = m.reactions[emoji] = m.reactions[emoji] || [];
  const i = u.indexOf(currentUser.id);
  if (i >= 0) u.splice(i, 1); else u.push(currentUser.id);
  if (!u.length) delete m.reactions[emoji];
  collSave(key); renderSpaceThread();
}

/* AI space generation (full SYN, shared thread) */
function generalSpacePrompt(space){
  return "You are SYN, Syntrex's brand intelligence assistant, posting in the shared team space \"" + space.name + "\" that the whole workspace can see. You have live web search and can produce downloadable files by wrapping them EXACTLY as [[FILE:filename.ext]]\\ncontent\\n[[/FILE]]. Answer with clean markdown, be concise and useful, and never use em dashes.";
}
function buildUserContent(m){
  const blocks = [];
  (m.atts || []).forEach(a => {
    if (a.stub) blocks.push({ type:"text", text:"[A file named " + a.name + " was attached earlier but is no longer available.]" });
    else if (a.kind === "image") blocks.push({ type:"image", source:{ type:"base64", media_type:a.media, data:a.data } });
    else if (a.kind === "pdf") blocks.push({ type:"document", source:{ type:"base64", media_type:"application/pdf", data:a.data } });
    else blocks.push({ type:"text", text:"[Attached file: " + a.name + "]\n" + (a.text || "") });
  });
  blocks.push({ type:"text", text:(m.by ? m.by + ": " : "") + (m.text || "") });
  return blocks;
}
async function spaceGenerate(space){
  const key = msgKey("space", space.id);
  const b = space.brandId ? BRANDS.find(x => x.id === space.brandId) : brand();
  const sCap = modelPick === "smart" ? "smart" : "fast";
  const sGate = gateAI(sCap, "space");   // AI spaces were unmetered — now gated like every other AI call
  if (!sGate.ok){
    const inner0 = document.getElementById("spaceMsgsInner");
    if (inner0){ const n = document.createElement("div"); n.className = "ai-offline-note"; n.textContent = "◍ " + sGate.reason; inner0.appendChild(n); scrollSpace(); }
    return;
  }
  if (sGate.reason) toast(sGate.reason);
  spaceBusy = true; spaceAbort = new AbortController();
  const inner = document.getElementById("spaceMsgsInner");
  const live = document.createElement("div"); live.className = "tmsg syn";
  live.innerHTML = '<div class="avatar">S</div><div class="tmsg-b"><div class="tmsg-h">SYN' + (b ? " · " + esc(b.name) : "") + '</div><div class="tmsg-t syn-live"><span class="s-dot"></span> Thinking…</div></div>';
  if (inner) inner.appendChild(live);
  scrollSpace();
  const liveTxt = live.querySelector(".syn-live");
  // Cost fix: window the thread instead of replaying the entire space (was unbounded — up to 800 msgs/call).
  const history = collAll(key).filter(m => !m.note).slice(-SPACE_HISTORY_WINDOW).map(m => m.role === "syn" ? { role:"assistant", content: m.rawText || m.text || " " } : { role:"user", content: buildUserContent(m) });
  let raw = "";
  try{
    const res = await fetch(apiBase() + "/v1/messages", {
      method:"POST", headers:{ "Content-Type":"application/json", ...gateHeaders() }, signal: spaceAbort.signal,
      body: JSON.stringify({ model: MODELS[sGate.downgrade ? "fast" : (modelPick || "smart")] || MODELS.smart, max_tokens: AI_MAX_TOKENS.space, stream:true, system: b ? buildSystemPrompt(b) : generalSpacePrompt(space), messages: history, tools:[{ type:"web_search_20250305", name:"web_search" }] })
    });
    if (!res.ok || !res.body) throw new Error("net");
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
    while (true){
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream:true }); const lines = buf.split("\n"); buf = lines.pop();
      for (const line of lines){ if (!line.startsWith("data:")) continue; const p = line.slice(5).trim(); if (!p) continue; let ev; try{ ev = JSON.parse(p); }catch(e){ continue; }
        if (ev.type === "content_block_start"){ const cb = ev.content_block || {}; if (cb.type === "server_tool_use" && liveTxt) liveTxt.innerHTML = '<span class="s-dot"></span> Searching the web…'; }
        else if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta"){ raw += ev.delta.text; if (liveTxt){ const vis = raw.replace(/\[\[[\s\S]*$/, "").trim(); if (vis){ liveTxt.classList.add("md"); liveTxt.innerHTML = renderMD(vis); scrollSpace(); } } }
      }
    }
    raw = raw.trim(); live.remove(); finishSpaceSyn(space, raw, null);
  }catch(err){
    live.remove();
    if (err && err.name === "AbortError") finishSpaceSyn(space, raw, raw ? null : "stopped");
    else finishSpaceSyn(space, raw, raw ? null : "net");
  }
  spaceBusy = false; spaceAbort = null;
}
function finishSpaceSyn(space, raw, errKind){
  const key = msgKey("space", space.id); const arr = collAll(key);
  const b = space.brandId ? BRANDS.find(x => x.id === space.brandId) : brand();
  if (errKind === "net"){ const inner = document.getElementById("spaceMsgsInner"); if (inner){ const n = document.createElement("div"); n.className = "ai-offline-note"; n.innerHTML = "◍ SYN is offline · this space still works as a normal channel"; inner.appendChild(n); scrollSpace(); } return; }
  if (errKind === "stopped" && !raw) return;
  if (!raw){ return; }
  const { clean, files, memories, aiTasks, aiEvents, aiDMs } = parseSpecial(raw);
  if (memories.length && b){ memories.forEach(mm => b.memories.push({ id:uid("m"), text:mm, by:"SYN · " + space.name, at:nowISO() })); saveBrands(); }
  ingestAITasks(aiTasks); ingestAIEvents(aiEvents); ingestAIDMs(aiDMs);
  const display = clean || (files.length ? "Your file is ready." : raw);
  const m = { id:uid("m"), role:"syn", by:"SYN", byId:"syn", at:nowISO(), text:display, displayText:display, rawText:raw, files, reactions:{} };
  arr.push(m); if (arr.length > 800) arr.splice(0, arr.length - 800); collSave(key);
  bumpThreadRecord("space", space.id, m); markSeen("space", space.id);
  renderSpaceThread(); renderSpaceRail(); updateSpacesBadge();
}

/* space modal */
function openSpaceModal(id){
  if (!isAdmin()){ toast("Only admins manage spaces."); return; }
  const s = id ? Spaces.get(id) : null; editingSpaceId = id && s ? id : null;
  smDraft = s ? JSON.parse(JSON.stringify(s)) : { name:"", icon:"◆", color:"#8E959F", description:"", type:"team", brandId:(BRANDS[0] ? BRANDS[0].id : null), members:"all", archived:false };
  document.getElementById("smTitle").textContent = s ? "Manage space" : "New space";
  const arch = document.getElementById("smArchive");
  arch.style.display = s ? "block" : "none"; arch.textContent = s && s.archived ? "Unarchive" : "Archive"; arch.dataset.armed = "";
  renderSpaceModalBody();
  document.getElementById("spaceVeil").classList.add("open");
}
function syncSpaceHeader(){
  if (!smDraft) return;
  const g = id => { const el = document.getElementById(id); return el ? el.value : undefined; };
  if (g("smName") !== undefined) smDraft.name = g("smName");
  if (g("smDesc") !== undefined) smDraft.description = g("smDesc");
  if (g("smColor") !== undefined){ const h = normHex(g("smColor")); if (h) smDraft.color = h; }
  if (g("smType") !== undefined) smDraft.type = g("smType");
  if (g("smBrand") !== undefined) smDraft.brandId = g("smBrand") || null;
  const mode = g("smMemMode");
  if (mode !== undefined){ if (mode === "all") smDraft.members = "all"; else if (!Array.isArray(smDraft.members)) smDraft.members = [currentUser.id]; }
}
function renderSpaceModalBody(){
  const s = smDraft; const body = document.getElementById("smBody");
  const ICONS = ["◆","◎","★","✦","⬡","▲","●","✳","☀","♦","☺","⚑"];
  const opt = (v, cur, l) => '<option value="' + v + '"' + (v === cur ? " selected" : "") + '>' + l + '</option>';
  const memMode = s.members === "all" ? "all" : "subset";
  let h = '<label class="f-label" for="smName">Name</label><input class="f-input" id="smName" value="' + esc(s.name) + '">';
  h += '<label class="f-label">Icon</label><div class="icon-pick">' + ICONS.map(ic => '<button type="button" class="' + (s.icon === ic ? "on" : "") + '" data-wact="smIcon" data-ic="' + ic + '">' + ic + '</button>').join("") + '</div>';
  h += '<label class="f-label" for="smColor">Color</label><div class="color-row"><input type="color" id="smColorPick" value="' + (normHex(s.color) || "#8E959F") + '"><input class="f-input" id="smColor" value="' + esc(s.color) + '" style="flex:1"></div>';
  h += '<label class="f-label" for="smDesc">Description</label><textarea class="f-area" id="smDesc">' + esc(s.description || "") + '</textarea>';
  h += '<label class="f-label" for="smType">Type</label><select class="f-input" id="smType">' + opt("team", s.type, "Team · humans") + opt("ai", s.type, "AI · the whole team talks to SYN") + '</select>';
  if (s.type === "ai") h += '<label class="f-label" for="smBrand">Brand lock</label><select class="f-input" id="smBrand">' + (BRANDS.length ? BRANDS.map(b => opt(b.id, s.brandId || "", b.name)).join("") : '<option value="">General (no brand encoded yet)</option>') + '</select><div class="f-hint">This AI space answers as this brand, with its voice, guardrails, and memory.</div>';
  h += '<label class="f-label" for="smMemMode">Membership</label><select class="f-input" id="smMemMode">' + opt("all", memMode, "Whole workspace") + opt("subset", memMode, "Selected members") + '</select>';
  if (memMode === "subset") h += '<div class="mem-toggle-chips">' + TEAM.map(u => { const on = u.id === currentUser.id || (Array.isArray(s.members) && s.members.includes(u.id)); return '<button type="button" class="mem-chip-pick' + (on ? " on" : "") + '" data-wact="smMember" data-uid="' + u.id + '">' + avatarHtml(u.id) + esc(u.name.split(" ")[0]) + '</button>'; }).join("") + '</div>';
  body.innerHTML = h;
  const cp = document.getElementById("smColorPick"), ct = document.getElementById("smColor");
  if (cp && ct){ cp.addEventListener("input", () => { ct.value = cp.value.toUpperCase(); smDraft.color = ct.value; }); ct.addEventListener("input", () => { const hh = normHex(ct.value); if (hh){ cp.value = hh; smDraft.color = hh; } }); }
  const ty = document.getElementById("smType"); if (ty) ty.addEventListener("change", () => { syncSpaceHeader(); renderSpaceModalBody(); });
  const mm = document.getElementById("smMemMode"); if (mm) mm.addEventListener("change", () => { syncSpaceHeader(); renderSpaceModalBody(); });
}
function saveSpaceModal(){
  if (!isAdmin()) return;
  syncSpaceHeader();
  if (!smDraft.name.trim()){ document.getElementById("smName").focus(); return; }
  if (smDraft.type === "ai" && BRANDS.length && !smDraft.brandId) smDraft.brandId = BRANDS[0].id;
  if (editingSpaceId){ Spaces.update(editingSpaceId, smDraft); if (activeSpaceKind === "space" && activeSpaceId === editingSpaceId) renderSpaceMain(); }
  else { const sp = Spaces.create(smDraft); logActivity("space", currentUser.name + " created space " + sp.name, "space", sp.id); document.getElementById("spaceVeil").classList.remove("open"); renderSpaceRail(); openThread("space", sp.id); toast("Space created."); return; }
  document.getElementById("spaceVeil").classList.remove("open");
  renderSpaceRail(); toast("Space saved.");
}
function archiveSpaceNow(){
  const s = Spaces.get(editingSpaceId); if (!s) return;
  if (s.archived){ Spaces.update(s.id, { archived:false }); document.getElementById("spaceVeil").classList.remove("open"); renderSpaceRail(); renderSpaceMain(); toast("Space unarchived."); return; }
  const btn = document.getElementById("smArchive");
  if (!btn.dataset.armed){ btn.dataset.armed = "1"; btn.textContent = "Click again to archive"; setTimeout(() => { btn.dataset.armed = ""; btn.textContent = "Archive"; }, 3000); return; }
  Spaces.update(s.id, { archived:true });
  document.getElementById("spaceVeil").classList.remove("open");
  if (activeSpaceKind === "space" && activeSpaceId === s.id) activeSpaceKind = null;
  renderSpaces(); toast("Space archived.");
}

/* direct messages */
function openDMPicker(){
  const body = document.getElementById("dmBody");
  const others = TEAM.filter(u => u.id !== currentUser.id);
  body.innerHTML = others.length ? others.map(u => '<button class="dm-pick-row" data-wact="startDM" data-uid="' + u.id + '">' + avatarHtml(u.id) + '<div><div class="k-name">' + esc(u.name) + '</div><div class="k-meta">' + esc(u.email) + '</div></div></button>').join("") : '<div class="space-empty-rail">No teammates yet. Invite your team from Settings.</div>';
  document.getElementById("dmVeil").classList.add("open");
}
function startDM(otherId){
  let dm = DMs.list(d => Array.isArray(d.members) && d.members.length === 2 && d.members.includes(currentUser.id) && d.members.includes(otherId))[0];
  if (!dm) dm = DMs.create({ members:[currentUser.id, otherId], msgCount:0 });
  document.getElementById("dmVeil").classList.remove("open");
  openThread("dm", dm.id);
}

/* poll open thread messages (8s, pauses when hidden) */
async function activeThreadSyncOnce(){
  if (!ORG) return;
  if (activeSpaceKind && viewIs("spaces") && !spaceBusy){
    const key = msgKey(activeSpaceKind, activeSpaceId);
    if (!collDirty.has(key)){
      const fresh = (await sGet(okey(key))) || [];
      const cur = coll(key).cache || [];
      if (fresh.length !== cur.length || JSON.stringify(fresh) !== JSON.stringify(cur)){ coll(key).cache = fresh; markSeen(activeSpaceKind, activeSpaceId); renderSpaceThread(); }
    }
  }
  updateSpacesBadge();
}
// The thread you're actively looking at polls faster (3s) so new posts land quickly; the rest of
// the workspace stays on the 8s poll. Both pause when the tab is hidden, so we don't hammer the backend.
function startSpacePoll(){
  clearInterval(spacePollTimer);
  spacePollTimer = setInterval(() => { if (ORG && !document.hidden) activeThreadSyncOnce(); }, 3000);
}
// Coming back to the tab shouldn't wait for the next tick: resync everything immediately on focus.
let _focusSyncAt = 0;
function resyncOnFocus(){
  if (!ORG || document.hidden) return;
  const now = Date.now();
  if (now - _focusSyncAt < 1000) return;                 // debounce focus+visibilitychange double-fire
  _focusSyncAt = now;
  wsSyncOnce(); activeThreadSyncOnce();
}
window.addEventListener("focus", resyncOnFocus);
document.addEventListener("visibilitychange", () => { if (!document.hidden) resyncOnFocus(); });

/* spaces click delegation */
document.addEventListener("click", e => {
  const w = e.target.closest("[data-wact]"); if (!w) return;
  const a = w.dataset.wact;
  if (a === "openSpace"){ openThread("space", w.dataset.id); return; }
  if (a === "openDM"){ openThread("dm", w.dataset.id); return; }
  if (a === "newSpace"){ openSpaceModal(null); return; }
  if (a === "editSpace"){ openSpaceModal(w.dataset.id); return; }
  if (a === "newDM"){ openDMPicker(); return; }
  if (a === "startDM"){ startDM(w.dataset.uid); return; }
  if (a === "toggleArchived"){ showArchived = !showArchived; renderSpaceRail(); return; }
  if (a === "spaceAttach"){ const fi = document.getElementById("spaceFile"); if (fi) fi.click(); return; }
  if (a === "spaceUnatt"){ spacePending.splice(+w.dataset.i, 1); renderSpacePending(); return; }
  if (a === "spaceSend"){ if (spaceBusy && spaceAbort){ spaceAbort.abort(); } else sendSpaceMsg(); return; }
  if (a === "react"){ toggleReaction(activeSpaceKind, activeSpaceId, w.dataset.mid, w.dataset.emoji); return; }
  if (a === "reactAdd"){ const wrap = w.closest(".react-wrap"); if (wrap) wrap.classList.toggle("on"); return; }
  if (a === "spFilePrev"){ const m = threadMsgs(activeSpaceKind, activeSpaceId).find(x => x.id === w.dataset.mid); if (m && m.files) doPreview(m.files[+w.dataset.fi]); return; }
  if (a === "spFileDl"){ const m = threadMsgs(activeSpaceKind, activeSpaceId).find(x => x.id === w.dataset.mid); if (m && m.files) doDownload(m.files[+w.dataset.fi]); return; }
  if (a === "smIcon"){ syncSpaceHeader(); smDraft.icon = w.dataset.ic; renderSpaceModalBody(); return; }
  if (a === "smMember"){ syncSpaceHeader(); if (!Array.isArray(smDraft.members)) smDraft.members = [currentUser.id]; const id = w.dataset.uid; if (id === currentUser.id) return; const i = smDraft.members.indexOf(id); if (i >= 0) smDraft.members.splice(i, 1); else smDraft.members.push(id); renderSpaceModalBody(); return; }
});

/* ---------- workspace click delegation (data-wact) ---------- */
document.addEventListener("click", e => {
  const w = e.target.closest("[data-wact]");
  if (!w) return;
  const a = w.dataset.wact;
  if (a === "calView"){ calView = w.dataset.v; renderCalendar(); return; }
  if (a === "calNav"){ const dir = +w.dataset.dir; if (calView === "month") calCursor.setMonth(calCursor.getMonth() + dir); else calCursor.setDate(calCursor.getDate() + dir * (calView === "day" ? 1 : 7)); renderCalendar(); return; }
  if (a === "calToday"){ calCursor = (() => { const d = new Date(); d.setHours(0,0,0,0); return d; })(); renderCalendar(); return; }
  if (a === "calDay"){ calView = "day"; calCursor = dparse(w.dataset.d); renderCalendar(); return; }   // clicking any date opens the Day view
  if (a === "calSlot"){ openEventModal(null, w.dataset.d); if (w.dataset.t && typeof evDraft === "object" && evDraft){ evDraft.allDay = false; evDraft.startTime = w.dataset.t; const eh = String(Math.min(23, (parseInt(w.dataset.t,10)||9)+1)).padStart(2,"0")+":00"; evDraft.endTime = eh; renderEventModal(); } return; }
  if (a === "openEvent"){ openEventModal(w.dataset.eid); return; }
  if (a === "openTaskCal"){ openTaskModal(w.dataset.tid); return; }
  if (a === "newEvent"){ openEventModal(null, todayISO()); return; }
  if (a === "exportAllIcs"){ exportAllIcs(); return; }
  if (a === "evAllDay"){ syncEventHeader(); evDraft.allDay = !evDraft.allDay; renderEventModal(); return; }
  if (a === "evAttend"){ syncEventHeader(); const id = w.dataset.uid; const has = (evDraft.attendees || []).includes(id); evDraft.attendees = has ? evDraft.attendees.filter(x => x !== id) : (evDraft.attendees || []).concat(id); renderEventModal(); return; }
  if (a === "evGoogle"){ syncEventHeader(); if (!evDraft.title.trim()){ toast("Give the event a title first."); return; } window.open(googleUrl(evDraft), "_blank", "noopener"); return; }
  if (a === "evIcs"){ syncEventHeader(); if (!evDraft.title.trim()){ toast("Give the event a title first."); return; } exportEventIcs(evDraft); return; }
});

/* ---------- workspace click delegation (data-wact) ---------- */
document.addEventListener("click", e => {
  const w = e.target.closest("[data-wact]");
  if (!w) return;
  const a = w.dataset.wact;
  if (a === "openNotif"){ openNotification(w.dataset.nid); return; }
  if (a === "projFilter"){ taskFilter.project = w.dataset.pid; renderProjectsNav(); setView("tasks"); return; }
  if (a === "personFilter"){ taskFilter.assignee = w.dataset.uid; if (taskView === "completed") taskView = "board"; renderProjectsNav(); renderTasks(); setView("tasks"); return; }
  if (a === "newProject"){ openProjectModal(null); return; }
  if (a === "setStatus"){ e.stopPropagation(); setTaskStatus(w.dataset.tid, w.dataset.st); return; }
  if (a === "reopenTask"){ e.stopPropagation(); setTaskStatus(w.dataset.tid, "todo"); return; }
  if (a === "taskView"){ taskView = w.dataset.v; if (taskView !== "completed" && taskView !== "mine" && taskView !== "board" && taskView !== "list") taskView = "board"; renderProjectsNav(); renderTasks(); return; }
  if (a === "myScope"){ myScope = w.dataset.s; renderTasks(); return; }
  if (a === "newTask"){ const t = Tasks.create({ title:"", status:"todo" }); openTaskModal(t.id); return; }
  if (a === "planProject"){ openPlanModal(); return; }
  if (a === "filter"){ return; }              // handled on change
  if (a === "clearFilters"){ taskFilter = { project:taskFilter.project, assignee:"", priority:"", label:"", sort:"manual" }; renderTasks(); renderProjectsNav(); return; }
  if (a === "quickAdd") return;               // handled on Enter
  if (a === "openTask"){ if (e.target.closest("[data-wact]") === w) openTaskModal(w.dataset.tid); return; }
  if (a === "toggleDone"){ e.stopPropagation(); toggleDone(w.dataset.tid); return; }
  if (a === "assign"){ toggleAssignee(w.dataset.uid); return; }
  if (a === "delLabel"){ const t = Tasks.get(editingTaskId); syncTaskHeader(); t.labels = (t.labels || []).filter(l => l !== w.dataset.l); Tasks.update(t.id, { labels:t.labels }); renderTaskModalBody(); return; }
  if (a === "subToggle"){ const t = Tasks.get(editingTaskId); syncTaskHeader(); const s = (t.subtasks || []).find(x => x.id === w.dataset.sid); if (s) s.done = !s.done; Tasks.update(t.id, { subtasks:t.subtasks }); renderTaskModalBody(); return; }
  if (a === "subDel"){ const t = Tasks.get(editingTaskId); syncTaskHeader(); t.subtasks = (t.subtasks || []).filter(x => x.id !== w.dataset.sid); Tasks.update(t.id, { subtasks:t.subtasks }); renderTaskModalBody(); return; }
  if (a === "attAdd"){ document.getElementById("tmFile").click(); return; }
  if (a === "attDel"){ const t = Tasks.get(editingTaskId); syncTaskHeader(); t.attachments = (t.attachments || []).filter((_, i) => i !== +w.dataset.i); Tasks.update(t.id, { attachments:t.attachments }); renderTaskModalBody(); return; }
  if (a === "openLinkedChat"){ const t = Tasks.get(editingTaskId); if (t && t.linkedChatId){ document.getElementById("taskVeil").classList.remove("open"); selectBrand(t.linkedBrandId || activeBrandId).then(() => { const b = brand(); if (b){ b._activeThread = t.linkedChatId; renderChatList(); renderThread(); setView("chat"); } }); } return; }
});
document.addEventListener("keydown", e => {
  if (e.key !== "Enter") return;
  const qa = e.target.closest("[data-wact='quickAdd']");
  if (qa){ e.preventDefault(); quickAddTask(qa.dataset.status, qa.value); qa.value = ""; return; }
});
document.addEventListener("change", e => {
  const f = e.target.closest("[data-wact='filter']");
  if (f){ taskFilter[f.dataset.k] = f.value; renderTasks(); renderProjectsNav(); return; }
  const lc = e.target.closest("[data-wact='linkChat']");
  if (lc){ const t = Tasks.get(editingTaskId); if (t){ syncTaskHeader(); t.linkedChatId = lc.value || null; t.linkedBrandId = lc.value ? activeBrandId : null; Tasks.update(t.id, { linkedChatId:t.linkedChatId, linkedBrandId:t.linkedBrandId }); renderTaskModalBody(); } return; }
});

/* ---------- bus subscriptions (wire once) ---------- */
let busWired = false;
function wireWorkspaceBus(){
  if (busWired) return; busWired = true;
  BUS.on("change:tasks", () => { if (viewIs("tasks")) renderTasks(); if (viewIs("calendar")) renderCalendar(); renderProjectsNav(); updateTasksBadge(); });
  BUS.on("change:projects", () => { renderProjectsNav(); if (viewIs("tasks")) renderTasks(); if (viewIs("settings")) renderSettings(); });
  BUS.on("change:events", () => { if (viewIs("calendar")) renderCalendar(); });
  BUS.on("change:spaces", () => { if (viewIs("spaces")) renderSpaceRail(); updateSpacesBadge(); if (viewIs("settings")) renderSettings(); });
  BUS.on("change:dms", () => { if (viewIs("spaces")) renderSpaceRail(); updateSpacesBadge(); });
  BUS.on("change:notifications", () => { renderBell(); if (viewIs("spaces")) renderSpaceRail(); });
  BUS.on("change:profiles", () => { refreshMyAvatar(); applyPersonalAccent(); if (viewIs("people")) renderPeople(); if (viewIs("spaces")) renderSpaceThread(); if (viewIs("tasks")) renderTasks(); if (viewIs("settings")) renderSettings(); });
  ["tasks","events","spaces","dms","notifications","activity","projects"].forEach(k => BUS.on("change:" + k, () => { if (viewIs("myday")) renderMyDay(); if (viewIs("people") && (k === "tasks")) renderPeople(); }));
  BUS.on("notif:new", () => renderBell());
}
function updateTasksBadge(){
  const badge = document.getElementById("tasksBadge");
  if (!badge || !currentUser) return;
  const n = Tasks.list(t => t.status !== "done" && (t.assignees || []).includes(currentUser.id) && taskDueState(t) === "red").length;
  badge.style.display = n ? "inline-block" : "none";
  badge.textContent = n;
}

/* ---------------- EVENT WIRING ---------------- */
document.addEventListener("click", e => {
  const closer = e.target.closest("[data-close]");
  if (closer){ document.getElementById(closer.dataset.close).classList.remove("open"); if (closer.dataset.close === "prevVeil") document.getElementById("prevFrame").srcdoc = ""; return; }
  const veil = e.target.classList && e.target.classList.contains("modal-veil");
  if (veil){ e.target.classList.remove("open"); if (e.target.id === "prevVeil") document.getElementById("prevFrame").srcdoc = ""; return; }

  const bi = e.target.closest(".brand-item");
  if (bi){ selectBrand(bi.dataset.bid); return; }

  const cm = e.target.closest('[data-act="chatMenu"]');
  if (cm){ e.stopPropagation(); openChatMenu(cm.dataset.tid, cm); return; }
  const ci = e.target.closest(".chat-item");
  if (ci){ brand()._activeThread = ci.dataset.tid; renderChatList(); renderThread(); setView("chat"); return; }

  const act = e.target.closest("[data-act]");
  if (!act) return;
  const a = act.dataset.act;
  if (a === "approve") setVerdict(+act.dataset.idx, true);
  else if (a === "reject") setVerdict(+act.dataset.idx, false);
  else if (a === "copy"){ const m = thread().msgs[+act.dataset.idx]; copyText(m.displayText || m.text || ""); act.textContent = "Copied"; setTimeout(() => act.textContent = "Copy", 1400); }
  else if (a === "regen") regenerate();
  else if (a === "preview"){ const m = thread().msgs[+act.dataset.idx]; doPreview(m.files[+act.dataset.fi]); }
  else if (a === "download"){ const m = thread().msgs[+act.dataset.idx]; doDownload(m.files[+act.dataset.fi]); }
  else if (a === "unatt"){ pendingAtts.splice(+act.dataset.i, 1); renderPending(); }
  else if (a === "editBrand") openBrandModal(activeBrandId);
  else if (a === "upKnow") document.getElementById("kInput").click();
  else if (a === "delKnow"){ brand().knowledge.splice(+act.dataset.i, 1); saveBrands(); renderProfile(); }
  else if (a === "delMem"){ const b = brand(); b.memories = b.memories.filter(m => m.id !== act.dataset.mid); saveBrands(); renderProfile(); }
  else if (a === "aPrev"){ const x = document.getElementById("assetsPanel")._assets[+act.dataset.i]; assetPreview(x); }
  else if (a === "aDl"){ const x = document.getElementById("assetsPanel")._assets[+act.dataset.i]; assetDownload(x); }
  else if (a === "aBrowse"){ assetBrowse(); }
  else if (a === "aView"){ assetView = act.dataset.v; renderAssets(); }
  else if (a === "aFolder"){ assetFolder = act.dataset.f; renderAssets(); }
  else if (a === "aNewFolder"){ document.getElementById("folderName").value = ""; document.getElementById("folderVeil").classList.add("open"); setTimeout(() => document.getElementById("folderName").focus(), 60); }
  else if (a === "aMenu"){ e.stopPropagation(); openAssetMenu(+act.dataset.i, act); }
  // ---- operations layer ----
  else if (a === "opsLog"){ openActVeil(null); }
  else if (a === "opsParse"){ openParseModal(); }
  else if (a === "opsEditAct"){ openActVeil(act.dataset.id); }
  else if (a === "opsExport"){ exportOps(act.dataset.kind); }
  else if (a === "fuSnooze"){ fuSnooze(act.dataset.kind, act.dataset.id); }
  else if (a === "fuResched"){ openResched(act.dataset.kind, act.dataset.id); }
  else if (a === "fuComplete"){ fuComplete(act.dataset.kind, act.dataset.id); }
  else if (a === "depNew"){ openDepModal(); }
  else if (a === "depTab"){ depTab = act.dataset.t; renderDeps(); }
  else if (a === "depResolve"){ resolveDep(act.dataset.id); }
  else if (a === "recapWeek"){ recapWeekOffset = +act.dataset.d; renderRecap(); }
  else if (a === "recapAI"){ recapAINarrative(); }
  else if (a === "billSeats"){ billAdjustSeats(+act.dataset.d); }
  else if (a === "openBrand"){ selectBrand(act.dataset.bid); }
  else if (a === "toggleMotion"){ SETTINGS.motion = SETTINGS.motion === false ? true : false; document.body.classList.toggle("no-motion", SETTINGS.motion === false); saveSettings(); renderSettings(); }
  else if (a === "toggleCalTasks"){ SETTINGS.calShowTasks = SETTINGS.calShowTasks === false ? true : false; saveSettings(); renderSettings(); if (viewIs("calendar")) renderCalendar(); }
  else if (a === "exportIcs"){ exportAllIcs(); }
  else if (a === "toggleNotif"){ const nt = act.dataset.nt; NOTIF_PREFS[nt] = NOTIF_PREFS[nt] === false ? true : false; savePrefs(); renderSettings(); renderBell(); updateSpacesBadge(); }
  else if (a === "signout") signOut();
  else if (a === "backup") backupWorkspace();
  else if (a === "refreshCode"){ renderSettings(); toast("Team code re-checked · " + codeMinutesLeft() + " min left before it rotates."); }
  else if (a === "copyCode"){ copyText(orgCode(ORG)); toast("Team code copied."); }
  else if (a === "resetPw"){ resetUid = act.dataset.uid; renderSettings(); }
  else if (a === "resetPwCancel"){ resetUid = null; renderSettings(); }
  else if (a === "resetPwSave"){
    (async () => {
      const u = TEAM.find(t => t.id === act.dataset.uid);
      const v = (document.getElementById("rpInput") || {}).value || "";
      if (!u || v.length < 4){ toast("Temporary password needs at least 4 characters."); return; }
      u.pwHash = await hashPw(v, u.email);
      saveTeam(); resetUid = null; renderSettings();
      toast("Password reset for " + u.name + ". Tell them the temporary password.");
    })();
  }
  else if (a === "loadDemo"){
    defaultBrands().forEach(b => { b.id = uid("b"); BRANDS.push(b); });
    saveBrands();
    selectBrand(BRANDS[0].id);
  }
  else if (a === "delUser"){
    if (!act.dataset.armed){
      act.dataset.armed = "1"; act.textContent = "?";
      setTimeout(() => { act.dataset.armed = ""; act.textContent = "\u2715"; }, 2600);
    } else { TEAM = TEAM.filter(t => t.id !== act.dataset.uid); saveTeam(); renderSettings(); toast("Teammate removed."); }
  }
});
document.addEventListener("change", e => {
  const el = e.target.closest("[data-act='roleChange']");
  if (el){ const u = TEAM.find(t => t.id === el.dataset.uid); if (u){ u.role = el.value; saveTeam(); } }
});

document.querySelectorAll(".nav-btn").forEach(btn => btn.addEventListener("click", () => setView(btn.dataset.view)));
document.getElementById("newChatBtn").addEventListener("click", newChat);
document.getElementById("addBrandBtn").addEventListener("click", () => openBrandModal());
document.getElementById("bmSave").addEventListener("click", saveBrandModal);
document.getElementById("bmDelete").addEventListener("click", deleteBrandNow);
document.getElementById("menuBtn").addEventListener("click", () => document.getElementById("sidebar").classList.toggle("open"));
document.getElementById("setBtn").addEventListener("click", () => setView("settings"));
document.getElementById("exportChatBtn").addEventListener("click", exportChat);
document.getElementById("obAddBrand").addEventListener("click", () => openBrandModal());
document.getElementById("bmResearch").addEventListener("click", researchBrand);
document.getElementById("bmAddColor").addEventListener("click", () => document.getElementById("bmPaletteRows").appendChild(paletteRow("", "#8E959F")));
document.getElementById("bmAccentPick").addEventListener("input", function(){ document.getElementById("bmAccent").value = this.value.toUpperCase(); });
document.getElementById("bmAccent").addEventListener("input", function(){ const h = normHex(this.value); if (h) document.getElementById("bmAccentPick").value = h; });
document.getElementById("smSave").addEventListener("click", saveSpaceModal);
document.getElementById("smArchive").addEventListener("click", archiveSpaceNow);
document.getElementById("guardChip").addEventListener("click", () => setView("profile"));
document.getElementById("modeCopy").addEventListener("click", () => setMode("copy"));
document.getElementById("modeImage").addEventListener("click", () => setMode("image"));
document.getElementById("mSmart").addEventListener("click", () => setModel("smart"));
document.getElementById("mFast").addEventListener("click", () => setModel("fast"));
document.getElementById("attachBtn").addEventListener("click", () => document.getElementById("fileInput").click());
document.getElementById("micBtn").addEventListener("click", toggleMic);
document.getElementById("fileInput").addEventListener("change", function(){ handleFiles(this.files); this.value = ""; });
document.getElementById("chatSearch").addEventListener("input", renderChatList);
document.getElementById("sendBtn").addEventListener("click", () => { if (busy && abortCtl){ abortCtl.abort(); } else send(); });
const inputEl = document.getElementById("input");
inputEl.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey){ e.preventDefault(); send(); } });
inputEl.addEventListener("input", function(){ this.style.height = "auto"; this.style.height = Math.min(this.scrollHeight, 170) + "px"; });

const stageEl = document.getElementById("stage");
/* File drop overlay. The old handler cleared only when e.target === stage, so moving the cursor
   over a child element fired dragleave and stranded the "Drop files for SYN" overlay until a
   refresh (the classic nested-dragleave bug). Fix: a single enter/leave DEPTH COUNTER — each
   element entered is +1, each left is -1, overlay shows while depth>0 — plus a hard force-clear
   on drop, dragend, window blur, and Escape so it can never get stuck. Only file drags trigger
   it, so dragging a task card no longer flashes the overlay. */
let stageDragDepth = 0;
function dtHasFiles(e){ const dt = e.dataTransfer; return !!(dt && dt.types && Array.prototype.indexOf.call(dt.types, "Files") !== -1); }
function clearStageDrag(){ stageDragDepth = 0; stageEl.classList.remove("dragging"); }
stageEl.addEventListener("dragenter", e => { if (!dtHasFiles(e)) return; e.preventDefault(); stageDragDepth++; stageEl.classList.add("dragging"); });
stageEl.addEventListener("dragover", e => { if (!dtHasFiles(e)) return; e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"; });
stageEl.addEventListener("dragleave", e => { if (!stageEl.classList.contains("dragging")) return; stageDragDepth = Math.max(0, stageDragDepth - 1); if (stageDragDepth === 0) stageEl.classList.remove("dragging"); });
stageEl.addEventListener("drop", e => { e.preventDefault(); clearStageDrag(); if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); });
/* Belt-and-braces: nothing can leave the overlay (or the asset drop overlay) stuck on. */
function clearAllDropOverlays(){ clearStageDrag(); if (typeof assetDragDepth !== "undefined") assetDragDepth = 0; document.querySelectorAll(".asset-view.drag-over").forEach(v => v.classList.remove("drag-over")); }
document.addEventListener("dragend", clearAllDropOverlays);
window.addEventListener("blur", clearAllDropOverlays);
document.addEventListener("keydown", e => { if (e.key === "Escape") clearAllDropOverlays(); });

/* --- workspace suite wiring (Stage 0 + 1) --- */
document.getElementById("bellBtn").addEventListener("click", e => { e.stopPropagation(); closeQuickAdd(); toggleBell(); });
document.getElementById("notifClear").addEventListener("click", markAllRead);
document.addEventListener("click", e => { const p = document.getElementById("notifPanel"); if (p.classList.contains("open") && !e.target.closest(".bell-wrap")) closeBell(); });
/* global search + quick-add wiring */
document.getElementById("searchBtn").addEventListener("click", openSearch);
document.getElementById("newBtn").addEventListener("click", e => { e.stopPropagation(); closeBell(); toggleQuickAdd(); });
document.addEventListener("click", e => { const m = document.getElementById("quickAddMenu"); if (m.classList.contains("open") && !e.target.closest("#quickAddMenu") && e.target.id !== "newBtn") closeQuickAdd(); });
document.addEventListener("keydown", e => {
  const appOn = document.getElementById("app").classList.contains("on");
  if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")){ e.preventDefault(); if (appOn) openSearch(); return; }
  if ((e.metaKey || e.ctrlKey) && (e.key === "b" || e.key === "B")){ e.preventDefault(); if (appOn) toggleCollapsed(); return; }
  if ((e.metaKey || e.ctrlKey) && e.key === "."){ e.preventDefault(); if (appOn) toggleFocus(); return; }
  if (e.key === "Escape"){
    if (document.getElementById("searchVeil").classList.contains("open")){ closeSearch(); return; }
    if (ctxMenuEl){ closeChatMenu(); return; }
    // close any open modal (task, event, brand, space, DM, plan, project, integration, visibility, preview…)
    const openVeil = document.querySelector(".modal-veil.open");
    if (openVeil){ openVeil.classList.remove("open"); return; }
    // notifications / quick-add popovers
    const notif = document.getElementById("notifPanel");
    if (notif && getComputedStyle(notif).display !== "none"){ notif.style.display = "none"; return; }
    if (typeof closeQuickAdd === "function" && document.querySelector(".qa-pop.open")){ closeQuickAdd(); return; }
    if (document.getElementById("app").classList.contains("focus-mode")){ toggleFocus(); return; }
  }
});

/* ---------- SHELL: theme + collapsible sidebar + focus mode (view state only) ---------- */
function applyTheme(t){ document.documentElement.dataset.theme = (t === "light" ? "light" : "dark"); }
function currentTheme(){ return document.documentElement.dataset.theme === "light" ? "light" : "dark"; }
function loadThemePref(){
  let t = null; try{ t = localStorage.getItem("syn5:ui:theme"); }catch(e){}
  if (!t){ t = (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) ? "light" : "dark"; }
  applyTheme(t);
}
function toggleTheme(){ const t = currentTheme() === "light" ? "dark" : "light"; applyTheme(t); try{ localStorage.setItem("syn5:ui:theme", t); }catch(e){} if (viewIs("settings")) renderSettings(); }
function toggleCollapsed(){ const app = document.getElementById("app"); const on = app.classList.toggle("sb-collapsed"); try{ localStorage.setItem("syn5:ui:sidebar", on ? "collapsed" : "expanded"); }catch(e){} }
function toggleFocus(){ document.getElementById("app").classList.toggle("focus-mode"); }
function loadShellPrefs(){
  let c = null; try{ c = localStorage.getItem("syn5:ui:sidebar"); }catch(e){}
  document.getElementById("app").classList.toggle("sb-collapsed", c === "collapsed");
}
const searchInputEl = document.getElementById("searchInput");
searchInputEl.addEventListener("input", doSearch);
searchInputEl.addEventListener("keydown", e => {
  if (e.key === "ArrowDown"){ e.preventDefault(); searchMove(1); }
  else if (e.key === "ArrowUp"){ e.preventDefault(); searchMove(-1); }
  else if (e.key === "Enter"){ e.preventDefault(); searchJump(searchSel); }
});
document.getElementById("tmSave").addEventListener("click", saveTaskModal);
document.getElementById("tmDelete").addEventListener("click", deleteTaskNow);
document.getElementById("pmSave").addEventListener("click", saveProjectModal);
document.getElementById("pmDelete").addEventListener("click", deleteProjectNow);
document.getElementById("pmColorPick").addEventListener("input", function(){ document.getElementById("pmColor").value = this.value.toUpperCase(); });
document.getElementById("pmColor").addEventListener("input", function(){ const h = normHex(this.value); if (h) document.getElementById("pmColorPick").value = h; });
document.getElementById("planRun").addEventListener("click", planWithSYN);
document.getElementById("evSave").addEventListener("click", saveEventModal);
document.getElementById("evDelete").addEventListener("click", deleteEventNow);
document.getElementById("visSave").addEventListener("click", saveVisibility);
document.getElementById("folderSave").addEventListener("click", saveFolder);
document.getElementById("folderName").addEventListener("keydown", e => { if (e.key === "Enter") saveFolder(); });
document.getElementById("imConnect").addEventListener("click", intConnectSave);
document.getElementById("actSave").addEventListener("click", saveAct);
document.getElementById("actDelete").addEventListener("click", deleteAct);
document.getElementById("depSave").addEventListener("click", saveDep);
document.getElementById("reschedSave").addEventListener("click", saveResched);

boot();
