# DAG header Run settings modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adjust in the DAG graph header opens a "Run settings" dialog (ModalShell, built like the Profile modal) in place of the inline full-width band, keeping every behavior and line of copy the band had.

**Architecture:** The run-settings state machine that lives inside `LoadedConfig` (draft, baseline, save, Use for new runs, errors, notices, the resolved hand-back) moves into one exported hook, `useRunSettingsEditor`, with its decisions (saved notice, approvals note, footer status, waiting question) extracted as pure, tested functions. The run sheet's inline form and the new `RunSettingsModal` both consume that hook, so there is one source of truth for save behavior. The inline form renders exactly as today; the non-inline branch of `LoadedConfig` is deleted because its only caller, the DAG header, now opens the modal.

**Tech Stack:** React 19, jotai, motion, Tailwind 4 (`@theme` tokens only), vitest, CDP scenarios under `scripts/cdp/`.

**Verify:** `node scripts/verify.mjs ./pkg/jarvis`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs dag-run-settings dag-lifecycle motion-dag-peek autonomous-runs`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\run-settings-polish\project

Verify note: this plan changes no Go. At each merge `verify.mjs` runs the vitest files related to the changed frontend paths (and nothing for `scripts/cdp` or docs); `./pkg/jarvis` only gives the unscoped final run a Go package that owns the run-settings rules. The tasks' own vitest steps are the focused tests.

## Decisions beyond the design (and why)

1. **One editor hook, two faces.** `useRunSettingsEditor` (in `briefrunsheet.tsx`) owns all state the band had; the inline form and the modal only render it. Why: "keep every existing behavior" is only provable if both faces run the same code; a copy in the modal would drift.
2. **The modal takes the header's live `group` and `owner`** (groupRead `"ready"`), not `run.dagoref` through a second `useDagGroup` subscription. Why: the header already holds the live linked group the DAG modal subscribes to; Adjust only shows while `!ended`, so the loading/unavailable notes are unreachable from here. If `configNote` still returns a note (a read-only run), the modal body shows that note (dot, title, body, same tones as the band's note) and the footer shows no buttons.
3. **Each open starts fresh.** `RunSettingsModal` calls `useRunSettingsEditor` at its top, outside `ModalShell` (so the component stays mounted while closed and an in-flight save still finishes), and the header keys `RunSettingsModal` by an open counter it bumps on every Adjust click. A new key remounts it, so a dropped or saved draft, the saved notice, an error and the resolved note never carry into the next open. Why: a modal reads as a fresh form; the band kept state only because it stayed mounted.
4. **Saving does not close the modal** (unlike Profile, which closes with a toast). Why: the Saved, SavedProfile and Resolved boards show those states inside the open modal.
5. **The DAG header now passes `waiting`.** Today it passes none, so the hand-back warning (ApprovalsOn) and the resolved note (Resolved) could never show from the DAG header; the boards require both. `waitingQuestion(run, agents, asks)` is extracted from `runsheet.tsx` (same rule: the lead's own asking question by its first header, else `{header: "question", lead: false}` when user-owned child asks exist) and both callers use it. The header reads agents from a new module-level `cockpitRosterAtom` (dev: `devRosterAtom`, else `liveAgentsAtom`, the exact choice `AgentsViewModel` makes today, which then uses this atom too) and asks from `childAsksAtom`, calling `bindChildAsks(group.channelid, group.runid)` on mount. Why: the DAG modal has no `AgentsViewModel`; the base roster carries the lead's `asking` state, which is all `leadAsker` reads. `devmock.ts`'s header comment says the module never ships in prod; with `cockpitRosterAtom` imported unconditionally that is no longer true, so the comment is updated to say the dev mock state is inert in prod (`import.meta.env.DEV` picks `liveAgentsAtom`) while the module itself ships.
6. **Parallelism is a `WorkerStepper`**, so a typed out-of-range width can no longer happen. A stored `0` (no width yet; the engine picks at submit) shows as `auto` (`value={null}`, `unsetLabel="auto"`), and every step goes through the pure `stepParallelism(width, delta)` (Task 1): from `0` it lands on `DEFAULT_PARALLELISM`, as in the Profile modal; otherwise `clampParallelism(width + delta)`. A DAG's group always has a width of at least 1 after `dagsubmit`, so the `0` case is unreachable from the DAG header and is proven by the unit test alone. The `invalid` rule and its copy are kept (they gate Save and appear in the footer status) even though the stepper should not reach them. Why: keep behavior, cost is one branch.
7. **Footer status precedence** (one pure function, `runSettingsStatus`): error (the save's message, red, nudged by `errorNudge` keyed on the failure count) > invalid width copy (red) > `Unsaved changes` (asking dot) > the saved notice (success) > `No changes` (muted). Why: Refused shows the error, not "Unsaved", while the draft stays dirty; Saving shows "Unsaved changes"; Saved shows the notice once the draft equals the baseline. This matches the band, where the notice showed only when `!dirty`.
8. **Line under the Approvals panel** swaps by `approvalsNoteKind`: `on` (and a question waits) → the hand-back warning in `text-warning-soft`; `off` → "The lead asks you again from its next decision. Calls it already made stand." (muted); `none` → "Approvals apply to the lead's next decision." (muted). The band's single intro paragraph is split across the modal's three lines (fixed after launch, apply from now on, approvals) with the same words. The swap is a `CrossFade` (micro cross-fade).
9. **Close drops unsaved changes silently** (a change from the goal, made by the human after the first submit). There is no discard confirm: no Keep editing / Discard, no prompt. The X, Esc and a backdrop click always call `onClose` at once, dirty or not, and the next open re-seeds (Decision 3). Close stays allowed while a save is in flight (the hook lives in `RunSettingsModal`, which stays mounted while closed). Esc closes only this modal: `ModalShell` is on the modal stack, and the DAG modal's own keys already yield to a higher modal (`dagModalKey` checks `isTopModal`).
10. **Shared Profile pieces are exported, not copied.** `DefaultRow` gets optional `hint` and `aside`; with no `aside` its grid is `grid-cols-[156px_minmax(0,1fr)]` (the prototype's two columns). `FOOTER_BTN`, `SEGMENTS`, `SEGMENT` and `segmentTone` are exported from `briefprofileview.tsx`. The Profile modal renders exactly as before.
11. **Adjust is a dialog trigger now**: always labelled "Adjust" (no Done cross-fade), `aria-haspopup="dialog"`, no `aria-expanded`, `data-dag-adjust` kept.
12. **`RunSettingsPanel` loses `inline` and `open`**: it is only the run sheet's inline form. The non-inline JSX of `LoadedConfig` (the `PaneReveal open={hostOpen}` note and dials) is deleted.

## Global Constraints

- Colors from `@theme` tokens only (`frontend/tailwindsetup.css`); no raw hex, no new tokens. Prototype hex maps: `#5e9cff` accent, `#e6b450` asking, `#54c79a` success, `#e0726c` error, `#0c0e11` background, `#13171d` surface-raised, `#0e1116` surface, `#20262e` edge-mid / border.
- Copy is verbatim from `LoadedConfig` today; new copy only: `Run settings`, `Workers and reviewers`, `Approvals` (section), `No changes`, `Unsaved changes`, close aria-label `Close run settings`. No discard-confirm copy.
- `tsconfig.json` is `strict: false`: narrow unions with `in`, not truthiness.
- No `foo.ts` beside `foo.tsx` of the same name.
- The run sheet's inline form (`RunSettingsPanel` in `runsheet.tsx`) renders and behaves exactly as before.

