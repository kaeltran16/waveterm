# Channel data-model scaling, Phase 3 (Contract) implementation plan

**Spec:** `docs/superpowers/specs/2026-07-21-channel-data-model-scaling-design.md` Read it first (Sections 1, 2 and 4): it is the design, and every task's requirements include it. This plan is its Phase 3.
**Verify:** `node scripts/verify.mjs ./pkg/wstore ./pkg/waveobj ./pkg/jarvis ./pkg/jarvisstate ./pkg/jarvisvolunteer ./pkg/consult ./pkg/reporadar ./pkg/orchestrate ./pkg/wshrpc/wshserver`
**Check:** `go build ./pkg/... ./cmd/... && go vet ./pkg/wstore/ ./pkg/jarvis/ ./pkg/wshrpc/wshserver/ && node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs surface-smoke attention-cross-channel brief-peek`

## Goal and shape

A channel object stops carrying its messages and runs. Today every `PostChannelMessage`, `AppendRun`,
`UpdateRun` and `CreateDagForRun` reads the whole channel blob, re-marshals it and rewrites it, although
the same message or run is also written to its own `db_channelmessage` / `db_run` row (the Phase 1
dual-write). After this plan the rows are the only copy and `Channel` is metadata.

Why now (packaged store, read-only, 2026-10-06): the largest channel blob is 11.3 MB (585 runs, 95
messages; about two thirds of it is child-run `goal` text), a second is 2.4 MB. The revive gate in
`docs/deferred.md` was 5 MB. One read-modify-write of the 11 MB blob costs about 0.17 s in node
(parse 41 ms, stringify 71 ms, sqlite write 55 ms), on the single write connection, for every run write.

Pre-flight already done on that store, so the contract is safe to take: every embedded run and message
has a row with the same id (0 missing across 9 channels, 759 runs, 108 messages). Run rows differ from the
embedded copies only by the row-side `otype` key and, on two cancelled August runs, a legacy `tier` field
the current struct no longer has. The rows are a superset.

Order is expand, then contract, so no merge leaves the tree half-migrated:

- Tasks 1 and 2 move every remaining reader off the embedded arrays while the arrays still exist and are
  still written. They are independent (Go and frontend) and each is safe alone.
- Task 3 removes the fields, stops the dual-write and migrates existing stores. It is the only
  irreversible step and runs last.

## Global constraints

- Never hand-edit generated files (`frontend/types/gotypes.d.ts`, `frontend/app/store/*`,
  `pkg/wshrpc/wshclient/wshclient.go`, `pkg/waveobj/metaconsts.go`): change the Go type, then
  `task generate`. Only Task 3 changes a wire type.
- No test, script or task step opens the packaged store (`%LOCALAPPDATA%\dev.arc.app`). Tests use the
  wstore test store; Final starts its own dev app on its own data dir.
- Do not kill or restart any `wavesrv` or `wave-tauri` process.
- A decision that reads state and then writes on it stays inside one `WithTx` on the write handle (spec
  Section 3). A read made inside a write transaction must use that transaction's context so it sees the
  transaction's own writes; check how `WithReadTxRtn` behaves when called with a `WithTx` context before
  relying on it, and do not route such a read to the read pool.
- Keep the `channel:` object's version bump on every message and run mutation. The frontend's active
  channel refetches its run and message lists on that bump (`channelsstore.ts`), and nothing else tells it
  a list changed. After Task 3 the bump is a rewrite of a metadata-sized row, which is the point.
- No new RPC unless a task names it. Reuse `GetChannelRuns`, `GetChannelMessages`, `GetRun`,
  `GetWorkerOwner`.
- Errors are returned or logged with context, never swallowed. Comments say why, lower case, only when
  needed. Remove comments that describe the dual-write or "Phase 2" once they stop being true.
- No attribution trailer in any commit message.
- Typecheck with the Check command, not `npx tsc` or `task check:ts`.

## Review focus

