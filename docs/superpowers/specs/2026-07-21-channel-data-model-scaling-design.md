# Design — Channel data-model scaling (Theme A)

**Date:** 2026-07-21
**Status:** Approved design, pre-plan. Source: the 2026-07-21 improvement scan (Theme A, findings A1–A3).
**Driver:** Preventive. No observed symptom; the goal is to remove the `O(session)` growth that is the
only cluster whose cost worsens the more the product is used, before it bites at scale.

---

## Problem

`Channel` is a single blob that grows without bound. `Messages []ChannelMessage` and `Runs []Run` (each
`Run` embeds `Phases` and a sealed `Evidence` carrying files + verifs) are stored inline in one JSON `data`
column, and **nothing prunes either slice** (`waveobj/wtype.go:318`; `ChannelMessage` `:204`, `Run` `:235`).
That one shape drives all three findings:

- **A1 — write + broadcast.** Every mutation (`PostChannelMessage`, `UpdateRun`, `SetChannelRead`,
  `SetChannel*`) goes through `DBUpdateFn`/`DBUpdateFnErr` → `DBMustGet` (full deserialize) → `DBUpdate`
  (full `ToJson` re-marshal, whole `data` column rewritten) — `wstore_dbops.go:301,320,331`,
  `wstore_channel.go:78,133,161`. Then `SendWaveObjUpdate` (`wcore.go:108`) re-reads the whole channel and
  publishes the entire `Obj` to every subscriber; the FE replaces the whole WOS object. Cost grows with the
  channel's history, per near-keystroke event (`SetChannelRead` fires on every channel select).
- **A2 — hot-path full scan.** `handleAsk` (`jarvis/watcher.go:94`), `OnWorkerExit` (`jarvis/onexit.go:52`),
  `ReportRunPhase` + a second site (`wshserver_runs.go:190,344`), radar collect
  (`reporadar/collect_runs.go:18`), and `wshserver_jarvis.go:64` all call `GetChannels` →
  `DBGetAllObjsByType` (`wstore_dbops.go:220`), which **full-deserializes every channel with all embedded
  history**, then nested-scan channels × runs × phases × orefs to find one owner (`jarvis/resolve.go:93`).
  Cost `O(total channels × blob size)` per event, and it is pure waste — only one owner is needed.
- **A3 — single connection.** `SetMaxOpenConns(1)` (`wstore_dbsetup.go:55`; WAL on at `:51`) means a large
  read-modify-write (A1) or a radar scan (A2) head-of-line-blocks UI-critical reads for the duration of the
  write. WAL already supports N readers + 1 writer, so a read-only connection pool is the standard fix — but
  several paths **rely** on single-connection serialization for correctness (`PostChannelMessageIf`
  documents it at `wstore_channel.go:89-92`; run-state transitions; the double-spawn guard), so a read pool
  has real blast radius.

## Approaches considered

- **A — Index-first (minimal).** An in-memory lookup (worker-oref → run, dispatch-ref → channel, run-id →
  run) with fallback-to-scan on miss, killing A2 only. Backend-only, no migration, no correctness risk.
  Document A1/A3 behind a measurement trigger.
- **B — Index + delta broadcast.** A, plus a new wire event carrying just the changed message/run, applied
  incrementally on the FE.
- **C — Full workstream (chosen).** Split `Messages`/`Runs` out of the channel blob into their own indexed
  object rows (O(1) appends, no blob rewrite), plus a read-connection pool with a correctness audit.

**Decision: C.** Chosen despite the preventive/no-symptom driver — the intent is to build the correct
end-state model once rather than in increments. To reconcile that with "measure before optimizing", C is
built as **independently-shippable, reversible phases** (below), with the irreversible step last and the
actual A1 payoff measured at the end. C **subsumes A**: once runs/messages are indexed rows, the lookup is a
real SQL query, so no separate in-memory index is needed; and it **subsumes B**: the existing per-object
`waveobj:update`/WOS mechanism already *is* a per-object delta broadcast, so no new wire event is invented.

---

## Section 1 — Target data model

Promote the two unbounded slices out of the blob into their own object types. Both `Run.ID` and
`ChannelMessage.ID` are already UUIDs, so they become object OIDs directly.

