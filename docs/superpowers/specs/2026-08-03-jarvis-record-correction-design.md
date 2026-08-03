# Jarvis — the record becomes correctable

Design for one cycle on the Jarvis surface's record views: collapse the two competing caches of a
dossier's detail, make a record's run rows carry what each run did, and expose the attribution lifecycle
so a wrong edge can be corrected where it is drawn.

Three changes, one view. The order is a dependency, not a preference — a correction that leaves five
session caches holding the pre-correction picture reads as a broken button, and the record's run list is
the surface the correction controls attach to.

## Why this, now

The [2026-07-31 integration brief](../briefs/2026-07-31-jarvis-integration-brief.md) measured its way to a
conclusion: Jarvis is not under-distributed, it is **under-fed**. Production held 2 channels, 3
conversations and 18 runs; re-measured 2026-08-03, the vault on disk holds **17 records, 4 decisions and 1
vault-owned memory note** (the ~400 memory notes are read-only mirrors federated from `~/.claude` and
`~/.codex`). The brief's fourth gap — you cannot correct Jarvis when its attribution is wrong — was named
the strongest remaining candidate on the argument that corpus *quality* is the binding constraint, and the
only thing that improves it is the operator correcting and adding to the record. That compounds; a
delivery channel is a one-time multiplier on whatever is already there.

Two defects found while reading the surface for this cycle make the same view untrustworthy, and both are
prerequisites rather than side quests. They are described in §1 and §2.

## 1. One record, one cache

### The defect

A dossier's detail is cached twice, and only one copy is invalidated on write.

- `dossierDetailAtom` (`frontend/app/view/jarvis/tasksstore.ts:17`) — single value, residue from the
  deleted Tasks surface. Backs the record **subject** (`stage.tsx:57`, its only reader). `appendDecision`
  and `setDossierStatus` reload it (`tasksstore.ts:59,72`).
- `recordDetailAtom` (`frontend/app/view/jarvis/jarvissubjectstore.ts:139`) — keyed by dossier id. Backs
  the record **band** (`stage.tsx:203`, rendered by `recordbandview.tsx:183` with decisions shown whenever
  the band is not the subject itself). Written in exactly one place (`jarvissubjectstore.ts:234`), behind
  an early return when the key is already present (`:225`), and cleared nowhere.

So: append a decision to a record, then expand that record from a channel's record band. The band renders
the copy taken the first time it was expanded, for the rest of the session.

Four more session caches of vault-derived state are never invalidated either:

| Atom | File | Keyed by | Cleared today |
|---|---|---|---|
| `ambientDataAtom` | `view/agents/ambientstore.ts:18` | session | never — `loaded` latch at `:23` |
| `recordScopeAtom` | `view/jarvis/jarvissubjectstore.ts:50` | dossier id | never |
| `recordRunsAtom` | `view/jarvis/jarvissubjectstore.ts:54` | dossier id | never |
| `graphBloomAtom` | `view/jarvis/jarvisgraphstore.ts:24` | dossier id | never |

`ambientDataAtom` is the whole-vault attribution map behind every ambient tag on every surface — Radar
findings, run bodies, Memory rows — not just this Stage.

### The fix

**Delete `dossierDetailAtom`.** `stage.tsx` reads `recordDetailAtom[subject.id]` for the record subject,
exactly as it already does for the band, and `tasksstore`'s `reloadDetail` writes that keyed atom.
Collapsing rather than patching is what removes the class: two caches of one object will drift again the
next time only one write path is updated. The blast radius is small and was verified rather than assumed —
`dossierDetailAtom` has one reader and `selectDossier` has one caller (`jarvissubjectstore.ts:93`).

**One `afterRecordWrite(dossierId)`** in `jarvissubjectstore.ts`, called by every write path — decision
append, status set, and the three attribution commands in §3. It drops that dossier's keys from the
detail, scope, runs and graph-bloom atoms, refetches whatever is currently rendered, and kicks
`reloadAmbient()` (new, in `ambientstore.ts`: clears the `loaded` latch and re-reads).

The ambient reload is **fire-and-forget and deliberately not awaited.** `ResolveAmbient` sweeps every
dossier against every run and shells out to git for commit subjects, which is why its call site already
carries a 30-second budget (`ambientstore.ts:16`). Blocking a Confirm click on that would be worse than a
chip that updates a beat late. It has to happen at all because a correction changes ambient tags on
surfaces the user is not looking at.

`graphBaseAtom` is left alone: a correction changes attribution, not the vault's node set, and the bloom is
precisely the attribution part.

This section closes the stale-record defect on its own. After it, appending a decision refreshes the band,
which today it does not.

## 2. A run row says what the run did

### The defect