## Review Focus

1. A run whose stored parallelism is 0: the modal must show `auto`, keep Save disabled until something changes, keep Use for new runs disabled (`defaultsInvalid`), and the first `+` must land on `DEFAULT_PARALLELISM`. Test: `stepParallelism` in Task 1. No scenario can reach it: a DAG's group always has a width of at least 1.
2. A save refused, then retried with the same message: the error must nudge again (keyed by failure count) and the draft must stay. Covered by the scenario's Refused step.
3. Esc inside the Run settings modal must not close the DAG modal under it, nor clear the graph's selection; with unsaved changes it still closes at once and drops them. Covered by `dag-run-settings` steps 10-11 and `motion-dag-peek` step 6.
4. A scheduler tick (group object changes, same settings) while the modal is open must not wipe the draft: the hook keeps the `draftSeedKey` seeding rule. Covered by keeping the seed effect as is (reviewer reads it).
5. Approvals turned on with no waiting question: no hand-back warning, the `none` line shows, and the saved notice is "Saved. The run is autonomous from now on." Test in Task 1 (`approvalsNoteKind`, `savedNotice`).

---

### Task 1: Pure run-settings decisions and the waiting question
**Depends on:** none
**Files:** `frontend/app/view/jarvis/runsettings.ts`, `frontend/app/view/jarvis/runsettings.test.ts`, `frontend/app/view/jarvis/runsheetmodel.ts`, `frontend/app/view/jarvis/runsheetmodel.test.ts`

