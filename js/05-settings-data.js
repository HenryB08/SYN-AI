/* ============================================================
   js/05-settings-data.js — SETTINGS, view registry, the signed-in GUIDE, voice input, legacy team chat + export/backup, then the core data layer: global event bus, org-scoped cached collections, the typed entity factory, ops-layer helpers, per-org integrations config, notifications, activity feed, due-soon scan, the workspace sync poll, and shared helpers.
   MOVE, not a refactor: a byte-identical slice of the original inline <script>.
   Order-dependent. Loads after 04-pricing-brand.js and before 06-tasks.js. Shared global
   scope, not a module. Do not reorder these tags.
   ============================================================ */
/* ---------------- SETTINGS ---------------- */
let resetUid = null;
function renderSettings(){
  const p = document.getElementById("settingsPanel");
  let html = '<div class="panel-head"><div><h2>Settings</h2><p class="sub">' + esc(ORG ? ORG.name : "") + ' workspace, team, and session controls.</p></div></div>';

  // My Profile (personal, per-user)
  const myProf = Profiles.get(currentUser.id) || {};
  const acc = myProf.accent || "";
  html += '<div class="spec-block"><div class="sb-head">My Profile</div><div class="sb-body">' +
    '<div class="prof-row">' + avatarBig(currentUser.id, 'width:74px;height:74px;font-size:24px').replace('class="avatar"', 'class="avatar prof-av"') +
    '<div style="flex:1;min-width:200px"><div class="prof-actions"><button class="btn-ghost" data-wact="profUpload">Upload photo</button>' +
    (myProf.avatar ? '<button class="btn-ghost" data-wact="profRemoveAvatar">Remove</button>' : '') + '</div>' +
    '<div class="f-hint" style="margin-top:8px">A square photo works best. Stored compressed and shared with your team.</div></div>' +
    '<input type="file" id="profFile" accept="image/*" style="display:none"></div>' +
    '<label class="f-label" for="profName" style="margin-top:16px">Display name</label>' +
    '<div class="mini-form" style="margin-top:0"><input class="f-input" id="profName" value="' + esc(currentUser.name) + '"><button class="btn-gold" data-wact="profSaveName">Save</button></div>' +
    '<label class="f-label" style="margin-top:16px">Personal accent</label>' +
    '<div class="f-hint" style="margin-top:0;margin-bottom:8px">Themes only your own My Day and Portfolio screens. Never changes shared screens for teammates.</div>' +
    '<div class="prof-accent-row"><input type="color" id="profAccentPick" value="' + (normHex(acc) || "#8E959F") + '"><input class="f-input" id="profAccent" placeholder="Brand default" value="' + esc(acc) + '" style="max-width:150px">' +
    '<button class="btn-gold" data-wact="profSaveAccent">Apply</button>' + (acc ? '<button class="btn-ghost" data-wact="profClearAccent">Use brand accent</button>' : '') +
    '</div></div></div>';

  if (isAdmin()){
    html += '<div class="spec-block"><div class="sb-head">Live Team Code <button class="add-btn" data-act="refreshCode">Refresh</button></div><div class="sb-body">' +
      '<div class="code-big" id="codeBig">' + esc(orgCode(ORG)) + '</div>' +
      '<div style="text-align:center;margin-bottom:6px"><button class="btn-ghost" data-act="copyCode">Copy code</button></div>' +
      '<div class="code-sub">Rotates every 30 minutes · <span id="codeMinsLeft">' + codeMinutesLeft() + '</span> min left on this code</div>' +
      '<div class="f-hint" style="text-align:center">Give this code to teammates. They pick Join Team on the sign-in screen, enter it, and create their own account in this workspace.</div>' +
      '</div></div>';
    html += renderBilling();          // admin-only Billing
  }

  html += '<div class="spec-block"><div class="sb-head">Workspace</div><div class="sb-body">' +
    '<div class="set-row"><div class="set-info"><div class="set-title">Appearance</div><div class="set-sub">Light or dark theme. Defaults to your system preference.</div></div>' +
    '<button class="toggle ' + (currentTheme() === "light" ? "on" : "") + '" data-wact="toggleTheme" aria-label="Toggle light theme" role="switch" aria-checked="' + (currentTheme() === "light") + '"></button></div>' +
    '<div class="set-row"><div class="set-info"><div class="set-title">Focus mode</div><div class="set-sub">Hide the sidebar for a distraction-free full-screen workspace (⌘ / Ctrl + .)</div></div>' +
    '<button class="btn-ghost" data-wact="toggleFocusMode">Enter focus</button></div>' +
    '<div class="set-row"><div class="set-info"><div class="set-title">Living background</div><div class="set-sub">Aurora motion behind the glass</div></div>' +
    '<button class="toggle ' + (SETTINGS.motion !== false ? "on" : "") + '" data-act="toggleMotion" aria-label="Toggle motion"></button></div>' +
    '<div class="set-row"><div class="set-info"><div class="set-title">Workspace storage</div><div class="set-sub">' +
    (persistMode === "cloud" ? "Synced to SYN Core. Accounts, brands, chats, memory, and approvals are saved to the cloud and shared with your team across devices." : persistMode === "shared" ? "Connected. Accounts, brands, chats, memory, and approvals are saved and shared with your team." : persistMode === "device" ? "Saving to this browser only. SYN Core wasn't reachable, so cross-device team sync is off right now." : "Unavailable in this environment; running in-session only.") +
    '</div></div><span class="role-pill">' + (persistMode === "cloud" ? "Synced" : persistMode === "shared" ? "Saved" : persistMode === "device" ? "Device" : "Session") + '</span></div>' +
    '<div class="set-row"><div class="set-info"><div class="set-title">Workspace backup</div><div class="set-sub">Download everything (brands, chats, memory, approvals) as one JSON file</div></div>' +
    '<button class="btn-ghost" data-act="backup">Download</button></div>' +
    '</div></div>';

  html += '<div class="spec-block"><div class="sb-head">Calendar</div><div class="sb-body">' +
    '<div class="set-row"><div class="set-info"><div class="set-title">Show tasks on the calendar</div><div class="set-sub">Tasks with due dates appear read-only on the calendar</div></div>' +
    '<button class="toggle ' + (SETTINGS.calShowTasks !== false ? "on" : "") + '" data-act="toggleCalTasks" aria-label="Toggle tasks on calendar"></button></div>' +
    '<div class="set-row"><div class="set-info"><div class="set-title">Export calendar</div><div class="set-sub">Download the whole workspace calendar as a standard .ics file</div></div>' +
    '<button class="btn-ghost" data-act="exportIcs">Export .ics</button></div>' +
    '<div class="set-row"><div class="set-info"><div class="set-title">Google Calendar</div><div class="set-sub">Per-event "Add to Google Calendar" and .ics export work now. Live two-way Google sync arrives with SYN Core.</div></div>' +
    '<span class="role-pill">Coming with SYN Core</span></div>' +
    '</div></div>';

  html += renderIntegrations();

  // Projects management
  html += '<div class="spec-block"><div class="sb-head">Projects <button class="add-btn" data-wact="newProject">+ New project</button></div><div class="sb-body">';
  const projs = Projects.list();
  if (!projs.length) html += '<div class="k-empty">No projects yet. Group tasks under a project from here or the Tasks sidebar.</div>';
  else projs.forEach(pr => { const n = Tasks.list(t => canSeeTask(t) && t.projectId === pr.id).length;
    html += '<div class="k-row"><div class="k-ico" style="background:' + hexToSoft(pr.color) + ';color:' + esc(pr.color) + '">◆</div>' +
      '<div style="flex:1"><div class="k-name">' + esc(pr.name) + '</div><div class="k-meta">' + n + ' task' + (n === 1 ? '' : 's') + (pr.description ? ' · ' + esc(pr.description) : '') + '</div></div>' +
      '<button class="c-tool" data-wact="editProject" data-id="' + pr.id + '" title="Edit" style="opacity:1;display:inline">✎</button></div>';
  });
  html += '</div></div>';

  // Spaces management (admins)
  if (isAdmin()){
    html += '<div class="spec-block"><div class="sb-head">Spaces <button class="add-btn" data-wact="newSpace">+ New space</button></div><div class="sb-body">';
    const sps = Spaces.list().sort((a,b) => (a.createdAt < b.createdAt ? -1 : 1));
    if (!sps.length) html += '<div class="k-empty">No spaces yet.</div>';
    else sps.forEach(s => { const mem = s.members === "all" ? "Whole workspace" : (Array.isArray(s.members) ? s.members.length + " members" : "");
      html += '<div class="k-row"><div class="k-ico" style="background:' + hexToSoft(s.color) + ';color:' + esc(s.color) + '">' + esc(s.icon || "◆") + '</div>' +
        '<div style="flex:1"><div class="k-name">' + esc(s.name) + (s.type === "ai" ? ' <span class="space-ai-tag">AI</span>' : '') + (s.archived ? ' <span class="k-meta" style="display:inline">· archived</span>' : '') + '</div><div class="k-meta">' + (s.type === "ai" ? "AI space" : "Team space") + ' · ' + mem + '</div></div>' +
        '<button class="c-tool" data-wact="editSpace" data-id="' + s.id + '" title="Manage" style="opacity:1;display:inline">✎</button></div>';
    });
    html += '</div></div>';
  }

  // Notification preferences (per-user)
  const npref = (type, title, sub) => '<div class="set-row"><div class="set-info"><div class="set-title">' + title + '</div><div class="set-sub">' + sub + '</div></div>' +
    '<button class="toggle ' + (NOTIF_PREFS[type] !== false ? "on" : "") + '" data-act="toggleNotif" data-nt="' + type + '" aria-label="Toggle"></button></div>';
  html += '<div class="spec-block"><div class="sb-head">Notification preferences</div><div class="sb-body">' +
    npref("assigned", "Task assignments", "When a task is assigned to you") +
    npref("mention", "Mentions", "When a teammate @mentions you in a space") +
    npref("dm", "Direct messages", "When you get a new DM") +
    npref("task-due", "Due-soon tasks", "When your tasks are due within 48 hours") +
    npref("event", "Event invites", "When you are added to an event") +
    npref("comment", "Task comments", "When someone comments on a task you are on") +
    '<div class="f-hint" style="margin-top:10px">Preferences are personal to you and apply on this device.</div></div></div>';

  html += '<div class="spec-block"><div class="sb-head">Team · ' + esc(ORG ? ORG.name : "") + '</div><div class="sb-body">';
  TEAM.forEach(m => {
    html += '<div class="team-row">' + avatarBig(m.id) +
      '<div><div class="k-name">' + esc(m.name) + '</div><div class="k-meta">' + esc(m.email) + '</div></div>';
    if (isAdmin() && m.id !== currentUser.id){
      html += '<select class="role-sel" data-act="roleChange" data-uid="' + m.id + '">' +
        '<option ' + (m.role === "Member" ? "selected" : "") + '>Member</option>' +
        '<option ' + (m.role === "Admin" ? "selected" : "") + '>Admin</option></select>' +
        '<button class="c-tool" data-act="resetPw" data-uid="' + m.id + '" title="Reset password" style="margin-left:6px;opacity:1;display:inline">PW</button>' +
        '<button class="k-del" data-act="delUser" data-uid="' + m.id + '" title="Remove" style="margin-left:2px">✕</button>';
    } else {
      html += '<span class="role-pill">' + esc(m.role) + (m.id === currentUser.id ? " · You" : "") + "</span>";
    }
    html += "</div>";
    if (resetUid === m.id){
      html += '<div class="mini-form" style="margin:4px 0 10px 46px"><input class="f-input" id="rpInput" type="text" placeholder="New temporary password for ' + esc(m.name) + '">' +
        '<button class="btn-gold" data-act="resetPwSave" data-uid="' + m.id + '">Set</button>' +
        '<button class="btn-ghost" data-act="resetPwCancel">Cancel</button></div>';
    }
  });
  html += '<div class="f-hint" style="margin-top:12px">Teammates join with the live team code. Admins manage roles and reset passwords here. Email reset links arrive with SYN Core.</div>';
  html += "</div></div>";

  if (isAdmin() && !BRANDS.length){
    html += '<div class="spec-block"><div class="sb-head">Demo</div><div class="sb-body">' +
      '<div class="set-row"><div class="set-info"><div class="set-title">Load Syntrex demo brands</div><div class="set-sub">Seed HALT Fire, Doughbrik&#39;s Wavers, and Karlo Financial into this workspace for a demo</div></div>' +
      '<button class="btn-ghost" data-act="loadDemo">Load</button></div></div></div>';
  }

  html += '<div class="spec-block"><div class="sb-head">Session</div><div class="sb-body">' +
    '<div class="set-row"><div class="set-info"><div class="set-title">Signed in as ' + esc(currentUser.name) + '</div><div class="set-sub">' + esc(currentUser.email) + " · " + esc(currentUser.role) + '</div></div>' +
    '<button class="btn-ghost" data-act="signout">Sign out</button></div></div></div>';
  p.innerHTML = html;
  startCodeCountdown();
  const pf = document.getElementById("profFile");
  if (pf) pf.onchange = function(){ if (this.files && this.files[0]) compressImage(this.files[0], 256, data => { if (data){ saveMyProfile({ avatar:data }); refreshMyAvatar(); renderSettings(); toast("Photo updated."); } else toast("Could not read that image."); }); this.value = ""; };
  const pap = document.getElementById("profAccentPick"), pat = document.getElementById("profAccent");
  if (pap && pat){ pap.addEventListener("input", () => { pat.value = pap.value.toUpperCase(); }); pat.addEventListener("input", () => { const h = normHex(pat.value); if (h) pap.value = h; }); }
}
/* Live team-code counter: ticks the minutes-remaining down and swaps the code
   in place when it rotates on the half-hour. Rotation logic itself is unchanged. */
