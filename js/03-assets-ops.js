/* ============================================================
   js/03-assets-ops.js — ASSETS (grid/list, upload pipeline, options menu, visibility modal) and the operations views: escalation, ACTIVITY view + AI transcript parse, FOLLOW-UPS, DEPENDENCIES, WEEKLY RECAP, COMPANY ROLLUP, CSV export, and shared refresh/badges.
   MOVE, not a refactor: a byte-identical slice of the original inline <script>.
   Order-dependent. Loads after 02-chat.js and before 04-pricing-brand.js. Shared global
   scope, not a module. Do not reorder these tags.
   ============================================================ */
/* ---------------- ASSETS ---------------- */
/* Upload constraints */
const ASSET_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const ASSET_TYPES = ["png","jpg","jpeg","gif","webp","svg","pdf","txt","md","csv","json","doc","docx","rtf","xls","xlsx","ppt","pptx"];
const ASSET_BINARY = ["png","jpg","jpeg","gif","webp","pdf","xls","xlsx","ppt","pptx","docx"];
function fmtBytes(n){ n = n || 0; if (n < 1024) return n + " B"; if (n < 1048576) return (n/1024).toFixed(0) + " KB"; return (n/1048576).toFixed(1) + " MB"; }
function visLabel(v){ return v === "workspace" ? "Workspace" : v === "specific" ? "Shared" : "Private"; }
function visIcon(v){
  if (v === "workspace") return '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></svg>';
  if (v === "specific") return '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 6.2a3 3 0 0 1 0 5.6M18 19a5 5 0 0 0-3-4.6"/></svg>';
  return '<svg viewBox="0 0 24 24"><rect x="5" y="10.5" width="14" height="9" rx="1.6"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>';
}
/* per-brand asset view state */
let assetView = "grid";      // grid | list
let assetFolder = "";        // "" = all, "__none__" = unfiled, or folderId
let assetTypeFilter = "";
let assetOwnerFilter = "";

/* Normalized, visibility-gated asset list for a brand (uploads + chat-generated deliverables).
   Uploads pass through canSeeAsset; chat files inherit their chat's privacy via canSee — so this
   accessor never returns an asset the current user is not entitled to, at the data layer. */
function brandAssets(b){
  const out = [];
  Assets.list(a => a.brandId === b.id && canSeeAsset(a)).forEach(a => out.push({
    id: a.id, source: "upload", f: { name: a.name, content: a.content || "", dataUrl: a.dataUrl || null },
    name: a.name, ext: a.ext || extOf(a.name), size: a.size || 0, at: a.createdAt,
    folderId: a.folderId || null, ownerId: a.createdBy, ownerName: a.createdByName || teamName(a.createdBy),
    visibility: a.visibility || "private", rec: a
  }));
  (CHATS[b.id] || []).filter(canSee).forEach(c => c.msgs.forEach(m => (m.files || []).forEach(f => out.push({
    id: c.id + ":" + f.name + ":" + (m.at || ""), source: "chat", f: f,
    name: f.name, ext: extOf(f.name), size: (f.content || "").length, at: m.at,
    folderId: null, ownerId: c.ownerId, ownerName: teamName(c.ownerId),
    visibility: c.shared ? "workspace" : "private", chat: c.name, rec: null
  }))));
  return out.sort((x, y) => new Date(y.at || 0) - new Date(x.at || 0));
}
function brandFolders(b){ return AFolders.list(f => f.brandId === b.id).sort((a, c) => (a.name || "").localeCompare(c.name || "")); }

function renderAssets(){
  const b = brand();
  const p = document.getElementById("assetsPanel");
  if (!b){ p.innerHTML = '<div class="empty-log">No brands yet, so no assets yet.</div>'; return; }
  const all = brandAssets(b);
  const folders = brandFolders(b);

  // filters
  let list = all.slice();
  if (assetFolder === "__none__") list = list.filter(x => !x.folderId);
  else if (assetFolder) list = list.filter(x => x.folderId === assetFolder);
  if (assetTypeFilter) list = list.filter(x => (x.ext || "") === assetTypeFilter);
  if (assetOwnerFilter) list = list.filter(x => x.ownerId === assetOwnerFilter);

  const types = Array.from(new Set(all.map(x => x.ext).filter(Boolean))).sort();
  const owners = Array.from(new Set(all.map(x => x.ownerId).filter(Boolean)));

  let html = '<div class="panel-head"><div><h2>' + esc(b.name) + ' · Assets</h2><p class="sub">Uploads and every deliverable SYN has produced — organized, permissioned, ready.</p></div>' +
    '<button class="btn-gold" data-act="aBrowse">Upload</button></div>';

  // toolbar: view toggle + filters
  html += '<div class="assets-toolbar">' +
    '<div class="view-toggle"><button class="' + (assetView === "grid" ? "active" : "") + '" data-act="aView" data-v="grid" aria-label="Grid view"><svg viewBox="0 0 24 24"><rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/></svg>Grid</button>' +
    '<button class="' + (assetView === "list" ? "active" : "") + '" data-act="aView" data-v="list" aria-label="List view"><svg viewBox="0 0 24 24"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg>List</button></div>' +
    '<div class="at-spacer"></div>' +
    '<select class="af-select" data-act="aFilterType"><option value="">All types</option>' + types.map(t => '<option value="' + esc(t) + '"' + (assetTypeFilter === t ? " selected" : "") + '>.' + esc(t) + '</option>').join("") + '</select>' +
    '<select class="af-select" data-act="aFilterOwner"><option value="">Any owner</option>' + owners.map(o => '<option value="' + esc(o) + '"' + (assetOwnerFilter === o ? " selected" : "") + '>' + esc(teamName(o)) + (o === (currentUser && currentUser.id) ? " (you)" : "") + '</option>').join("") + '</select>' +
    '</div>';

  // folder bar
  html += '<div class="folder-bar">' +
    '<button class="folder-chip' + (assetFolder === "" ? " active" : "") + '" data-act="aFolder" data-f=""><svg viewBox="0 0 24 24"><path d="M4 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>All<span class="fc-n">' + all.length + '</span></button>' +
    '<button class="folder-chip' + (assetFolder === "__none__" ? " active" : "") + '" data-act="aFolder" data-f="__none__">Unfiled<span class="fc-n">' + all.filter(x => !x.folderId).length + '</span></button>';
  folders.forEach(f => {
    html += '<button class="folder-chip' + (assetFolder === f.id ? " active" : "") + '" data-act="aFolder" data-f="' + f.id + '"><svg viewBox="0 0 24 24"><path d="M4 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>' + esc(f.name) + '<span class="fc-n">' + all.filter(x => x.folderId === f.id).length + '</span></button>';
  });
  html += '<button class="folder-chip" data-act="aNewFolder" style="border-style:dashed">+ Folder</button></div>';

  // upload tray placeholder (populated live during uploads)
  html += '<div class="upload-tray" id="uploadTray"></div>';

  // dropzone + content
  html += '<div class="asset-dropzone">';
  if (!all.length){
    html += '<div class="asset-drop-hint" data-act="aBrowse"><div class="adh-ico"><svg viewBox="0 0 24 24"><path d="M12 16V4M12 4l-4 4M12 4l4 4"/><path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg></div>' +
      '<b>Drop files here or click to browse</b><div class="adh-sub">Images, PDFs, docs, sheets · up to ' + fmtBytes(ASSET_MAX_BYTES) + ' · new uploads are private to you</div></div>';
  } else if (!list.length){
    html += '<div class="empty-log">No assets match these filters.</div>';
  } else if (assetView === "grid"){
    html += '<div class="asset-grid">';
    list.forEach((x, i) => {
      html += '<div class="asset-card">' +
        (x.source === "upload" ? '<button class="a-menu-btn" data-act="aMenu" data-i="' + i + '" aria-label="Asset options">⋯</button>' : "") +
        '<div class="fc-ico">.' + esc(x.ext || "txt") + '</div>' +
        '<div class="a-name">' + esc(x.name) + '</div>' +
        '<div class="a-meta">' + esc(x.ownerName || "") + (x.at ? " · " + esc(fmtTime(x.at)) : "") + ' · ' + fmtBytes(x.size) + '</div>' +
        '<div class="a-vis">' + visIcon(x.visibility) + visLabel(x.visibility) + '</div>' +
        '<div class="a-btns"><button class="fc-prev" data-act="aPrev" data-i="' + i + '">Preview</button>' +
        '<button class="fc-dl" data-act="aDl" data-i="' + i + '">Download</button></div></div>';
    });
    html += "</div>";
  } else {
    html += '<div class="asset-list">';
    list.forEach((x, i) => {
      html += '<div class="asset-row">' +
        '<div class="ar-ext">' + esc(x.ext || "txt") + '</div>' +
        '<div class="ar-name">' + esc(x.name) + '</div>' +
        '<div class="a-vis">' + visIcon(x.visibility) + visLabel(x.visibility) + '</div>' +
        '<div class="ar-col owner">' + esc(x.ownerName || "") + '</div>' +
        '<div class="ar-col date">' + (x.at ? esc(fmtTime(x.at)) : "") + '</div>' +
        '<div class="ar-col">' + fmtBytes(x.size) + '</div>' +
        '<button class="fc-prev" data-act="aPrev" data-i="' + i + '">Preview</button>' +
        '<button class="fc-dl" data-act="aDl" data-i="' + i + '">Download</button>' +
        (x.source === "upload" ? '<button class="a-menu-btn" data-act="aMenu" data-i="' + i + '" aria-label="Asset options">⋯</button>' : "") +
        '</div>';
    });
    html += "</div>";
  }
  html += "</div>"; // dropzone

  p.innerHTML = html;
  p._assets = list;
}

