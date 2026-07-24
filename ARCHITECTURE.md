# ARCHITECTURE.md — SYN data flow

How data actually moves through SYN: sign-in, where state lives, what triggers a
cloud write, how the sync poll works, how per-user privacy is enforced, and how
an AI request travels from the app to the Worker to Anthropic and back. Read
this **before** changing persistence, sync, or privacy — those three are where
an innocent-looking edit silently breaks a live workspace.

All line numbers refer to `index.html` and are approximate landmarks; grep the
named function to confirm.

---

## 1. The two surfaces and the two Workers

```
                          ┌─────────────────────────────────────────────┐
   Browser (index.html)   │  static page served by GitHub Pages          │
   ┌──────────────┐       │  Cloudflare CDN in front                     │
   │  #site        │──────┼──▶  syn-assistant Worker  ──▶ Anthropic       │
   │ (marketing)   │      │     (marketing chat only; prompt baked in)    │
   ├──────────────┤       │                                               │
   │  #app         │──────┼──▶  SYN Core Worker  ──┬──▶ D1  (KV storage)   │
   │ (workspace)   │      │  (SYN_CORE_URL)        └──▶ Anthropic          │
   └──────────────┘       │                          (/v1/messages proxy) │
                          └─────────────────────────────────────────────┘
```

- **SYN Core** (`SYN_CORE_URL = https://syn-core.henrybello.workers.dev`,
  line 2745) is both the **storage backend** (D1-backed KV) and the **Anthropic
  proxy** for the signed-in app. `apiBase()` (2746) returns `SYN_CORE_URL` when
  set, so `apiBase()+"/v1/messages"` reaches Anthropic through the Worker — the
  browser never holds an Anthropic key.
- **syn-assistant** (`SYN_ASSISTANT_URL =
  https://syn-assistant.henrybello.workers.dev`, line 3221;
  `worker/syn-assistant.js`) serves only the public marketing assistant, with
  the system prompt baked into the Worker.

---

## 2. Sign-in and boot

Entry: `boot()` (line 3312). Roughly:

1. `boot()` calls `cloudOk = await cloudHealth()` (3314). `cloudHealth()`
   (2792) probes SYN Core; on success **`cloudOk = true`** and all *shared*
   reads/writes go through the cloud. If the probe fails, the app degrades to a
   local `persistMode` (`shared` preview → `device` localStorage → `memory`).
2. The signed-out visitor sees `#site` (marketing). Sign In / Get Started call
   `siteAuth(mode)` (3209) → `hideSite()` → `showAuth(mode)` (auth screen).
3. On submit, auth resolves the **workspace (ORG)** and the **current user**.
   Identity/registry reads use `sGetStrict()` (2845) — when the cloud is live it
   **must** come from the cloud and **throws on failure** rather than fabricating
   an empty registry (a past bug made existing users re-onboard into a fresh
   workspace). Workspace join codes rotate every 30 min (banner at 3371).
4. Once `ORG` and `currentUser` are set, the app boots into `#app` and loads
   collections (tasks, events, spaces, assets, …) from storage.

State lives in module-level globals set at boot: **`ORG`** (the workspace),
**`currentUser`**, **`TEAM`**, **`BRANDS`**, plus per-collection caches. There is
no framework store — these globals *are* the state.

---

## 3. Where state lives: the storage adapter

Section `STORAGE ADAPTER` (line 2750). Every read/write goes through a small
adapter that picks a backend by `persistMode` / `cloudOk`:

```
sGet(key, shared=true)          sSet(key, val, shared=true)
  if shared && cloudOk:           mem[key] = val            // in-memory safety net
    cloudGet(key)  ──▶ SYN Core   if shared && cloudOk:
    (falls through on a blip)       cloudWrite(key, str) ──▶ SYN Core
  else window.storage (preview)   else window.storage (preview)
  else localStorage (device)      else localStorage (device)
  else mem[key]                   else mem[key]
```

