# Run timing in the run sheet

**Goal:** an orchestrator run's detail sheet shows where the run's wall clock went: a collapsible Timing section with one bar per activity (Planning, Execution, Task review, Merge & Verify, Final verification, Landing / wrap-up) on a shared since-launch axis, live while the run runs and kept on the finished run above its report.

**Architecture:** the timing is derived once, in Go, inside the DAG digest (`orchestrate.BuildDigest`), from the retained run events the digest already loads, and travels as a new `digest.timing` field. The frontend turns it into rows with a pure model (`runtiming.ts`) and draws it with a thin view at the top of the run sheet's body. Open activities carry no end; the sheet's clock grows them.

**Verify:** `node scripts/verify.mjs ./pkg/orchestrate/... ./pkg/wshrpc/...`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && go vet ./pkg/orchestrate/ ./pkg/wshrpc/...`
**Final:** `node scripts/cdp/final-verify.mjs run-timing`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\run-timing\project\Main.dc.html

## Decisions (approved at Spec review)

- One derivation, in Go: `BuildDigest` fills `digest.timing`. The sheet and `wsh jarvis dag status` JSON read the same value; the frontend never re-derives intervals from raw events (the UI's event window is capped at 200 rows; the digest's retained-kind query is not).
- Activities, each from the first start to the last end, in this display order:
  - `planning`: the owner run's `CreatedTs` -> first `task-spawned`.
  - `execution`: first `task-spawned` -> last `task-done` / `task-failed`.
  - `review`: first `task-review-started` -> last `task-review-passed` / `task-review-failed`.
  - `merge` (Merge & Verify): first `task-merge-started` -> the last merge boundary: the merge-point Verify outcome (`task-verify-passed` / `task-verify-failed`) naming the task in `taskid` or `batch`, or `task-merged` when the plan has no Verify.
  - `final`: the first final step's start (a `final-step` event's `ts - ms`, or the live `FinalStage.StepTs` before any step has ended) -> `dag-done`.
  - `landing` (Landing / wrap-up): `dag-done` -> the owner run's `CompletedTs`.
- An activity is open (end 0) while any of its per-task starts has no later end for that task (a retried task's latest start counts). Planning is open until the first spawn; final is open while the final stage runs; landing is open after `dag-done` until the run completes.
- On a terminal run (done, cancelled, failed) nothing is open: an open activity closes at the run's end.
- Only started activities are listed. `partial` is set when a boundary the derivation needs was pruned by retention (the 1000-row per-run cap).
- Only DAG-linked runs show Timing; quick runs show nothing.
- Placement and copy follow the prototype: the first thing in the sheet's scrolling body, above tasks / report / evidence. Collapsed by default while running, expanded by default on a terminal run. The toggle is component state, not persisted. Header right side: `30m elapsed` (live), `Finished in 42m` (done), `Ended after 42m` (cancelled or failed).
- Bar colors use existing tokens only: planning and landing `bg-ink-mid`, execution `bg-accent`, review `bg-accent-soft`, merge `bg-accent-500`, final `bg-success`. Track `bg-surface-raised`.

## Interfaces

Wire types (Task 1, `pkg/wshrpc/wshrpctypes_dag.go`), shared by every later task:

```go
// DagTimingDigest is where the run's wall clock went: activities on a since-launch axis.
type DagTimingDigest struct {
	StartTs    int64               `json:"startts"`          // the owner run's launch
	EndTs      int64               `json:"endts,omitempty"`  // the run's end; 0 while it is live
	Activities []DagTimingActivity `json:"activities,omitempty"` // started activities, in display order
	Partial    bool                `json:"partial,omitempty"`    // a needed boundary was pruned by retention
}