/* preview / download that understand both text content and binary dataURLs */
function assetPreview(x){
  const f = x.f;
  if (f.dataUrl){
    document.getElementById("prevTitle").textContent = f.name;
    const ext = extOf(f.name);
    const inner = (ASSET_BINARY.includes(ext) && !/pdf/.test(ext) ? '<img src="' + f.dataUrl + '" style="max-width:100%;height:auto;display:block;margin:0 auto">' : '<iframe src="' + f.dataUrl + '" style="border:0;width:100%;height:100%"></iframe>');
    document.getElementById("prevFrame").srcdoc = '<html><body style="margin:0;background:#111;display:flex;align-items:center;justify-content:center;min-height:100vh">' + inner + '</body></html>';
    document.getElementById("prevVeil").classList.add("open");
    return;
  }
  doPreview(f);
}
function assetDownload(x){
  const f = x.f;
  if (f.dataUrl){
    const a = document.createElement("a"); a.href = f.dataUrl; a.download = f.name;
    document.body.appendChild(a); a.click(); a.remove(); return;
  }
  doDownload(f);
}

/* ---- upload pipeline (drag-drop + click-to-browse, progress, errors) ---- */
function assetBrowse(){
  let inp = document.getElementById("assetFileInput");
  if (!inp){
    inp = document.createElement("input"); inp.type = "file"; inp.multiple = true; inp.id = "assetFileInput";
    inp.accept = ASSET_TYPES.map(t => "." + t).join(",");
    inp.style.display = "none"; document.body.appendChild(inp);
    inp.addEventListener("change", () => { handleAssetFiles(inp.files); inp.value = ""; });
  }
  inp.click();
}
function uploadTray(){ return document.getElementById("uploadTray"); }
function handleAssetFiles(fileList){
  const b = brand();
  if (!b){ toast("Select a brand first."); return; }
  const files = Array.from(fileList || []);
  if (!files.length) return;
  const tray = uploadTray();
  files.forEach(file => {
    const ext = extOf(file.name);
    const rowId = "up_" + Math.random().toString(36).slice(2, 8);
    const row = document.createElement("div");
    row.className = "upload-row"; row.id = rowId;
    // validate type
    if (!ASSET_TYPES.includes(ext)){
      row.classList.add("err");
      row.innerHTML = '<div class="ur-name">' + esc(file.name) + '</div><div class="ur-msg">Unsupported file type (.' + esc(ext || "?") + ')</div>';
      if (tray){ tray.appendChild(row); setTimeout(() => row.remove(), 6000); }
      toast("Skipped " + file.name + " — unsupported type."); return;
    }
    // validate size
    if (file.size > ASSET_MAX_BYTES){
      row.classList.add("err");
      row.innerHTML = '<div class="ur-name">' + esc(file.name) + '</div><div class="ur-msg">Too large (' + fmtBytes(file.size) + ' · max ' + fmtBytes(ASSET_MAX_BYTES) + ')</div>';
      if (tray){ tray.appendChild(row); setTimeout(() => row.remove(), 6000); }
      toast("Skipped " + file.name + " — over the size limit."); return;
    }
    row.innerHTML = '<div class="ur-name">' + esc(file.name) + '</div><div class="ur-bar"><div class="ur-fill"></div></div><div class="ur-pct">0%</div>';
    if (tray) tray.appendChild(row);
    const fill = row.querySelector(".ur-fill"), pct = row.querySelector(".ur-pct");
    const reader = new FileReader();
    reader.onprogress = e => { if (e.lengthComputable){ const p = Math.round(e.loaded / e.total * 100); if (fill) fill.style.width = p + "%"; if (pct) pct.textContent = p + "%"; } };
    reader.onerror = () => { row.classList.add("err"); row.innerHTML = '<div class="ur-name">' + esc(file.name) + '</div><div class="ur-msg">Read failed — try again</div>'; };
    reader.onload = () => {
      const binary = ASSET_BINARY.includes(ext);
      const rec = {
        brandId: b.id, name: file.name, ext: ext, size: file.size,
        content: binary ? "" : String(reader.result || ""),
        dataUrl: binary ? String(reader.result || "") : null,
        folderId: (assetFolder && assetFolder !== "__none__") ? assetFolder : null,
        visibility: "private", sharedWith: []
      };
      Assets.create(rec);
      if (fill) fill.style.width = "100%"; if (pct) pct.textContent = "Done";
      row.classList.add("done");
      setTimeout(() => { row.remove(); }, 1200);
      renderAssets();
    };
    if (ASSET_BINARY.includes(ext)) reader.readAsDataURL(file); else reader.readAsText(file);
  });
}
/* drag feedback on the assets view */
let assetDragDepth = 0;
function wireAssetDnD(){
  const view = document.getElementById("view-assets");
  if (!view || view._dndWired) return;
  view._dndWired = true;
  view.classList.add("asset-view");
  view.addEventListener("dragenter", e => { e.preventDefault(); assetDragDepth++; view.classList.add("drag-over"); });
  view.addEventListener("dragover", e => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
  view.addEventListener("dragleave", e => { assetDragDepth = Math.max(0, assetDragDepth - 1); if (!assetDragDepth) view.classList.remove("drag-over"); });
  view.addEventListener("drop", e => { e.preventDefault(); assetDragDepth = 0; view.classList.remove("drag-over"); if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) handleAssetFiles(e.dataTransfer.files); });
}

/* ---- asset options menu (owner/admin: change visibility, move, delete) ---- */
function openAssetMenu(i, anchor){
  const x = document.getElementById("assetsPanel")._assets[i];
  if (!x || x.source !== "upload"){ return; }
  closeAssetMenu();
  const canEdit = canEditAsset(x.rec);
  const folders = brandFolders(brand());
  const menu = document.createElement("div");
  menu.className = "ctx-menu open"; menu.id = "assetCtxMenu";
  let items = '<button class="ctx-item" data-aact="vis" data-i="' + i + '"><span class="ci-ico">' + visIcon(x.visibility) + '</span>Change visibility</button>';
  items += '<button class="ctx-item" data-aact="move" data-i="' + i + '">Move to folder…</button>';
  items += '<button class="ctx-item danger" data-aact="del" data-i="' + i + '">Delete asset</button>';
  menu.innerHTML = canEdit ? items : '<div class="ctx-item" style="color:var(--text-3);cursor:default">Only the owner can manage this asset.</div>';
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.position = "fixed"; menu.style.top = (r.bottom + 6) + "px";
  menu.style.left = Math.max(10, Math.min(r.left - 140, window.innerWidth - 230)) + "px"; menu.style.zIndex = 90;
  menu._moveFolders = folders;
}
function closeAssetMenu(){ const m = document.getElementById("assetCtxMenu"); if (m) m.remove(); }
document.addEventListener("click", e => {
  const it = e.target.closest("#assetCtxMenu [data-aact]");
  if (it){ e.stopPropagation(); const act = it.dataset.aact, i = +it.dataset.i; closeAssetMenu(); assetMenuAction(act, i); return; }
  if (!e.target.closest("#assetCtxMenu") && !e.target.closest('[data-act="aMenu"]')) closeAssetMenu();
});
function assetMenuAction(act, i){
  const x = document.getElementById("assetsPanel")._assets[i];
  if (!x || !x.rec) return;
  if (act === "vis") openVisibilityModal(x.rec.id);
  else if (act === "move") openMoveMenu(x.rec.id);
  else if (act === "del"){ if (!confirm("Delete " + x.name + "? This can't be undone.")) return; Assets.remove(x.rec.id); toast("Asset deleted."); renderAssets(); }
}
function openMoveMenu(assetId){
  const a = Assets.get(assetId); if (!a) return;
  const folders = brandFolders(brand());
  const names = ["Unfiled"].concat(folders.map(f => f.name));
  const ids = [null].concat(folders.map(f => f.id));
  const pick = prompt("Move to which folder?\n" + names.map((n, k) => k + ": " + n).join("\n") + "\n\n(or type a new folder name)", "");
  if (pick == null) return;
  const num = parseInt(pick, 10);
  if (!isNaN(num) && num >= 0 && num < ids.length){ Assets.update(assetId, { folderId: ids[num] }); }
  else if (pick.trim()){ const nf = AFolders.create({ brandId: brand().id, name: pick.trim() }); Assets.update(assetId, { folderId: nf.id }); }
  toast("Moved."); renderAssets();
}

