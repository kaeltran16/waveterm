# Workspace pane for the Rendered view

**Verify:** `node scripts/verify.mjs ./pkg/brainstormcheck`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs workspace-pane workspace-header workspace-ring workspace-run workspace-changes workspace-file workspace-brainstorm-canvas agent-rendered rendered-shell agent-header agent-rail agent-streams agent-subagents agent-tree-rail shell-tasks run-cost code-peek brainstorm-mode rendered-bs-host rendered-bs-mockup rendered-bs-run rendered-bs-check rendered-bs-design rendered-bs-review rendered-bs-question rendered-bs-boards transcript-dagactions`
**Prototype:** C:\Users\cktra\Projects\waveterm\.superpowers\design\workspace-pane\project

**Goal:** in the Agent surface's Rendered view, a resizable, tabbed right pane opens what the conversation
references (a run, the changes, a cited file, the brainstorm, the canvas) beside the transcript, in place of the
fixed 300px AgentDetailsRail. The canvas's nine boards are the spec for every state; its app bar, nav rail and agent
tree are rough context, not things to rebuild. Copy comes from the boards.

Verify: `scripts/verify.mjs` runs vitest on the test files related to what a merge changed, and tsc when TS changed;
the Go package is only its required argument (no task touches Go).

## Settled with the user (the design)

- Rendered view only. The Terminal (TUI) view, and agents `canRender` rejects (pi, plain terminals, ended workers, the
  final stage), and a subagent interior (it wins over Rendered today) keep AgentDetailsRail exactly as it is.
- No Details tab. In Rendered the rail's items move: project, branch and worktree into the header's subline; the
  needs-you count onto the header's run link as an amber dot and count; files touched into a header chip
  ("5 files +239 −0", hidden when clean or not a repo, "repo" prefix when the checkout is shared) that opens the
  Changes tab; session state, age, cache countdown, context meter, Compact/Clear (only when `offersContextReset`),
  token usage and spend into a popover on the composer's context ring; Stop is the composer's existing Interrupt;
  subagents and tools used are already transcript rows. Both views read these facts from `agentrailmodel.ts`.
- Five tab kinds, each body reusing today's component: Run (sub-views Tasks, Asks, Activity, Graph; Graph is a static
  DAG with a selected-task card, no replay scrubber), Changes (file list beside the selected file's diff), File
  (today's Code peek, landed on the cited line), Brainstorm (today's brainstorm pane), Canvas (today's canvas pane).
- No pane until a tab is open. In Rendered a plain click opens beside; Ctrl+click keeps today's avatar peek. In
  Rendered, brainstorm and canvas no longer take over the center; in TUI they still do.
- Tabs belong to the agent, in a per-agent jotai atom, so they survive switching agents and the picker flip to the
  terminal. Closing a tab removes it; the pane goes with its last tab.
- 600px by default, drag-resizable from its left edge (persisted; double-click resets), expandable to full width (the
  transcript hides), collapsible to a 44px strip with the needs-you badge and the open-tab count. `d` toggles collapse
  when tabs exist and does nothing otherwise. No + button.
- DESIGN.md says the pane is not a rail (rails stay fixed-width); docs/keyboard-shortcuts.md documents `d`.

## Decided while planning (beyond the boards), and why

1. **State shape.** One in-memory per-agent record (tabs, active key, collapsed, expanded) and one global persisted
   width. Tabs belong to the agent; the width is a layout preference, like the window's other splits.
2. **Tab identity.** One tab per key: Run per run id, one Changes, File per cited path (reopening it moves the landed
   line), one Brainstorm, one Canvas. Opening an existing key activates it, keeps its sub-state, and un-collapses the
   pane. Closing the active tab activates its right neighbour, else its left. Without this, repeated clicks on the
   same link would pile up duplicates.
3. **Widths.** Default 600, minimum 360, and the transcript keeps at least 360 (the pane clamps down on a narrow
   window). Collapsing clears expanded, as the prototype does. Fullscreen (`f`) hides the tree, not the pane: the pane
   holds what you opened, the tree is chrome. Any tab closes by its × (shown on the active tab, and on hover or focus
   of the others) or by a middle-click; the boards show only the active tab's ×.
4. **Brainstorm and canvas have one "shown" source of truth.** Their `mode` field becomes Terminal-view state (it still
   means "takes over the center there"). In Rendered, "shown" is "its tab is the active tab of an uncollapsed pane".
   One predicate and one show/hide dispatcher (Task 8) replace every direct read and write of `mode` for showing:
   keys, the tree's badges, the poller's on-screen test, the header switch, openref's landing. Syncing `mode` with the
   tab list instead would be two states that drift.
5. **Opening beside is one store call that can decline.** `openBeside(model, agentId, tab, event)` opens the tab and
   returns true only when the agent shows Rendered on the Agent surface and Ctrl is not held; otherwise it returns
   false and the caller keeps today's open/peek. Transcript cards already carry `ctx.agentId`, so no new React
   context is needed, and the same cards elsewhere (Sessions, read-backs) behave as today.
6. **One git read for the facts.** The rail's branch/worktree/files load moves into a hook deduplicated per
   `railReloadKey`, so the header, the Changes tab and the TUI rail share one read of `railStateAtom`.
7. **Header facts in Rendered only.** The TUI header is unchanged (its rail still shows them). A landed lead follows
   the rail's rule: the branch is its landing branch and there is no files chip (its worktree is gone).
8. **The ring is always there in Rendered**, as a button that keeps `data-context-ring`; with no context reading it
   draws the empty ring without a percent and the popover leaves out the Context row. Otherwise the popover's session
   and usage facts would be unreachable before the first usage report.
9. **The strip's needs-you badge** counts what waits on you across the open tabs: each Run tab's user-owned asks, plus
   one for an asking Brainstorm tab. The header run link's count is the agent's own role asks (the rail's "yours").
10. **Expanded hides the center but keeps the focused agent's terminal laid out** (never `display: none`), the rule
    `terminalClass` in agentsurface.tsx exists for.
11. **Existing card labels stay** ("Open run", "Answer in the run", the brainstorm cards' open links): the prototype's
    generic "Open beside" card stands for them, and each label names what it opens. Only the destination changes.
12. **Scenarios.** Each task owns one new scenario module; Task 1 lands them as registered stubs that fail with "not
    written yet", so parallel tasks never share `scripts/cdp/scenarios.mjs` and an unwritten one cannot pass. Existing
    scenarios that read the details rail on a claude fixture agent pin the Terminal view (`pinDefaultView`), since
    that rail is what they test and it stays in TUI.
13. **The `d` key** keeps toggling the rail in TUI; in Rendered it toggles collapse with tabs and passes on with none.
    While a shown Brainstorm tab asks with a fourth option, `d` picks it as today (the collapse binding stands down).

Motion moments (docs/reference/motion-system.md) each task's new state changes use: pane appearing/leaving and
collapse/restore 6b (`paneReveal`); a tab added 1, closed 2; the active tab and Run sub-view indicator 9; expand to
full width 17; a badge or count changing 12; the strip badge appearing `popoverReveal` (as RailStrip does); the ring
popover `PopoverReveal`; a tab body or the Changes diff swapping `ViewSwap`/`viewFade`.

### Task 1: Workspace state, shared fact hooks and scenario stubs
**Depends on:** none
**Files:** `frontend/app/view/agents/workspacemodel.ts`, `frontend/app/view/agents/workspacemodel.test.ts`, `frontend/app/view/agents/workspacestore.ts`, `frontend/app/view/agents/workspacestore.test.ts`, `frontend/app/view/agents/roleasks.ts`, `frontend/app/view/agents/railgit.ts`, `frontend/app/view/agents/railgit.test.ts`, `frontend/app/view/agents/agentdetailsrail.tsx`, `frontend/app/view/agents/workspaceruntab.tsx`, `frontend/app/view/agents/workspacechangestab.tsx`, `frontend/app/view/agents/workspacefiletab.tsx`, `scripts/cdp/scenarios-workspace-pane.mjs`, `scripts/cdp/scenarios-workspace-header.mjs`, `scripts/cdp/scenarios-workspace-ring.mjs`, `scripts/cdp/scenarios-workspace-run.mjs`, `scripts/cdp/scenarios-workspace-changes.mjs`, `scripts/cdp/scenarios-workspace-file.mjs`, `scripts/cdp/scenarios-workspace-brainstorm-canvas.mjs`, `scripts/cdp/scenarios.mjs`

**What to build:** the interface every other task builds on, with no visible change yet. A pure model of a pane's
state and its transitions (decisions 1-3), a store holding it per agent plus the persisted width, the Rendered
predicate and `openBeside` (decision 5). Two hooks move out of agentdetailsrail.tsx so other views can share them:
`useRoleAsks` (unchanged behaviour) into roleasks.ts, and the rail panel's git load into `useRailGit`, deduplicated
per `railReloadKey` (decision 6); the rail panel uses both and behaves as before. Three body components exist as
stubs with their final signatures (each renders a placeholder line naming its tab). Seven scenario modules exist,
registered in `scripts/cdp/scenarios.mjs` under the names in the Final line, each recording one failing step
"not written yet" (decision 12).

**Interfaces:**
```ts
// workspacemodel.ts
export type RunView = "tasks" | "asks" | "activity" | "graph";
export type WorkspaceTab =
    | { kind: "run"; runId: string; view: RunView }
    | { kind: "changes"; selected: string | null }
    | { kind: "file"; path: string; line: number | null }
    | { kind: "brainstorm" }
    | { kind: "canvas" };