| Today | Target |
|---|---|
| `Channel{… Messages []ChannelMessage, Runs []Run, Meta}` — one blob | `Channel{… Meta}` — metadata only, ~constant size |
| `ChannelMessage` embedded in the array | `OType_ChannelMessage` → `db_channelmessage(oid, version, data)`; `data.channeloid`, `data.ts` |
| `Run` embedded (carries `Phases`, `Evidence`) | `OType_Run` → `db_run(oid, version, data)`; `data.channeloid` |

What it fixes at the root:
- **A1 write:** append a message = `DBInsert` one row; update a run rewrites only that run's row.
- **A1 broadcast:** per-object `waveobj:update` pushes only the changed object — delta broadcast for free
  from existing plumbing.
- **A2 lookup:** run-by-channel / run-by-id become indexed SQL (`WHERE json_extract(data,'$.channeloid')=?`
  with an expression index).

**Design call 1 — worker-oref → run lookup (approved).** Worker orefs live nested at
`run.Phases[].WorkerOrefs[]` (array-in-array, not directly indexable). Rather than a separate `run_worker`
index table, **stamp the owning `run:`/`channel:` oref onto the worker tab's `Meta` at spawn time.** The
worker oref *is* a tab oref, and the hot paths already load that tab (`OnWorkerExit` does
`DBFindTabForBlockId`), so the lookup becomes a direct field read — zero scan, zero new table. Caveat:
needs a backfill for existing workers; revisit if a future subagent worker lacks its own tab.

**Design call 2 — `Run` as a top-level object (approved).** `OType_Run` gets an oref (`run:<id>`),
participates in WOS, and the FE subscribes to it live. This is what makes per-run delta updates work; the
cost is the FE assembling a channel view from three streams (channel meta + message list + run list)
instead of one object.

## Section 2 — Phasing (expand → migrate → contract)

Landed as independently-shippable, reversible phases; no half-migrated state breaks the tree.

- **Phase 0 — Read-connection pool (A3), fully independent.** Ships first; touches no data model. Immediate
  latency relief, reversible by routing reads back. Detail in Section 3.
- **Phase 1 — Expand.** Add `db_run` + `db_channelmessage` tables and expression indexes on
  `json_extract(data,'$.channeloid')`. Introduce `OType_Run` / `OType_ChannelMessage`. **Dual-write:**
  mutations keep embedding in the channel blob *and* write the row. Backfill existing blobs into rows; stamp
  `run:`/`channel:` oref onto worker-tab meta (+ backfill). Nothing reads the rows yet — invisible,
  reversible (drop tables).
- **Phase 2 — Migrate reads.** Point hot-path lookups (`handleAsk`, `OnWorkerExit`, `ReportRunPhase`, the
  two `wshserver_runs` sites, radar collect) at the indexed rows / tab-meta instead of the `GetChannels`
  full-scan. Add FE-facing APIs `GetChannelMessages(channelId, before, limit)` and `GetChannelRuns(channelId)`;
  cut the FE over to assembling the channel view from message-list + run-list + per-object WOS subscriptions.
  Blob arrays still written but no longer read.
- **Phase 3 — Contract.** Stop embedding `Messages`/`Runs` in the channel blob; `Channel` becomes
  metadata-only; drop the dead arrays (final blob-shrink migration). This is the phase that collapses the
  `O(session)` write + broadcast cost — everything before it is scaffolding that keeps the tree safe.

**Order rationale.** Phase 0 delivers value alone and de-risks. The risky cutover (Phase 2: FE + read-path
flip) happens while the old blob is intact as a fallback; the irreversible step (Phase 3: drop arrays)
happens last, only after reads are proven on the new path.

**Cost of safety (stated).** During Phases 1–2 the blob write cost is unchanged (dual-write adds a little).
A1's win fully lands only at Phase 3. Accepted trade-off for a preventive/no-symptom refactor: safety over
speed.

## Section 3 — Read-connection pool + correctness audit (A3)

**Mechanism — two handles.**
- **Write handle:** the existing one, `SetMaxOpenConns(1)`, `mode=rwc`. All writes and all read-modify-write
  transactions stay here (they still serialize, exactly as today).
