/* ============================================================
   js/06-tasks.js — TASKS: sidebar nav (grouped by person), the tasks view (toolbar + board/list), drag & drop, quick-add, assignment, the task modal, the project modal, AI task ingestion ([[TASK:]]), and Ask-SYN-to-plan.
   MOVE, not a refactor: a byte-identical slice of the original inline <script>.
   Order-dependent. Loads after 05-settings-data.js and before 07-calendar-views.js. Shared global
   scope, not a module. Do not reorder these tags.
   ============================================================ */
/* =====================================================================
   STAGE 1 · TASKS & PROJECTS
   ===================================================================== */
const T_STATUS = [
  { key:"todo",       label:"To Do",       dot:"#8B93A7" },
  { key:"inprogress", label:"In Progress", dot:"#C9CDD6" },
  { key:"review",     label:"Review",      dot:"#8E959F" },
  { key:"done",       label:"Done",        dot:"#7FD99A" }
];
const T_PRI = {
  low:    { label:"Low",    cls:"pri-low",    color:"#7FD99A" },
  med:    { label:"Med",    cls:"pri-med",    color:"#8E959F" },
  high:   { label:"High",   cls:"pri-high",   color:"#EE9A5B" },
  urgent: { label:"Urgent", cls:"pri-urgent", color:"#FF7A6B" }
};
let taskView = "board";                         // board | list | mine
let myScope = "all";                            // all | today | week (My Tasks only)
let taskFilter = { project:"", assignee:"", priority:"", label:"", sort:"manual" };
let dragTaskId = null;
let editingTaskId = null;
let editingProjectId = null;
let armedDone = null;

// Tasks are private to their assignees by default. Admins see everything; "team" tasks are
// workspace-visible; otherwise you see a task only if you're an assignee or its creator.
function canSeeTask(t){
  if (isAdmin()) return true;
  if (t.visibility === "team") return true;
  const me = currentUser && currentUser.id;
  return !!(me && ((t.assignees || []).includes(me) || t.createdBy === me));
}
const ARCHIVE_MS = 48 * 3600 * 1000;
// A completed task auto-archives 48h after completion: hidden from the board, still under Completed, recoverable.
function isArchived(t){
  if (t.status !== "done" || !t.completedAt) return false;
  return (Date.now() - Date.parse(t.completedAt)) > ARCHIVE_MS;
}
function allLabels(){ const s = new Set(); Tasks.list(canSeeTask).forEach(t => (t.labels || []).forEach(l => s.add(l))); return Array.from(s).sort(); }
function projectById(id){ return Projects.get(id); }
function taskDueState(t){
  if (!t.dueDate || t.status === "done") return "";
  const today = new Date(); today.setHours(0,0,0,0);
  const diff = new Date(t.dueDate + "T00:00:00") - today;
  if (diff < 0) return "red";
  if (diff <= 2 * 86400000) return "amber";
  return "";
}
function fmtDay(d){ if (!d) return ""; const dt = new Date(d + "T00:00:00"); return dt.toLocaleDateString([], { month:"short", day:"numeric" }); }

function matchAssignee(t, uid){
  if (!uid) return true;
  if (uid === "__unassigned__") return !(t.assignees || []).length;
  return (t.assignees || []).includes(uid);
}
function baseTasks(){
  let list = Tasks.list(canSeeTask);
  if (taskView === "completed"){
    // Completed view: every done task (recent + auto-archived), most-recent first, recoverable.
    list = list.filter(t => t.status === "done");
    list = list.filter(t => matchAssignee(t, taskFilter.assignee));
    if (taskFilter.project)  list = list.filter(t => t.projectId === taskFilter.project);
    if (taskFilter.priority) list = list.filter(t => t.priority === taskFilter.priority);
    if (taskFilter.label)    list = list.filter(t => (t.labels || []).includes(taskFilter.label));
    return list.sort((a,b) => Date.parse(b.completedAt || b.updatedAt || 0) - Date.parse(a.completedAt || a.updatedAt || 0));
  }
  list = list.filter(t => !isArchived(t));               // archived-completed drop off the board/list
  if (taskView === "mine"){
    list = list.filter(t => (t.assignees || []).includes(currentUser.id));
    if (myScope !== "all"){
      const today = new Date(); today.setHours(0,0,0,0);
      const cutoff = today.getTime() + (myScope === "week" ? 7 * 86400000 : 0);
      list = list.filter(t => t.status !== "done" && t.dueDate && new Date(t.dueDate + "T00:00:00").getTime() <= cutoff);
    }
  }
  if (taskFilter.project)  list = list.filter(t => t.projectId === taskFilter.project);
  list = list.filter(t => matchAssignee(t, taskFilter.assignee));
  if (taskFilter.priority) list = list.filter(t => t.priority === taskFilter.priority);
  if (taskFilter.label)    list = list.filter(t => (t.labels || []).includes(taskFilter.label));
  return list;
}
/* tasks due within a scope (today = due today or overdue; week = next 7 days) */
function baseTasksScoped(scope){
  const today = new Date(); today.setHours(0,0,0,0);
  const cutoff = today.getTime() + (scope === "week" ? 7 * 86400000 : 0);
  return Tasks.list(t => canSeeTask(t) && t.status !== "done" && t.dueDate && new Date(t.dueDate + "T00:00:00").getTime() <= cutoff);
}
function sortTasks(list){
  const arr = list.slice();
  const s = taskFilter.sort;
  if (s === "due") arr.sort((a,b) => (a.dueDate ? Date.parse(a.dueDate) : Infinity) - (b.dueDate ? Date.parse(b.dueDate) : Infinity));
  else if (s === "priority"){ const o = { urgent:0, high:1, med:2, low:3 }; arr.sort((a,b) => (o[a.priority] - o[b.priority]) || (a.order - b.order)); }
  else if (s === "assignee") arr.sort((a,b) => (teamName((a.assignees || [])[0]) || "~").localeCompare(teamName((b.assignees || [])[0]) || "~"));
  else arr.sort((a,b) => (a.order || 0) - (b.order || 0));
  return arr;
}