let codeTimer = null;
function startCodeCountdown(){
  clearInterval(codeTimer);
  if (!isAdmin()) return;
  codeTimer = setInterval(() => {
    const mins = document.getElementById("codeMinsLeft");
    if (!mins || !ORG || !viewIs("settings")){ clearInterval(codeTimer); return; }
    mins.textContent = codeMinutesLeft();
    const cb = document.getElementById("codeBig");
    if (cb){ const cur = orgCode(ORG); if (cb.textContent !== cur) cb.textContent = cur; }
  }, 15000);
}

/* ---------------- VIEWS ---------------- */
function setView(v){
  document.querySelectorAll(".view").forEach(el => el.classList.remove("active"));
  document.getElementById("view-" + v).classList.add("active");
  document.querySelectorAll(".nav-btn").forEach(el => el.classList.toggle("active", el.dataset.view === v));
  if (typeof applyPersonalAccent === "function") applyPersonalAccent();
  if (v === "myday") renderMyDay();
  if (v === "people") renderPeople();
  if (v === "tasks") renderTasks();
  if (v === "calendar") renderCalendar();
  if (v === "spaces") renderSpaces();
  if (v === "profile") renderProfile();
  if (v === "settings") renderSettings();
  if (v === "assets"){ wireAssetDnD(); renderAssets(); }
  if (v === "dashboard") renderDashboard();
  if (v === "activity") renderActivity();
  if (v === "followups") renderFollowups();
  if (v === "deps") renderDeps();
  if (v === "recap") renderRecap();
  if (v === "rollup") renderRollup();
  if (v === "guide") renderGuide();
  if (window.innerWidth <= 900) document.getElementById("sidebar").classList.remove("open");
}


