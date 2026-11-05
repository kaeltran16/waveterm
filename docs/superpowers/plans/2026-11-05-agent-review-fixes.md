# Agent surface review fixes (F1-F20) Implementation Plan

> **For agentic workers:** each task below is one worker's job. It carries its design decisions, files, interfaces
> and acceptance; you write the implementation. Logic goes in pure `.ts` files with a vitest test beside them;
> `.tsx` stays a thin consumer (AGENTS.md "Logic is extracted, not rendered"). The spec restates every finding's
> decision and why; the review report it comes from (`cdp-shots/review/agent/report.md` in the main checkout,
> gitignored, screenshots beside it) is background.

**Goal:** Fix the 20 findings (F1-F20) of the Agent surface review; its "Tooling and procedure" and "Related to
known items" sections are out of scope.

**Architecture:** Two small roots land first side by side: the scenario scaffold with shared page fixtures (Task 1)
and the `isStandingBy(state, shellTasks, subagents)` interface with every caller updated (Task 2). Then the
shell-owned streams (Task 3), the subagent parse (Task 4), the tree-owned focus order and keys (Task 5) and the
header's shared state view (Task 6) run beside each other; the rail (Task 7) builds on the state
view, and the tree/launch fixes (Task 8) on the streams' and the focus order's files.

**Tech Stack:** React 19, jotai, Tailwind 4 (`@theme` tokens only), vitest, the CDP harness in `scripts/cdp/`.

**Spec:** `docs/superpowers/specs/2026-11-05-agent-review-fixes-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/agentsessions`
**Check:** `task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs agent-streams agent-subagents agent-keys agent-header agent-rail agent-tree agent-start-failed agent-launch-hero cockpit-offgrid cockpit-roster-counts cockpit-card-layout cockpit-rail-help cockpit-launch-stays`

## Global Constraints

- Colors and spacing from existing `@theme` tokens in `frontend/tailwindsetup.css` only (DESIGN.md); no new tokens.
- Scenario fixtures write nothing into `~/.claude/projects`: transcripts go under `os.tmpdir()` dirs the scenario
  removes. The fixture roster is set in the page through `devMockAgentsAtom` and restored to its previous value at
  teardown. A tab a scenario creates never runs an agent: no `claude`/`pi` controller on any block it makes.
- Every task that changes a view, a visual state or an interaction fills the steps of its own scenario module
  (named in its Files) with the step that shows it, and takes a screenshot per step through `h.shot`.
- Keyboard changes update `docs/keyboard-shortcuts.md`; the cheat sheet is generated from the binding labels in
  `bindings.ts`, so a label change there is the cheat sheet change.
- `tsconfig.json` is `strict: false`: narrow unions with `"x" in y`, not a boolean flag.
- Lint/format only the files you touch (`npx eslint <paths>`, `npx prettier --check <paths>`); keep prettier off
  `scripts/*.mjs`. `task check:ts` takes ~2 min: give it a longer timeout.
- A snapshot dev app on :9222 / :5174 belongs to another review: never attach to it or stop it. Check a scenario
  with `ARC_FINAL_OUT=<tmp dir> node scripts/cdp/final-verify.mjs <scenario>`, which starts its own app on its own
  ports, or a second dev app per `docs/reference/cdp-verification.md`.
- Comments say why, in lower case, only where needed. No new dependencies.

## Review Focus

- A Cockpit visit and return must not end a stream the shell holds: the Cockpit's unmount stops nothing (Task 3
  scenario step 3, and the Cockpit no longer imports `useCardStreams`).
- A background subagent whose finish notification never lands (a resumed or compacted parent) must not hold its
  parent "standing by" forever: it is done once its child file is done (Task 4 test
  `background spawn is done when its child file is done`).
- Moving focus while it sits on a row the tree no longer shows (its run was folded) starts from the first row
  rather than doing nothing (Task 5 test `step from a hidden row lands on the first row`).
- A Rename to an empty label on a booting row keeps the launch name (Task 8 test
  `mergePendingLaunches keeps the launch name for an empty label`).
- An agent interrupted, then given a new prompt that it finished, offers no Resume (Task 7 test
  `lastTurnInterrupted is false once a later turn ran`).

