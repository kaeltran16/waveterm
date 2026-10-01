# Final Check Screenshots Implementation Plan

> **For agentic workers:** each task below carries its design decisions, the files it owns, the interfaces other
> tasks rely on, and acceptance criteria with the focused tests that prove them. Write the implementation yourself.

**Goal:** Show a run's Final check screenshots in the cockpit: a collapsed Final check row and a Screenshots dock
button in the run sheet, opening a viewer of scenarios, screenshot + filmstrip, steps and a round switch, built
from real Final output, for every round of the run.

**Architecture:** The Final command may write an optional `shots.json` manifest into `ARC_FINAL_OUT`; this repo's
`verify.mjs`/`final-verify.mjs` write one. After the Final command exits, the engine copies the manifest (or a
plain listing of the PNGs) onto the dag's `FinalStage.Shots`, so steps outlive the files, and a fix round moves the
finished round into `TaskGroup.PastFinals` instead of overwriting it. `ARC_FINAL_OUT` moves from `%TEMP%` to the
app data dir with a 30-day sweep. The frontend derives everything from the dag in a pure `finalshotsmodel.ts`, and
renders the run sheet entry and a modal viewer that fetches PNGs through wavesrv.

**Tech Stack:** Go (pkg/orchestrate, pkg/waveobj), node scripts (scripts/cdp), React 19 + jotai + Tailwind 4.

**Prototype (the approved design; there is no separate spec):**
`C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\final-shots\project\` — boards `Main.dc.html` (run
sheet row closed and opened, dock button), `Viewer.dc.html` (the viewer), `States.dc.html` (entry states, missing
file, no manifest). Open them in a browser; the boards are interactive. They are the visual spec: layout, copy,
sizes, ordering and the drawer behaviour all come from them.

**Verify:** `node scripts/verify.mjs ./pkg/orchestrate/... ./pkg/waveobj/... ./pkg/jarvis/... ./cmd/server/...`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && go vet ./pkg/orchestrate/... ./pkg/waveobj/... ./pkg/jarvis/... ./cmd/server/...`
**Final:** `node scripts/cdp/final-verify.mjs final-shots run-sheet-polish surface-smoke`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\final-shots\project\Main.dc.html

## Global Constraints