/* ---------------- GUIDE (signed-in manual; never rendered on the public site) ---------------- */
const GUIDE_IMGS = {
  start: "img/guide/getting-started.webp",
  brand: "img/guide/brand-profile.webp",
  tasks: "img/guide/tasks-assignments.webp",
  calendar: "img/guide/calendar.webp",
  followups: "img/guide/followups-escalation.webp",
  deps: "img/guide/dependencies.webp",
  activity: "img/guide/activities-transcript.webp",
  recap: "img/guide/weekly-recap-rollup.webp",
  spaces: "img/guide/spaces-dms.webp",
  assets: "img/guide/assets-permissions.webp",
  chat: "img/guide/ai-chat.webp",
  settings: "img/guide/settings-integrations.webp",
};
const GUIDE_DIMS = {start:[1200,750],brand:[1200,750],tasks:[1200,750],calendar:[1200,750],followups:[1200,750],deps:[1200,750],activity:[1200,750],recap:[1200,750],spaces:[1200,750],assets:[1200,750],chat:[1200,750],settings:[1200,750]};
const GUIDE = [
  { id:"start", title:"Getting started", key:"onboarding setup first steps welcome checklist",
    body:["SYN is one workspace with your brand's memory built in. You set it up once; from then on every surface — tasks, calendar, chat, spaces, assets — works from the same brain.","Work through the checklist below. Each item links to the part of this guide that explains it."],
    notes:[[11.5, 26.1, "Your brand and chats live in the sidebar"], [61, 23.6, "My Day greets you with what matters now"], [61, 39.1, "Ask SYN from anywhere"], [74.6, 68.7, "Due follow-ups escalate here until handled"]],
    go:{v:"myday",label:"Open My Day"}, checklist:true },
  { id:"brand", title:"Brand Profile", key:"voice palette claims guardrails memory knowledge encode brain",
    body:["The Brand Profile is the brain. Encode your voice, audience, palette, products, approved and banned claims, and legal lines once — SYN enforces them on everything it writes, and your team sees them everywhere they work.","Memories are permanent facts SYN carries into every chat. Knowledge is reference material it can draw on. Add both here."],
    notes:[[11.5, 14.9, "The active brand"], [61, 66, "Voice, audience, and products"], [61, 28.9, "Memory SYN never forgets"], [61, 91, "Palette and visual rules"]],
    go:{v:"profile",label:"Open Brand Profile"} },
  { id:"tasks", title:"Tasks & assignments", key:"board kanban list my tasks assignees priority labels projects subtasks due",
    body:["Three views of the same work: Board for flow, List for scanning, My Tasks for focus. Drag cards between columns, or change status right on the card.","Tasks are private to their assignees until you mark them \"team\". Admins see everything. Priorities, labels, projects, subtasks, comments, and due dates are all on the card."],
    notes:[[54.8, 24.3, "Board, List, or My Tasks"], [32.7, 29.1, "Filter by project, person, priority, label"], [93.1, 24.3, "New task"], [0, 0, "Drag cards between columns; status on the card"]],
    go:{v:"tasks",label:"Open Tasks"} },
  { id:"calendar", title:"Calendar", key:"events month week agenda recurring meeting link ics google",
    body:["Month, week, and agenda views. Events take attendees, locations, meeting links, and recurrence; tasks with due dates show up alongside them so the week reads true.","Any event exports to Google Calendar or .ics in one click. Meeting links join from the event, from My Day, or from the calendar itself."],
    notes:[[59.6, 14.2, "Switch month / week / day / agenda"], [61, 26.2, "Click any day to add"], [92.9, 14.2, "New event"]],
    go:{v:"calendar",label:"Open Calendar"} },
  { id:"followups", title:"Follow-ups & escalation", key:"overdue due today snooze reschedule escalate amber red aging",
    body:["Everything you owe a next touch, in one place. Every follow-up carries a date, and its state ages honestly: upcoming, due today, then escalating day by day until it's handled.","Color never stands alone — the label always says exactly how overdue something is. Snooze it, reschedule it, or complete it; nothing silently disappears."],
    notes:[[61, 41.7, "Every state is labeled, not just colored"], [78.3, 41.7, "Snooze, reschedule, or complete"], [0, 0, "Export the whole list as CSV"]],
    go:{v:"followups",label:"Open Follow-ups"} },
  { id:"deps", title:"Dependencies", key:"waiting blocked owes cross-person asks",
    body:["A dependency is a cross-person ask with a name on both ends: who needs it, who owes it, by when. Both sides see it — it shows on your My Day under \"Waiting on you\" and on theirs under what they're owed.","When it resolves, the requester is notified. No more chasing status in DMs."],
    notes:[[39.9, 28, "Who owes whom, and for what"], [52.2, 28, "Both sides see it — aging in days"]],
    go:{v:"deps",label:"Open Dependencies"} },
  { id:"activity", title:"Activities & transcript capture", key:"log call meeting note outcome transcript parse capture crm",
    body:["Log the outside world: calls, meetings, emails, site visits. Each activity takes an outcome, notes, and an optional follow-up date that feeds the Follow-ups view.","Three ways in: the + New quick add, the Activity view itself, or paste a raw transcript and let SYN parse it into a structured activity with the follow-up already attached."],
    notes:[[0, 0, "Log a call, meeting, or note"], [0, 0, "Paste a transcript — SYN structures it"], [61, 49.2, "Outcome, notes, and next touch"]],
    go:{v:"activity",label:"Open Activity"} },
  { id:"recap", title:"Weekly Recap & Rollup", key:"summary week report rollup company admin csv", admin:true,
    body:["The Weekly Recap writes your week for you: what moved, what shipped, what's overdue, what's next. Everyone gets their own.","Admins also get the company Rollup — every person's week across the workspace, with usage and approvals, exportable as CSV. Members never see each other's private work."],
    notes:[[46.7, 16.5, "Your week, auto-written"], [61, 71.1, "What moved, shipped, and is overdue"]],
    go:{v:"recap",label:"Open Weekly Recap"}, goAdmin:{v:"rollup",label:"Open Rollup (admin)"} },
  { id:"spaces", title:"Spaces & DMs", key:"channels direct messages mentions reactions ai spaces team chat",
    body:["Spaces are team channels; DMs are one-to-one. @mentions notify, reactions work as you'd expect, and unread counts follow you to My Day.","An AI space is a channel where SYN is a member. The whole team talks to the same brain together — same brand rules, same memory, shared context."],
    notes:[[32.1, 17.9, "Channels and direct messages"], [38.2, 27.8, "Start a direct message"], [95.1, 92.4, "@mentions and reactions in the thread"]],
    go:{v:"spaces",label:"Open Spaces"} },
  { id:"assets", title:"Assets & permissions", key:"files upload drag permissions private workspace folders grid",
    body:["Brand files live here: drop them anywhere on the view to upload. Folders, grid or list, filter by type.","Every asset has a real permission: private to you, specific people, or the whole workspace — enforced at the data layer, not just hidden in the interface. What you can't see, you can't fetch."],
    notes:[[61, 28.3, "Folders, grid/list, and type filters"], [33.5, 51.3, "Private · specific people · workspace"]],
    go:{v:"assets",label:"Open Assets"} },
  { id:"chat", title:"AI chat — private vs shared, modes", key:"copy imagery smart fast verdict approve draft private shared",
    body:["Chats in the sidebar are private to you. Work SYN produces there still follows brand rules, but only you see the thread. To work with SYN in the open, use an AI space instead.","Two output modes: Copy for words, Imagery for pictures. Two engines: Smart for brand and campaign work (reviewed before it ships), Fast for everyday questions. Anything that needs review carries a verdict — nothing ships without one."],
    notes:[[11.5, 26.1, "Private chats — yours alone"], [36.8, 86.2, "Copy or Imagery · Smart or Fast"]],
    go:{v:"chat",label:"Open Chat"} },
  { id:"settings", title:"Settings & integrations", key:"profile accent team code invite billing seats slack teams zoom webhook export theme",
    body:["Your profile, display name, photo, and a personal accent that themes only your own screens. Theme and motion preferences live here too.","Invites are a live team code — share it, teammates join themselves. Admins manage seats and billing. Integrations connect Slack, Microsoft Teams, Zoom, and plain webhooks to fire on assignments, approvals, events, and mentions."],
    notes:[[61, 28.9, "Profile and personal accent"], [61, 68.1, "Live team code — how teammates join"], [61, 96.6, "Billing and seats (admin)"]],
    go:{v:"settings",label:"Open Settings"} }
];
function guideChecklist(){
  const anyChat = Object.values(CHATS || {}).some(arr => (arr || []).some(c => (c.msgs || []).some(m => m.role === "syn")));
  return [
    { t:"Encode your brand", done:BRANDS.length > 0, sec:"brand" },
    { t:"Invite a teammate", done:TEAM.length > 1, sec:"settings" },
    { t:"Create your first task", done:Tasks.list().length > 0, sec:"tasks" },
    { t:"Put something on the calendar", done:Events.list().length > 0, sec:"calendar" },
    { t:"Ask SYN for a draft", done:anyChat, sec:"chat" },
    { t:"Upload a brand asset", done:Assets.list().length > 0, sec:"assets" }
  ];
}
let guideQ = "";
function renderGuide(){
  const p = document.getElementById("guidePanel"); if (!p) return;
  p.innerHTML =
    '<div class="gd-band-txt"><h2>How to use SYN</h2><p>The whole product, one page.</p></div>' +
    '<div class="gd-head spec-block"><p>Short explanations, real screenshots, and a way to jump straight into each view and try it.</p></div>' +
    '<div class="gd-search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/><path d="M20 20l-4.2-4.2"/></svg><input id="gdSearch" placeholder="Search the guide\u2026" value="' + esc(guideQ) + '"><span class="gd-count" id="gdCount"></span></div>' +
    '<div class="gd-toc" id="gdToc"></div><div id="gdSecs"></div>';
  document.getElementById("gdSearch").addEventListener("input", e => { guideQ = e.target.value; renderGuideSecs(); });
  renderGuideSecs();
}
function renderGuideSecs(){
  const q = guideQ.trim().toLowerCase();
  const hit = g => !q || (g.title + " " + g.key + " " + g.body.join(" ")).toLowerCase().includes(q);
  const list = GUIDE.filter(hit);
  document.getElementById("gdCount").textContent = list.length + " of " + GUIDE.length;
  document.getElementById("gdToc").innerHTML = list.map(g => '<button data-wact="guideGo" data-sec="' + g.id + '">' + esc(g.title) + '</button>').join("");
  const wrap = document.getElementById("gdSecs");
  if (!list.length){ wrap.innerHTML = '<div class="gd-none">Nothing matches \u201c' + esc(guideQ) + '\u201d. Try a feature name \u2014 \u201cfollow-ups\u201d, \u201cclaims\u201d, \u201cpermissions\u201d.</div>'; return; }
  wrap.innerHTML = list.map((g, i) => {
    let h = '<div class="gd-sec" id="gd-' + g.id + '"><div class="gd-sec-head"><span class="n">' + String(GUIDE.indexOf(g) + 1).padStart(2, "0") + '</span><h3>' + esc(g.title) + '</h3>' + (g.admin ? '<span class="gd-admin">Admin view included</span>' : '') + '</div>';
    g.body.forEach(t => h += '<p>' + t + '</p>');
    if (g.checklist){
      h += '<div class="gd-check">';
      guideChecklist().forEach(c => {
        h += '<div class="gd-check-row' + (c.done ? " done" : "") + '"><span class="st">' + (c.done ? "\u2713" : "") + '</span><span class="lbl">' + esc(c.t) + '</span><a data-wact="guideGo" data-sec="' + c.sec + '">How \u2192</a></div>';
      });
      h += '</div>';
    }
    h += '<div class="gd-shot"><img src="' + GUIDE_IMGS[g.id] + '" alt="SYN ' + esc(g.title) + ' screenshot" data-sec-title="' + esc(g.title) + '" width="' + (GUIDE_DIMS[g.id] ? GUIDE_DIMS[g.id][0] : "") + '" height="' + (GUIDE_DIMS[g.id] ? GUIDE_DIMS[g.id][1] : "") + '" loading="lazy" decoding="async" onerror="guideImgFail(this)">' +
      g.notes.map((n, j) => '<span class="gd-dot" style="--x:' + n[0] + '%;--y:' + n[1] + '%">' + (j + 1) + '</span>').join("") + '</div>';
    h += '<div class="gd-legend">' + g.notes.map((n, j) => '<div><b>' + (j + 1) + '</b>' + esc(n[2]) + '</div>').join("") + '</div>';
    h += '<button class="head-btn gd-try" data-wact="goView" data-v="' + g.go.v + '">' + esc(g.go.label) + ' \u2192</button>';
    if (g.goAdmin && isAdmin()) h += ' <button class="head-btn gd-try" data-wact="goView" data-v="' + g.goAdmin.v + '">' + esc(g.goAdmin.label) + ' \u2192</button>';
    return h + '</div>';
  }).join("");
}
function guideGo(sec){
  setView("guide");
  guideQ = ""; renderGuide();
  requestAnimationFrame(() => {
    const el = document.getElementById("gd-" + sec); if (!el) return;
    el.scrollIntoView({ block:"start" });
    el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 1200);
  });
}
/* Guide screenshots load over the network now (they were inline data URIs before). If one 404s
   or fails, show a bordered placeholder naming the section instead of a broken-image icon. The
   hotspot dots are dropped too — they'd float over empty space. Styles are inlined so this stays
   within the guide's image rendering and touches no CSS. */