/* ----- tasks sidebar nav: grouped BY PERSON (projects moved to the toolbar filter) ----- */
function renderProjectsNav(){
  const el = document.getElementById("projNav");
  if (!el) return;
  const active = (uid) => (taskFilter.assignee === uid && taskView !== "completed") ? " active" : "";
  const liveCount = (pred) => Tasks.list(t => canSeeTask(t) && !isArchived(t) && pred(t)).length;
  let html = '<button class="proj-nav-item' + active("") + '" data-wact="personFilter" data-uid=""><span class="proj-dot" style="--pn:var(--gold)"></span>All tasks<span class="pn-count">' + liveCount(() => true) + '</span></button>';
  (TEAM || []).forEach(u => {
    // Only offer people the current user can actually see tasks for (admins see all).
    const n = liveCount(t => (t.assignees || []).includes(u.id));
    if (!isAdmin() && u.id !== currentUser.id && !n) return;
    html += '<button class="proj-nav-item' + active(u.id) + '" data-wact="personFilter" data-uid="' + u.id + '">' +
      avatarHtml(u.id, "pn-av") + '<span class="pn-name">' + esc(u.name.split(" ")[0]) + (u.id === currentUser.id ? " (you)" : "") + '</span><span class="pn-count">' + n + '</span></button>';
  });
  const unN = liveCount(t => !(t.assignees || []).length);
  html += '<button class="proj-nav-item' + active("__unassigned__") + '" data-wact="personFilter" data-uid="__unassigned__"><span class="proj-dot" style="--pn:var(--faint)"></span>Unassigned<span class="pn-count">' + unN + '</span></button>';
  html += '<button class="proj-nav-item' + (taskView === "completed" ? " active" : "") + '" data-wact="taskView" data-v="completed"><span class="proj-dot" style="--pn:var(--good)"></span>Completed<span class="pn-count">' + Tasks.list(t => canSeeTask(t) && t.status === "done").length + '</span></button>';
  el.innerHTML = html;
}

