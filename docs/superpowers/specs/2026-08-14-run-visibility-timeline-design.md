# Run lifecycle timeline — design

Status: draft for review
Date: 2026-08-14

## Context

Jarvis runs and the DAG engine persist *state*, not *history*: a `Run` records its status and phases
(each with `StartedTs`/`DoneTs`), a `TaskGroup` records derived task states — but neither keeps an
append-only log of what happened and when. The live transcript narration (`usecardstreams.ts`) shows
*what a worker is doing right now*, and `PhaseHistory` shows that same session feed; neither survives
as run-level history (session feed is live-only), and neither can answer "how did this run get here?"
across phases, children, gates, and triage.

The de-facto references for multi-agent visibility — Orca's durable message log with ack'd deliveries
(`orca orchestration check`), orca-viz's read-only SQLite viewer, 1devtool's activity rail — all render
a *chronological event stream*, not a state snapshot. This design adds the missing event layer to Wave,
in-place: the run card gains a lifecycle timeline. Constraint from the user: **no new tab or surface**;
everything renders inside the existing run body.

## Design overview

1. **A durable, append-only run-event log** (`db_runevent`), written at the exact transitions that
   already persist run state — no new engine logic, no worker-side protocol change (`wsh jarvis
   complete/hold/triage` already pass what the log needs).
2. **A read-only query** (`JarvisRunEventsCommand`) plus a `run:event` wps event so the open run card
   live-appends.
3. **A hybrid timeline** rendered in `RunBody`: events grouped under **RUN** (cross-cutting: create,
   triage, children, evidence, cancel) and under their **phase** (started / complete / held), with a
   collapsed default showing the last 3 events. This resolves the A/B tradeoff: run-scoped events get a
   home; phase events stay anchored (decision from brainstorming, v2).
4. **A click map that reuses existing verbs** — every interactive row navigates/opens via machinery the
   run card already has (`approveGate`/`sendBackGate`, `jumpToAgent`, run-strip selection, `openDag`,
   `openPath` for artifacts).

## Data model

### `db_runevent` (migration 000018)

Append-only table; follows the repo's row-backed store pattern but with queryable columns:

```sql
CREATE TABLE IF NOT EXISTS db_runevent (
    oid varchar(36) PRIMARY KEY,      -- event uuid
    runid varchar(36) NOT NULL,       -- owning run (== run oid)
    channelid varchar(36) NOT NULL,   -- for GetChannelEvents scoping
    ts int NOT NULL,                  -- unix millis
    kind varchar(32) NOT NULL,        -- see kinds below
    phaseidx int,                     -- nullable; phase-scoped events only
    data json NOT NULL                -- kind-specific detail
);
CREATE INDEX IF NOT EXISTS idx_runevent_run ON db_runevent(runid, ts DESC);
```

`RunEvent` (wshrpc DTO, generated): `{oid, runid, channelid, ts, kind, phaseidx, data}` where `data`
is a typed JSON detail per kind. Prune to the most recent 1000 events per run on insert.

### Event kinds and their single write point

All writes are **best-effort, after the mutation succeeds** (the house telemetry pattern — a log write
must never fail the run it describes; see `writeProactive` precedent). Written in the same code path
that already performs the transition:

| kind | written in | detail |
|---|---|---|
| `run-created` | `CreateRunCommand` after `AppendRun` | runtime, mode |
| `phase-started` | `NewRun` first phase + `CompletePhase` auto-start + `ApproveGate` successor | phaseidx, worker tab oref |
| `phase-complete` | `ApplyRunAction` complete | phaseidx, artifacts[], commit |
| `phase-held` | `ApplyRunAction` hold | phaseidx, artifacts[] (plan path) |
| `gate-approved` / `gate-sent-back` | `ApplyRunAction` approve/sendback | phaseidx |
| `triage` | `ApplyRunAction` triage | phaseidx, verdict, note |
| `child-created` | `CreateChildRunCommand` | child runid, goal, mode |
| `child-done` / `child-cancelled` | `AdvanceRunCommand` when the mutated run has a `ParentLeadORef` — same handler that already computes `ParentNotifyLine`; resolve the parent run id via `jarvis.ResolveRunWorkerFromMeta(ctx, child.ParentLeadORef)` (the resolver `CreateChildRunCommand` already uses) | child runid, goal, summary |
| `run-cancelled` | `CancelRunCommand` | — |
| `evidence-sealed` | `sealDoneRunEvidence` on successful seal | files, +add/-del |
| `task-spawned` / `task-stalled` / `dag-blocked` / `dag-done` | `orchestrate` engine, at the same points it publishes `dag:*` wps events — appended to the *owning run's* log (fixes the stalled-child gap surfacing only to the lead) | task id / failure count |