1. A worker whose owner stamp is missing must still resolve to its run and channel after the arrays are
   gone: the scan fallbacks read rows, not a channel list (Task 1).
2. Two worker-exit signals for one worker must not both post an outcome: the freshness check and the
   insert stay in one write transaction and the check sees the other's committed message (Task 1; the
   existing `-race` test in `wstore_readpool_test.go` is the guard).
3. A store upgraded straight from before Phase 1, whose arrays have no rows yet, must not lose a message
   or run when the arrays are dropped (Task 3).
4. A row must never be overwritten from an embedded copy during migration: the row is the newer truth
   (Task 3).
5. The migration is re-runnable: a crash between channels, then a restart, finishes the job and loses
   nothing (Task 3).

---

### Task 1: Go readers leave the embedded arrays
**Depends on:** none

After this task no Go code outside the store's own write path and its two one-shot backfills reads
`Channel.Messages` or `Channel.Runs`. The fields, the dual-write and the wire type are unchanged, so
behavior is unchanged.

**Files:** `pkg/wstore/wstore_channel.go`, `pkg/wstore/wstore_dag.go`, `pkg/jarvis/resolve.go`,
`pkg/jarvis/outcome.go`, `pkg/jarvis/classify.go`, `pkg/jarvis/routemigrate.go`,
`pkg/wshrpc/wshserver/wshserver_jarvis.go`, a new migration pair
`db/migrations-wstore/000022_channelmessage_reforef_idx.{up,down}.sql`, and the tests beside each.

**Store additions (`wstore`):**

- An expression index on `db_channelmessage` over `json_extract(data, '$.reforef')` (migration 000022,
  following the form of the existing `channeloid` indexes; the down drops it).
- `GetMessagesByRef(ctx, refORef)`: every message row whose `reforef` is `refORef`, across channels, in
  `ts` order. This replaces every "walk all channels' messages for the one that references this worker".
- A run lookup by worker oref for the stamp-miss fallback: the run row whose some phase lists the worker.
  Select candidates in SQL without decoding every row (for example `instr(data, ?) > 0` on `db_run`), then
  confirm with the existing `phaseIdxForWorker` logic, so a substring hit that is not a phase worker is not
  returned.

**Readers to move (each keeps its current result for the same data):**

- `jarvis/resolve.go`: `ResolveGatekeeperChannel`, `ResolveDispatchChannel`, `workerTaskFor`,
  `ResolveRunWorker`, and the two fallbacks `resolveRunWorkerByScan` and the scan branch of
  `resolveGatekeeperChannelByMeta`. Resolve from the message and run rows; load the one owning channel by
  id. The pure "take a channel list" forms go away if nothing else calls them (grep callers first; the
  pre-Phase-2 parity test may be deleted with the function it compares against).
  "First owner wins" becomes "earliest matching message wins".