- **Cloud tier** (`cloudGet`/`cloudPut`/`cloudWrite`, from 2760): `GET`/`PUT
  /kv/<key>` against SYN Core (D1). `cloudGet` retries transient failures 3× so
  a blip never surfaces as "empty". `cloudWrite` **serializes writes per key**
  (`cloudChain`) so rapid PUTs to the same key can't land out of order.
- **Keys are workspace-scoped** via `okey(sub)` (2993):
  `"syn5:" + ORG.id + ":" + sub`. Every collection and settings blob is filed
  under its workspace, so two workspaces never collide.
- **Read authority:** `sGetStrict()` throws on cloud failure for
  identity/registry keys (never silently empty). Ordinary `sGet` falls through
  to local on a blip so day-to-day reads never hard-fail.

---

## 4. What triggers a cloud write

Two write paths, both **debounced**, both **flushed on hide**:

1. **`saveSoon(key, getVal, shared)`** (2866) — blob writes (brands, team,
   settings, approvals, chats, prefs). Debounced **600 ms**; the pending value
   is stored in `savePending[key]` so it can be flushed.
2. **Collection writes** — `collSave(name)` marks a collection dirty; a debounce
   (~500 ms) then persists `okey(name)`. Collections: tasks, projects, events,
   spaces, dms, notifications, assets, folders, activities.

**Critical: `flushPendingWrites()`** (2880) fires on `visibilitychange`
(hidden) and `pagehide` (2894–2895), flushing **both** the `savePending` blob
writes **and** every dirty collection immediately. This exists because a
create/edit made moments before a quick reload or tab close could otherwise be
dropped inside the 500–600 ms debounce window (guarded by
`tests/audit-regression.mjs`). **Do not remove the flush-on-hide.**

A manual action mutates a global, marks it dirty/`saveSoon`, and re-renders.
The write to SYN Core happens on the debounce or the next flush — **no AI call
is involved** (see §7).

---

## 5. The sync poll (multi-user freshness)

Section `workspace sync poll` (6290). Because two teammates edit the same
workspace, each session polls SYN Core for others' changes:

- `WS_POLL_MS = 12000` (12 s) while the tab is **visible**;
  `WS_HIDDEN_MS = 60000` (60 s) while **hidden** (6296).
- `wsSyncOnce()` (6299) refetches shared collections from the cloud and merges;
  it also runs immediately on focus / `visibilitychange` so returning to the tab
  is instantly fresh.
- A "SYNCED" indicator is nudged on each poll so the user can see it working.

```
tab visible ──every 12s──▶ wsSyncOnce() ──cloudGet(okey(coll))──▶ SYN Core/D1
tab hidden  ──every 60s──▶ wsSyncOnce()
focus/visibility change ──immediately──▶ wsSyncOnce()
```

Changing these intervals trades perceived freshness against request volume
(and therefore cost).

---

## 6. How per-user privacy is enforced

Privacy is enforced **twice**: at the **access layer** (what the UI surfaces)
and at the **storage layer** (which keys a session even fetches). Both are
required — `tests/privacy-sweep.mjs` checks ACCESS *and* STORAGE for each data
type.

- **Chats:** private chats are filed under a **per-user key**
  `privChatKey(brandId)` = `okey(userId + ":chats:" + brandId)` (3001); shared
  chats under `sharedChatKey(brandId)` (3002). A non-owner's session never
  fetches another user's private-chat key — privacy by **key isolation**, not
  just a UI filter. `tests/chat-visibility.mjs` guards that re-keying a chat
  (private↔shared) never orphans or deletes it for the other user.
- **Generic collections:** `canSee(c)` (3570) = `c.shared || c.ownerId ===
  currentUser.id`.
- **Tasks:** `canSeeTask(t)` (6422) = admin, **or** `visibility === "team"`,
  **or** the current user is an assignee or the creator.