export type WorkspaceState = { tabs: WorkspaceTab[]; active: string | null; collapsed: boolean; expanded: boolean };
export const EMPTY_WORKSPACE: WorkspaceState;
export const DEFAULT_PANE_PX = 600, MIN_PANE_PX = 360, MIN_TRANSCRIPT_PX = 360, STRIP_PX = 44;
export function tabKey(tab: WorkspaceTab): string; // "run:<id>" | "changes" | "file:<path>" | "brainstorm" | "canvas"
export function paneWidth(stored: number, availablePx: number): number;
// workspacestore.ts
export function workspaceAtom(agentId: string): Atom<WorkspaceState>;
export const workspaceWidthAtom; // atomWithStorage "agent.workspace.width", DEFAULT_PANE_PX
export function openWorkspaceTab(agentId: string, tab: WorkspaceTab): void;
export function closeWorkspaceTab(agentId: string, key: string): void;
export function activateWorkspaceTab(agentId: string, key: string): void;
export function updateWorkspaceTab(agentId: string, key: string, patch: Partial<WorkspaceTab>): void;
export function setWorkspaceCollapsed(agentId: string, collapsed: boolean): void;
export function toggleWorkspaceCollapsed(agentId: string): boolean; // false, and no change, with no tabs
export function setWorkspaceExpanded(agentId: string, expanded: boolean): void;
export function rendersNow(model: AgentsViewModel, agentId: string): boolean;
export function openBeside(model: AgentsViewModel, agentId: string, tab: WorkspaceTab, event?: { ctrlKey: boolean }): boolean;
// roleasks.ts: useRoleAsks(model, agent) -> { lineage, role, roleRun, asks, yours }, moved as is
// railgit.ts: useRailGit(agent: AgentVM): RailGitState | null  (loads, and returns railStateAtom)
// stubs: RunTab / ChangesTab / FileTab, each ({ model, agent, tab }) with tab narrowed to its kind
```

**Acceptance:**
- opening a tab adds it and makes it active; opening an existing key activates it without a duplicate, moves a File
  tab's line, keeps a Run tab's view, and un-collapses; closing the active tab activates its right neighbour, else its
  left; closing the last tab returns `EMPTY_WORKSPACE`; collapsing clears expanded; `toggleWorkspaceCollapsed` with no
  tabs returns false and changes nothing
- one agent's tabs are untouched by another's actions
- `paneWidth` clamps to 360 at least and leaves the transcript at least 360
- `rendersNow` is true only for a claude agent with a block, in effective view "rendered", not ended, not the final
  stage, with no subagent interior open; `openBeside` returns false (and opens nothing) when `rendersNow` is false,
  when the surface is not "agent", or with Ctrl held
- two `useRailGit` consumers of the same agent and key start one git read; a new key reloads, a new agent blanks first
  as the rail does today
- the details rail reads exactly as before: the existing `agent-rail` scenario passes as it is (the rail is still in
  Rendered until Task 2)

### Task 2: The pane shell, its tab strip and the d key
**Depends on:** Task 1
**Files:** `frontend/app/view/agents/workspacepane.tsx`, `frontend/app/view/agents/workspacemodel.ts`, `frontend/app/view/agents/workspacemodel.test.ts`, `frontend/app/view/agents/agentsurface.tsx`, `frontend/app/store/keybindings/bindings.ts`, `frontend/app/store/keybindings/bindings.test.ts`, `frontend/app/store/keybindings/whenstate.ts`, `frontend/app/store/keybindings/whenstate.test.ts`, `docs/keyboard-shortcuts.md`, `DESIGN.md`, `scripts/cdp/scenarios-workspace-pane.mjs`, `scripts/cdp/scenarios-agent-rail.mjs`, `scripts/cdp/scenarios-agent-streams.mjs`, `scripts/cdp/scenarios-agent-subagents.mjs`, `scripts/cdp/scenarios-shell-tasks.mjs`, `scripts/cdp/scenarios-runs.mjs`, `scripts/cdp/scenarios-agent.mjs`

**What to build:** in Rendered, AgentDetailsRail no longer renders; the focused agent's pane renders beside the center
when it has tabs. The pane (`aside aria-label="Workspace"`) is the Main board's right side: a 44px tab strip
(`role="tablist"`, each tab its kind's icon, label, an amber dot while it waits on you, a close × on the active tab),
then expand/restore and collapse (`title="Collapse (d)"`) buttons, then the active tab's body: RunTab, ChangesTab,
FileTab from their modules, and BrainstormPane / CanvasPane for those kinds. Labels: "Run · <run title>",
"Changes", the file's base name, "Brainstorm · <topic>", "Canvas · <topic>" (pure, in workspacemodel.ts). A left-edge
handle drags the width (persisted), double-click resets to 600 (`title="Drag to resize · double-click resets to
600px"`). Expanded, the center hides (decision 10) and the pane fills. Collapsed, a 44px strip (Closed board) shows the
needs-you badge (decision 9) and the tab count; clicking it reopens. `d` per decision 13 (a new binding beside
`agent:toggle-rail`, exclusive `when`s). docs/keyboard-shortcuts.md: `d` reads "Toggle the agent rail (Terminal), or
collapse the workspace pane (Rendered, with tabs open)". DESIGN.md's Layout section: the workspace pane is a
resizable split, not a rail; rails stay fixed-width. Fullscreen (`f`) hides the tree and keeps the pane (decision 3).
The `d` bindings' `when`s read the focused agent's workspace, view-mode and picker-flip atoms, so `watchFocusedCanvas`
follows them too (its completeness test counts them). The scenarios that read the details rail on a claude fixture
agent pin the Terminal view (decision 12) and keep their steps: `agent-rail`, `agent-streams`, `agent-subagents`,
`agent-tree-rail` (scenarios-agent.mjs), `shell-tasks` and `run-cost` (scenarios-runs.mjs).