/* ---- visibility modal ---- */
let visEditId = null, visPick = "private", visPeople = new Set();
function openVisibilityModal(assetId){
  const a = Assets.get(assetId); if (!a) return;
  if (!canEditAsset(a)){ toast("Only the owner can change visibility."); return; }
  visEditId = assetId; visPick = a.visibility || "private"; visPeople = new Set(a.sharedWith || []);
  renderVisibilityModal();
  document.getElementById("visVeil").classList.add("open");
}
function renderVisibilityModal(){
  const body = document.getElementById("visBody");
  const opt = (v, title, sub) => '<div class="vis-opt' + (visPick === v ? " sel" : "") + '" data-visopt="' + v + '"><span class="vo-radio"></span><div><div class="vo-title">' + title + '</div><div class="vo-sub">' + sub + '</div></div></div>';
  let html = opt("private", "Private", "Only you can see this asset.") +
    opt("specific", "Specific people", "Choose workspace members who can see it.") +
    opt("workspace", "Workspace", "Everyone in the workspace can see it.");
  if (visPick === "specific"){
    html += '<div class="vis-people"><div class="vp-lbl">Share with</div>';
    (TEAM || []).filter(u => u.id !== (currentUser && currentUser.id)).forEach(u => {
      html += '<label class="chk"><input type="checkbox" data-visperson="' + u.id + '"' + (visPeople.has(u.id) ? " checked" : "") + '><span class="box"><svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg></span>' + esc(u.name) + '</label>';
    });
    if (!(TEAM || []).some(u => u.id !== (currentUser && currentUser.id))) html += '<div class="vo-sub">No other members in this workspace yet.</div>';
    html += '</div>';
  }
  body.innerHTML = html;
}

/* visibility modal wiring */
document.addEventListener("click", e => {
  const opt = e.target.closest("#visBody [data-visopt]");
  if (opt){ visPick = opt.dataset.visopt; renderVisibilityModal(); return; }
});
document.addEventListener("change", e => {
  const cb = e.target.closest("#visBody [data-visperson]");
  if (cb){ if (cb.checked) visPeople.add(cb.dataset.visperson); else visPeople.delete(cb.dataset.visperson); return; }
  // asset filter selects
  const ft = e.target.closest('[data-act="aFilterType"]');
  if (ft){ assetTypeFilter = ft.value; renderAssets(); return; }
  const fo = e.target.closest('[data-act="aFilterOwner"]');
  if (fo){ assetOwnerFilter = fo.value; renderAssets(); return; }
  // operations-layer filters
  const at = e.target.closest('[data-act="actFType"]'); if (at){ actFilter.type = at.value; renderActivity(); return; }
  const ap = e.target.closest('[data-act="actFPerson"]'); if (ap){ actFilter.person = ap.value; renderActivity(); return; }
  const af = e.target.closest('[data-act="actFFrom"]'); if (af){ actFilter.from = af.value; renderActivity(); return; }
  const ato = e.target.closest('[data-act="actFTo"]'); if (ato){ actFilter.to = ato.value; renderActivity(); return; }
  const rp = e.target.closest('[data-act="recapPerson"]'); if (rp){ recapUser = rp.value; renderRecap(); return; }
});
function saveVisibility(){
  if (!visEditId) return;
  const patch = { visibility: visPick, sharedWith: visPick === "specific" ? Array.from(visPeople) : [] };
  Assets.update(visEditId, patch);
  document.getElementById("visVeil").classList.remove("open");
  toast("Visibility updated: " + visLabel(visPick) + ".");
  renderAssets();
}
function saveFolder(){
  const nm = document.getElementById("folderName").value.trim();
  if (!nm){ toast("Name the folder."); return; }
  const b = brand(); if (!b) return;
  const f = AFolders.create({ brandId: b.id, name: nm });
  document.getElementById("folderVeil").classList.remove("open");
  assetFolder = f.id; renderAssets();
}
/* ---------------- ASSETS end ---------------- */

/* ==================================================================
   OPERATIONS LAYER — activities, follow-ups, dependencies, recap, rollup
   ================================================================== */
function actTypeLabel(t){ const x = ACT_TYPES.find(a => a[0] === t); return x ? x[1] : "Note"; }
function actIcon(t){ const I = {
  call:'<svg viewBox="0 0 24 24"><path d="M5 4h4l2 5-2.5 1.5a12 12 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z"/></svg>',
  meeting:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/></svg>',
  email:'<svg viewBox="0 0 24 24"><rect x="4" y="6" width="16" height="12" rx="1.6"/><path d="M4 8l8 6 8-6"/></svg>',
  sample:'<svg viewBox="0 0 24 24"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/></svg>',
  application:'<svg viewBox="0 0 24 24"><path d="M7 3h7l4 4v14H7V3Z"/><path d="M14 3v4h4M10 13h5M10 17h5"/></svg>',
  note:'<svg viewBox="0 0 24 24"><path d="M5 19l1-4L16.5 4.5a2 2 0 0 1 3 3L9 18l-4 1Z"/></svg>'
}; return I[t] || I.note; }

/* ---- escalation: days overdue -> state + always-a-text-label (never colour alone) ---- */
function escalate(dateStr){
  if (!dateStr) return { key:"none", label:"", cls:"", days:null, badge:false };
  const today = new Date(); today.setHours(0,0,0,0);
  const d = new Date(dateStr + "T00:00:00"); d.setHours(0,0,0,0);
  const days = Math.round((today - d) / 86400000);               // >0 = overdue
  if (days < 0){ const n = -days; return { key:"upcoming", label:"in " + n + " day" + (n>1?"s":""), cls:"esc-upcoming", days, badge:false }; }
  if (days === 0) return { key:"today", label:"Due today", cls:"esc-today", days, badge:false };
  if (days <= 3)  return { key:"warm", label:days + " day" + (days>1?"s":"") + " overdue", cls:"esc-warm", days, badge:false };
  if (days <= 13) return { key:"red", label:days + " days overdue", cls:"esc-red", days, badge:false };
  return { key:"critical", label:days + " days overdue", cls:"esc-critical", days, badge:true };
}
function escChip(e){ if (!e || !e.cls) return ""; return '<span class="esc-chip ' + e.cls + '" role="status">' + (e.badge ? '<span class="esc-bang" aria-hidden="true">!</span>' : '<span class="esc-dot" aria-hidden="true"></span>') + esc(e.label) + '</span>'; }

/* ---- auto-activity when a task is completed (once per task) ---- */
function autoActivityForTask(t){
  if (!t) return;
  if (Acts.list(a => a.taskId === t.id && a.auto).length) return;
  Acts.create({ type:"note", notes:"Completed task: " + (t.title || "Untitled"), date: todayISO(), taskId: t.id, auto:true, visibility:"private" });
}

/* ---- non-streaming model call returning text (for AI parse + recap narrative) ---- */
async function aiText(system, user, maxTokens){
  const res = await fetch(apiBase() + "/v1/messages", { method:"POST", headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ model: MODELS.fast, max_tokens: maxTokens || 1500, system, messages:[{ role:"user", content: user }] }) });
  if (!res.ok) throw new Error("ai " + res.status);
  const j = await res.json();
  return (j.content || []).filter(c => c.type === "text").map(c => c.text).join("").trim();
}