/* ----- tasks view (toolbar + board/list) ----- */
function renderTasks(){
  const wrap = document.getElementById("tasksWrap");
  if (!wrap) return;
  const projs = Projects.list();
  const labels = allLabels();
  const sel = (val, cur) => (val === cur ? " selected" : "");
  const projName = taskFilter.project ? (projectById(taskFilter.project) || {}).name : "";
  let bar =
    '<div class="tasks-bar"><div class="tb-top">' +
    '<div><h2>' + (taskView === "completed" ? "Completed" : taskView === "mine" ? "My Tasks" : (projName ? esc(projName) : "Tasks")) + '</h2>' +
    '<div class="sub">' + (taskView === "completed" ? "Done tasks auto-archive off the board after 48h. Reopen any of them here." : "Tasks are private to their assignees; mark a task “team” to share it. Admins see everything.") + '</div></div>' +
    '<div class="tb-actions">' +
    '<button class="mode-btn' + (taskView === "board" ? " active" : "") + '" data-wact="taskView" data-v="board">Board</button>' +
    '<button class="mode-btn' + (taskView === "list" ? " active" : "") + '" data-wact="taskView" data-v="list">List</button>' +
    '<button class="mode-btn' + (taskView === "mine" ? " active" : "") + '" data-wact="taskView" data-v="mine">My Tasks</button>' +
    '<button class="head-btn ghost" data-wact="newProject" style="padding:8px 13px">+ Project</button>' +
    '<button class="head-btn ghost" data-wact="planProject" style="padding:8px 15px">✦ Ask SYN to plan</button>' +
    '<button class="head-btn" data-wact="newTask" style="padding:8px 17px">+ New Task</button>' +
    '</div></div>' +
    '<div class="tb-filters"><span class="fl-lbl">Filter</span>' +
    '<select data-wact="filter" data-k="project"><option value="">All projects</option>' + projs.map(p => '<option value="' + p.id + '"' + sel(p.id, taskFilter.project) + '>' + esc(p.name) + '</option>').join("") + '</select>' +
    '<select data-wact="filter" data-k="assignee"><option value="">Anyone</option>' + TEAM.map(u => '<option value="' + u.id + '"' + sel(u.id, taskFilter.assignee) + '>' + esc(u.name) + '</option>').join("") + '</select>' +
    '<select data-wact="filter" data-k="priority"><option value="">Any priority</option>' + Object.keys(T_PRI).map(k => '<option value="' + k + '"' + sel(k, taskFilter.priority) + '>' + T_PRI[k].label + '</option>').join("") + '</select>' +
    '<select data-wact="filter" data-k="label"><option value="">Any label</option>' + labels.map(l => '<option value="' + esc(l) + '"' + sel(l, taskFilter.label) + '>' + esc(l) + '</option>').join("") + '</select>' +
    '<span class="fl-lbl">Sort</span>' +
    '<select data-wact="filter" data-k="sort"><option value="manual"' + sel("manual", taskFilter.sort) + '>Manual</option><option value="due"' + sel("due", taskFilter.sort) + '>Due date</option><option value="priority"' + sel("priority", taskFilter.sort) + '>Priority</option><option value="assignee"' + sel("assignee", taskFilter.sort) + '>Assignee</option></select>' +
    (taskFilter.project || taskFilter.assignee || taskFilter.priority || taskFilter.label ? '<button class="mode-btn" data-wact="clearFilters">Clear</button>' : "") +
    '</div>' +
    (taskView === "mine" ? '<div class="tb-filters"><span class="fl-lbl">Due</span>' +
      [["all","All"],["today","Today"],["week","This week"]].map(s => {
        const n = s[0] === "all" ? 0 : baseTasksScoped(s[0]).filter(t => (t.assignees || []).includes(currentUser.id)).length;
        return '<button class="mode-btn' + (myScope === s[0] ? " active" : "") + '" data-wact="myScope" data-s="' + s[0] + '">' + s[1] + (s[0] !== "all" && n ? " · " + n : "") + '</button>';
      }).join("") + '</div>' : "") +
    '</div>';

  if (taskView === "completed"){
    const done = baseTasks();
    wrap.innerHTML = bar + (done.length ? '<div class="tlist">' + done.map(t => {
      const archived = isArchived(t);
      return '<div class="trow" data-wact="openTask" data-tid="' + t.id + '"><span class="tr-check done">✓</span>' +
        '<div class="tr-main"><div class="tr-title done">' + esc(t.title || "Untitled") + '</div>' +
        '<div class="tr-sub">Completed ' + (t.completedAt ? fmtTime(t.completedAt) : "") + (archived ? " · archived" : "") + '</div></div>' +
        '<div class="tc-avs">' + (t.assignees || []).slice(0,4).map(id => avatarHtml(id)).join("") + '</div>' +
        '<button class="mode-btn" data-wact="reopenTask" data-tid="' + t.id + '">Reopen</button></div>';
    }).join("") + '</div>' : '<div class="empty-log tasks-empty">No completed tasks yet.</div>');
    return;
  }
  const total = Tasks.list(t => canSeeTask(t) && !isArchived(t)).length;
  if (!total && taskView !== "board"){
    wrap.innerHTML = bar + '<div class="empty-log tasks-empty">No tasks yet. Switch to the Board to quick-add into a column, use <b>+ New Task</b>, or ask SYN to plan a project and it will fill the board for you.</div>';
    return;
  }
  wrap.innerHTML = bar + (taskView === "list" || taskView === "mine" ? renderTaskList() : renderBoard());
  if (taskView === "board") wireBoardDnd();
}

function taskCardHtml(t){
  const pri = T_PRI[t.priority] || T_PRI.med;
  const proj = t.projectId ? projectById(t.projectId) : null;
  const dueState = taskDueState(t);
  const subDone = (t.subtasks || []).filter(s => s.done).length, subTot = (t.subtasks || []).length;
  let h = '<div class="tcard' + (dueState === "red" ? " overdue" : "") + '" draggable="true" data-wact="openTask" data-tid="' + t.id + '" style="--pc:' + pri.color + '">';
  h += '<div class="tc-title">' + esc(t.title || "Untitled") + '</div><div class="tc-meta">';
  if (proj) h += '<span class="tc-proj" style="color:' + esc(proj.color) + ';border-color:' + hexToSoft(proj.color) + '">' + esc(proj.name) + '</span>';
  h += '<span class="tc-pri ' + pri.cls + '">' + pri.label + '</span>';
  if (t.dueDate) h += '<span class="tc-due ' + dueState + '">◷ ' + fmtDay(t.dueDate) + '</span>';
  h += '</div>';
  if ((t.labels || []).length) h += '<div class="tc-labels">' + t.labels.map(l => '<span class="tc-lab">' + esc(l) + '</span>').join("") + '</div>';
  h += '<div class="tc-foot"><div class="tc-avs">' + (t.assignees || []).slice(0,4).map(id => avatarHtml(id)).join("") + '</div>';
  const bits = [];
  if (subTot) bits.push('<span class="tc-bar"><i style="width:' + Math.round(subDone / subTot * 100) + '%"></i></span>' + subDone + "/" + subTot);
  if ((t.comments || []).length) bits.push("❝ " + t.comments.length);
  if ((t.attachments || []).length) bits.push("≣ " + t.attachments.length);
  if (bits.length) h += '<div class="tc-sub">' + bits.join(" · ") + '</div>';
  h += '</div>';
  // One-click status control right on the card.
  h += '<div class="tc-status" role="group" aria-label="Set status">' + T_STATUS.map(c =>
    '<button class="tcs-btn' + (t.status === c.key ? " on" : "") + '" data-wact="setStatus" data-tid="' + t.id + '" data-st="' + c.key + '" title="' + c.label + '" aria-label="Set status: ' + c.label + '"' + (t.status === c.key ? ' aria-pressed="true"' : '') + '><span class="tcs-dot" style="background:' + c.dot + '"></span>' + c.label + '</button>'
  ).join("") + '</div>';
  h += '</div>';
  return h;
}
function renderBoard(){
  let h = '<div class="board" id="taskBoard">';
  T_STATUS.forEach(col => {
    const cards = sortTasks(baseTasks().filter(t => t.status === col.key));
    h += '<div class="board-col"><div class="col-head"><span class="col-dot" style="background:' + col.dot + '"></span>' + col.label + '<span class="col-n">' + cards.length + '</span></div>' +
      '<div class="col-cards" data-status="' + col.key + '">' + cards.map(taskCardHtml).join("") + '</div>' +
      '<div class="col-quick"><input placeholder="+ Add task" data-wact="quickAdd" data-status="' + col.key + '"></div></div>';
  });
  return h + '</div>';
}
function renderTaskList(){
  const list = sortTasks(baseTasks());
  if (!list.length) return '<div class="empty-log tasks-empty">No tasks match. Adjust filters or add a task.</div>';
  let h = '<div class="tlist">';
  T_STATUS.forEach(col => {
    const rows = list.filter(t => t.status === col.key);
    if (!rows.length) return;
    h += '<div class="tlist-group"><div class="tlist-gh"><span class="g-dot" style="background:' + col.dot + '"></span>' + col.label + ' · ' + rows.length + '</div>';
    rows.forEach(t => {
      const pri = T_PRI[t.priority] || T_PRI.med;
      const proj = t.projectId ? projectById(t.projectId) : null;
      const dueState = taskDueState(t);
      const done = t.status === "done";
      h += '<div class="trow' + (dueState === "red" ? " overdue" : "") + '" data-wact="openTask" data-tid="' + t.id + '" style="--pc:' + pri.color + '">' +
        '<button class="tr-check' + (done ? " done" : "") + '" data-wact="toggleDone" data-tid="' + t.id + '">✓</button>' +
        '<span class="tr-title' + (done ? " done" : "") + '">' + esc(t.title || "Untitled") + '</span>' +
        '<span class="tr-side">' +
        (proj ? '<span class="tc-proj" style="color:' + esc(proj.color) + ';border-color:' + hexToSoft(proj.color) + '">' + esc(proj.name) + '</span>' : "") +
        '<span class="tc-pri ' + pri.cls + '">' + pri.label + '</span>' +
        (t.dueDate ? '<span class="tc-due ' + dueState + '">◷ ' + fmtDay(t.dueDate) + '</span>' : "") +
        '<span class="tc-avs">' + (t.assignees || []).slice(0,3).map(id => avatarHtml(id)).join("") + '</span>' +
        '</span></div>';
    });
    h += '</div>';
  });
  return h + '</div>';
}