**Acceptance:**
- in Rendered with no tabs there is no pane and no rail, and `d` changes nothing (Main board)
- opening a tab shows the pane at the stored width (600 on a fresh profile); dragging the edge resizes it and the
  width survives a reload; double-clicking the edge returns it to 600
- the expand button fills the surface with the pane and hides the transcript; restore brings it back; the focused
  terminal stays laid out while expanded (Expanded board)
- collapse shows the 44px strip with the open-tab count and the needs-you badge; `d` collapses and restores it;
  clicking the strip restores it (Closed board)
- closing the last tab removes the pane; tabs survive switching to another agent and back, and a flip to Terminal and
  back; in Terminal the rail shows as today and `d` toggles it
- an inactive tab closes by its hover × and by middle-click, and the active tab stays active
- `f` hides the tree and the pane stays
- the `d` binding's availability follows the focused agent's tabs and view with no other key event
- scenario `workspace-pane` has a step for each bullet above, with a screenshot of the Expanded and Closed boards'
  states, and steps showing the pane's reveal (6b), a tab's entrance (1) and exit (2), and the active-tab indicator
  moving (9); the six pinned rail scenarios pass unchanged

### Task 3: Header facts in Rendered
**Depends on:** Task 2 (its scenario opens tabs into the pane Task 2 renders)
**Files:** `frontend/app/view/agents/agentheader.tsx`, `frontend/app/view/agents/agentrailmodel.ts`, `frontend/app/view/agents/agentrailmodel.test.ts`, `frontend/app/view/agents/agentdetailsrail.tsx`, `scripts/cdp/scenarios-workspace-header.mjs`

