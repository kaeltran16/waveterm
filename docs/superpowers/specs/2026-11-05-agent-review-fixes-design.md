# Agent surface review fixes (F1-F20): design

Source: the Agent surface review of 2026-11-05 (`cdp-shots/review/agent/report.md` in the main checkout,
gitignored). Its "Tooling and procedure" and "Related to known items" sections are out of scope. Each cause below
was checked against the code at `aafa0f87e`; where the code supports a different fix than the report suggests, the
decision says so and why.

## Verified causes that differ from, or add to, the report

- **F1.** Confirmed, and wider than the report says: the transcript stream registry (`livetranscript.ts`) is a
  per-id singleton. `startTranscriptStream` is a no-op for an id already streamed and `stopTranscriptStream` kills it
  whoever asked, so a second `useCardStreams` driver beside the Cockpit's would have its streams torn down by the
  Cockpit's unmount cleanup. The pure rule for what streams, `streamableTranscriptAgents` (`agentsviewmodel.ts:864`),
  is already written but only its test calls it; the Cockpit computes its own set inline. Shell tasks and subagents
  ride `lastActivityByIdAtom`, which only a stream writes.
- **F2.** Confirmed. The tree also sorts by the Cockpit's `orderAtom` (`agenttree.tsx:1223`), which is why it
  re-sorted A1 when the Cockpit parked it.
- **F7.** The first press falls through: the binding's `run` returns false (`bindings.ts:403`), and the dispatcher
  only `preventDefault`s a handled key (`dispatcher.ts:178-181`), so ^C reaches the PTY in code. That it reaches the
  PTY in the running app stays unconfirmed (a CDP ^C never stopped `ping`).