Extract the decisions `LoadedConfig` makes inline (lines ~302-331 and ~275-284 of `briefrunsheet.tsx` today) into pure functions. Do not touch any `.tsx` here; Task 2 switches the callers.

**Interfaces (produces):**
- In `runsettings.ts`:
  - `export type WaitingQuestion = { header: string; lead: boolean };` (moves here from `briefrunsheet.tsx` in Task 2; define it here now).
  - `export type ApprovalsNoteKind = "on" | "off" | "none";`
  - `export function approvalsNoteKind(draft: RunSettingsDraft, baseline: RunSettingsDraft, waiting: WaitingQuestion | null | undefined): ApprovalsNoteKind` — `"on"` when turning on and `waiting != null`, `"off"` when turning off, else `"none"`.
  - `export function savedNotice(draft: RunSettingsDraft, baseline: RunSettingsDraft): string` — turning on: `"Saved. The run is autonomous from now on."`; turning off: `"Saved. The lead asks you from its next decision."`; else `"Saved. Applies to future dispatches."`.
  - `export function stepParallelism(width: number, delta: number): number` — `width <= 0` (unset) → `DEFAULT_PARALLELISM`; otherwise `clampParallelism(width + delta)` (both from `@/app/view/agents/runconfig`).
  - `export const DEFAULTS_SAVED_NOTICE = "Saved to this project's Profile. New runs start with these settings.";`
  - `export type RunSettingsStatus = { kind: "error" | "unsaved" | "saved" | "none"; text: string };`
  - `export function runSettingsStatus(input: { error: string | null; invalid: boolean; dirty: boolean; notice: string | null; baselineWidth: number }): RunSettingsStatus` — precedence per Decision 7. Invalid text: `` `Enter a whole number from 1 through ${MAX_PARALLELISM}. The scheduler is still running at ${baselineWidth}.` `` with kind `"error"`. Unsaved text `"Unsaved changes"`, none text `"No changes"`, saved text is the notice.
- In `runsheetmodel.ts`:
  - `export function waitingQuestion(run: Run, agents: AgentVM[], asks: DagAskItem[]): WaitingQuestion | null` — same rule as `runsheet.tsx:226-231` today: `leadAsker(run, agents)` → `{ header: asker.ask?.questions?.[0]?.header || "question", lead: true }`; else `userOwnedAsks(asks).length > 0` → `{ header: "question", lead: false }`; else `null`.

- [ ] **Step 1: Write failing tests** in `runsettings.test.ts`: `describe("approvalsNoteKind")` (on with waiting → "on"; on with no waiting → "none"; off → "off"; unchanged → "none"), `describe("savedNotice")` (the three strings exactly), `describe("runSettingsStatus")` (error beats invalid beats unsaved beats saved beats none; invalid text names the baseline width and `MAX_PARALLELISM`; a notice with `dirty: true` yields "unsaved"), `describe("stepParallelism")` (`(0, 1)` and `(0, -1)` → `DEFAULT_PARALLELISM`; `(1, -1)` → 1; `(MAX_PARALLELISM, 1)` → `MAX_PARALLELISM`; `(4, 1)` → 5). In `runsheetmodel.test.ts`: `describe("waitingQuestion")` (asking lead with header "Plan review" → `{header: "Plan review", lead: true}`; asking lead with no header → "question"; no lead but a user-owned ask → `{header: "question", lead: false}`; neither → null). Build agents/asks the way existing tests in those files build runs.
- [ ] **Step 2:** `npx vitest run frontend/app/view/jarvis/runsettings.test.ts frontend/app/view/jarvis/runsheetmodel.test.ts` → the new tests FAIL.
- [ ] **Step 3:** Implement the functions above.
- [ ] **Step 4:** Same command → PASS.
- [ ] **Step 5:** Commit.