/* ================= ACTIVITY VIEW ================= */
let actFilter = { type:"", person:"", from:"", to:"" };
function actInWindow(a){
  if (actFilter.from && a.date < actFilter.from) return false;
  if (actFilter.to && a.date > actFilter.to) return false;
  return true;
}
function visibleActs(){
  return myActs(a => (!actFilter.type || a.type === actFilter.type) &&
    (!actFilter.person || a.createdBy === actFilter.person) && actInWindow(a))
    .sort((x,y) => (y.date + (y.createdAt||"")) < (x.date + (x.createdAt||"")) ? -1 : 1);
}
function renderActivity(){
  const p = document.getElementById("activityPanel"); if (!p) return;
  const list = visibleActs();
  let h = '<div class="panel-head"><div><h2>Activity</h2><p class="sub">Log calls, meetings, emails, samples, and notes. Yours are private; admins see the whole team.</p></div>' +
    '<div style="display:flex;gap:8px"><button class="btn-ghost" data-act="opsParse">✦ Parse with SYN</button><button class="btn-gold" data-act="opsLog">+ Log activity</button></div></div>';

  // filters + export
  h += '<div class="ops-toolbar">' +
    '<select class="af-select" data-act="actFType"><option value="">All types</option>' + ACT_TYPES.map(t => '<option value="' + t[0] + '"' + (actFilter.type === t[0] ? " selected" : "") + '>' + t[1] + '</option>').join("") + '</select>';
  if (isAdmin()) h += '<select class="af-select" data-act="actFPerson"><option value="">Everyone</option>' + TEAM.map(u => '<option value="' + u.id + '"' + (actFilter.person === u.id ? " selected" : "") + '>' + esc(u.name) + '</option>').join("") + '</select>';
  h += '<label class="ops-dt">From <input type="date" class="af-select" data-act="actFFrom" value="' + esc(actFilter.from) + '"></label>' +
    '<label class="ops-dt">To <input type="date" class="af-select" data-act="actFTo" value="' + esc(actFilter.to) + '"></label>' +
    '<div class="at-spacer"></div>' +
    '<button class="btn-ghost" data-act="opsExport" data-kind="activities">⤓ Export CSV</button></div>';

  if (!list.length){ h += '<div class="empty-log">No activities logged' + (actFilter.type || actFilter.from || actFilter.person ? ' for this filter' : ' yet') + '. Log one in seconds, or paste a call transcript and let SYN extract it.</div>'; }
  else {
    h += '<div class="ops-list">';
    list.forEach(a => {
      const fu = a.followUpDate && !a.followUpDone ? escalate(a.followUpDate) : null;
      h += '<div class="ops-row" data-act="opsEditAct" data-id="' + a.id + '">' +
        '<span class="ops-ico" title="' + actTypeLabel(a.type) + '">' + actIcon(a.type) + '</span>' +
        '<div class="ops-main"><div class="ops-title">' + esc(actTypeLabel(a.type)) + (a.relatedName ? ' · ' + esc(a.relatedName) : '') + (a.companyName ? ' <span class="ops-dim">(' + esc(a.companyName) + ')</span>' : '') + (a.auto ? ' <span class="ops-auto">auto</span>' : '') + '</div>' +
        '<div class="ops-sub">' + esc(fmtDay(a.date)) + (a.duration ? ' · ' + a.duration + ' min' : '') + (a.outcome ? ' · ' + esc(a.outcome) : '') + (isAdmin() && a.createdByName ? ' · ' + esc(a.createdByName) : '') + '</div>' +
        (a.notes ? '<div class="ops-notes">' + esc(a.notes) + '</div>' : '') + '</div>' +
        (fu ? '<div class="ops-fu">' + escChip(fu) + '</div>' : '') + '</div>';
    });
    h += '</div>';
  }
  p.innerHTML = h;
}

/* ---- activity entry modal (fast manual logging) ---- */
let editingActId = null;
function contactsDatalist(){
  return '<datalist id="contactList">' + Contacts.list().map(c => '<option value="' + esc(c.name) + '">' + esc(c.company || "") + '</option>').join("") + '</datalist>';
}
function openActVeil(id){
  editingActId = id || null;
  const a = id ? Acts.get(id) : null;
  document.getElementById("actTitle").textContent = a ? "Edit activity" : "Log activity";
  document.getElementById("actDelete").style.display = a ? "block" : "none";
  const cur = a || { type:"call", date: todayISO(), duration:0 };
  let b = '<label class="f-label">Type</label><div class="type-chips" id="actTypeChips">' +
    ACT_TYPES.map(t => '<button type="button" class="type-chip' + (cur.type === t[0] ? " on" : "") + '" data-acttype="' + t[0] + '">' + esc(t[1]) + '</button>').join("") + '</div>' +
    '<div class="tm-grid"><div><label class="f-label" for="actContact">Contact / company</label><input class="f-input" id="actContact" list="contactList" placeholder="Name" value="' + esc(cur.relatedName || "") + '">' + contactsDatalist() + '</div>' +
    '<div><label class="f-label" for="actCompany">Company</label><input class="f-input" id="actCompany" placeholder="Company" value="' + esc(cur.companyName || "") + '"></div></div>' +
    '<div class="tm-grid"><div><label class="f-label" for="actDate">Date</label><input class="f-input" type="date" id="actDate" value="' + esc(cur.date || todayISO()) + '"></div>' +
    '<div><label class="f-label" for="actDuration">Duration (min)</label><input class="f-input" type="number" min="0" id="actDuration" value="' + (cur.duration || 0) + '"></div></div>' +
    '<label class="f-label" for="actOutcome">Outcome</label><input class="f-input" id="actOutcome" placeholder="e.g. Positive · needs quote" value="' + esc(cur.outcome || "") + '">' +
    '<label class="f-label" for="actNotes">Notes</label><textarea class="f-area" id="actNotes" placeholder="Free text…">' + esc(cur.notes || "") + '</textarea>' +
    '<label class="f-label" for="actFollow">Follow-up date (optional)</label><input class="f-input" type="date" id="actFollow" value="' + esc(cur.followUpDate || "") + '">' +
    '<input class="f-input" id="actFollowNote" placeholder="Follow-up note (optional)" value="' + esc(cur.followUpNote || "") + '" style="margin-top:8px">';
  document.getElementById("actBody").innerHTML = b;
  document.getElementById("actVeil").classList.add("open");
  const chips = document.getElementById("actTypeChips");
  chips.addEventListener("click", e => { const c = e.target.closest("[data-acttype]"); if (!c) return; chips.querySelectorAll(".type-chip").forEach(x => x.classList.remove("on")); c.classList.add("on"); chips.dataset.val = c.dataset.acttype; });
  chips.dataset.val = cur.type;
  setTimeout(() => { const el = document.getElementById("actContact"); if (el) el.focus(); }, 60);
}
function ensureContact(name, company){
  name = (name || "").trim(); if (!name) return null;
  let c = Contacts.list(x => x.name.toLowerCase() === name.toLowerCase())[0];
  if (!c) c = Contacts.create({ name, company: (company || "").trim() });
  else if (company && !c.company) Contacts.update(c.id, { company: company.trim() });
  return c;
}
function saveAct(){
  const type = document.getElementById("actTypeChips").dataset.val || "note";
  const relatedName = document.getElementById("actContact").value.trim();
  const companyName = document.getElementById("actCompany").value.trim();
  const contact = relatedName ? ensureContact(relatedName, companyName) : null;
  const patch = {
    type, relatedName, companyName, contactId: contact ? contact.id : null,
    date: document.getElementById("actDate").value || todayISO(),
    duration: parseInt(document.getElementById("actDuration").value, 10) || 0,
    outcome: document.getElementById("actOutcome").value.trim(),
    notes: document.getElementById("actNotes").value.trim(),
    followUpDate: document.getElementById("actFollow").value || null,
    followUpNote: document.getElementById("actFollowNote").value.trim()
  };
  if (editingActId) Acts.update(editingActId, patch);
  else Acts.create(patch);
  document.getElementById("actVeil").classList.remove("open");
  toast("Activity saved.");
  refreshOps();
}
function deleteAct(){
  if (!editingActId) return;
  Acts.remove(editingActId);
  document.getElementById("actVeil").classList.remove("open");
  toast("Activity deleted.");
  refreshOps();
}