function guideImgFail(img){
  const shot = img.closest(".gd-shot");
  if (!shot || shot.classList.contains("gd-shot-failed")) return;
  shot.classList.add("gd-shot-failed");
  const title = img.getAttribute("data-sec-title") || "Screenshot";
  shot.innerHTML = '<div class="gd-shot-ph" role="img" aria-label="' + esc(title) + ' preview unavailable" ' +
    'style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;' +
    'aspect-ratio:1200/750;width:100%;padding:16px;box-sizing:border-box;text-align:center;' +
    'border:1px solid var(--hairline-strong);border-radius:8px;background:var(--surface-1);' +
    'color:var(--text-2);font:600 14px/1.4 Inter,sans-serif">' + esc(title) +
    '<span style="font:400 12px/1.4 Inter,sans-serif;color:var(--text-3)">Preview unavailable</span></div>';
}

/* ---------------- VOICE ---------------- */
let recog = null, recording = false;
function toggleMic(){
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btn = document.getElementById("micBtn");
  if (!SR){ toast("Voice dictation isn't supported in this browser."); return; }
  if (recording){ recog.stop(); return; }
  recog = new SR();
  recog.continuous = true; recog.interimResults = true; recog.lang = "en-US";
  const input = document.getElementById("input");
  const base = input.value;
  recog.onresult = e => {
    let txt = "";
    for (let i = 0; i < e.results.length; i++) txt += e.results[i][0].transcript;
    input.value = (base ? base + " " : "") + txt;
  };
  recog.onend = () => { recording = false; btn.classList.remove("rec"); };
  recog.onerror = () => { recording = false; btn.classList.remove("rec"); };
  recog.start(); recording = true; btn.classList.add("rec");
}

