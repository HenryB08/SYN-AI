/* ============================================================
   js/07-calendar-views.js — CALENDAR (month/week/day/agenda), the event modal, Google Calendar / ICS export, AI event ingestion ([[EVENT:]]), the profile + integrations click-delegation (part 2), and the remaining view renderers.
   MOVE, not a refactor: a byte-identical slice of the original inline <script>.
   Order-dependent. Loads after 06-tasks.js and before 08-wiring.js. Shared global
   scope, not a module. Do not reorder these tags.
   ============================================================ */
/* =====================================================================
   STAGE 2 · CALENDAR (month / week / agenda, events, recurrence, ICS)
   ===================================================================== */
let calView = "month";                                  // month | week | agenda
let calCursor = (() => { const d = new Date(); d.setHours(0,0,0,0); return d; })();
let evDraft = null, editingEventId = null;
const WD = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const EV_COLORS = ["#8E959F","#5FD4B0","#A78BFF","#B8BCC4","#FF7A6B","#EE9A5B","#7FD99A"];

function dparse(s){ return new Date(s + "T00:00:00"); }
function fmtISO(d){ return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0"); }
function todayISO(){ return fmtISO(new Date()); }
function stepRecur(d, freq){ const n = new Date(d); if (freq === "weekly") n.setDate(n.getDate()+7); else if (freq === "monthly") n.setMonth(n.getMonth()+1); else n.setDate(n.getDate()+1); return n; }
function canSeeEvent(ev){ return ev.visibility !== "private" || (currentUser && ev.createdBy === currentUser.id); }
function monthGridStart(c){ const d = new Date(c.getFullYear(), c.getMonth(), 1); d.setDate(d.getDate() - d.getDay()); d.setHours(0,0,0,0); return d; }
function weekStart(c){ const d = new Date(c); d.setDate(d.getDate() - d.getDay()); d.setHours(0,0,0,0); return d; }
function fmtRange(a, b){
  const sameMonth = a.getMonth() === b.getMonth();
  const opt = { month:"short", day:"numeric" };
  return a.toLocaleDateString([], opt) + " – " + (sameMonth ? b.getDate() : b.toLocaleDateString([], opt)) + ", " + b.getFullYear();
}

/* expand events into per-day items across [startStr, endStr] */
function calItemsByDay(startStr, endStr){
  const map = {};
  const push = (iso, item) => { (map[iso] = map[iso] || []).push(item); };
  const rs = dparse(startStr), re = dparse(endStr);
  Events.list(canSeeEvent).forEach(ev => {
    if (!ev.startDate) return;
    const base = dparse(ev.startDate);
    const spanMs = Math.max(0, (ev.endDate ? dparse(ev.endDate) : base) - base);
    const occs = [];
    if (ev.recur && ev.recur.freq){
      const until = ev.recur.until ? dparse(ev.recur.until) : re;
      let cur = new Date(base), guard = 0;
      while (cur <= re && cur <= until && guard++ < 800){ occs.push(new Date(cur)); cur = stepRecur(cur, ev.recur.freq); }
    } else occs.push(base);
    occs.forEach(oStart => {
      const oEnd = new Date(oStart.getTime() + spanMs);
      if (oEnd < rs || oStart > re) return;
      const startISO = fmtISO(oStart), endISO = fmtISO(oEnd);
      let cur = new Date(oStart), g = 0;
      while (cur <= oEnd && g++ < 90){
        const iso = fmtISO(cur);
        if (iso >= startStr && iso <= endStr) push(iso, { kind:"event", ev, isStart: iso === startISO, isEnd: iso === endISO });
        cur = new Date(cur.getTime() + 86400000);
      }
    });
  });
  if (SETTINGS.calShowTasks !== false){
    Tasks.list(t => canSeeTask(t) && t.dueDate && t.dueDate >= startStr && t.dueDate <= endStr).forEach(t => push(t.dueDate, { kind:"task", task:t }));
  }
  const sortKey = it => it.kind === "task" ? "3" : (it.ev.allDay ? "0" : "1" + (it.ev.startTime || "99:99"));
  Object.keys(map).forEach(k => map[k].sort((a,b) => sortKey(a).localeCompare(sortKey(b))));
  return map;
}
/* 12-hour clock display for every user-facing time. Storage stays 24-hour "HH:MM". */
function fmtT12(hhmm){
  if (!hhmm || !/^\d{1,2}:\d{2}$/.test(hhmm)) return hhmm || "";
  let [h, m] = hhmm.split(":").map(Number);
  const ap = h < 12 ? "AM" : "PM";
  h = (h % 12) || 12;
  return h + ":" + String(m).padStart(2, "0") + " " + ap;
}
function fmtHour12(hr){ const ap = hr < 12 ? "AM" : "PM"; const h = (hr % 12) || 12; return h + " " + ap; }
function calChipHtml(item){
  if (item.kind === "task"){ const t = item.task; return '<button class="cal-ev task" data-wact="openTaskCal" data-tid="' + t.id + '" title="Task due: ' + esc(t.title) + '"><span class="ce-t">✓ ' + esc(t.title || "Task") + '</span>' + calAvatars(t.assignees, 2) + '</button>'; }
  const ev = item.ev;
  const tm = (!ev.allDay && item.isStart && ev.startTime) ? fmtT12(ev.startTime) + " " : "";
  return '<button class="cal-ev' + (item.isStart ? "" : " cont") + '" style="--ec:' + esc(ev.color || "#8E959F") + ';--ec-soft:' + hexToSoft(ev.color || "#8E959F") + '" data-wact="openEvent" data-eid="' + ev.id + '" title="' + esc(ev.title) + '"><span class="ce-t">' + (item.isStart ? esc(tm) : "↳ ") + esc(ev.title || "Event") + '</span>' + (item.isStart ? calAvatars(ev.attendees, 2) : "") + '</button>';
}

// Compact avatar cluster for calendar items (event attendees / task assignees).
function calAvatars(ids, max){
  ids = ids || []; if (!ids.length) return "";
  max = max || 3;
  return '<span class="cal-avs">' + ids.slice(0, max).map(id => avatarHtml(id, "cal-av")).join("") +
    (ids.length > max ? '<span class="cal-av-more">+' + (ids.length - max) + '</span>' : "") + '</span>';
}
function dayItemHtml(item){
  if (item.kind === "task"){ const t = item.task; return '<button class="cal-ev task" data-wact="openTaskCal" data-tid="' + t.id + '" title="Task due: ' + esc(t.title) + '"><span class="ce-t">✓ ' + esc(t.title || "Task") + '</span>' + calAvatars(t.assignees, 3) + '</button>'; }
  const ev = item.ev; const tm = (!ev.allDay && ev.startTime) ? fmtT12(ev.startTime) + " " : "";
  return '<button class="cal-ev" style="--ec:' + esc(ev.color || "#8E959F") + ';--ec-soft:' + hexToSoft(ev.color || "#8E959F") + '" data-wact="openEvent" data-eid="' + ev.id + '" title="' + esc(ev.title) + '"><span class="ce-t">' + esc(tm) + esc(ev.title || "Event") + '</span>' + calAvatars(ev.attendees, 3) + (ev.meetingLink ? '<a class="ev-join" href="' + esc(ev.meetingLink) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">Join</a>' : "") + '</button>';
}
// Day view: hour-by-hour timeline with events at their times, plus an all-day / due band.
function renderDay(){
  const iso = fmtISO(calCursor);
  const items = (calItemsByDay(iso, iso)[iso] || []);
  const band = items.filter(it => it.kind === "task" || (it.kind === "event" && it.ev.allDay));
  const timed = items.filter(it => it.kind === "event" && !it.ev.allDay);
  const byHour = {};
  timed.forEach(it => { const hr = parseInt((it.ev.startTime || "09:00").split(":")[0], 10) || 0; (byHour[hr] = byHour[hr] || []).push(it); });
  const nowHr = (iso === todayISO()) ? new Date().getHours() : -1;
  // Default scroll target: 7 AM, or the first event of the day if it starts earlier — all 24h stay reachable.
  const evHours = timed.map(it => parseInt((it.ev.startTime || "09:00").split(":")[0], 10));
  const scrollHr = Math.max(0, Math.min(7, evHours.length ? Math.min(...evHours) : 7));
  let h = '<div class="cal-day"><div class="cal-day-allday"><div class="cd-lbl">All day &amp; due</div><div class="cd-band">' +
    (band.length ? band.map(dayItemHtml).join("") : '<span class="cal-daycol-empty">Nothing all-day or due</span>') + '</div></div><div class="cal-day-grid" data-scroll-hr="' + scrollHr + '">';
  for (let hr = 0; hr < 24; hr++){
    const slot = String(hr).padStart(2, "0") + ":00";     // 24h value kept for slot creation
    h += '<div class="cd-hour' + (hr === nowHr ? " now" : "") + '" data-wact="calSlot" data-d="' + iso + '" data-t="' + slot + '"><div class="cd-time">' + fmtHour12(hr) + '</div><div class="cd-slot">' + (byHour[hr] || []).map(dayItemHtml).join("") + '</div></div>';
  }
  return h + '</div></div>';
}

function renderCalendar(){
  const wrap = document.getElementById("calWrap"); if (!wrap) return;
  let label, body;
  if (calView === "month"){ label = calCursor.toLocaleDateString([], { month:"long", year:"numeric" }); body = renderMonth(); }
  else if (calView === "week"){ const ws = weekStart(calCursor); label = fmtRange(ws, new Date(ws.getTime() + 6*86400000)); body = renderWeek(); }
  else if (calView === "day"){ label = calCursor.toLocaleDateString([], { weekday:"long", month:"long", day:"numeric" }); body = renderDay(); }
  else { label = "Agenda · next 45 days"; body = renderAgenda(); }
  const seg = (v, l) => '<button class="mode-btn' + (calView === v ? " active" : "") + '" data-wact="calView" data-v="' + v + '">' + l + '</button>';
  const bar = '<div class="cal-bar"><h2>' + esc(label) + '</h2>' +
    '<div class="cal-navctl"><button class="cal-arrow" data-wact="calNav" data-dir="-1" aria-label="Previous">‹</button>' +
    '<button class="mode-btn" data-wact="calToday">Today</button>' +
    '<button class="cal-arrow" data-wact="calNav" data-dir="1" aria-label="Next">›</button></div>' +
    '<div class="cal-actions">' + seg("month","Month") + seg("week","Week") + seg("day","Day") + seg("agenda","Agenda") +
    '<button class="head-btn ghost" data-wact="exportAllIcs" style="padding:8px 15px">⤓ Export .ics</button>' +
    '<button class="head-btn" data-wact="newEvent" style="padding:8px 17px">+ New Event</button></div></div>';
  wrap.innerHTML = bar + body;
  // Day view: scroll the 24-hour grid to the morning (or first event) so early hours aren't stranded off-screen.
  if (calView === "day"){
    const grid = wrap.querySelector(".cal-day-grid");
    if (grid){
      const hr = parseInt(grid.dataset.scrollHr || "7", 10);
      const row = grid.children[hr];
      if (row) grid.scrollTop = row.offsetTop;
    }
  }
}
function renderMonth(){
  const start = monthGridStart(calCursor);
  const map = calItemsByDay(fmtISO(start), fmtISO(new Date(start.getTime() + 41*86400000)));
  const today = todayISO(), curMonth = calCursor.getMonth();
  let h = '<div class="cal-grid-head">' + WD.map(d => '<div>' + d + '</div>').join("") + '</div><div class="cal-grid">';
  for (let i = 0; i < 42; i++){
    const d = new Date(start.getTime() + i*86400000), iso = fmtISO(d);
    const items = map[iso] || [], shown = items.slice(0, 3);
    h += '<div class="cal-cell' + (d.getMonth() !== curMonth ? " other" : "") + (iso === today ? " today" : "") + '" data-wact="calDay" data-d="' + iso + '">' +
      '<div class="cal-daynum">' + d.getDate() + '</div><div class="cal-evs">' +
      shown.map(calChipHtml).join("") + (items.length > 3 ? '<div class="cal-more">+' + (items.length - 3) + ' more</div>' : "") +
      '</div></div>';
  }
  return h + '</div>';
}
function renderWeek(){
  const ws = weekStart(calCursor);
  const map = calItemsByDay(fmtISO(ws), fmtISO(new Date(ws.getTime() + 6*86400000)));
  const today = todayISO();
  let h = '<div class="cal-week">';
  for (let i = 0; i < 7; i++){
    const d = new Date(ws.getTime() + i*86400000), iso = fmtISO(d), items = map[iso] || [];
    h += '<div class="cal-daycol' + (iso === today ? " today" : "") + '"><div class="cal-daycol-head" data-wact="calDay" data-d="' + iso + '"><b>' + WD[d.getDay()] + '</b> ' + d.getDate() + '</div>' +
      '<div class="cal-daycol-body" data-wact="calDay" data-d="' + iso + '">' + (items.length ? items.map(calChipHtml).join("") : '<div class="cal-daycol-empty">+ add</div>') + '</div></div>';
  }
  return h + '</div>';
}
function renderAgenda(){
  const start = new Date(calCursor);
  const map = calItemsByDay(fmtISO(start), fmtISO(new Date(start.getTime() + 44*86400000)));
  const days = Object.keys(map).sort();
  if (!days.length) return '<div class="empty-log tasks-empty">Nothing scheduled in the next 45 days. Add an event with <b>+ New Event</b>, or ask SYN to schedule one.</div>';
  let h = '<div class="cal-agenda">';
  days.forEach(iso => {
    const d = dparse(iso);
    h += '<div class="cal-ag-day"><div class="cal-ag-head">' + d.toLocaleDateString([], { weekday:"short", month:"short", day:"numeric" }) + (iso === todayISO() ? " · Today" : "") + '</div>';
    map[iso].forEach(item => {
      if (item.kind === "task"){ const t = item.task; h += '<div class="cal-ag-row task" data-wact="openTaskCal" data-tid="' + t.id + '"><span class="ag-dot" style="background:var(--muted)"></span><span class="ag-time">Task</span><span class="ag-title">' + esc(t.title || "Task") + '</span></div>'; }
      else { const ev = item.ev; h += '<div class="cal-ag-row" data-wact="openEvent" data-eid="' + ev.id + '"><span class="ag-dot" style="background:' + esc(ev.color) + '"></span><span class="ag-time">' + (ev.allDay ? "All day" : esc(fmtT12(ev.startTime))) + '</span><span class="ag-title">' + esc(ev.title || "Event") + (item.isStart ? "" : " (cont.)") + '</span>' + (ev.meetingLink ? '<a class="ev-join" href="' + esc(ev.meetingLink) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()" style="margin-left:auto">Join</a>' : "") + '</div>'; }
    });
    h += '</div>';
  });
  return h + '</div>';
}

/* ----- event modal ----- */
function blankEvent(dateISO){ return { title:"", description:"", location:"", startDate:dateISO, endDate:dateISO, allDay:false, startTime:"09:00", endTime:"10:00", attendees:[], color:"#8E959F", taskId:null, projectId:null, recur:null, reminder:0, visibility:"team" }; }
let evMoreOpen = false;
function eventHasDetail(ev, editing){
  if (editing) return true;
  return !!(ev.location || ev.description || (ev.attendees || []).length || ev.meetingLink ||
    (ev.recur && ev.recur.freq && ev.recur.freq !== "none") || ev.taskId || ev.projectId || ev.reminder ||
    (ev.endDate && ev.endDate !== ev.startDate) || (ev.color && ev.color !== "#8E959F") ||
    (ev.visibility && ev.visibility !== "team"));
}
function openEventModal(id, prefill){
  const ev = id ? Events.get(id) : null;
  editingEventId = id && ev ? id : null;
  evDraft = ev ? JSON.parse(JSON.stringify(ev)) : blankEvent(prefill || todayISO());
  evMoreOpen = eventHasDetail(evDraft, !!editingEventId);   // new events show title/date/time only
  document.getElementById("evTitle").textContent = ev ? "Edit event" : "New event";
  document.getElementById("evDelete").style.display = ev ? "block" : "none";
  document.getElementById("evDelete").dataset.armed = "";
  document.getElementById("evDelete").textContent = "Delete";
  renderEventModal();
  document.getElementById("eventVeil").classList.add("open");
  const nm = document.getElementById("evName"); if (nm) nm.focus();
}
function syncEventHeader(){
  if (!evDraft) return;
  const g = id => { const el = document.getElementById(id); return el ? el.value : undefined; };
  if (g("evName") !== undefined) evDraft.title = g("evName");
  if (g("evDesc") !== undefined) evDraft.description = g("evDesc");
  if (g("evLoc") !== undefined) evDraft.location = g("evLoc");
  if (g("evMeet") !== undefined) evDraft.meetingLink = g("evMeet").trim();
  if (g("evStart") !== undefined) evDraft.startDate = g("evStart") || evDraft.startDate;
  if (g("evEnd") !== undefined) evDraft.endDate = g("evEnd") || evDraft.startDate;
  if (g("evStartT") !== undefined) evDraft.startTime = g("evStartT");
  if (g("evEndT") !== undefined) evDraft.endTime = g("evEndT");
  if (g("evColor") !== undefined){ const h = normHex(g("evColor")); if (h) evDraft.color = h; }
  const rf = g("evRecur"); if (rf !== undefined){ evDraft.recur = (rf === "none") ? null : { freq: rf, until: (g("evUntil") || null) }; }
  const tk = g("evTask"); if (tk !== undefined) evDraft.taskId = tk || null;
  const pj = g("evProj"); if (pj !== undefined) evDraft.projectId = pj || null;
  const rm = g("evRemind"); if (rm !== undefined) evDraft.reminder = +rm || 0;
  const vs = g("evVis"); if (vs !== undefined) evDraft.visibility = vs;
}
function renderEventModal(){
  const ev = evDraft; if (!ev) return;
  const body = document.getElementById("evBody");
  const opt = (v, cur, l) => '<option value="' + v + '"' + (v === cur ? " selected" : "") + '>' + l + '</option>';
  let h = '';
  // Essentials only: title, date, and (for a timed event) the start time. Everything else is optional.
  h += '<label class="f-label" for="evName">Title</label><input class="f-input" id="evName" value="' + esc(ev.title) + '" placeholder="What\'s the event?">';
  h += '<div class="ev-allday"><button type="button" class="toggle ' + (ev.allDay ? "on" : "") + '" data-wact="evAllDay" aria-label="All day"></button><span class="set-title">All-day event</span></div>';
  h += '<div class="tm-grid"><div><label class="f-label" for="evStart">Date</label><input class="f-input" id="evStart" type="date" value="' + esc(ev.startDate || "") + '"></div>' +
    (ev.allDay ? '<div></div>' : '<div><label class="f-label" for="evStartT">Start time</label><input class="f-input" id="evStartT" type="time" value="' + esc(ev.startTime || "09:00") + '"></div>') + '</div>';
  h += '<details class="more-opts"' + (evMoreOpen ? ' open' : '') + '><summary>More options</summary><div class="more-opts-body">';
  h += '<div class="tm-grid"><div><label class="f-label" for="evEnd">End date</label><input class="f-input" id="evEnd" type="date" value="' + esc(ev.endDate || ev.startDate || "") + '"></div>' +
    (ev.allDay ? '<div></div>' : '<div><label class="f-label" for="evEndT">End time</label><input class="f-input" id="evEndT" type="time" value="' + esc(ev.endTime || "10:00") + '"></div>') + '</div>';
  h += '<label class="f-label" for="evLoc">Location</label><input class="f-input" id="evLoc" value="' + esc(ev.location || "") + '">';
  h += '<label class="f-label" for="evMeet">Meeting link (Zoom, Meet, Teams…)</label><input class="f-input" id="evMeet" placeholder="https://…" value="' + esc(ev.meetingLink || "") + '">';
  if (ev.meetingLink) h += '<div style="margin-top:8px"><a class="ev-join" href="' + esc(ev.meetingLink) + '" target="_blank" rel="noopener">▶ Join meeting</a></div>';
  h += '<label class="f-label" for="evDesc">Description</label><textarea class="f-area" id="evDesc">' + esc(ev.description || "") + '</textarea>';
  h += '<label class="f-label">Attendees</label><div class="tm-assignees">' +
    TEAM.map(u => { const on = (ev.attendees || []).includes(u.id); return '<button type="button" class="assign-chip' + (on ? " on" : "") + '" data-wact="evAttend" data-uid="' + u.id + '">' + avatarHtml(u.id) + esc(u.name.split(" ")[0]) + '</button>'; }).join("") + '</div>';
  h += '<div class="tm-grid"><div><label class="f-label" for="evColor">Color</label><div class="color-row"><input type="color" id="evColorPick" value="' + (normHex(ev.color) || "#8E959F") + '"><input class="f-input" id="evColor" value="' + esc(ev.color || "#8E959F") + '" style="flex:1"></div></div>' +
    '<div><label class="f-label" for="evVis">Visibility</label><select class="f-input" id="evVis">' + opt("team", ev.visibility, "Team") + opt("private", ev.visibility, "Private to me") + '</select></div></div>';
  h += '<div class="tm-grid"><div><label class="f-label" for="evRecur">Repeat</label><select class="f-input" id="evRecur">' +
    opt("none", ev.recur ? ev.recur.freq : "none", "Does not repeat") + opt("daily", ev.recur ? ev.recur.freq : "", "Daily") + opt("weekly", ev.recur ? ev.recur.freq : "", "Weekly") + opt("monthly", ev.recur ? ev.recur.freq : "", "Monthly") + '</select></div>' +
    '<div><label class="f-label" for="evUntil">Repeat until</label><input class="f-input" id="evUntil" type="date" value="' + esc(ev.recur && ev.recur.until ? ev.recur.until : "") + '"' + (ev.recur ? "" : " disabled") + '></div></div>';
  h += '<div class="tm-grid"><div><label class="f-label" for="evTask">Link to task</label><select class="f-input" id="evTask"><option value="">None</option>' + Tasks.list(canSeeTask).map(t => opt(t.id, ev.taskId || "", t.title || "Untitled")).join("") + '</select></div>' +
    '<div><label class="f-label" for="evProj">Link to project</label><select class="f-input" id="evProj"><option value="">None</option>' + Projects.list().map(p => opt(p.id, ev.projectId || "", p.name)).join("") + '</select></div></div>';
  h += '<label class="f-label" for="evRemind">Reminder (display only)</label><select class="f-input" id="evRemind">' +
    opt("0", String(ev.reminder || 0), "None") + opt("10", String(ev.reminder || 0), "10 minutes before") + opt("60", String(ev.reminder || 0), "1 hour before") + opt("1440", String(ev.reminder || 0), "1 day before") + '</select>';
  h += '<div class="ev-export"><button data-wact="evGoogle">↗ Add to Google Calendar</button><button data-wact="evIcs">⤓ Export this .ics</button></div>';
  h += '</div></details>';
  body.innerHTML = h;
  const det = body.querySelector(".more-opts");
  if (det) det.addEventListener("toggle", () => { evMoreOpen = det.open; });
  // Enter in the title submits the event (title + date + start time are enough).
  const nameEl = document.getElementById("evName");
  if (nameEl) nameEl.addEventListener("keydown", e => { if (e.key === "Enter"){ e.preventDefault(); saveEventModal(); } });
  const cp = document.getElementById("evColorPick"), ct = document.getElementById("evColor");
  if (cp && ct){
    cp.addEventListener("input", () => { ct.value = cp.value.toUpperCase(); evDraft.color = ct.value; });
    ct.addEventListener("input", () => { const hh = normHex(ct.value); if (hh){ cp.value = hh; evDraft.color = hh; } });
  }
  const rc = document.getElementById("evRecur");
  if (rc) rc.addEventListener("change", () => { syncEventHeader(); renderEventModal(); });
}
function saveEventModal(){
  syncEventHeader();
  if (!evDraft.title.trim()){ document.getElementById("evName").focus(); toast("Give the event a title."); return; }
  if (evDraft.endDate < evDraft.startDate) evDraft.endDate = evDraft.startDate;
  const prevAtt = editingEventId ? ((Events.get(editingEventId) || {}).attendees || []) : [];
  const wasNew = !editingEventId;
  const saved = editingEventId ? Events.update(editingEventId, evDraft) : Events.create(evDraft);
  (saved.attendees || []).forEach(uid2 => { if (uid2 !== currentUser.id && !prevAtt.includes(uid2)) notify(uid2, "event", currentUser.name + " invited you: " + saved.title + " (" + fmtDay(saved.startDate) + ")", { view:"calendar", eventId:saved.id }); });
  if (wasNew) fireIntegrations("event", currentUser.name + " scheduled “" + saved.title + "” on " + fmtDay(saved.startDate) + (saved.allDay ? "" : " at " + fmtT12(saved.startTime)) + (saved.meetingLink ? " · " + saved.meetingLink : ""));
  logActivity("event", currentUser.name + (editingEventId ? " updated " : " scheduled ") + "“" + saved.title + "”", "event", saved.id);
  document.getElementById("eventVeil").classList.remove("open");
  if (viewIs("calendar")) renderCalendar();
  toast("Event saved.");
}
function deleteEventNow(){
  const btn = document.getElementById("evDelete");
  if (!btn.dataset.armed){ btn.dataset.armed = "1"; btn.textContent = "Click again to delete"; setTimeout(() => { btn.dataset.armed = ""; btn.textContent = "Delete"; }, 3000); return; }
  if (editingEventId) Events.remove(editingEventId);
  document.getElementById("eventVeil").classList.remove("open");
  if (viewIs("calendar")) renderCalendar();
  toast("Event deleted.");
}

/* ----- Google Calendar + ICS ----- */
function gcalDates(ev){
  if (ev.allDay){
    const s = ev.startDate.replace(/-/g,"");
    const e = fmtISO(new Date(dparse(ev.endDate || ev.startDate).getTime() + 86400000)).replace(/-/g,"");
    return s + "/" + e;
  }
  const s = ev.startDate.replace(/-/g,"") + "T" + (ev.startTime || "09:00").replace(":","") + "00";
  const e = (ev.endDate || ev.startDate).replace(/-/g,"") + "T" + (ev.endTime || ev.startTime || "10:00").replace(":","") + "00";
  return s + "/" + e;
}
function googleUrl(ev){
  const p = new URLSearchParams({ action:"TEMPLATE", text: ev.title || "Event", dates: gcalDates(ev), details: ev.description || "", location: ev.location || "" });
  let u = "https://calendar.google.com/calendar/render?" + p.toString();
  if (ev.recur && ev.recur.freq){ let r = "RRULE:FREQ=" + ev.recur.freq.toUpperCase(); if (ev.recur.until) r += ";UNTIL=" + ev.recur.until.replace(/-/g,"") + (ev.allDay ? "" : "T235959Z"); u += "&recur=" + encodeURIComponent(r); }
  return u;
}
function icsEscape(s){ return String(s || "").replace(/\\/g,"\\\\").replace(/;/g,"\\;").replace(/,/g,"\\,").replace(/\r?\n/g,"\\n"); }
function icsEvent(ev){
  const L = ["BEGIN:VEVENT", "UID:" + ev.id + "@syn", "SUMMARY:" + icsEscape(ev.title)];
  if (ev.allDay){
    L.push("DTSTART;VALUE=DATE:" + ev.startDate.replace(/-/g,""));
    L.push("DTEND;VALUE=DATE:" + fmtISO(new Date(dparse(ev.endDate || ev.startDate).getTime() + 86400000)).replace(/-/g,""));
  } else {
    L.push("DTSTART:" + ev.startDate.replace(/-/g,"") + "T" + (ev.startTime || "09:00").replace(":","") + "00");
    L.push("DTEND:" + (ev.endDate || ev.startDate).replace(/-/g,"") + "T" + (ev.endTime || ev.startTime || "10:00").replace(":","") + "00");
  }
  if (ev.recur && ev.recur.freq){ let r = "RRULE:FREQ=" + ev.recur.freq.toUpperCase(); if (ev.recur.until) r += ";UNTIL=" + ev.recur.until.replace(/-/g,"") + (ev.allDay ? "" : "T235959Z"); L.push(r); }
  if (ev.location) L.push("LOCATION:" + icsEscape(ev.location));
  if (ev.description) L.push("DESCRIPTION:" + icsEscape(ev.description));
  L.push("END:VEVENT");
  return L.join("\r\n");
}
function icsDoc(events, name){
  return ["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//Syntrex//SYN Workspace//EN","CALSCALE:GREGORIAN","X-WR-CALNAME:" + icsEscape(name)]
    .concat(events.map(icsEvent)).concat(["END:VCALENDAR"]).join("\r\n");
}
function exportEventIcs(ev){ doDownload({ name: (ev.title || "event").replace(/[^\w\- ]/g,"").trim() + ".ics", content: icsDoc([ev], ev.title || "Event") }); toast(".ics downloaded."); }
function exportAllIcs(){ const evs = Events.list(canSeeEvent); if (!evs.length){ toast("No events to export yet."); return; } doDownload({ name: (ORG ? ORG.name : "SYN").replace(/[^\w\- ]/g,"").trim() + "_Calendar.ics", content: icsDoc(evs, (ORG ? ORG.name : "SYN") + " Calendar") }); toast("Workspace calendar exported (" + evs.length + " events)."); }

/* ----- AI event ingestion ([[EVENT:]]) ----- */
function ingestAIEvents(lines){
  if (!lines || !lines.length) return 0;
  let made = 0;
  lines.forEach(line => {
    const parts = line.split("|").map(s => s.trim());
    const title = parts[0]; if (!title) return;
    const dateStr = parts[1] || "";
    const timeStr = parts[2] || "";
    const attStr = parts[3] || "";
    const visibility = normVisibility(parts[4], "team");   // AI events default team unless the user says private/just me
    const startDate = /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? dateStr : todayISO();
    const hasTime = /^\d{1,2}:\d{2}$/.test(timeStr);
    const startTime = hasTime ? (timeStr.length === 4 ? "0" + timeStr : timeStr) : "09:00";
    const attendees = attStr.split(/[,;]/).map(s => s.trim()).filter(Boolean)
      .map(nm => TEAM.find(u => u.name.toLowerCase() === nm.toLowerCase() || u.name.toLowerCase().split(" ")[0] === nm.toLowerCase()))
      .filter(Boolean).map(u => u.id);
    const color = EV_COLORS[made % EV_COLORS.length];
    const ev = Events.create({ title, startDate, endDate:startDate, allDay: !hasTime, startTime, endTime:"10:00", attendees, color, visibility });
    attendees.forEach(id => { if (id !== currentUser.id) notify(id, "event", currentUser.name + " (via SYN) invited you: " + title + " (" + fmtDay(startDate) + ")", { view:"calendar", eventId:ev.id }); });
    fireIntegrations("event", currentUser.name + " (via SYN) scheduled “" + title + "” on " + fmtDay(startDate));
    made++;
  });
  if (made){ logActivity("event", currentUser.name + " used SYN to schedule " + made + " event" + (made > 1 ? "s" : ""), "event", null); if (viewIs("calendar")) renderCalendar(); }
  return made;
}

/* =====================================================================
   STAGE 5 · GLOBAL SEARCH (Cmd/Ctrl-K) + UNIVERSAL QUICK-ADD
   ===================================================================== */
let searchItems = [], searchSel = 0;
const S_ICON = {
  task:'<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 12l3 3 5-6"/></svg>',
  event:'<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 9h16M8 3v4M16 3v4"/></svg>',
  space:'<svg viewBox="0 0 24 24"><path d="M9 4L7 20M17 4l-2 16M4 9h16M3 15h16"/></svg>',
  dm:'<svg viewBox="0 0 24 24"><rect x="4" y="6" width="16" height="12" rx="1.6"/><path d="M4 8l8 6 8-6"/></svg>',
  person:'<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.2"/><path d="M5.5 20a6.5 6.5 0 0 1 13 0"/></svg>',
  chat:'<svg viewBox="0 0 24 24"><path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9l-4 3V6a1 1 0 0 1 1-1Z"/></svg>',
  asset:'<svg viewBox="0 0 24 24"><path d="M12 4l8 4-8 4-8-4 8-4Z"/><path d="M4 12l8 4 8-4M4 16l8 4 8-4"/></svg>'
};
async function openSearch(){
  for (const b of BRANDS) await loadChats(b.id);
  document.getElementById("searchVeil").classList.add("open");
  const inp = document.getElementById("searchInput");
  inp.value = ""; searchItems = []; searchSel = 0;
  document.getElementById("searchResults").innerHTML = '<div class="search-empty">Search across tasks, events, spaces, DMs, people, and chats.</div>';
  setTimeout(() => inp.focus(), 30);
}
function closeSearch(){ document.getElementById("searchVeil").classList.remove("open"); }
function searchSnip(text, q){ text = (text || "").replace(/\s+/g, " "); const i = text.toLowerCase().indexOf(q); if (i < 0) return ""; const s = Math.max(0, i - 26); return (s > 0 ? "…" : "") + text.slice(s, i + q.length + 46) + (i + q.length + 46 < text.length ? "…" : ""); }
function searchHL(str, q){ if (!str) return ""; const lo = str.toLowerCase(); let out = "", i = 0, idx; while ((idx = lo.indexOf(q, i)) >= 0){ out += esc(str.slice(i, idx)) + "<mark>" + esc(str.slice(idx, idx + q.length)) + "</mark>"; i = idx + q.length; } out += esc(str.slice(i)); return out; }
function searchAll(q){
  q = q.toLowerCase().trim(); const items = [];
  if (!q) return items;
  const inc = s => (s || "").toLowerCase().includes(q);
  Tasks.list(canSeeTask).forEach(t => { const hitDesc = inc(t.description); if (inc(t.title) || hitDesc || (t.labels || []).some(inc)) items.push({ type:"task", id:t.id, title:t.title || "Untitled", sub:(T_PRI[t.priority] || T_PRI.med).label + (t.dueDate ? " · due " + fmtDay(t.dueDate) : ""), snippet: hitDesc ? searchSnip(t.description, q) : "" }); });
  Events.list(canSeeEvent).forEach(ev => { if (inc(ev.title) || inc(ev.description) || inc(ev.location)) items.push({ type:"event", id:ev.id, title:ev.title || "Event", sub:fmtDay(ev.startDate) + (ev.allDay ? " · all day" : " · " + (ev.startTime || "")), snippet: inc(ev.description) ? searchSnip(ev.description, q) : "" }); });
  Spaces.list(s => isMember(s)).forEach(s => { if (inc(s.name) || inc(s.description)) items.push({ type:"space", id:s.id, title:s.name, sub:(s.type === "ai" ? "AI space" : "Space") + (s.archived ? " · archived" : ""), snippet: inc(s.description) ? searchSnip(s.description, q) : "" }); });
  DMs.list(d => Array.isArray(d.members) && d.members.includes(currentUser.id)).forEach(d => { if (inc(teamName(dmOther(d)))) items.push({ type:"dm", id:d.id, title:dmName(d), sub:"Direct message", snippet:"" }); });
  TEAM.forEach(u => { if (inc(u.name) || inc(u.email)) items.push({ type:"person", id:u.id, title:u.name, sub:u.role + " · " + u.email, snippet:"" }); });
  // Chats: search message CONTENT, surface the matching snippet
  BRANDS.forEach(b => { (CHATS[b.id] || []).filter(canSee).forEach(c => {
    let snip = ""; if (!inc(c.name)){ const hit = c.msgs.find(m => inc(m.text || m.displayText)); if (hit) snip = searchSnip(hit.text || hit.displayText, q); }
    if (inc(c.name) || snip) items.push({ type:"chat", id:c.id, brandId:b.id, title:c.name || "Chat", sub:b.name + " · chat", snippet: snip });
  }); });
  // Assets: files generated into chat messages
  BRANDS.forEach(b => (CHATS[b.id] || []).filter(canSee).forEach(c => (c.msgs || []).forEach(m => (m.files || []).forEach(f => {
    if (inc(f.name)) items.push({ type:"asset", id:c.id, brandId:b.id, title:f.name, sub:b.name + " · asset", snippet:"" });
  }))));
  return items;
}
function doSearch(){ const q = document.getElementById("searchInput").value; searchItems = searchAll(q); searchSel = 0; renderSearchList(q); }
function renderSearchList(q){
  const el = document.getElementById("searchResults");
  const ql = q.toLowerCase().trim();
  if (!ql){ el.innerHTML = '<div class="search-empty">Search across tasks, events, spaces, DMs, people, chats, and assets.</div>'; return; }
  if (!searchItems.length){ el.innerHTML = '<div class="search-empty">No matches for “' + esc(q) + '”.</div>'; return; }
  const groups = [["task","Tasks"],["event","Events"],["space","Spaces"],["dm","Direct messages"],["person","People"],["chat","Chats"],["asset","Assets"]];
  let html = "";
  groups.forEach(g => { const list = searchItems.filter(x => x.type === g[0]); if (!list.length) return;
    html += '<div class="search-group-lbl">' + g[1] + '</div>';
    list.forEach(it => { const i = searchItems.indexOf(it);
      html += '<button class="search-item' + (i === searchSel ? " sel" : "") + '" data-wact="searchJump" data-i="' + i + '"><span class="si-ico">' + (S_ICON[it.type] || S_ICON.chat) + '</span><div class="si-main"><div class="si-title">' + searchHL(it.title, ql) + '</div>' +
        (it.snippet ? '<div class="si-snip">' + searchHL(it.snippet, ql) + '</div>' : '<div class="si-sub">' + esc(it.sub) + '</div>') + '</div></button>';
    });
  });
  el.innerHTML = html;
  const sel = el.querySelector(".search-item.sel"); if (sel) sel.scrollIntoView({ block:"nearest" });
}
function searchMove(d){ if (!searchItems.length) return; searchSel = (searchSel + d + searchItems.length) % searchItems.length; renderSearchList(document.getElementById("searchInput").value); }
function searchJump(i){
  const it = searchItems[i]; if (!it) return; closeSearch();
  if (it.type === "task"){ setView("tasks"); if (Tasks.get(it.id)) openTaskModal(it.id); }
  else if (it.type === "event"){ setView("calendar"); if (Events.get(it.id)) openEventModal(it.id); }
  else if (it.type === "space"){ setView("spaces"); openThread("space", it.id); }
  else if (it.type === "dm"){ setView("spaces"); openThread("dm", it.id); }
  else if (it.type === "person"){ setView("people"); }
  else if (it.type === "asset"){ selectBrand(it.brandId).then(() => setView("assets")); }
  else if (it.type === "chat"){ selectBrand(it.brandId).then(() => { const b = brand(); if (b){ b._activeThread = it.id; renderChatList(); renderThread(); setView("chat"); } }); }
}

/* universal quick-add menu */
function toggleQuickAdd(){ document.getElementById("quickAddMenu").classList.toggle("open"); }
function closeQuickAdd(){ const m = document.getElementById("quickAddMenu"); if (m) m.classList.remove("open"); }

/* stage 5 click delegation */
document.addEventListener("click", e => {
  const w = e.target.closest("[data-wact]"); if (!w) return;
  const a = w.dataset.wact;
  if (a === "searchJump"){ searchJump(+w.dataset.i); return; }
  if (a === "editProject"){ openProjectModal(w.dataset.id); return; }
  if (a === "qaTask"){ closeQuickAdd(); const t = Tasks.create({ title:"", status:"todo" }); setView("tasks"); openTaskModal(t.id); return; }
  if (a === "qaActivity"){ closeQuickAdd(); setView("activity"); openActVeil(null); return; }
  if (a === "qaEvent"){ closeQuickAdd(); setView("calendar"); openEventModal(null, todayISO()); return; }
  if (a === "qaSpace"){ closeQuickAdd(); if (!isAdmin()){ toast("Only admins can create spaces."); return; } setView("spaces"); openSpaceModal(null); return; }
  if (a === "qaChat"){ closeQuickAdd(); if (!brand()){ toast("Encode a brand first to start a chat."); setView("chat"); return; } newChat(); return; }
  if (a === "qaInvite"){ closeQuickAdd(); if (!isAdmin()){ toast("Ask your workspace admin for the team code to invite people."); return; } setView("settings"); toast("Share your live team code (in Settings) with teammates."); return; }
  if (a === "toggleCollapse"){ toggleCollapsed(); return; }
  if (a === "exitFocus"){ toggleFocus(); return; }
  if (a === "toggleTheme"){ toggleTheme(); return; }
  if (a === "toggleFocusMode"){ toggleFocus(); return; }
});

/* ---------- Part 2: profile + integrations delegation ---------- */
document.addEventListener("click", e => {
  const w = e.target.closest("[data-wact]"); if (!w) return;
  const a = w.dataset.wact;
  // My Profile
  if (a === "profUpload"){ const f = document.getElementById("profFile"); if (f) f.click(); return; }
  if (a === "profRemoveAvatar"){ saveMyProfile({ avatar:null }); refreshMyAvatar(); if (viewIs("settings")) renderSettings(); toast("Photo removed."); return; }
  if (a === "profSaveName"){ const v = (document.getElementById("profName").value || "").trim(); if (!v) return; const me = TEAM.find(t => t.id === currentUser.id); if (me) me.name = v; currentUser.name = v; saveTeam(); const un = document.getElementById("uName"); if (un) un.textContent = v; refreshMyAvatar(); if (viewIs("settings")) renderSettings(); toast("Display name updated."); return; }
  if (a === "profSaveAccent"){ const hx = normHex(document.getElementById("profAccent").value) || document.getElementById("profAccentPick").value; saveMyProfile({ accent: hx }); applyPersonalAccent(); if (viewIs("settings")) renderSettings(); toast("Personal accent applied to your My Day and Portfolio."); return; }
  if (a === "profClearAccent"){ saveMyProfile({ accent:null }); applyPersonalAccent(); if (viewIs("settings")) renderSettings(); toast("Reverted to the brand accent."); return; }
  // Integrations
  if (a === "intConnect"){ openIntegrationModal(w.dataset.k); return; }
  if (a === "intDisconnect"){ intDisconnect(w.dataset.k); return; }
  if (a === "intSave"){ const k = w.dataset.k; const inp = document.querySelector('[data-int-url="' + k + '"]'); const url = inp ? inp.value.trim() : ""; INTS[k] = INTS[k] || { on:{} }; INTS[k].url = url; saveIntegrations(); renderSettings(); const nm = (INT_HOOKS.find(x => x[0] === k) || [,k])[1]; toast(url ? (nm + " webhook saved.") : (nm + " webhook cleared.")); return; }
  if (a === "intClear"){ const k = w.dataset.k; if (INTS[k]) INTS[k].url = ""; saveIntegrations(); renderSettings(); toast("Webhook removed."); return; }
  if (a === "intToggle"){ const k = w.dataset.k, ev = w.dataset.e; INTS[k] = INTS[k] || { url:"", on:{} }; INTS[k].on = INTS[k].on || {}; INTS[k].on[ev] = INTS[k].on[ev] === false ? true : false; saveIntegrations(); renderSettings(); return; }
  if (a === "intTest"){ const k = w.dataset.k, cfg = INTS[k]; const nm = (INT_HOOKS.find(x => x[0] === k) || [,k])[1]; if (cfg && cfg.url){ postWebhook(cfg.url, { text: "[SYN · " + (ORG ? ORG.name : "") + "] Test notification from " + currentUser.name + ". Your " + nm + " webhook is connected.", event:"test", workspace: ORG ? ORG.name : "", source:"SYN Workspace" }); toast("Test sent to " + nm + "."); } return; }
  if (a === "intStaged"){ toast((w.dataset.n || "This integration") + " connects when SYN Core is live. No OAuth is configured yet."); return; }
});

/* =====================================================================
   STAGE 4 · MY DAY (per-user home) + PEOPLE directory
   ===================================================================== */
function greetWord(){ const h = new Date().getHours(); return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"; }
function myUpcomingEvents(days){
  const start = todayISO(), end = fmtISO(new Date(Date.now() + (days || 7) * 86400000));
  const map = calItemsByDay(start, end), out = [];
  Object.keys(map).sort().forEach(iso => map[iso].forEach(it => {
    if (it.kind === "event" && it.isStart){ const ev = it.ev; if ((ev.attendees || []).includes(currentUser.id) || ev.createdBy === currentUser.id || !(ev.attendees || []).length) out.push({ iso, ev }); }
  }));
  return out;
}
function myUnreadThreads(){
  const out = [];
  Spaces.list(s => isMember(s) && !s.archived).forEach(s => { const un = unreadFor("space", s.id), men = hasUnreadMention(s.id); if (un > 0 || men) out.push({ kind:"space", rec:s, un, men }); });
  DMs.list(d => Array.isArray(d.members) && d.members.includes(currentUser.id)).forEach(d => { const un = unreadFor("dm", d.id); if (un > 0) out.push({ kind:"dm", rec:d, un, men:false }); });
  return out;
}
function renderMyDay(){
  const p = document.getElementById("mydayPanel"); if (!p) return;
  const first = currentUser.name.split(" ")[0];
  const dateStr = new Date().toLocaleDateString([], { weekday:"long", month:"long", day:"numeric" });
  const soon = fmtISO(new Date(Date.now() + 2 * 86400000));
  const myDue = Tasks.list(t => canSeeTask(t) && t.status !== "done" && (t.assignees || []).includes(currentUser.id) && t.dueDate && t.dueDate <= soon).sort((a,b) => a.dueDate < b.dueDate ? -1 : 1);
  const noDue = Tasks.list(t => canSeeTask(t) && t.status !== "done" && (t.assignees || []).includes(currentUser.id) && !t.dueDate);
  const events = myUpcomingEvents(7);
  const threads = myUnreadThreads();
  const acts = recentActivity(10);
  const pend = pendingCount();

  let h = '<div class="md-greet spec-block"><div><h2>' + greetWord() + ', ' + esc(first) + '</h2><div class="sub">' + esc(dateStr) + '</div></div>' +
    (aiReady() ? '<button class="head-btn md-plan" data-wact="planMyDay" id="mdPlanBtn">✦ Plan my day</button>' : '') + '</div>';
  h += '<div class="md-ask"><input id="mdAsk" placeholder="Ask SYN anything…"><button class="btn-gold" data-wact="mdAsk">Ask</button></div>';
  h += '<div class="md-plan-out" id="mdPlanOut" style="display:none"></div>';
  h += usageBannerHtml();

  // Friendly empty state: nothing due, no events, no unreads, no pending approvals
  if (!myDue.length && !events.length && !threads.length && !(isAdmin() && pend)){
    h += '<div class="spec-block md-empty-hero">' + synMark(70, 'empty-mark') +
      '<h3>Your day is clear</h3>' +
      '<p>Nothing due and nothing unread' + (noDue.length ? ' (you have ' + noDue.length + ' task' + (noDue.length > 1 ? 's' : '') + ' with no due date)' : '') + '. Ask SYN to get moving, add a task, or plan your week.</p>' +
      '<div class="starter-row"><button class="btn-gold" data-wact="newTask">+ New Task</button><button class="head-btn ghost" data-wact="newEvent">+ New Event</button><button class="head-btn ghost" data-wact="goView" data-v="guide">Open the guide</button></div></div>';
    if (acts.length){
      h += '<div class="spec-block md-card" style="margin-top:14px"><div class="sb-head">Recent activity</div><div class="sb-body">';
      acts.forEach(a => h += '<div class="md-act-line">' + esc(a.text) + '<span class="t">' + esc(fmtTime(a.createdAt)) + '</span></div>');
      h += '</div></div>';
    }
    p.innerHTML = h;
    const ask0 = document.getElementById("mdAsk");
    if (ask0) ask0.addEventListener("keydown", e => { if (e.key === "Enter"){ e.preventDefault(); myDayAsk(); } });
    return;
  }

  h += '<div class="md-grid">';

  // Tasks due
  h += '<div class="spec-block md-card"><div class="sb-head">Your tasks · due today & soon <span style="color:var(--faint)">' + myDue.length + '</span></div><div class="sb-body">';
  if (!myDue.length) h += '<div class="md-empty-row">Nothing due in the next 2 days. ' + (noDue.length ? noDue.length + ' open task' + (noDue.length > 1 ? 's' : '') + ' with no due date.' : 'You are all clear.') + '</div>';
  else myDue.forEach(t => { const ds = taskDueState(t); const pri = T_PRI[t.priority] || T_PRI.med;
    h += '<div class="md-row" data-wact="openTask" data-tid="' + t.id + '"><span class="r-dot" style="--rd:' + pri.color + '"></span><div class="r-main"><div class="r-title">' + esc(t.title || "Untitled") + '</div><div class="r-sub">' + pri.label + (t.projectId && projectById(t.projectId) ? ' · ' + esc(projectById(t.projectId).name) : '') + '</div></div><span class="r-when ' + ds + '">' + (ds === "red" ? "Overdue" : fmtDay(t.dueDate)) + '</span></div>';
  });
  h += '</div></div>';

  // Events
  h += '<div class="spec-block md-card"><div class="sb-head">Upcoming events <span style="color:var(--faint)">' + events.length + '</span></div><div class="sb-body">';
  if (!events.length) h += '<div class="md-empty-row">No events in the next 7 days.</div>';
  else events.slice(0, 8).forEach(x => { const ev = x.ev;
    h += '<div class="md-row" data-wact="mdEvent" data-eid="' + ev.id + '"><span class="r-dot" style="--rd:' + esc(ev.color) + '"></span><div class="r-main"><div class="r-title">' + esc(ev.title || "Event") + '</div><div class="r-sub">' + (x.iso === todayISO() ? "Today" : dparse(x.iso).toLocaleDateString([], { weekday:"short", month:"short", day:"numeric" })) + (ev.allDay ? " · All day" : " · " + esc(fmtT12(ev.startTime))) + '</div></div>' + (ev.meetingLink ? '<a class="ev-join" href="' + esc(ev.meetingLink) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">Join</a>' : "") + '</div>';
  });
  h += '</div></div>';

  // Unread messages
  h += '<div class="spec-block md-card"><div class="sb-head">Unread messages <span style="color:var(--faint)">' + threads.length + '</span></div><div class="sb-body">';
  if (!threads.length) h += '<div class="md-empty-row">You are caught up across spaces and DMs.</div>';
  else threads.forEach(x => { const name = x.kind === "dm" ? dmName(x.rec) : x.rec.name;
    h += '<div class="md-row" data-wact="mdThread" data-kind="' + x.kind + '" data-id="' + x.rec.id + '"><span class="r-ico">' + (x.kind === "dm" ? esc(initials(name)) : esc(x.rec.icon || "◆")) + '</span><div class="r-main"><div class="r-title">' + esc(name) + '</div><div class="r-sub">' + (x.kind === "dm" ? "Direct message" : "Space") + (x.men ? ' · mentioned you' : '') + '</div></div>' + (x.un ? '<span class="space-unread">' + x.un + '</span>' : (x.men ? '<span class="space-mention">@</span>' : '')) + '</div>';
  });
  h += '</div></div>';

  // Follow-ups due (today or overdue)
  const dueFu = collectFollowUps().filter(f => { const e = escalate(f.date); return e.days !== null && e.days >= 0; });
  h += '<div class="spec-block md-card"><div class="sb-head">Follow-ups due <span style="color:var(--faint)">' + dueFu.length + '</span></div><div class="sb-body">';
  if (!dueFu.length) h += '<div class="md-empty-row">No follow-ups due. Nice.</div>';
  else dueFu.slice(0,6).forEach(f => { const e = escalate(f.date);
    h += '<div class="md-row" data-wact="goView" data-v="followups"><div class="r-main"><div class="r-title">' + esc(f.title) + '</div><div class="r-sub">' + esc(f.meta) + '</div></div>' + escChip(e) + '</div>'; });
  h += '</div></div>';

  // People waiting on you (dependencies)
  const oweMe = myDeps(d => d.oweeId === currentUser.id && d.status === "open");
  h += '<div class="spec-block md-card"><div class="sb-head">Waiting on you <span style="color:var(--faint)">' + oweMe.length + '</span></div><div class="sb-body">';
  if (!oweMe.length) h += '<div class="md-empty-row">No one is blocked on you.</div>';
  else oweMe.slice(0,6).forEach(d => { const days = Math.max(0, Math.round((Date.now()-Date.parse(d.createdAt||nowISO()))/86400000));
    h += '<div class="md-row" data-wact="goView" data-v="deps"><div class="r-main"><div class="r-title">' + esc(d.note||"") + '</div><div class="r-sub">For ' + esc(d.requesterName||teamName(d.requesterId)) + ' · ' + days + 'd</div></div><span class="esc-chip ' + escalate(d.dueDate||todayISO()).cls + '"><span class="esc-dot"></span>' + days + 'd</span></div>'; });
  h += '</div></div>';

  // Activity
  h += '<div class="spec-block md-card"><div class="sb-head">Recent activity</div><div class="sb-body">';
  if (!acts.length) h += '<div class="md-empty-row">Nothing yet. Activity from your team shows here.</div>';
  else acts.forEach(a => h += '<div class="md-act-line">' + esc(a.text) + '<span class="t">' + esc(fmtTime(a.createdAt)) + '</span></div>');
  h += '</div></div>';

  h += '</div>';
  p.innerHTML = h;
  const ask = document.getElementById("mdAsk");
  if (ask) ask.addEventListener("keydown", e => { if (e.key === "Enter"){ e.preventDefault(); myDayAsk(); } });
}
function myDayAsk(){
  const inp = document.getElementById("mdAsk"); if (!inp) return;
  const v = (inp.value || "").trim(); if (!v) return;
  if (!brand()){ toast("Encode a brand first to chat with SYN."); setView("chat"); return; }
  inp.value = "";
  setView("chat");
  const ci = document.getElementById("input"); if (ci){ ci.value = v; send(); }
}
async function planMyDay(){
  const btn = document.getElementById("mdPlanBtn"), out = document.getElementById("mdPlanOut");
  if (!out) return;
  const dGate = gateAI("fast", "plan_day");   // a daily summary of your own tasks/events — Haiku is plenty
  if (!dGate.ok){ out.innerHTML = '<div class="spec-block"><div class="sb-body"><div class="md-empty-row">' + esc(dGate.reason) + '</div></div></div>'; return; }
  out.style.display = "block";
  out.innerHTML = '<div class="spec-block"><div class="sb-body"><div class="status-line"><span class="s-dot"></span><span class="s-txt">SYN is drafting your day…</span></div></div></div>';
  if (btn){ btn.disabled = true; btn.textContent = "Planning…"; }
  const myTasks = Tasks.list(t => canSeeTask(t) && t.status !== "done" && (t.assignees || []).includes(currentUser.id));
  const events = myUpcomingEvents(2);
  const tLines = myTasks.map(t => "- " + t.title + (t.dueDate ? " (due " + t.dueDate + ")" : "") + " [" + (T_PRI[t.priority] || T_PRI.med).label + "]").join("\n") || "None";
  const eLines = events.map(x => "- " + x.ev.title + " on " + x.iso + (x.ev.allDay ? " (all day)" : " at " + (x.ev.startTime || ""))).join("\n") || "None";
  const summary = "My open tasks:\n" + tLines + "\n\nMy events (next 2 days):\n" + eLines + "\n\nDraft a focused, prioritized plan for today.";
  try{
    const res = await fetch(apiBase() + "/v1/messages", {
      method:"POST", headers:{ "Content-Type":"application/json", ...gateHeaders() },
      body: JSON.stringify({ model: MODELS.fast, max_tokens: AI_MAX_TOKENS.plan_day,
        system: "You are SYN, a sharp chief-of-staff. Given a teammate's open tasks and events, write a concise, prioritized plan for their day: a short opening line, then an ordered list of what to focus on and when, grouping around their meetings. Flag anything overdue first. Clean markdown, no preamble, no em dashes. Today is " + todayISO() + ".",
        messages:[{ role:"user", content: summary }] })
    });
    const data = await res.json();
    const txt = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("").trim();
    out.innerHTML = '<div class="spec-block"><div class="sb-head">Your plan for today <button class="add-btn" data-wact="mdPlanClose">Dismiss</button></div><div class="sb-body md">' + (txt ? renderMD(txt) : "SYN did not return a plan. Try again.") + '</div></div>';
  }catch(e){
    out.innerHTML = '<div class="spec-block"><div class="sb-body"><div class="md-empty-row">SYN is offline right now. Plan-my-day needs SYN Core connected. Your tasks and events above still work.</div></div></div>';
  }
  if (btn){ btn.disabled = false; btn.textContent = "✦ Plan my day"; }
}

/* people directory */
function openTaskCount(uid2){ return Tasks.list(t => t.status !== "done" && (t.assignees || []).includes(uid2)).length; }
function renderPeople(){
  const p = document.getElementById("peoplePanel"); if (!p) return;
  let h = '<div class="panel-head"><div><h2>People</h2><p class="sub">Everyone in ' + esc(ORG ? ORG.name : "") + '. Message a teammate or see what they are working on.</p></div></div>';
  h += '<div class="people-grid">';
  TEAM.forEach(u => { const oc = openTaskCount(u.id);
    h += '<div class="person-card">' + avatarBig(u.id) + '<div class="p-info">' +
      '<div class="p-name">' + esc(u.name) + (u.id === currentUser.id ? ' <span style="color:var(--faint);font-size:11px;font-weight:600">You</span>' : '') + '</div>' +
      '<div class="p-meta">' + esc(u.email) + '</div><div class="p-role">' + esc(u.role) + ' · ' + oc + ' open task' + (oc === 1 ? '' : 's') + '</div>' +
      '<div class="p-acts">' + (u.id !== currentUser.id ? '<button class="mode-btn" data-wact="pDM" data-uid="' + u.id + '">Message</button>' : '') +
      '<button class="mode-btn" data-wact="pTasks" data-uid="' + u.id + '">View tasks</button></div></div></div>';
  });
  h += '</div>';
  p.innerHTML = h;
}

/* my day + people click delegation */
document.addEventListener("click", e => {
  const w = e.target.closest("[data-wact]"); if (!w) return;
  const a = w.dataset.wact;
  if (a === "mdAsk"){ myDayAsk(); return; }
  if (a === "planMyDay"){ planMyDay(); return; }
  if (a === "mdPlanClose"){ const o = document.getElementById("mdPlanOut"); if (o){ o.style.display = "none"; o.innerHTML = ""; } return; }
  if (a === "mdEvent"){ setView("calendar"); if (Events.get(w.dataset.eid)) openEventModal(w.dataset.eid); return; }
  if (a === "mdThread"){ setView("spaces"); openThread(w.dataset.kind, w.dataset.id); return; }
  if (a === "goView"){ setView(w.dataset.v); return; }
  if (a === "guideGo"){ guideGo(w.dataset.sec); return; }
  if (a === "pDM"){ setView("spaces"); startDM(w.dataset.uid); return; }
  if (a === "pTasks"){ taskFilter = { project:"", assignee:w.dataset.uid, priority:"", label:"", sort:"manual" }; taskView = "list"; setView("tasks"); return; }
});

