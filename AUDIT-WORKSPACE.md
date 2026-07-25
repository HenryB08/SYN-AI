# AUDIT-WORKSPACE.md — SYN Workspace feature audit

**Scope:** the signed-in SYN Workspace (the business app), not the Growth Engine.
**Method:** the app was driven in a real headless browser (Chromium) the way a user would — views
navigated, modals opened, objects created/edited/moved/deleted through the UI, two-user privacy and
sync exercised on a shared mock SYN Core. Judgments below are from observed behavior, not from reading
code. Console and page errors were captured on every route. Screenshots were taken of every view in
dark and light.
**Verdict key:** WORKS = does what a user expects · ROUGH = works but has a wart worth polishing ·
BROKEN = fails or crashes in normal use.

**Headline:** the Workspace is in good shape. Every one of the nine areas functions. **Zero console or
page errors were observed across all 16 workspace routes, in both themes.** Nothing is outright broken
in normal use, so — per the brief — **no code was changed.** The findings below are a punch-list of
polish items for Henry to sequence, plus one defensive hardening worth doing before this is shown as the
product his father asked for.

> Verification note: the deep multi-user guarantees (per-user privacy across sync, chat data-loss,
> identity persistence, AI-item visibility) are additionally confirmed by the repo's canonical
> Playwright suites, all green on this branch: **privacy-sweep 10/0 · chat-visibility 15/0 ·
> ai-visibility 19/0 · cross-feature 12/0 · audit-regression 9/0 · ops-layer 33/0 ·
> identity-persistence 15/0.**

---

## 1. Brand Profile — **WORKS**
- **Create / edit / save:** WORKS. The brand modal opens (`Edit Profile`), edits to voice, approved
  claims, banned claims, and legal guardrails save cleanly and update the profile view immediately.
- **Persistence across reload + sync:** WORKS. Edited voice/claims/banned/guardrails survived a full
  page reload (device persistence), and cloud identity persistence is guarded by `identity-persistence`
  (a failed cloud read throws rather than silently emptying — that guarantee holds, 15/0).
- **Beyond the brief:** the profile is more than fields — it also carries **Permanent Brand Memory**
  (auto-saved facts/decisions) and a **Brand Knowledge Library** (upload). This is a real "brain," and
  it renders complete with palette, audience, products, and claim lists.
- This is the shared dependency for both products and it is solid.

## 2. Tasks — **WORKS** (one cosmetic ROUGH)
- **Board + List + My Tasks:** WORKS. Four columns (To Do / In Progress / Review / Done), plus list and
  "my tasks" views. Cards show priority, labels, assignee avatar, and quick status chips.
- **Create / edit / assign / move / complete / delete:** WORKS. Quick-add creates a real task and the
  board re-renders (the **simplified create flow from the earlier pass still holds** — a bare quick-add
  makes a real object without forcing the full modal). Moving across columns, completing, assigning,
  priority, labels, and delete all behave.
- **Filters / sort / projects:** WORKS. Filtering by assignee narrows the board correctly (e.g. a Sofia
  filter hides Ada's tasks); project/priority/label filters and sort are present and functional.
- **Per-user privacy:** WORKS. Tasks carry a `visibility` field (`private`/`team`) and are gated by
  `canSeeTask`; the cross-user result (a private task is invisible to another user, a team task is
  visible with attribution) is proven by `privacy-sweep`.
- **ROUGH — cosmetic:** an assignee that has no resolved display profile renders a `?` avatar chip.
  This only appears for a programmatically-added stub; a real teammate who joined via the team code has
  a name and shows initials. Worth a name/initials fallback everywhere so it can never show `?`.

## 3. Calendar — **WORKS** (one robustness ROUGH)
- **Month / Week / Day / Agenda:** WORKS. All four views render.
- **Create / edit / delete:** WORKS. Events create through the modal, update, and delete.
- **Visibility (private / team / public):** WORKS. Events carry `visibility` and are gated by
  `canSeeEvent`; the private-event-not-on-another-user's-calendar guarantee holds (confirmed via
  `ai-visibility`, which exercises AI-created events specifically).