/* ----- drag & drop ----- */
function wireBoardDnd(){
  const board = document.getElementById("taskBoard");
  if (!board) return;
  board.querySelectorAll(".tcard").forEach(card => {
    card.addEventListener("dragstart", e => { dragTaskId = card.dataset.tid; card.classList.add("dragging"); if (e.dataTransfer) e.dataTransfer.effectAllowed = "move"; });
    card.addEventListener("dragend", () => { dragTaskId = null; card.classList.remove("dragging"); board.querySelectorAll(".col-cards").forEach(c => c.classList.remove("drop-hi")); });
  });
  board.querySelectorAll(".col-cards").forEach(zone => {
    zone.addEventListener("dragover", e => { e.preventDefault(); zone.classList.add("drop-hi"); });
    zone.addEventListener("dragleave", e => { if (!zone.contains(e.relatedTarget)) zone.classList.remove("drop-hi"); });
    zone.addEventListener("drop", e => { e.preventDefault(); zone.classList.remove("drop-hi"); dropTask(zone, e); });
  });
}
function dropTask(zone, e){
  const id = dragTaskId; if (!id) return;
  const t = Tasks.get(id); if (!t) return;
  const status = zone.dataset.status;
  const cards = Array.from(zone.querySelectorAll(".tcard")).filter(c => c.dataset.tid !== id);
  let idx = cards.length;
  for (let i = 0; i < cards.length; i++){ const r = cards[i].getBoundingClientRect(); if (e.clientY < r.top + r.height / 2){ idx = i; break; } }
  const colIds = sortTasks(baseTasks().filter(x => x.status === status && x.id !== id)).map(x => x.id);
  colIds.splice(idx, 0, id);
  colIds.forEach((tid, i) => { const tk = Tasks.get(tid); if (tk) tk.order = i; });
  const wasDone = t.status === "done";
  t.status = status;
  Tasks.update(id, { status, order: t.order });
  if (status === "done" && !wasDone){
    logActivity("task", currentUser.name + " completed “" + t.title + "”", "task", id);
    const rem = (t.subtasks || []).filter(s => !s.done).length;
    if (rem) toast("Moved to Done with " + rem + " subtask" + (rem > 1 ? "s" : "") + " still open.");
  }
  renderTasks();
}

/* ----- quick add ----- */
function quickAddTask(status, title){
  title = (title || "").trim(); if (!title) return;
  const order = Math.min(0, ...Tasks.list(t => t.status === status).map(t => t.order || 0)) - 1;
  const t = Tasks.create({ title, status, order });
  logActivity("task", currentUser.name + " added “" + title + "”", "task", t.id);
  renderTasks();
  toast("Task added.");
}

