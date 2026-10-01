# Cockpit Peek (slice 2) Implementation Plan

> **For agentic workers:** each task below carries its design decisions, the files it owns, the interfaces other
> tasks rely on, and acceptance criteria with the focused tests that prove them. Write the implementation yourself.

**Goal:** Look at any run, agent, record, initiative, radar finding or memory note inside the avatar popup, without
leaving the surface you are on and without writing that destination's selection.

**Architecture:** `openref.ts` splits each kind's landing into a load (proves the target exists, writes nothing) and
a select (writes the destination's selection; open only). `peekTarget` = load, then one peek-store atom that the
avatar popup (`petpeek.tsx`) renders as an item view: header (Back to Jarvis, close X), a per-kind body from a
registry, Open / Focus this, and the key hints. Ctrl+click on any DOM element that opens a target today, and Space on
a row cursor, call `peekTarget` instead of `openTarget`.

**Tech Stack:** React 19, jotai, Tailwind 4 `@theme` tokens, vitest; Go (`pkg/wshrpc`, `pkg/wavevault`) for the
note RPC; CDP scenarios in `scripts/cdp/scenarios.mjs`.

**Spec:** none. The approved mockup is the design:
`C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\cockpit-peek\project\` (Main.dc.html interactive;
States.dc.html; PeekRun, PeekAgent, PeekEffort, PeekRecord, PeekRadar, PeekNote `.dc.html`). The original contract
is `docs/superpowers/specs/2026-09-22-cockpit-focus-and-peek-design.md` §5-6; where it and the mockup disagree, the
mockup wins (the peek lives in the avatar popup, not a ModalShell overlay).

**Effort:** effort:868d36b8-4871-4134-a920-772df62963b1
**Verify:** `node scripts/verify.mjs ./pkg/wshrpc/... ./pkg/wavevault/...`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && go vet ./pkg/wshrpc/... ./pkg/wavevault/...`
**Final:** `node scripts/cdp/final-verify.mjs peek-ctrl-click jarvis-peek brief-peek resource-linking surface-smoke`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\cockpit-peek\project\Main.dc.html

## Global Constraints

- A peek writes no destination selection atom: not `briefSheetOpenAtom`, `activeSubjectAtom`/`selectSubject`,
  `activeRunIdAtom`/`setActiveRunId`, `selectChannel`, `briefPeekRecordAtom`, `pendingDecisionAnchorAtom`,
  `radarScopeAtom`/`initRadarScope`, `selectReport`, `radarSelectedIdAtom`, the Agent surface's focused agent
  (`jumpToAgent`), nor `model.surfaceAtom`.
- A peek never changes the cockpit focus. Only the Focus this button (or `f` in the item view) does.
- A failed load is a toast (`OpenResult` copy, through the existing `toast` in `openref.ts`) and opens nothing; a
  superseded load renders nothing. Peek and open share one `openSeq` counter, so the latest click wins.
- Depth 1: a link inside an item view body does a full `openTarget`, including with Ctrl held. Bodies never call
  `openOrPeek`.
- Colors come from `@theme` tokens in `frontend/tailwindsetup.css`; no raw hex/rgba; no new tokens (DESIGN.md).
- The agent peek has no terminal.
- Never hand-edit generated files; run `task generate` after changing a wshrpc type.
- Out of scope: new links on surfaces that have none (Diff, Code), and the toast stack's position under the avatar.
- **Deliberate deviation from the mockup:** Main.dc.html demonstrates the gesture on the Sessions "All activity"
  feed, where each row peeks a run, agent or initiative. Those rows link sessions today, not runs, and the human
  scoped giving them targets out of this run in the goal. This plan therefore builds no feed-row-to-target mapping,
  and the gesture is demonstrated on the Brief instead (Task 7). Task 7 records the deferral in `docs/deferred.md`.

## Review Focus

- A Ctrl+click on an element nested in a row that has its own click handler must peek once, not peek and open
  (stop propagation in `openOrPeek` when it peeks). Owner: Task 3.
- The peeked target vanishes while the item view is open (run deleted, agent session ends). The body shows a
  one-line "no longer exists" state, and Open and Focus this are disabled. It must not render blank or throw.
  Owner: Task 2 (the shell's gone state, through `reportPeekFacts`) and Tasks 4-6 (each body model's `gone`, one
  test per body model: run, record, agent, initiative, radar, note).
- Ctrl is held when the window loses focus (Alt+Tab). The ctrl-held flag clears on `blur`, so no element stays
  underlined. Owner: Task 3.
- Space while focus is in an editable field (composer, terminal textarea, reply input) never peeks. Owner: Task 3.
- Escape from an item view that was opened from a closed popup closes the popup and leaves the host surface's
  selection and scroll untouched. Backspace from one opened from the hub returns to the hub. Owner: Task 2.

---

### Task 1: Split openref.ts into load and select; peekTarget and the peek store
**Depends on:** none
**Chunk:** S2-1 Slice 2 plan (needs S1's loadTarget/selectTarget signatures + the mockup)
**Chunk:** S2-2 openref.ts load/select split, so a peek writes no destination selection

**Files:**
- Modify: `frontend/app/view/jarvis/openref.ts`, `frontend/app/view/jarvis/openref.test.ts`
- Create: `frontend/app/view/jarvis/peekstore.ts`, `frontend/app/view/jarvis/peekstore.test.ts`

**Decisions:**
- Every `land*` function splits in two: `load<Kind>` awaits what proves the target exists and returns the loaded
  facts, or a failure `OpenResult`, writing no atom. `select<Kind>` writes the destination's selection and switches
  surface. `openTarget` = load, then select (unchanged observable behaviour; existing `openref.test.ts` cases pass
  untouched). Radar's load fetches the report and checks the finding. It does NOT call `initRadarScope` or
  `selectReport`, which belong to select.
- Effort gains a real load (today's landing only writes): `loadEffort` awaits
  `loadEffortDetail("effort:" + effortId)` (`effortstore.ts`), then reads `effortDetailAtom`. A rejected load, or
  one that leaves no entry for that oref, is `unavailable("That initiative no longer exists")`. Check how
  `loadEffortDetail` reports a missing effort before relying on either path. `openTarget` on an effort now awaits
  this load before selecting, so a dead effort link toasts instead of opening an empty sheet.
- `peekTarget` = load, then write the peek store. A `channel` target is normalised to its active run: the run id
  named on the target, else the channel's newest run. A channel with no run fails with "That channel has no run to
  peek". A `canvas` target is not peekable, so `peekTarget` delegates to `openTarget`.
- The popup opens at once in a loading state (States.dc.html). On failure the store returns to where it was before
  the peek (popup closed, or the hub) and the toast fires. A superseded peek writes nothing, and the newer call owns
  the store. `openTarget` landing after a loading peek clears that loading item back to its prior state.
- `peekstore.ts` holds the item. It imports `petPeekOpenAtom` from `petstore.ts` to open and close the popup.

**Interfaces (produced, relied on by Tasks 2-7):**
```ts
// peekstore.ts
export type PeekTarget = Exclude<OpenTarget, { kind: "channel" } | { kind: "canvas" }>;
export type PeekItem = { target: PeekTarget; status: "loading" | "ready"; from: "closed" | "hub" };
export const peekItemAtom: PrimitiveAtom<PeekItem | null>;
export function backToHub(): void;        // item -> hub, popup stays open
export function closePeek(): void;        // item and popup closed
// openref.ts
export function peekTarget(model: AgentsViewModel, target: OpenTarget, report?: ReportOpen): Promise<OpenResult>;
export function peekAddress(model: AgentsViewModel, address: string, hint?: AddressHint, report?: ReportOpen): Promise<OpenResult>;
// ctrlKey -> peek (and event.preventDefault + stopPropagation); otherwise openTarget/openAddress
export function openOrPeek(model: AgentsViewModel, target: OpenTarget, event?: { ctrlKey: boolean; preventDefault(): void; stopPropagation(): void }): Promise<OpenResult>;
export function openOrPeekAddress(model: AgentsViewModel, address: string, event?: { ctrlKey: boolean; preventDefault(): void; stopPropagation(): void }, hint?: AddressHint): Promise<OpenResult>;
export function isPeekable(target: OpenTarget): boolean; // false for canvas
```

**Acceptance and tests** (`npx vitest run frontend/app/view/jarvis/openref.test.ts frontend/app/view/jarvis/peekstore.test.ts`):
- [ ] One test per kind (run, channel, agent, record, effort, radar): `peekTarget` on a loadable target leaves every
  selection atom in Global Constraints at its prior value and `model.surfaceAtom` unchanged. The test sets
  `peekItemAtom` to `{ target, status: "ready", from }`, where `from` is `"closed"` when the popup was closed and
  `"hub"` when it was open, covering both, and opens `petPeekOpenAtom`. This is the regression most likely to return,
  so it asserts the atoms by value and not by mock call counts.
- [ ] A failed load (run gone, agent not in roster, record not listed, effort missing, report gone) toasts the
  existing copy and
  leaves `peekItemAtom` and `petPeekOpenAtom` as they were before the call (closed, and separately hub-open).
- [ ] Two peeks, the first resolving after the second: only the second's target is in the store, and no toast for
  the first.
- [ ] An `openTarget` started while a peek is loading clears the loading item.
- [ ] `openOrPeek` with `ctrlKey` peeks and calls `preventDefault` and `stopPropagation`. Without `ctrlKey` it opens
  and calls neither. A canvas target with `ctrlKey` opens.
- [ ] `backToHub` / `closePeek` state transitions (peekstore.test.ts).

### Task 2: The avatar popup's item view
**Depends on:** Task 1

**Files:**
- Modify: `frontend/app/view/jarvis/petpeek.tsx`, `frontend/app/view/jarvis/petactrun.ts`, `frontend/app/view/jarvis/petpeekmodel.ts` (+ its test)
- Create: `frontend/app/view/jarvis/peekitem.tsx` (the item view shell), `frontend/app/view/jarvis/peekitemmodel.ts`
  + `peekitemmodel.test.ts`, `frontend/app/view/jarvis/peek/peekregistry.ts`, and stub bodies
  `frontend/app/view/jarvis/peek/{peekrun,peekagent,peekrecord,peekeffort,peekradar}.tsx`
- Modify: `frontend/app/view/jarvis/peekstore.ts` + `peekstore.test.ts` (the facts channel below)
- Create: `frontend/app/view/agents/focusfor.ts` + `focusfor.test.ts` (the shared ActiveFocus builders)
- Modify: `frontend/app/cockpit/actions/{run,agent,record}.ts` so their focus actions call `focusfor.ts`
- Modify: `scripts/cdp/scenarios.mjs` `jarvis-peek` only if the hub's hint row change breaks an assertion

**Decisions:**
- The popup renders the item view when `peekItemAtom` is non-null. Layout: 560px wide (the hub keeps 300/420). The
  header has a "Jarvis" back button (chevron) on the left and the existing close X on the right. Then the body, then
  a row with "Open <kind>" (primary) and "Focus this", then the hint row: `↵ open <kind>`, `f focus this`,
  `⌫ back`, `esc close`. Match Main.dc.html. The panel carries `data-pet-peek-item=<kind>` and
  `data-pet-peek-status=<loading|ready>`, which Task 7 asserts.
- Loading: the skeleton and disabled buttons of States.dc.html.
- Open: `closePeek()`, then `openTarget(model, target)`. Focus this: `enterFocusFor(model, facts.focus)`, then
  `closePeek()`. The note kind (Task 6) has no Open.
- **Facts channel.** Whether a target is gone, and what its focus would be, depend on data only the body holds, so
  the body reports them and the shell reads them. Add to `peekstore.ts`:
  `type PeekFacts = { gone: boolean; focus: ActiveFocus | null }`, `peekFactsAtom: PrimitiveAtom<PeekFacts | null>`
  (reset to null whenever `peekItemAtom` changes target), and `reportPeekFacts(target: PeekTarget, facts: PeekFacts)`.
  A report for a target that is no longer the current item is ignored. The shell renders the body. When
  `facts.gone`, it renders one line in place of the body (`That <kind> no longer exists`) with Open and Focus this
  disabled. Focus this shows only when `facts?.focus != null`. The stub bodies report
  `{ gone: false, focus: null }`. Tasks 4-6 only call `reportPeekFacts`; they never edit the shell, the store or the
  registry.
- **Focus builders** (`focusfor.ts`): `focusForRun(row: FocusRowVM | undefined): ActiveFocus | null` returns null
  when the focus switcher has no row for the run. The label and project come from that row, which `actions/run.ts`
  finds with `runRows(agents)` (`focusswitchermodel.ts`). `focusForAgent(agent: AgentVM): ActiveFocus` uses
  `agent.name` and `projectOf(agent)`. `focusForRecord(r: { id: string; objective: string; status: string }):
  ActiveFocus | null` returns null unless `isFocusTarget(r.status)` (`tasksderive.ts`), with project `""`, matching
  `record:focus`. The three cockpit actions switch to these builders and keep their behaviour. The run, agent and
  record bodies (Tasks 4-5) report `focus` through them. Initiative, radar and note report `focus: null`, so their
  Focus this never shows.
- Keys in the item view: Enter open, `f` focus this (when shown), Backspace `backToHub()`, Escape `closePeek()`. The
  existing focus management (FloatingFocusManager, return focus to the anchor, the `focusin` steal) carries over.
- Hub: clicking an update row (UpdateRow, LatestUpdate) peeks its first source: `peekAddress(model, source.ref,
  {anchor})`. Its "Open X" links keep opening, and Enter still runs the open act. In the busy queue, Space on the
  cursor row peeks that row's run. The hub hint row gains `space peek` where a cursor row or latest update is
  peekable (Main.dc.html `hubHints`).
- The pet act links (`ActLinks` and `ActButton` in `petpeek.tsx`, and `runAct` in `petactrun.ts:33`) take the click
  event and go through `openOrPeekAddress`. Ctrl+click on an act link from the hub therefore peeks, and the element
  carries `data-peek`.
- Registry: `PEEK_BODIES: Record<PeekTarget["kind"], ComponentType<{ model: AgentsViewModel; target: PeekTarget }>>`
  plus `openLabel(kind)` ("Open run", "Open agent", "Open record", "Open initiative", "Open finding") in
  `peekitemmodel.ts`. Each stub body renders the kind word and the target id in one line. Tasks 4-6 replace the stub
  file contents only, never the registry.

**Interfaces (produced):** `peek/peekregistry.ts` exports `PEEK_BODIES`. Each body file exports one named component:
`PeekRunBody`, `PeekAgentBody`, `PeekRecordBody`, `PeekEffortBody`, `PeekRadarBody`, all with props
`{ model: AgentsViewModel; target: PeekTarget }`. `peekitemmodel.ts` exports `openLabel(kind)`,
`itemButtons(kind, facts: PeekFacts | null): { open: "enabled" | "disabled" | "absent"; focus: "enabled" | "disabled" | "absent" }`,
`itemHints(kind, facts)`, and `itemKeyCommand(key): "open" | "focus" | "back" | "close" | null`. `peekstore.ts`
exports `PeekFacts`, `peekFactsAtom` and `reportPeekFacts`. `focusfor.ts` exports `focusForRun`, `focusForAgent`
and `focusForRecord`.

**Acceptance and tests** (`npx vitest run frontend/app/view/jarvis/peekitemmodel.test.ts frontend/app/view/jarvis/petpeekmodel.test.ts frontend/app/view/jarvis/peekstore.test.ts frontend/app/view/agents/focusfor.test.ts`):
- [ ] `itemButtons`: facts null (loading) disables both buttons. `gone` disables both. `focus: null` makes Focus
  absent. `openLabel` per kind.
- [ ] `itemHints` omits `f focus this` whenever Focus is not enabled. `itemKeyCommand` maps Enter, f, Backspace and
  Escape, and nothing else.
- [ ] `reportPeekFacts` for a stale target is ignored, and changing the item resets the facts to null.
- [ ] `focusForRun` returns null with no switcher row. `focusForRecord` returns null for a status
  `isFocusTarget` rejects, and a task focus with project `""` otherwise. `focusForAgent` uses the name and project.
- [ ] The hub's update-row peek target derives from the event's first source, and an event with no source is not
  peekable (pure helper in `petpeekmodel.ts`, tested there).
- [ ] The three cockpit focus actions still produce the same `enterFocusFor` arguments (the existing
  `frontend/app/cockpit/cockpit-actions.test.ts` passes; add a case there if none covers `run:focus`,
  `agent:focus` or `record:focus`).

### Task 3: Ctrl+click, Space, and the Ctrl-held affordance
**Depends on:** Task 1

**Files:**
- Modify the DOM click sites that open a target today, routing them through `openOrPeek` /
  `openOrPeekAddress(model, …, event)` and marking the clickable element `data-peek`:
  `frontend/app/view/agents/agentheader.tsx:92`, `agenttree.tsx:505`, `radarfindingdetail.tsx:41,163`,
  `runrailsections.tsx:117,222`, `sessionsdetail.tsx:437`, `frontend/app/view/jarvis/briefsheet.tsx:370`,
  `briefsurface.tsx:920,978-987,1911`, `effortdetailview.tsx:433`, `graphpeek.tsx:132`, and
  `frontend/app/view/orchestrate/taskcorrelate.ts:71`. Line numbers are as of `ee53d1b3`; find each by its
  `openTarget(`/`openAddress(` call. Two sites belong to the tasks that own their files: the pet act links go to
  Task 2, and `briefpeekview.tsx:108` goes to Task 4.
- Leave alone: `frontend/app/cockpit/actions/*`, `command-palette.tsx`, `uiclient.ts`, `linkingdevhooks.ts`,
  `newruncontrol.tsx`, `initiativeworkaction.ts`. These are not pointer clicks on a link.
- Modify: `frontend/app/store/keybindings/listnav.ts` (optional `peekTarget?: () => OpenTarget | null` on
  `ListNavController`), `bindings.ts` (a `list:peek` binding on `Space`, plus a `cockpit:peek` doc binding),
  `bindings.test.ts`
- Modify: `frontend/app/view/jarvis/briefsurface.tsx` and `frontend/app/view/agents/radarfindingslist.tsx` to
  publish `peekTarget` for the cursor row. `frontend/app/view/agents/usecockpitkeyboard.ts`: Space on a roster agent
  row peeks `{kind: "agent", tabId}`.
- Modify: `frontend/app/cockpit/footerhints.ts` (+ test), `hints-footer.tsx`, `cockpit-root.tsx` (the listener),
  `frontend/tailwindsetup.css` or `frontend/app/cockpit/cockpit.scss` (the one rule)
- Create: `frontend/app/cockpit/ctrlheld.ts` + `ctrlheld.test.ts`

**Decisions:**
- One window listener in `cockpit-root.tsx` (keydown/keyup on Control, and window `blur`) sets
  `document.documentElement.dataset.ctrlHeld` and a `ctrlHeldAtom`. The state transition is a pure function in
  `ctrlheld.ts`.
- One style rule: `:root[data-ctrl-held] [data-peek]:hover` gets an accent underline (offset 3px) and
  `cursor: zoom-in`. It uses theme tokens only (`var(--color-accent)` or the token the mockup's accent maps to).
- `list:peek` (key `Space`, group Navigation, `paletteHidden`) is active when the list-nav controller is active and
  `peekTarget?.()` is non-null. It runs `peekTarget(model, target)`. The Brief's rows peek their row target (run,
  record, effort). Radar's rows peek `{kind: "radar", reportId, findingId}`.
- Footer chip `{ ids: ["list:peek", "cockpit:peek"], glyph: "space · ctrl+click", label: "peek" }` in
  `GLOBAL_HINTS`, shown only when one of those bindings is active. While `ctrlHeldAtom` is true it renders lit:
  accent border, accent-tinted fill and accent-soft label, as in Main.dc.html `appHints`.

**Acceptance and tests** (`npx vitest run frontend/app/cockpit/ctrlheld.test.ts frontend/app/cockpit/footerhints.test.ts frontend/app/cockpit/footer-visible.test.ts frontend/app/store/keybindings/bindings.test.ts`):
- [ ] ctrlheld: Control down sets the flag and Control up clears it. `blur` clears it. Other keys leave it.
- [ ] `list:peek` is inactive when the controller has no `peekTarget`, when it returns null, when `ctx.editable`,
  and when `ctx.modalOpen`. Otherwise it is active and runs `peekTarget` with the returned target.
- [ ] The peek chip is visible only when `list:peek` or `cockpit:peek` is active (footer-visible), and every id it
  references exists (footerhints.test.ts).
- [ ] At least one converted call site's handler is covered by a test through its pure model, if it has one. The
  rest are covered by `openOrPeek`'s Task 1 tests and the Task 7 scenario.

### Task 4: Run and record bodies
**Depends on:** Task 2

**Files:**
- Replace: `frontend/app/view/jarvis/peek/peekrun.tsx`, `frontend/app/view/jarvis/peek/peekrecord.tsx`
- Create: `frontend/app/view/jarvis/peek/peekrunmodel.ts` + `peekrunmodel.test.ts`,
  `frontend/app/view/jarvis/peek/peekrecordmodel.ts` + `peekrecordmodel.test.ts`
- Modify: `frontend/app/view/jarvis/briefpeekview.tsx`: extract its body into one `RecordPeekBody` component that
  both the Brief peek and `PeekRecordBody` render. The Brief peek stays and remains the record's Open destination.
  Its fleet-row run link (`briefpeekview.tsx:108`) goes through `openOrPeekAddress` with the click event when it
  renders in the Brief peek, and through a plain `openAddress` inside the popup (depth 1). It carries `data-peek`
  only in the Brief.

**Decisions:**
- Run body per PeekRun.dc.html: the kind word, goal and status pill. A meta line: mode, project, lead harness/model,
  duration, tokens, age. Goal text. The phase strip (Plan, Plan review, Tasks "n of m landed", Final). The
  unverified line when the final stage is unverified. The task list (id, title, status mark, tokens) with the commit
  range. Derive from the run WaveObj (live via WOS) and the facts the run sheet already derives
  (`briefsheetmodel.ts`, `briefrunsheet.tsx`, `runtimeline.ts`, the dag digest). Reuse those derivations; add only
  the arrangement in `peekrunmodel.ts`. A quick run has no phase strip or task list.
- Record body per PeekRecord.dc.html is exactly today's Brief peek content (`briefpeek.ts` `buildRecordPeek`),
  including its status picker.
- Each body reports its facts through Task 2's `reportPeekFacts(target, facts)` whenever they change, and never
  edits the shell, store or registry. The shell draws the gone line and disables the buttons. Run:
  `runPeekFacts(run | undefined, row: FocusRowVM | undefined): PeekFacts` in `peekrunmodel.ts`. A missing run is gone;
  otherwise focus is `focusForRun(row)`, with the row from `runRows(agents)`. Record:
  `recordPeekFacts(summary | undefined): PeekFacts` in `peekrecordmodel.ts`. A record no longer in `taskListAtom` is
  gone; otherwise focus is `focusForRecord(summary)`, which is null when `isFocusTarget` rejects its status.

**Acceptance and tests** (`npx vitest run frontend/app/view/jarvis/peek/peekrunmodel.test.ts frontend/app/view/jarvis/peek/peekrecordmodel.test.ts frontend/app/view/jarvis/briefpeek.test.ts`):
- [ ] The orchestrator run model gives the phase strip states, "8 of 8 landed", the unverified line only when
  unverified, and tasks in plan order with tokens. A quick run gives no phase strip.
- [ ] `runPeekFacts`: a missing run is `{ gone: true, focus: null }`. A run with no switcher row has `focus: null`.
  A run with a row carries that row's label and project.
- [ ] `recordPeekFacts`: an unlisted record is gone. A listed record with a non-focusable status has `focus: null`.
  A focusable one has a task focus with project `""`.
- [ ] briefpeek.test.ts still passes. The Brief peek renders through the shared body (the `brief-peek` CDP scenario
  in Final covers the render).

### Task 5: Agent and initiative bodies
**Depends on:** Task 2

**Files:**
- Replace: `frontend/app/view/jarvis/peek/peekagent.tsx`, `frontend/app/view/jarvis/peek/peekeffort.tsx`
- Create: `frontend/app/view/jarvis/peek/peekagentmodel.ts` + test, `frontend/app/view/jarvis/peek/peekeffortmodel.ts`
  + test

**Decisions:**
- Agent body per PeekAgent.dc.html: the kind word, the agent's name and state. A key/value grid: project, branch,
  cwd, model, session. Changed files (status letter, path, +/-). The footer line "The terminal stays on the Agent
  surface. Open agent takes you to it." No terminal and no PTY. Derive from the roster `AgentVM` and the sources
  `agentdetailsrail.tsx` already reads, reusing `agentrailmodel.ts` (`filesSummary`, `linkedWorktree`). An agent no
  longer in the roster is `gone`.
- Initiative body per PeekEffort.dc.html: the kind word, title and status. The objective line. "n of m chunks done",
  project, and the segmented progress bar. The done chunks collapsed to one line. The remaining chunks listed with
  status. Read the effort from `effortDetailAtom`, loaded by Task 1's effort load through `loadEffortDetail`. Derive
  with `effortFacts` and `chunkTone` from `effortmodel.ts`, and `effortChunkRows` from `effortstore.ts`. Don't write a
  new derivation of chunk state.
- Each body reports its facts through Task 2's `reportPeekFacts(target, facts)` and never edits the shell, store or
  registry. `agentPeekFacts(agent | undefined): PeekFacts` in `peekagentmodel.ts`: an agent missing from the roster
  (agents plus terminals) is gone; otherwise focus is `focusForAgent(agent)`. `effortPeekFacts(effort | undefined):
  PeekFacts` in `peekeffortmodel.ts`: a missing effort is gone; focus is always null.

**Acceptance and tests** (`npx vitest run frontend/app/view/jarvis/peek/peekagentmodel.test.ts frontend/app/view/jarvis/peek/peekeffortmodel.test.ts`):
- [ ] The agent model gives grid rows in mockup order, omits a row whose value is unknown rather than printing
  "undefined", and sums the changed files.
- [ ] `agentPeekFacts`: missing is `{ gone: true, focus: null }`. Present carries `focusForAgent`'s value.
- [ ] The effort model gives the done count, the collapsed done line, the remaining chunks in plan order with the
  active one marked, and progress segments equal to the chunk count.
- [ ] `effortPeekFacts`: missing is gone. Present has `focus: null`.

### Task 6: Radar finding body, and the memory-note kind end to end
**Depends on:** Task 2

**Files:**
- Replace: `frontend/app/view/jarvis/peek/peekradar.tsx`
- Create: `frontend/app/view/jarvis/peek/peeknote.tsx`, `frontend/app/view/jarvis/peek/peekradarmodel.ts` + test,
  `frontend/app/view/jarvis/peek/peeknotemodel.ts` + test
- Modify: `frontend/app/view/jarvis/address.ts` + `address.test.ts`; `frontend/app/view/jarvis/openref.ts` +
  `openref.test.ts` (the note kind); `peekstore.ts` / `peek/peekregistry.ts` / `peekitemmodel.ts` (register `note`,
  no Open, no Focus)
- Go: `pkg/wshrpc/wshrpctypes_jarvis.go` (`ReadVaultNoteCommand`), `pkg/wshrpc/wshserver/wshserver_jarvis.go`, a
  test beside `wshserver_graph_test.go`; then `task generate`
- Modify: `skills/cockpit-ui/SKILL.md` and `cmd/wsh/cmd/wshcmd-ui.go` help text only if they now misdescribe
  `memnote:`

**Decisions:**
- Radar body per PeekRadar.dc.html: the kind word, finding title and severity. Risk. Why. Evidence (count, then
  `path:line` rows). Investigation status (run id and state) when one exists. Compact what
  `radarfindingdetail.tsx` shows, reusing its model (`radarmodel.ts`). **Do not edit `radarfindingdetail.tsx`**:
  Task 3 converts its links in parallel. Anything you need from it moves only if it is already exported or lives in
  `radarmodel.ts`. The investigation run link does a full open (depth 1).
- Each body reports its facts through Task 2's `reportPeekFacts(target, facts)` and never edits the shell.
  `radarPeekFacts(report | undefined, findingId?): PeekFacts` in `peekradarmodel.ts`: a missing report, or a finding
  absent from it, is gone; focus is always null. The note body fetches with `ReadVaultNoteCommand`. A rejected fetch
  reports `{ gone: true, focus: null }`, and a successful one reports `{ gone: false, focus: null }`.
- Note kind: `OpenTarget` gains `{ kind: "note"; noteId: string }`. `memnote:<id>`, `memory:<id>` and
  `vault:<id>` with sourceType `memory` parse to it, and `NO_MEMORY_SURFACE` goes. A note has no surface, so
  `openTarget` on a note peeks it: a plain click on a note link and `wsh ui reveal memnote:<id>` both show the peek.
  Load: `ReadVaultNoteCommand({ id }) -> { id, title, body, updated, project? }` through
  `wavevault.Retriever(AllScope()).Read(id)`. The title is the frontmatter title, else the id. A missing id is an
  error, which the loader turns into the `unavailable` toast "That note no longer exists".
- Note body per PeekNote.dc.html: the kind word, title, and a meta line (project, updated date). The body renders
  as markdown with `MarkdownMessage`. There is no Open button and no Focus this.

**Acceptance and tests** (`npx vitest run frontend/app/view/jarvis/address.test.ts frontend/app/view/jarvis/openref.test.ts frontend/app/view/jarvis/peek/peekradarmodel.test.ts frontend/app/view/jarvis/peek/peeknotemodel.test.ts frontend/app/view/jarvis/peekitemmodel.test.ts`; `go test ./pkg/wshrpc/wshserver -run 'TestReadVaultNote'`):
- [ ] address: memnote, memory and vault+memory parse to `note`, and the other vault sourceTypes keep their current
  results.
- [ ] openref: `openTarget` and `peekTarget` on a note both set the store to a ready note item and write no
  selection atom. A missing note toasts and opens nothing.
- [ ] Go: the RPC returns the title (frontmatter, else id) and the body for a memory node in a temp vault
  (`wavevault.OpenVaultAtForTest`), and errors on an unknown id.
- [ ] The radar model gives evidence rows in order and the investigation line only when one exists.
- [ ] `radarPeekFacts`: a missing report is gone, a finding absent from its report is gone, and a present finding is
  `{ gone: false, focus: null }`.
- [ ] Note: `notePeekFacts(result: "ok" | "error"): PeekFacts` (in `peek/peeknotemodel.ts`): `"error"` is gone,
  and focus is always null. `itemButtons("note", …)` has Open absent and Focus absent (peekitemmodel.test.ts).

### Task 7: The peek-ctrl-click CDP scenario and docs
**Depends on:** Task 3, Task 4, Task 5, Task 6
**Chunk:** S2-3 peekTarget, the registry over ModalShell, six compact renderers
**Chunk:** S2-4 Space invocation, Open + Focus this promote verbs, CDP scenarios

**Files:**
- Modify: `scripts/cdp/scenarios.mjs` (new `peek-ctrl-click`)
- Modify: `docs/keyboard-shortcuts.md` (Space peek, Ctrl+click peek, and the item view's Enter, f, Backspace and
  Esc); `docs/reference/architecture.md` (one line: openref's load/select split and the popup item view);
  `docs/deferred.md`. Add the spec's "Deferred until evidence" list, as its Rollout section asks, if not already
  there. Add one entry for the deviation in Global Constraints: the Sessions "All activity" feed rows peeking a
  run, agent or initiative, as Main.dc.html shows, is deferred until those rows carry a target. Mirror it as a
  one-line row in `docs/open-issues.md`.
- Modify: `frontend/app/view/jarvis/petstore.ts` (its `__wavePetStore` dev global) and/or
  `frontend/app/view/jarvis/linkingdevhooks.ts`, only to expose what the scenario reads (`surfaceAtom`,
  `activeSubjectAtom`, `briefSheetOpenAtom`, `peekItemAtom`), under the same dev-only guard those globals already
  use.

**Decisions:**
- The scenario arranges a channel with a run (`h.rpc("createchannel", …)`, then the same run setup the existing
  `brief-peek` scenario uses) and goes to the Jarvis Brief. It records the host's selection: `model.surfaceAtom`,
  `activeSubjectAtom`, `briefSheetOpenAtom`, and the Brief list's scroll offset. It dispatches a Ctrl+click
  (`Input.dispatchMouseEvent` with `modifiers: 2`) on the run row's `[data-peek]` element.
- It then asserts: the popup carries `data-pet-peek-item="run"` with `data-pet-peek-status="ready"` and is 560px
  wide; every recorded value is unchanged; Escape closes the popup and the values still match. Read atoms through
  the existing dev-only globals pattern (`linkingdevhooks.ts`, `__wavePetStore`), adding only what the scenario
  needs. Scope DOM queries to a `data-*` container, not the document.

**Acceptance and tests:**
- [ ] `task verify:ui -- peek-ctrl-click` passes against a dev app on this branch. The Final line runs it with
  `jarvis-peek`, `brief-peek`, `resource-linking` and `surface-smoke`.