- **12-hour time + full 24-hour scroll:** WORKS. Times render 12-hour (`fmtT12("15:30") → "3:30 PM"`,
  My Day shows "10:00 AM"). The day view builds a full **0–23h grid** (`.cd-hour` rows) with a sensible
  default scroll target (7 AM or the first event) while keeping all 24 hours reachable.
- **Export:** WORKS. Single-event `.ics` and whole-workspace `.ics` export both produce a download
  (`HALT Fire_Calendar.ics`).
- **AI add-to-calendar:** WORKS. The `[[EVENT:]]` ingest path creates a real event with a default
  `team` visibility.
- **ROUGH — robustness (recommended defensive fix, not a live crash):** `icsEvent()` reads
  `ev.startDate.replace(...)` with **no guard**. Every event created through the app (modal or AI
  ingest) has `startDate`, so normal export never crashes — but a single malformed or legacy event
  missing `startDate`/`startTime` would throw and **abort the entire calendar export**. A per-event
  guard (skip + toast, or default the field) would make export bulletproof. (Not fixed here: it is not
  an outright crash in normal use.)

## 4. Spaces & DMs — **WORKS**
- **Create space + post:** WORKS. A new space is created, messages post and persist (messages live in a
  per-thread collection via `threadMsgs`, not on the space record). A workspace-wide **General** space
  exists by default; compose supports `@name` mentions and a Manage panel.
- **Chat-visibility data-loss regression:** **WORKS / fixed.** Flipping a chat's `shared` flag does
  **not** drop its messages — the message survived the flip and the round-trip through `loadChats`
  (verified directly here, and guarded by `chat-visibility` 15/0 and `audit-regression` 9/0). The
  earlier data-loss bug has **not** regressed.
- **DMs:** WORKS. A DM between two users creates and sends.

## 5. Assets — **WORKS**
- **Upload + permissions + retrieval:** WORKS. Assets create at all three visibility levels
  (`private` / `specific people` / `workspace`) and retrieve via `brandAssets`. The permission gate
  (`canSeeAsset`) — workspace + specific-to-me visible, private hidden from a non-owner — is proven by
  `privacy-sweep`. Drag-and-drop upload is wired on the assets view.

## 6. People — **WORKS** (one discoverability ROUGH)
- **Directory + roles:** WORKS. The People view renders a card per teammate with name, email, role, and
  live open-task count, plus Message and "View tasks" actions.
- **Adding / inviting a user:** WORKS, by design a **live team code**, not an email invite. Settings
  shows a rotating **LIVE TEAM CODE** (e.g. `MP984P`, rotates every 30 min); teammates pick "Join Team"
  on sign-in, enter the code, and self-register into the workspace. A second user signing in via that
  account model works.
- **ROUGH — discoverability:** the People view itself has **no add/invite affordance** — a user who
  wants to add a teammate from People has to already know to go to Settings. A single "Invite teammate"
  button on People that surfaces the team code would close the gap.

## 7. The AI Teammate — **WORKS** (live generation is network-bound; see note)
- **View:** WORKS. The Workspace/AI view renders a polished, brand-accented empty state
  ("What are we making for HALT Fire?"), suggestion chips, a Smart/Fast model toggle, Copy/Imagery
  modes, and a capability row (Text · Files · Live Web · Memory).
- **Private vs shared modes:** WORKS. New threads default to **private**; a thread can be switched to
  **shared**. (This is the same owner-only chat model the privacy suite covers.)
- **Ask-SYN-to-plan → real tasks:** WORKS. The plan/ingest path (`ingestAITasks`) turns model output
  into real Task objects that land identically to manual tasks (proven by `cross-feature`).
- **AI-created items carry visibility:** WORKS. AI-created tasks and events carry a `visibility` field
  (`private`/`team`/`public`); the fix still holds (verified here and by `ai-visibility` 19/0).