/* ---------------- LEGACY TEAM CHAT (kept only to migrate into Spaces) ---------------- */
let TEAMCHAT = [];
async function loadTeamChat(){ TEAMCHAT = (await sGet(okey("teamchat"))) || []; }

/* ---------------- EXPORT & BACKUP ---------------- */
function exportChat(){
  if (!brand()){ toast("Encode a brand first."); return; }
  const t = thread();
  if (!t.msgs.length){ toast("This chat is empty."); return; }
  let md = "# " + brand().name + " · " + t.name + "\n\nExported from SYN · " + new Date().toLocaleString() + "\n\n---\n\n";
  t.msgs.forEach(m => {
    if (m.mode === "image"){ md += "**Imagery request**\n\n```\n" + (m.text || "") + "\n```\n\n"; return; }
    md += "**" + (m.role === "user" ? (m.by || "Teammate") : "SYN") + ":**\n\n" + (m.displayText || m.text || "") + "\n\n";
    (m.files || []).forEach(f => { md += "*Generated file: " + f.name + "*\n\n"; });
    md += "---\n\n";
  });
  doDownload({ name: (brand().name + " - " + t.name).replace(/[^\w\- ]/g, "").trim() + ".md", content: md });
}
async function backupWorkspace(){
  for (const b of BRANDS) await loadChats(b.id);
  const data = {
    exportedAt: new Date().toISOString(), platform: "SYN v5", workspace: ORG ? ORG.name : "",
    teamChat: TEAMCHAT,
    team: TEAM.map(t => ({ name:t.name, email:t.email, role:t.role })),
    brands: BRANDS.map(b => ({ ...b, knowledge: b.knowledge.filter(k => !k.tooBig) })),
    chats: CHATS, approvals: APPROVALS, settings: SETTINGS
  };
  doDownload({ name: "SYN_Workspace_Backup.json", content: JSON.stringify(data, null, 2) });
}

/* =====================================================================
   WORKSPACE SUITE · STAGE 0 (foundation) + STAGE 1 (tasks / projects)
   All data org-scoped via okey(), persisted through sGet/sSet, cached,
   and refreshed on the same ~8s poll pattern as team chat.
   ===================================================================== */

