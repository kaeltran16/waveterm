# Run tab polish: step rows, Activity timeline, Lanes | Focus graph

**Verify:** `node scripts/verify.mjs ./pkg/waveobj`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs workspace-run workspace-run-activity workspace-run-graph workspace-pane dag-observability`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\run-tab-polish

The workspace pane's Run tab (`frontend/app/view/agents/workspaceruntab.tsx`, `workspaceruntabmodel.ts`), rebuilt
to the prototype canvas. Its boards: **Main** (live run: head, Tasks, Activity, Graph), **Done** (finished run) and
**Graph** (Lanes | Focus at 8, 21 and 39 tasks; the 21 and 39-task dags are `FD.b` / `FD.c` with `LD.b` / `LD.c`
in `Graph.dc.html`'s script). The canvas is the spec: match its layout, type, colours (through the `@theme`
tokens, no new ones) and copy. Out of scope: the Changes tab's own content and the DAG modal itself (its timeline
keeps working, unchanged, through the shared pieces).

## Decisions beyond the design

1. **Graph state lives on the run tab.** `WorkspaceTab`'s run variant gains `graph?: RunGraphState` (mode, the one
   shared selected task, the Focus back trail), beside `view`. One source of truth that the Esc binding reads from
   `workspaceAtom`, and that survives a view swap; hover stays local component state. The workspace state is not
   persisted, so dropping `"asks"` from `RunView` needs no migration.
2. **Who answered** is not recorded on `child-answered`. The tab derives it: "you" when a `task-forwarded` event for
   the task (a lead forward or a take-over, both record one) lies between the `child-ask` and its `child-answered`,
   else "the lead". The answer text is never shown.
3. **Queued reason** comes from the digest: `DagTaskDigest.waitreason === "parallelism"` reads "waits for a free
   worker"; any other not-started task with no unmet deps reads "queued".
4. **Latest worker steps** are read only for a running task whose row is open: `loadRunTranscriptPath(channel,
   task.runid)` / `runTranscriptPathsAtom`, then a stream the tab owns, under its own id
   `runtab-steps:<runId>:<taskId>` (`startTranscriptStream` / `stopTranscriptStream` in `livetranscript.ts`, read
   with `entriesAtomFor` from `livetranscriptatoms.ts`), so closing the row never stops the worker's own stream in
   another view; projected by `transcriptlayout.ts`, the last 3 steps, drawn with the transcript's step rows. The
   stream stops when the row closes or the tab unmounts. No path ("") means no steps, and nothing else stands in.
5. **Dots** are the tab's own (`taskDots`), read from each task's state and `workerAsk`, not from `runSegments`
   (which says "working" for a lead-held question and "done" for both merged and done-awaiting-merge): merged
   (green: `task.merged` and not verifying), working (accent, pulsing: running with no question, verifying even when
   merged, reviewing, done awaiting merge), asked (amber, pulsing: a question with the lead or with you), failed
   (red: failed, verify-failed, review-failed, blocked-merge), waits (faint: pending, ready, skipped, cancelled).
   Pulsing is the `pulse-dot` class the always-mounted `PulseDriver` drives; no CSS animation. **The tab's head
   strip** draws from `taskDots` too (unpulsed fills, `STRIP_MAX`'s one-bar fallback kept), so strip and dots agree
   and t-3 is amber as on the Main board; `runSegments`, `taskStrip` and `SEG_FILL` stay as they are for the rail,
   the tree and the lead card.
6. **State words.** Tasks rows use the engine's words (`taskState`), except that a merged row and a plainly running
   one (no question, not verifying or reviewing) show none, only their time, as the canvas's t-1 and t-4 do: the
   dot says it. The Done board's "sent back once" is left out: the engine records no send-back event to count.
   Lanes and Focus use the short words of the canvas: none for merged, "working", "asked the lead" / "asking you",
   "failed", "waits".
7. **Lanes draws the reduced graph, Focus the task's own deps.** Lanes drops transitively implied edges (a gutter of
   them is noise); Focus's "waits on" lists every dep the engine waits on.
8. **Activity's Task filter** is picked by a row's task pill ("Show only this task"), local to the view, as the
   canvas has it; it is not the Graph's selection. Rows open to their events; no Lifecycle header, no Relaunch lead.
9. **Activity reuse:** `timelinerail.tsx` exports its pieces (strip, filter bar, now marker, quiet gap, group row,
   empty rows) with the modal-only parts (relaunch, graph hover, modal selection routing) as optional props; the
   modal's `TimelineRail` composes them as it does today, the tab composes them without the header and relaunch.
10. **Open changes** opens the existing Changes tab beside (`openBeside` with `{ kind: "changes", selected: <the
    task's first evidence file> }`), shown only on a task whose worker run has evidence files.
11. **Plan review / Final verification rows** read `dag.planreview` and the final stage (`dag.final`, through
    `finalStageView` for a running step's text); they are stage rows, not tasks, and are not counted in "Tasks N".
    The tab's own words win over `finalStageView`'s (which stays as it is for its other callers): waiting reads
    "waits for every task", passed reads "passed · N scenarios" with N the final stage's `shots` count (just "passed"
    with none), failed reads "failed", running reads the step `finalStageView` names. Lanes shows the same two rows
    with the same words above and below the gutter; the Done board's Lanes "waits for every task" is a prototype slip,
    and a passed run's Lanes reads as its Tasks row does.
12. **Head:** "Needs you" leaves the head (the canvas has none; the tab strip's waiting dot stays). The facts line
    counts merged tasks (`2/8` on the Main board, where t-2 is merged and verifying), not `runProgress`'s
    state-done count, which the rail keeps. A finished run's facts line appends `landed <short commit>` from
    `run.land.commit`. Spent / Tokens / Worker time move from the bottom totals to the head's second line, each fact
    only when known.
13. **A Report link with a task** (`wshcards-dag.tsx` `CardLink`) opens the tab's Graph in Focus on that task instead
    of setting the DAG modal's `selectedTaskIdAtom`, since the tab no longer embeds the modal's graph: the new-tab
    literal carries `graph: { mode: "focus", focus: taskId, trail: [] }`, and because `openTab` leaves an already
    open run tab as it was, `CardLink` then calls `updateWorkspaceTab(agentId, tabKey(tab), { view: "graph", graph:
    … })`.
14. **In flight** shows at most 5 chips, as both boards do (the 21-task board leaves its sixth working task off):
    asked first, then failed, then working, each in plan order. Lanes lists every task, so none is unreachable.
15. **Between merges the tab is incomplete:** Task 1 removes the Asks view and Task 4 brings open questions back into
    their rows. Only the run's Final checks the UI, after every task has landed, so no intermediate state is shipped
    or judged on its own.
16. **Scenarios split in three** (`workspace-run`, `workspace-run-activity`, `workspace-run-graph`) over one shared
    fixture module, so the three view tasks each own a scenario file and run side by side. The fixture becomes the
    canvas's 8-task "stats and dedupe packages" run, so screenshots compare to the boards.

### Task 1: Run tab shell: head, Tasks | Activity | Graph, shared fixture
**Depends on:** none
**Files:** `frontend/app/view/agents/workspacemodel.ts`, `frontend/app/view/agents/workspacemodel.test.ts`, `frontend/app/view/agents/workspaceruntab.tsx`, `frontend/app/view/agents/workspaceruntabmodel.ts`, `frontend/app/view/agents/workspaceruntabmodel.test.ts`, `frontend/app/view/agents/workspaceruntasks.tsx`, `frontend/app/view/agents/workspacerunactivity.tsx`, `frontend/app/view/agents/workspacerungraph.tsx`, `scripts/cdp/workspace-run-fixture.mjs`, `scripts/cdp/scenarios-workspace-run.mjs`, `scripts/cdp/scenarios-workspace-run-activity.mjs`, `scripts/cdp/scenarios-workspace-run-graph.mjs`, `scripts/cdp/scenarios.mjs`

**What to build:** the prefactor the three views build on. `RunView` becomes `"tasks" | "activity" | "graph"`; the
Asks view, the old run-log Activity and the bottom `RunTotals` go. The head becomes the canvas's: title, state pill
(Live / Done / Cancelled / the run's status), the Tasks | Activity | Graph segmented control at the head's right
(counts: tasks, events), the facts line, the Spent / Tokens / Worker time line, the task strip. Each view moves to
its own component file so later tasks own one file each: `workspaceruntasks.tsx` (today's task rows, unchanged),
`workspacerunactivity.tsx` (today's log, unchanged until Task 5), `workspacerungraph.tsx` (today's embedded DAG
graph, unchanged until Task 6). The swap between views keeps `ViewSwap`'s fade; the segmented control's active
fill moves with moment 17 (`morphTransition` on a `layoutId`).

The scenario fixture moves to `scripts/cdp/workspace-run-fixture.mjs`, seeding the Main board's run: 8 tasks t-1..t-8
with the canvas's labels, deps, descriptions and states (t-1 merged after a question the lead answered, with a
report and evidence files; t-2 `merged: true` in state verifying, `verifystartedts` 40s ago, the dag's `verify`
command set; t-3 running with a lead-owned question and a deadline; t-4 running; t-5 reviewing with evidence and
`reviewspawnedts` 30s ago; t-6 failed with verify output; t-7 waiting on t-3, t-4; t-8 pending with digest
waitreason `parallelism`), plan review passed, final stage waiting, events matching the canvas's Activity, usage and
`report.workerms` for the Spent line, child run objects carrying evidence. A `finished` option seeds the Done board
instead (every task merged, final passed with 6 shots, `land.commit` 4c1e9a2…, events through `dag-done`).
`scenarios-workspace-run-activity.mjs` and `scenarios-workspace-run-graph.mjs` are new scenarios
(`workspace-run-activity`, `workspace-run-graph`) registered in `scenarios.mjs`, each arranging through the fixture.

**Interfaces:**
```ts
// workspacemodel.ts
export type RunView = "tasks" | "activity" | "graph";
export type RunGraphState = { mode: "lanes" | "focus"; focus: string | null; trail: string[] };
// run variant: { kind: "run"; runId: string; view: RunView; graph?: RunGraphState }

// workspaceruntabmodel.ts
export type RowDot = "merged" | "working" | "asked" | "failed" | "waits";
export const ROW_DOT: Record<RowDot, string>; // token classes; "pulse-dot" on working and asked
export function taskDots(dag: TaskGroup | undefined, digest: DagStatusDigest | undefined): Record<string, RowDot>;
export function spendLine(usage: UsageRow[] | undefined, workerMs: number | undefined): string | null;
```
View components: `TasksView`, `ActivityView`, `GraphView`, each taking `{ model, agent, tab, run }` (plus what the
shell already reads: asks, events), so later tasks change a view's body without touching the shell.
`workspace-run-fixture.mjs` exports at least `RUN_ID`, the task and question constants, `seedRun(h, now, { version,
finished })`, `arrange(h, name, opts)`, `teardown(h, ctx, name)`, `readHead(h)` and `pickView(h, view)`; later tasks
seed anything extra (a 39-task dag, a transcript stub) inside their own scenario file.

**Acceptance:**
- `runHead` on the Main fixture (t-1 merged, t-2 merged and verifying) gives facts line `2/8 tasks · <elapsed> ·
  7f3a91c2 · plan 2026-11-17-stats-dedupe.md` (merged count, decision 12) and no Needs you; on a finished run with
  `land.commit` the line ends `landed <7-char commit>`.
- `spendLine` joins only the known facts (`Spent ~$… · Tokens … · Worker time …`), and is null with none.
- `taskDots` gives each state its dot as decision 5 lists: a lead-held and a user-held question are both `asked`, a
  merged verifying task is `working`, a done task awaiting merge is `working`, a merged one `merged`. The head strip
  is drawn from `taskDots` (t-3 amber on the Main fixture); `runstrip.ts` and its other callers are untouched.
- `runTabCounts` has no asks count.
- Scenario `workspace-run`: step "head: title, Live, facts line, Spent / Tokens / Worker time line, 8-segment
  strip, segmented Tasks 8 | Activity N | Graph (Main board)"; step "the segmented control switches to Activity
  and Graph and back, the active fill moving"; step "finished run: Done pill, facts line ends landed 4c1e9a2, the
  Spent line, every strip segment green (Done board)". The old Asks, answered and Graph-peek steps are gone.
- Scenarios `workspace-run-activity` and `workspace-run-graph` each pass a step that opens their view from the
  segmented control on the Main fixture.

### Task 2: Lane layout and Focus neighbourhood model
**Depends on:** none
**Files:** `frontend/app/view/agents/workspacerungraphmodel.ts`, `frontend/app/view/agents/workspacerungraphmodel.test.ts`

**What to build:** the Graph view's pure logic, no React. Rows order topologically, depth first: place a root, then
repeatedly place a ready task (all deps placed) among the children of the most recently placed task that still has
one ready, walking back up the placed stack; with none, the next ready task in plan order. Lanes are git-graph
lanes: a task takes the lowest lane among parents for which it is the last child (by row), else the lowest free
lane; a lane is held from its task's row to its last child's row. An edge runs down its parent's lane and curves
into the child's lane just above the child's row. Lanes and the gutter use the transitively reduced edges. The
chain of a task is itself plus everything up and downstream. Focus shows a task's own deps above and dependents
below, at most 3 per side: more than 3 shows the first 2 and a "+N more" pill (N = the rest) whose pick moves to the
first hidden one; no deps puts the Plan review stage above, no dependents the Final verification stage below.

**Interfaces:**
```ts
type GraphTask = { id: string; deps?: string[] };
export function reduceDeps(tasks: GraphTask[]): [string, string][]; // [dep, dependent], implied edges dropped
export interface LaneLayout { rows: string[]; lane: Record<string, number>; laneCount: number; edges: [string, string][] }
export function laneLayout(tasks: GraphTask[]): LaneLayout;
export function gutterPath(layout: LaneLayout, edge: [string, string], geo: { rowH: number; laneW: number; x0: number }): string; // svg d
export function chainOf(edges: [string, string][], id: string): Set<string>;
export interface FocusView { centre: string; up: string[]; upMore: string[]; down: string[]; downMore: string[]; upStage: boolean; downStage: boolean }
export function focusView(tasks: GraphTask[], id: string, max?: number): FocusView;
export const IN_FLIGHT_MAX = 5;
export function inFlight(planOrder: string[], kind: (id: string) => string): string[]; // "asked", then "failed", then "working", each in plan order, at most IN_FLIGHT_MAX
```

**Acceptance:**
- `reduceDeps` drops an edge implied through another path and keeps the rest; the canvas fixtures `FD.a/b/c` reduce
  to exactly `LD.a/b/c`'s edges (copy the fixtures from `Graph.dc.html` into the test).
- `laneLayout` on the 8-task fixture orders rows `t-1, t-3, t-4, t-7, t-8, t-2, t-5, t-6` with 3 lanes; the 21 and
  39-task fixtures need 5 and 9 lanes; on all three every dep sits above its dependent, and no task's row lies in
  the lane of an edge passing it (for edge p→c and any row strictly between, that row's task is not in p's lane).
- `chainOf` on the 8-task fixture from t-3 is {t-1, t-3, t-7}.
- `focusView` with 5 deps shows 2 and lists 3 in `upMore`; a root sets `upStage`, a leaf `downStage`.
- `inFlight` on the 8-task fixture's states gives `t-3, t-6, t-2, t-4, t-5`; on the 21-task fixture's, `t-7, t-9,
  t-2, t-8, t-10` (5, leaving t-11 off, decision 14); merged and waiting tasks never appear.

### Task 3: Tasks view: step rows, stage rows and row bodies
**Depends on:** Task 1 (owns the Tasks view file and model it creates)
**Files:** `frontend/app/view/agents/workspaceruntasks.tsx`, `frontend/app/view/agents/workspaceruntabmodel.ts`, `frontend/app/view/agents/workspaceruntabmodel.test.ts`, `scripts/cdp/scenarios-workspace-run.mjs`

**What to build:** the Tasks view as the canvas draws it: one bordered box with divided rows in the transcript's
step-box look (`StepBox` / `AddsDels` / `TurnChevron` from `steprows.tsx` where they fit): Plan review stage row,
then each task (dot, sans title, mono id, then on the right the state word, `+adds −dels` from its worker run's
evidence, time, chevron), then the Final verification stage row. A row opens to its body (moment 6b, `PaneReveal`;
the chevron turns): the task report's headline (`reportHeadline` / `parseRunReport` on the evidence summary; "Merged."
when a merged task has none), its files with diff counts, "review passed · merged HH:MM" from the events, the
failure output for a failed task (verify fail output, the canvas's mono block) with "The lead is deciding: retry,
escalate, skip or send back." while it waits on the lead, what a waiting task depends on ("depends on t-3, t-4", "·
waits for a free worker" per decision 3), and the actions: Open agent (the existing open-a-task's-agent path the
DAG peek's Open in Agent uses) and Open changes (decision 10). The in-between states have their canvas bodies too:
a **verifying** task reads "Merged. The plan's Verify is running in the project checkout." with a running step
"Ran `<the plan's Verify command (dag.verify)>`" timed from `verifystartedts` (and the digest's `verifylastline`
when present), then its files; a **reviewing** task reads "Finished with a commit. A reviewer is judging it against
the task and the spec.", its files, and "reviewer started <age> ago" from `reviewspawnedts`; a **not-started** task
leads with its description's first line (`TaskNode.description`; none, no line). State words follow decision 6 (no
word on merged and plainly running rows) and stage rows decision 11. A dot whose state changes uses moment 17's
colour morph; nothing else animates beyond the reveal.

**Acceptance:**
- Model: rows carry dot, state word (none for merged and plainly running), time and diff counts; the Final
  verification row reads "waits for every task" while waiting and "passed · N scenarios" from the final stage's
  shots count once passed (just "passed" with no shots); a not-started task with an unmet dep reads `waits on t-3,
  t-4`, one with waitreason `parallelism` adds "waits for a free worker" to its body, else "queued".
- Scenario `workspace-run`: step "Tasks: Plan review row, 8 task rows with their dots (merged, working pulsing,
  asked pulsing, failed, waits) and state words, Final verification row (Main board)"; step "t-1 opens to its
  summary, two files with counts, review passed · merged, Open agent and Open changes; Open changes opens the
  Changes tab"; step "t-2 opens to the merged-and-verifying body with its running Ran step; t-5 to the reviewing
  body with reviewer started … ago"; step "t-6 opens to its failure output; t-7 to its description and depends on
  t-3, t-4; t-8 to its description and waits for a free worker"; step "finished run: every row merged, Final
  verification passed · 6 scenarios (Done board; the fixture's final stage carries 6 shots)".

### Task 4: Questions in their rows, Take over, latest worker steps
**Files:** `frontend/app/view/agents/workspaceruntasks.tsx`, `frontend/app/view/agents/workspaceruntabmodel.ts`, `frontend/app/view/agents/workspaceruntabmodel.test.ts`, `scripts/cdp/scenarios-workspace-run.mjs`

**What to build:** open questions show inside their task's row and nowhere else. A task whose question is with the
lead opens by itself (once, on arrival; the user may close it) and shows the lead's question as the canvas draws it:
"t-3 asked the lead · lead is answering · 2m left" (from the ask's deadline, `formatLeft`; no deadline, no
countdown), header, question, its options read-only, "the lead answers in 2m unless you take over" and Take over
(`takeOverChildAsk`). Taken over, the ask is the user's and the row renders the existing `ChildAskEntry`, answerable
inline; once sent the row returns to working. A user-owned ask (forwarded) shows the same answerable entry. Asked
and answered questions list in the body: "asked · answered by the lead HH:MM" or "by you", with the question
(decision 2). A running task's open body shows its worker's latest 3 steps through the tab-owned stream
`runtab-steps:<runId>:<taskId>` (decision 4). `answeredAsks` becomes
per task with who answered, replacing the old Asks-view shape.

**Acceptance:**
- Model: a question answered with a `task-forwarded` between ask and answer is "you", else "the lead"; a task asked
  twice lists both, newest last; an open question is not listed as answered.
- Scenario `workspace-run`: step "t-3 is open on arrival with the lead's question, its options, the countdown and
  Take over"; step "Take over (the dag action RPCs stubbed as today's answer step stubs them) makes the question
  answerable inline; picking an option and sending returns t-3 to working and the tab's waiting dot goes"; step
  "t-1 lists asked · answered by the lead with its question"; step "t-4 opens to its worker's latest steps, read
  from a stubbed `RunTranscriptPathCommand` pointing at a fixture transcript".

### Task 5: Activity view: the Lifecycle timeline in the tab
**Depends on:** Task 1 (owns the Activity view file and scenario it creates)
**Files:** `frontend/app/view/orchestrate/timelinerail.tsx`, `frontend/app/view/agents/workspacerunactivity.tsx`, `scripts/cdp/scenarios-workspace-run-activity.mjs`

**What to build:** the DAG modal's Lifecycle timeline as the tab's Activity view (decisions 8 and 9): the activity
strip, All / Task / Attention filters with counts, grouped rows on the spine with steps and snippet, quiet gaps, the
now marker on a live run (none once ended), rows that open to their events, and a task pill that filters to that
task (fading the strip's other ticks). Built from `timelinerail.tsx`'s exported pieces with `timelinegroups.ts`
and `timelinefilter.ts`, no copies; the modal's rail renders exactly as before. Rows keep the rail's motion (viewFade
entrance for a live arrival, no cascade; open is the existing detail reveal).

**Acceptance:**
- Scenario `workspace-run-activity`: step "Activity: strip with ticks, All / Task / Attention with counts, grouped
  rows newest first, a quiet gap, now marker (Main board)"; step "Attention keeps only the asked and failed groups";
  step "a row's task pill filters to that task and fades the strip's other ticks"; step "a row opens to its events";
  step "finished run: the timeline ends at DAG complete with no now marker (Done board)"; no Lifecycle header or
  Relaunch lead in the tab.
- Scenario `dag-observability` still passes: the modal's rail is unchanged.

### Task 6: Graph view: Lanes | Focus, In flight, Esc
**Depends on:** Task 1 (owns the Graph view file and scenario it creates), Task 2 (extends the graph model it creates)
**Files:** `frontend/app/view/agents/workspacerungraph.tsx`, `frontend/app/view/agents/workspacerungraphmodel.ts`, `frontend/app/view/agents/workspacerungraphmodel.test.ts`, `scripts/cdp/scenarios-workspace-run-graph.mjs`, `frontend/app/store/keybindings/bindings.ts`, `frontend/app/store/keybindings/bindings.test.ts`, `docs/keyboard-shortcuts.md`, `frontend/app/view/agents/wshcards-dag.tsx`

**What to build:** the Graph board. A bar with the In flight chips (`inFlight` over the tasks in plan order, at most
5, dot plus id; a pick opens Focus on that task with an empty trail), the back button "← t-N" in Focus with a trail,
and the Lanes | Focus switch. **Lanes:** Plan review row, the gutter (`laneLayout` / `gutterPath`, a dot per task in
its lane) beside one row per task (mono id, full name, short state word per decision 6), Final verification row
(words per decision 11). Hovering a row lights its chain (chain edges accent, the rest dimmed, other rows at reduced
opacity); the selected task's row is tinted and lit when nothing is hovered. Click opens Focus on it. **Focus:** the
task centred, its deps above, dependents below, curved arrows, the "+N more" pill, stage nodes when a side is empty;
"waits on N" above, "waited on by N · click a task to move to it" below; clicking a task moves (pushing the trail),
back pops it. The mode and selection are the tab's `graph` state (decision 1). The graph's pure additions go in
`workspacerungraphmodel.ts` beside Task 2's: the short state word and In flight kind per task (from `taskDots` and
`workerAsk`), and the Esc gate `graphEscapeKey(ws: WorkspaceState): string | null` (the active tab's key when it is a
run tab on Graph in Focus, else null). Esc in Focus returns to Lanes and stops there; in Lanes Esc is left to the
app: a new `agent:` Escape binding in `buildAgentBindings`, guarded as `agent:back` is (`agentNavStrict`, so a focused
text field keeps its Esc), live only while `graphEscapeKey` of the focused agent's workspace is non-null, with
`agent:back` standing down then (no conflict), and its row in `docs/keyboard-shortcuts.md`. Lanes ↔ Focus and a
Focus move are moment 10 (`StepSwap`, forward into Focus or deeper, back out); the chip and row selection tint is
moment 17. A Report link with a task opens Focus on it (decision 13): `CardLink`'s new-tab literal carries the
`graph` state, and after `openBeside` it calls `updateWorkspaceTab(agentId, tabKey(tab), { view: "graph", graph })`
so an already open tab moves there too; `workspacemodel.ts` is not edited (Task 1 owns the type).

**Acceptance:**
- Unit: `graphEscapeKey` is the tab key for a run tab on Graph in Focus and null on Lanes, on Tasks or with another
  tab active; in `bindings.test.ts`, with a workspace in Focus the new binding is active and `agent:back` is not, with
  an editable target (a focused text field) neither Escape binding fires the Focus return, and in Lanes `agent:back`
  is active; the registry's conflict check passes.
- Scenario `workspace-run-graph`: step "Lanes: Plan review, 8 rows in order t-1, t-3, t-4, t-7, t-8, t-2, t-5, t-6
  with names and words, a 3-lane gutter, Final verification, In flight chips t-3, t-6, t-2, t-4, t-5 (Main and Graph
  boards)"; step "hovering t-3 lights t-1, t-3, t-7 and their edges and dims the rest"; step "clicking t-7 opens Focus
  on it: t-3 and t-4 above, Final verification below"; step "clicking t-3 moves there, back returns to t-7"; step
  "an In flight chip jumps into Focus on its task"; step "Esc in Focus returns to Lanes; a second Esc leaves the
  Graph to the app's back"; step "a seeded 21-task dag draws 21 rows, a 5-lane gutter and 5 In flight chips t-7, t-9,
  t-2, t-8, t-10 (Graph board)"; step "a seeded 39-task dag draws 39 rows and a 9-lane gutter, and a task with more
  than 3 dependents shows 2 and +N more (Graph board)"; step "with the Run tab open on Tasks, a `wsh jarvis complete`
  card's Report link for t-3 (a worker transcript and roster entry the step seeds for the fixture run) switches the
  tab to Graph in Focus on t-3"; step "finished run: every lane merged, the Final verification row reads as the Tasks
  view's, no In flight chips (Done board)".
