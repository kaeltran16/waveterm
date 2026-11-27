# Cockpit rethink: thumbnails that zoom

**Effort:** effort:1bb41458-84ec-4623-841d-4456ecb2e0ce
**Spec:** `docs/superpowers/specs/2026-11-27-cockpit-rethink-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/jarvis`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs cockpit-thumbs attention-popup surface-smoke`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\cockpit-rethink\project

The canvas's boards are Grid, Escalated, Zoom-final, Zoom-asks, Zoom-watching and the interactive Prototype (its
PROTOTYPE ONLY simulate bar is not UI). Wording on run lines, waiting rows and popups is the prototype's
(`runLine`, `waitNote`, `settle` in Prototype.dc.html).

Decisions beyond the design, with why:

- **Sources, no backend change.** Sessions come from `model.agentsAtom`. Runs come from a new shell store that holds
  every channel's runs, loaded per channel through `GetChannelRunChangesCommand` with `knownRunVersions` /
  `mergeRunChanges` (`channelruns.ts`), so a refresh after the cold load costs only changed rows. It refreshes on the
  AttentionPoller's 10 s tick and keeps runs keyed by channel: a refresh replaces only the channels it fetched (a
  failed or unlisted channel keeps what it had), which is also what lets a scenario seed a page-only channel. Engine
  children (`isEngineChild`) are dropped. Stages read the dag digest (`runDigestsAtom`). Why: the palette's
  `loadAllRuns` refetches whole histories and only runs when the palette opens.
- **Conductor link:** a session is a conductor when `samePath(agent.transcriptPath, run.origintranscript)` holds for
  some loaded run (`projectoverviewmodel.ts`'s `samePath`).
- **Who is a session:** a roster agent of kind agent (not `terminal`, not `background`) with no `runId`, no lineage
  role and no `parentTabId`. An agent-started worker reports to the agent that started it, as run agents report to
  their conductor, so it gets no thumbnail.
- **Session state:** `asking` → Asks you; idle and `isStandingBy` (a monitor, background shell or background
  subagent) → Watching; other idle → Your turn; working or booting → Working.
- **Escalation is per wait,** a wait being an `attentionAtom` item with a `runid` (not `workflow-scan`). It is the
  user's when: the run has no live conductor; the conductor is on Your turn or Asks you (the prototype's `ownerOf`:
  a conductor at its own question cannot see the wait either); or the conductor has been Watching for 5 minutes in
  total since the wait opened. Watching time accumulates, pauses while Working and never resets. Once the user's, a
  wait stays the user's until it leaves the attention list. A wait whose run the store has not loaded is pending
  (neither amber nor popped) while the store fetches that run's channel at once (the item names it), so a boot or a
  run created a moment ago is never popped as conductorless; a run still unknown after that fetch has no conductor.
  `why` is `turn`, `timer`, `exit` (its conductor was live and is gone) or `none` (never had one). The spec's
  escalation list now says Asks you counts as Your turn (spec edited in this round, per the prototype's `ownerOf`).
- **Popup and taskbar:** the poller's outward list is every non-run item plus the run waits that are the user's. A
  run wait therefore enters the list once, when it becomes the user's, and the existing `newAttention` diff pops and
  flashes once. Its bubble's `detail` line carries the prototype's reason sentence. Hub, the nav badges and
  `attentionAtom` are unchanged.
- **Dismissal and quiet:** in memory only, a `dismissedAt` time per agent id. A session is in the Idle line while it
  has not finished a turn since then (`idleSince` ≤ `dismissedAt`, or not idle). A session that is idle or never
  prompted when the store first sees it gets `dismissedAt` = that moment. Zooming a session from the Idle line clears
  its dismissal. Any state can be dismissed, as in the prototype.
- **Runs a thumbnail lists:** live runs plus runs that landed, failed or were cancelled since local midnight, newest
  first. Runs with no live conductor (never had one, or its conductor exited or was cleared) use the same window in
  the strip.
- **Layout:** 3 columns (2 when the grid is under 1100 px wide), and two rows fill the viewport; a third row onward
  scrolls at the two-row height. Order is today's anchored order (`mergeOrder` over `model.orderAtom`).
- **Thumbnail transcript:** `NarrationTimeline` over the last turn's entries (`lastTurnEntries`: from the last user
  prompt on, at most the newest 8 rows; the filmstrip's last line reads the same cut), bottom-anchored under a top fade, at a smaller type scale, in a still mode with no spinner (a
  static ring) and no infinite animation.
- **Arrow path:** Left/Right step ±1, Up/Down ±columns; Down from the bottom row goes to the Idle line's names, then
  to the strip's lines; Up retraces. Space zooms a thumbnail, zooms (and un-dismisses) an Idle name, and opens a strip
  line's run on its own surface (`openTarget` run). d dismisses a thumbnail; Enter opens the selected session on the
  Agent surface.
- **Zoomed view** mounts the session's own `RenderedView` (transcript, composer, docked answer bar) and its
  `WorkspacePane`, plus a filmstrip of the grid's sessions. While zoomed, `[` / `]` step the pane's tabs (taking the
  keys from surface cycling), d collapses the pane, Esc returns to the grid on the same thumbnail, and Enter outside
  an editable opens the Agent surface. Filmstrip hops are by click.
- **Zoom's tabs:** on zoom, `pushWorkspaceTab` adds a Run tab per listed run and an Initiative tab per initiative
  (`run.effortref`), the Initiative tab's `open` set to the run's chunk, which is how its chunk is marked (no new tab
  field). The default run (the one that waits, else the newest live, else the newest) is activated unless the active
  tab is already one of those Run tabs. Keyboard focus stays where it is.
- **Run tab dot and waiting row** follow the run's `RunWait` wherever the pane renders, the Agent surface included,
  since the rule lives in the shell. A run with no `RunWait` keeps today's color.
- **Run 2089c1d0** (workspace pane for finished workers and the Final stage) is in its final stage and edits
  `workspacepane.tsx`, `workspacemodel.ts`, `workspacestore.ts`, `renderedview.tsx` and `scripts/cdp/scenarios.mjs`.
  This plan edits only `workspacepane.tsx` of those pane files (the tab dot), and `scenarios.mjs` only to register or
  drop scenario names, so the land merges cleanly.
- **Scenario `cockpit-thumbs`** has one page-only fixture in `scripts/cdp/scenarios-cockpit-thumbs.mjs`: a dev
  roster (`setRoster`) holding the prototype's sessions in all four states, runs and digests seeded into the page's
  object cache and the runs store under a fixture channel with `origintranscript` set to the sessions' transcript
  paths, waits through the DEV `wave:dev-attention-items` key, a Watching conductor through `shellTasksByIdAtom`, and
  the 5-minute timer advanced by setting the escalation state atom (no 5-minute wait). Task 2 creates it, Task 4
  extends it, Task 5 only rewrites the old scenarios after both; no other task edits it.
- **No types-only first task.** Tasks 2 and 3 render sessions, run lines and waits that only Task 1's behavior
  produces, so with types alone they would merge without seeing their own UI; Task 1 stays whole.

### Task 1: Conductor-first escalation in the shell
**Depends on:** none
**Chunk:** Conductor-first escalation in the shell (session states, run waits, attention popup)
**Files:** `frontend/app/view/agents/cockpitsessionmodel.ts`, `frontend/app/view/agents/cockpitsessionmodel.test.ts`, `frontend/app/view/agents/cockpitsessionstore.ts`, `frontend/app/view/agents/cockpitsessionstore.test.ts`, `frontend/app/view/agents/attentionpoller.tsx`, `frontend/app/view/agents/attentionpopup.ts`, `frontend/app/view/agents/attentionpopup.test.ts`, `frontend/tauri/popup.tsx`

The always-mounted shell decides, for every session, its state, its runs and whether each run's wait is the
conductor's or the user's, and the desktop popup and taskbar flash fire only when a run's wait becomes the user's.
The pure decisions go in `cockpitsessionmodel.ts`; the runs store, the escalation state, dismissals and the zoom atom
go in `cockpitsessionstore.ts`, driven from `AttentionPoller`.

Interfaces (Tasks 2-5 rely on these names):

```ts
export type SessionState = "asks" | "turn" | "watching" | "working";
export type WaitOwner = "you" | "conductor";
export type WaitWhy = "turn" | "timer" | "exit" | "none";
export interface RunWait { runId: string; key: string; short: string; label: string; owner: WaitOwner;
    why: WaitWhy | null; minutesLeft: number | null; conductorName: string | null }