/* ---------- global event bus ---------- */
const BUS = (() => {
  const map = {};
  return {
    on(evt, fn){ (map[evt] = map[evt] || []).push(fn); return () => { map[evt] = (map[evt] || []).filter(f => f !== fn); }; },
    emit(evt, payload){ (map[evt] || []).forEach(f => { try{ f(payload); }catch(err){ console.error("bus handler", evt, err); } }); }
  };
})();

/* ---------- org-scoped cached collections ---------- */
const COLL = {};                  // name -> { cache, shared }
const collDirty = new Set();
const collTimers = {};
function coll(name){ if (!COLL[name]) COLL[name] = { cache: null, shared: true }; return COLL[name]; }
async function collLoad(name){ const c = coll(name); if (c.cache) return c.cache; c.cache = (await sGet(okey(name))) || []; return c.cache; }
function collAll(name){ return coll(name).cache || []; }
function collSave(name){
  const c = coll(name);
  collDirty.add(name);
  clearTimeout(collTimers[name]);
  collTimers[name] = setTimeout(async () => {
    try{ await sSet(okey(name), c.cache || [], c.shared); }catch(e){ console.error("collSave", name, e); }
    collDirty.delete(name);
  }, 500);
}
function nowISO(){ return new Date().toISOString(); }

/* ---------- typed entity factory ---------- */
function entity(name, defaults){
  return {
    name,
    load(){ return collLoad(name); },
    list(filter){ const arr = collAll(name); return filter ? arr.filter(filter) : arr.slice(); },
    get(id){ return collAll(name).find(x => x.id === id) || null; },
    create(obj){
      const c = coll(name); c.cache = c.cache || [];
      const rec = Object.assign(defaults ? defaults() : {}, obj, {
        id: obj && obj.id ? obj.id : uid(name[0]),
        createdAt: obj && obj.createdAt ? obj.createdAt : nowISO(),
        updatedAt: nowISO(),
        createdBy: obj && obj.createdBy ? obj.createdBy : (currentUser ? currentUser.id : null),
        createdByName: obj && obj.createdByName ? obj.createdByName : (currentUser ? currentUser.name : "")
      });
      c.cache.push(rec);
      collSave(name);
      BUS.emit("change:" + name, { op:"create", rec });
      return rec;
    },
    update(id, patch){
      const rec = collAll(name).find(x => x.id === id);
      if (!rec) return null;
      Object.assign(rec, patch, { updatedAt: nowISO() });
      collSave(name);
      BUS.emit("change:" + name, { op:"update", rec });
      return rec;
    },
    remove(id){
      const c = coll(name);
      c.cache = (c.cache || []).filter(x => x.id !== id);
      collSave(name);
      BUS.emit("change:" + name, { op:"remove", id });
    }
  };
}

const Tasks    = entity("tasks", () => ({ title:"", description:"", status:"todo", assignees: currentUser ? [currentUser.id] : [], priority:"med", dueDate:null, startDate:null, labels:[], subtasks:[], attachments:[], comments:[], linkedBrandId:null, linkedChatId:null, projectId:null, visibility:"private", completedAt:null, followUpDate:null, followUpNote:"", followUpDone:false, order: Date.now() }));
const Projects = entity("projects", () => ({ name:"", color:"#8E959F", description:"" }));
const Events   = entity("events", () => ({ title:"", description:"", location:"", startDate:null, endDate:null, allDay:true, startTime:"09:00", endTime:"10:00", attendees:[], color:"#8E959F", taskId:null, projectId:null, recur:null, reminder:0, meetingLink:"", visibility:"team" }));
const Spaces   = entity("spaces", () => ({ name:"", icon:"◆", color:"#8E959F", description:"", type:"team", members:"all", archived:false }));
const DMs      = entity("dms", () => ({ members:[], lastAt:null }));
const Notifs   = entity("notifications", () => ({ forUserId:null, type:"", text:"", link:null, read:false }));
const Activity = entity("activity", () => ({ actorId:null, actorName:"", type:"", text:"", refType:null, refId:null }));
const Profiles = entity("profiles", () => ({ avatar:null, accent:null }));   // per-user, id = userId
const Assets   = entity("assets", () => ({ brandId:null, name:"", ext:"", size:0, content:"", dataUrl:null, folderId:null, visibility:"private", sharedWith:[] }));
const AFolders = entity("afolders", () => ({ brandId:null, name:"" }));
/* ---- Operations layer ---- */
const ACT_TYPES = [["call","Call"],["meeting","Meeting"],["email","Email"],["sample","Sample sent"],["application","Application submitted"],["note","Note"]];
// Operations activity model. Owner = createdBy. Private to owner by default; admins see all.
const Acts     = entity("acts", () => ({ type:"note", contactId:null, relatedName:"", companyName:"", date: todayISO(), duration:0, outcome:"", notes:"", followUpDate:null, followUpNote:"", followUpDone:false, taskId:null, visibility:"private" }));
const Contacts = entity("contacts", () => ({ name:"", company:"", email:"" }));
// Dependency: requester is waiting on owee to deliver `note`. requester is "owed to"; owee "owes".
const Deps     = entity("deps", () => ({ requesterId:null, requesterName:"", oweeId:null, oweeName:"", note:"", dueDate:null, status:"open", resolvedAt:null, taskId:null }));

const WS_KEYS = ["tasks","projects","events","spaces","dms","notifications","activity","profiles","assets","afolders","acts","contacts","deps"];

/* Operations privacy gates — enforced at the data-access layer (mirrors canSeeTask/canSeeAsset). */
function canSeeAct(a){ return isAdmin() || (currentUser && a.createdBy === currentUser.id); }
function canSeeDep(d){ const me = currentUser && currentUser.id; return isAdmin() || (me && (d.requesterId === me || d.oweeId === me)); }
function canSeeRecapOf(uid){ return isAdmin() || (currentUser && uid === currentUser.id); }
function myActs(f){ return Acts.list(a => canSeeAct(a) && (!f || f(a))); }
function myDeps(f){ return Deps.list(d => canSeeDep(d) && (!f || f(d))); }

/* Asset visibility gate — enforced at the data-access layer, mirroring canSeeTask/canSee.
   Every read of uploaded assets goes through this (never rendered-only). Admins see all;
   workspace is open; owner always sees their own; specific-people checks the sharedWith list;
   private is owner-only (default for new uploads). */
function canSeeAsset(a){
  if (isAdmin()) return true;
  const me = currentUser && currentUser.id;
  if (a.createdBy === me) return true;
  if (a.visibility === "workspace") return true;
  if (a.visibility === "specific") return !!(me && (a.sharedWith || []).includes(me));
  return false; // private
}
function canEditAsset(a){ return isAdmin() || (currentUser && a.createdBy === currentUser.id); }