- **Events:** `canSeeEvent(ev)` (6981) = `visibility !== "private"` **or** the
  current user created it.
- **AI-created items respect the same rules:** `normVisibility(s, dflt)` (6892)
  maps the model's natural-language visibility ("just me", "the whole team") to
  the app's real `private`/`team` values, and the created task/event then flows
  through the same `canSee*` checks. `tests/ai-visibility.mjs` verifies an
  AI-made "private to just me" event is invisible to other users.

**When adding a data type, wire both layers:** give it an owner/visibility
field, add a `canSee*` check for the UI, and file private records under a
per-user `okey(...)` so a non-owner's session never even requests them.

---

## 7. How an AI request travels

Every AI-consuming feature (6 call sites: thread send 4183, activity braindump
4716, brand research 5587, plan-a-task 6943, event ingestion 7563, space send
7888) follows one path:

```
user triggers an AI action
        │
        ▼
gateAI(capKind, callType)  ── line 5298 ────────────────────────────┐
   1. per-user DAILY hard cap (AI_DAILY_CAPS, real cost firewall)    │ if capped:
   2. pooled monthly soft throttle (smart ▶ downgraded to fast;      │ return {ok:false,
      legacy workspaces exempt)                                      │ capped:true, reason}
   3. record daily + monthly (recordAI) + cost (recordCost)          │ → toast, no API call
        │ ok                                                          │
        ▼                                                            ─┘
build request:
   model = MODELS[smart|fast]        // sonnet-4-6 / haiku-4-5  (line 2916)
   system = stable cacheable prefix  // cache_control:{type:"ephemeral"} (3758)
   messages = history.slice(-HISTORY_WINDOW)   // 10 for chat / 12 for spaces
        │
        ▼
fetch(apiBase() + "/v1/messages")  ──▶  SYN Core Worker  ──▶  api.anthropic.com
        │                                (adds ANTHROPIC_API_KEY server-side)
        ▼
response streams / returns  ──▶  parsed into the app
   (task/event ingestion parses [[TASK: …]] / [[EVENT: …]] markers,
    normVisibility() applies, items created via the entity factory)
        │
        ▼
new entities persist via the normal debounced write path (§4)
```

Key guarantees:

- **The browser never holds an Anthropic key** — SYN Core injects it. The
  marketing assistant does the same via syn-assistant.
- **Prompt caching:** the system prompt's stable prefix (identity + guardrails +
  brand profile + protocols) is sent with `cache_control:{type:"ephemeral"}`, so
  repeated calls reuse the cached prefix instead of re-billing it.
- **History is windowed** (last 10 / 12 messages, image turns filtered) so
  context — and cost — stays bounded.
- **Manual actions never enter this path.** Creating a task, adding a calendar
  entry, or sending a human-to-human message mutates state and persists via §4
  — it never calls `gateAI` and never hits `/v1/messages`.
  `tests/cost-control.mjs` wraps `fetch`, counts `/v1/messages`, and asserts a
  full manual workflow = **0** API calls.

---

## 8. Invariants a change must not break

1. **Flush-on-hide** (`flushPendingWrites` on `visibilitychange`/`pagehide`) —
   removing it reintroduces silent data loss.
2. **`sGetStrict` throws on cloud failure** for identity/registry — never
   fabricate an empty registry (causes existing users to re-onboard).
3. **Private records live under per-user keys** — a non-owner's session must not
   fetch them; a UI filter alone is not privacy.
4. **`gateAI` is the only door to Anthropic** — every AI call goes through the
   cap/throttle/record gate; manual actions go through none of it.
5. **Workspace scoping via `okey`** — every shared key is namespaced by
   `ORG.id`; never write an unscoped shared key.

The Growth Engine (`syn-growth`, a separate Worker) will **bind the same D1**.
That makes the `okey` key conventions and the KV value shapes above a **shared
contract** between two codebases — change them deliberately, not incidentally.