---

### Task 1: Agent scenario modules and page fixtures
**Depends on:** none
**Files:** `scripts/cdp/scenarios.mjs`, `scripts/cdp/agent-page-fixtures.mjs`, `scripts/cdp/agent-page-fixtures.test.mjs`, `scripts/cdp/scenarios-agent-streams.mjs`, `scripts/cdp/scenarios-agent-subagents.mjs`, `scripts/cdp/scenarios-agent-keys.mjs`, `scripts/cdp/scenarios-agent-header.mjs`, `scripts/cdp/scenarios-agent-rail.mjs`, `scripts/cdp/scenarios-agent-tree.mjs`

- Six scenario modules, each `export default function (kit) { return [scenario]; }` with one scenario named
  `agent-streams`, `agent-subagents`, `agent-keys`, `agent-header`, `agent-rail`, `agent-tree` (surface `agent`).
  Each stub's `assert` returns exactly one failing step `{ step: "<name>: steps not written yet", ok: false }`.
  Register them in `SCENARIOS` with `SESSIONS_KIT`, right after `...agentStartFailed(SESSIONS_KIT)`;
  `agentComposer` stays last.
- `agent-page-fixtures.mjs`, the helpers the six modules share (model `scenarios-agent-start-failed.mjs`'s `LIB`,
  `pageEval` and `makeAgentTab`, and `scenarios-cockpit-offgrid.mjs`'s roster swap):
  - `agentPage(h, body)`: evaluate `body` in the page with `mod`, `globalStore`, `WOS`, `agentsModel()` (the app's
    one `AgentsViewModel`, found from the nav rail's React props), `until`, `nap`, `flat` in scope.
  - `setRoster(h, roster)` saves the current `devMockAgentsAtom` value once per page in `window.__agentFixturePrev`
    and sets the roster; `restoreRoster(h)` puts the saved value back. `focusAgent(h, id)` sets `focusIdAtom` and
    lands on the `agent` surface.
  - `makeTab(h, ctx, { label, blockMeta, tabMeta })` creates a real tab as `makeAgentTab` does, pushes its id on
    `ctx.tabIds`, and returns `{ tabId, blockId }`; `closeTabs(h, ctx)` closes them best-effort.
  - Pure record builders for Claude transcript JSONL, each returning one JSON line: `userText(text)`,
    `assistantText(text)`, `toolUse(id, name, input)`, `toolResult(id, text, { toolUseResult, isError })`,
    `taskNotification({ taskId, toolUseId, status, summary })` (the `<task-notification>` user record shape seen in
    real transcripts: `<task-id>`, `<tool-use-id>`, `<status>`, `<summary>`), `interrupted()`,
    `usage({ input, output, cacheRead, cacheWrite, model })` (an assistant record carrying `message.usage`). Each
    record carries `timestamp`, `cwd` (an option, default the fixture dir) and `sessionId`.
  - `writeTranscript(dir, name, lines)` writes `<dir>/<name>.jsonl`; `writeSubagent(dir, name, agentId, lines)` writes
    `<dir>/<name>/subagents/agent-<agentId>.jsonl`, where `GetSubagentsCommand` looks for children.
- Tests in `agent-page-fixtures.test.mjs`: `each builder emits one parseable JSON line`,
  `taskNotification carries task-id, tool-use-id and status`, `toolResult keeps toolUseResult`,
  `writeSubagent puts the child under <name>/subagents`.

Acceptance: `node --check` passes on the eight `.mjs` files;
`node -e "import('./scripts/cdp/scenarios.mjs').then((m) => console.log(m.SCENARIOS.map((s) => s.name).join(' ')))"`
prints the six names, `agent-composer` still last; `npx vitest run scripts/cdp/agent-page-fixtures.test.mjs` passes.

### Task 2: Standing by takes the agent's subagents
**Depends on:** none
**Files:** `frontend/app/view/agents/shelltasks.ts`, `frontend/app/view/agents/shelltasks.test.ts`, `frontend/app/view/agents/session-models/sessionviewmodel.ts`, `frontend/app/view/agents/agentrow.tsx`, `frontend/app/view/agents/agenttree.tsx`, `frontend/app/view/agents/agentheader.tsx`, `frontend/app/view/agents/agentdetailsrail.tsx`, `frontend/app/view/agents/cockpiteventsrail.tsx`, `frontend/app/view/agents/cockpitsurface.tsx`, `frontend/app/view/agents/cockpitsurfacemodel.ts`, `frontend/app/view/agents/cockpitsurfacemodel.test.ts`, `frontend/app/cockpit/actions/agent.ts`, `frontend/app/view/agents/shelltasksstore.test.ts`

The interface F8 needs, landed alone so Tasks 3-7 build on it in parallel. No behavior changes until Task 4 sets
`background`.

- `SubagentVM` (`sessionviewmodel.ts`) gains `background?: boolean` (spawned with `run_in_background`; its tool
  result is only the launch ack).
- `isStandingBy(state: string, tasks: ShellTask[], subagents: SubagentVM[]): boolean` is true when idle and a shell
  task runs or a subagent with `background` is still `working`. The argument is required.
- Every caller passes the agent's list from `subagentsByIdAtom` (`[]` when absent): `agentrow.tsx`,
  `agenttree.tsx`, `agentheader.tsx`, `agentdetailsrail.tsx`, `cockpiteventsrail.tsx`, `cockpitsurface.tsx`,
  `cockpit/actions/agent.ts`, `shelltasksstore.test.ts` (its read-hold helper), and `splitRecentlyIdle`, which gains a `subagents: Record<string, SubagentVM[]> = {}`
  argument after `shellTasks`.
- Tests: in `shelltasks.test.ts`, `isStandingBy counts a working background subagent`,
  `isStandingBy ignores a foreground or finished subagent`, `isStandingBy is false while working`; in
  `cockpitsurfacemodel.test.ts`, `splitRecentlyIdle keeps an idle agent with a working background subagent`.

Acceptance: `npx vitest run frontend/app/view/agents/shelltasks.test.ts frontend/app/view/agents/cockpitsurfacemodel.test.ts`
passes; `task check:ts` passes.

### Task 3: The shell owns transcript streams and tracking (F1)
**Depends on:** Task 1, Task 2
**Files:** `frontend/app/view/agents/agentsviewmodel.ts`, `frontend/app/view/agents/agentsviewmodel.test.ts`, `frontend/app/view/agents/cockpitshell.tsx`, `frontend/app/view/agents/cockpitsurface.tsx`, `frontend/app/view/agents/subagenttracking.ts`, `frontend/app/view/agents/subagenttracking.test.ts`, `scripts/cdp/scenarios-agent-streams.mjs`

- `streamableTranscriptAgents(agents: AgentVM[], now: number, opts: { shellTasks: Record<string, ShellTask[]>;
  subagents: Record<string, SubagentVM[]>; focusId?: string }): AgentVM[]`: agents with a `transcriptPath` that are
  asking, working, recently idle (`isRecentlyIdle`), standing by (`isStandingBy` with both lists), or focused and not
  a terminal. Order follows the roster; no duplicates.
- `AgentStreams({ model })` in `cockpitshell.tsx`, rendered by `CockpitShell`, returns null. It reads the roster,
  `structuralNowAtom`, `shellTasksByIdAtom`, `subagentsByIdAtom` and `focusIdAtom`, calls
  `useCardStreams(<set mapped to WantedCard>, { trackGit: true })` and `useSubagentTracking(agents)`. The Cockpit
  removes its `useCardStreams` and `useSubagentTracking` calls (the `ensurePreviousInfo` effect stays). The Agent
  tree's own `useSubagentTracking` stays until Task 8 removes it.
- `useSubagentTracking` refreshes an agent on entering and whenever its transcript path changes: a pure
  `enterRefreshes(tracked: Map<string, string | undefined>, agents: Trackable[]): string[]` in `subagenttracking.ts`
  returns the ids to read (new ids, and tracked ids whose path differs).
- Tests: `streams the focused idle agent`, `skips a focused terminal`, `keeps a standing-by agent past grace`,
  `drops an idle agent past grace that is not focused`, `skips agents with no transcript` (agentsviewmodel; replace
  the existing `streamableTranscriptAgents` case); `enterRefreshes reads a new id`,
  `enterRefreshes reads an id whose path arrived`, `enterRefreshes skips an unchanged id` (subagenttracking).
- Scenario `agent-streams` (fresh page, the Cockpit not opened after the reload; fixture roster: a working claude
  agent focused, its temp transcript holding a running `run_in_background` Bash call and a few tool calls; rail open):
  1. without visiting the Cockpit, the tree row shows its "1 shell task" chip and the rail's Tools used lists the
     calls;
  2. a line appended to the transcript reaches the rail (a new tool chip) while on the Agent surface;
  3. after a Cockpit visit and back, the chip and Tools used are still there and the stream still delivers a new
     line; the Cockpit card for the agent showed its diff/transcript as before (no regression).

Acceptance: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts frontend/app/view/agents/subagenttracking.test.ts`
passes; `agent-streams`, `cockpit-offgrid` and `cockpit-card-layout` pass under `final-verify.mjs`.

### Task 4: Background subagent spawns and the handback tool (F8, F20)
**Depends on:** Task 1, Task 2 (sets the `SubagentVM.background` field Task 2 adds)
**Files:** `frontend/app/view/agents/transcriptprojection.ts`, `frontend/app/view/agents/transcriptprojection.test.ts`, `frontend/app/view/agents/subagentcorrelate.ts`, `frontend/app/view/agents/subagentcorrelate.test.ts`, `scripts/cdp/scenarios-agent-subagents.mjs`

- `SubagentSpawn` gains `background: boolean`. `extractSubagentSpawns`: a `tool_result` whose record's
  `toolUseResult` has `isAsync === true` or `status === "async_launched"` marks the spawn background and leaves it
  not done. A user record holding a `<task-notification>` whose `<tool-use-id>` names a background spawn marks it
  done, failed when `<status>` is not `completed`. A foreground spawn keeps today's rule.
- `correlateSubagents` copies `background` onto the `SubagentVM`. `resolveState` for a background spawn: working
  until the notification or the child file is done (`fileDone`), then failure / success from the notification, or
  `done` when only the file says so.
- F20: the Claude projector (`projectTranscript`, and the action and tool counts built from it) skips tool calls
  named `SubagentHandback` and their tool results.
- Tests: `async spawn stays working after its launch ack`, `task notification ends a background spawn`,
  `failed notification marks the background spawn failed`, `foreground spawn is done by its tool result`
  (transcriptprojection); `background spawn is done when its child file is done`, `correlate copies background`
  (subagentcorrelate); `projectTranscript drops SubagentHandback calls` (transcriptprojection).
- Scenario `agent-subagents` (fixture roster: one idle claude agent focused, its transcript under a temp dir with an
  `Agent` spawn whose result is an async launch ack and no notification, plus its child file under
  `<name>/subagents/` holding a `SubagentHandback` call; rail open):
  1. the header pill reads "standing by" and the rail offers no Resume;
  2. the tree row shows the subagent working;
  3. after appending a completed `<task-notification>` for it to the parent transcript, the pill reads idle and
     the subagent reads done (the re-read rides the shell-owned stream of the focused agent from Task 3, so this
     step is checked in Final on the merged tree; in this task's own tree it may report the subagent still working);
  4. the subagent interior lists no `SUBAGENTHANDBACK` row, and Tools used has no `subagenthandback` chip.

Acceptance: `npx vitest run frontend/app/view/agents/transcriptprojection.test.ts frontend/app/view/agents/subagentcorrelate.test.ts`
passes; the four `agent-subagents` steps pass under `final-verify.mjs agent-subagents`.

### Task 5: Focus order from the tree, and the Agent keys (F2, F7, F11, F12, F14 `d`)
**Depends on:** Task 1, Task 2
**Files:** `frontend/app/view/agents/agenttreemodel.ts`, `frontend/app/view/agents/agenttreemodel.test.ts`, `frontend/app/view/agents/agents.tsx`, `frontend/app/view/agents/agenttree.tsx`, `frontend/app/view/agents/agentsurface.tsx`, `frontend/app/store/keybindings/bindings.ts`, `frontend/app/store/keybindings/bindings.test.ts`, `frontend/app/store/keybindings/whenstate.ts`, `frontend/app/store/keybindings/store.test.ts`, `docs/keyboard-shortcuts.md`, `scripts/cdp/scenarios-agent-keys.mjs`

- `buildAgentTree(agents, lineage?, folds?, focusId?)` drops `order`: top-level rows follow roster order, pinned
  first. Update its tests that passed an order.
- `rowFocusKey(row: AgentTreeRow): string | undefined` (agent rows: `agent.id`; worker: `endedWorkerId` when ended
  as `WorkerRow` decides today, else `agent?.id`; final: `finalRowFocusId(run, agent ? [agent] : [])`; group, run,
  done, queued: undefined) and `treeFocusOrder(rows: AgentTreeRow[], terminals: AgentVM[]): string[]`. `WorkerRow`
  and `FinalRow` use `rowFocusKey`.
- `AgentsViewModel` gains `treeRowsAtom` (buildAgentTree over `agentsAtom`, `lineageAtom`, `treeFoldsAtom`,
  `focusIdAtom`) and `focusOrderAtom` (treeFocusOrder over it and `terminalsAtom`). `AgentTree` renders
  `treeRowsAtom` and stops reading `orderAtom`; `AgentSurface`'s default focus is the first id in `focusOrderAtom`
  that is an agent, else the first agent, else the first terminal. `orderAtom` is read by the Cockpit only.
- `cycleFocus(delta: 1 | -1)` cycles `focusOrderAtom` with wrap (`cycleId`). Bindings: `cycle-agent-next` →
  `cycleFocus(1)`, `cycle-agent-prev` → `cycleFocus(-1)` (label "Previous agent" stays); `step` reads
  `focusOrderAtom`; new `agent:prev-up` (`ArrowUp`, "Previous agent") and `agent:next-down` (`ArrowDown`, "Next
  agent") with `agent:prev-k`'s guard. The footer's "↑↓ move" chip (`footerhints.ts`) needs no change: it shows
  while any of its ids is active.
- F7: the close-agent binding passes only `agentsAtom`'s agents to `closeTargetForDoubleCtrlC`; a focused terminal
  returns null, so both presses reach the shell. Update the comment that cites spec §5.
- F14: `agent:toggle-rail`'s `when` is also false while the focused id is a terminal; extend `whenstate.ts` only as
  far as the PREDICATE_ATOMS completeness test in `store.test.ts` demands.
- Docs (`docs/keyboard-shortcuts.md`): Global table "`Ctrl`+`Tab` / `Ctrl`+`Shift`+`Tab` | Next / previous agent in
  the tree's order (terminals included)" and "`Ctrl`+`C` `Ctrl`+`C` … | Close the focused agent (on a plain terminal
  both presses go to the shell)"; Agent table "`j` / `k` (or `↓` / `↑`, `→` / `←`) | Next / previous row in the tree:
  agents, workers and terminals".
- Tests: `rows follow roster order, pinned first`, `rowFocusKey for each row kind`,
  `treeFocusOrder appends terminals after the rows`, `treeFocusOrder skips workers of a folded run`
  (agenttreemodel); `step from a hidden row lands on the first row`, `Ctrl+Shift+Tab cycles backward`,
  `ArrowDown steps like j`, `double Ctrl+C on a terminal opens no confirm`, `toggle-rail is off for a terminal`
  (bindings; replace the old closeTargetForDoubleCtrlC terminal case).
- Scenario `agent-keys` (fixture roster: three agents of one project, one pinned and idle past the grace window,
  one with `booting: true`; plus one real plain terminal tab; Cockpit not visited). Dispatch keys as `keydown`
  events from page JS with focus outside the terminal: CDP `Input.dispatchKeyEvent` often never reaches the
  WebView.
  1. `j` from the first row visits every tree row in its rendered order, the idle and booting agents and the
     terminal included; `k` walks back;
  2. `↓` / `↑` do the same; the footer's "↑↓ move" chip is shown;
  3. `Ctrl+Tab` wraps from the terminal to the first row; `Ctrl+Shift+Tab` goes backward;
  4. a Cockpit visit that parks the idle agent leaves the tree order unchanged on return;
  5. two `Ctrl+C` presses within 500 ms with the terminal focused open no close confirm; on an agent they do (cancel
     it);
  6. with the terminal focused the footer has no `d` chip; with an agent focused it has.

Acceptance: `npx vitest run frontend/app/view/agents/agenttreemodel.test.ts frontend/app/store/keybindings/bindings.test.ts frontend/app/store/keybindings/store.test.ts frontend/app/cockpit/footerhints.test.ts`
passes; `agent-keys`, `cockpit-roster-counts` and `cockpit-rail-help` pass under `final-verify.mjs`.

### Task 6: Header and the shared state view (F10, F13, F14, F18)
**Depends on:** Task 1, Task 2
**Files:** `frontend/app/view/agents/agentstateview.ts`, `frontend/app/view/agents/agentstateview.test.ts`, `frontend/app/view/agents/agentheader.tsx`, `scripts/cdp/scenarios-agent-header.mjs`

- `agentStateView(input: { agent: Pick<AgentVM, "state" | "kind" | "startError" | "agent">; ended: boolean;
  landed: boolean; runDone: boolean; standingBy: boolean; silentMs: number | null }): { text: string; tone:
  StateTone } | null`, `type StateTone = "success" | "error" | "warning" | "accent" | AgentState`. Order: terminal →
  null; ended or runDone → "landed" / "done" (success); startError → "failed to start" (error); `silentMs` non-null
  → `quiet ${Math.floor(silentMs / 60_000)}m` (warning); standingBy → "standing by" (accent); else the state label
  (`STATE_LABEL`), tone the state. Export `STATE_TONE_COLOR: Record<StateTone, string>` (the CSS vars the header uses
  today plus `var(--color-warning)`).
- The header renders its pill from `agentStateView` (no pill for a terminal); `silentMs` comes from
  `hungSilenceMs(agent, lastOutputTs, structuralNow)` with `getLastOutputAtom(blockId)` and
  `model.structuralNowAtom`. A booting launch still reads "working" (the `agent-start-failed` scenario asserts it).
- F13 titles: fullscreen off "Fullscreen terminal (f, or F11 in the terminal)", on "Exit fullscreen (F11, or f / Esc
  outside the terminal)" (chords through `formatChordString`); close button "Close agent (Ctrl+C twice in its
  terminal)" for agents, "Close terminal" for terminals.
- F14: the header menu's "Interrupt turn" item is offered only while `agent.state === "working"`.
- Tests: `terminal has no state view`, `quiet wins over working`, `failed to start wins over standing by`,
  `done and landed`, `standing by is accent`, `plain idle and asking`.
- Scenario `agent-header` (fixture roster: a working claude agent with a real block id from a non-running tab, an
  idle agent, one real plain terminal tab):
  1. a terminal focused: no state pill, and the close title reads "Close terminal";
  2. the idle agent's header menu has no "Interrupt turn"; the working agent's has it;
  3. with the working agent's last output set 4 minutes back (`getLastOutputAtom` in the page), the pill reads
     "quiet 4m" in the warning color;
  4. the fullscreen button's titles name F11, before and after toggling.

Acceptance: `npx vitest run frontend/app/view/agents/agentstateview.test.ts` passes; `agent-header` and
`agent-start-failed` pass under `final-verify.mjs`.

### Task 7: Rail actions, Session line, Files touched and tokens (F4, F5, F9, F10, F17, F18, F19)
**Depends on:** Task 1, Task 2, Task 6 (renders `agentStateView` and `STATE_TONE_COLOR`)
**Files:** `frontend/app/view/agents/agentrailmodel.ts`, `frontend/app/view/agents/agentrailmodel.test.ts`, `frontend/app/cockpit/actions/agent.ts`, `frontend/app/cockpit/actions/agent.test.ts`, `frontend/app/view/agents/agentdetailsrail.tsx`, `frontend/app/view/agents/railstore.ts`, `frontend/app/view/agents/tokenusagesection.tsx`, `scripts/cdp/scenarios-agent-rail.mjs`

- `railAction(input: { state: AgentState; age: string; live: boolean; standingBy: boolean; interrupted: boolean;
  silentMs: number | null }): RailAction | null`: not live or standing by → null; asking → `{ kind: "none", hint:
  "waiting on you · answer in the terminal" }` (F4, no button); idle → Resume with `idle <age> · nudge to continue`
  only when `interrupted`, else null (F9); working and quiet → Stop with `quiet · no output <N>m · Esc also stops`
  and a warning tone (F18); working → Stop as today. `RailAction` becomes `{ kind: "resume" | "stop" | "none"; hint:
  string; tone?: "warning" }`.
- `lastTurnInterrupted(entries: AgentEntry[]): boolean`: the last entry is `{ kind: "interrupted" }`.
- The palette's `agent:nudge` (`cockpit/actions/agent.ts`) follows the same rule (one rule for one action): it
  calls `railAction` with the object input, `interrupted` from `lastTurnInterrupted(liveEntriesByIdAtom[id] ??
  agent.previousInfo ?? [])` and `silentMs: null`. An idle agent with no entries offers no Nudge. Update
  `agent.test.ts`'s idle-nudge case to `nudge applies only after an interrupted turn`.
- `railReloadKey(agent: Pick<AgentVM, "id" | "transcriptPath" | "blockId" | "idleSince">, lastEditTs?: number):
  string`; the rail reloads when it changes. `loadRailForAgent(id, transcriptPath, blockId, opts?: { silent?:
  boolean })`: silent keeps the shown state until the new read lands (a focus change stays non-silent). The block's
  `agent:lasteditts` is read from its WOS block atom.
- `newTokens(classes: ClassUsage[]): number`: the sum of every class but `cacheRead`.
- The rail's Session line renders `agentStateView` (same inputs as the header, F10) plus the age. The footer renders
  "none" as the hint alone and the warning tone with `text-warning`.
- F17 in `TokenUsageSection`: the section label's total goes; the headline pair is `newTokens` captioned "new
  tokens" and the spend; the Tokens bar row's right label reads `<total> total`.
- F19: Files touched's summary reads `repo · <filesSummary>` with the title "All changes in this checkout, shared
  by N agents" when `sharedCheckoutCount(agent.id, cardCwdByIdAtom) > 1` (reuse `cardgitstore.ts`, no copy).
- Tests: `asking offers no stop`, `idle offers resume only after an interrupt`, `quiet working warns and keeps
  stop`, `standing by offers nothing`, `lastTurnInterrupted is false once a later turn ran`,
  `railReloadKey changes with lasteditts and a new idle episode`, `newTokens leaves out cache reads` (replace the
  old `railAction` cases).
- Scenario `agent-rail` (temp git repo with one committed file; fixture transcripts carry `cwd` = the repo and usage
  records; fixture agents with real block ids from non-running tabs so `agent:lasteditts` can be set; rail open):
  1. an asking agent: the footer hint reads "waiting on you · answer in the terminal" and has no Stop;
  2. an idle agent whose transcript ends finished: no Resume; one whose transcript ends interrupted: Resume;
  3. the rail Session line's state text equals the header pill's for idle, standing by and quiet agents;
  4. editing the repo file and bumping the block's `agent:lasteditts` (setmeta) shows the file in Files touched
     without refocusing, and the list never blanks during the reload;
  5. Token usage shows the total once and "new tokens" as the headline;
  6. a second fixture agent in the same repo makes the summary read "repo · …" with the shared title;
  7. a working agent whose last output is 4 minutes old shows the quiet hint beside Stop.

Acceptance: `npx vitest run frontend/app/view/agents/agentrailmodel.test.ts frontend/app/cockpit/actions/agent.test.ts`
passes; `agent-rail` passes under `final-verify.mjs`. Steps 6 and 7 read `cardCwdByIdAtom` and the focused agent's
stream, which the shell owner from Task 3 keeps filled: they are checked in Final on the merged tree.

### Task 8: Duplicate, pending rename and pin, empty AGENTS group, terminal launch (F3, F6, F15, F16)
**Depends on:** Task 3, Task 5
**Files:** `frontend/app/view/agents/session-models/sessionviewmodel.ts`, `frontend/app/view/agents/session-models/sessionviewmodel.test.ts`, `frontend/app/view/agents/agentsviewmodel.ts`, `frontend/app/view/agents/agentsviewmodel.test.ts`, `frontend/app/view/agents/agents.tsx`, `frontend/app/view/agents/agenttree.tsx`, `frontend/app/view/agents/agentlaunchhero.tsx`, `frontend/app/view/agents/launch.ts`, `frontend/app/view/agents/launch.test.ts`, `frontend/app/view/agents/newagentmodal.tsx`, `frontend/app/cockpit/cockpit-actions.ts`, `frontend/app/cockpit/cockpit-actions.test.ts`, `scripts/cdp/scenarios-agent-tree.mjs`

- F3: `buildDuplicateBlockMeta` sets `cmd:args` to a copy of `agent:baseargs` when the source has that array.
- F6: `mergePendingLaunches(base, pending, now, tabMeta: Record<string, { label?: string; pinned?: boolean }> = {})`
  overlays a non-empty `label` as the booting row's name and `pinned`; `agentsAtom` builds `tabMeta` for the pending
  tab ids from their tab WOS atoms (`session:label`, `session:pinned`).
- F15: when the roster has no agents, `AgentTree` renders under its AGENTS header a "No agents" line, a New agent
  button (opens `newAgentOpenAtom`) and up to `RECENT_IN_TREE = 3` recent sessions from `recentSessionsAtom`
  (loading them as the hero does), each resuming through
  `launchAgentOrToast(model, resumeLaunchOpts({ ...s, live: false, needsAttention: false }))`, the call the palette's
  session rows already make (`palette-items.ts:425`, `resumeLaunchOpts` in `sessionsruns.ts`). The hero's own
  `resume` is replaced by that same call. Remove `AgentTree`'s `useSubagentTracking` (the
  shell tracks since Task 3).
- F16: `launchFocuses(runtime: Runtime, surface: SurfaceKey): boolean` in `launch.ts` (agents: always; terminals:
  only on `agent`); `launchAgent` focuses a terminal it launched when that holds. `runtimeLaunchLabel(runtime,
  surface)` reads "Add terminal" for a terminal off the Agent surface, "Open terminal" on it; `newagentmodal.tsx`
  passes the surface.
- Tests: `duplicate drops the task and keeps the flags`, `duplicate keeps cmd:args without baseargs`,
  `duplicate of an empty baseargs launch has no args` (sessionviewmodel); `mergePendingLaunches overlays label and
  pinned`, `mergePendingLaunches keeps the launch name for an empty label` (agentsviewmodel); `launchFocuses`, `runtimeLaunchLabel by surface` (launch); `a terminal launched on the Agent
  surface is focused`, `a terminal launched on the Cockpit stays in the background` (cockpit-actions).
- Scenario `agent-tree`:
  1. a fixture roster of `[]` and one real plain terminal tab: the AGENTS group shows "No agents", New agent (it
     opens the New agent modal; close it) and the recent sessions list when there are any (skip that part of the
     step with a reason when the store has none);
  2. a pending launch on a tab with no controller (as `agent-start-failed` makes it): Rename and Pin through the row
     menu show on the booting row at once;
  3. Duplicate of a tab whose block meta is `{ controller: "cmd", cmd: "node", "cmd:args": ["-e", "", "TASK"],
     "agent:baseargs": ["-e", ""] }` (never focused, so it never starts) creates a block whose `cmd:args` is
     `["-e", ""]`;
  4. on the Agent surface the New agent modal's terminal button reads "Open terminal" and launching focuses the new
     terminal (its pane shows); on the Cockpit it reads "Add terminal".

Acceptance: `npx vitest run frontend/app/view/agents/session-models/sessionviewmodel.test.ts frontend/app/view/agents/agentsviewmodel.test.ts frontend/app/view/agents/launch.test.ts frontend/app/cockpit/cockpit-actions.test.ts`
passes; `agent-tree`, `agent-launch-hero` and `cockpit-launch-stays` pass under `final-verify.mjs`.
