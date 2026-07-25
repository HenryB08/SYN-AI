# syn-growth — Backup & Restore

The Growth Engine's D1 database holds real client leads, consent records, conversations, and the
append-only events the Receipt and the value guarantee are computed from. **A backup nobody has ever
restored is not a backup.** This repo ships a *tested* restore: the round-trip drill in
`worker/syn-growth.test.mjs` seeds a database, exports it, wipes it, restores it, and asserts the
result is byte-for-byte identical (see [The drill](#the-drill)).

Two layers protect this data. Use both.

---

## 1. Cloudflare native: D1 Time Travel — useful, NOT sufficient alone

D1 has **Time Travel**: automatic point-in-time recovery. Every D1 database can be restored to any
moment in roughly **the last 30 days** using a timestamp or a "bookmark," with no configuration and no
scheduled job on your side. It is the right first tool for the common disaster: a bad migration or an
accidental `DELETE`/`DROP` you notice quickly.

```sh
# See restore points, then restore in place (Cloudflare-side, ~last 30 days):
npx wrangler d1 time-travel info    <DB_NAME>
npx wrangler d1 time-travel restore <DB_NAME> --timestamp='2026-07-24T12:00:00Z'
```

**Honest assessment — why it is not enough on its own:**

| Gap | Consequence |
|---|---|
| **~30-day window** | Anything older than the window is unrecoverable. Corruption discovered late (a slow data-quality bug) is past saving. |
| **Same platform / same account** | Time Travel lives *inside* Cloudflare, tied to this account. It does **not** survive an account-level accident: account suspension/billing lockout, a compromised account, or an operator deleting the **database or the account** itself. |
| **No portable copy** | It restores in place; you never hold a file you control. You cannot hand the data to auditors, migrate off Cloudflare, or diff two points yourself. |

So Time Travel is layer one. **`GET /admin/backup` is layer two: a portable snapshot you store OFF
Cloudflare, so a Cloudflare-side accident is survivable.** Neither replaces the other.

---

## 2. The off-platform snapshot (this Worker)

### `GET /admin/backup` — export
Admin-authed. Returns a complete, self-describing JSON snapshot of **every growth table**
(`tenants, brands, installs, contacts, conversations, messages, events, followups, job_values,
receipts, consent_events, usage_events, error_events`), **streamed** (paged per table) so a large
database never has to be held in Worker memory. It deliberately **excludes** `kv` (syn-core's workspace
blobs — backed up separately) and `growth_rl` (throwaway rate-limit state).

Shape:
```json
{ "format": "syn-growth-backup", "schema_version": 1, "created_at": "…ISO…",
  "counts": { "tenants": 2, "events": 8, … },
  "tables": { "tenants": [ …rows… ], "events": [ …rows… ], … } }
```
Rows are emitted in insertion (rowid) order, so append-only tables round-trip identically.

### `POST /admin/restore` — restore
Admin-authed and deliberately hard to fire by accident:
- **Refuses without the confirmation token** — body must be `{ "confirm": "RESTORE-SYN-GROWTH", "snapshot": {…} }`.
- **Refuses a schema-version mismatch** (`409`) rather than loading a snapshot shaped for different code.
- **Refuses a corrupt snapshot** whose declared `counts` disagree with its rows (`400`).
- **Restores in one atomic D1 `batch()`** (wipe every table, then reload) — a mid-restore failure rolls
  back; you never get a half-rebuilt database.
- **Reports rows expected vs written per table** and returns `500` if any disagree.

---

## 3. Operational procedure

**Cadence — pull a snapshot on this schedule (in addition to Time Travel):**
- **Daily** automated `GET /admin/backup` to off-Cloudflare storage. Keep **30 daily**, **12 monthly**.
- **Always before a schema change or a risky migration.** Take one by hand first.
- Verify at least monthly that a snapshot actually restores (see the drill — it runs in CI on every push).

**Where to store it — OFF Cloudflare, on purpose.** The whole point of layer two is surviving a
Cloudflare-side accident, so **do not** store snapshots in R2/KV/D1 or anything in the same Cloudflare
account. Put them in a *different* provider/account: an S3/GCS bucket with versioning + object-lock, or
encrypted in a separate cloud. Snapshots contain **personal data** (names, emails, phones, chat text) —
store **encrypted at rest, access-controlled**, and apply the same retention/erasure rules as the live
DB (see `COMPLIANCE.md`).

**Pull command (fill in host + admin key):**
```sh
SYN_GROWTH=https://syn-growth.<your-subdomain>.workers.dev
curl -fsS -H "Authorization: Bearer $GROWTH_ADMIN_KEY" \
  "$SYN_GROWTH/admin/backup" -o "syn-growth-$(date -u +%Y%m%dT%H%M%SZ).json"
# then copy that file to your OFF-Cloudflare, versioned, encrypted bucket.
```

---

## 4. RESTORE RUNBOOK — read this DURING the incident

You are here because growth data is gone or wrong. Breathe. Work top to bottom. Do not skip the dry run.

**0. Stop the bleeding.** If something is actively corrupting data, revoke it first: pause the Worker
or rotate `GROWTH_ADMIN_KEY` so nothing keeps writing while you recover.

**1. Try Time Travel FIRST if the loss is recent (< ~30 days) and Cloudflare-side is healthy.** It is
faster and in-place:
```sh
npx wrangler d1 time-travel info    <DB_NAME>
npx wrangler d1 time-travel restore <DB_NAME> --timestamp='<just-before-the-incident>'
```
If that recovers you, stop here. Use the snapshot path below only when Time Travel can't (loss older
than the window, account-level loss, or you're rebuilding on a fresh database).

**2. Get the right snapshot.** From your off-Cloudflare bucket, pick the newest snapshot from **before**
the incident. Confirm it is intact and is the real thing:
```sh
SNAP=syn-growth-YYYYMMDDTHHMMSSZ.json
python3 -c "import json,sys; d=json.load(open('$SNAP')); print(d['format'], 'schema', d['schema_version'], d['created_at']); print(d['counts'])"
# format must be 'syn-growth-backup'; schema must match the deployed code's SCHEMA_VERSION (currently 1).
```
If `schema_version` does not match the deployed Worker, the restore will refuse (correctly). Either
deploy the matching code version, or migrate the snapshot deliberately — do NOT force it.

**3. Point the Worker at the target database.** Make sure `SYN_DB` in `wrangler.syn-growth.toml` binds
the database you intend to overwrite. **The restore WIPES every growth table on that database.** Triple-
check you are not aimed at a healthy production DB by mistake.

**4. Dry-run the auth + shape (this does NOT write — no confirm token):**
```sh
SYN_GROWTH=https://syn-growth.<your-subdomain>.workers.dev
curl -fsS -X POST -H "Authorization: Bearer $GROWTH_ADMIN_KEY" -H "Content-Type: application/json" \
  --data "$(python3 -c "import json;print(json.dumps({'snapshot':json.load(open('$SNAP'))}))")" \
  "$SYN_GROWTH/admin/restore"
# EXPECT: 400 {"error":"confirmation_required"}. That proves auth + reachability are good and nothing wrote.
```

**5. Run the real restore (this WIPES and reloads):**
```sh
curl -fsS -X POST -H "Authorization: Bearer $GROWTH_ADMIN_KEY" -H "Content-Type: application/json" \
  --data "$(python3 -c "import json;print(json.dumps({'confirm':'RESTORE-SYN-GROWTH','snapshot':json.load(open('$SNAP'))}))")" \
  "$SYN_GROWTH/admin/restore"
```
**Read the response.** `"ok": true` and every table row `"expected" == "written"` means success. If
`ok` is `false` or you get a `500`, the batch is atomic so the database rolled back — **do not retry
blindly**; capture the response, check the failing table, and re-run only once you understand it.

**6. Verify you are whole.** Pull a fresh backup and compare counts to the snapshot you restored:
```sh
curl -fsS -H "Authorization: Bearer $GROWTH_ADMIN_KEY" "$SYN_GROWTH/admin/backup" -o after.json
python3 -c "import json;a=json.load(open('after.json'));s=json.load(open('$SNAP'));print('MATCH' if a['counts']==s['counts'] else ('MISMATCH',a['counts'],s['counts']))"
```
Spot-check a known client's contacts and their consent records. Then re-enable writes (un-pause / re-
issue the admin key from step 0) and confirm the widget answers on a test site.

**7. Post-incident.** Note what was lost between the snapshot's `created_at` and the incident (that gap
is your data-loss window — anything captured in it is gone unless Time Travel covered it). Tighten
cadence if the gap hurt.

---

## Schema version

`SCHEMA_VERSION` (top of `syn-growth.js`, currently **1**) stamps every snapshot and gates every restore.
**When you change the growth schema (add/alter a table or column), bump it.** Old snapshots then refuse
to load into new code instead of silently restoring a mismatched shape — that refusal is the feature.

## The drill (proof this works)

`worker/syn-growth.test.mjs` runs a real round trip against real SQLite on every push: seed 13 tables
with multiple tenants, contacts, conversations, events, consent, usage, and a multi-row `job_values`
history → export → **wipe** → restore → assert **byte-for-byte identical**, including append-only
content and `job_values` ordering, with relationships intact. Latest drill: **all 13 tables round-trip
identical, 0 discrepancies.** If that check ever fails, the backup is not trustworthy — fix it before
you need it.

## What this does NOT cover

- **`kv` (syn-core workspace blobs)** — different table, different Worker, backed up separately.
- **Secrets** (`GROWTH_ADMIN_KEY`, `ANTHROPIC_API_KEY`) — these live as Wrangler secrets, not in D1;
  keep them in your password manager. A restore rebuilds *data*, not secrets.
- **Cloudflare account access itself** — keep account recovery (2FA backup, billing contact) current, or
  layer two has nowhere to restore *to*.