type DagTimingActivity struct {
	Key     string `json:"key"`             // planning | execution | review | merge | final | landing
	StartTs int64  `json:"startts"`
	EndTs   int64  `json:"endts,omitempty"` // 0 while open
}
```

`DagStatusDigest` gains a `Timing *DagTimingDigest` field tagged `json:"timing,omitempty"` (pointer + omitempty keeps the typed digest fixtures in frontend tests compiling, like `Shape`).

Frontend model (Task 3, `frontend/app/view/jarvis/runtiming.ts`), consumed by Task 4:

```ts
export type TimingKey = "planning" | "execution" | "review" | "merge" | "final" | "landing";
export type TimingRow = { key: TimingKey; label: string; left: number; width: number; duration: string; open: boolean }; // left/width in percent of the axis
export type RunTimingView = {
    header: string;              // "30m elapsed" | "Finished in 42m" | "Ended after 42m"
    axis: [string, string, string]; // "0m", midpoint, end
    rows: TimingRow[];
    summary: string[];           // live only, shown even when collapsed; [] on a terminal run
    notes: string[];             // the footnotes under the rows
    defaultOpen: boolean;        // false live, true terminal
};
export function runTiming(input: { run: Run; digest: DagStatusDigest | undefined; tasks: TaskNode[] | undefined; nowMs: number }): RunTimingView | null;
```

`runTiming` returns null when the digest has no timing.

### Task 1: Timing wire types
**Depends on:** none
**Model:** claude-sonnet-5-5

Files: `pkg/wshrpc/wshrpctypes_dag.go`; regenerated `frontend/types/gotypes.d.ts` (and any other `task generate` output it touches).

- Add `DagTimingDigest`, `DagTimingActivity` and the `Timing` field on `DagStatusDigest` exactly as in Interfaces, with the comments.
- Run `task generate`; never hand-edit a generated file.
- Nothing fills `Timing` yet. Acceptance: `go build ./pkg/... ./cmd/...` succeeds, `frontend/types/gotypes.d.ts` has `DagTimingDigest` / `DagTimingActivity` and an optional `timing?` on `DagStatusDigest`, and the Check line passes.

### Task 2: Derive timing in the DAG digest
**Depends on:** Task 1

Files: `pkg/orchestrate/digest.go` (or a new `pkg/orchestrate/digesttiming.go` beside it), `pkg/orchestrate/digest_test.go` (or `digesttiming_test.go`), `pkg/wshrpc/wshserver/wshserver_dag.go`.

- `DagDigestSnapshot` gains `Owner *waveobj.Run` (the run that owns the dag). `DagStatusCommand` already loads it; pass it in. `BuildDigest` stays pure.
- `dagDigestRetainedKinds` gains `task-spawned`, `task-failed`, `task-review-started`, `task-review-passed`, `task-review-failed`, `task-merged`, `task-verify-passed`, `task-verify-failed`, `final-step`. Check that every other `BuildDigest` consumer of `Retained` (retries, merge gate clock, durations, tally, told) still gets the same answer with the extra rows present.
- `BuildDigest` sets `Timing` by the rules in Decisions when `Owner` is non-nil; nil otherwise. `StartTs` is `Owner.CreatedTs`. `EndTs` is the run's end once it is terminal (`Owner.CompletedTs`, else the `dag-done` / `dag-cancelled` ts); 0 while live.
- Do not change any wire type (Task 1 owns them) and do not run `task generate`.

Tests (`go test ./pkg/orchestrate -run 'TestDigestTiming'`), each building a snapshot with events at fixed timestamps:
- `TestDigestTimingCompletedRun`: all six activities with the expected start/end, none open, `EndTs` = `CompletedTs`, display order as listed.
- `TestDigestTimingLiveRun`: planning closed, execution open while a task's spawn has no done, review open while a review has no outcome, final and landing absent, `EndTs` 0.
- `TestDigestTimingPlanningOnly`: no task spawned yet: one open planning activity.
- `TestDigestTimingRetriedTask`: spawn, failed, spawn again with no done: execution is open (the latest start counts).
- `TestDigestTimingBatchVerify`: two tips merged and one `task-verify-passed` whose `taskid` is the older tip and `batch` names both: merge is closed at the verify ts, not left open for the second tip.
- `TestDigestTimingNoVerifyLine`: merges with `task-merged` and no verify events: merge closes at the last `task-merged`.
- `TestDigestTimingFinalLiveStep`: final stage checking with `FinalStage.StepTs` set and no `final-step` event yet: final is open from `StepTs`.
- `TestDigestTimingCancelledRun`: cancelled mid-execution: execution closed at the `dag-cancelled` ts, nothing open, `EndTs` set.
- `TestDigestTimingPruned`: a `task-done` with no matching `task-spawned` (pruned): `Partial` true and no panic or negative interval.

### Task 3: Timing view model
**Depends on:** Task 1

Files: `frontend/app/view/jarvis/runtiming.ts`, `frontend/app/view/jarvis/runtiming.test.ts`, `frontend/app/view/orchestrate/dagdigest.ts` (+ `dagdigest.test.ts`).

- `runTiming` per Interfaces. The axis spans `startts` -> `endts` (or `nowMs` while live). Each row's `left`/`width` are percents of that span; an open row ends at the axis end. A zero-length row still gets a small minimum width so it is visible. Durations use `formatElapsed` from `orchestrate/dagdigest.ts`.
- Labels: Planning, Execution, Task review, Merge & Verify, Final verification, Landing / wrap-up.
- Header: `<elapsed> elapsed` live; `Finished in <elapsed>` when the run is done; `Ended after <elapsed>` when terminal otherwise (`isTerminal` from `agents/runmodel.ts`).
- Summary (live only): first line names the tasks still executing (task state `running` or `stalled`), with plan ids `t-N` printed as `Task N`: one task -> `Task 3 is the last task still executing.` only when no task is pending/ready, else `Task 3 is executing.`; several -> `Tasks 3 and 4 are executing.`. No executing task -> no first line. Second line lists the activities, in display order, that have not started and still lie ahead (review, merge, final): `Its review and final verification are still ahead.` (singular `Its` with one executing task, `Their` with several, else name them plainly). No line when nothing is ahead.
- Notes: always `Elapsed since launch. Activities overlap; do not add these rows.` Terminal: `Longest activity: <label lowercased>, <duration>. This is not summed worker time.` Live: one sentence naming which open activities overlap and which have not started (e.g. `Review has overlapped execution. Final verification has not started.`). Partial: `Some early boundaries were pruned; rows may start late.`
- `REFRESH_EVENT_KINDS` in `dagdigest.ts` gains the boundary kinds Task 2 derives from (`task-spawned`, `task-done`, `task-failed`, `task-review-started`, `task-review-passed`, `task-review-failed`, `task-merge-started`, `task-merged`, `task-verify-passed`, `task-verify-failed`, `final-step`, `dag-done`) so a landing boundary refetches the digest. Update its test.

Tests (`npx vitest run frontend/app/view/jarvis/runtiming.test.ts frontend/app/view/orchestrate/dagdigest.test.ts`):
- completed run: six rows at minutes 0-8, 8-32, 18-34, 20-34, 34-41, 41-42 of 42. Five come from the prototype's completed sheet; the prototype has no Merge & Verify row, so its 20-34 is chosen by this plan, not read from the prototype. Check the rows' positions and durations, header `Finished in 42m`, axis `0m / 21m / 42m`, longest-activity note, `defaultOpen` true, empty summary.
- live run at 30m with task 3 running and nothing pending: header `30m elapsed`, open rows end at 100%, summary `Task 3 is the last task still executing.` and the still-ahead line, `defaultOpen` false.
- cancelled run: header `Ended after …`, no summary.
- planning-only live run: one row, open.
- zero-length activity: nonzero width.
- no `digest.timing`: returns null.
- `shouldRefreshDigest("task-spawned")` and `("final-step")` are true; an activity tick kind stays false.

### Task 4: Timing section in the run sheet
**Depends on:** Task 2, Task 3

Files: `frontend/app/view/jarvis/runtimingview.tsx` (new), `frontend/app/view/jarvis/runsheet.tsx`, `scripts/cdp/scenarios.mjs`.

- `RunTimingSection` renders `runTiming(...)` for a DAG-linked run (`dag != null` in `RunSheetFrame`), as the first child of the scrolling body, above the cards and tasks / report / evidence; nothing when the model returns null. Inputs: `run`, `dag.digest.digest`, `dag.group?.tasks`, `now` from the sheet context.
- Layout and type follow the prototype board: a full-width `button` with `aria-expanded`, a chevron that rotates 90° when open, `Timing` label, and the header right-aligned in mono; the live summary under it (visible collapsed or open); when open, the axis labels over the track column, one row per activity (label column ~132px, track `h-3` with the bar absolutely positioned by `left`/`width`, duration column ~42px right-aligned mono), then the notes. Colors by key per Decisions, tokens only. A bottom border separates the section from what follows.
- Open state: `useState(view.defaultOpen)`, reset when the run id changes.
- Mark the section `data-run-timing` and each row `data-run-timing-row={key}` for the scenario.
- Add CDP scenario `run-timing` to `scripts/cdp/scenarios.mjs`, built on `arrangeSheetDagRun`. It asserts, scoped to `[data-run-sheet]`: the Timing toggle exists with `aria-expanded="false"` on the live run and a header ending in `elapsed`; after a click it is `"true"`, a `planning` row is present with a bar of nonzero width and a duration, and the always-present note `Elapsed since launch. Activities overlap; do not add these rows.` shows (not the live overlap sentence, which this fixture does not produce deterministically); it screenshots the expanded section. Tear down what it created like the neighbouring sheet scenarios do.
- Acceptance: the Check line passes, `task verify:ui -- run-timing` passes against a dev app, and the existing `run-sheet-polish` scenario still passes (font floor covers the new text).