**What to build:** in Rendered, the header's subline reads project · branch (git-branch icon) · worktree (clipped at
its start, full path as title) · initiative · run link, as the Main board draws it. The lead's run link carries an
amber dot and the count of asks waiting on you (`useRoleAsks`'s `yours`; none when zero). A files chip on the
header's right ("N files +A −D", `title="Open the Changes tab"`) shows when the checkout has changes; it is hidden
when clean, when not a repo and for a landed lead (decision 7); it reads "repo · …" when `sharedCheckoutCount` > 1,
with the rail's tooltip. Its line counts follow `lineCountsShown` as the rail's summary does. A plain click on the
chip opens the Changes tab and on the run link opens the Run tab (`openBeside`); Ctrl+click on the run link keeps
today's peek. The header's context menu drops "Show/Hide details" in Rendered. One pure function in agentrailmodel.ts
derives branch, worktree and the chip (count, adds, dels, prefix, or none) from the rail inputs; the rail's Details
and Files touched sections use it too, so the two views cannot disagree. The TUI header is unchanged.

**Interfaces:** the chip button carries `data-header-files-chip`; the run link keeps `data-header-run-link`.

**Acceptance:**
- the pure function's cases: plain checkout, linked worktree, shared checkout ("repo" prefix), clean (no chip), not a
  repo (no chip), landed lead (landing branch, no chip), line counts unavailable (count without +/−)
- scenario `workspace-header`: the subline shows branch and worktree for a fixture agent in a linked worktree; the run
  link shows the dot and "1" with one user-owned ask; the chip shows the fixture repo's count and opens the Changes tab
  beside; the run link opens the Run tab beside; Ctrl+click on the run link opens the avatar peek instead; a clean repo
  shows no chip; the Terminal view's header shows none of the new facts (Main board, ring closed); a step shows the
  run link's count changing (12)
- `agent-header` passes

### Task 4: Session popover on the composer's context ring
**Depends on:** Task 3
**Files:** `frontend/app/view/agents/renderedcomposer.tsx`, `frontend/app/view/agents/sessionfacts.tsx`, `frontend/app/view/agents/agentdetailsrail.tsx`, `frontend/app/view/agents/agentrailmodel.ts`, `frontend/app/view/agents/agentrailmodel.test.ts`, `frontend/app/view/agents/renderedmode.ts`, `frontend/app/view/agents/renderedmode.test.ts`, `scripts/cdp/scenarios-workspace-ring.mjs`

**What to build:** the ring becomes a button (`aria-expanded`, `title="Session, context and token usage"`, decision
8) that opens a 320px popover (`role="dialog" aria-label="Session"`) above the composer, right-aligned, as the Main
board draws it: Session (state in its tone colour · age · cache countdown, with the rail's rewrite tooltip), Context
(meter, percent, note, and Compact/Clear only when `offersContextReset`, sending what the rail sends), then Token usage
(today's TokenUsageSection). Esc, a click outside, or the ring again closes it. The Session line and the Context line
move out of agentdetailsrail.tsx into sessionfacts.tsx, with the cache-status and session-usage loaders, so the rail
and the popover render the same components; loaders run only while the popover or the rail panel is open.

**Acceptance:**
- the ring opens and closes the popover; Esc and an outside click close it; focus returns to the composer
- the popover's Session, Context and token figures equal what the Terminal view's rail shows for the same agent
- Compact and Clear appear only for an idle, live claude agent whose context level is not ok, and each types its
  command into the agent as the rail's do
- with no context reading the ring draws empty, without a percent, and the popover has no Context row
- `agent-rendered`'s ring step still finds `[data-rendered-composer] [data-context-ring]`
- scenario `workspace-ring`: open popover with a warn-level fixture (Main board's ring), the reset buttons present for
  it and absent for an ok-level agent, Esc closing it; a step shows the popover's reveal (`PopoverReveal`)

### Task 5: Run tab
**Depends on:** Task 2 (its scenario opens the Run tab into the pane Task 2 renders)
**Files:** `frontend/app/view/agents/workspaceruntab.tsx`, `frontend/app/view/agents/workspaceruntabmodel.ts`, `frontend/app/view/agents/workspaceruntabmodel.test.ts`, `frontend/app/view/agents/runrailsections.tsx`, `frontend/app/view/orchestrate/daggraph.tsx`, `frontend/app/view/agents/wshcards-runs.tsx`, `frontend/app/view/agents/wshcards-dag.tsx`, `frontend/app/view/agents/wshcards-dagactions.tsx`, `frontend/app/view/agents/renderedbsrun.tsx`, `scripts/cdp/scenarios-workspace-run.mjs`, `scripts/cdp/scenarios-transcript-dagactions.mjs`, `scripts/cdp/scenarios-rendered-bs-run.mjs`

**What to build:** RunTab for a run id (resolved with `useRunInfo`; loading and not-found states say so). Its head, as
the RunTasks board draws it: title, live state, "done/total tasks · elapsed · run id · plan <file>", the task strip
(`runstrip`), and "Needs you · then <next step>" while a user ask is open. Sub-tabs Tasks, Asks, Activity (each with
its count) and Graph; the choice is the tab's `view` (`updateWorkspaceTab`). Tasks: a row per task (task, state, time,
changes) with a user-owned ask answerable inline under its task, then Spent, Tokens and Worker time. Asks: questions
waiting on you first, answerable, then answered ones. Activity: the run's events, newest first. Graph (RunGraph board):
the DAG modal's `DagGraphView`, static, its selected-task card with "Focus its agent"; no timeline or replay. Reuse
the rail's run pieces (RunSection's lanes, ask cards, Activity, usage rows, exported from runrailsections.tsx) and
`DagGraphView` (adapt it to run without the DAG modal's context if it needs that) rather than re-implementing them;
the derivations the head and counts need go in workspaceruntabmodel.ts. In Rendered, the transcript's run links
("Open run", "Answer in the run", the runs and DAG cards' links, the brainstorm run step's "Open run") call
`openBeside` with the transcript's agent and fall back to today's open; Ctrl+click peeks.

**Acceptance:**
- the model's head line, counts and Needs-you line for: running with a user ask, all merged, no DAG yet, done
- scenario `workspace-run`: a fixture lead's run card in the Rendered transcript opens the Run tab beside with Tasks
  shown and the ask answerable inline (RunTasks board); Asks, Activity and Graph each show their content, and Graph's
  selected task shows its card (RunGraph board); the tab's dot shows while the ask waits and goes once answered; a
  step shows the sub-view indicator moving (9) and the body swapping (`viewFade`)
- `transcript-dagactions` and `rendered-bs-run` pass, with their run links still opening the run off the Agent surface

### Task 6: Changes tab
**Depends on:** Task 2 (its scenario opens the Changes tab into the pane Task 2 renders)
**Files:** `frontend/app/view/agents/workspacechangestab.tsx`, `frontend/app/view/agents/changedfilelist.tsx`, `frontend/app/view/agents/diffpane.tsx`, `frontend/app/view/agents/diffcontentstore.ts`, `frontend/app/view/agents/diffcontentstore.test.ts`, `scripts/cdp/scenarios-workspace-changes.mjs`

**What to build:** ChangesTab, as the Changes board draws it: a line "N files +A −D · <branch>, <scope>" with "Open on
Diff ↗" (`openDiff` with `agentDiffScope`), a 206px file list (today's ChangedFileList, `review` null) beside the
selected file's diff (today's DiffPane). The list is the agent's `railStateAtom` changes (`useRailGit`), the same the
chip counts; the selection is the tab's `selected` (first file when unset or gone). The diff loads only while the
Agent surface is shown, through the Diff surface's pair loader against the same base the list is read against.
That loader and DiffPane share the global `diffPairAtom` with the Diff surface, so the tab's pair must never show on
the Diff surface (it re-reads its own selection on mount, or the tab keeps its own pair state: the worker picks).
Empty states: no changes, not a repo, loading (skeleton), read failed (with Retry).

**Acceptance:**
- selecting a file shows its diff and is kept when switching tabs or agents and back
- the file list and counts equal the agent's `railStateAtom` changes (`useRailGit`), the set the header chip counts
- after using the tab, the Diff surface shows its own scope and selection, not the tab's
- scenario `workspace-changes`: a fixture repo with two changed files: the list, the first file's diff, a second
  file selected with the diff swapping (`ViewSwap`), Open on Diff landing on the agent's scope (Changes board); a clean
  repo's empty state; the Diff surface afterwards showing its own selection

### Task 7: File tab
**Depends on:** Task 2 (its scenario opens the File tab into the pane Task 2 renders)
**Files:** `frontend/app/view/agents/workspacefiletab.tsx`, `frontend/app/view/code/codepeekcard.tsx`, `frontend/app/view/code/codepeekstore.ts`, `frontend/app/view/code/codepeekstore.test.ts`, `frontend/app/view/agents/renderedview.tsx`, `scripts/cdp/scenarios-workspace-file.mjs`, `scripts/cdp/scenarios-agent-rendered.mjs`, `scripts/cdp/scenarios-codepeek.mjs`

**What to build:** a reply's file link in Rendered opens a File tab (`openBeside`) instead of docking the peek under
the transcript; the dock goes. FileTab shows today's CodePeekCard in a tab variant, as the File board draws it:
"Code" label, the path (full path as title) and "Open in Code ↗" in its header, the Preview/Source/Diff row with the
stat and "Read-only", the body landed on the cited line; no footer and no own ×. The card's state comes from the
existing peek store, opened without its toggle (a second click on the same link activates the tab, it does not
close it); activating another File tab shows that file. Esc in the card runs the existing `codepeek:close` binding,
which closes the peek; FileTab closes its own tab when its peek goes away, so bindings.ts needs no edit. The tab's ×
closes the tab and its peek. The
terminal's Code peek is unchanged: the card's variant prop is optional, so `codepeekhost.tsx` needs no edit.

**Acceptance:**
- the store opens a peek for a request without toggling, and closing the File tab closes its peek
- scenario `workspace-file`: clicking `path:line` in a reply opens a File tab named by the base name, Source mode,
  the cited line highlighted and in view (File board); a second link to another file adds a tab; Esc in the card
  closes its tab; Open in Code lands on the Code surface at that line
- `agent-rendered`'s peek steps assert the tab instead of the dock; `code-peek` reads the details rail's Files touched
  row for a claude agent, so it pins the Terminal view (decision 12) and passes

### Task 8: Brainstorm and Canvas tabs, and one "shown" for both views
**Depends on:** Task 2, Task 3
**Files:** `frontend/app/view/agents/agentpanes.ts`, `frontend/app/view/agents/agentpanes.test.ts`, `frontend/app/view/agents/brainstormstore.ts`, `frontend/app/view/agents/canvasstore.ts`, `frontend/app/view/agents/canvassend.ts`, `frontend/app/view/agents/canvassend.test.ts`, `frontend/app/view/agents/canvasmodel.ts`, `frontend/app/view/agents/canvasmodel.test.ts`, `frontend/app/store/keybindings/bindings.test.ts`, `frontend/app/store/keybindings/whenstate.ts`, `frontend/app/store/keybindings/whenstate.test.ts`, `frontend/app/view/agents/renderedbsrows.tsx`, `frontend/app/view/agents/renderedbsboards.tsx`, `frontend/app/view/agents/agentsurface.tsx`, `frontend/app/view/agents/workspacepane.tsx`, `frontend/app/store/keybindings/bindings.ts`, `frontend/app/view/agents/agentheader.tsx`, `frontend/app/view/agents/agenttree.tsx`, `frontend/app/view/agents/canvaspoller.ts`, `frontend/app/view/agents/canvaspoller.test.ts`, `frontend/app/view/jarvis/openref.ts`, `docs/keyboard-shortcuts.md`, `scripts/cdp/scenarios-workspace-brainstorm-canvas.mjs`, `scripts/cdp/scenarios-rendered-brainstorm.mjs`, `scripts/cdp/scenarios-rendered-bs-mockup.mjs`, `scripts/cdp/scenarios-rendered-bs-check.mjs`, `scripts/cdp/scenarios-rendered-bs-design.mjs`, `scripts/cdp/scenarios-rendered-bs-review.mjs`, `scripts/cdp/scenarios-rendered-bs-question.mjs`, `scripts/cdp/scenarios-rendered-bs-boards.mjs`

**What to build:** decision 4. agentpanes.ts holds `paneShown(model, agentId): "brainstorm" | "canvas" | null` and
`showPane(model, agentId, kind, on, now)`: in Rendered it opens/activates the tab (stamping the seen mark as showing
the pane does) or closes it; in Terminal it sets `mode` as today. Every reader of `mode === "brainstorm" | "canvas"`
for "is it showing" and every writer that shows or hides one goes through them: the brainstorm/canvas keys (`b`,
`c`, Ctrl+Shift+B, the answer letters, the review keys, `[`/`]`, Esc's step-back), the tree's badges, the canvas
poller's on-screen test, openref's canvas and brainstorm landings, `openBrainstormAt` and the Rendered cards' canvas
opens. `openBrainstormAt` keeps its signature, so its callers (renderedbrainstorm.tsx, renderedbscheck.tsx,
renderedbsdesign.tsx, renderedbsquestion.tsx, renderedbsreview.tsx, renderedbsrows.tsx, renderedbsrun.tsx,
renderedbsboards.tsx, all Rendered cards) need no edit for it; it opens the tab through the workspace store directly.
After a mark is sent (canvassend.ts) the Terminal view returns to the terminal as today, and in Rendered the Canvas
tab stays open, since the transcript is already beside it. `isUnseen` takes whether the canvas is shown instead of
reading `mode`, so the tree and header badges stay right when the Canvas tab is what shows it. In Rendered the center never shows the brainstorm or canvas pane and the header's Brainstorm/Canvas switch is
gone (the tab replaces it; the view toggle stays). The Brainstorm and Canvas tab bodies fit the pane at 600px with no
horizontal scroll (Brainstorm and Canvas boards); the Brainstorm tab's dot shows while it asks. The `d` collapse
binding stands down while the shown Brainstorm tab's question offers a fourth option. keyboard-shortcuts.md: `b`, `c`
and Ctrl+Shift+B open and close the tab in Rendered.

**Acceptance:**
- `paneShown` and `showPane` cases: Rendered tab active / inactive / collapsed, Terminal mode on / off, an agent with
  both a brainstorm and a canvas (the brainstorm wins, as today)
- in Terminal, every existing brainstorm and canvas behaviour is unchanged (the `brainstorm-mode` scenario passes)
- scenario `workspace-brainstorm-canvas`: in Rendered, the brainstorm card's open link opens the Brainstorm tab with the
  transcript still visible, its question answerable there and by `a`-`d` (Brainstorm board); `b` closes and reopens
  it; the canvas card opens the Canvas tab with its boards and Mark (Canvas board); in Terminal the same links take
  over the center as before; a step shows the Brainstorm tab's asking dot appearing and going (3)
- `isUnseen` is false while the canvas shows in either view; a sent mark leaves the Canvas tab open in Rendered
- the listed `rendered-bs-*` scenarios assert the tab where they asserted the center pane, and pass