/* ---- AI parse: transcript / brain-dump -> structured activities + tasks + follow-ups ---- */
let parsed = null;
function openParseModal(){
  parsed = null;
  document.getElementById("parseBody").innerHTML =
    '<p class="ops-help">Paste a call transcript or an unstructured dump of your day. SYN will extract activities, tasks, and follow-ups for you to confirm before anything is saved.</p>' +
    '<textarea class="f-area" id="parseInput" style="min-height:180px" placeholder="e.g. Called Dana at Acme about the sample, she wants a quote by Friday. Emailed Ben the deck. Need to send samples to Riverside next week…"></textarea>';
  document.getElementById("parseFoot").innerHTML = '<button class="btn-ghost" data-close="parseVeil">Cancel</button><button class="btn-gold" id="parseRun">Extract</button>';
  document.getElementById("parseVeil").classList.add("open");
  document.getElementById("parseRun").addEventListener("click", runParse);
}
// local heuristic fallback so parse works (and is testable) even when the model is offline
function localParse(text){
  const acts = [], tasks = [], followUps = [];
  const lines = text.split(/[\n.;]+/).map(s => s.trim()).filter(s => s.length > 3);
  const guess = s => { s = s.toLowerCase();
    if (/\bcall(ed)?\b|\bphoned\b|\brang\b|\bspoke\b/.test(s)) return "call";
    if (/\bmet\b|\bmeeting\b|\bmet with\b|\bdemo\b/.test(s)) return "meeting";
    if (/\bemail(ed)?\b|\bsent .*deck\b|\breplied\b/.test(s)) return "email";
    if (/\bsample(s)?\b/.test(s)) return "sample";
    if (/\bappl(ied|ication)\b|\bsubmitted\b/.test(s)) return "application";
    return null; };
  lines.forEach(line => {
    const isTask = /\b(need to|todo|to-do|must|should|follow up|follow-up|send|schedule|prepare|draft)\b/i.test(line);
    const type = guess(line);
    const nameM = line.match(/\b(?:with|to|from|called)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/);
    const relatedName = nameM ? nameM[1] : "";
    if (type){ acts.push({ type, relatedName, notes: line, date: todayISO() }); }
    if (isTask || /\bby (friday|monday|tuesday|wednesday|thursday|next week|tomorrow)\b/i.test(line)){
      tasks.push({ title: line.slice(0, 80) });
      if (/\bfollow[- ]?up\b|\bnext week\b|\bby \w+day\b/i.test(line)) followUps.push({ note: line.slice(0, 80) });
    }
  });
  if (!acts.length && !tasks.length && lines.length) acts.push({ type:"note", relatedName:"", notes: lines[0].slice(0,120), date: todayISO() });
  return { activities: acts, tasks, followUps };
}
async function runParse(){
  const text = (document.getElementById("parseInput").value || "").trim();
  if (!text){ toast("Paste something to parse first."); return; }
  const pGate = gateAI("parse", "parse");   // daily hard cap on AI parses; local fallback still runs
  if (!pGate.ok){
    toast(pGate.reason);
    parsed = localParse(text);   // caps stop the API call, not the feature — fall back to local extraction
    renderParseConfirm();
    return;
  }
  if (pGate.reason) toast(pGate.reason);
  const btn = document.getElementById("parseRun"); btn.textContent = "Extracting…"; btn.disabled = true;
  let result = null;
  if (aiReady()){
    try{
      const sys = "You extract structured CRM data from a sales rep's notes. Return ONLY minified JSON, no prose, shaped as {\"activities\":[{\"type\":one of call|meeting|email|sample|application|note,\"relatedName\":string,\"companyName\":string,\"outcome\":string,\"notes\":string,\"date\":\"YYYY-MM-DD\"}],\"tasks\":[{\"title\":string,\"dueDate\":\"YYYY-MM-DD\"|null}],\"followUps\":[{\"note\":string,\"date\":\"YYYY-MM-DD\"|null}]}. Use today " + todayISO() + " for relative dates.";
      const raw = await aiText(sys, text, AI_MAX_TOKENS.parse);
      const m = raw.match(/\{[\s\S]*\}/);
      result = JSON.parse(m ? m[0] : raw);
    }catch(e){ result = null; }
  }
  if (!result) result = localParse(text);
  parsed = { activities: result.activities || [], tasks: result.tasks || [], followUps: result.followUps || [] };
  renderParseConfirm();
  btn.textContent = "Extract"; btn.disabled = false;
}
function renderParseConfirm(){
  const a = parsed.activities, t = parsed.tasks, f = parsed.followUps;
  let h = '<p class="ops-help">SYN found the following. Uncheck anything you do not want, then save. Nothing is stored until you confirm.</p>';
  if (a.length){ h += '<div class="parse-grp"><div class="parse-lbl">Activities · ' + a.length + '</div>';
    a.forEach((x,i) => h += '<label class="parse-item"><input type="checkbox" data-pgroup="activities" data-i="' + i + '" checked><span class="box"><svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg></span><span><b>' + esc(actTypeLabel(x.type)) + '</b>' + (x.relatedName ? ' · ' + esc(x.relatedName) : '') + '<div class="ops-dim">' + esc(x.notes || x.outcome || "") + '</div></span></label>');
    h += '</div>'; }
  if (t.length){ h += '<div class="parse-grp"><div class="parse-lbl">Tasks · ' + t.length + '</div>';
    t.forEach((x,i) => h += '<label class="parse-item"><input type="checkbox" data-pgroup="tasks" data-i="' + i + '" checked><span class="box"><svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg></span><span>' + esc(x.title) + (x.dueDate ? ' <span class="ops-dim">· due ' + esc(x.dueDate) + '</span>' : '') + '</span></label>');
    h += '</div>'; }
  if (f.length){ h += '<div class="parse-grp"><div class="parse-lbl">Follow-ups · ' + f.length + '</div>';
    f.forEach((x,i) => h += '<label class="parse-item"><input type="checkbox" data-pgroup="followUps" data-i="' + i + '" checked><span class="box"><svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg></span><span>' + esc(x.note) + (x.date ? ' <span class="ops-dim">· ' + esc(x.date) + '</span>' : '') + '</span></label>');
    h += '</div>'; }
  if (!a.length && !t.length && !f.length) h += '<div class="empty-log">Nothing structured could be extracted. Try adding more detail.</div>';
  document.getElementById("parseBody").innerHTML = h;
  document.getElementById("parseFoot").innerHTML = '<button class="btn-ghost" data-close="parseVeil">Cancel</button><button class="btn-gold" id="parseSave">Save selected</button>';
  document.getElementById("parseSave").addEventListener("click", saveParsed);
}
function saveParsed(){
  const keep = g => [...document.querySelectorAll('[data-pgroup="' + g + '"]')].filter(c => c.checked).map(c => +c.dataset.i);
  const ka = keep("activities"), kt = keep("tasks"), kf = keep("followUps");
  let n = 0;
  ka.forEach(i => { const x = parsed.activities[i]; const contact = x.relatedName ? ensureContact(x.relatedName, x.companyName) : null;
    Acts.create({ type: x.type || "note", relatedName: x.relatedName || "", companyName: x.companyName || "", contactId: contact ? contact.id : null, outcome: x.outcome || "", notes: x.notes || "", date: x.date || todayISO() }); n++; });
  kt.forEach(i => { const x = parsed.tasks[i]; Tasks.create({ title: x.title || "Task", dueDate: x.dueDate || null, status:"todo", visibility:"private" }); n++; });
  kf.forEach(i => { const x = parsed.followUps[i]; Acts.create({ type:"note", notes: x.note || "Follow-up", date: todayISO(), followUpDate: x.date || fmtISO(new Date(Date.now() + 7*86400000)), followUpNote: x.note || "" }); n++; });
  document.getElementById("parseVeil").classList.remove("open");
  toast("Saved " + n + " item" + (n===1?"":"s") + " from your notes.");
  refreshOps();
}