/* ----- assignment ----- */
function toggleAssignee(id){
  const t = Tasks.get(editingTaskId); if (!t) return;
  syncTaskHeader();
  const has = (t.assignees || []).includes(id);
  t.assignees = has ? t.assignees.filter(x => x !== id) : (t.assignees || []).concat(id);
  Tasks.update(t.id, { assignees: t.assignees });
  if (!has && id !== currentUser.id){
    notify(id, "assigned", currentUser.name + " assigned you: " + (t.title || "a task"), { view:"tasks", taskId:t.id });
    logActivity("task", currentUser.name + " assigned " + teamName(id) + " to “" + (t.title || "a task") + "”", "task", t.id);
    fireIntegrations("assigned", currentUser.name + " assigned " + teamName(id) + " to “" + (t.title || "a task") + "”");
  }
  renderTaskModalBody();
}

/* ----- task modal ----- */
let tmMoreOpen = false;
function taskHasDetail(t){
  if (!t) return false;
  return !!(t.description || (t.assignees || []).some(id => id !== (currentUser && currentUser.id)) ||
    (t.labels || []).length || (t.subtasks || []).length || (t.comments || []).length || (t.attachments || []).length ||
    t.dueDate || t.startDate || t.projectId || t.linkedChatId || (t.priority && t.priority !== "med") ||
    (t.status && t.status !== "todo") || (t.visibility && t.visibility !== "private"));
}
function openTaskModal(id){
  editingTaskId = id;
  armedDone = null;
  tmMoreOpen = taskHasDetail(Tasks.get(id));     // expanded only when the task already carries detail; a new task shows Title alone
  document.getElementById("tmTitle").textContent = "Task detail";
  renderTaskModalBody();
  document.getElementById("taskVeil").classList.add("open");
  const nm = document.getElementById("tmName"); if (nm) nm.focus();
}
function syncTaskHeader(){
  const t = Tasks.get(editingTaskId); if (!t) return;
  const g = id => { const el = document.getElementById(id); return el ? el.value : undefined; };
  if (g("tmName") !== undefined) t.title = g("tmName").trim();
  if (g("tmDesc") !== undefined) t.description = g("tmDesc");
  if (g("tmStatus") !== undefined) t.status = g("tmStatus");
  if (g("tmPri") !== undefined) t.priority = g("tmPri");
  if (g("tmDue") !== undefined) t.dueDate = g("tmDue") || null;
  if (g("tmStart") !== undefined) t.startDate = g("tmStart") || null;
  if (g("tmProj") !== undefined) t.projectId = g("tmProj") || null;
  if (g("tmVis") !== undefined) t.visibility = g("tmVis");
}
function renderTaskModalBody(){
  const t = Tasks.get(editingTaskId); if (!t) return;
  const body = document.getElementById("tmBody");
  const opt = (val, cur, label) => '<option value="' + val + '"' + (val === cur ? " selected" : "") + '>' + label + '</option>';
  const subDone = (t.subtasks || []).filter(s => s.done).length, subTot = (t.subtasks || []).length;
  const proj = t.projectId ? projectById(t.projectId) : null;
  let h = '';
  h += '<label class="f-label" for="tmName">Title</label><input class="f-input" id="tmName" value="' + esc(t.title) + '" placeholder="What needs doing?">';
  // Only the title is required; everything else is optional and folded behind "More options".
  h += '<details class="more-opts"' + (tmMoreOpen ? ' open' : '') + '><summary>More options</summary><div class="more-opts-body">';
  h += '<label class="f-label" for="tmDesc">Description</label><textarea class="f-area" id="tmDesc">' + esc(t.description || "") + '</textarea>';
  h += '<div class="tm-grid">';
  h += '<div><label class="f-label" for="tmStatus">Status</label><select class="f-input" id="tmStatus">' + T_STATUS.map(s => opt(s.key, t.status, s.label)).join("") + '</select></div>';
  h += '<div><label class="f-label" for="tmPri">Priority</label><select class="f-input" id="tmPri">' + Object.keys(T_PRI).map(k => opt(k, t.priority, T_PRI[k].label)).join("") + '</select></div>';
  h += '</div><div class="tm-grid">';
  h += '<div><label class="f-label" for="tmStart">Start date</label><input class="f-input" id="tmStart" type="date" value="' + esc(t.startDate || "") + '"></div>';
  h += '<div><label class="f-label" for="tmDue">Due date</label><input class="f-input" id="tmDue" type="date" value="' + esc(t.dueDate || "") + '"></div>';
  h += '</div>';
  h += '<div class="tm-grid"><div><label class="f-label" for="tmProj">Project</label><select class="f-input" id="tmProj"><option value="">No project</option>' + Projects.list().map(p => opt(p.id, t.projectId || "", p.name)).join("") + '</select></div>';
  h += '<div><label class="f-label" for="tmVis">Visibility</label><select class="f-input" id="tmVis">' + opt("private", t.visibility, "Private to assignees") + opt("team", t.visibility, "Team task (workspace-visible)") + '</select></div></div>';

  h += '<label class="f-label">Assignees</label><div class="tm-assignees">' +
    TEAM.map(u => { const on = (t.assignees || []).includes(u.id); return '<button type="button" class="assign-chip' + (on ? " on" : "") + '" data-wact="assign" data-uid="' + u.id + '">' + avatarHtml(u.id) + esc(u.name.split(" ")[0]) + '</button>'; }).join("") + '</div>';

  h += '<label class="f-label">Labels</label><div class="chip-input" id="tmLabels">' +
    (t.labels || []).map(l => '<span class="lab-chip">' + esc(l) + '<b data-wact="delLabel" data-l="' + esc(l) + '">✕</b></span>').join("") +
    '<input id="tmLabelInput" placeholder="Add label, Enter"></div>';

  h += '<label class="f-label">Subtasks' + (subTot ? ' · ' + subDone + '/' + subTot : "") + '</label>';
  if (subTot) h += '<div class="sub-prog"><span class="bar"><i style="width:' + Math.round(subDone / subTot * 100) + '%"></i></span>' + Math.round(subDone / subTot * 100) + '%</div>';
  h += '<div class="sub-list">' + (t.subtasks || []).map(s =>
    '<div class="sub-item"><button class="tr-check' + (s.done ? " done" : "") + '" data-wact="subToggle" data-sid="' + s.id + '">✓</button>' +
    '<span class="' + (s.done ? "done" : "") + '">' + esc(s.text) + '</span>' +
    '<button class="k-del" data-wact="subDel" data-sid="' + s.id + '">✕</button></div>').join("") + '</div>';
  h += '<div class="mini-form"><input class="f-input" id="tmSubInput" placeholder="Add a subtask, Enter"></div>';

  h += '<label class="f-label">Attachments</label>';
  h += (t.attachments || []).map((a, i) => '<div class="tm-att"><span class="fc-ico" style="width:32px;height:32px;border-radius:6px">' + (a.kind === "image" ? "▣" : a.kind === "pdf" ? "⌘" : "≣") + '</span><div style="flex:1"><div class="fc-name">' + esc(a.name) + '</div><div class="fc-meta">' + (a.kind || "file").toUpperCase() + (a.size ? " · " + fmtSize(a.size) : "") + '</div></div><button class="k-del" data-wact="attDel" data-i="' + i + '">✕</button></div>').join("");
  h += '<button class="add-btn" data-wact="attAdd" style="margin-top:4px">+ Attach file</button><input type="file" id="tmFile" multiple style="display:none">';

  if (BRANDS.length){
    const linked = t.linkedChatId && (CHATS[t.linkedBrandId] || []).find(c => c.id === t.linkedChatId);
    h += '<label class="f-label">Linked chat</label>';
    h += '<select class="f-input" id="tmChat" data-wact="linkChat"><option value="">None</option>' +
      chats().filter(canSee).map(c => '<option value="' + c.id + '"' + (t.linkedChatId === c.id ? " selected" : "") + '>' + esc(c.name) + '</option>').join("") + '</select>';
    if (linked) h += '<button class="add-btn" data-wact="openLinkedChat" style="margin-top:6px">↗ Open linked chat</button>';
  }

  h += '<label class="f-label">Comments</label><div class="cmt-thread">' +
    ((t.comments || []).length ? t.comments.map(c => '<div class="cmt">' + avatarHtml(c.byId) + '<div class="cmt-b"><div class="cmt-h">' + esc(c.by) + ' · ' + esc(fmtTime(c.at)) + '</div><div class="cmt-t">' + esc(c.text) + '</div></div></div>').join("") : '<div class="k-empty">No comments yet.</div>') +
    '</div><div class="mini-form"><input class="f-input" id="tmCmtInput" placeholder="Write a comment, Enter"></div>';

  h += '<div class="tm-meta-line">Created by ' + esc(t.createdByName || "—") + ' · ' + esc(fmtTime(t.createdAt)) + '</div>';
  h += '</div></details>';
  body.innerHTML = h;

  const det = body.querySelector(".more-opts");
  if (det) det.addEventListener("toggle", () => { tmMoreOpen = det.open; });
  // Enter in the title submits the (title-only) task.
  const nameEl = document.getElementById("tmName");
  if (nameEl) nameEl.addEventListener("keydown", e => { if (e.key === "Enter"){ e.preventDefault(); saveTaskModal(); } });
  const bindEnter = (inpId, fn) => { const el = document.getElementById(inpId); if (el) el.addEventListener("keydown", e => { if (e.key === "Enter"){ e.preventDefault(); fn(el.value); el.value = ""; } }); };
  bindEnter("tmLabelInput", v => addTaskLabel(v));
  bindEnter("tmSubInput", v => addSubtask(v));
  bindEnter("tmCmtInput", v => addComment(v));
  const fi = document.getElementById("tmFile");
  if (fi) fi.onchange = function(){ taskAttachFiles(this.files); this.value = ""; };
}
function addTaskLabel(v){ v = (v || "").trim(); if (!v) return; const t = Tasks.get(editingTaskId); if (!t) return; syncTaskHeader(); if (!(t.labels || []).includes(v)){ t.labels = (t.labels || []).concat(v); Tasks.update(t.id, { labels:t.labels }); } renderTaskModalBody(); }
function addSubtask(v){ v = (v || "").trim(); if (!v) return; const t = Tasks.get(editingTaskId); if (!t) return; syncTaskHeader(); t.subtasks = (t.subtasks || []).concat({ id:uid("s"), text:v, done:false }); Tasks.update(t.id, { subtasks:t.subtasks }); renderTaskModalBody(); }
function addComment(v){ v = (v || "").trim(); if (!v) return; const t = Tasks.get(editingTaskId); if (!t) return; syncTaskHeader(); t.comments = (t.comments || []).concat({ id:uid("c"), by:currentUser.name, byId:currentUser.id, at:nowISO(), text:v }); Tasks.update(t.id, { comments:t.comments }); (t.assignees || []).forEach(uid2 => { if (uid2 !== currentUser.id) notify(uid2, "comment", currentUser.name + " commented on “" + (t.title || "a task") + "”", { view:"tasks", taskId:t.id }); }); renderTaskModalBody(); }
function taskAttachFiles(fileList){
  const t = Tasks.get(editingTaskId); if (!t) return;
  syncTaskHeader();
  Array.from(fileList).forEach(f => {
    if (f.size > 4.5 * 1048576){ toast(f.name + " is over 4.5 MB."); return; }
    const r = new FileReader();
    const done = obj => { t.attachments = (t.attachments || []).concat(obj); Tasks.update(t.id, { attachments:t.attachments }); renderTaskModalBody(); };
    if (f.type.startsWith("image/")) { r.onload = () => done({ kind:"image", name:f.name, media:f.type, data:r.result.split(",")[1], size:f.size }); r.readAsDataURL(f); }
    else if (f.type === "application/pdf"){ r.onload = () => done({ kind:"pdf", name:f.name, media:"application/pdf", data:r.result.split(",")[1], size:f.size }); r.readAsDataURL(f); }
    else { r.onload = () => done({ kind:"text", name:f.name, text:String(r.result).slice(0, 40000), size:f.size }); r.readAsText(f); }
  });
}
function saveTaskModal(){
  const t = Tasks.get(editingTaskId); if (!t) return;
  syncTaskHeader();
  Tasks.update(t.id, {});
  document.getElementById("taskVeil").classList.remove("open");
  if (viewIs("tasks")) renderTasks();
  renderProjectsNav();
  toast("Task saved.");
}
function deleteTaskNow(){
  const btn = document.getElementById("tmDelete");
  if (!btn.dataset.armed){ btn.dataset.armed = "1"; btn.textContent = "Click again to delete"; setTimeout(() => { btn.dataset.armed = ""; btn.textContent = "Delete task"; }, 3000); return; }
  btn.dataset.armed = ""; btn.textContent = "Delete task";
  Tasks.remove(editingTaskId);
  document.getElementById("taskVeil").classList.remove("open");
  if (viewIs("tasks")) renderTasks();
  renderProjectsNav();
  toast("Task deleted.");
}
function toggleDone(id){
  const t = Tasks.get(id); if (!t) return;
  if (t.status !== "done"){
    const rem = (t.subtasks || []).filter(s => !s.done).length;
    if (rem && armedDone !== id){ armedDone = id; toast(rem + " subtask" + (rem > 1 ? "s" : "") + " still open. Tap the check again to mark done."); setTimeout(() => { if (armedDone === id) armedDone = null; }, 3000); return; }
    armedDone = null;
    Tasks.update(id, { status:"done", completedAt: nowISO() });
    logActivity("task", currentUser.name + " completed “" + t.title + "”", "task", id);
    autoActivityForTask(t);
  } else {
    Tasks.update(id, { status:"todo", completedAt: null });
  }
  if (viewIs("tasks")) renderTasks();
}
// One-click status change straight from the card (To do / In progress / Review / Done).
function setTaskStatus(id, st){
  const t = Tasks.get(id); if (!t || !T_STATUS.some(c => c.key === st)) return;
  const patch = { status: st, completedAt: st === "done" ? nowISO() : null };
  Tasks.update(id, patch);
  if (st === "done"){ logActivity("task", currentUser.name + " completed “" + t.title + "”", "task", id); autoActivityForTask(t); }
  if (viewIs("tasks")) renderTasks();
  renderProjectsNav();
}

