# Run tab Graph: Focus centre card, state words, a board as tall as its rows

**Effort:** effort:40b4d563-2de6-4bf4-b71f-75561fe370ff
**Verify:** `node scripts/verify.mjs ./pkg/waveobj`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs workspace-run-graph workspace-run`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\run-graph-focus\project\Main.dc.html

Builds the settled canvas `run-graph-focus` (boards Main = today, Focus-Working, Focus-Asked, Focus-Waits, Lanes;
`feedback/001.png`: the centre card wrapped its buttons) in `workspacerungraph.tsx`. Read `DESIGN.md` and the boards
before styling; colours come from the `@theme` tokens the Graph view already uses (`#2a313a` = `edge-strong`,
`#646a72` = `ink-faint`, `#7f858b` = `muted`, `#9aa3ad` = `ink-mid`). The fixture is `scripts/cdp/workspace-run-fixture.mjs`
(t-1 merged, t-2 merged+verifying, t-3 asked the lead, t-4 running, t-5 reviewing with evidence, t-6 failed, t-7 waits
on t-3 and t-4, t-8 waits for a worker).

Decisions beyond the design:

1. **Open changes and the diff stat need sealed evidence.** A worker's `RunEvidence` (files, `addtotal`, `deltotal`)
   exists only once its run finishes; a running worker has no live diff in the data. So the centre shows Open changes
   and `N files +a −d` when the task's worker run has evidence with files (reviewing, merged, failed, done), and a
   running task (t-4) shows Open agent alone. The scenario shows the diff on t-5 (reviewing, a working dot).
2. **The live step is the worker's latest one step**, from the Tasks view's `LatestSteps` stream (n = 1), only while
   the task's state is `running`. It streams under its own id prefix, since the Tasks and Graph views can be mounted
   together during the view swap and one id would stop the other's stream.
3. **A question with you** (`asking you`) shows the same question text and Open agent as one with the lead; answering
   stays in the Tasks view's row, so the cockpit has one answer box per question.
4. **Failed and merged centres**, which no board draws, follow the same rules: word and time, Open agent when the
   task has a worker run, Open changes and diff when it has evidence. The failure output stays in the Tasks view.
5. **"Starts once ..."**: the task's unmet deps as `t-3 and t-4` (`t-1, t-3 and t-4` for three) + ` merge.`; with none
   unmet, `Starts once a worker is free.`; in a finished run, `Never started.`
6. **Times** use `formatElapsed` (`4m`, `40s`): working = the Tasks view's task time (digest run time, else since
   spawn); asked = since `task.askts` (else the task time); failed = `<elapsed> ago` since the task's latest
   `task-failed` / `task-verify-failed` / `task-review-failed` / `task-merge-failed` event, the bare word with none;
   merged and waits have no time.
7. **Unmet deps** are the Tasks view's existing rule (not merged and not `done`), extracted once so the Lanes'
   `waits on t-3, t-4`, the centre's "Starts once" and the Tasks row's `waits on` cannot disagree.
8. **Row labels** read `waits on N` / `then N` (N counts folded tasks too). Over a stage node they drop the count:
   `then` over Final verification (Focus-Waits), and, mirrored, `waits on` over Plan review.
9. **Every state has a word now**, merged included (`merged`), in Lanes, on neighbour cards and in chip titles.
   Neighbour cards carry the short word with no time, as the boards do; Lanes rows and the centre add the time.
10. **`Focus →`** shows on the hovered Lanes row and on the keyboard-focused one (rows already treat focus as hover).
11. **Action buttons never wrap** (feedback 001): `whitespace-nowrap` goes on the shared action class, which the
    Tasks view's Open agent / Open changes / Take over share.
12. **The old "waits on N" line above the board and "waited on by N · click a task" line below it go**; the row
    labels replace them and the footer reads `click a task to move to it · Esc for Lanes`.
13. **One state-word colour map**: the Tasks view's `STATE_TEXT` is exported and the Graph's duplicate `WORD_TONE`
    is deleted.

### Task 1: State words with time on every Lanes row, and Focus →
**Depends on:** none
**Files:** `frontend/app/view/agents/workspacerungraphmodel.ts`, `frontend/app/view/agents/workspacerungraphmodel.test.ts`, `frontend/app/view/agents/workspaceruntabmodel.ts`, `frontend/app/view/agents/workspaceruntabmodel.test.ts`, `frontend/app/view/agents/workspacerungraph.tsx`, `scripts/cdp/scenarios-workspace-run-graph.mjs`

Goal: Lanes board. `GraphNode` gains `time: string` and `waitsOn: string[]`, `word` covers every state (decisions
6, 7, 9); `graphNodes(dag, digest, events, now)`; a pure `laneWord(node)` gives the row's text: `waits on t-3, t-4`
for a waiting node with unmet deps, else `word` + ` · time` when there is a time. The unmet-deps rule is one exported
helper in `workspaceruntabmodel.ts` that `taskState` also uses. Each Lanes row shows `laneWord` in its state colour;
the hovered or focused row adds a muted `Focus →` (`data-graph-focus-hint`).

Acceptance:
- On the Main fixture `graphNodes` gives words t-1 `merged`, t-3 `asked the lead`, t-4/t-2/t-5 `working`, t-6
  `failed`, t-7/t-8 `waits`; t-3's time runs from `askts`; t-6's time ends in ` ago`; t-7 `waitsOn` `["t-3","t-4"]`,
  t-8 `[]`; a merged node has no time.