`recordthread.tsx:64-87` renders each run attributed to a record as `id.slice(0,8)` · `goal` · status. A
dossier's objective is seeded from its run's goal, so the widest column in the row repeats the record's own
title — N identical lines whose only distinguishing datum is an 8-character id. Tracked as JC23 in
[`docs/jarvis-consolidation-open-issues.md`](../../jarvis-consolidation-open-issues.md), which states the
requirement: *when it ran, how long it took and what changed — the goal belongs in the row only when it
differs from the record's.*

The data is already on the object. `RunEvidence` (`pkg/waveobj/wtype.go`) carries `Summary` — a
worker-written sentence that differs per run — plus `DurationMs`, `Files`, `AddTotal` and `DelTotal`.

### The fix

A pure `recordrunrow.ts` with `recordrunrow.test.ts` beside it, matching the surface's
derive-and-unit-test convention. `runRow(run, recordObjective, now)` returns:

| Part | Content | Absent when |
|---|---|---|
| id | `run.id.slice(0, 8)` | never |
| headline | `run.evidence.summary` when sealed; else `run.goal` when it differs from the record's objective | unsealed and the goal matches the objective |

"Differs" means differs after trimming, collapsing internal whitespace and lowercasing — the dossier's
objective is seeded verbatim from its run's goal, so the match this suppresses is an exact one and the
normalization only absorbs incidental drift.
| meta | age from `createdts`, duration from `evidence.durationms`, `+A/−D across N files` | each part independently, when its source is missing |
| status | the existing `runStatusView` | never |

Each meta part is omitted rather than defaulted, so an unsealed run shows age and status and invents
nothing. Reuse rather than reimplement: `ageLabel` (`view/jarvis/recallderive.ts:14`) and `fmtDuration`
(`view/agents/runcompletion.ts:12`, already the formatter the run completion surface applies to this same
`evidence.durationms` field).

Tone assignment follows the role table already commented in `recordthread.tsx:22-28` and recorded under
JC22: the id is identity (`accent-soft`), the headline is value (`secondary`), the meta line is structure
(`muted`), the status is outcome (tonal).

## 3. Correcting an edge

### What exists

`pkg/jarvisattrib/lifecycle.go` implements the whole lifecycle and none of it has a wshrpc command or a
production caller: `Detach` (`:78`), `Accept` (`:111`), `Backfill` (`:245`), `Harden` (`:262`). The record
band's empty case says *"attribution is machine-maintained"* instead — an honest description of a dead end,
written when JC13 replaced two accent-styled `<span>`s that did nothing.

A correction is durable and cheap. `appendOverride` (`pkg/jarvisattrib/store.go:33`) writes one JSONL line
to `<vault>/attributions/overrides.jsonl`, and `applyOverrides` (`lifecycle.go:60`) replays the log over
freshly-assembled edges on every read — so a detach survives a cache rebuild and keeps the edge suppressed
even when the extractors re-infer it. The log is the only non-derivable state the attribution engine
commits.

### Backend

Three commands in `pkg/wshrpc/wshrpctypes_jarvis.go` with handlers in
`pkg/wshrpc/wshserver/wshserver_jarvis.go`, then `task generate`:

| Command | Calls | Serves |
|---|---|---|
| `DetachDossierEdgeCommand{dossierid, runoref}` | `jarvisattrib.Detach` | Not this record |
| `AcceptDossierEdgeCommand{dossierid, runoref}` | `jarvisattrib.Accept` | Confirm, Restore, and Attach |
| `ListDetachedEdgesCommand{dossierid, runoref}` | new `jarvisattrib.DetachedEdges` | the Detached group |

`ListDetachedEdges` takes **either** id, because the two views ask the inverse question — a record's
suppressed runs, and a run's suppressed records. It returns `{tasks, edges}`, the same first two fields
`ResolveAmbient` returns, so the frontend joins labels to edges with the machinery it already has
(`makeAmbientProvider`).

`DetachedEdges` is a small addition to `lifecycle.go`, and **the override log is its source of truth** —
not the assembled edges. *(Corrected during implementation: an earlier draft of this spec said it assembles
the deterministic edges and keeps the detached pairs. That does not work.)* `Detach` also strips the
hardened canonical reference (`lifecycle.go:93-106`), so a detached layer-1 edge is **no longer derivable**;
assembling alone would silently drop the very row the operator most needs to restore — the one behind the
confirm dialog. So the read walks the log for entries whose action is `detach`, filters by whichever id the
caller supplied, and emits each pair carrying `StateDetached` — the state constant declared at `edges.go:52`
that nothing had ever emitted, because `applyOverrides` drops the edge instead. Pairs are sorted, since map
iteration would otherwise reshuffle the rows between reads.

