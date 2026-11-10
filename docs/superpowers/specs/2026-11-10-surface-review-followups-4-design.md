# Surface review follow-ups, round 4: design

Source: `cdp-shots/review/followups-4/report.md` in the main checkout (gitignored), findings F1-F8, initiative
effort:fdea6d43-219b-4cf2-b4ce-51758338103b chunks 78-80 and 82-86. Each finding was checked against HEAD
92cbb8591 before this was written; every one still happens (F1, F2, F4, F6, F7, F8 read in code; F3 and F5 are
rendered states the agent-tree-rail fixture still sets up the same way, so their workers confirm them live first).

## D1. The server refuses a prompt no terminal can take (F1)

`AgentPromptCommand` refuses, before it answers, a block id that:

- is not in the store (the tab was closed, or the id was made up), or
- has neither a running block controller nor a mod control stream (`agentctl.Has`).

Why both: the delivery path (`orchestrate.SendToSession` -> `overStream` or `typeWake`) can only reach a block
through one of those two. A block with neither fails later in a goroutine that only logs, which is the silent drop
the finding is about. Refusing exactly what delivery cannot do keeps the rule from drifting from the path.

The error names the block and says nothing was sent ("block <id> has no live terminal: nothing was sent", or "no
longer exists"). The readers are package vars, as `tabAgentBlock` and `blockTranscriptMeta` already are, so the
Go test needs no store or controller.

The Brief composer already sends before it posts the directive and treats a throw as "nothing was sent", so its
behaviour on a refusal is right as it stands; its CDP step drops the `failRpc` stub and lets the real server refuse
the fixture's made-up block, which proves the refusal end to end. The other frontend callers each must surface the
error to the user (none may swallow it); fixtures that relied on a made-up block being accepted are fixed to stub
the RPC, create a real block, or expect the refusal.

## D2. The run carries its plan title (F2)

`waveobj.Run` gains `Title string json:"title,omitempty"`: the plan title, copied from the dag where the owning
run's `DagORef` is set at first submit (`pkg/wstore/wstore_dag.go`) and again where a revised plan replaces the
dag's title (`pkg/orchestrate/planreview.go`, `g.Title = proposed.Title`). The frontend names a run by
`dag.title`, else `run.title`, else the goal's first line. `runInfoOf` records on `RunInfo` whether that title is a
plan title (from the dag or the run), and `leadDisplayName` treats a known plan title as the lead's name, falling
back to the tab name only when neither exists. Because the knowledge lives on `RunInfo`, every caller that names a
lead from a `RunInfo` (the Brief composer, the cockpit's run action in `cockpit/actions/run.ts`, the worker header,
the rail) gets the fix with no change at the call site.

Why on the run: the Brief composer already holds the `Run` object when it mounts; the dag is a second object fetch.
Only the run can name the plan before that fetch lands, and a field set once at submit is the smallest way to get
there. Runs from before the field fall back to the dag as today, so no backfill.

## D3. A worker tab is placed from its first frame (F3)

The worker's first-frame row placement must not depend on any object that loads after the tab appears in the
roster. Placement can come from data the tree already has (the lead's dag lists each task's `runid`), or the tab
stays hidden until it can be placed; never a row of its own that later moves. The worker finds what places it
late and fixes it in the model (`agenttreemodel.ts` / `runlineage.ts`), with a unit test of the not-yet-loaded case.

agent-tree-rail step 9c samples the tree from the inject onwards and fails on any frame where the worker tab
renders anywhere but its task's worker row.

## D4. Early start needs one lane holding every dependency (F4)

`startBase` (pkg/orchestrate/scheduler.go) lets a task start on an unmerged lane's tip only when every one of the
task's cross-lane dependencies is in that one unmerged lane. A task with any other cross-lane dependency (one
merged onto the landing head, or one in a second lane) waits until all its cross-lane lanes have merged, then
starts on the landing head.

Why this rule: the lane tip's branch was cut when that lane started, so it holds nothing merged since. Proving a
merged dependency is in the tip would take either git ancestry checks in the pure scheduler or reasoning about the
lane's own transitive dependencies; the finding asks for the simplest rule that guarantees every dependency is in
the base. The cost is a short wait (the other lane's review and merge) in the diamond shape only.

In practice this makes early start single-dependency only: `jarvis.Lanes` (pkg/jarvis/plan.go) gives any task with
two or more dependencies its own lane, and a non-tip lane member has exactly one dependent, so a join's
dependencies never share one lane. A fork (one cross-lane dependency) still starts early on its predecessor's tip;
a join waits for every lane it depends on to merge. This is the one intended behaviour change:
`TestStartBaseJoinOneUnmergedPredecessor` (pkg/orchestrate/earlyready_test.go), which asserted the buggy start, is
the repro and is rewritten to the new rule.

## D5. The CDP boot wait includes the RPC client (F6)

The wait attach.mjs uses for "the app has booted" (the first attach, `goto` and `reload`) also requires
`window.TabRpcClient`. Same timeout, same failure message shape; no retry. The wait is one exported helper
(`waitBooted(ev, ms)`) used by attach, `goto` and `reload`, so it is unit-testable with a fake `ev`.

## D6. go mod tidy waits for the mod copy (F7)

`go:mod:tidy` takes `sync:claudemod` as a dependency, so in one `task` invocation tidy can never start while the copy
rewrites `cmd/wsh/cmd/claude-*`. `sync:claudemod` is also `run: once`: without it Task (3.51.1) runs a dependency
once per reference, so `tauri:dev` and tidy would each start their own copy at the same time.

## D7. The CLI names why a held tip waits (F8)

`taskSignal` receives the holder's state and words it as the cockpit's `mergeGateLine` does: `verifying` ->
"Verify", `verify-failed` -> "failed Verify", `blocked-merge` -> "merge conflict"; any other state -> plain
"merge held". The reason words live in one Go map beside `taskSignal`; the frontend keeps its own map (two
languages, no shared source).

## D8. F5: the agent-tree-rail worker tab is a real block

The injected worker tab gets a real block (created in arrange, deleted in teardown) instead of
`fx-blk-tree-worker-t1`, so its header and rail read as a running worker, and a step asserts the header shows no
error text. Under D1 a prompt to it either reaches that block or is refused; either is acceptable.