/* ---------- per-org integrations config (admin-managed, shared) ---------- */
let INTS = {};
async function loadIntegrations(){ INTS = (await sGet(okey("integrations"))) || {}; }
function saveIntegrations(){ saveSoon(okey("integrations"), () => INTS); }
const INT_EVENTS = [["assigned","Task assigned"],["approval","Approval requested"],["event","Event created"],["mention","@mention"]];
/* webhook-firing integrations (keys + display names), derived from the catalog */
const INT_HOOKS = INT_CATALOG.filter(m => m.kind === "webhook").map(m => [m.key, m.name]);
/* Fire-and-forget browser POST (no-cors: request is really sent, response is opaque) */
function postWebhook(url, payload){ if (!url) return; try{ fetch(url, { method:"POST", mode:"no-cors", body: JSON.stringify(payload) }).catch(() => {}); }catch(e){} }
function fireIntegrations(eventType, text){
  INT_HOOKS.forEach(h => { const cfg = INTS[h[0]]; if (cfg && cfg.url && (!cfg.on || cfg.on[eventType] !== false)){
    postWebhook(cfg.url, { text: "[SYN · " + (ORG ? ORG.name : "") + "] " + text, event:eventType, workspace: ORG ? ORG.name : "", actor: currentUser ? currentUser.name : "", ts: nowISO(), source:"SYN Workspace" });
  }});
}
async function loadWorkspaceData(){ await Promise.all(WS_KEYS.map(k => collLoad(k))); }

/* ---------- notifications ---------- */
const N_ICON = { assigned:"◎", "task-due":"⏰", mention:"@", dm:"✉", approval:"✓", event:"◷", comment:"❝", system:"◈" };
/* per-user notification preferences (device-local); recipients hide muted types */
let NOTIF_PREFS = {};
async function loadPrefs(){ NOTIF_PREFS = (await sGet(okey("prefs:" + currentUser.id), false)) || {}; }
function savePrefs(){ saveSoon(okey("prefs:" + currentUser.id), () => NOTIF_PREFS, false); }
function notifAllowed(type){ return NOTIF_PREFS[type] !== false; }
function notify(forUserId, type, text, link){
  if (!forUserId) return null;
  const n = Notifs.create({ forUserId, type, text, link: link || null, read:false });
  const c = coll("notifications");                 // keep the org-wide notification log bounded
  if (c.cache && c.cache.length > 1000){ c.cache.splice(0, c.cache.length - 800); collSave("notifications"); }
  BUS.emit("notif:new", { forUserId });
  return n;
}
function myNotifs(){ return Notifs.list(n => n.forUserId === (currentUser && currentUser.id) && notifAllowed(n.type)).sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)); }
function renderBell(){
  if (!currentUser) return;
  const list = myNotifs();
  const unread = list.filter(n => !n.read).length;
  const badge = document.getElementById("bellBadge");
  if (badge){ badge.textContent = unread > 99 ? "99+" : unread; badge.classList.toggle("on", unread > 0); }
  const btn = document.getElementById("bellBtn"); if (btn) btn.classList.toggle("lit", unread > 0);
  const el = document.getElementById("notifList"); if (!el) return;
  if (!list.length){ el.innerHTML = '<div class="notif-empty">No notifications yet. Assignments, mentions, due-soon tasks, and approvals land here.</div>'; return; }
  el.innerHTML = list.slice(0, 40).map(n =>
    '<button class="notif-item' + (n.read ? "" : " unread") + '" data-wact="openNotif" data-nid="' + n.id + '">' +
    '<span class="notif-ico">' + (N_ICON[n.type] || "◈") + '</span>' +
    '<span class="notif-txt">' + esc(n.text) + '<div class="notif-time">' + esc(fmtTime(n.createdAt)) + '</div></span>' +
    (n.read ? "" : '<span class="notif-dot"></span>') + '</button>'
  ).join("");
}
function toggleBell(){ const p = document.getElementById("notifPanel"); if (!p) return; const open = !p.classList.contains("open"); p.classList.toggle("open", open); if (open) renderBell(); }
function closeBell(){ const p = document.getElementById("notifPanel"); if (p) p.classList.remove("open"); }
function markAllRead(){
  let changed = false;
  collAll("notifications").forEach(n => { if (n.forUserId === currentUser.id && !n.read){ n.read = true; changed = true; } });
  if (changed){ collSave("notifications"); BUS.emit("change:notifications", {}); }
  renderBell();
}
function openNotification(id){
  const n = Notifs.get(id); if (!n) return;
  if (!n.read) Notifs.update(id, { read:true });
  closeBell();
  const link = n.link || {};
  if (link.view === "tasks"){ setView("tasks"); if (link.taskId && Tasks.get(link.taskId)) openTaskModal(link.taskId); }
  else if (link.view === "calendar"){ setView("calendar"); if (link.eventId && Events.get(link.eventId)) openEventModal(link.eventId); }
  else if (link.view === "spaces"){ setView("spaces"); if (link.space && Spaces.get(link.space)) openThread("space", link.space); else if (link.dm && DMs.get(link.dm)) openThread("dm", link.dm); }
  else if (link.view){ setView(link.view); }
  renderBell();
}

/* ---------- activity feed ---------- */
function logActivity(type, text, refType, refId){
  Activity.create({ actorId: currentUser ? currentUser.id : null, actorName: currentUser ? currentUser.name : "", type, text, refType: refType || null, refId: refId || null });
  const c = coll("activity");
  if (c.cache && c.cache.length > 300){ c.cache.splice(0, c.cache.length - 300); collSave("activity"); }
}
function recentActivity(n){ return Activity.list().sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, n || 40); }

/* ---------- due-soon scan (per-client, deduped) ---------- */
function checkDueSoon(){
  if (!currentUser || !notifAllowed("task-due")) return;
  const now = Date.now(), soon = now + 48 * 3600 * 1000;
  Tasks.list(t => t.status !== "done" && t.dueDate && (t.assignees || []).includes(currentUser.id)).forEach(t => {
    const due = new Date(t.dueDate + "T23:59:59").getTime();
    const overdue = due < now;
    if (!overdue && due > soon) return;
    const type = overdue ? "task-overdue" : "task-due";
    const exists = Notifs.list(x => x.forUserId === currentUser.id && x.type === type && x.link && x.link.taskId === t.id).length;
    if (!exists) notify(currentUser.id, type, (overdue ? "Overdue: " : "Due soon: ") + t.title, { view:"tasks", taskId:t.id });
  });
}

/* ---------- workspace sync poll ----------
   Background refetch of shared state from SYN Core so changes from other users (new tasks,
   messages, and members joining) appear without a manual refresh. Polls ~12s while visible and
   backs off to ~60s while the tab is hidden, and refetches immediately on focus / visibilitychange.
   Unsaved local edits are never clobbered: dirty collections and a pending team write are skipped. */