/* ================= FOLLOW-UPS VIEW ================= */
// Aggregates open follow-ups from both activities and tasks that the current user can see.
function collectFollowUps(){
  const out = [];
  myActs(a => a.followUpDate && !a.followUpDone).forEach(a => out.push({ kind:"act", id:a.id, date:a.followUpDate, title:(a.followUpNote || a.notes || actTypeLabel(a.type)), meta: actTypeLabel(a.type) + (a.relatedName ? " · " + a.relatedName : ""), ownerName:a.createdByName }));
  Tasks.list(t => canSeeTask(t) && t.followUpDate && !t.followUpDone && t.status !== "done").forEach(t => out.push({ kind:"task", id:t.id, date:t.followUpDate, title:(t.followUpNote || t.title), meta:"Task" + (t.projectId && projectById(t.projectId) ? " · " + projectById(t.projectId).name : ""), ownerName: teamName((t.assignees||[])[0]) }));
  return out.sort((a,b) => a.date < b.date ? -1 : 1);
}
function openFollowUpCount(){ return collectFollowUps().filter(f => { const e = escalate(f.date); return e.days !== null && e.days >= 0; }).length; }
function renderFollowups(){
  const p = document.getElementById("followupsPanel"); if (!p) return;
  const list = collectFollowUps();
  let h = '<div class="panel-head"><div><h2>Follow-ups</h2><p class="sub">Everything you owe a next touch. States escalate as they age — the label always tells you exactly how overdue.</p></div>' +
    '<button class="btn-ghost" data-act="opsExport" data-kind="followups">⤓ Export CSV</button></div>';
  // legend
  h += '<div class="esc-legend">' + ["upcoming","today","warm","red","critical"].map(k => { const sample = { upcoming:"in 3 days", today:"Due today", warm:"2 days overdue", red:"7 days overdue", critical:"20 days overdue" }[k]; const cls = "esc-" + k; return '<span class="esc-chip ' + cls + '">' + (k==="critical"?'<span class="esc-bang">!</span>':'<span class="esc-dot"></span>') + sample + '</span>'; }).join("") + '</div>';
  if (!list.length){ h += '<div class="empty-log">No open follow-ups. Add a follow-up date to any activity or task and it shows up here.</div>'; p.innerHTML = h; return; }
  h += '<div class="ops-list">';
  list.forEach(f => {
    const e = escalate(f.date);
    h += '<div class="ops-row fu-row ' + e.cls + '">' +
      '<div class="ops-main"><div class="ops-title">' + esc(f.title) + '</div>' +
      '<div class="ops-sub">' + esc(f.meta) + ' · due ' + esc(fmtDay(f.date)) + (isAdmin() && f.ownerName ? ' · ' + esc(f.ownerName) : '') + '</div></div>' +
      '<div class="ops-fu">' + escChip(e) + '</div>' +
      '<div class="fu-actions">' +
        '<button class="mini-btn" data-act="fuSnooze" data-kind="' + f.kind + '" data-id="' + f.id + '" title="Snooze 3 days">Snooze</button>' +
        '<button class="mini-btn" data-act="fuResched" data-kind="' + f.kind + '" data-id="' + f.id + '">Reschedule</button>' +
        '<button class="mini-btn gold" data-act="fuComplete" data-kind="' + f.kind + '" data-id="' + f.id + '">Complete</button>' +
      '</div></div>';
  });
  h += '</div>';
  p.innerHTML = h;
}
function fuSetDate(kind, id, date){ if (kind === "act") Acts.update(id, { followUpDate: date }); else Tasks.update(id, { followUpDate: date }); }
function fuSnooze(kind, id){ const from = new Date(); from.setHours(0,0,0,0); from.setDate(from.getDate() + 3); fuSetDate(kind, id, fmtISO(from)); toast("Snoozed 3 days."); refreshOps(); }
function fuComplete(kind, id){ if (kind === "act") Acts.update(id, { followUpDone:true }); else Tasks.update(id, { followUpDone:true }); toast("Follow-up complete."); refreshOps(); }
let reschedTarget = null;
function openResched(kind, id){ reschedTarget = { kind, id }; const cur = (kind === "act" ? Acts.get(id) : Tasks.get(id)) || {};
  document.getElementById("reschedBody").innerHTML = '<label class="f-label" for="reschedDate">New follow-up date</label><input class="f-input" type="date" id="reschedDate" value="' + esc(cur.followUpDate || todayISO()) + '">';
  document.getElementById("reschedVeil").classList.add("open"); }
function saveResched(){ if (!reschedTarget) return; const d = document.getElementById("reschedDate").value; if (!d){ toast("Pick a date."); return; } fuSetDate(reschedTarget.kind, reschedTarget.id, d); document.getElementById("reschedVeil").classList.remove("open"); toast("Rescheduled."); refreshOps(); }

/* ================= DEPENDENCIES VIEW ================= */
let depTab = "owe";  // owe = what I owe others; owed = what others owe me
function openDependencies(){ renderDeps(); }
function renderDeps(){
  const p = document.getElementById("depsPanel"); if (!p) return;
  const me = currentUser.id;
  const admin = isAdmin();
  let h = '<div class="panel-head"><div><h2>Dependencies</h2><p class="sub">Who is waiting on whom, and for how long. Requests notify the other person and show in their My Day.</p></div>' +
    '<button class="btn-gold" data-act="depNew">+ Request</button></div>';
  h += '<div class="mode-tabs">' +
    '<button class="mode-btn' + (depTab === "owe" ? " active" : "") + '" data-act="depTab" data-t="owe">What I owe others</button>' +
    '<button class="mode-btn' + (depTab === "owed" ? " active" : "") + '" data-act="depTab" data-t="owed">What others owe me</button>' +
    (admin ? '<button class="mode-btn' + (depTab === "all" ? " active" : "") + '" data-act="depTab" data-t="all">All open (admin)</button>' : '') + '</div>';
  let list;
  if (depTab === "owe") list = myDeps(d => d.oweeId === me && d.status === "open");
  else if (depTab === "owed") list = myDeps(d => d.requesterId === me && d.status === "open");
  else list = Deps.list(d => d.status === "open");   // admin-only tab (gated by button visibility + isAdmin below)
  if (depTab === "all" && !admin) list = [];
  list = list.sort((a,b) => (a.createdAt||"") < (b.createdAt||"") ? -1 : 1);
  if (!list.length){ h += '<div class="empty-log">Nothing here. ' + (depTab === "owe" ? "You are not blocking anyone." : depTab === "owed" ? "No one owes you anything right now." : "No open dependencies in the workspace.") + '</div>'; p.innerHTML = h; return; }
  h += '<div class="ops-list">';
  list.forEach(d => {
    const e = escalate(d.dueDate || fmtISO(new Date((d.createdAt||nowISO()).slice(0,10))));
    const daysOut = Math.max(0, Math.round((Date.now() - Date.parse(d.createdAt || nowISO())) / 86400000));
    const who = depTab === "owe" ? ("For " + esc(d.requesterName || teamName(d.requesterId))) : depTab === "owed" ? ("From " + esc(d.oweeName || teamName(d.oweeId))) : (esc(d.requesterName || teamName(d.requesterId)) + " → " + esc(d.oweeName || teamName(d.oweeId)));
    h += '<div class="ops-row dep-row ' + e.cls + '">' +
      '<div class="ops-main"><div class="ops-title">' + esc(d.note || "(no detail)") + '</div>' +
      '<div class="ops-sub">' + who + ' · requested ' + esc(fmtDay((d.createdAt||"").slice(0,10))) + ' · ' + daysOut + ' day' + (daysOut===1?"":"s") + ' outstanding' + '</div></div>' +
      '<div class="ops-fu">' + (d.dueDate ? escChip(e) : '<span class="esc-chip esc-upcoming"><span class="esc-dot"></span>' + daysOut + 'd outstanding</span>') + '</div>' +
      '<div class="fu-actions">' + ((d.oweeId === me || d.requesterId === me || admin) ? '<button class="mini-btn gold" data-act="depResolve" data-id="' + d.id + '">Mark done</button>' : '') + '</div></div>';
  });
  h += '</div>';
  p.innerHTML = h;
}
function openDepModal(){
  const others = TEAM.filter(u => u.id !== currentUser.id);
  document.getElementById("depBody").innerHTML =
    '<label class="f-label" for="depOwee">Waiting on</label><select class="f-input" id="depOwee">' + (others.length ? others.map(u => '<option value="' + u.id + '">' + esc(u.name) + '</option>').join("") : '<option value="">No teammates yet</option>') + '</select>' +
    '<label class="f-label" for="depNote">What do you need?</label><textarea class="f-area" id="depNote" placeholder="e.g. Approved pricing for the Riverside quote"></textarea>' +
    '<label class="f-label" for="depDue">Needed by (optional)</label><input class="f-input" type="date" id="depDue">';
  document.getElementById("depVeil").classList.add("open");
}
function saveDep(){
  const oweeId = document.getElementById("depOwee").value;
  const note = document.getElementById("depNote").value.trim();
  if (!oweeId){ toast("Pick a teammate."); return; }
  if (!note){ toast("Describe what you need."); return; }
  const d = Deps.create({ requesterId: currentUser.id, requesterName: currentUser.name, oweeId, oweeName: teamName(oweeId), note, dueDate: document.getElementById("depDue").value || null, status:"open" });
  notify(oweeId, "assigned", currentUser.name + " is waiting on you: " + note.slice(0, 60), { view:"deps" });
  document.getElementById("depVeil").classList.remove("open");
  toast("Request sent to " + teamName(oweeId) + ".");
  refreshOps();
}
function resolveDep(id){ const d = Deps.get(id); if (!d) return; Deps.update(id, { status:"done", resolvedAt: nowISO() }); if (d.requesterId && d.requesterId !== currentUser.id) notify(d.requesterId, "assigned", teamName(currentUser.id) + " resolved: " + (d.note||"").slice(0,60), { view:"deps" }); toast("Marked done."); refreshOps(); }