- **Read handle:** new, `mode=ro`, `SetMaxOpenConns(N)`. Serves pure read-only queries: the `GetChannels`
  list, the new message/run list queries, the indexed hot-path lookups.

A new `WithReadTx` (read pool) alongside `WithTx` (write) makes the routing explicit at each call site.

**Correctness audit — the invariant.** The single connection protects correctness only where a read-then-write
spans two connections. Rule enforced: **any decision that reads state and then writes based on it must run
inside one `WithTx` on the write handle.**
- `PostChannelMessageIf` (`wstore_channel.go:93`) — cond-check + append already in one `WithTx`. Stays on
  the write handle; two posters still serialize and the second sees the first's committed message. No change
  needed beyond keeping it on the write handle.
- Run-state transitions in nested `WithTx` — read + mutate in one write tx. Safe.
- **Double-spawn guard** (`len(WorkerOrefs)>0` checked, then persisted in a later call) — an *existing*
  latent TOCTOU (flagged in `docs/deferred.md`); the single connection only narrowed the window, never
  closed it. The read pool does not create it but may widen it. **Noted, not fixed here** (orthogonal, and
  the real fix — fold spawn+attach into one write tx — is a known open item). Called out for honesty.

**Deliverable.** A short audit table in the plan: every read-then-write site, its handle, and whether it is
inside one write tx. Guarded by a `go test -race` test hammering concurrent posts/reads asserting the
`PostChannelMessageIf` invariant.

## Section 4 — Migration & verification

**Migration mechanism.**
- **Schema** (new tables + expression indexes in Phase 1; drop-arrays in Phase 3) → SQL migrations
  `000014_*`…, following the numbered pattern. Run `task build:backend --force` after adding `.sql` (the
  Taskfile does not cache-bust on `db/**`).
- **Backfill** (unpack existing blobs → rows; stamp worker-tab meta) → a **Go startup migration** guarded by
  a one-shot marker (MainServer meta flag or sentinel row), reading each channel once and inserting rows
  **idempotently**, so a restart mid-backfill is safe and re-runnable. (Raw-SQL row-fanout via `json_each`
  is possible but gnarly and unlike the existing migrations; Go is more maintainable.)

**Ordering & pagination.** Messages sort by `ts`; list query `WHERE channeloid=? ORDER BY ts DESC LIMIT ?
[AND ts < ?]` against the `(channeloid, ts)` expression index. Phase 2 ships a generous default limit; true
lazy "load older" UI is a follow-on, not required for cutover.

**Verification per phase** (evidence before "done"):
- **Phase 0:** `go test -race` — readers proceed while a slow write is in flight; `PostChannelMessageIf`
  invariant holds on the two-handle setup.
- **Phase 1:** backfill test — seed legacy blobs, run backfill, assert row counts + content match the
  arrays and **idempotency** (second run is a no-op). Dual-write test: a post writes blob and row
  identically.
- **Phase 2:** parity test — old `ResolveRunWorker` full-scan vs new indexed lookup agree over the same
  fixture. FE assembled view renders identically, verified on the live dev app over CDP (`task verify:ui`;
  no render harness exists).
- **Phase 3:** channel blob no longer contains the arrays; message/run reads still resolve; a burst of posts
  to a large channel shows constant-ish write time (the A1 payoff — measured here, closing the loop on
  "preventive").
- **Cross-cutting:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` clean;
  `task generate` leaves no drift (new wshrpc + object types regenerated, never hand-edited).

## Scope boundary (explicitly out)

- **No history-retention/deletion policy.** Rows accumulate, just cheaply now; pruning/archival is a
  separate future call.
- **No remote/WSL worker model change** (open-issues #5, blocked on a missing prerequisite).
- **No double-spawn TOCTOU fix** (Section 3 — orthogonal pre-existing race).

## References

- Brief: `docs/superpowers/briefs/2026-07-21-open-ended-improvement-scan-brief.md` (Theme A, A1–A3).
- Backlog: `docs/open-issues.md`.
- Memory: `improvement-scan-2026-07-21-brief`.