- The Tasks view's row words are unchanged (`workspaceruntabmodel` tests pass as they are).
- Scenario `workspace-run-graph`, the Lanes step (Lanes and Main boards): t-1 reads `merged`, t-3 starts
  `asked the lead · `, t-4, t-2 and t-5 start `working · `, t-7 reads `waits on t-3, t-4`, t-8 `waits`, t-6 starts
  `failed · ` and ends ` ago`.
- Scenario step `hovering t-4 shows Focus → on its row and on no other (Lanes board)`.
- The Done-board step (`finished run: every lane merged ...`) asserts every row reads `merged` instead of an empty
  word, and `MAIN_WORDS` holds t-1 `merged`.

### Task 2: The Focus centre card by state
**Depends on:** none
**Files:** `frontend/app/view/agents/workspacerunfocuscard.tsx`, `frontend/app/view/agents/workspacerunfocuscardmodel.ts`, `frontend/app/view/agents/workspacerunfocuscardmodel.test.ts`, `frontend/app/view/agents/workspaceruntasks.tsx`

Goal: the centre card of Focus-Working, Focus-Asked and Focus-Waits as its own component, which Task 3 places.
`FocusCentreCard({ task, dot, state, waitsOn, finished, ask, evidence, run, onOpenAgent, onOpenChanges })` fills its
wrapper's width: header (dot, id, `state` in its colour), the name (15px semibold, one line), then by state the live
step (decision 2), the question (`data-focus-question`, the ask's first question), or `Starts once ...`
(`data-focus-starts`, decision 5); then an actions row with Open agent (`data-open-agent`), Open changes
(`data-open-changes`), and right-aligned `N files +a −d` (`data-focus-diff`), per decisions 1 and 4; a waiting task has
no actions row. Border `accent`, `warning/60` when asked. A pure `focusCardView` decides which parts show. From
`workspaceruntasks.tsx` export `useChildRuns`, `LatestSteps` (with `n` and a stream-id prefix; the Tasks view keeps 3
and its prefix), `TaskActions` (an optional trailing node after a spacer) and `STATE_TEXT`; the shared action class
gets `whitespace-nowrap` (decision 11).

Acceptance:
- `focusCardView`: running with a worker run → step and Open agent, no changes without evidence; reviewing with
  evidence of 2 files → Open changes on the first file and diff `2 files` with the totals; asked → the question and
  Open agent; waits on t-3, t-4 → `Starts once t-3 and t-4 merge.` and no actions; waits with none unmet →
  `Starts once a worker is free.`; waits in a finished run → `Never started.`
- Scenario `workspace-run` passes unchanged (Tasks rows still show their 3 latest steps, Open agent, Open changes).
- Shown by Task 3's scenario steps for Focus-Working, Focus-Asked and Focus-Waits.

### Task 3: The Focus board: centre card, worded neighbours, row labels, its rows' height
**Depends on:** Task 1, Task 2 (places `FocusCentreCard`, uses `useChildRuns` and `STATE_TEXT`)
**Chunk:** Run tab Graph: the task card button reads 'Open in Agent' where the board says 'Focus its agent'; the board's legend under the graph is not built
**Files:** `frontend/app/view/agents/workspacerungraph.tsx`, `frontend/app/view/agents/workspacerungraphmodel.ts`, `frontend/app/view/agents/workspacerungraphmodel.test.ts`, `scripts/cdp/scenarios-workspace-run-graph.mjs`

Goal: Focus as the boards draw it. Neighbour cards 190 x 52, radius 10: dot, id, short word in its colour
(`data-graph-node-word`), the name on one line; stage nodes dashed with their label and mono word. The centre is
`FocusCentreCard` (up to 440px wide) with `state` = word + ` · time`, Open agent wired as the Tasks view's
(`openTaskWorker(resolveTaskWorker(...))`), Open changes through `openBeside(..., { kind: "changes" })`. Rows stack
from the top: up row, a 40px arrow, the centre at its measured height, a 40px arrow, the down row; the board
(`data-graph-board`) is exactly as tall as its last row, with no row present taking no space. Edges are `edge-strong`,
straight when aligned. Row labels at the left (`data-graph-row-label="up"|"down"`, decision 8); footer `data-graph-hint`
(decision 12). `WORD_TONE` goes (decision 13).

Acceptance:
- Scenario step `Focus on t-4: working · <time>, its latest step, Open agent, no Open changes; t-1 above reads merged,
  t-7 below reads waits; labels waits on 1 / then 1 (Focus-Working board)`, with t-4's transcript stubbed as the
  `workspace-run` scenario's t-4 step does.
- Scenario step `Focus on t-5: Open changes and its diff stat on one line with Open agent, no button wrapping (each
  action button's height is one line) (Focus-Working board, feedback 001)`.
- Scenario step `Focus on t-3: warning border, asked the lead · <time>, the fixture's question, Open agent
  (Focus-Asked board)`.
- Scenario step `Focus on t-7 from t-4 (back ← t-4): t-3 and t-4 above with their words, Starts once t-3 and t-4
  merge., no actions, Final verification below labelled then (Focus-Waits board)`; the existing t-7 step asserts the
  row labels instead of the removed count lines.
- The 39-task step (`a seeded 39-task dag ... +N more`) asserts the down row label `then 4` (decision 8 counts
  folded tasks) instead of the removed `waited on by 4` line.
- In each Focus step the board's height equals its lowest node's bottom (within 1px) and is under 460px.
- The other existing `workspace-run-graph` steps pass.