Assembly is consulted only to **enrich** a row whose signal still exists, reusing `assembleEdges` once per
distinct dossier. An edge with nothing derivable left comes back with no layers, an empty provenance and
zero confidence, and the handler projects that as an **empty bucket** rather than deriving one — a bucket
computed from zero confidence reads as "weak", which would assert a strength the row does not have. Both
the record's Detached group and the band's omit the chip entirely when the bucket is empty: absent rather
than fabricated. The projection targets the existing `AmbientEdge` wire shape
(`{oref, dossierid, provenance, bucket, state}`), so no new generated type is needed.

**One accepted limit.** A detached *semantic* edge is not listed. `edgesForDossier` (`lifecycle.go:181`)
reaches the semantic proposal only when the deterministic layers are silent, and semantic attribution
emits zero edges in production because that gate never opens — measured in
[`docs/jarvis-second-brain-open-issues.md`](../../jarvis-second-brain-open-issues.md) item J5. Building for
it would be building for a case the corpus has never produced.

**Two lifecycle functions stay unexposed, deliberately, so the next reader does not think they were
forgotten.** `Harden` auto-promotes ticket-match (layer 2) edges past probation, and layer 2 is measured at
**zero edges** on this corpus because no dispatch goal carries a ticket id — the button would be
unobservable. `Backfill` is `EdgesFor` filtered to the unconfirmed subset, written for a batched-accept
screen this cycle is not building; the per-edge controls make it redundant.

### Where the controls sit

The record band's collapsed row is a single `<button>` (`recordbandview.tsx:152-163`). Nesting Confirm and
Detach buttons inside it would re-open exactly the defect JC19 was filed to fix, so:

- **Record band, expanded panel only.** The non-primary edges already render as sibling rows below the
  panel (`recordbandview.tsx:199-209`); the primary edge gets a matching row there, so every edge is
  corrected the same way in one list. The collapsed row stays purely the expand control.
- **Record subject, on each run row** in `RecordThread`. Those rows are plain `<div>`s today
  (`recordthread.tsx:67`), so a control row costs nothing structurally.

The same edge is reachable from both ends — a run's records from a channel, a record's runs from the
subject — and is corrected wherever the user noticed it was wrong. No new destination.

Which controls appear is a pure function (`edgecontrols.ts`, unit-tested):

| Edge state | Confirm | Not this record |
|---|---|---|
| informing (inferred) | yes | yes, immediate |
| confirmed | no — `Accept` produces no observable change once the ref is hardened | yes, behind `ConfirmModal` |
| detached | Restore (calls `Accept`) | — |

Detaching a **confirmed** edge asks first and names what is being overridden: at layer 1 the worker itself
reported this record when it finished, so the machine is not guessing. It is still offered, because a
worker reporting the wrong dossier is exactly the case worth fixing, and `applyOverrides` suppresses an
edge regardless of which layer produced it.

### Undoing a detach

A detached edge vanishes from every read, so without somewhere to go, Detach would be a destructive action
with no visible trace on a 17-record corpus. Detached edges collect in a muted trailing **`Detached · N`**
group with a Restore control — the same pattern the Subjects column already uses for archived channels and
threads, where the reasoning was identical: without somewhere to go, the menu item would have had no
visible effect.

The group appears in **both** views, asking the inverse question in each: on the record subject it lists
runs suppressed from this record; in the band's expanded panel it lists records suppressed from this run.
That symmetry is why `ListDetachedEdges` takes either id. Without it, detaching from the band would have
had its only undo on a different subject, with nothing on screen saying so.

Recall and the ambient map keep dropping detached edges. Only `ListDetachedEdgesCommand` sees them, so
nothing downstream changes.

A transient undo was considered and rejected: the cockpit has no transient-notification primitive
(`frontend/app/element/` has modal, context menu and flyout, nothing ephemeral), and an undo that is gone
the moment you look away is a worse fit than a group that persists.

### Attaching a record to an unattributed run

`Accept(dossierID, runORef)` works on a pair with **no existing edge**: it appends the accept override, and
`hardenEdge` (`lifecycle.go:26`) writes the run's canonical reference into the dossier's refs block, which
makes it a layer-1 confirmed edge on the next assembly. So attach is the same RPC command plus a picker —
no new backend.

The band's empty case (`recordBandCase` → `none`) renders in a plain `<div>` rather than the expand button
(`recordbandview.tsx:164-167`, since `expandable` covers only the `one` and `several` cases), so the
control can live directly on that row. The expanded panel also gets **`+ Attach another record`**, since
the picker exists either way.

The picker is a small inline list over `taskListAtom` with a free-text filter, keyed by run oref in its own
atom — mirroring the composer's channel picker (`channelPickingAtom`, keyed by subject id), which is keyed
that way for the reason that applies here too: a half-made choice must not follow the user to another
subject.

