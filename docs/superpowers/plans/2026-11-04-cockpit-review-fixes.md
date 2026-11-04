# Cockpit review fixes (F1-F24) Implementation Plan

> **For agentic workers:** each task below is one worker's job. The task carries its design decisions, files,
> interfaces and acceptance; you write the implementation. Logic goes in pure `.ts` files with a vitest test
> beside them; `.tsx` stays a thin consumer (AGENTS.md "Logic is extracted, not rendered"). This plan is
> self-contained: the review report it comes from (`C:\Users\kael02\IdeaProjects\waveterm\cdp-shots\review\cockpit\report.md`,
> gitignored in the main checkout) is background only, and every finding's decision is restated below.

**Goal:** Fix the 24 findings (F1-F24) of the Cockpit surface review. Its "Tooling and procedure" section is out of scope.

**Architecture:** The changes are frontend-only. They reuse two backend paths that already exist:
- `AgentPromptCommand` types the text as a bracketed paste, pauses, then sends Enter, or hands the text to the agent's mod over its stream.
- `ControllerResyncCommand` starts a block's process without a terminal mounted.

The work is split as follows:
- A small interface task lands first: the `booting` flag on `AgentVM`, and `cardBody`.
- The roster/counts task and the card task then run side by side. Each is the single owner of one big file (`cockpitsurface.tsx` and `agentrow.tsx`).
- The off-grid task follows the roster task.
- The composer, ask, launch and rail/help tasks run beside all of this.
- Each task owns its own scenario module, which Task 1 scaffolds. A last sweep task owns the existing `scripts/cdp/scenarios-cockpit.mjs` and the steps that need several tasks landed.

**Tech Stack:** React 19, jotai, Tailwind 4 (`@theme` tokens only), vitest, the CDP scenario harness in `scripts/cdp/`.

## Design decisions (made from the goal; why in each line)