/* ================= WEEKLY RECAP ================= */
let recapUser = null, recapWeekOffset = 0;
function weekBounds(offset){ const ws = weekStart(new Date()); ws.setDate(ws.getDate() + offset*7); const we = new Date(ws); we.setDate(we.getDate()+6); return { start: fmtISO(ws), end: fmtISO(we) }; }
function computeRecap(uid, offset){
  const wb = weekBounds(offset);
  const nb = weekBounds(offset + 1);
  const inWeek = d => d >= wb.start && d <= wb.end;
  const acts = Acts.list(a => a.createdBy === uid && inWeek(a.date));
  const counts = {}; ACT_TYPES.forEach(t => counts[t[0]] = 0); acts.forEach(a => counts[a.type] = (counts[a.type]||0) + 1);
  const tasksCompleted = Tasks.list(t => t.completedAt && t.completedAt.slice(0,10) >= wb.start && t.completedAt.slice(0,10) <= wb.end && ((t.assignees||[]).includes(uid) || t.createdBy === uid));
  const tasksOpen = Tasks.list(t => t.status !== "done" && (t.assignees||[]).includes(uid));
  const followUpsNext = collectFollowUpsFor(uid).filter(f => f.date >= nb.start && f.date <= nb.end);
  const deps = Deps.list(d => d.status === "open" && (d.requesterId === uid || d.oweeId === uid));
  return { wb, acts, counts, tasksCompleted, tasksOpen, followUpsNext, deps };
}
function collectFollowUpsFor(uid){
  const out = [];
  Acts.list(a => a.createdBy === uid && a.followUpDate && !a.followUpDone).forEach(a => out.push({ date:a.followUpDate, title:(a.followUpNote||a.notes||actTypeLabel(a.type)) }));
  Tasks.list(t => (t.assignees||[]).includes(uid) && t.followUpDate && !t.followUpDone && t.status!=="done").forEach(t => out.push({ date:t.followUpDate, title:(t.followUpNote||t.title) }));
  return out.sort((a,b)=>a.date<b.date?-1:1);
}
async function renderRecap(){
  const p = document.getElementById("recapPanel"); if (!p) return;
  if (!recapUser) recapUser = currentUser.id;
  if (!canSeeRecapOf(recapUser)) recapUser = currentUser.id;   // data-layer guard: members can only view their own
  const uid = recapUser, r = computeRecap(uid, recapWeekOffset);
  const totalActs = r.acts.length;
  let h = '<div class="panel-head"><div><h2>Weekly Recap</h2><p class="sub">' + esc(fmtDay(r.wb.start)) + ' – ' + esc(fmtDay(r.wb.end)) + (recapWeekOffset===0?' · this week':'') + '</p></div><div class="recap-ctl" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">';
  if (isAdmin()) h += '<select class="af-select" data-act="recapPerson">' + TEAM.map(u => '<option value="' + u.id + '"' + (uid===u.id?" selected":"") + '>' + esc(u.name) + (u.id===currentUser.id?" (you)":"") + '</option>').join("") + '</select>';
  h += '<button class="btn-ghost" data-act="recapWeek" data-d="-1">‹ Prev</button><button class="btn-ghost" data-act="recapWeek" data-d="0">This week</button><button class="btn-ghost" data-act="recapWeek" data-d="1">Next ›</button>' +
    '<button class="btn-ghost" data-act="opsExport" data-kind="recap">⤓ CSV</button></div></div>';
  h += '<div class="recap-head">' + avatarHtml(uid, "recap-av") + '<div><div class="recap-name">' + esc(teamName(uid)) + '</div><div class="ops-dim">' + totalActs + ' activities · ' + r.tasksCompleted.length + ' tasks completed · ' + r.tasksOpen.length + ' still open</div></div></div>';
  // stat tiles
  h += '<div class="stat-strip">' + ACT_TYPES.map(t => '<div class="stat-tile"><b>' + (r.counts[t[0]]||0) + '</b><span>' + esc(t[1]) + '</span></div>').join("") + '</div>';
  // narrative
  h += '<div class="spec-block"><div class="sb-head">The week in review</div><div class="sb-body"><div id="recapNarr" class="recap-narr">' + esc(templateNarrative(uid, r)) + '</div>' +
    (aiReady() ? '<button class="btn-ghost" data-act="recapAI" style="margin-top:10px">✦ Write a richer narrative with SYN</button>' : '') + '</div></div>';
  // columns
  h += '<div class="md-grid">';
  h += '<div class="spec-block md-card"><div class="sb-head">Tasks completed · ' + r.tasksCompleted.length + '</div><div class="sb-body">' + (r.tasksCompleted.length ? r.tasksCompleted.map(t => '<div class="md-act-line">' + esc(t.title) + '</div>').join("") : '<div class="md-empty-row">None completed this week.</div>') + '</div></div>';
  h += '<div class="spec-block md-card"><div class="sb-head">Still open · ' + r.tasksOpen.length + '</div><div class="sb-body">' + (r.tasksOpen.length ? r.tasksOpen.slice(0,8).map(t => '<div class="md-act-line">' + esc(t.title) + '</div>').join("") : '<div class="md-empty-row">Clear.</div>') + '</div></div>';
  h += '<div class="spec-block md-card"><div class="sb-head">Follow-ups due next week · ' + r.followUpsNext.length + '</div><div class="sb-body">' + (r.followUpsNext.length ? r.followUpsNext.map(f => '<div class="md-act-line">' + esc(f.title) + '<span class="t">' + esc(fmtDay(f.date)) + '</span></div>').join("") : '<div class="md-empty-row">None scheduled.</div>') + '</div></div>';
  h += '<div class="spec-block md-card"><div class="sb-head">Outstanding dependencies · ' + r.deps.length + '</div><div class="sb-body">' + (r.deps.length ? r.deps.map(d => '<div class="md-act-line">' + esc(d.note||"") + '<span class="t">' + (d.oweeId===uid?"you owe":"owed to you") + '</span></div>').join("") : '<div class="md-empty-row">No open dependencies.</div>') + '</div></div>';
  h += '</div>';
  p.innerHTML = h;
}
function templateNarrative(uid, r){
  const name = teamName(uid).split(" ")[0] || "You";
  const total = r.acts.length;
  const topType = ACT_TYPES.map(t => [t[1], r.counts[t[0]]||0]).sort((a,b)=>b[1]-a[1])[0];
  const parts = [];
  parts.push(name + " logged " + total + " activit" + (total===1?"y":"ies") + " this week" + (topType && topType[1] ? ", most of them " + topType[0].toLowerCase() + "s" : "") + ".");
  parts.push(r.tasksCompleted.length + " task" + (r.tasksCompleted.length===1?"":"s") + " closed" + (r.tasksOpen.length ? ", " + r.tasksOpen.length + " still open" : "") + ".");
  if (r.followUpsNext.length) parts.push(r.followUpsNext.length + " follow-up" + (r.followUpsNext.length===1?" lands":"s land") + " next week, worth front-loading.");
  if (r.deps.length) parts.push(r.deps.length + " dependenc" + (r.deps.length===1?"y is":"ies are") + " still open.");
  return parts.join(" ");
}
async function recapAINarrative(){
  const el = document.getElementById("recapNarr"); if (!el) return;
  const uid = recapUser, r = computeRecap(uid, recapWeekOffset);
  el.textContent = "Writing…";
  try{
    const facts = "Rep: " + teamName(uid) + ". Activities by type: " + ACT_TYPES.map(t => t[1] + "=" + (r.counts[t[0]]||0)).join(", ") + ". Tasks completed: " + r.tasksCompleted.length + ". Tasks open: " + r.tasksOpen.length + ". Follow-ups next week: " + r.followUpsNext.map(f=>f.title).join("; ") + ". Open dependencies: " + r.deps.map(d=>d.note).join("; ") + ".";
    recordCost("recap");   // batch-eligible, non-interactive (AI_BATCH_ELIGIBLE): tracked, not daily-capped
    const txt = await aiText("You are a sales operations lead writing a crisp 3-4 sentence weekly recap for a rep, then a short 'Suggested for next week' list of 2-3 bullet follow-ups. No em dashes. Base it only on the facts given.", facts, AI_MAX_TOKENS.recap);
    el.innerHTML = renderMD(txt);
  }catch(e){ el.textContent = templateNarrative(uid, r); toast("SYN is offline; kept the summary."); }
}