/* ----- project modal ----- */
function openProjectModal(id){
  editingProjectId = id || null;
  const p = id ? Projects.get(id) : null;
  document.getElementById("pmTitle").textContent = p ? "Edit project" : "New project";
  document.getElementById("pmName").value = p ? p.name : "";
  const color = p ? p.color : "#8E959F";
  document.getElementById("pmColor").value = color;
  document.getElementById("pmColorPick").value = normHex(color) || "#8E959F";
  document.getElementById("pmDesc").value = p ? (p.description || "") : "";
  document.getElementById("pmDelete").style.display = p ? "block" : "none";
  document.getElementById("pmDelete").dataset.armed = "";
  document.getElementById("pmDelete").textContent = "Delete project";
  document.getElementById("projVeil").classList.add("open");
}
function saveProjectModal(){
  const name = document.getElementById("pmName").value.trim();
  if (!name){ document.getElementById("pmName").focus(); return; }
  const color = normHex(document.getElementById("pmColor").value) || document.getElementById("pmColorPick").value || "#8E959F";
  const desc = document.getElementById("pmDesc").value.trim();
  if (editingProjectId){ Projects.update(editingProjectId, { name, color, description:desc }); }
  else { const p = Projects.create({ name, color, description:desc }); logActivity("project", currentUser.name + " created project " + name, "project", p.id); }
  document.getElementById("projVeil").classList.remove("open");
  renderProjectsNav();
  if (viewIs("tasks")) renderTasks();
  toast("Project saved.");
}
function deleteProjectNow(){
  const btn = document.getElementById("pmDelete");
  if (!btn.dataset.armed){ btn.dataset.armed = "1"; btn.textContent = "Click again to delete"; setTimeout(() => { btn.dataset.armed = ""; btn.textContent = "Delete project"; }, 3000); return; }
  const pid = editingProjectId;
  Tasks.list(t => t.projectId === pid).forEach(t => Tasks.update(t.id, { projectId:null }));
  Projects.remove(pid);
  if (taskFilter.project === pid) taskFilter.project = "";
  document.getElementById("projVeil").classList.remove("open");
  renderProjectsNav();
  if (viewIs("tasks")) renderTasks();
  toast("Project deleted. Its tasks were kept.");
}