let wsPollTimer = null, wsHiddenTimer = null, wsPollWired = false, wsLastSync = 0;
const WS_POLL_MS = 12000, WS_HIDDEN_MS = 60000;
function collSig(arr){ let mx = ""; for (const x of arr){ if (x.updatedAt > mx) mx = x.updatedAt; } return arr.length + "|" + mx; }
function teamSig(arr){ return (arr || []).map(u => u.id + ":" + u.name + ":" + u.role).sort().join(","); }
async function wsSyncOnce(){
  if (!ORG) return;
  pulseSync("start");
  let applied = false;
  for (const name of WS_KEYS){
    if (collDirty.has(name)) continue;                   // don't clobber unsaved local edits
    const fresh = (await sGet(okey(name))) || [];
    const c = coll(name);
    if (collSig(fresh) !== collSig(c.cache || [])){
      c.cache = fresh; applied = true;
      BUS.emit("change:" + name, { op:"sync" });
    }
  }
  // Team roster (a member joining / leaving) lives under its own key, not a collection.
  if (!savePending[okey("team")]){                       // skip if this user has an unsaved team edit in flight
    const freshTeam = await sGet(okey("team"));
    if (Array.isArray(freshTeam) && teamSig(freshTeam) !== teamSig(TEAM)){
      TEAM = freshTeam; applied = true;
      if (typeof renderSpaceRail === "function") renderSpaceRail();
      if (viewIs("people") && typeof renderPeople === "function") renderPeople();
      if (viewIs("settings") && typeof renderSettings === "function") renderSettings();
    }
  }
  checkDueSoon();
  renderBell();
  wsLastSync = Date.now();
  pulseSync(applied ? "hit" : "ok");
}
/* Nudge the SYNCED indicator so the user can see the poll working. */
function pulseSync(phase){
  const pill = document.getElementById("storagePill");
  if (!pill) return;
  if (phase === "start"){ pill.classList.add("syncing"); return; }
  pill.classList.remove("syncing");
  if (phase === "hit"){ pill.classList.add("sync-hit"); setTimeout(() => pill.classList.remove("sync-hit"), 900); }
  if (wsLastSync) pill.title = pill.title.replace(/ · Last synced.*/, "") + " · Last synced just now";
}
function startWorkspacePoll(){
  clearInterval(wsPollTimer); clearInterval(wsHiddenTimer);
  wsPollTimer   = setInterval(() => { if (ORG && !document.hidden) wsSyncOnce(); }, WS_POLL_MS);
  wsHiddenTimer = setInterval(() => { if (ORG && document.hidden)  wsSyncOnce(); }, WS_HIDDEN_MS);
  if (!wsPollWired){
    wsPollWired = true;
    window.addEventListener("focus", () => { if (ORG) wsSyncOnce(); });                       // immediate refetch on focus
    document.addEventListener("visibilitychange", () => { if (ORG && !document.hidden) wsSyncOnce(); });
  }
}

/* ---------- shared helpers ---------- */
function teamById(id){ return TEAM.find(t => t.id === id) || null; }
function teamName(id){ const u = teamById(id); return u ? u.name : ""; }
function initials(name){ return (name || "?").split(" ").map(w => w[0]).join("").slice(0,2).toUpperCase(); }
function avatarPhoto(id){ const p = Profiles.get(id); return p && p.avatar ? p.avatar : null; }
function myAccent(){ const p = currentUser && Profiles.get(currentUser.id); return p && p.accent ? p.accent : null; }
function avatarHtml(id, cls){
  const u = teamById(id); const nm = u ? u.name : "?"; const ph = avatarPhoto(id);
  if (ph) return '<span class="t-av ' + (cls || "") + '" title="' + esc(nm) + '" style="background:none;padding:0;overflow:hidden"><img src="' + esc(ph) + '" alt="" style="width:100%;height:100%;object-fit:cover;display:block"></span>';
  return '<span class="t-av ' + (cls || "") + '" title="' + esc(nm) + '">' + esc(initials(nm)) + '</span>';
}
/* big .avatar circle with photo-or-initials (sidebar, people, messages, settings) */
function avatarBig(id, extraStyle){
  const u = teamById(id); const nm = u ? u.name : (currentUser && id === currentUser.id ? currentUser.name : "?"); const ph = avatarPhoto(id);
  const st = extraStyle ? (';' + extraStyle) : '';
  if (ph) return '<div class="avatar" style="background:none;padding:0;overflow:hidden' + st + '"><img src="' + esc(ph) + '" alt="' + esc(nm) + '" style="width:100%;height:100%;object-fit:cover;display:block"></div>';
  return '<div class="avatar" style="' + (extraStyle || '') + '">' + esc(initials(nm)) + '</div>';
}
function refreshMyAvatar(){
  const el = document.getElementById("uAvatar"); if (!el || !currentUser) return;
  const ph = avatarPhoto(currentUser.id);
  if (ph){ el.style.background = "none"; el.style.padding = "0"; el.style.overflow = "hidden"; el.innerHTML = '<img src="' + esc(ph) + '" alt="" style="width:100%;height:100%;object-fit:cover;display:block">'; }
  else { el.style.background = ""; el.style.overflow = ""; el.textContent = initials(currentUser.name); }
}
/* personal accent themes ONLY the current user's own My Day + Portfolio screens */
function applyPersonalAccent(){
  const acc = myAccent();
  ["view-myday","view-dashboard"].forEach(id => { const el = document.getElementById(id); if (!el) return;
    if (acc){ el.style.setProperty("--accent", acc); el.style.setProperty("--accent-soft", hexToSoft(acc)); }
    else { el.style.removeProperty("--accent"); el.style.removeProperty("--accent-soft"); }
  });
}
function saveMyProfile(patch){
  if (Profiles.get(currentUser.id)) Profiles.update(currentUser.id, patch);
  else Profiles.create(Object.assign({ id: currentUser.id, avatar:null, accent:null }, patch));
}
/* downscale + compress an uploaded image to a small base64 JPEG for storage */
function compressImage(file, maxPx, cb){
  const r = new FileReader();
  r.onload = () => { const img = new Image(); img.onload = () => {
      const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
      const c = document.createElement("canvas"); c.width = w; c.height = h;
      try{ c.getContext("2d").drawImage(img, 0, 0, w, h); cb(c.toDataURL("image/jpeg", 0.82)); }catch(e){ cb(null); }
    }; img.onerror = () => cb(null); img.src = r.result;
  };
  r.onerror = () => cb(null); r.readAsDataURL(file);
}
function viewIs(v){ const el = document.getElementById("view-" + v); return el && el.classList.contains("active"); }