### Task 2: Run settings modal from the DAG header
**Depends on:** Task 1 (uses `approvalsNoteKind`, `savedNotice`, `runSettingsStatus`, `stepParallelism`, `DEFAULTS_SAVED_NOTICE`, `WaitingQuestion`, `waitingQuestion`)
**Files:** `frontend/app/view/jarvis/briefrunsheet.tsx`, `frontend/app/view/jarvis/runsettingsmodal.tsx`, `frontend/app/view/jarvis/briefprofileview.tsx`, `frontend/app/view/jarvis/runsheet.tsx`, `frontend/app/view/orchestrate/daggraph-header.tsx`, `frontend/app/view/agents/devmock.ts`, `frontend/app/view/agents/agents.tsx`, `docs/orchestrator-guide.md`, `scripts/cdp/scenarios-runs.mjs`

Read `briefprofileview.tsx` (`DefaultRow`, `FooterStatus`) and every board in the Prototype folder before building. Every line number below is pre-edit.

**Interfaces:**
- Consumes (Task 1): see Depends on.
- Produces, in `briefrunsheet.tsx`:
```ts
  export type RunSettingsEditor = {
      state: RunSettingsPanelState; note: ConfigNote | null;
      draft: RunSettingsDraft | null; baseline: RunSettingsDraft | null;
      setDraft: (d: RunSettingsDraft) => void;
      saving: "settings" | "defaults" | null; busy: boolean; dirty: boolean;
      invalid: boolean; defaultsInvalid: boolean; notSaved: boolean;
      error: string | null; failures: number; notice: string | null;
      approvalsNote: ApprovalsNoteKind; resolvedHeader: string | null;
      canSave: boolean; canSaveDefaults: boolean;
      save: () => void; saveDefaults: () => void;
  };
  export function useRunSettingsEditor(run: Run, group: TaskGroup | null, groupRead: LinkedGroupRead, waiting: WaitingQuestion | null | undefined): RunSettingsEditor;
  export function ResolvedNote({ header }: { header: string }): JSX.Element; // now exported, unchanged
```
  `canSave = !busy && dirty && !invalid && channelId !== ""`; `canSaveDefaults = !busy && !defaultsInvalid && channelId !== ""` (the band's exact `disabled` rules).
- Produces, in `runsettingsmodal.tsx`: `export function RunSettingsModal({ open, run, group, waiting, onClose }: { open: boolean; run: Run; group: TaskGroup; waiting: WaitingQuestion | null; onClose: () => void })`. It calls `useRunSettingsEditor(run, group, "ready", waiting)` at its top, outside `ModalShell` (Decision 3).
- DOM contract the scenarios rely on: `data-run-settings-modal` (the modal's root inside the dialog panel), `data-run-settings-close` (the X), `data-run-settings-status="error|unsaved|saved|none"` (the footer status), the stepper's `aria-label`s `Fewer concurrent workers` / `More concurrent workers`, the Approvals group `role="group" aria-label="Approvals"`, `data-jarvis-brief-sheet-resolved` (the `ResolvedNote`), and buttons by text `Save settings` / `Use for new runs` / `Saving…`.
- Produces, in `devmock.ts`: `export const cockpitRosterAtom: Atom<AgentVM[]>` (Decision 5).
- `briefprofileview.tsx` exports `DefaultRow` (with `hint?: string`, `aside?: ReactNode`), `FOOTER_BTN`, `SEGMENTS`, `SEGMENT`, `segmentTone`.
- Removed: `ConfigProps.inline`, `ConfigProps.open`; `WaitingQuestion` now imported from `./runsettings` (in `briefrunsheet.tsx` and `runsheet.tsx`).

Steps:
- [ ] **Step 1: Hook.** Move `LoadedConfig`'s state, seed effect, derived flags, `submit`, `save`, `saveDefaults` into `useRunSettingsEditor`, using Task 1's functions for the notice, approvals note and (in the modal) status. Behavior unchanged: only a successful write re-seeds the baseline, a refused save keeps the draft, the resolved note is keyed by run id and set only when `waiting.lead` at save time, the defaults save refreshes the resolved profile only after the write. `LoadedConfig` keeps its inline JSX, reading the hook; delete its non-inline branches and the `inline`/`open` props (Decision 12); `RunSettingsPanel` and `LinkedRunConfig` stay. `runsheet.tsx`: drop `inline` on `<RunSettingsPanel>`, import `WaitingQuestion` from `./runsettings`, and replace the inline `waiting` computation with `waitingQuestion(run, agents, asks)`.
- [ ] **Step 2: Shared Profile pieces** per Decision 10. The Profile modal must render identically (every existing `DefaultRow` call still passes `hint` and `aside`).
- [ ] **Step 3: `RunSettingsModal`** in `runsettingsmodal.tsx`, laid out per `Main.dc.html`: `ModalShell` `className="flex max-h-[86vh] w-[min(620px,93vw)] flex-col"`; root `data-run-settings-modal`; header (`border-b border-border px-5 py-4`) with `Run settings` (15px semibold) over the run name (`group.title || "orchestration dag"`, 12px muted, truncated) and an X icon button (lucide `X`, 14px, `aria-label="Close run settings"`, `data-run-settings-close`); body (`bg-background px-5 pt-[18px] pb-5`, `flex-col gap-[22px]`, scrolls): `ResolvedNote` when `resolvedHeader != null`, then "Shape, machine and the lead route are fixed after launch.", then section **Workers and reviewers** (h2 13px semibold) with a `PROFILE_PANEL` of four `DefaultRow`s, no aside: Worker parallelism (hint `1 through ${MAX_PARALLELISM}`, `WorkerStepper` per Decision 6, `onStep={(d) => setDraft({ ...draft, parallelism: stepParallelism(draft.parallelism, d) })}`), Worker route (`RoutePicker` with `canInherit`, `inheritedLabel="Inherit the lead"`, the `Reviewer picks` extra option, `withWorkers`), Reviewers (`inheritedLabel="Inherit the lead"`), Light reviewers (`inheritedLabel="Sonnet (default)"`, attrs `data-light-reviewers-row`), all `disabled={busy}`; then "Parallelism and routes apply to workers and reviewers dispatched from now on."; then section **Approvals** with one `DefaultRow` "Approvals" holding the `SEGMENTS` group (`role="group" aria-label="Approvals"`, `bg-surface-raised`, `h-6 px-[11px] text-[12.5px] font-medium` buttons, `aria-pressed`, `disabled={busy}`), then the swapped line per Decision 8. When `note != null`, the body shows the note instead (Decision 2). Footer (`border-t border-border bg-surface-raised px-5 py-3`, `flex items-center gap-2`): status span `data-run-settings-status={status.kind}` per `runSettingsStatus` (error: `text-error`, wrapped in a `motion` element with `errorNudge` keyed by `failures`; unsaved: asking dot + `text-asking`; saved: `text-success`; none: `text-muted`), then **Use for new runs** (`FOOTER_BTN` + `border border-border bg-surface-raised text-secondary hover:text-primary disabled:opacity-40`, `title={USE_FOR_NEW_RUNS_TITLE}`, label `Saving…` while `saving === "defaults"`), then **Save settings** (`FOOTER_BTN`; `bg-accent text-background hover:bg-accenthover` when `canSave || saving === "settings"`, else `bg-border text-muted`; label cross-fades to `Saving…` while `saving === "settings"`). `ModalShell`'s `onClose` is the modal's `onClose` directly (Decision 9: no confirm, a dirty draft is dropped).
- [ ] **Step 4: Header.** In `daggraph-header.tsx`: Adjust per Decision 11 opens the modal and bumps the open counter (Decision 3); render `<RunSettingsModal key={opens} open={adjusting} run={owner} group={group} waiting={waiting} onClose={() => setAdjusting(false)} />` while `!ended`; `waiting = waitingQuestion(owner, useAtomValue(cockpitRosterAtom), useAtomValue(childAsksAtom)[group.runid] ?? [])`, with `bindChildAsks(group.channelid, group.runid)` in an effect. Remove the `RunSettingsPanel` band and the now-unused `CrossFade` import; update the header comment (line 62-65) to say Adjust opens the Run settings modal. `agents.tsx` uses `cockpitRosterAtom` for its base roster (keep `loadDevMockRoster()` in DEV).
- [ ] **Step 5: Docs.** `docs/orchestrator-guide.md` lines ~983 and ~996: the Route DAG modal's Adjust opens a **Run settings** dialog (same controls, Save settings / Use for new runs in its footer).
- [ ] **Step 6:** `npx vitest run frontend/app/view/jarvis` → PASS; Check passes.
- [ ] **Step 7: `dag-lifecycle` step 5g** (`scenarios-runs.mjs` ~line 464-488) drives the removed number input and the Done toggle, so update it here: Adjust opens `[data-run-settings-modal]`; raise the width with `button[aria-label="More concurrent workers"]` to `dagParallelism + 1`; Save settings; wait for `[data-run-settings-status="saved"]` reading `Saved. Applies to future dispatches.`; keep the dag-width and header assertions and the `cdp-shots/dag-modal-adjust.png` shot; close with `[data-run-settings-close]` (not a second Adjust click) and assert the DAG modal is still open before step 6's Escape. Reword the step text to say the Run settings modal.
- [ ] **Step 8: See it.** `ARC_FINAL_OUT=<tmp dir> node scripts/cdp/final-verify.mjs dag-lifecycle` → passes, and `dag-modal-adjust.png` shows the modal over the graph. (`motion-dag-peek` step 6 still expects the Done label until Task 3; do not run it here.)
- [ ] **Step 9:** Commit.

**Motion (docs/reference/motion-system.md):** open/close is `ModalShell`'s `modalBackdrop`/`modalPanel`; the Save label `Saving…` and the approvals line swap with `CrossFade` (micro cross-fade); the refused save nudges the footer error (moment 13, `errorNudge`); the stepper count rolls (moment 12, `TickNumber`, inside `WorkerStepper`). Task 4's `dag-run-settings` steps 2 (count roll), 3 (`Saving…`) and 4 (nudge) show them, and Task 3's `motion-dag-peek` step 6 shows the open fade.

**Acceptance:** shown by `dag-lifecycle` step 5g (this task), `dag-run-settings` (Task 4) steps 1-11, plus `motion-dag-peek` step 6 (Task 3); the run sheet's inline form still passes `autonomous-runs` unchanged.

### Task 3: The DAG motion scenario opens the modal
**Depends on:** Task 2 (drives the modal it builds)
**Files:** `scripts/cdp/scenarios-motion-dag-peek.mjs`

- [ ] **Step 1:** `scenarios-motion-dag-peek.mjs` step 6 (~line 231-243): Adjust no longer cross-fades to Done. Replace it with: clicking `[data-dag-adjust]` fades the Run settings dialog panel (`[data-run-settings-modal]`'s `role="dialog"` ancestor) in from opacity 0 to 1 (this file's `start`/`stop`/`fadedIn` helpers), then Esc closes only it (`[data-dag-modal-kind]` still present, and the selection the later steps rely on unchanged). Reword the step text to say so.
- [ ] **Step 2:** `ARC_FINAL_OUT=<tmp dir> node scripts/cdp/final-verify.mjs motion-dag-peek` → passes.
- [ ] **Step 3:** Commit.

### Task 4: `dag-run-settings` scenario covering every board
**Depends on:** Task 2 (drives the modal it builds)
**Files:** `scripts/cdp/scenarios-dag-run-settings.mjs`, `scripts/cdp/scenarios.mjs`, `scripts/cdp/scenarios-runs.mjs`

A new scenario `dag-run-settings` (surface `jarvis`) in `scenarios-dag-run-settings.mjs`, registered in `scripts/cdp/scenarios.mjs` the way `dagLifecycle` is (the import and every list it appears in). Arrange the run with `arrangeHeldRun` (`scenarios-shared.mjs`, ~line 602; teardown with `teardownHeldRuns`): an orchestrator run held by deferstart in an unborn repo with a submitted dag, which never starts a model. `SetRunSettingsCommand` accepts it (`jarvis.EngineSettingsBlocker` refuses only done/cancelled, non-orchestrator and adaptive runs), and with a dag owned by the run it writes the group, so width saves land in `dagstatus`; `autonomous-runs` already proves the Approvals hand-back on a deferstart run. Give it 4 tasks and `parallelism: 4` (the boards' width). Then link a lead asking `Plan review` to that run as `autonomousRuns` does (it rewrites the run's phases with `fstWriteRun` and seeds the fixture roster): export `seedAutonomousLead`, `raiseLeadAsk`, `patchFixtureLead` and the constants they need from `scenarios-runs.mjs` and import them rather than copying. Use `holdRpc`/`failRpc`/`releaseRpc` from `scenarios-shared.mjs` for Saving and Refused. Teardown runs `teardownHeldRuns`, deletes the lead tab, removes the fixture roster and restores any patched RPC. Write `shots.json` with one entry per board.

Steps (each takes a screenshot `cdp-shots/run-settings-<board>.png` and records pass/fail with its observed state):
1. **Main:** open the DAG modal, click `[data-dag-adjust]` → `[data-run-settings-modal]` shows title `Run settings`, the run name, status `none` / `No changes`, Save settings disabled, Use for new runs enabled.
2. **Dirty:** `More concurrent workers` → the count reads baseline+1, status `unsaved` / `Unsaved changes`, Save enabled.
3. **Saving:** `holdRpc("SetRunSettingsCommand")`, Save → Save reads `Saving…`, stepper, route pickers and Approvals buttons disabled; `releaseRpc`, close with the X, reopen.
4. **Refused:** `failRpc("SetRunSettingsCommand", <msg>)`, change width, Save → status `error` with `<msg>`, draft count unchanged, Save still enabled; Save again → the error nudges again; `releaseRpc`.
5. **Saved:** Save → status `saved` / `Saved. Applies to future dispatches.`, Save disabled, `dagstatus` width equals the draft.
6. **SavedProfile:** Use for new runs → status `saved` / `Saved to this project's Profile. New runs start with these settings.`
7. **ApprovalsOn:** with the lead asking Plan review, click `Autonomous` → line reads `Saving hands the waiting Plan review back to the lead, and it answers everything from then on.`
8. **Resolved:** Save → `[data-jarvis-brief-sheet-resolved]` inside the modal reads `Plan review: the lead decided` and status reads `Saved. The run is autonomous from now on.`
9. **ApprovalsOff:** click `Ask me` → line reads `The lead asks you again from its next decision. Calls it already made stand.`
10. **Close drops a dirty draft:** with that unsaved change (status `unsaved`), Esc → the Run settings modal closes at once with no confirm (no `Keep editing` / `Discard` button anywhere), `[data-dag-modal-kind]` stays; Adjust again → status `No changes` and the last saved settings (Autonomous pressed from step 8, the unsaved change gone). Repeat with the X (`[data-run-settings-close]`) and with a mousedown on the backdrop (the dialog panel's parent): each drops a dirty draft and closes.
11. **Clean close:** with no changes, `[data-run-settings-close]` closes it at once, and Esc with no changes closes only the Run settings modal.

- [ ] **Step 1:** Write the scenario, the exports and the registration.
- [ ] **Step 2:** `ARC_FINAL_OUT=<tmp dir> node scripts/cdp/final-verify.mjs dag-run-settings autonomous-runs` → every step passes (`autonomous-runs` proves the exports left it intact and the run sheet's inline form unchanged); look at each shot against its board in the Prototype folder (Main.dc.html, Dirty, Saving, Refused, Saved, SavedProfile, ApprovalsOn, Resolved, ApprovalsOff).
- [ ] **Step 3:** Commit.