- `jarvis/outcome.go`: `alreadyHasFreshOutcome` and `PostOutcome`'s dispatch-existence gate read the
  worker's message rows in the channel. `wstore.PostChannelMessageIf`'s condition stops receiving a
  `*Channel`; give it what the one caller needs to decide inside the transaction (the transaction's
  context is enough: the caller queries the worker's messages with it). Keep the documented guarantee.
- `jarvis/classify.go` `recentTimeline` and `wshserver_jarvis.go` (`consult.BuildPrompt(ch.Messages, ...)`):
  take the messages from `GetChannelMessages`. `recentTimeline` needs only its last `maxTimeline`.
- `wstore_dag.go` `CreateDagForRun`: load the run row inside the transaction and check it belongs to the
  channel, instead of walking `ch.Runs`. It still writes both copies in this task.
- `jarvis/routemigrate.go` `migrateRunPins`: walk the run rows (each carries `ChannelOID`), not
  `ch.Runs`.

`pkg/jarvis/attention.go` already reads rows (`AttentionChannel` is filled from `GetChannelRuns` and
`GetChannelMessages`); leave it. `wshserver_ctx.go` and `jarvisvolunteer/ledger.go` call `GetChannels`
only for identity and metadata; leave them.

**Tests:** tests that seeded `Channel{Runs: ..., Messages: ...}` literals to drive these readers seed
through `AppendRun` / `PostChannelMessage` instead (or the row helpers the package's tests already use).
Add: a worker with no owner stamp resolves to its run through the row fallback; a tab oref that only
appears in a run's goal text does not; an outcome is posted once when two posts race (extend the existing
race test to the new condition form); `go test -race ./pkg/wstore/` passes.

**Done when:** `grep -rnE "\.(Messages|Runs)\b" --include=*.go pkg cmd` shows, for channel values, only
`pkg/wstore/wstore_channel.go` (the write path), `pkg/wstore/wstore_channelrows.go` and tests of those two.

### Task 2: Frontend aggregates leave the channel snapshot's arrays
**Depends on:** none

After this task no frontend code reads `channel.messages` or `channel.runs`. The generated `Channel` type
still has both (Task 3 removes them); do not edit it.

**Files:** `frontend/app/view/agents/channelsstore.ts`, `jarvisderive.ts`, `channelderive.ts`,
`jarviscards.ts`, `cockpitsurface.tsx`, `frontend/app/view/jarvis/fleetscope.ts`, `briefpeekview.tsx`, and
the `.test.ts` beside each model.

- `channelsstore.ts` gains one atom holding each channel's messages keyed by channel id, filled wherever
  the channel snapshot is filled (`fetchChannelsInto`) with one `GetChannelMessagesCommand` per channel.
  A channel whose fetch fails keeps its previous list and the failure is logged; one failure does not
  blank the others. This gives the cross-channel readers the freshness they have today (the snapshot's),
  no better and no worse.
- The pure derivations take messages, not a channel that carries them: `buildFleetSnapshot`,
  `answeredAskIdsAcross`, and whatever else reads `.messages` off a `Channel` (the prompt builder in
  `jarvisderive.ts` keeps the channel for its name and takes the messages beside it). Before porting an
  exported helper, grep for a non-test caller; one with none (`channelHasAsk`, `pendingAskCount` and
  `unreadCount` looked uncalled on 2026-10-06) is deleted with its test rather than ported.
- `fleetscope.ts` `fleetForRecord` no longer finds the owning channels by scanning `channel.runs`. A run
  row carries `channeloid`; take the owning channel ids from the record's attributed runs (the peek
  already loads them into `recordRunsAtom`; the record scope may also carry channel ids). The channel
  count and the worker list for a record stay what they are today for the same data.
- `cockpitsurface.tsx` passes the message lists to `answeredAskIdsAcross`.

Update the comments in `channelsstore.ts` that say the blob still dual-writes; say what the bump means now.

**Tests:** the existing vitest files for these models move to the new signatures and keep their cases.
Add one case to the `fleetscope` test: a record whose run sits in a channel that has no dispatch messages
still counts that channel.

**Final step that shows it:** `attention-cross-channel` (answered asks across channels), `brief-peek`
(a record's fleet line), `surface-smoke` (every surface still mounts).

**Done when:** `grep -rnE "\b(channel|ch|c)\??\.(messages|runs)\b" frontend --include=*.ts --include=*.tsx`
has no hit outside `gotypes.d.ts`, and the Check command's tsc step is clean.

### Task 3: Contract the channel object and migrate stores
**Depends on:** Task 1, Task 2

The irreversible step. `Channel` becomes metadata, the store writes one copy, and an existing store is
migrated at startup without losing a row.

**Files:** `pkg/waveobj/wtype.go`, `pkg/wstore/wstore_channel.go`, `pkg/wstore/wstore_dag.go`,
`pkg/wstore/wstore_channelrows.go` (replaced by the contract migration), its caller at startup, a migration
pair `db/migrations-wstore/000023_channel_precontract.{up,down}.sql`, generated files via `task generate`,
tests, and the docs listed at the end.

**Type:** remove `Messages` and `Runs` from `waveobj.Channel`. Run `task generate`; the frontend `Channel`
type loses both fields and must still typecheck (Task 2 made that true).

**Writes (`wstore`):**

- `PostChannelMessage`, `PostChannelMessageIf`, `AppendRun`: write the row, and bump the channel's version
  in the same transaction (a `DBUpdate` of the now-small channel is enough). A missing channel is still an
  error, as it is today through `DBMustGet`.
- `UpdateRun` and `CreateDagForRun`: read the run row in the transaction, check `ChannelOID`, apply the
  change, write the row, bump the channel. "run not found in channel" keeps its meaning for a run that
  exists under another channel.
- Delete `appendChannelMessage`, `appendRunIn`, `updateRunIn` and the comments about keeping two
  representations identical.

**Recovery copy (migration 000023):** `CREATE TABLE db_channel_precontract AS SELECT oid, version, data
FROM db_channel`. SQL migrations run before the Go step below, so this captures the blobs as they were.
The down copies `data` back into `db_channel` for the oids that still exist, then drops the table. This
table is the only undo for the strip; it is dropped by a later change, not this one.

**Startup migration (Go, replaces `BackfillChannelRows`):** one pass gated by its own MainServer marker
(a new key; the two old markers and their backfills are deleted, and the old keys are left in existing
stores untouched). It must run before anything can write a channel, because the first write of a contracted
`Channel` drops that channel's arrays implicitly. For each channel, in one write transaction:

1. read the raw `data` and decode only `messages` and `runs` into a private legacy struct in this file;
2. for each embedded message or run whose row does not exist, stamp identity and parent and insert it; a
   row that exists is left exactly as it is;
3. remove the two keys from the stored blob (`json_remove(data, '$.messages', '$.runs')`).

A channel that fails is logged with its id and left untouched; the marker is set only when every channel
succeeded, so the next start retries. Log one summary line: channels, rows inserted, bytes before and after.
The owner-stamp backfills are not carried over: a worker with no stamp resolves through Task 1's row
fallback.

**Tests (`pkg/wstore`):**

- Migration, seeded by writing raw legacy JSON into `db_channel` (the struct can no longer produce it):
  embedded items with no rows become rows with identity and `channeloid` set; an existing row whose
  content differs from its embedded copy is unchanged afterwards; the stored blob has no `messages` or
  `runs` key; a second run is a no-op; a pass interrupted after the first of two channels completes on the
  next run.
- Contract: after `AppendRun`, `UpdateRun`, `PostChannelMessage` and `CreateDagForRun` on a channel holding
  500 runs of about 15 KB each, the channel's stored `data` stays under 4 KB (a named constant in the
  test), the channel version rose by one per mutation, and `GetRun` / `GetChannelRuns` /
  `GetChannelMessages` return what was written.
- The whole Verify set passes, including `-race` on `./pkg/wstore`.

**Measure and report (not asserted):** time 50 `UpdateRun` calls on that 500-run channel before and after
this task's store change (the "before" from the commit this task starts on) and put both numbers in the
task report and the commit body. This closes the spec's Phase 3 verification line.

**Docs, in the same commit:**

- Spec: status line and Section 2 mark Phase 3 shipped with the date; note the deviations (the bump is
  kept as the list signal; the cross-channel frontend readers use a per-channel message fetch on the
  snapshot's cadence; owner-stamp backfills dropped).
- `docs/deferred.md`: replace the "Channel data-model scaling, Phase 3" entry with a short one for what is
  left: `db_channel_precontract` is a recovery copy to drop once the migrated store has been in use
  (give the exact SQL to restore from it and to drop it), and the active channel still refetches its whole
  run list on every bump (11 MB of run rows for the largest channel), to revisit on a measured cost.
- `docs/open-issues.md`: remove the Phase 3 line.
- Delete this plan file.