/* Normalize an AI-supplied visibility token to the app's actual values ("private" | "team").
   Accepts natural synonyms the model may emit (just me / everyone / the whole team / public …). */
function normVisibility(s, dflt){
  s = (s || "").toLowerCase().trim();
  if (!s) return dflt;
  if (/\b(private|just ?me|only ?me|myself|personal|me only|hidden)\b/.test(s)) return "private";
  if (/\b(team|everyone|public|shared|workspace|whole team|all|company)\b/.test(s)) return "team";
  return dflt;
}
/* ----- AI task ingestion ([[TASK:]]) ----- */
function ingestAITasks(lines){
  if (!lines || !lines.length) return 0;
  let made = 0;
  lines.forEach(line => {
    const parts = line.split("|").map(s => s.trim());
    const title = parts[0]; if (!title) return;
    const assigneeName = parts[1] || "";
    const dateStr = parts[2] || "";
    const priStr = (parts[3] || "med").toLowerCase();
    const projName = parts[4] || "";
    const visibility = normVisibility(parts[5], "private");   // AI tasks default private unless the user says team/everyone
    const assignee = TEAM.find(u => assigneeName && (u.name.toLowerCase() === assigneeName.toLowerCase() || u.name.toLowerCase().split(" ")[0] === assigneeName.toLowerCase()));
    let projectId = null;
    if (projName){
      let p = Projects.list().find(x => x.name.toLowerCase() === projName.toLowerCase());
      if (!p) p = Projects.create({ name: projName });
      projectId = p.id;
    }
    const pri = ["low","med","high","urgent"].includes(priStr) ? priStr : (priStr.startsWith("med") ? "med" : (priStr.startsWith("urg") ? "urgent" : (priStr.startsWith("hi") ? "high" : (priStr.startsWith("lo") ? "low" : "med"))));
    const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? dateStr : null;
    const t = Tasks.create({ title, priority:pri, dueDate, projectId, visibility, assignees: assignee ? [assignee.id] : (currentUser ? [currentUser.id] : []) });
    if (assignee && assignee.id !== currentUser.id){ notify(assignee.id, "assigned", currentUser.name + " (via SYN) assigned you: " + title, { view:"tasks", taskId:t.id }); fireIntegrations("assigned", currentUser.name + " (via SYN) assigned " + assignee.name + " to “" + title + "”"); }
    made++;
  });
  if (made){ logActivity("task", currentUser.name + " used SYN to create " + made + " task" + (made > 1 ? "s" : ""), "task", null); renderProjectsNav(); if (viewIs("tasks")) renderTasks(); }
  return made;
}

