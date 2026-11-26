# Clear run-tree transcripts, keep Usage history

**Spec:** `docs/superpowers/specs/2026-11-23-clear-run-transcripts-design.md` (its "Builder decisions" section settles what the spec left open)
**Verify:** `node scripts/verify.mjs ./pkg/usagestats ./pkg/wstore ./pkg/storagereport ./pkg/wshrpc/... ./cmd/server`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && go vet ./pkg/usagestats ./pkg/wstore ./pkg/storagereport ./pkg/wshrpc/... ./cmd/server`
**Final:** `node scripts/cdp/final-verify.mjs settings-storage motion-diff`

### Task 1: Usage keeps its own record
**Depends on:** none
**Files:** `db/migrations-wstore/000027_usagekeep.up.sql`, `db/migrations-wstore/000027_usagekeep.down.sql`, `pkg/wstore/wstore_usage.go`, `pkg/wstore/wstore_usage_test.go`, `pkg/usagestats/keep.go`, `pkg/usagestats/keep_test.go`

Add `db_usagebucket` (key: harness, session, provider, model, day; token classes, nullable reported cost, msgs) and `db_usagesession` (key: harness, session; cwd, title), with the SQL in `wstore` as `wstore_sessioneffort.go` does, and the keep/read seam in `usagestats`.

Interfaces (Tasks 2 and 3 call these):
- `usagestats.Keep(ctx context.Context, buckets []Bucket, metas []SessionMeta) error`
- `usagestats.Kept(ctx context.Context, sinceDay string) ([]Bucket, []SessionMeta, error)`: `sinceDay` "" = every row; metas for every session among the rows
- `usagestats.KeepTranscriptDirs(ctx context.Context, dirs []string) error`: all-time scan of every transcript under the given Claude project folders or Pi session folders (subagent files included, sessions named as the Usage scan names them), then Keep

Acceptance:
- Keep then Kept round-trips every field of a bucket, a nil reported cost staying nil, and each session's cwd and title.
- A stored row is replaced only by a scanned row of the same key whose token total is at least the stored one; a smaller one leaves it, and rows a later Keep does not name stay.
- A Codex session kept on one day, then kept on a later day, has only the later day's row.
- A Keep of rows identical to the stored ones writes nothing (a repeat scan with no new usage costs no write).
- An empty cwd or title in a later Keep does not erase a stored one.
- KeepTranscriptDirs over a Claude folder holding a session and its subagent file keeps the same buckets the Usage scan gives that session.

### Task 2: Usage answers from the kept record
**Depends on:** Task 1 (calls Keep, Kept)
**Files:** `pkg/wshrpc/wshserver/wshserver_agents.go`, `pkg/wshrpc/wshserver/sessionruns.go`, `pkg/wshrpc/wshserver/sessionruns_test.go`, `pkg/wshrpc/wshserver/usagesessions_test.go`, `pkg/wstore/wstore_channel.go`, `pkg/wstore/wstore_channel_test.go`, `cmd/server/main-server.go`

GetUsageStats scans its window as today, Keeps what it read, then answers with `Kept(windowStart day)` (all rows for All time) and the kept session metas, so a session whose transcript is gone still counts, keeps its title and links to its run, project and initiative live. A failed Keep or Kept is logged and that load answers from the scan alone. wavesrv runs `ScanUsage(0)` + Keep in the background shortly after start and every 24 hours, logging a failure. `runsBySession` maps ids to runs in memory from `wstore.GetAllRunsShared` (cached, re-decodes only changed rows) instead of one `json_each` query per call, which also removes SQLite's bound-parameter cap; delete `GetRunsBySessionIds` and its test if no caller is left.

Acceptance:
- A session kept earlier whose transcript is gone appears in GetUsageStats' buckets and sessions, with its kept title and its run link.
- A windowed load returns no kept row from before its window.
- Linking 12,000 session ids succeeds (past SQLite's bound-parameter cap) and links the same runs as linking them one by one.
- Linking 12,000 session ids takes no longer than linking 100 plus the one `GetAllRunsShared` read (no per-id or per-chunk table scan).
- Measured and stated in the task's report: 7-day and All-time GetUsageStats loads, cold (first call in a fresh process) and warm (second call), against the spec's 1.8 s / 0.4 s and 2.1 s / 0.6 s. Measure with a throwaway Go harness kept outside the repo, pointed at a COPY of the packaged store's db in a temp dir: never open the live packaged or dev store with this code, since applying migration 27 to it makes the installed Arc (which knows migrations up to 26) fail on boot. Also time All time after seeding the copy with 12 months of synthetic kept rows (about 50k rows, 12k sessions).

### Task 3: Storage lists and clears old runs' transcript folders
**Depends on:** Task 1 (clear calls KeepTranscriptDirs)
**Files:** `pkg/wshrpc/wshrpctypes_storage.go`, `pkg/storagereport/transcripts.go`, `pkg/storagereport/transcripts_test.go`, `pkg/storagereport/scan.go`, `pkg/storagereport/scan_test.go`, `pkg/storagereport/classify.go`, `pkg/storagereport/clear.go`, `pkg/storagereport/clear_test.go`

Add `StorageKind_RunTranscripts = "runtranscripts"`. The scan finds the run-tree transcript folders under Claude's projects root and Pi's sessions root by name (Builder decisions: `SlugifyCwd(WorktreeRoot())+"-"+<tree name>`, and Pi's `--<path>--` form; check Pi's encoding against a real folder name such as `--C--Users-...-waveterm-.waveterm-arc-worker-check--`), groups them by the 8-char run prefix, and emits one row per run that is left over: no folder under the worktree root starts with the prefix, and either the one stored run with that prefix (found by filtering `wstore.GetAllRunsShared` in memory; never add a query to `wstore_channel.go`, which Task 2 owns) finished (done or cancelled) at least 14 days ago, or no single stored run has it and the folders' newest write is at least 14 days old. Each harness transcripts row's size leaves out the bytes of the run rows listed under its root. Clearing re-probes the row, runs KeepTranscriptDirs on its folders, and deletes them only if that succeeded.

Wire shape (Task 4 renders it): `Id` `runtranscripts:<prefix>`; `Path` the root holding the first member; `Paths` every member folder; `Count` members; `Size`; `ModTs` newest write; for a known run `RunId`, `RunChannelId`, `RunTitle`, `RunStatus`, `RunTs` (completed ts) as `fillRun` sets them; an unknown run leaves `RunId` empty. Group Left over, Clearable.

Acceptance:
- A finished run 15 days old with lead and task folders and no tree on disk gives one Clearable row holding all of them; at 13 days, or with any tree of its prefix on disk, or with the run still running, no row.
- An unknown run's folders are aged by last write the same way.
- The claude transcripts row's size plus the run rows' sizes equals the root's size.
- A clear keeps the folders' usage before deleting; when keeping fails, nothing is deleted and the row fails with the error.
- A row whose run has a tree on disk again by clear time is skipped, not deleted.

### Task 4: Storage shows run-transcript rows and says what clearing them costs
**Depends on:** none
**Files:** `frontend/app/view/agents/storagemodel.ts`, `frontend/app/view/agents/storagemodel.test.ts`, `frontend/app/view/agents/storagefixtures.ts`, `frontend/app/view/agents/storagefixtures.test.ts`, `frontend/app/view/agents/storagesection.tsx`, `scripts/cdp/scenarios-settings.mjs`, `scripts/cdp/scenarios-motion-diff.mjs`

Render a `runtranscripts` row (wire shape in Task 3) in Left over: titled with its run title, else the prefix from its id; its size and how long ago the run finished (`RunTs`, else `ModTs`). The clear confirm counts the run-transcript folders on their own line and says cleared runs lose their agent replay but keep their Usage. Add run-transcript rows (one known run, one unknown) to the fixture the settings-storage scenario drives, and update that scenario's expected clear size and ids (and motion-diff's storage step if it reads them).

Acceptance:
- clearPlan over a report with run-transcript rows includes their ids and size and a line naming the folder count, the lost replay and the kept Usage.
- settings-storage step 1 shows both run-transcript rows in Left over, the known one by run title and the unknown one by its prefix, and its Clear label reads the fixture's new total (314 MB plus the two rows' sizes); step 2's confirm holds 4 lines (was 3), the new one naming the lost replay and kept Usage; the clear step's expected ids (`STORAGE_CLEAR_IDS`) include both rows' ids. motion-diff's storage step still passes.