**Out of scope:** *create a new record from this run*. It needs `CreateDossier` over wshrpc, which is part
of a separate "author a record" cycle along with `SetState`, `SetBlockers`, `SetRefs` and
`SupersedeDecision` — all present in `pkg/jarvisdossier` with no RPC command today.

### Copy that stops being true

`MachineGlyph`'s `title="machine-maintained"` (`recordbandview.tsx:21`) and the empty case's *"attribution
is machine-maintained"* (`:81`) both describe the world this change ends. The empty case becomes the attach
control. The glyph's title becomes **"inferred by Jarvis — you can correct it"**: it still marks an edge
nobody authored, which is the distinction the glyph was drawn for, but stops asserting that the operator
cannot change it.

## Files

| File | Change |
|---|---|
| `pkg/jarvisattrib/lifecycle.go` | add `DetachedEdges` |
| `pkg/jarvisattrib/lifecycle_test.go` | detach→list, accept→empty, accept with no assembled edge |
| `pkg/wshrpc/wshrpctypes_jarvis.go` | three commands + their data types |
| `pkg/wshrpc/wshserver/wshserver_jarvis.go` | three handlers |
| generated (`task generate`) | `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`, generated Go |
| `frontend/app/view/agents/ambientstore.ts` | `reloadAmbient()` |
| `frontend/app/view/jarvis/jarvisgraphstore.ts` | `invalidateBloom()` |
| `frontend/app/view/jarvis/jarvissubjectstore.ts` | detail-atom consolidation; `reloadRecordDetail` / `reloadRecordScope` |
| `frontend/app/view/jarvis/tasksstore.ts` | the record list only; delete `dossierDetailAtom` and both write actions |
| `frontend/app/view/jarvis/stage.tsx` | read the keyed atom; pass the active run's oref to the band |
| `frontend/app/view/jarvis/recordrunrow.ts` + `.test.ts` | new — the run row's content rules |
| `frontend/app/view/jarvis/edgecontrols.ts` + `.test.ts` | new — which controls a state gets |
| `frontend/app/view/jarvis/recordactions.ts` + `.test.ts` | new — every record write, `afterRecordWrite`, detach / accept / restore / attach + the detached-edge read |
| `frontend/app/view/jarvis/edgecontrolsview.tsx` | new — the control row, shared by band and thread |
| `frontend/app/view/jarvis/recordpicker.tsx` | new — the attach picker |
| `frontend/app/view/jarvis/recordthread.tsx` | new run rows, controls, Detached group |
| `frontend/app/view/jarvis/recordbandview.tsx` | per-edge rows in the panel, attach on the empty case, copy |
| `scripts/cdp/scenarios.mjs` | two steps (below) |
| `docs/jarvis-tab.md` | §4 record band, §5 record renderer, §14 state table |
| `docs/jarvis-consolidation-open-issues.md` | close JC23 |

No database migration: the override log is a file in the vault and no new `waveobj` type is registered.

## Verification

**Go.** `DetachedEdges` lists a detached edge with its original layers and provenance; an accepted edge
leaves the list; `Accept` on a pair with no assembled edge produces a canonical reference that
`EdgesFor` then reports as confirmed. Run with the CGO flags the Taskfile sets — a bare `go test ./pkg/...`
fails to build six packages (see `CLAUDE.md`).

**Frontend units.** `recordrunrow.ts` (each absence rule, and the goal-matches-objective case) and
`edgecontrols.ts` (the state→controls table).

**Live, over the Chrome DevTools Protocol.** The defect class here is a bad hop between atoms, which
`docs/jarvis-tab.md` records as invisible to the unit suite. The `jarvis-attribution` scenario runs the
**detach/restore round trip** on a record's own thread:

1. Detach a run from a record: assert it leaves the record's run list and appears under `Detached · N`.
2. Restore it: assert the run returns and the group empties. Ending where it started is what makes this safe
   to run against the user's real vault, mirroring the archive/unarchive step `jarvis-subject-state` already
   runs for the same reason. With no correctable edge in the vault the scenario **reports** that rather than
   passing quietly.

Both steps must be checked by breaking the fix and watching them go red. A green scenario that cannot fail
is not a net.

*(Corrected during implementation: an earlier draft made step 1 "append a decision to a record, then expand
that record's band from its channel and assert the decision is present". That is not arrangeable — it needs
a run carrying a real attribution edge, which `docs/jarvis-tab.md` records as impossible to set up from a
scenario. The invalidation seam it was meant to prove is covered instead by `recordactions.test.ts`, which
asserts `afterRecordWrite` replaces the record's detail, scope and runs, drops its graph bloom, and re-reads
the ambient map. The round trip above exercises that same seam end to end: a detach that does not invalidate
leaves both lists unchanged, so a missing `afterRecordWrite` reddens both halves.)*