- **F8.** Deeper than "count subagents": a background spawn's `tool_result` is the launch ack ("Async agent launched
  successfully", `toolUseResult.status: "async_launched"`, `isAsync: true`), so `extractSubagentSpawns` marks it done
  at once and `resolveState` reads it `success` while it still runs. Its real finish is a `<task-notification>` whose
  `<tool-use-id>` names the spawn and whose `<status>` says how it ended (seen in the review's own A2 transcript).
- **F18.** Confirmed: `hungSilenceMs` (`agenthung.ts`) is read only by the Cockpit's `ActivityLine`. Its input,
  `getLastOutputAtom(blockId)`, is fed by a global controller-status subscription, so it is available on any surface.
- **F19.** Cockpit F8's fix is `sharedCheckoutCount` over `cardCwdByIdAtom` (`cardgitstore.ts`), filled by the
  Cockpit's git tracking (`useCardStreams` with `trackGit`). On the Agent surface that map is empty unless the
  Cockpit is open, so reusing the fix needs F1's always-on owner.
- **F20.** The tool is named `SubagentHandback` in transcripts.

## Decisions

### Streams and tracking have one owner, in the shell (F1, F19's data)

- `streamableTranscriptAgents(agents, now, { shellTasks, subagents, focusId })` becomes the one rule: an agent with a
  transcript streams while it is asking or working, idle within the grace window, standing by (F8's rule), or focused
  (any state, not a terminal). The focused agent is added so the rail's Tools used, F9's interrupted check and F5's
  idle reload have entries for an idle agent.
- An `AgentStreams` component in `CockpitShell` (renders nothing) drives `useCardStreams(..., { trackGit: true })`
  over that set on the coarse `structuralNowAtom`, and runs `useSubagentTracking` over the roster. The Cockpit drops
  its own `useCardStreams` and `useSubagentTracking` calls. The Agent tree's call goes too, in a later change than
  the shell's (tracking from two places at once is safe: its refreshes are seq-guarded). Why:
  a stream is per-id state with exactly one lifecycle owner; the shell is the always-mounted home AGENTS.md gives
  cross-surface concerns. Rejected: refcounting the registry (two wanted-set computations to keep in step), and the
  Agent surface as owner (it renders the hero instead of the tree with no agents, and hides the tree in fullscreen).
- Cost: the same streams and debounced git loads the Cockpit paid while open, plus the focused agent, now also
  while the Cockpit is closed. A Cockpit dismissal no longer ends a stream early; the grace window still does.
- `useSubagentTracking` keys its enter refresh on id and transcript path, so a launch whose path arrives after it
  entered is read then.

### Focus order comes from the tree (F2, F11, F12)

- `buildAgentTree` drops its `order` argument: rows follow roster order (the session sidebar's visual order, which
  does not move when an agent parks), pinned first, as before. The Cockpit's `orderAtom` stays the grid's alone.
- `agenttreemodel.ts` exports `rowFocusKey(row)` (the id a click on the row focuses: an agent row's id, a done
  task's `endedWorkerId`, the final row's `finalRowFocusId`, none for group, run, done and queued folds) and
  `treeFocusOrder(rows, terminals)` (the focus keys in row order, then the terminals). `WorkerRow` and `FinalRow`
  use `rowFocusKey` instead of their own copies.
- The model gains derived `treeRowsAtom` and `focusOrderAtom`. The tree renders `treeRowsAtom`; `j`/`k`, `←`/`→`,
  new `↑`/`↓`, `Ctrl+Tab`, `Ctrl+Shift+Tab` and the surface's default focus read `focusOrderAtom`, so booting agents,
  parked agents, workers and terminals are all reachable, in the order the tree shows them.
- F11: `cycleFocus(delta)` cycles the focus order with wrap; `Ctrl+Shift+Tab` goes backward and keeps its "Previous
  agent" label. The asking-only cycle is dropped: nothing else documents it, and the tree's asking badge marks them.
- F12: `↑`/`↓` move like `j`/`k` (same guard: not in the brainstorm check's review), so the footer's "↑↓ move" is
  true. The docs' "j / k … Previous / next" order is fixed.

### Keys and terminal chrome (F7, F14's `d`)

- F7: the double Ctrl+C close targets agents only; on a plain terminal both presses reach the shell. A terminal
  still closes from its row menu or the header ×.
- F14: `agent:toggle-rail` is inactive while the focused row is a terminal (the rail never renders for one), so the
  footer's `d` chip hides with it. Its `when` reads the focus and the terminal roster; `whenstate.ts` already
  re-evaluates on focus changes, and the PREDICATE_ATOMS completeness test decides whether more must be watched.

### Background subagents (F8) and the handback tool (F20)

- `extractSubagentSpawns` marks a spawn `background` when its `tool_result` record's `toolUseResult` is async
  (`isAsync` or `status: "async_launched"`); a background spawn is done only when a `<task-notification>` whose
  `<tool-use-id>` names it arrives, failed when that status is not `completed`. `SubagentVM` gains `background`.
- `isStandingBy(state, shellTasks, subagents)`: idle with a shell task running or a background subagent still
  working. The argument is required, so every caller (header, rail, tree, card, events rail, Cockpit partition, the
  close action) states both; one early task makes that mechanical change so later tasks build on it.
- F20: the Claude projector drops `SubagentHandback` tool calls and their results, so the subagent interior, the
  rail's Tools used and the Cockpit card all lose it at once.

### Duplicate (F3) and pending launches (F6)

- F3: `buildDuplicateBlockMeta` sets `cmd:args` to the source's `agent:baseargs` when present: a duplicate is a
  fresh session with the same launch flags. A source without baseargs (older blocks, shells) keeps `cmd:args`.
  "Duplicate with task" is not added (YAGNI).
- F6: `mergePendingLaunches` takes the tabs' `session:label` and `session:pinned` and overlays them on the booting
  row, so Rename and Pin show before the agent reports.

### Header and the shared state text (F10, F13, F14, F18)

- A pure `agentStateView` (new `agentstateview.ts`) returns the state text and tone for an agent: landed / done,
  failed to start, quiet (F18), standing by, else the plain state; null for a plain terminal (F14: no pill). The
  header's pill and the rail's Session line both render it (F10).
- F18: a working agent whose `hungSilenceMs` is non-null reads "quiet Nm" in the warning tone in the header pill; the
  rail footer says "quiet · no output Nm · Esc also stops" beside Stop. The clock is `structuralNowAtom`: the
  threshold is 3 minutes and the text is in minutes.
- F13: the fullscreen titles name F11 ("Fullscreen terminal (f, or F11 in the terminal)", "Exit fullscreen (F11, or
  f / Esc outside the terminal)"). The close title follows the kind: "Close agent (Ctrl+C twice in its terminal)",
  "Close terminal".
- F14: the header menu offers "Interrupt turn" only while the agent is working.

### Rail (F4, F5, F9, F17, F19)

- F4: an asking agent's rail footer has no Stop; its hint reads "waiting on you · answer in the terminal". AnswerBar
  in the rail was rejected: the terminal beside it already shows Claude's own picker for the same question, and two
  answer paths for one ask can race.
- F9: Resume is offered only when the agent's last turn was interrupted (the last projected entry is
  `interrupted`); an idle agent that finished its turn gets no footer action. Labelling it "Send continue" was
  rejected: a button that spends a turn to be told "nothing is left" is noise whatever its label. The palette's
  "Nudge (continue)" action follows the same rule, reading the agent's streamed entries.
- F5: the rail reloads git silently (keeps the shown list while it reads) when the block's `agent:lasteditts`
  advances or the agent starts a new idle episode. A pure `railReloadKey` decides. Polling was rejected: the edit
  stamp is already pushed with the block.
- F17: the headline is new tokens (input, output, reasoning, cache writes) beside the spend; the total appears once,
  on the Tokens bar row; the section label's duplicate total goes.
- F19: Files touched reuses Cockpit F8: when `sharedCheckoutCount(agent.id, cardCwdByIdAtom) > 1` its summary reads
  "repo · …" with the title "All changes in this checkout, shared by N agents". Snapshotting the tree at session
  start and intersecting with transcript edits were rejected, as for Cockpit F8 (Bash and codegen edits would go
  uncounted). Limits shared with the Cockpit: an agent outside the streamed set is not counted, and a closed agent's
  leftover edits still count.

### Tree and launch (F15, F16)

- F15: with no agents the tree's AGENTS group shows "No agents", a New agent button and up to three recent sessions
  to resume (the tree is 248px wide), above the Terminals group. The hero and the tree build the launch with the
  existing `resumeLaunchOpts` (`sessionsruns.ts`), as the palette's session rows do, and launch through
  `launchAgentOrToast`.
- F16: a terminal launched while the Agent surface shows is focused there; from anywhere else it stays in the
  background, and the New agent button reads "Add terminal" for it.

## Verification

Final runs six new scenarios (`agent-streams`, `agent-subagents`, `agent-keys`, `agent-header`, `agent-rail`,
`agent-tree`), each in its own `scripts/cdp/scenarios-agent-*.mjs` module, plus `agent-start-failed`,
`agent-launch-hero` and the Cockpit scenarios that read what F1 and F2 move (`cockpit-offgrid`,
`cockpit-roster-counts`, `cockpit-card-layout`, `cockpit-rail-help`, `cockpit-launch-stays`). The new scenarios use
an in-page fixture roster (`devMockAgentsAtom`, restored at teardown), transcripts written under a temp dir (never
`~/.claude/projects`), and real tabs only where the code under test needs a block (terminals, duplicates, pending
launches); no tab they create runs an agent. F7's first press reaching the PTY cannot be shown over CDP; the step
checks that the second press opens no confirm on a terminal and still does on an agent.
