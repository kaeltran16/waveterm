# The final stage, visible on the Agent surface and in the DAG

**Verify:** `node scripts/verify.mjs ./pkg/waveobj`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs final-stage agent-tree-rail dag-lifecycle dag-observability final-shots run-sheet-polish surface-smoke`
**Prototype:** C:/Users/kael02/IdeaProjects/waveterm/.superpowers/design/final-stage-visibility/project/Main.dc.html

An orchestrator run's final stage (Tree, Check, Verify, Final, then the verifier session) is most of a run's
unattended minutes, and today only the verifier agent gets a row in the Agents tree; the command steps are one
status string on the run row and one hover tooltip in the DAG's stage line. This plan gives the stage a row, a
pane, a rail block and a DAG node.

The mockup is the spec. Its folder holds three boards, and every task reads the ones it builds:
`Main.dc.html` (Agent surface: lead focused, and the Final verification row focused), `Dag.dc.html` (the DAG
with the final node selected), `States.dc.html` (the row and the node in each of nine states, and what opening
either shows). The folder is gitignored scaffolding in the main checkout: read it at that path, never copy or
commit it, never delete it (the lead deletes it after the run lands). In the mockup the run, tasks, scenarios
and the round 1 failure are real; the DAG edges, step durations, Verify output format, Check command and the
320px rail width are illustrative, so sizes, paddings and type come from the components already in the app.

## Decisions that bind every task

1. **No backend change.** Nothing under `pkg/`, `cmd/` or the generated files is edited. `TaskGroup.final` and
   `TaskGroup.pastfinals` (`FinalStage` in `frontend/types/gotypes.d.ts`) carry state, round, step, stepts,
   output, detail, unverified, verifierrunid, startedts, tree, commit, shots. A finished step's duration and
   result come from the run's `final-step` events (`detail`: `round`, `step`: tree | check | verify | final,
   `ms`, `ok`), read through `useRunEvents` / `runEventsAtom` (`frontend/app/view/agents/runeventstore.ts`).
2. **One pure model**, `frontend/app/view/agents/finalstage.ts`, derives everything every site draws. No site
   computes a step's state, a duration or a label itself, and no site reads `final.step` directly.
3. **Steps** are Tree, then Check, Verify and Final only where the dag has that command (`group.check`,
   `group.verify`, `group.finalcmd`), then Verifier. A dag with none of the three has the one step, Verifier.
   "step N of M" counts those steps.
4. **Engine facts the model rests on** (read `pkg/orchestrate/final.go` before relying on them):
   - `final.state`: `""` (a round not started), `checking`, `final`, `verifying`, `passed`, `unverified`,
     `failed`. `final.step` names the running command and is cleared when the commands end.
   - With no Final command the verifier works alongside Check and Verify: `state` is `checking` and
     `verifierrunid` is set. The engine tends (starts) a verifier on every tick while `state` is `checking`
     and `final.tree` is set, whatever the plan's commands; with a Final command it leaves `final.tree` empty
     until the commands end.
   - `final.startedts` is the round's start until a verifier session starts, then that session's start. The
     round's start is therefore the earliest `ts - ms` of the round's step events, else `startedts`.
   - A step's event is written when the step returns. A step a human stopped usually has none: its event is
     written with the context the stop cancelled, and the stop clears `final.step`. So the stopped step is
     derived, never read: in a stage whose `detail` or one of whose `unverified` reasons starts with
     `ended by the human:`, it is the first step with no passing event. The verifier has no step event.
   - A failed Tree step ends the stage `unverified`, not `failed`. A Final command that exits 3 is `ok: false`
     and the stage goes on to the verifier. A human's end writes `ended by the human: <reason>` into `detail`
     (failed) or `unverified` (unverified).
   - A fix round appends tasks with no dependency on the earlier ones, moves the failed round into
     `pastfinals` and sets `final` to `{ state: "", round: n + 1 }`.
   - The engine publishes the output tail at most every 10 seconds and keeps nothing for a finished step but a
     failure's `detail`.
5. **Durations come only from step events.** A step with no event shows its state with no time. A stage total
   shows only when every step has a time. The store holds a run's newest 200 events, so an old round's can be
   gone: that is the no-event case, never an error.
6. **The row.** It exists once the dag's status is `finalizing`, or `final.state` is not empty, or
   `final.round > 1`. Before a verifier session exists it is focused by an id of its own, as a done task's
   worker is (`endedWorkerId` is the pattern). When the current round's verifier session is in the roster, the
   row is that session and a focus sitting on the stage's own id moves to it. When that tab is gone the row is
   the stage's own again. There is never a second Final verification row for the current round. A verifier tab
   left from an earlier round stays the failed stage row it is today.
7. **Colors are `@theme` tokens** from `frontend/tailwindsetup.css`, never hex. No new token. Map the mockup's
   colors onto the ones the neighbouring rows already use (success, accent, warning, error, the edge and ink
   scales). Tailwind, no new SCSS.
8. **Selectors the scenario reads.** These attributes are a contract between tasks; do not rename them:
   - every drawn step, at every site: `data-final-step="<key>"` and `data-final-step-state="<state>"`
   - the output tail: `data-final-output`; the End final stage control: `data-final-end`
   - the tree row: `data-final-row` with `data-final-tone="<tone>"`; the strip's slot: `data-final-slot`
   - the middle pane: `data-final-pane`; the stage's details-rail section: `data-final-rail`
   - the lead's rail block: `data-final-block`; its link: `data-final-watch`
   - the DAG card: `data-dag-node="final"` with `aria-pressed`; its bottom rail: `data-dag-final-rail`
   - an earlier round's one line: `data-final-past-round="<n>"`

Repo rules: no new dependency. Never run `task dev`, `task check:ts` or `npm install` in a worktree; typecheck
with the Check line. Never run prettier on `scripts/*.mjs`. Never stop `wave-tauri.exe` or `wavesrv.x64.exe` by
image name. No `Co-Authored-By`, `Claude-Session` or other attribution trailer in a commit. Change nothing
outside the files a task lists. Comments say why, never what, in lower case, only where needed. No jsdom
render tests: logic goes in a pure `.ts` with a `.test.ts` beside it, and the rendered result is proved by the
CDP scenario in Task 5.

Out of scope: the Jarvis run sheet's behaviour, the peek, any new notification, plan review as a DAG node.

### Task 1: The final-stage model, its shared step views and the shared end form
**Depends on:** none
**Files:** `frontend/app/view/agents/finalstage.ts`, `frontend/app/view/agents/finalstage.test.ts`, `frontend/app/view/agents/finalstageviews.tsx`, `frontend/app/view/agents/endfinalform.tsx`, `frontend/app/view/jarvis/runsheet.tsx`

Build the pure model three other tasks draw from, the thin views they share, and move the run sheet's end form
to where all of them can use it.

**`finalstage.ts`** (pure: no React, no store). Reuse `finalStageActivity` and `finalStepCommand`'s rule from
`runlineage.ts` and `formatAgeShort` from `agentsviewmodel.ts`; do not restate them. Exports, which Tasks 2, 3
and 4 rely on by these names:

```ts
export type FinalStepKey = "tree" | "check" | "verify" | "final" | "verifier";
// notrun: the stage ended before it. stopped: a human ended the stage while it ran.
export type FinalStepState = "waiting" | "running" | "passed" | "failed" | "unverified" | "stopped" | "notrun";
export type FinalTone = "wait" | "run" | "pass" | "fail" | "warn";

export interface FinalStep {
    key: FinalStepKey;
    label: string;      // Tree, Check, Verify, Final, Verifier
    state: FinalStepState;
    tone: FinalTone;
    ms?: number;        // a finished step's duration, or a running step's elapsed
    text: string;       // "passed 41s", "running 3m 12s", "waiting", "not run", "failed 2m 05s"
    command: string;    // the plan's own command; for tree and verifier, what the step does
}

export interface FinalRoundLine { round: number; tone: FinalTone; text: string } // "round 1 · failed at Final"

export interface FinalStageView {
    visible: boolean;            // decision 6: whether the tree has a row
    round: number;
    state: string;               // final.state, "" when not started
    tone: FinalTone;
    steps: FinalStep[];
    running?: FinalStepKey;      // the command step running; the verifier when only it runs
    alongside: boolean;          // the verifier works beside a running command
    stepIndex: number;           // 1-based position of the running step, 0 when none
    elapsedMs?: number;          // the running step's elapsed, or a finished stage's total (decision 5)
    waitsOn: string[];           // ids of the tasks not done yet, in plan order
    output: string;              // final.output while a command runs, else ""
    detail: string;              // a failure's detail, whole
    unverified: string[];        // every reason, whole
    past: FinalRoundLine[];      // earlier rounds, oldest first
    subline: string;             // the tree row's second line
    nodeMeta: string;            // the DAG card's second line
    headline: string;            // the pane's header line: "round 1 · running Verify · 3m 12s"
    next: string;                // the Run status tail: "next Final, then the verifier"; "" when nothing follows
}

export function finalStageView(
    group: TaskGroup | undefined,
    events: RunEvent[],
    now: number,
    verifierRun?: Pick<Run, "completedts">
): FinalStageView;

export function finalStageId(runId: string): string;        // the stage's own focus id
export function isFinalStageId(id: string): boolean;
export function finalStageRunId(id: string): string | undefined;
// the id a click on the row focuses: the current round's verifier agent when it is in the roster, else finalStageId
export function finalRowFocusId(
    run: Pick<RunInfo, "runId" | "dag">,
    agents: Pick<AgentVM, "id" | "runId">[]
): string;
export function outputTail(output: string, lines: number): string;  // the last `lines` lines
```

`verifierRun` is the Run object of the current round's verifier session, `run:<final.verifierrunid>`. Every
site that draws the stage reads it from the object store as `endedWorkerAtomFor` reads a task's child run
(`WOS.getWaveObjectAtom<Run>(WOS.makeORef("run", id))`), and passes undefined while there is no verifier or
the object has not loaded. `finalstageviews.tsx` exports one hook for that,
`useFinalStageView(group: TaskGroup | undefined, runId: string, channelId: string, now: number): FinalStageView`,
which reads the run's events (`useRunEvents`) and the verifier's Run and returns the view, so no site wires
the three inputs itself.

The texts are the States board's, word for word in shape:

| State | `subline` | `nodeMeta` |
|---|---|---|
| tasks still running | (no row) `after 3 more tasks` | `waits on every task` |
| preparing the tree | `Tree · 22s · step 1 of 5` | `round 1 · Tree · 22s` |
| a command running | `Verify · 3m 12s · step 3 of 5` | `round 1 · Verify · 3m 12s` |
| verifier alongside | `Check · 11s · verifier alongside` | `round 1 · Check · verifier` |
| verifier reviewing | `verifier reviewing · 4m 02s` | `round 2 · verifier · 4m 02s` |
| failed | `failed at Final · round 1` | `round 1 · failed at Final` |
| fix round under way | `round 2 after 2 fix tasks` | `round 2 waits on t-8, t-9` |
| unverified | `unverified · 1 reason` | `round 2 · unverified` |
| passed | `passed · 14m 22s` | `round 2 · passed · 14m 22s` |

A time that is unknown is left out with its separator (`passed`, `round 2 · passed`), never shown as zero.

`finalstage.test.ts` proves, one test each:
- each of the nine rows above yields its `subline`, `nodeMeta`, `tone` and step states (the board's segment
  colours: wait, run, pass, fail, warn), with `visible` false only for the first;
- steps follow decision 3: a dag with all three commands has five; with no `finalcmd` four; with none, one;
- a running step's `ms` is `now - stepts`, and a step with `stepts` 0 has no time;
- steps before the running one read `passed` whether or not their events arrived, with a time only from an event;
- a failed stage: the step whose event is `ok: false` is `failed`, every later step `notrun`, `detail` whole
  and untrimmed; with every command step `ok` the Verifier is `failed`;
- a failed Tree step in an unverified stage reads `unverified` and the rest `notrun`;
- a Final command that exited 3 (`ok: false`, stage went on) does not make the Verifier `notrun`;
- a stage a human ended (decision 4): the first step with no passing event is `stopped` and the later ones
  `notrun`, with no event for the stopped step and with an `ok: false` one alike; the reason is in `detail`
  or `unverified` whole, for both outcomes; ended while only the verifier ran, the Verifier is `stopped`;
- events of another round are ignored, and of two events for one round and step the newer wins (a restart
  reruns a step);
- with no events at all: no step has a time, the total is absent, nothing throws, and a finished stage's
  steps still read by its state;
- the total is the sum of the steps' times and shows only when every step has one; the Verifier's time is
  `startedts` to `verifierRun.completedts`, absent when either is missing;
- the round's start comes from the earliest step event once a verifier has moved `startedts`;
- `past` gives one line per `pastfinals` entry, oldest first;
- `group` undefined, and a dag with no tasks, return an invisible view with no steps running;
- `finalRowFocusId` returns the verifier agent's id only when an agent's `runId` equals the current round's
  `verifierrunid`, and `finalStageId(runId)` otherwise, including for an agent left from an earlier round.

**`finalstageviews.tsx`**: the thin views the three sites share, each taking a `FinalStageView` (or its
steps) and drawing nothing the model did not decide. Every step element carries `data-final-step` and
`data-final-step-state`.
- `FinalStepList`: one row per step, mark, label, state text (Main board, the rail's list).
- `FinalStepCells`: the pipeline grid, one bordered cell per step, the running one accented; `showCommand`
  adds each step's command under it (Dag board's bottom rail).
- `FinalStepStrip`: the 3px segment strip (the DAG card, States board).
- `FinalOutput`: the output tail in a mono block, `data-final-output`; takes `lines`.
- `FinalOutcome`: the failure's detail whole, every unverified reason, and one `data-final-past-round` line
  per earlier round. Long text scrolls inside it; it is never truncated.
- `FinalShotsLink`: when `finalCheckEntry(group)` (`jarvis/finalshotsmodel.ts`) has screenshots, a link that
  mounts the existing `FinalShotsViewer` (`jarvis/finalshotsviewer.tsx`); renders nothing otherwise.
- `EndFinalStage`: the End final stage button (`data-final-end`), shown only while
  `finalStageEndable(group)` (`jarvis/runsheetmodel.ts`), opening `EndFinalForm`; a refusal from the engine
  is shown beside it, never swallowed.

**`endfinalform.tsx`**: move `EndFinalForm` out of `runsheet.tsx` unchanged in behaviour, taking
`{ channelId, runId, onClose, onError }` instead of the sheet's context. `runsheet.tsx` imports it; the run
sheet looks and behaves exactly as before, and keeps its `data-run-sheet-end-final` attribute. That edit is
the only change to `runsheet.tsx`.

Acceptance: `npx vitest run frontend/app/view/agents/finalstage.test.ts` passes; the Check line is clean. The
views have no scenario step of their own: Tasks 2, 3 and 4 mount them, and Task 5's `final-stage` scenario
shows each. The moved form is shown by the existing `run-sheet-polish` and `final-shots` scenarios, which the
Final line runs.

### Task 2: The Final verification row, the stage pane and the stage's rail
**Depends on:** Task 1
**Files:** `frontend/app/view/agents/runlineage.ts`, `frontend/app/view/agents/runlineage.test.ts`, `frontend/app/view/agents/runlineagestore.ts`, `frontend/app/view/agents/agents.tsx`, `frontend/app/view/agents/agenttreemodel.ts`, `frontend/app/view/agents/agenttreemodel.test.ts`, `frontend/app/view/agents/agenttree.tsx`, `frontend/app/view/agents/runstrip.ts`, `frontend/app/view/agents/runstrip.test.ts`, `frontend/app/view/agents/runmodel.ts`, `frontend/app/view/agents/runmodel.test.ts`, `frontend/app/view/agents/agentsurface.tsx`, `frontend/app/view/agents/finalstagepane.tsx`, `frontend/app/view/agents/agentheader.tsx`, `frontend/app/view/agents/agentdetailsrail.tsx`, `frontend/app/view/agents/finalstagerail.tsx`

Boards: `Main.dc.html` with the Final verification row focused (click the row in the canvas), and the AGENT
TREE ROW and OPENED columns of `States.dc.html`.

Consumes from Task 1: `finalStageView`, `finalStageId`, `isFinalStageId`, `finalStageRunId`,
`finalRowFocusId`, and the views and the `useFinalStageView` hook in `finalstageviews.tsx`. The row, the
pane and the rail each get their view from that hook, which supplies the run's events and the verifier's Run.

**The tree** (`agenttreemodel.ts`, `agenttree.tsx`). `runRows` adds one row, `{ kind: "final"; project; run;
agent?: AgentVM }`, per decision 6: `agent` is the current round's verifier session when it is in the roster
(its `runId` equals `run.dag.final.verifierrunid`), and that session then gets no `stage` row of its own. The
row sits where a judging stage sits today, after the live tasks; once the stage has passed it folds into the
run's finished group as a verdict does, and the `done` fold's `stages` count includes it. A failed or
unverified stage keeps its row out of the fold. It counts toward the lead's `live` only while the stage runs.
The row's title is Final verification, its second line the model's `subline`, its mark by `tone` as the
States board draws it (a hollow dot waiting, the accent dot with its halo running, error, warning, a check
passed). A click focuses `finalRowFocusId`. `buildAgentTree` gains the run's events only if the model needs
them for the row; if it does, pass them in as an argument, keeping the function pure.

**The strip** (`runstrip.ts`). A `finalSlot(dag)` returning the slot's state, or undefined before the row
exists; the tree's strip draws it after a gap, wider than a task's slot (Main board), with
`data-final-slot`. `taskStrip` and `taskStripLabel` are unchanged, and so are their other callers (the
cockpit's lead card, the run sheet). The tree's strip gets its label from a new `treeStripLabel(dag, digest)`
in `runstrip.ts`, which is `taskStripLabel` plus the final stage's state once the slot exists ("7 of 7
tasks done, final verification running").

**The run row's line** (`runmodel.ts`). While the dag is finalizing `dagProgressLabel` reads `7/7 ·
verifying`: the step now has a row of its own, so the run row stops repeating it.

**Focus** (`runlineage.ts`, `runlineagestore.ts`, `agents.tsx`, `agentsurface.tsx`). The stage's own id is
focusable without being mountable, exactly as an ended worker's is: a derived atom on the view model gives
the focused stage (its run, and a synthesized `AgentVM` named Final verification with no block), `lineage.roles`
gives that id a `stage` role with `stageRole: "verifier"` so the header and the rail place it under its run,
and `AgentSurface` resolves it beside `ended?.agent`. While the focus is the stage's own id and the current
round's verifier session is in the roster, an effect moves the focus to that session. Nothing else about
focus defaulting changes: a stale stage id (its run gone from the roster) falls back as any unknown id does.

**The pane** (`finalstagepane.tsx`), shown where the terminal would be while the stage's own id is focused,
`data-final-pane`: a header (the dot by tone, Final verification, the model's `headline`, `EndFinalStage` on
the right), `FinalStepCells`, then by state, as the OPENED column says:
- a command running: the running step's command as a `$` line, `FinalOutput` filling the rest, and the note
  that the engine publishes the tail every 10s; with no output yet (Tree, or a command's first seconds), the
  step list alone and no empty box;
- failed, unverified, passed, fix round under way: `FinalOutcome` and `FinalShotsLink`; for a failure, that
  the lead has it; later steps read not run.
The pane takes the run's events from `useRunEvents(run.runId, run.channelId)` and `now` from
`model.nowAtom`, so elapsed times tick.

**The header** (`agentheader.tsx`). The stage's own id must not offer what needs a session (close, rename,
canvas, reply); it shows the row's title under its run as a stage session's does.

**The stage's rail** (`finalstagerail.tsx`, mounted from `agentdetailsrail.tsx`), `data-final-rail`: the
section a Final verification row shows, for the stage's own id and for the verifier's session alike. Facts:
Round, Commit (short), Tree, Reviewers (the route from `reviewerRouteOf` in `orchestrate/taskroute.ts`), then
`FinalStepList`, `FinalShotsLink`, and one line per earlier round. For the verifier's session the rest of
its rail stays as today.

Tests, in the files above:
- `agenttreemodel.test.ts`: no row while tasks run and the stage has no state; a row once finalizing with no
  stage session; with the current round's verifier in the roster there is exactly one row and it carries
  that agent; an earlier round's verifier tab stays a failed `stage` row beside the current round's `final`
  row; a passed stage's row is inside the done fold and counted; a fix round under way has a row; the lead's
  `live` counts the row only while the stage runs;
- `runstrip.test.ts`: `finalSlot` undefined before the row exists, and its state for running, failed,
  unverified and passed; `treeStripLabel` equals `taskStripLabel` before the slot exists and names the
  stage's state after;
- `runmodel.test.ts`: the finalizing label;
- `runlineage.test.ts`: the stage id's role.

Acceptance: `npx vitest run frontend/app/view/agents/agenttreemodel.test.ts
frontend/app/view/agents/runstrip.test.ts frontend/app/view/agents/runmodel.test.ts
frontend/app/view/agents/runlineage.test.ts` passes; the Check line is clean. Shown by Task 5's `final-stage`
scenario: the step "the tree has one Final verification row naming the running step" for the row and the
slot, "the focused row shows the pipeline, the running command and its output" for the pane and the stage's
rail, and the States steps for each other state of the row and the pane.

### Task 3: The lead's rail: the Final verification block and Verifying
**Depends on:** Task 1
**Files:** `frontend/app/view/agents/runrailsections.tsx`, `frontend/app/view/agents/runrail.ts`, `frontend/app/view/agents/runrail.test.ts`

Board: `Main.dc.html` with the lead focused (its default view), the right-hand rail.

Consumes from Task 1: `useFinalStageView` (which supplies the run's events and the verifier's Run),
`finalRowFocusId`, `outputTail`, `FinalStepList`, `FinalOutput`.

In `RunSection`, between the run's status and its lanes, a Final verification block (`data-final-block`)
whenever the model's `visible` is true: the section label with `round N` and the stage's time on the right,
`FinalStepList`, the last lines of output while a command runs (a named constant for how many; the mockup
shows three), and a link, "watch the output" (`data-final-watch`), that sets `model.focusIdAtom` to
`finalRowFocusId(run, agents)`. With no output the tail box is not drawn. Once the stage has ended the link
reads for what it opens (the failure, the reasons) and the block keeps the step list; an earlier round is one
line.

The Run status line reads `Verifying` in the accent tone while the dag's status is `finalizing`, with the
model's `next` as its tail ("· next Final, then the verifier"). A question waiting on the human still wins,
as it does today. Decide the headline in a pure function in `runrail.ts` so it is tested; `RunStatus` only
draws it.

Tests in `runrail.test.ts`: the headline is Verifying while finalizing, is what it was for every other
status, and yields to waiting-on-you; the tail constant cuts the output to its last lines.

Acceptance: `npx vitest run frontend/app/view/agents/runrail.test.ts` passes; the Check line is clean. Shown
by Task 5's `final-stage` scenario, step "the lead's rail has the Final verification block and reads
Verifying", and the step that clicks the block's link and lands on the row.

### Task 4: The final stage as the DAG's last node
**Depends on:** Task 1
**Files:** `frontend/app/view/orchestrate/dagfinal.ts`, `frontend/app/view/orchestrate/dagfinal.test.ts`, `frontend/app/view/orchestrate/dagfinalrail.tsx`, `frontend/app/view/orchestrate/daggraph.tsx`, `frontend/app/view/orchestrate/dagnodes.tsx`, `frontend/app/view/orchestrate/dagcanvas.ts`, `frontend/app/view/orchestrate/dagcanvas.test.ts`, `frontend/app/view/orchestrate/dagdetailrail.tsx`, `frontend/app/view/orchestrate/taskroute.ts`, `frontend/app/view/orchestrate/taskroute.test.ts`

Boards: `Dag.dc.html`, and the DAG NODE and OPENED columns of `States.dc.html`.

Consumes from Task 1: `useFinalStageView` (which supplies the run's events and the verifier's Run; the
graph calls it once with the dag's own run id and channel, and hands the view to the card and the rail),
`finalRowFocusId`, `FinalStepStrip`, `FinalStepCells`, `FinalOutput`, `FinalOutcome`, `FinalShotsLink`,
`EndFinalStage`.

**`dagfinal.ts`** (pure): `FINAL_NODE_ID = "final"`, and `withFinalNode(tasks)` returning the layout's tasks
with one more, the final node, depending on every task no other task depends on. That one rule gives it the
edges from the plan's sink tasks and, in a later round, from the fix round's tasks, which depend on nothing
before them. A dag with no tasks gets no final node. Also here: the style of an edge into the final node
(live while the stage runs, waiting while a source task is not done, satisfied once it has ended), in the
vocabulary `edgeStyle` in `dagcanvas.ts` already has.

**The graph** (`daggraph.tsx`, `dagnodes.tsx`). The layout runs over `withFinalNode(tasks)`, so the node is
the last column from the start of the run. Lane bands still come from the tasks alone (`lanesOf` mirrors the
engine's lanes). The node is a new node type, the card's size (`CARD_W` by `CARD_H`), not draggable and with
no stored offset: its glyph by tone, Final verification, the model's `nodeMeta`, and `FinalStepStrip`
(`data-dag-node="final"`, `aria-pressed` when selected), with "on the merged result" under it as the board
shows. A click selects it through `selectedTaskIdAtom`; selecting it dims nothing it should not (its
relatives are every task). The arrow keys reach it (`graphKey` takes the layout's tasks), and Enter on it
opens the verifier in Agent when one exists. Wherever the code looks a selected id up among the tasks, the
final node's id must not read as a missing task.

**The bottom rail** (`dagfinalrail.tsx`, `data-dag-final-rail`), shown in place of `DagDetailRail` while the
final node is selected: the meta line (`final · round N · <state>`), Final verification, the verifier's line
(the reviewers' route from `reviewerRouteOf`, and when it starts: after Final, or alongside), `EndFinalStage`
on the right, `FinalStepCells` with `showCommand`, then the running output tail, or `FinalOutcome` and
`FinalShotsLink` once the stage has ended. When the current round's verifier session is in the roster, an
Open in Agent link focuses it the way a task's worker link does (`openTaskWorker` in `taskcorrelate.ts` is
the pattern; the roster comes from `dagModalAgentsContextAtom`). The rail's height stays bounded as the
task rail's is: long detail scrolls inside it.

**The stage line** (`taskroute.ts`). `stageEntries` returns the plan review only, when one ran; the "final
verify" entry and its tooltip are gone, with the code that built them. With no plan review the line shows the
run's route alone.

Tests:
- `dagfinal.test.ts`: the final node depends on exactly the tasks nothing depends on; a chain gives one edge,
  a fan gives one per leaf; appended fix-round tasks add their own sinks; no tasks, no node; the edge style
  for a source not done, a running stage and an ended one;
- `dagcanvas.test.ts`: ArrowRight from a sink task selects the final node, ArrowLeft from it returns to a
  sink, and `j` reaches it last;
- `taskroute.test.ts`: `stageEntries` is empty with no plan review and holds only the plan review with one;
  the tests of the removed final entry are removed with it.

Acceptance: `npx vitest run frontend/app/view/orchestrate/dagfinal.test.ts
frontend/app/view/orchestrate/dagcanvas.test.ts frontend/app/view/orchestrate/taskroute.test.ts` passes; the
Check line is clean. Shown by Task 5's `final-stage` scenario: the step "the DAG's last node is the final
stage, with an edge from each sink task", the step "selecting it opens the rail with each step's command and
the output tail", and the States steps for the node. The existing `dag-lifecycle` and `dag-observability`
scenarios, which the Final line runs, show the graph is otherwise as it was.

### Task 5: The final-stage scenario
**Depends on:** Task 2, Task 3, Task 4
**Files:** `scripts/cdp/scenarios.mjs`, `docs/reference/cdp-run-fixtures.md`

One scenario, `final-stage`, added to `SCENARIOS`, that shows every view this plan adds. Read
`docs/reference/cdp-run-fixtures.md` first and reuse its helpers (`arrangeFixtureRun` with a fixture lead as
`agent-tree-rail` does, `seedDag`, `waveService`, `teardownFixtureRun`); do not write a second seeding
mechanism. Read every element through the selectors of decision 8, scoped to its container
(`[data-agent-tree]`, `[data-dag-modal-kind]`), never by a document-wide text search. Pin the viewport
(1600 by 950) before reading layout. Wait for what is visible, not for a write.

**The fixture's two traps, both in the engine, both verified in `pkg/orchestrate/final.go`:**
1. The engine acts on a dag that is `finalizing`. Each tick it starts the stage's commands if none are
   running, and it starts a real verifier session whenever the stage is `verifying`, or is `checking` with
   `final.tree` set (`advanceFinal`, whatever the plan's commands). A seeded finalizing dag is therefore
   run, not left alone, and a seeded `final.tree` spawns a verifier.
2. A run's events cannot be written through an RPC. The page appends whatever arrives as a `run:event` wave
   event scoped to `run:<id>` (`runeventstore.ts`), so `eventpublish` with a `RunEventData` payload puts a
   `final-step` event in the page's store, once a view reading that run's events is mounted.

So the scenario has two parts.

**Part A, a dag really in `finalizing`, run by the engine.** Make the fixture's temp dir a git repository
with one commit before the run is created, so the stage can make its own tree. Seed every task done and
merged, a `finalcmd` (any non-empty command: with one the engine leaves `final.tree` empty while the
commands run, so no verifier is tended), a `verify` that prints a few lines and then sleeps long enough to
outlast the scenario, no `check`, no `setup`, and no `final` at all (or one with no `tree`). The engine
then starts round 1 itself: it runs the Tree step (a detached worktree beside the temp dir), writes that
step's real `final-step` event, and runs Verify for real, so `final.step`, `stepts`, `output` and the Tree
step's time are all the engine's own and nothing in Part A is published by hand. Confirm against the engine
that this is what a tick does before building on it, and assert in step 0 that `final.verifierrunid` and
`final.tree` are empty while Verify runs; if the engine does otherwise, find the smallest seed that leaves a
finalizing dag with a command running and no verifier spawned, and say what you used in the fixtures doc.
Never let the scenario spawn a verifier session. Teardown's run cancel stops the command and the engine
removes the tree; the temp dir's removal must still succeed if the tree is left. Wait for the output tail to appear (the engine publishes it at most every 10 seconds). Steps, each
with a screenshot under `cdp-shots/`:
- the tree has one Final verification row naming the running step (`Verify · … · step N of M`), and the
  run's strip has its final slot;
- the lead's rail has the Final verification block, with the Tree step's time from the engine's event, the
  output's last lines, and the Run status reads Verifying;
- clicking the block's link focuses the row, and the focused row shows the pipeline, the running command and
  its output, the stage's facts and step list in the rail, and End final stage;
- the DAG's last node is the final stage, with an edge from each sink task, and the stage line has no "final
  verify" entry;
- selecting it opens the rail with each step's command and state, the output tail and End final stage;
- End final stage, with a reason, as unverified: the row, the pane and the node all read unverified, the
  reason is shown whole, and Verify, the step that was running, reads stopped whether or not its event
  arrived. This is the States board's "the same when you ended the stage yourself".

**Part B, the other States rows, seeded on a dag the engine leaves alone.** As `final-shots` does: a dag
with a task still not started is never finalizing, so the engine never touches its `final`. For each row
seed `final` and `pastfinals` (and the round's step events through `eventpublish`), then assert the node's
second line and strip in the DAG and, where the row exists, the tree row's second line and what opening it
shows:
- tasks still running: no tree row; the node reads `waits on every task`;
- preparing the tree: Tree running, the step list and no output box;
- verifier alongside (no `finalcmd`): four steps, the Verifier running beside Check;
- verifier reviewing, the row as the stage's own: every command step passed, the Verifier running, and no
  roster agent holds `verifierrunid`, which is the state after the verifier's tab is gone;
- verifier reviewing, the row as the verifier's session (the board's "The row is the verifier's session").
  This needs a verifier Run and a roster agent, both seeded, never spawned: create a second deferred run in
  the fixture's channel and write `stagerole: "verifier"`, `dagoref` (the dag's bare id), a start and no
  completion onto it through `object.UpdateObject`; give the fixture roster an agent whose `runId` is that
  run's id (the roster is read at boot, so it is in the roster file before the reload). Focus the stage's
  own row first, then seed `final.verifierrunid` with that run's id, and assert: the focus moved to the
  agent; the tree has exactly one Final verification row and it is the agent's; that agent's rail has the
  `data-final-rail` section with the step list; in the DAG, the final node's rail has the Open in Agent
  link, and Enter on the selected node lands on the Agent surface with that agent focused;
- failed at Final in round 1, with the round's `shots` and `outdir` seeded as `final-shots` seeds them
  (reuse its fixture writers): the failing step's detail whole, the Verifier not run, and the screenshots
  link present in the pane and in the DAG rail, opening the existing viewer (`[data-final-shots-viewer]`);
- fix round under way: round 2 waiting, round 1 as one `data-final-past-round` line;
- passed in round 2: write a completion time onto the seeded verifier Run, keep it as `verifierrunid`, and
  publish every command step's event; each step shows its time, the row and the node show the total, and the
  tree row is inside the run's finished group. Then drop one step's event (reload, publish the rest) and
  assert the total is gone while the states stay.

Because the model keys the row on the stage's state as well as the dag's status (decision 6), these rows
draw on a dag that is not finalizing. Step 0 asserts the arrange outcome with what was observed. Teardown
cancels the run (which stops the engine's commands), restores any UI state the scenario changed, and removes
the temp dir; a teardown that throws fails the scenario.

`docs/reference/cdp-run-fixtures.md` gains a short section on the two traps and the fixture that works, so
the next scenario with a final stage does not rediscover them.

Acceptance: `CDP_PORT=<port> task verify:ui -- final-stage` is not available to a worker (no dev app in a
worktree), so the proof is the Final line, which runs `final-stage` on the merged result; before completing,
check the scenario parses and is registered with `node -e "import('./scripts/cdp/scenarios.mjs').then(m =>
{ if (!m.SCENARIOS.some(s => s.name === 'final-stage')) process.exit(1) })"` (adjust to how `SCENARIOS` is
exported), and that every selector it reads is one decision 8 names and Tasks 2, 3 and 4 emit.