The store helper is `wstore.AppendRunEvent(ctx, channelId, runId, kind, phaseIdx, detail)` +
`wstore.QueryRunEvents(ctx, channelId, runId, limit)` — a small package with no import-cycle risk
(both `jarvis` and `orchestrate` already import `wstore`; `orchestrate` must keep not importing
`jarvis`, per the existing comment in `attention.go`).

## Read path

- `JarvisRunEventsCommand({channelid, runid, limit})` → newest-first events.
- `Event_RunEvent = "run:event"` added to `wps/wpstypes.go` + `AllEvents` + `pkg/tsgen/tsgenevent.go`
  (the three-step rule in the file header); payload `{channelid, runid, event}`. Published after every
  append so the focused run card appends one row without re-querying.

## Frontend

### Placement

`RunTimeline`, a collapsible section in `runbody.tsx` between the header (`RunRollup`/status) and the
`CompactStepper`/phase rail. Collapsed default: `TIMELINE · N events` header row + a 3-event preview
(read-only; clicking anywhere expands). The `RunBody` already owns run-scoped live machinery
(liveness clock, transcript streams, run: WOS subscription) — the event subscription is a parallel,
consistent addition.

### Grouping (pure, testable)

`buildRunTimeline(run, events)` in `runmodel.ts` (or a sibling pure module, per repo convention):
events with `phaseidx` render under their phase group; `run-created`, `triage`, child events,
`run-cancelled`, `evidence-sealed`, and dag events render under a RUN group. Within a group, newest
first. Preview = last 3 events overall by ts. No events → the section renders nothing.

### Click map (reuses existing verbs)

| event | click | verb |
|---|---|---|
| phase-started / phase-complete | roll the rail to that phase, open its worker card | `phaseRailIds` / `jumpToAgent` |
| phase-held | scroll to the ReviewGateCard, focus Approve | `approveGate` / `sendBackGate` |
| child-done / child-cancelled | select the child run in the run strip (its card has the evidence) | run-strip selection |
| evidence-sealed | open the run's completion/diff surface | existing completion surface |
| task-stalled / dag-blocked | `openDag()` focused on that task | `openDag` |
| run-created / triage / run-cancelled | informational; tooltip shows the detail (reason/note) | — |
| phase-complete / phase-held artifact filename | open the artifact in the editor | `openPath(projectPath, rel)` — same pattern `runcompletionsurface.tsx` already uses for artifacts; dotted underline marks the link |

Row click and filename click are distinct surfaces on artifact rows. Collapsed preview rows are
read-only. Two-way anchoring: clicking a rail node expands the timeline at that phase's group; clicking
a phase event scrolls the rail to that node.

## Error handling / robustness

- Event append is best-effort post-mutation: a failed log write logs and never fails the run (matches
  `writeProactive`).
- Prune on insert; reads are bounded by `limit`.
- `phaseidx` out of range / missing details render as "no action" rows or are skipped — never crash the
  card.
- Parent-run resolution for `child-done` uses the existing resolve machinery the notify path uses;
  unresolved parent → log and skip the event.

## Testing

- Go: `AppendRunEvent`/`QueryRunEvents` round trip + prune (wstore); each transition writes its event
  (wshserver run tests — assert the log row exists after `complete`/`hold`/`approve`/`sendback`/
  `triage`/cancel); `child-done` lands on the parent run's log; orphan-child resolution is a no-op.
- FE: `buildRunTimeline` grouping + preview (vitest, pure); no jsdom render tests per repo convention.
- Gates: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` clean; `npx vitest`; the
  touched Go packages build + test.

## Scope / phasing

**v1 (this spec):** the event log + `JarvisRunEventsCommand` + `run:event` + hybrid timeline (RUN +
phase groups, collapsed preview) + click map + artifact-open.

**Deferred:** backfill of historical runs (log starts at feature ship); a global all-runs activity
feed (the log is the foundation, the feed is a later consumer); per-worker heartbeat events (separate
worker-contract change); live transcript *steps* in the timeline (that's the existing narration
surface's job).

## Non-goals

- No worker-side protocol change — `wsh jarvis complete/hold/triage` are unchanged; their existing
  payloads populate the detail fields.
- No new navigation surface, tab, or full-surface takeover (the DAG graph stays the only takeover).
- No writes to the run's own state beyond what transitions already do.