- Decisions the human approved beyond the mockup (each binds every task):
  - Scope is all three boards: Main (row + dock button), Viewer, States.
  - `ARC_FINAL_OUT` is `<wave data dir>/final-shots/<dagID>/<round>`; a sweep at startup and every 4h (with the
    temp-attachment sweep) removes round dirs older than 30 days.
  - Manifest contract: optional `$ARC_FINAL_OUT/shots.json`, a JSON array of
    `{ "name": string, "files": string[], "steps": [{ "step": string, "state": "pass"|"fail"|"skip", "detail"?: string }] }`,
    file paths relative to `ARC_FINAL_OUT`, forward slashes.
  - With no `shots.json`, every `*.png` under `ARC_FINAL_OUT` (recursive, sorted by path) is one entry
    (`name` = file name without `.png`, one file, no steps) with no verdict.
  - The engine copies the manifest onto the dag after the Final command exits, whatever its exit code.
  - A fix round keeps the finished round in `TaskGroup.PastFinals`; the round switch reads it.
  - A scenario that threw is one failing step carrying the error as its detail.
  - The entry is hidden while a round's commands or verifier run; otherwise it shows the latest finished round.
  - PNGs are fetched through wavesrv `/wave/stream-local-file` with the auth header (`frontend/util/fetchutil.ts`)
    and shown as blob URLs; a 404 shows "No longer on disk".
  - Viewer keys (↑ ↓ scenario, ← → screenshot, z zoom, s steps, Esc close) are defined in
    `frontend/app/store/keybindings/bindings.ts`, active only while the viewer is open, and mirrored in
    `docs/keyboard-shortcuts.md`.
  - The mockup's hex colors map onto existing `@theme` tokens in `frontend/tailwindsetup.css`; no new tokens, no raw
    hex/rgba in components (AGENTS.md, DESIGN.md).
  - Where the boards disagree (decided by the lead, with the human's standing authority while away): the dock
    button is accented only while the latest finished round failed, as `States.dc.html` says; `Main.dc.html`'s accent
    on an unverified round is not followed.
  - Every shot count in the entry (`right`, `dockLabel`) is the latest finished round's count (16 on the boards), never
    a sum across rounds.
  - With one finished round the viewer header shows that round as a plain label (dot + "Round 1 passed"), not a
    one-segment control; the segmented round control appears from two finished rounds on.
- Never hand-edit generated files; run `task generate` after changing a waveobj type.
- Testable logic lives in a pure `.ts` model with a `.test.ts` beside it; no jsdom render tests.

## Review Focus

1. A manifest `files` entry that escapes `ARC_FINAL_OUT` (`..`, absolute path, drive letter) must be dropped at
   ingest, never stored or fetched. Test in Task 1.
2. A malformed or oversized (> 1 MiB) `shots.json` must not fail or change the stage; it falls back to the plain PNG
   listing and logs why. Test in Task 1.
3. The viewer's arrow keys must not also move the Jarvis surface's cursor or row selection underneath the modal,
   and Esc must close only the viewer, not the run sheet. Covered by Task 4's matchBinding test and Task 6's scenario.
4. A dag whose plan has no Final command shows no entry at all; a Final that wrote nothing shows the disabled
   "Screenshots · 0" state, not a hidden entry. Test in Task 3.
5. Switching rounds where the other round has fewer scenarios or shots must clamp the selection, not render an
   empty stage. Test in Task 3.

---

### Task 1: Engine — data-dir out dir, shots on the dag, rounds kept, sweep
**Depends on:** none

**Files:**
- Modify: `pkg/waveobj/wtype.go` (FinalStage, TaskGroup, new types)
- Modify: `pkg/orchestrate/final.go` (`finalOutDir`, ingest after `runFinalCommand`, `finalResult`, `recordFinalLocked`)
- Create: `pkg/orchestrate/finalshots.go` (manifest read, plain listing, sweep) + `pkg/orchestrate/finalshots_test.go`
- Modify: `pkg/orchestrate/round.go` (`AppendRound` keeps the finished round)
- Modify: `cmd/server/main-server.go` (`tempAttachmentCleanupLoop` also calls the sweep)
- Modify: `pkg/jarvis/plan.go` (PlanFormat's Final sentence names the optional `shots.json`)
- Modify: `docs/orchestrator-guide.md` (the Final step's `ARC_FINAL_OUT` location, the manifest contract, retention,
  and, in the "final-verify writes into ARC_FINAL_OUT" list, that this repo's final-verify writes `shots.json`). This
  task owns every guide edit of the plan, so Task 2 can run beside it.
- Regenerate: `task generate` (gotypes.d.ts etc.)

**Interfaces (produces):**
```go
// pkg/waveobj
type FinalShot struct {
	Name  string          `json:"name"`
	Files []string        `json:"files"`           // relative to FinalStage.OutDir, forward slashes
	Steps []FinalShotStep `json:"steps,omitempty"`
}
type FinalShotStep struct {
	Step   string `json:"step"`
	State  string `json:"state"` // pass | fail | skip
	Detail string `json:"detail,omitempty"`
}
// FinalStage gains:
	Shots         []FinalShot `json:"shots,omitempty"`
	ShotsManifest bool        `json:"shotsmanifest,omitempty"` // Shots came from shots.json (verdicts and steps); false is a plain PNG listing
// TaskGroup gains:
	PastFinals []FinalStage `json:"pastfinals,omitempty"` // finished earlier rounds, oldest first
```
TS (generated): `FinalShot`, `FinalShotStep`, `FinalStage.shots`, `FinalStage.shotsmanifest`, `TaskGroup.pastfinals`.

**Decisions:**
- `finalOutDir(dagID, round)` = `<wavebase.GetWaveDataDir()>/final-shots/<dagID>/<round>`, still `filepath.ToSlash`.
  The root is a package var (`finalShotsRoot func() string`) so tests point it at `t.TempDir()`.
- `readFinalShots(outDir string) ([]waveobj.FinalShot, bool)` runs in `runFinalSteps` right after the Final command
  returns (any exit, timeout included) and its result travels in `finalResult` to `recordFinalLocked`, which sets
  `f.Shots`/`f.ShotsManifest`. No Final command, or a stage that failed before it ran: no shots.
- Manifest validation: over 1 MiB, unparseable, or a `state` outside pass|fail|skip falls back to the plain listing
  and logs `dag <id>: reading shots.json: <why>`. A file path that is absolute, has a volume name, or cleans to
  something starting `..` is dropped (logged); a scenario left with no files keeps its steps.
- `AppendRound` appends the current `*g.Final` (finished: failed) to `g.PastFinals` before setting the new round.
- `SweepFinalShots(now time.Time)` removes `<root>/<dag>/<round>` dirs whose mtime is older than 30 days
  (`FinalShotsRetention = 30 * 24 * time.Hour`), then dag dirs left empty; errors are logged per dir, never stop
  the sweep. `tempAttachmentCleanupLoop` calls it.

**Acceptance (focused tests in `finalshots_test.go`):**
- [ ] `TestReadFinalShotsManifest` — a valid manifest is returned as-is with `manifest=true`.
- [ ] `TestReadFinalShotsPlainListing` — no manifest: nested PNGs become sorted one-file entries, `manifest=false`.
- [ ] `TestReadFinalShotsBadManifestFallsBack` — malformed JSON, > 1 MiB, and a bad state each fall back to the listing.
- [ ] `TestReadFinalShotsDropsEscapingPaths` — `../x.png`, `C:/x.png`, `/x.png` are dropped.
- [ ] `TestFinalStageRecordsShots` — a Final command that writes a manifest (and one that exits 1 after writing it)
  leaves `Final.Shots` set on the persisted dag; reuse the harness of `TestFinalExit3IsUnverifiedWithItsLastLine`.
- [ ] `TestAppendRoundKeepsThePastFinal` — after a failed round 1 and `AppendRound`, `PastFinals[0]` is round 1 with
  its shots and `Final.Round == 2`.
- [ ] `TestSweepFinalShotsDropsOldRounds` — a 31-day-old round dir goes, a 1-day-old one stays, an emptied dag dir goes.
- Run: `go test ./pkg/orchestrate -run 'TestReadFinalShots|TestFinalStageRecordsShots|TestAppendRoundKeepsThePastFinal|TestSweepFinalShots'`
  and the existing `go test ./pkg/orchestrate -run 'TestFinal'` still pass.

### Task 2: Scripts — verify.mjs groups shots and steps into shots.json
**Depends on:** none

**Files:**
- Modify: `scripts/cdp/report.mjs` (+ `scripts/cdp/report.test.mjs`, append with Edit, do not overwrite)
- Modify: `scripts/cdp/verify.mjs`
- Modify: `scripts/cdp/final-verify.mjs` (+ `scripts/cdp/final-verify.test.mjs` if its copy step is tested there)
- Do not edit `docs/orchestrator-guide.md`: Task 1 documents this task's `shots.json` too.

**Interfaces (produces):** `shotsManifest(results, shotsByScenario)` in `report.mjs` returns the manifest array of the
Global Constraints contract. `results` is verify.mjs's `[{ name, steps: [{ step, ok, skip?, detail? }], error? }]`;
`shotsByScenario` is `{ [name]: string[] }` of PNG paths relative to `cdp-shots/`.

**Decisions:**
- verify.mjs records `h.shots.length` before each scenario and assigns the shots taken until the next scenario (the
  goto shot first, then any taken inside assert/teardown) to it; writes `cdp-shots/shots.json` next to `index.html`.
- `state`: `skip` when `st.skip`, else `pass`/`fail` from `ok`. A scenario with `error` gets one extra step
  `{ step: "the scenario threw", state: "fail", detail: <error> }` after any steps it has.
- final-verify.mjs, after copying `cdp-shots` into `ARC_FINAL_OUT`, writes `<ARC_FINAL_OUT>/shots.json` with every
  file prefixed `cdp-shots/`. A missing `cdp-shots/shots.json` (verify never ran) writes nothing.
- Do not run prettier on `scripts/*.mjs` (AGENTS.md).

**Acceptance:**
- [ ] report.test.mjs: `shotsManifest` maps pass/fail/skip, keeps step order and details, adds the thrown step, and
  gives a scenario with no shots `files: []`.
- [ ] final-verify test (or a new focused test of the exported rewrite helper): paths gain the `cdp-shots/` prefix.
- Run: `npx vitest run scripts/cdp/report.test.mjs scripts/cdp/final-verify.test.mjs`

### Task 3: Frontend model — rounds, scenarios, tallies, entry state
**Depends on:** Task 1

**Files:**
- Create: `frontend/app/view/jarvis/finalshotsmodel.ts` + `frontend/app/view/jarvis/finalshotsmodel.test.ts`

**Interfaces (produces):**
```ts
export type ShotVerdict = "pass" | "fail" | "none"; // none: a plain listing entry
export type ShotScenario = { name: string; files: string[]; steps: FinalShotStep[]; verdict: ShotVerdict };
export type ShotRound = {
    round: number;
    state: string;              // the stage's state: passed | unverified | failed
    outDir: string;
    manifest: boolean;
    scenarios: ShotScenario[];  // failed first, then the rest, each group in manifest order
    shotCount: number;
};
export function shotRounds(group: TaskGroup | null): ShotRound[];           // finished rounds, oldest first
export function finalCheckEntry(group: TaskGroup | null): FinalCheckEntry | null;
export type FinalCheckEntry = {
    tone: "pass" | "fail" | "warn";  // dot: passed / failed / unverified
    head: string;                    // e.g. "unverified · 5 scenarios", "failed · jarvis-peek 2 steps", "passed · 3 screenshots", "unverified · no screenshots"
    right: string;                   // e.g. "16 shots · 2 rounds", "17 shots · round 1", "3 shots", ""
    dockLabel: string;               // "Screenshots · 16"
    dockAccent: boolean;             // latest round failed
    dockDisabled: boolean;           // no shots
    strip: { name: string; file: string; verdict: ShotVerdict }[]; // one per scenario of the latest round, its first file
    caption: string | null;          // "Round 1 failed on jarvis-peek steps 4 and 5." when an earlier round failed
    latestRound: number;
};
export function scenarioTally(s: ShotScenario): { short: string; long: string }; // "4/5", "1 failed, 4 of 5 passed, 1 skipped"
export function roundTally(r: ShotRound): string;                                // "40 of 42 steps passed, 4 skipped"
export function roundLabel(r: ShotRound): string;                                // "Round 1 failed"
export function shotPath(r: ShotRound, file: string): string;                   // outDir + "/" + file
export function clampSelection(r: ShotRound, s: number, k: number): { s: number; k: number };
```

**Decisions (from the boards):**
- Finished rounds = `pastfinals` + `final` when `final.state` is passed|unverified|failed. No entry when the dag has
  no `finalcmd`, no finished round, or `final.state` is checking|final|verifying.
- `head`: the latest round's state word; then one failed scenario → `<name> <n> step(s)`; several →
  `<k> scenarios failed`; else manifest → `<N> scenarios`; plain → `<N> screenshots`; no shots → `no screenshots`.
- `right`: no shots → `""`; a later round pending (final not terminal) → `<n> shots · round <r>`; more than one
  finished round → `<n> shots · <k> rounds`; else `<n> shots`.
- `caption` names the newest earlier failed round and its failing steps by 1-based index within each scenario
  ("jarvis-peek steps 4 and 5", scenarios joined with ", "); null when no earlier round failed.
- A scenario's verdict is fail when any step fails, pass otherwise; plain entries are `none`.

**Acceptance (finalshotsmodel.test.ts):**
- [ ] the four States-board rows produce exactly their head/right/dock text (failed during the fix round, passed,
  unverified with no screenshots and dock disabled, plain PNG listing).
- [ ] the Main-board data (round 1 failed on jarvis-peek 4 and 5, round 2 unverified) gives
  `"unverified · 5 scenarios"`, `"16 shots · 2 rounds"`, and the caption.
- [ ] no entry for a dag with no `finalcmd`, and none while `final.state` is `final`.
- [ ] failed scenarios sort first; tallies match the Viewer board's strings.
- [ ] `clampSelection` clamps scenario and shot indexes into the other round's bounds.
- Run: `npx vitest run frontend/app/view/jarvis/finalshotsmodel.test.ts`

### Task 4: Viewer modal
**Depends on:** Task 3

**Files:**
- Create: `frontend/app/view/jarvis/finalshotsviewer.tsx`
- Create: `frontend/app/view/jarvis/localimage.ts` (+ `localimage.test.ts` for its pure URL/status helper)
- Create: `frontend/app/view/jarvis/finalshotsstore.ts` (`finalShotsViewerOpenAtom`)
- Modify: `frontend/app/store/keybindings/bindings.ts` (`buildFinalShotsBindings`), `docs/keyboard-shortcuts.md`
- Modify: `frontend/app/store/keybindings/dispatcher.ts` (`deriveKeyContext` counts the viewer in `modalOpen`)
- Test: `frontend/app/store/keybindings/bindings.test.ts` (append with Edit, do not overwrite)

**Interfaces (produces):**
```ts
export function FinalShotsViewer(props: {
    group: TaskGroup;
    initial: { round: number; scenario?: string }; // round number; scenario by name, default the first
    onClose: () => void;
}): JSX.Element;
export function useLocalImage(path: string): { url: string | null; status: "loading" | "ok" | "missing" | "error"; width?: number; height?: number };
export function buildFinalShotsBindings(handlers: { scenario(d: 1 | -1): void; shot(d: 1 | -1): void; zoom(): void; steps(): void; close(): void }): Binding[];
```

**Decisions:**
- Layout, copy and sizes follow `Viewer.dc.html`: header (title, round segmented control, round tally, key hint,
  close), scenario tablist, shot toolbar (file, `k of n · W × H` from the loaded image's natural size, Fit/Actual
  size, Steps toggle), stage, filmstrip with the full path (right-aligned ellipsis), 360px steps drawer.
- The drawer opens by itself only on a scenario with a failing step until the human toggles it; picking a round or
  scenario resets the toggle; picking a round clamps via `clampSelection`.
- A plain-listing round has no Steps button, no drawer, no tallies; its tabs show the hollow dot (States board).
- `useLocalImage` fetches `getWebServerEndpoint() + "/wave/stream-local-file?path=" + encodeURIComponent(path)` with
  `fetch` from `@/util/fetchutil`, makes a blob URL, revokes it on change/unmount; 404 → `missing` (the States board
  "No longer on disk" block with the path), other failures → `error` with the status in the same block.
- A modal dialog (`role="dialog" aria-modal`), focus moves in on open and back to the opener on close; reuse the
  existing modal focus helper (`frontend/app/modals/modalfocus.ts`) rather than a new trap. Bindings are registered
  with `useKeybindings` in the viewer body only, and must win over the Jarvis surface's arrows/Esc while open.
- Why the plain registration is not enough: `matcher.ts` runs the first-registered active binding, and the Jarvis
  `list:next`/`list:prev` (ArrowUp/Down) are gated only on `!ctx.modalOpen`, so they would beat the viewer's later
  registration. And the run sheet is a `ModalShell` (`briefsheet.tsx`) whose window Escape listener closes it while it
  is top of `modalstack`. So:
  - `finalShotsViewerOpenAtom` (a jotai `atom(false)` in `finalshotsstore.ts`) is set true while the viewer is mounted;
    `deriveKeyContext` ORs it into `modalOpen` (beside `petPeekOpenAtom`), which silences every surface binding.
  - Each `buildFinalShotsBindings` binding is gated `when: () => globalStore.get(finalShotsViewerOpenAtom)`, not on
    `modalOpen` being false.
  - The viewer calls `registerModal("final-shots-viewer")` (`frontend/app/modals/modalstack.ts`) in an effect while
    open, so it is top of the stack and the sheet's shell yields Escape; Esc closes only the viewer.
- With one finished round the header shows the round as a plain dot + label; the segmented control renders from two
  rounds on (Global Constraints).

**Acceptance:**
- [ ] `localimage.test.ts`: the URL builder encodes Windows paths; the status mapper maps 200/404/500.
- [ ] `bindings.test.ts` asserts `buildFinalShotsBindings` covers ArrowUp/Down/
  Left/Right, z, s and Escape and calls the matching handler.
- [ ] `bindings.test.ts`: with `finalShotsViewerOpenAtom` true and the Jarvis bindings registered first,
  `matchBinding` (`matcher.ts`) on a `deriveKeyContext()` context picks the final-shots binding for ArrowUp, ArrowDown
  and Escape, not the Jarvis one; with the atom false, the final-shots bindings are inactive.
- [ ] `docs/keyboard-shortcuts.md` lists the viewer's keys.
- Run: `npx vitest run frontend/app/view/jarvis/localimage.test.ts frontend/app/store/keybindings/bindings.test.ts`

### Task 5: Run sheet entry — Final check row and Screenshots dock button
**Depends on:** Task 4

**Files:**
- Modify: `frontend/app/view/jarvis/runsheet.tsx` (a `FinalCheckRow` section after `RunTimingSection`; the `Dock`
  button; the viewer's open state)
- Modify: `frontend/app/view/jarvis/runsheetmodel.ts` only if the entry needs data the sheet read lacks

**Decisions:**
- Row (`data-run-sheet-final-shots`), collapsed by default, 44px, as `Main.dc.html`/`States.dc.html`: chevron,
  "Final check", tone dot + `head`, `right`. Expanded: a 5-column grid of the latest round's `strip` thumbnails
  (each opens the viewer on that scenario) and the `caption` with an "Open the viewer" link. Thumbnails load through
  `useLocalImage`.
- Dock button (`data-run-sheet-final-shots-dock`) between "Open DAG" and "Open lead": tone dot + `dockLabel`, accent
  border when `dockAccent`, disabled when `dockDisabled`. It opens the viewer on the latest round.
- Row expansion is surface-local state (losing it on a surface switch is acceptable); the viewer open state lives in
  the sheet component and the viewer renders over the sheet.

**Acceptance:**
- [ ] `task check:ts` clean; `npx vitest run frontend/app/view/jarvis/finalshotsmodel.test.ts` still passes.
- [ ] The rendered states are proven by Task 6's scenario.

### Task 6: `final-shots` CDP scenario
**Depends on:** Task 5

**Files:**
- Modify: `scripts/cdp/scenarios.mjs` (a `final-shots` scenario, registered in `SCENARIOS`)

**Decisions:**
- Arrange with `arrangeSheetDagRun`, then rewrite the dag through `object.UpdateObject` over `/wave/service`
  (see memory: needs the shell origin and `x-authkey`): set `finalcmd`, a round-1 failed `pastfinals` entry and a
  round-2 unverified `final`, both with manifest shots modelled on the Viewer board's data, `outdir` pointing at
  temp dirs filled with PNGs the scenario captures from the app itself (`h.shot`). Leave one file missing on disk.
  Re-seed the same dag between steps for the other States-board rows. Keep the dag non-finalizing so the engine
  tick ignores it.
- Each step below takes its own `h.shot` so the final verifier sees every board state. Scope DOM queries to
  `[data-run-sheet]` / the dialog (memory: unscoped button queries hit the app bar).

**Steps (each a named assertion with a screenshot):**
1. the row is collapsed with `unverified · 5 scenarios` and `16 shots · 2 rounds`; the dock button reads `Screenshots · 16` (Main, closed).
2. the opened row shows one thumbnail per scenario and the round-1 caption (Main, opened).
3. the dock button opens the viewer on round 2; the scenario tabs, shot, filmstrip and path render; the drawer is closed on a passing scenario (Viewer).
4. switching to round 1 puts jarvis-peek first with the drawer open on its failing steps (Viewer).
5. ArrowRight moves the filmstrip selection, `z` toggles Actual size, `s` toggles the drawer, and the Jarvis surface's selection did not move (Viewer).
6. the missing file shows "No longer on disk" with its path (States).
7. re-seeded as failed during the fix round: `failed · jarvis-peek 2 steps`, `17 shots · round 1`, accent dock (States).
8. re-seeded as passed, as unverified with no shots (dock disabled), and as a plain PNG listing (`passed · 3 screenshots`, hollow-dot entries in the viewer, no Steps button) (States).
9. Esc closes the viewer and leaves the run sheet open.

**Acceptance:**
- [ ] `task verify:ui -- final-shots` passes against a dev app built from this branch; teardown removes the channel,
  run and temp dirs.