/* ----- Ask SYN to plan ----- */
async function planWithSYN(){
  const t = document.getElementById("tmPlanInput");
  const goal = (t.value || "").trim();
  if (!goal){ t.focus(); return; }
  const btn = document.getElementById("planRun");
  const status = document.getElementById("planStatus");
  const pGate = gateAI("smart", "plan_tasks");   // the planner drafts real board tasks — smart model, smart cap
  if (!pGate.ok){ status.textContent = pGate.reason; return; }
  if (pGate.reason) toast(pGate.reason);
  btn.textContent = "Planning…"; btn.disabled = true;
  status.textContent = "SYN is breaking this down into tasks…";
  const today = new Date().toISOString().slice(0,10);
  const names = TEAM.map(u => u.name).join(", ");
  try{
    const res = await fetch(apiBase() + "/v1/messages", {
      method:"POST", headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({
        model: MODELS[pGate.downgrade ? "fast" : "smart"], max_tokens: AI_MAX_TOKENS.plan_tasks,
        system: "You are a project planner. Break the user's goal into concrete, actionable tasks. Respond with ONLY task lines, one per line, each EXACTLY in this format and nothing else:\n[[TASK: title | assignee | YYYY-MM-DD | priority | project]]\nAssignee must be one of these team members or left blank: " + names + ". Priority is one of low, med, high, urgent. Project is a short project name (reuse the same name for all tasks in this plan). Dates should be realistic relative to today (" + today + "). Produce 4 to 10 tasks. No commentary, no markdown, only the task lines.",
        messages: [{ role:"user", content: "Goal: " + goal }]
      })
    });
    const data = await res.json();
    const txt = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("");
    const lines = (txt.match(/\[\[TASK:([^\]]+)\]\]/g) || []).map(m => m.replace(/\[\[TASK:/, "").replace(/\]\]$/, "").trim());
    const n = ingestAITasks(lines);
    if (n){ document.getElementById("planVeil").classList.remove("open"); toast("SYN created " + n + " task" + (n > 1 ? "s" : "") + "."); }
    else status.textContent = "SYN didn't return tasks in a usable format. Try rephrasing, or add tasks manually.";
  }catch(e){
    status.textContent = "SYN is offline right now. The AI planner needs SYN Core connected. You can still add tasks manually with + New Task.";
  }
  btn.textContent = "Plan it"; btn.disabled = false;
}
function openPlanModal(){
  document.getElementById("tmPlanInput").value = "";
  document.getElementById("planStatus").textContent = "SYN reads your team and drafts a set of tasks. Review and edit them on the board after.";
  document.getElementById("planVeil").classList.add("open");
}