export interface CockpitSession { agent: AgentVM; state: SessionState; conductor: boolean; runs: Run[] }
export interface CockpitView { sessions: CockpitSession[]; idle: CockpitSession[]; orphans: Run[]; turnCount: number; loaded: boolean }
// model
export function runStage(run: Run, digest: DagStatusDigest | undefined, now: number): string;
export function runLineFace(run: Run, stage: string, wait: RunWait | null): { text: string; tone: "yours" | "conductor" | "live" | "failed" | "done" };
export function waitNote(wait: RunWait): string;
export function lastTurnEntries(entries: AgentEntry[], max: number): AgentEntry[]; // from the last user prompt on
export function lastLine(entries: AgentEntry[]): string; // the filmstrip's line
// store
export function cockpitViewAtomFor(model: AgentsViewModel): Atom<CockpitView>;
export function runWaitAtom(runId: string): Atom<RunWait | null>; // the run's most urgent open wait
export const cockpitZoomAtom: PrimitiveAtom<string | null>; // zoomed session's agent id
export function dismissSession(agentId: string): void;
export function undismissSession(agentId: string): void;
export function outwardAttentionAtomFor(model: AgentsViewModel): Atom<AttentionItem[]>; // what the poller pops and flashes from
```

`short` is "Asks" (ask, escalation), "Plan to approve", "Final failed" or "Blocked" (dag-blocked, from its text),
"Landing held", "Unverified". `turnCount` counts sessions on Asks you or Your turn in the grid.

Acceptance:
- Session state maps as the header says, for each of asking, idle with a monitor, idle with a background subagent,
  plain idle, working and booting.
- Sessions exclude terminals, background agents, agents with a `runId`, lineage role or `parentTabId`; a session whose
  transcript is a loaded run's `origintranscript` is a conductor and lists that run.
- A conductor lists live runs and runs ended since local midnight, newest first; an older ended run is in neither
  the thumbnail nor the strip; a run whose conductor is absent is in `orphans`.
- Escalation, each a case: conductor Working → conductor's, however long; Watching 4 min → conductor's with
  `minutesLeft` 1; Watching 5 min in total across a Working gap → yours (`timer`); conductor on Your turn or Asks you
  when the wait opens, or ending a turn into Your turn with it open → yours (`turn`); conductor gone → yours
  (`exit`); never had one → yours (`none`); before the runs store loads → pending; once yours, a conductor going back
  to Working leaves it yours.
- The outward attention list holds a run wait only once it is the user's, so a wait the conductor holds never pops
  or flashes, and one that escalates pops once with the reason as its detail line; the `attention-popup` scenario
  still passes.
- A session idle at first sight, or never prompted, is in `idle`; a dismissed session returns when its `idleSince`
  passes the dismissal; `undismissSession` returns it at once.
- A runs refresh where one channel fails keeps that channel's runs, and a seeded channel that is not in the channel
  list survives a refresh.
- A wait on a run the store has not seen fetches its channel at once and decides after it: a run created by a
  conductor a moment ago stays the conductor's, and the `attention-popup` scenario's run still pops inside its 15 s
  wait.
- `lastTurnEntries` starts at the last user prompt and keeps at most `max` rows; with no prompt it keeps the newest.

### Task 2: Thumbnail grid replaces the cards
**Depends on:** Task 1 (cockpitViewAtomFor, runWaitAtom, runLineFace, dismissSession, cockpitZoomAtom)
**Chunk:** Thumbnail grid replaces the cards (run lines, Idle line, no-conductor strip)
**Files:** `frontend/app/view/agents/cockpitsurface.tsx`, `frontend/app/view/agents/cockpitgridmodel.ts`, `frontend/app/view/agents/cockpitgridmodel.test.ts`, `frontend/app/view/agents/cockpitthumbnail.tsx`, `frontend/app/view/agents/usecockpitkeyboard.ts`, `frontend/app/view/agents/usecockpitkeyboard.test.ts`, `frontend/app/view/agents/narrationtimeline.tsx`, `scripts/cdp/scenarios-cockpit-thumbs.mjs`, `scripts/cdp/scenarios.mjs`

The Cockpit becomes the Grid board: a header (title, "N sessions · all projects", the "N on your turn" count, the
"Space zooms · Esc returns" hint), the thumbnails, the Idle line and the "Runs with no conductor" strip. A thumbnail
is the header (name, project, state chip, age), the last turn's transcript and its run lines, or "No runs today".
Thumbnails are read-only: no composer, answer bar or row actions.
Keyboard triage per the header's arrow path. Space sets `cockpitZoomAtom`; until Task 4 the surface does not render
the zoom. The surface stops rendering the status tabs, Backgrounded and Idle sections, Live only, the project
switcher, the Events rail, the agent and run cards, the hints bar and the background-subagents strip, and ignores
the app bar's project scope; deleting their modules is Task 5's. The pure layout, cursor path and last-turn cut go in
`cockpitgridmodel.ts`. It keeps `useRunDigests` for every run it lists, since digests load only for runs in view.
Motion: selection ring slides (9); new transcript line fades in with its burst guard (5);
chip cross-fade and count roll (12); a run wait becoming yours cross-fades then flashes once (14); run line arrives
(1), landed run settles (4); dismiss leaves and reflows (2), Idle count rolls (12); a session re-entering appears at
the end (1). No glow, infinite animation or spinner in the grid.

Acceptance:
- `cockpitgridmodel` covers: columns for a width, the arrow path through grid, Idle names and strip (each edge), and
  the anchored order (a session turning to you keeps its
  slot; a new one appends).
- Scenario `cockpit-thumbs` step "grid" shows the Grid board: thumbnails in all four states with their chips, a run
  line muted "· conductor has it" under a Working conductor, one amber "· waits on you" under a Your turn conductor,
  "No runs today" on a session with none, the Idle line with its count, and the strip; a thumbnail draws no spinner.
- Step "escalated" shows the Escalated board: a Watching conductor's muted wait turns amber "· waits on you" once the
  timer is advanced past 5 minutes, and the "on your turn" count is unchanged by it. The popup half: reading
  `outwardAttentionAtomFor` before and after the advance, `popupBubble(before, after, false)` gives exactly one
  bubble, for that wait, whose `detail` is the timer reason ("<name> is Watching but didn't pick it up within 5
  min."); before the advance the wait is not in the outward list.
- Step "keys" (the Prototype board's grid keys): arrows move the ring along the path, d moves the selected thumbnail
  to the Idle line and its count rises, Space on a strip line opens that run, Enter lands on the Agent surface with
  that session focused, Space sets the zoom atom.

### Task 3: Zoomed view, its keys and the escalation in the pane
**Depends on:** Task 1 (runWaitAtom, waitNote, cockpitZoomAtom, cockpitViewAtomFor)
**Files:** `frontend/app/view/agents/cockpitzoom.tsx`, `frontend/app/view/agents/cockpitzoommodel.ts`, `frontend/app/view/agents/cockpitzoommodel.test.ts`, `frontend/app/view/agents/workspacepane.tsx`, `frontend/app/view/agents/workspaceruntasks.tsx`, `frontend/app/store/keybindings/bindings.ts`, `frontend/app/store/keybindings/bindings.test.ts`, `frontend/app/cockpit/footer-visible.test.ts`, `frontend/app/cockpit/footerhints.test.ts`, `docs/keyboard-shortcuts.md`

`CockpitZoom({ model, agentId, onBack })` (`data-cockpit-zoom`) draws the zoomed view: a header (All sessions with
Esc, name, project, state chip, age, "Enter opens it on the Agent surface"), the session's `RenderedView` in the
middle, its `WorkspacePane` on the right (none when it has no tabs) and the filmstrip of the grid's sessions at the
bottom (name, chip, `lastLine`; the current one ringed; a click hops). Zooming adds the tabs per the header's "Zoom's
tabs" decision, a pure `zoomTabs(session, runs, waits, ws)` in `cockpitzoommodel.ts`. The Run tab's dot and its
waiting row follow `runWaitAtom`: the waiting color once yours, the muted ink color while the conductor has it, the
row's note from `waitNote` (with minutes left while Watching). `bindings.ts` gets the zoomed keys (Esc, `[` `]`, d,
Enter) gated on `cockpitZoomAtom`, keeps `[` `]` from cycling surfaces while zoomed, and its Cockpit cheat-sheet
entries become the new key set (arrows, Space, d, Enter, Esc; t, b, n, r, h and 1-9 go). Motion: filmstrip hop swaps
the view (ViewSwap) and slides the ring (9); a handled waiting row folds (6b) with stage, state and dot cross-fading;
a failed action nudges (13); an answered ask collapses the bar (6); a wait turning yours while zoomed recolors row,
card and dot and flashes the card once (14); minutes left roll (12). Nothing mounts it in the Cockpit until Task 4.

Acceptance:
- `zoomTabs`: a Run tab per listed run, an Initiative tab per distinct initiative with `open` at the run's chunk; the
  default active tab is the waiting run, else the newest live, else the newest; an already-active one of these Run
  tabs stays; a session with no runs and no tabs adds none.
- Key bindings: while zoomed, `]` activates the next pane tab and does not change surface, d toggles the pane's
  collapse, Esc clears `cockpitZoomAtom`; not zoomed, `[` `]` still cycle surfaces.
- A Run tab whose run's wait the conductor holds draws a muted dot and the note "<name> has it: it is Watching. This
  comes to you in N min if it doesn't act." (or the Working sentence); once yours, the waiting dot and "Waits on you:
  …".
- The scenario steps that show this view are Task 4's "zoom-final", "zoom-asks" and "zoom-watching".

### Task 4: Zoom wired into the grid
**Depends on:** Task 2, Task 3 (mounts CockpitZoom from cockpitzoom.tsx)
**Chunk:** Zoomed view (transcript, composer, answer bar, Run and Initiative, filmstrip)
**Files:** `frontend/app/view/agents/cockpitsurface.tsx`, `frontend/app/view/agents/cockpitthumbnail.tsx`, `frontend/app/view/agents/cockpitzoom.tsx`, `frontend/app/view/agents/usecockpitkeyboard.ts`, `scripts/cdp/scenarios-cockpit-thumbs.mjs`

The Cockpit renders `CockpitZoom` while `cockpitZoomAtom` names a session and the grid otherwise. Space zooms the
selected thumbnail with its frame morphing into the view (17) while content cross-fades; Esc plays it back and lands
on the same thumbnail, still selected. Measure the morph with the Rendered transcript mounting under it (frame times
over CDP) and fall back to moment 1 scaled from the thumbnail's position if it drops frames; record which and the
numbers in the task report. A zoomed session that leaves the roster returns to the grid. The Agent surface may have
the same agent's Rendered view mounted off-screen: confirm auto-open and the composer draft are not applied twice.

Acceptance:
- Step "zoom-final" shows the Zoom-final board: a Your turn conductor zoomed, its pane on the run whose Final failed,
  the waiting row amber with "Waits on you".
- Step "zoom-asks" shows the Zoom-asks board: an Asks you session with its answer bar above the composer and the pane
  on its landed run; answering collapses the bar.
- Step "zoom-watching" shows the Zoom-watching board: a Watching conductor's run tab with a muted dot and the note
  with minutes left; `]` moves the pane tab, d collapses it to its strip.
- Step "zoom-keys" (the Prototype board's zoom keys): Space zooms, a filmstrip click hops sessions, Esc returns with
  the same thumbnail selected, Enter (composer unfocused) lands on the Agent surface.

### Task 5: Retire the old Cockpit
**Depends on:** Task 2, Task 4 (its greps must see the helpers cockpitzoom.tsx and the wired thumbnails import before deleting any)
**Chunk:** Keyboard triage and removal of tabs, sections, rail, switcher
**Files:** `frontend/app/view/agents/leadcard.tsx`, `frontend/app/view/agents/agentrow.tsx`, `frontend/app/view/agents/backgroundagentsstrip.tsx`, `frontend/app/view/agents/backgroundedsection.tsx`, `frontend/app/view/agents/idlesection.tsx`, `frontend/app/view/agents/cockpitrail.tsx`, `frontend/app/view/agents/cockpiteventsrail.tsx`, `frontend/app/view/agents/cockpithelp.tsx`, `frontend/app/view/agents/attentioncard.tsx`, `frontend/app/view/agents/cardgridlayout.ts`, `frontend/app/view/agents/cardgridlayout.test.ts`, `frontend/app/view/agents/leadcardmodel.ts`, `frontend/app/view/agents/leadcardmodel.test.ts`, `frontend/app/view/agents/leadcardactions.ts`, `frontend/app/view/agents/leadcardactions.test.ts`, `frontend/app/view/agents/agentrowmodel.ts`, `frontend/app/view/agents/agentrowmodel.test.ts`, `frontend/app/view/agents/cockpitevents.ts`, `frontend/app/view/agents/cockpitevents.test.ts`, `frontend/app/view/agents/cockpitsurfacemodel.ts`, `frontend/app/view/agents/cockpitsurfacemodel.test.ts`, `frontend/app/view/agents/agentactions.ts`, `frontend/app/view/agents/agents.tsx`, `frontend/app/cockpit/actions/agent.ts`, `frontend/app/cockpit/actions/run.ts`, `scripts/cdp/scenarios.mjs`, `scripts/cdp/scenarios-cockpit.mjs`, `scripts/cdp/scenarios-cockpit-asks.mjs`, `scripts/cdp/scenarios-cockpit-card.mjs`, `scripts/cdp/scenarios-cockpit-composer.mjs`, `scripts/cdp/scenarios-cockpit-launch.mjs`, `scripts/cdp/scenarios-cockpit-offgrid.mjs`, `scripts/cdp/scenarios-cockpit-rail.mjs`, `scripts/cdp/scenarios-cockpit-roster.mjs`, `scripts/cdp/scenarios-motion-agent.mjs`, `scripts/cdp/scenarios-runs.mjs`, `scripts/cdp/scenarios-shared.mjs`, `scripts/cdp/scenarios-shell-tasks.mjs`, `scripts/cdp/scenarios-usage.mjs`, `frontend/app/cockpit/actions/agent.test.ts`, `frontend/app/view/agents/agentsviewmodel.ts`, `frontend/app/view/agents/agentsviewmodel.test.ts`, `frontend/app/view/agents/cockpitemptystate.tsx`, `frontend/app/cockpit/cockpit-root.tsx`, `frontend/app/view/agents/projectnow.tsx`

Runs after Tasks 3 and 4, so its greps see the zoom's and the thumbnails' imports. Delete what only the old Cockpit
used: the card, row, section, rail, strip and hints components (`cockpiteventsrail.tsx` keeps `useRailTracking` and
the atoms `cockpit-root.tsx` and `projectnow.tsx` read, so only its rail component goes); the exports of
shared modules (`cardgridlayout`, `leadcardmodel`, `leadcardactions`, `agentrowmodel`, `cockpitevents`,
`cockpitsurfacemodel`) with no importer left, and a module with none; the model atoms only the old grid read
(`chipFilterAtom`, `liveOnlyAtom`, `backgroundedIdsAtom`, `dismissedAtom`, `openComposerIdAtom` and their kin); and the
background action (b key, `agent:background` palette command, `partitionBackgrounded`, the empty state's backgrounded
notice) with its Backgrounded concept, and their tests. Grep each symbol across `frontend` and
`scripts` before deleting; one surviving importer keeps it. Delete or rewrite every CDP scenario that drives removed
UI (status tabs, cards, inline answer and reply, Events rail, off-grid sections, Live only, the switcher, hints), and
drop deleted names from `scenarios.mjs`; that includes `scenarios-shell-tasks.mjs`'s step reading cockpit cards and
the Idle heading and `scenarios-usage.mjs`'s `cockpit-needs-you-cross-channel` reading the "N need you" header; a scenario whose subject survives (empty state, launch stays, toasts, smoke)
is rewritten onto the thumbnails' DOM.

Acceptance:
- tsc and the vitest suite pass with the modules gone; no deleted symbol is referenced in `frontend` or `scripts`.
- `surface-smoke` and each surviving `cockpit-*` scenario pass on the merged tree; no registered scenario
  references a removed selector or atom.