/* ================= COMPANY ROLLUP (admin only) ================= */
function renderRollup(){
  const p = document.getElementById("rollupPanel"); if (!p) return;
  if (!isAdmin()){ p.innerHTML = '<div class="empty-log">The company rollup is available to workspace admins.</div>'; return; }
  const tw = weekBounds(0), lw = weekBounds(-1);
  const inW = (d,b) => d >= b.start && d <= b.end;
  const allActs = Acts.list(() => true);
  const thisWeek = allActs.filter(a => inW(a.date, tw));
  const lastWeek = allActs.filter(a => inW(a.date, lw));
  const byType = {}; ACT_TYPES.forEach(t => byType[t[0]] = 0); thisWeek.forEach(a => byType[a.type] = (byType[a.type]||0)+1);
  const tasksCompleted = Tasks.list(t => t.completedAt && inW(t.completedAt.slice(0,10), tw)).length;
  const tasksOpened = Tasks.list(t => t.createdAt && inW(t.createdAt.slice(0,10), tw)).length;
  const openDeps = Deps.list(d => d.status === "open");
  const trend = thisWeek.length - lastWeek.length;
  let h = '<div class="panel-head"><div><h2>Company Rollup</h2><p class="sub">Workspace-wide operations for ' + esc(fmtDay(tw.start)) + ' – ' + esc(fmtDay(tw.end)) + '. Admin only.</p></div>' +
    '<button class="btn-ghost" data-act="opsExport" data-kind="rollup">⤓ Export CSV</button></div>';
  h += '<div class="stat-strip">' +
    '<div class="stat-tile"><b>' + thisWeek.length + '</b><span>Activities this week</span></div>' +
    '<div class="stat-tile"><b>' + (trend>=0?"+":"") + trend + '</b><span>vs last week</span></div>' +
    '<div class="stat-tile"><b>' + tasksCompleted + '</b><span>Tasks completed</span></div>' +
    '<div class="stat-tile"><b>' + tasksOpened + '</b><span>Tasks opened</span></div>' +
    '<div class="stat-tile"><b>' + openDeps.length + '</b><span>Open dependencies</span></div></div>';
  // by type
  h += '<div class="spec-block"><div class="sb-head">Activities by type · this week</div><div class="sb-body"><div class="roll-bars">';
  const maxT = Math.max(1, ...ACT_TYPES.map(t => byType[t[0]]||0));
  ACT_TYPES.forEach(t => { const v = byType[t[0]]||0; h += '<div class="roll-bar"><span class="rb-lbl">' + esc(t[1]) + '</span><span class="rb-track"><span class="rb-fill" style="width:' + (v/maxT*100) + '%"></span></span><span class="rb-val">' + v + '</span></div>'; });
  h += '</div></div></div>';
  // per person
  h += '<div class="spec-block"><div class="sb-head">Per-person this week</div><div class="sb-body"><div class="roll-scroll"><table class="roll-table"><thead><tr><th>Person</th>' + ACT_TYPES.map(t => '<th>' + esc(t[1]) + '</th>').join("") + '<th>Total</th></tr></thead><tbody>';
  TEAM.forEach(u => { const ua = thisWeek.filter(a => a.createdBy === u.id); const c = {}; ACT_TYPES.forEach(t => c[t[0]] = ua.filter(a => a.type===t[0]).length);
    h += '<tr><td>' + esc(u.name) + '</td>' + ACT_TYPES.map(t => '<td>' + c[t[0]] + '</td>').join("") + '<td><b>' + ua.length + '</b></td></tr>'; });
  h += '</tbody></table></div></div></div>';
  // open deps
  h += '<div class="spec-block"><div class="sb-head">All open dependencies · ' + openDeps.length + '</div><div class="sb-body">' + (openDeps.length ? openDeps.map(d => { const days = Math.max(0, Math.round((Date.now()-Date.parse(d.createdAt||nowISO()))/86400000)); return '<div class="md-act-line">' + esc(d.requesterName||teamName(d.requesterId)) + ' → ' + esc(d.oweeName||teamName(d.oweeId)) + ': ' + esc(d.note||"") + '<span class="t">' + days + 'd</span></div>'; }).join("") : '<div class="md-empty-row">No open dependencies.</div>') + '</div></div>';
  p.innerHTML = h;
}

/* ================= CSV EXPORT ================= */
function csvCell(v){ v = (v == null ? "" : String(v)); return /[",\n]/.test(v) ? '"' + v.replace(/"/g,'""') + '"' : v; }
function csvDoc(rows){ return "﻿" + rows.map(r => r.map(csvCell).join(",")).join("\r\n"); }   // BOM so Excel reads UTF-8
function personFilterMatch(uid){ return !actFilter.person || uid === actFilter.person; }
function exportOps(kind){
  let rows, name;
  const dateOk = d => (!actFilter.from || d >= actFilter.from) && (!actFilter.to || d <= actFilter.to);
  if (kind === "activities" || kind === undefined){
    rows = [["Date","Type","Owner","Contact","Company","Duration (min)","Outcome","Notes","Follow-up"]];
    myActs(a => personFilterMatch(a.createdBy) && dateOk(a.date)).sort((a,b)=>a.date<b.date?-1:1)
      .forEach(a => rows.push([a.date, actTypeLabel(a.type), a.createdByName||teamName(a.createdBy), a.relatedName, a.companyName, a.duration||0, a.outcome, a.notes, a.followUpDate||""]));
    name = "activities";
  } else if (kind === "tasks"){
    rows = [["Title","Status","Priority","Assignees","Due","Completed","Project","Follow-up"]];
    Tasks.list(t => canSeeTask(t) && personFilterMatch((t.assignees||[])[0]) && (!actFilter.from || (t.dueDate||t.createdAt.slice(0,10)) >= actFilter.from) && (!actFilter.to || (t.dueDate||t.createdAt.slice(0,10)) <= actFilter.to))
      .forEach(t => rows.push([t.title, t.status, (T_PRI[t.priority]||T_PRI.med).label, (t.assignees||[]).map(teamName).join("; "), t.dueDate||"", t.completedAt?t.completedAt.slice(0,10):"", (t.projectId&&projectById(t.projectId)?projectById(t.projectId).name:""), t.followUpDate||""]));
    name = "tasks";
  } else if (kind === "followups"){
    rows = [["Due","Item","Detail","State"]];
    collectFollowUps().forEach(f => { const e = escalate(f.date); rows.push([f.date, f.title, f.meta, e.label]); });
    name = "followups";
  } else if (kind === "recap" || kind === "rollup"){
    rows = [["Person","Week"].concat(ACT_TYPES.map(t=>t[1])).concat(["Tasks completed","Tasks open"])];
    const targets = kind === "rollup" ? TEAM.map(u=>u.id) : [recapUser || currentUser.id];
    targets.filter(canSeeRecapOf).forEach(uid => { const r = computeRecap(uid, kind==="rollup"?0:recapWeekOffset);
      rows.push([teamName(uid), r.wb.start + "/" + r.wb.end].concat(ACT_TYPES.map(t=>r.counts[t[0]]||0)).concat([r.tasksCompleted.length, r.tasksOpen.length])); });
    name = kind === "rollup" ? "company_rollup" : "weekly_recap";
  }
  doDownload({ name: (ORG?ORG.name.replace(/[^\w\- ]/g,"").trim():"SYN") + "_" + name + ".csv", content: csvDoc(rows) });
  toast("Exported " + name + ".csv");
}

/* ---- shared refresh + badges ---- */
function refreshOps(){
  const v = document.querySelector(".view.active");
  if (v){ const id = v.id;
    if (id === "view-activity") renderActivity();
    else if (id === "view-followups") renderFollowups();
    else if (id === "view-deps") renderDeps();
    else if (id === "view-recap") renderRecap();
    else if (id === "view-rollup") renderRollup();
    else if (id === "view-myday") renderMyDay();
  }
  updateOpsBadges();
}
function updateOpsBadges(){
  if (!currentUser) return;
  const fu = openFollowUpCount();
  const fb = document.getElementById("fuBadge"); if (fb){ fb.style.display = fu ? "inline-block" : "none"; fb.textContent = fu; }
  const dc = myDeps(d => d.oweeId === currentUser.id && d.status === "open").length;
  const db = document.getElementById("depBadge"); if (db){ db.style.display = dc ? "inline-block" : "none"; db.textContent = dc; }
  // admin-only nav visibility for rollup
  const rb = document.querySelector('.nav-btn[data-view="rollup"]'); if (rb) rb.style.display = isAdmin() ? "" : "none";
}

/* ==================================================================
   PRICING + AI FAIR USE  (per-seat model, pooled allowance, seat lock)
   Single source of truth used by both the marketing site and the app.
   ================================================================== */
const SEAT_PRICE = { s1: 39, s10: 35, s25: 29 };  // 1-9 / 10-24 / 25+
const BRAND_PRICE = 199;                          // per additional brand / mo (1 included)
const DEFAULT_SEATS = 5;                          // seats a new workspace starts with
// per-seat monthly AI allowance, pooled across the workspace
const AI_ALLOWANCE = { standard: 500, smart: 100, image: 20, parse: 20 };
const AI_LABELS = { standard: "Standard messages", smart: "Smart / brand messages", image: "Image generations", parse: "Transcript parses" };