- **F1 (composers left long replies unsent):** every free-text send to an agent goes through `RpcApi.AgentPromptCommand`, never one `ControllerInputCommand` write of `text + "\r"`. The report's paste theory is unconfirmed. Either way, the backend `typeWake` path (`pkg/orchestrate/wake.go:784`: a bracketed paste, `agentask.KeystrokeDelay`, then a separate `\r`) is the tested way long, multi-line text submits to Claude, and it also hands text to a mod-held stream. The same root cause covers the channel steer paths (`channelactions.ts:110-113`, `:138-141`), so they move too. Short fixed keystrokes (`/compact\r`, `NUDGE_INPUT`) stay on `driveAgent`.
- **F2/F9 (backgrounding an asking card hid the ask; Backgrounded said "still running" after a finish):** only a working agent can be backgrounded. A plain agent's id leaves the backgrounded set as soon as it stops working (it asks or finishes), so the Backgrounded section only ever holds running agents and its "still running" note is true. A run lead's id is kept: its card hides via `isBackgroundedRun`, which already resurfaces on needs-you, and a lead idles between wakes.
- **F3 (× on a Claude ask made a blocked agent look busy):** the × shows only for runtimes where dismissing cancels the ask (pi). For Claude it would only hide the panel copy while the agent stays blocked, so it is not offered.
- **F4/F5 (a launched agent was invisible until its first transcript entry; parked agents fell out of the counts):** no plain agent is hidden. An agent with nothing to show yet (a booting launch, or one at a trust prompt) renders a compact "Waiting in its terminal" card with an Open terminal button. Every count reads the roster, not a hidden set. A pending launch is marked `booting: true` instead of passing as working: it counts in agents and live, but not in working, and its status line reads "starting".
- **F5/F11 (the empty state covered the Idle list; a scope with no agents showed a blank grid):** the full "No agents running" state shows only for an empty seeded roster. A grid that is empty for another reason gets a smaller grid-only notice: the scope has no agents ("No agents in <project>"), or everything is parked or backgrounded ("Nothing live: N idle, M backgrounded below"). Any overlay covers only the grid, never the Backgrounded/Idle sections or the hints bar.
- **F6 (digit keys didn't advance a multi-question ask; Enter on a partial answer opened the Agent surface):** a digit key picks an option. On a single-select question it then moves to the next unanswered question, as a click does, but it never submits: the keyboard keeps Enter as the confirm step, so a stray digit cannot send. Enter submits when every question has an answer, and otherwise moves to the next unanswered question. It never opens the Agent surface while a structured ask is unanswered.
- **F7 (the header switcher's lower rows were unclickable over the empty state):** the toolbar header stacks above every grid overlay (`z-20` against the overlay's `z-10`).
- **F8 (the diff chip charged every agent in a checkout with all its changes):** when two or more cards resolve to the same checkout (same normalized cwd), the chip keeps its numbers but says it is repo-wide: a "repo" prefix in muted text, and a title naming the shared count. Intersecting with transcript-edited files was rejected: Bash and codegen edits would go uncounted, and the chip would understate silently.
- **F10 (a standing-by agent counted as ready for review and Live only hid it):** an agent that is standing by (idle with a running shell task) is live. It matches the working tab, not ready for review, and Live only keeps it.
- **F11:** with a project scope set, the toolbar fact, the tab counts and the Events rail all follow the scope.
- **F12 (the idle card's "Move to background" actually dismissed it to Idle):** the action is labeled "Move to Idle", in the menu and on the button.
- **F13 (Idle rows always read "just now idle"):** Idle and Backgrounded rows format `displayAgeMs(agent, now)`, the age the agent's state actually populates, never `activeMs`.
- **F14 (an Events row for an off-grid agent did nothing):** the row restores a backgrounded agent (then cursors and pulses it), opens a parked idle agent's terminal (as its Idle row does), and opens anything else in the Agent surface.
- **F15 (New agent ignored the Cockpit's scope):** New agent preselects the Cockpit's project scope when that project is a launch candidate, and otherwise keeps the most-recent default.
- **F16 (agents launched in one project all got its name):** an agent's roster name is `rowLabel` (`session-models/sessionviewmodel.ts:188`): its `session:label`, else its ai-title, else its project. Writing a unique `session:label` at launch was rejected: it would outrank the ai-title for the agent's whole life. Instead, `buildSessionViewModel` numbers repeated project-fallback labels in input (tab) order, as `deriveTerminalVMs` numbers terminals: "demo", "demo 2", "demo 3". A titled or custom-labelled agent is never numbered. The pending row uses the same rule against the live roster, so the name does not jump when the real row replaces it. Closing an earlier agent renumbers the later ones, as terminals already do.
- **F17 (the hints bar wrapped and clipped):** the bar is one line. Hints that don't fit drop whole from the end (a one-line-high wrapping row with overflow hidden), and the `?` chip and readouts never clip. "esc back" goes, since Escape does nothing on the Cockpit; "space peek" comes in.
- **F18 (counts mixed units):** one unit everywhere: the tab counts are card counts over the shown cards, the toolbar fact pluralizes ("1 agent · 1 project"), and the switcher's All count reads the same roster count as the toolbar.
- **F19 (an "asked" rail event could lack its question):** an event recorded before its question arrived takes the question text once it lands.
- **F20 (the collapsed Events rail gave no signal):** it shows its glyph plus the unread count.
- **F21 (`?` opened the cheat sheet on the Agent group):** confirmed cause: the sheet sorts by `a === surface` (`shortcuts-cheatsheet.tsx:41`), comparing the surface key `cockpit` with the group name `Cockpit`, so no surface's own group ever sorts first. It will reuse the palette's `SURFACE_GROUP` map (`palette-commands.ts:135`), the single key-to-group source.
- **F22 (layout broke at the 1000x700 dev window):** in the card header the name has priority. The shell-task, subagent and diff chips collapse to count-only below the card width where they would collide (a container query on the card). An asking card's single scroll region starts scrolled so the first answer option is in view.
- **F23 ("manual drag reorder" was claimed but doesn't exist; a restored card went to the end):** the false claim is removed. Card order is merged over active and backgrounded ids, so a restored card returns to its old slot.
- **F24 (every launch from the Cockpit switched to the Agent surface):** `launchAgent` starts the new block's process itself with `ControllerResyncCommand` (no force, no term size), so the process starts without the terminal mounting. A launch made on the Cockpit stays there; one made on any other surface lands on the Agent surface as today. A start error (for example the snapshot refusal) is thrown to the caller, which shows it. No term size: like run workers (`runexec.go:164`, which also pass none), the process starts at the block's stored size, and the terminal resizes it when first opened. Unlike workers there is no force: a fresh block has no controller to replace.

## Global Constraints

- Colors and spacing from existing `@theme` tokens in `frontend/tailwindsetup.css` only (DESIGN.md); no new tokens.
- Every logic change lands in a pure `.ts` file with vitest tests beside it.
- Every fixed visual state or interaction gets a step that shows it, in the task's own scenario module. Opening the Cockpit alone does not count.
- Only Task 10 edits `scripts/cdp/scenarios-cockpit.mjs`; no other task touches it.
- `tsconfig.json` is `strict: false`: narrow ok-unions with `"reason" in x`, not `x.ok`.
- Lint/format only the files you touch (`npx eslint <paths>`, `npx prettier --check <paths>`); keep prettier off `scripts/*.mjs`.
- Scenario fixtures: a fixture roster is the JSON written to `TREE_RAIL_FIXTURE` (see `surfaceHeadersArrange` in `scripts/cdp/scenarios-cockpit.mjs`), and app state is set through the app's own modules via `lookEval` (`scripts/cdp/scenarios-shared.mjs`). A fixture agent that must show transcript entries gets a real `transcriptPath`, found the way `surfaceHeadersArrange` finds one.

## Review Focus

- A launch from the Cockpit whose agent stops at Claude's folder-trust prompt: its card shows "Waiting in its terminal" and counts in agents and live (Task 5 `cardBody` tests; Task 10 step "a launch from the Cockpit shows a Waiting in its terminal card").
- A backgrounded run lead idling between wakes must stay backgrounded (Task 7 test `prunedBackgrounded keeps a run lead's id`).
- A multi-select question and a digit: the digit toggles and stays on that question (Task 3 test `pickAdvance stays on multi-select`).
- Composer text with leading/trailing whitespace or embedded newlines arrives as one trimmed message, and a failed send keeps the text in the composer (Task 2 tests).
- Two agents in different worktrees of one repo are not "shared"; two in the same checkout are, with case-insensitive Windows paths (Task 8 test `sharedCheckoutCount`).

**Verify:** `node scripts/verify.mjs ./pkg/blockcontroller`
**Check:** `task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs cockpit-composer-send cockpit-ask-keys cockpit-launch-stays cockpit-roster-counts cockpit-offgrid cockpit-card-layout cockpit-rail-help cockpit-empty-state context-menu surface-headers shell-tasks cockpit-keys-on-arrival cockpit-polish`

---

### Task 1: Scaffold the seven review scenario modules
**Depends on:** none
**Files:** `scripts/cdp/scenarios.mjs`, `scripts/cdp/scenarios-cockpit-composer.mjs`, `scripts/cdp/scenarios-cockpit-asks.mjs`, `scripts/cdp/scenarios-cockpit-launch.mjs`, `scripts/cdp/scenarios-cockpit-roster.mjs`, `scripts/cdp/scenarios-cockpit-offgrid.mjs`, `scripts/cdp/scenarios-cockpit-card.mjs`, `scripts/cdp/scenarios-cockpit-rail.mjs`

Create the seven modules. Each exports one named scenario object, shaped like `cockpitEmptyState` in `scripts/cdp/scenarios-cockpit.mjs` (`{ name, surface: "cockpit", arrange, assert, teardown }`); these are not the kit-factory default exports the brainstorm modules use. In module order, the names are `cockpit-composer-send`, `cockpit-ask-keys`, `cockpit-launch-stays`, `cockpit-roster-counts`, `cockpit-offgrid`, `cockpit-card-layout`, `cockpit-rail-help`. Each stub's `assert` returns exactly one failing step, `{ step: "<name>: steps not written yet", ok: false }`, so a task that forgets its steps fails Final instead of passing it empty. Import all seven in `scripts/cdp/scenarios.mjs` and add them to `SCENARIOS`, after the entries imported from `./scenarios-cockpit.mjs`.

Acceptance: `node --check` passes on all eight files. `node -e "import('./scripts/cdp/scenarios.mjs').then((m) => console.log(m.SCENARIOS.map((s) => s.name).join(' ')))"` prints the seven new names. `npx vitest run scripts/cdp` still passes.

### Task 2: Composer and steer sends submit long text (F1)
**Depends on:** Task 1 (fills the `cockpit-composer-send` stub it creates)
**Files:** `frontend/app/view/agents/agentsend.ts`, `frontend/app/view/agents/agentsend.test.ts`, `frontend/app/view/agents/agentcomposer.tsx`, `frontend/app/view/agents/agentcomposer.test.ts`, `frontend/app/view/agents/channelactions.ts`, `scripts/cdp/scenarios-cockpit-composer.mjs`

- Create `agentsend.ts`, exporting `sendAgentText(blockId: string, text: string): Promise<void>`. It trims the text and calls `RpcApi.AgentPromptCommand(TabRpcClient, { blockid, text })`. It rejects, with the block id in the message, on empty text or when the RPC fails.
- `AgentComposer.send` uses it, clears the textarea only after the promise resolves, and on rejection keeps the text and logs the error (no silent swallow).
- `channelactions.ts`'s steer branch and `steerWorker` use it in place of their `ControllerInputCommand` writes.
- Tests in `agentsend.test.ts` mock `RpcApi`, as `frontend/app/view/code/codereviewstore.test.ts` does: `sends a 120-character message as one AgentPromptCommand`, `trims whitespace and keeps embedded newlines`, `never calls ControllerInputCommand`, `rejects on empty text`, `rejects with the block id when the RPC fails`.
- Scenario `cockpit-composer-send`:
  - Start a real block running a small node echo program that strips the bracketed-paste markers and prints `GOT:<line>` on each CR.
  - Seed a fixture roster in which the working agent and the idle agent both have a real `transcriptPath` with entries, so today's hiding rule (removed by Task 6) hides neither. The block is the agent's `blockId`.
  - Steps: "a 120-character card reply arrives whole and submits once" (type it in the working card's composer, Send, and assert the block's output shows `GOT:<the whole 120 characters>` once), and "the Idle row composer sends the same way" (the idle agent parked, sent from its Idle row composer).

### Task 3: Ask keys and Claude-ask dismiss (F3, F6)
**Depends on:** Task 1 (fills the `cockpit-ask-keys` stub it creates)
**Files:** `frontend/app/view/agents/askflow.ts`, `frontend/app/view/agents/askflow.test.ts`, `frontend/app/view/agents/answerbar.tsx`, `frontend/app/view/agents/usecockpitkeyboard.ts`, `scripts/cdp/scenarios-cockpit-asks.mjs`

- Create `askflow.ts` (new file). It imports `nextUnansweredQuestion` and the types from `agentsviewmodel.ts`, which this task does not edit, and exports:
  - `pickAdvance(questions: AgentAskQuestion[], selections: Record<number, Set<number>>, texts: Record<number, string>, qi: number): number | null`. It returns the next unanswered question after a pick on `qi`, or `null` to stay (the question is multi-select, or no other question is unanswered).
  - `enterAction(questions, selections, texts, activeQi: number): { kind: "submit" } | { kind: "question"; qi: number }`.
  - `canDismissAsk(agent: AgentVM): boolean`, true only for `agent.agent === "pi"`.
- `AnswerBar` renders its × only when `onDismiss && canDismissAsk(agent)`; this covers the card and the channel rows. Its option click keeps today's behavior (a click on the last single-select answer submits).
- `usecockpitkeyboard.ts`: after a digit's `toggleAnswer`, read the fresh selections and texts from `model.answerSelAtom` / `model.answerTextAtom` and call `selectQuestion` with `pickAdvance`'s result when it is not null. Enter on an asking card, or on a task row with a structured ask, follows `enterAction` and never calls `openFocus` while the ask is unanswered.
- Tests: `pickAdvance moves to the next unanswered question`, `pickAdvance stays on multi-select`, `pickAdvance stays when nothing else is unanswered`, `enterAction submits when every question is answered`, `enterAction moves to the first unanswered question`, `canDismissAsk is true for pi and false for claude, codex and opencode`.
- Scenario `cockpit-ask-keys` (fixture: a two-question Claude ask, and a one-question pi ask): steps "digit 1 on question 1 moves the ask to question 2", "Enter with question 2 unanswered stays on the Cockpit and shows question 2", "the Claude ask shows no dismiss ×", "the pi ask shows its dismiss ×".

### Task 4: Launch stays on the Cockpit, scoped and distinctly named (F15, F16, F24)
**Depends on:** Task 1 (fills the `cockpit-launch-stays` stub it creates)
**Files:** `frontend/app/cockpit/cockpit-actions.ts`, `frontend/app/cockpit/cockpit-actions.test.ts`, `frontend/app/view/agents/launch.ts`, `frontend/app/view/agents/launch.test.ts`, `frontend/app/view/agents/newagentmodal.tsx`, `frontend/app/view/agents/session-models/sessionviewmodel.ts`, `frontend/app/view/agents/session-models/sessionviewmodel.test.ts`, `scripts/cdp/scenarios-cockpit-launch.mjs`

- `launch.ts` exports:
  - `numberedName(base: string, taken: string[]): string`: "demo", then "demo 2", "demo 3"; it fills the lowest free number.
  - `launchLanding(surface: SurfaceKey): SurfaceKey | null`: `null` on `"cockpit"`, `"agent"` otherwise.
  - `defaultLaunchProject(chosen: string, candidates: { name: string }[], scope: string): string`: an explicit pick wins, then the scope when it is a candidate, then `candidates[0]?.name ?? ""`.
- `sessionviewmodel.ts`: `buildSessionViewModel` numbers rows whose label came from the project fallback (no custom label, no title) when the same label repeats, in input order across all groups: the first keeps the bare name, then " 2", " 3". It uses `numberedName` or the same rule; keep `rowLabel` the single place that picks the fallback.
- `launchAgent`, for an agent runtime: the pending row's name is `opts.label || numberedName(opts.projectName, <names of the live roster's agents>)`. After the block meta is set and reloaded, it awaits `RpcApi.ControllerResyncCommand(TabRpcClient, { tabid: tabId, blockid: blockId })` and lets any error throw. It then sets `focusIdAtom` to the tab and switches surface only to `launchLanding(<current surface>)`. Update its header comment, which today says the process starts when the terminal mounts.
- `newagentmodal.tsx`: `selectedProject = defaultLaunchProject(project, candidates, <model.projectFilterAtom>)`.
- Tests:
  - `launch.test.ts`: `numberedName` (no clash, one clash, a gap filled), `launchLanding` (cockpit → null, jarvis → agent), `defaultLaunchProject` (explicit, scope, scope not a candidate, no candidates).
  - `sessionviewmodel.test.ts`: `numbers repeated project-fallback labels in tab order`, `never numbers a titled or custom-labelled row`.
  - `cockpit-actions.test.ts`: `launchAgent starts the controller with ControllerResyncCommand`, `launchAgent from the Cockpit leaves surfaceAtom on cockpit`, `launchAgent rethrows a controller start error`.
- Scenario `cockpit-launch-stays`:
  - Arrange: register a temp project (as `new-project-modal` does), and scope the Cockpit to it.
  - Open New agent and assert the scoped project is preselected.
  - Set the command field to a harmless long-running command and launch. Assert the surface is still the Cockpit, and that the block's controller reports running without its terminal having mounted.
  - Launch a second time. Once the real roster row has replaced the pending one, assert the second agent's roster name is "<project> 2" (read it from the Agent tree row, not the pending row).
  - Steps: "New agent preselects the scoped project", "a launch from the Cockpit stays on the Cockpit", "the launched process is running before its terminal is opened", "a second launch in one project is named <project> 2 in the roster".
  - Teardown closes the tabs and removes the project.

### Task 5: The booting flag and card-body mode (interface for F4)
**Depends on:** none
**Files:** `frontend/app/view/agents/agentsviewmodel.ts`, `frontend/app/view/agents/agentsviewmodel.test.ts`, `frontend/app/view/agents/cockpitsurfacemodel.ts`, `frontend/app/view/agents/cockpitsurfacemodel.test.ts`, `frontend/app/view/agents/statusline.tsx`

- `AgentVM` gains `booting?: boolean`. `pendingToVM` sets `booting: true`, and `statusline.tsx` reads a booting agent as "starting".
- `cockpitsurfacemodel.ts` exports `cardBody(agent: AgentVM, hasEntries: boolean): "feed" | "waiting"`. It returns `"waiting"` for a booting agent, or for one that `cardHasContent` says has nothing to show; otherwise `"feed"`. Leave `hiddenAgentIds` in place; Task 6 removes it.
- Tests: `pendingToVM marks booting`, and `cardBody`: booting → waiting, no entries and no ask → waiting, asking → feed, entries → feed.
- No scenario: Task 6 shows "starting" and Task 10 shows the waiting body.

### Task 6: Roster visibility, counts and empty states (F4, F5, F7, F10, F11 counts, F18)
**Depends on:** Task 5, Task 1 (fills the `cockpit-roster-counts` stub it creates)
**Files:** `frontend/app/view/agents/cockpitsurface.tsx`, `frontend/app/view/agents/cockpitsurfacemodel.ts`, `frontend/app/view/agents/cockpitsurfacemodel.test.ts`, `frontend/app/view/agents/cardgridlayout.ts`, `frontend/app/view/agents/cardgridlayout.test.ts`, `frontend/app/view/agents/agentsviewmodel.ts`, `frontend/app/view/agents/agentsviewmodel.test.ts`, `frontend/app/view/agents/cockpitemptystate.tsx`, `frontend/app/view/agents/projectswitcher.tsx`, `scripts/cdp/scenarios-cockpit-roster.mjs`

- `cockpitsurfacemodel.ts`:
  - Delete `hiddenAgentIds`, after grepping every reference. `cardHasContent` stays only if `cardBody` still uses it.
  - Add `cockpitCounts(agents: AgentVM[], projectFilter: string, needsYou: (a: AgentVM) => boolean): { agents: number; projects: number; needsYou: number }`, over the scoped roster.
  - Add `gridNotice(input: { seeded: boolean; rosterCount: number; scopedCount: number; shownCards: number; parked: number; backgrounded: number; projectFilter: string }): { kind: "loading" | "empty-roster" | "empty-scope" | "nothing-live" | "none"; idle?: number; backgrounded?: number; project?: string }`.
  - Add `plural(n: number, word: string): string`.
- `cardgridlayout.ts`:
  - `cardMatchesChip(card, chip, needsYou, standingBy: boolean)`. An agent card matches working when it is working and not booting, or when it is standing by. It matches idle when it is idle and not standing by.
  - Add `chipCounts(cards: GridCard[], needsYou: (c: GridCard) => boolean, standingBy: (c: GridCard) => boolean): Record<ChipFilter, number>`, so every tab counts cards.
- `agentsviewmodel.ts`: `filterAgents(agents, projectFilter, liveOnly, standingBy: Set<string> = new Set())`, where Live only keeps standing-by agents.
- `cockpitsurface.tsx`:
  - No agent is filtered out of the grid or the counts any more.
  - The toolbar fact uses `cockpitCounts` and `plural`; the tab counts use `chipCounts`.
  - The header wrapper becomes `z-20`.
  - The empty-state, skeleton and notice overlay moves into a `relative` wrapper around the grid scroll area only. The Backgrounded/Idle sections and the hints bar sit outside it.
  - `gridNotice` drives what shows: `empty-roster` is the existing `CockpitEmptyState`. `empty-scope` and `nothing-live` are a smaller notice in `cockpitemptystate.tsx`, using tokens only, reading "No agents in <project>" and "Nothing live: N idle, M backgrounded below".
- `projectswitcher.tsx`: the All count reads the same roster count as the toolbar (pass it in, or call `cockpitCounts`).
- Tests:
  - `cockpitCounts`: scoped, unscoped, and an agent with no transcript still counts.
  - `gridNotice`: loading, empty roster, empty scope, all parked, all backgrounded, cards shown.
  - `plural`.
  - `cardMatchesChip`: standing by → working, not idle; booting → not working.
  - `chipCounts` counts cards.
  - `filterAgents keeps standing-by under Live only`.
- Scenario `cockpit-roster-counts` (fixture roster; a pending launch set through the app's `pendingLaunchesAtom`). Steps:
  - "a booting launch's status line reads starting and it counts in agents and live, not working"
  - "the toolbar reads 1 agent · 1 project for one agent"
  - "with every agent parked, the grid shows Nothing live: N idle, M backgrounded below and the Idle list stays clickable"
  - "a scope with no agents shows No agents in <project> and scoped counts"
  - "the header switcher's New project is clickable over the empty state"
  - "a standing-by agent counts under working, not ready for review, and stays under Live only"

### Task 7: Backgrounded, Idle and Events-row targets (F2, F9, F13, F14, F23)
**Depends on:** Task 6, Task 1 (fills the `cockpit-offgrid` stub it creates)
**Files:** `frontend/app/view/agents/cockpitsurface.tsx`, `frontend/app/view/agents/cockpitsurfacemodel.ts`, `frontend/app/view/agents/cockpitsurfacemodel.test.ts`, `frontend/app/view/agents/agentsviewmodel.ts`, `frontend/app/view/agents/backgroundedsection.tsx`, `frontend/app/view/agents/idlesection.tsx`, `scripts/cdp/scenarios-cockpit-offgrid.mjs`

- `cockpitsurfacemodel.ts` adds:
  - `prunedBackgrounded(ids: Set<string>, agents: AgentVM[], lineage: Lineage): Set<string>`. It drops a plain agent's id when the agent is absent or not working, keeps run members' ids, and returns the same Set when nothing changed.
  - `railSelectTarget(id: string, where: { onGrid: Set<string>; backgrounded: Set<string>; parked: Set<string> }): "grid" | "restore" | "terminal" | "agent"`.
  - `orderIds(active: AgentVM[], backgrounded: AgentVM[]): string[]`.
- `cockpitsurface.tsx`:
  - `onBackground` is passed only for `a.state === "working" && !a.booting`.
  - The asking-only un-mute effect is replaced by one that applies `prunedBackgrounded`.
  - The order merges over `orderIds(activeAgents, backgrounded)`, and the "manual drag reorder" comment goes.
  - `onSelectAgent` dispatches on `railSelectTarget`: restore, then cursor and pulse; open the terminal; or `openFocus`.
- Rewrite the comments that say asking agents are never backgrounded, in `cockpitsurface.tsx` and on `partitionBackgrounded` in `agentsviewmodel.ts`: asking agents are passed in, and pruning, not partitioning, resurfaces them.
- `backgroundedsection.tsx` formats its age as `formatAge(displayAgeMs(a, now))`, and `idlesection.tsx` as `formatAge(displayAgeMs(a, now))` followed by "idle". `now` comes from `model.nowAtom` or a prop.
- Tests:
  - `prunedBackgrounded`: `drops an agent that finished`, `drops an agent that is asking`, `keeps a run lead's id`, `returns the same set when unchanged`.
  - `railSelectTarget`: each of the four outcomes.
  - `orderIds keeps a backgrounded id's slot`.
- Scenario `cockpit-offgrid` (fixture roster). Steps:
  - "an asking card offers no Move to background"
  - "a backgrounded agent that finishes leaves Backgrounded and shows on the grid"
  - "a restored card returns to its old slot"
  - "an Idle row reads its real idle age"
  - "an Events row for a backgrounded agent restores and pulses its card"
  - "an Events row for a parked idle agent opens its terminal"

### Task 8: Card body, header, diff chip and small-window layout (F4 card, F8, F12, F22)
**Depends on:** Task 5 (uses `booting` and `cardBody`), Task 1 (fills the `cockpit-card-layout` stub it creates)
**Files:** `frontend/app/view/agents/agentrow.tsx`, `frontend/app/view/agents/agentrowmodel.ts`, `frontend/app/view/agents/agentrowmodel.test.ts`, `frontend/app/view/agents/cardgitstore.ts`, `frontend/app/view/agents/cardgitstore.test.ts`, `scripts/cdp/scenarios-cockpit-card.mjs`

- `agentrow.tsx` waiting body: when `cardBody(agent, <has entries>)` is `"waiting"`, the body is one muted line, "Waiting in its terminal", plus an Open terminal button (the existing `CTL_BOX` style). It has no activity line and no feed.
- `cardgitstore.ts`:
  - Keep each card's resolved cwd in an exported `cardCwdByIdAtom: Record<string, string>`, dropped with the stats in `dropCardGit`.
  - Export `sharedCheckoutCount(id: string, cwdById: Record<string, string>): number`: how many cards, this one included, share its cwd, compared after normalizing slashes, trailing separator and case.
- `agentrowmodel.ts`:
  - `agentRowMenuItems(flags: { hasDiff: boolean; mute: "background" | "dismiss" | null })`. The mute item reads "Move to background" for background and "Move to Idle" for dismiss.
  - Export `muteTitle(mode)` for the button title: background → "Move to background (B)", dismiss → "Move to Idle".
- `agentrow.tsx`:
  - The diff chip shows a muted "repo" prefix when `sharedCheckoutCount > 1`, titled "All changes in this checkout, shared by N agents".
  - Header layout: the name has priority, and the chips collapse to count-only below the card width where they would collide (container query).
  - An asking card's body starts scrolled so its AnswerBar's first option is in view, on ask arrival and on mount while asking.
- Tests:
  - `sharedCheckoutCount`: same checkout, different worktrees, case and slash variants, one card.
  - `agentRowMenuItems` labels per mode, and `muteTitle`.
- Scenario `cockpit-card-layout` (fixture roster; viewport 1000x700 as `docs/reference/cdp-verification.md` describes). Steps:
  - "two cards in one checkout show the repo-wide diff chip"
  - "an idle card's menu and button read Move to Idle"
  - "at 1000x700 the standing-by card's name and chips do not overlap"
  - "at 1000x700 an asking card shows its first option without scrolling"

  The waiting body is shown by Task 10's step "an agent with no transcript shows a Waiting in its terminal card and is counted": until Task 6 lands, today's hiding rule keeps such an agent off the grid.

### Task 9: Events rail and hints (F11 rail, F17, F19, F20, F21)
**Depends on:** Task 1 (fills the `cockpit-rail-help` stub it creates)
**Files:** `frontend/app/view/agents/cockpitevents.ts`, `frontend/app/view/agents/cockpitevents.test.ts`, `frontend/app/view/agents/cockpiteventsrail.tsx`, `frontend/app/view/agents/cockpitrail.tsx`, `frontend/app/view/agents/cockpithelp.tsx`, `frontend/app/cockpit/palette-commands.ts`, `frontend/app/cockpit/palette-commands.test.ts`, `frontend/app/cockpit/shortcuts-cheatsheet.tsx`, `scripts/cdp/scenarios-cockpit-rail.mjs`

- `cockpitevents.ts` adds:
  - `fillAskedText(events: RailEvent[], agents: AgentVM[]): RailEvent[]`. An "asked" event with empty text, whose agent is still asking and now has a first question, takes that question. It returns the same array when nothing changed. Apply it where `cockpiteventsrail.tsx` accumulates agent events.
  - `scopeRailRows(rows, agents: AgentVM[], lineage: Lineage, projectFilter: string)`. It keeps all rows on "all", an agent row whose agent's project matches, and a run row whose lead's project matches.
- `cockpiteventsrail.tsx`: export a `useRailRows(model, lineage, runEvents)` hook that returns the merged, scoped rows and the unread split (the existing `splitUnread` with `seenTsAtom`); the rail list uses it.
- `cockpitrail.tsx`: pass `CollapsibleRail` a `strip` showing the Events glyph and the unread count from `useRailRows`, titled "Events". The badge is the accent badge `RailStrip` uses for needs-you in `agentdetailsrail.tsx`.
- `cockpithelp.tsx`: the hints sit in a one-line-high, wrapping, overflow-hidden row, so whole hints drop from the end. The `?` chip and readouts sit outside it as `shrink-0`. Remove "esc back", and add "space peek" after "n next ask".
- `palette-commands.ts`: export `SURFACE_GROUP`, and add `cheatsheetGroupOrder(groups: string[], surface: SurfaceKey): string[]`: the surface's own group first, then alphabetical. `shortcuts-cheatsheet.tsx` sorts with it.
- Tests:
  - `fillAskedText`: fills an empty asked event, leaves a filled one, leaves one whose agent stopped asking, returns the same array when unchanged.
  - `scopeRailRows`: all, an agent row in and out of scope, a run row by its lead's project.
  - `cheatsheetGroupOrder`: cockpit → Cockpit first, files → Diff first, a surface with no group → alphabetical.
- Scenario `cockpit-rail-help` (fixture roster). Steps:
  - "the collapsed Events rail shows the unread count"
  - "an asked event whose question arrived late shows the question"
  - "a project scope narrows the Events rail"
  - "the ? chip opens the cheat sheet on the Cockpit group"
  - "at 1600 wide with the rail open the hints bar is one line and the ? chip is visible"
  - "at 1000 wide the ? chip is visible"
  - "the hints show space peek and no esc back"

### Task 10: Sweep existing cockpit scenarios and the cross-task steps
**Depends on:** Task 6, Task 2 (re-checks the composer it changed), Task 3 (re-checks the ask keys it changed), Task 4 (its launch step needs the launch change), Task 7 (re-checks the off-grid sections it changed), Task 8 (re-checks the card labels it changed), Task 9 (re-checks the hints and rail it changed)
**Files:** `scripts/cdp/scenarios-cockpit.mjs`, `scripts/cdp/scenarios-cockpit-roster.mjs`

- Go through the merged diff since this plan's base (`git diff <base>..HEAD -- frontend`). For every user-visible string, label, count format, z-order or hidden/visible rule it changed, grep `scripts/cdp/scenarios-cockpit.mjs` for assertions that read it, and update them to the new behavior. At least check `cockpit-empty-state`, `context-menu`, `surface-headers`, `shell-tasks`, `cockpit-keys-on-arrival` and `cockpit-polish`. Do not weaken an assertion to pass: change it to assert the new intended behavior.
- Add to `scripts/cdp/scenarios-cockpit-roster.mjs` the steps that need Tasks 4, 6 and 8 together:
  - "an agent with no transcript shows a Waiting in its terminal card and is counted", on a fixture agent with no transcript and no pending launch.
  - "a launch from the Cockpit shows a Waiting in its terminal card": launch a harmless long-running command from New agent as `cockpit-launch-stays` does, assert the card is on the Cockpit, then tear it down.
- Acceptance: `node --check` on both files. Every scenario this task edits is in the plan's Final line.