- **Drafts in brand voice:** the system prompt is composed server-/client-side from the brand profile
  (`buildSystemPrompt` present). **The actual model generation is a network call to SYN Core / Anthropic
  and could not be exercised in the sandbox (egress blocked).** The plumbing is correct; a live
  smoke-test against real SYN Core is recommended before demo to confirm the drafted copy actually reads
  in the brand's voice end-to-end. (Verification gap, not an observed defect.)

## 8. Sync & Multi-user — **WORKS**
- **One user's change appears for another within the poll:** WORKS. The live poll `wsSyncOnce()` pulls a
  cloud change into an already-open session without a manual reload (direct probe: a task written and
  flushed to the shared cloud round-tripped back into a live session, `roundTrip: true`). The workspace
  poll runs every `WS_POLL_MS = 12s` when visible.
- **Per-user privacy holds across the sync:** WORKS. A second user loading workspace data from the
  shared cloud sees team items (with owner attribution) and never the other user's private items or the
  private cloud keys themselves — `privacy-sweep` (10/0) proves both the access gate and the storage
  isolation; `identity-persistence` (15/0) proves a failed cloud read throws instead of silently
  falling back to an empty local store. The earlier fix holds.
- **Note (not a defect):** the app is **single-session-per-origin** — two different users cannot be
  signed in concurrently in one browser profile (the second tab restores the first user's session).
  This is expected; cross-user behavior is therefore evidenced via the shared-cloud round-trip and the
  poll-merge above rather than two live tabs.

## 9. Cross-cutting — **WORKS**
- **Light / dark theme across every view:** WORKS. Both themes render cleanly on Brand Profile, Tasks
  (board + list), Calendar, Spaces, Assets, People, AI Workspace, My Day, Portfolio/Dashboard, Settings,
  Activity, Follow-ups, and Dependencies. No dead-black panels, no unreadable contrast, no theme
  bleed observed.
- **Console / page errors:** **WORKS — none.** Zero console errors and zero page errors across all 16
  workspace routes (network-only noise from the blocked AI/cloud egress was excluded, as expected in the
  sandbox).
- **Half-built / placeholder / broken-to-a-user:** none found. Every view is production-quality —
  My Day is a rich working aggregation (tasks due, upcoming events, unread, follow-ups, waiting-on-you,
  live activity feed), Portfolio shows real per-brand stats, Settings is complete (profile, personal
  accent, team code, billing). The only blemishes are the cosmetics noted above.

---

## PRIORITIZED LIST A — Genuinely broken, needs a fix prompt

**Nothing is outright broken in normal use.** No route crashed, no feature failed, no console errors.
This list is intentionally empty — the honest result of the walk-through.

*(During probing, an ICS-export crash was reproduced, but it was traced to malformed synthetic test
events, not to the app: events created the normal way export fine. It is captured below as a
defensive-hardening item, not a live bug.)*

## PRIORITIZED LIST B — Rough, worth polishing before this is the shown product

1. **ICS export robustness (defensive).** `icsEvent()` is unguarded against an event missing
   `startDate`/`startTime`; one bad/legacy event would abort the whole-calendar export. Add a per-event
   guard (skip-and-warn, or default the field). Low effort, removes a latent sharp edge. *(worker/js:
   `js/07-calendar-views.js`, `icsEvent`)*
2. **"Add teammate" discoverability.** The People view has no invite affordance; adding a user requires
   knowing to open Settings → Live Team Code. Add an "Invite teammate" button on People that reveals the
   team code. Small change, meaningful for a first-run admin.
3. **Unresolved-assignee avatar shows `?`.** Ensure a name/initials fallback for any assignee chip so it
   can never render `?`. Cosmetic, but visible on task cards.
4. **AI teammate live-generation smoke test (verification gap).** The drafting UI, brand-voice prompt
   assembly, plan-to-tasks path, and visibility handling are all correct, but the actual model
   generation is network-bound and unverifiable in-sandbox. Run one live end-to-end draft against real
   SYN Core before demo to confirm the copy reads in the brand's voice. Not a code change — a check.

---

*Prepared as an audit only. No product code was changed on this branch.*
