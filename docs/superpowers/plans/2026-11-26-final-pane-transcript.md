# Final stage pane in the transcript look, and Tests cards for Arc's runners

**Verify:** `node scripts/verify.mjs ./pkg/waveobj`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs final-stage`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\final-pane-transcript\project

Boards: **Main** (failed at Final, Verify and Final opened as Tests cards, raw toggle), **Running** (Verify
running, opened on its live tail), **Round2** (round 2, Check held at the memory gate, round 1 below opened to its
detail). The boards' log lines are illustrative; parse the real formats named below.

Decisions beyond the design, with why:

1. **The CDP summary is `P/R steps passed[, S skipped]`**, what `scripts/cdp/report.mjs` `formatResults` prints.
   "N of M steps failed" appears in no real output (only the `FST_DETAIL` fixture), so counts come from the step
   lines and both summary forms are accepted only as lines that end a FAIL's message. A `PASS` line's detail
   (formatResults prints details for passes too) is ignored; `SKIP` counts as skipped; `  ERROR: <msg>` under a
   header is a failure named `the scenario threw` (shotsManifest's name) with the message as its message.
2. **`isTestCommand` also matches `scripts/cdp/verify.mjs`**, which is what `task verify:ui` runs and prints the same
   format; both path separators match, since agents on Windows type either.
3. **Reuse, not copy:** `toolrenderers.tsx` exports `TestCard`; `steprows.tsx` exports the `data-tool-panel`
   container StepBody draws (with its `data-tool-error` block) as `ToolPanel`, and StepBody uses it. The pane draws
   the Bash panel as `ToolPanel` + `ToolDetailBody` (bash detail, `capped`). The card gate is the transcript's:
   `isTestCommand(step.command)` and `parseTestOutput(output)` non-null, so Check (tsc) never becomes a card.
4. **The running tail** is `ToolPanel` + an uncapped `ToolDetailBody` in a bounded scroller that keeps the newest
   lines in view on each publish (as today), then the "output tail · the engine publishes it every 10s" note. When
   the step ends, its open body trades the tail for the kept output (ViewSwap).
5. **Marks:** passed → StatusSquare ok; failed → StatusSquare X; running → LoaderCircle in a 16px slot; waiting,
   not run, stopped, unverified → StatusSquare pending. The right side is the time for passed / failed / running,
   else the state word: muted for waiting / not run, warning for stopped / unverified (the transcript's
   statusWordTone: a stop warns). The label is ink-mid for waiting / not run only.
6. **Open state:** a step opens by default when it is the running command with output or the failed step with kept
   output. A click on a row records the human's choice for that key, which wins over the default until the round
   changes. So a running step that passes closes unless the human opened it, and one that fails stays open.
7. **Exit chip:** the stage keeps no exit code per step; the chip reads `exit N` from the detail's first line
   (`... failed (exit N):`, pkg/orchestrate/final.go), else `failed`: the transcript's own fallback.
8. **Failure detail placement:** in the failed command step's panel, as its red error block on top, when that step
   kept output that does not parse into a card; hidden when it does (the card's failures say it); otherwise (End
   review or Verifier failed, a human ended the stage, no command failed) above the box in the same red block,
   the prototype's `detailAbove` variant. While the kept output loads, the body shows its loading line only.
9. **Earlier rounds:** `FinalRoundLine` gains `outcome` (the round's outcome alone, e.g. `failed at Final`); `text`
   stays for the rail, which is unchanged. The pane's line: StatusSquare by tone, `Round N`, the mono outcome, a
   `screenshots` link opening the viewer at that round, a chevron when it has a detail, which opens beneath it in
   the red block.
10. **Motion** (docs/reference/motion-system.md): a row's mark slot cross-fades as its state moves (CrossFade,
    micro); a row's body opens and closes with PaneReveal (6b); an ended step's body trades tail for kept output
    with ViewSwap; the earlier-rounds list follows its height with AutoHeight (15); the failed note keeps its fade,
    or errorNudge (13) when it answers the human's rerun. The pane drops DrawCheck (StatusSquare draws its own
    check) and the body-view fade (there is one body now), so the note no longer has a hidden-behind-kept case.
11. **Final runs final-stage only**, as the goal pins. motion-final and agent-tree-rail L9 are updated by Task 4,
    whose worker runs them. No transcript scenario step is added for a final-verify Bash call: the transcript draws
    the same `TestCard` through `bashCard`, the matcher is unit-tested, and final-stage shows a final-verify card.
12. **Deleted:** `FinalStepCells` (the pane was its only caller), `shownStep` and its tests (the open state
    replaces it). `FinalOutput`, `FinalStepList`, `FinalKeptOutput`, `FinalOutcome`, `FinalPastRounds` stay for the
    DAG peek and the rail.

### Task 1: Tests card for Arc's own runners
**Depends on:** none
**Files:** `frontend/app/view/agents/testoutput.ts`, `frontend/app/view/agents/testoutput.test.ts`, `frontend/app/view/agents/renderregistry.ts`, `frontend/app/view/agents/renderregistry.test.ts`, `frontend/app/view/agents/toolrenderers.tsx`

`parseTestOutput` recognizes the CDP scenario format (decision 1): `# <scenario>` headers, `  PASS  ` / `  FAIL  ` /
`  SKIP  ` step lines, a FAIL's following lines indented past its step line as its message. It must not claim go
test output (a go build error prints `# pkg/x`) nor vitest's. `isTestCommand` matches `scripts/verify.mjs`,
`scripts/cdp/final-verify.mjs`, `scripts/cdp/verify.mjs` and `task verify:ui`, and still not `npm run lint` or
`go build`. The card header names the runner.

**Interfaces:** `TestSummary.runner` is `"go" | "vitest" | "final-verify"`; a final-verify failure is
`{ pkg: <scenario>, test: <step text>, message }`; `failureLabel("final-verify", f)` is
`{ name: f.test, where: f.pkg, whereFull: f.pkg }`. `export function TestCard({ summary, output, collapsed })` from
`toolrenderers.tsx`, its runner label `go test` / `vitest` / `final-verify`.

**Acceptance:**
- the real formatResults output of two scenarios with one FAIL carrying a JSON detail line, one SKIP, PASS lines with
  details and the trailing `final-verify timing:` line parses to runner `final-verify`, unit `test`, the step counts,
  and one failure whose where is its scenario and whose message is the detail
- a scenario that threw (`  ERROR: <msg>`) is a failure named `the scenario threw`
- go build output starting `# pkg/x` still parses as go; cases join the existing tables in `testoutput.test.ts` and
  `renderregistry.test.ts`
- shown in final-stage B5 (Task 3): the Final row's card reads `final-verify` with its failures

### Task 2: Final stage pane model
**Depends on:** none
**Files:** `frontend/app/view/agents/finalstage.ts`, `frontend/app/view/agents/finalstage.test.ts`

The pure decisions the pane draws from (decisions 5 to 9), beside the existing `finalStageView`. `shownStep` stays
until Task 3 removes its last caller.

**Interfaces:**
```ts
// FinalRoundLine gains: outcome: string  (e.g. "failed at Final"; text keeps "round N · <outcome>")
export type FinalKept = { status: LocalImageStatus; text: string };
export const KEPT_NOTE: Record<LocalImageStatus, string>; // ok: "the step printed nothing"; the other three as finalstageviews' KEPT_EMPTY
export type FinalStepBody =
    | { kind: "tail"; command: string; output: string }
    | { kind: "card"; summary: TestSummary; output: string }
    | { kind: "panel"; command: string; output: string; error?: string; note?: string };
export function finalStepBody(view: FinalStageView, step: FinalStep, kept: FinalKept): FinalStepBody;
export function finalStepOpensByDefault(view: FinalStageView, step: FinalStep): boolean;
export function finalStepExit(view: FinalStageView, step: FinalStep): string; // chip text: "exit 1" | "failed"
export function finalDetailAbove(view: FinalStageView): boolean;
```

**Acceptance:**
- a running command's body is its tail of `view.output`, never a card, even when that output parses as tests
- a failed Verify (its command `go test ./...` in the fixture: Task 1's wider matcher lands beside this task) whose
  kept go test output parses is a card with no error; a failed Check (tsc) is a panel with
  `view.detail` as its error; an empty ok kept output is a panel noting `the step printed nothing`; a loading one
  notes its loading line and carries no error
- `finalDetailAbove` is true for a stage failed at the Verifier or End review and false for one failed at a command
  that kept output
- `finalStepOpensByDefault` is true for the running command with output and the failed step with kept output,
  false for passed, waiting and not-run steps
- `finalStepExit` reads `exit 1` from `Final \`...\` failed (exit 1):` and `failed` from a detail with no code
- each past round carries `outcome` without its `round N`

### Task 3: Final stage pane in the transcript look
**Depends on:** Task 1 (uses the exported TestCard and the final-verify parse), Task 2
**Files:** `frontend/app/view/agents/finalstagepane.tsx`, `frontend/app/view/agents/finalstageviews.tsx`, `frontend/app/view/agents/steprows.tsx`, `frontend/app/view/agents/finalstage.ts`, `frontend/app/view/agents/finalstage.test.ts`, `scripts/cdp/scenarios-final.mjs`, `scripts/cdp/scenarios-shared.mjs`

The pane per the goal and the prototype: header unchanged; the body in `TRANSCRIPT_COLUMN` inside a `px-6 py-[18px]`
scroller; one bordered box of step rows in StepBox / StepRow's look (rounded-10, divide-edge-faint, px-3.5 py-2.5,
13.5px secondary label, 12px mono muted command or the warning hold text, 11px mono time, TurnChevron), several open
at once; bodies from `finalStepBody`; the detail above the box per `finalDetailAbove`; earlier rounds, unverified
reasons, the failed note and the Screenshots link below. The Verifier row focuses the verifier session when
`verifierStepTarget` finds one. Remove `FinalStepCells` and `shownStep` with its tests. Hooks kept for the
scenarios: `data-final-pane`, `data-final-headline`, `data-final-step` + `data-final-step-state` on each row (its
head button carries `aria-expanded` when it opens), `data-final-step-memory`, `data-final-step-body="<key>"` on an
opened body, `data-final-past-round`, `data-final-past-round-shots`, `data-final-past-round-detail`,
`data-final-note`, `data-final-shots-link`, `data-final-end`, `data-final-rerun`.

**Acceptance** (final-stage scenario, its readers moved to the new DOM, the rail's and DAG peek's unchanged):
- Main board, B5 (writes `final.txt` in the real CDP format and `verify.txt` in scripts/verify.mjs's go output to the
  round's kept-steps dir, as B5b writes `check.txt`): the Final row is open by default as a `final-verify` Tests card
  with its failures and `where` its scenario, its row has the X square and the `exit 1` chip, no red detail block
  shows; a click on Verify opens it beside as a `go test` card; raw on Final shows the output; Verifier reads
  `not run` in ink-mid
- B5b: Check's kept output opens in place as a Bash panel and a second click closes it; an empty kept output reads
  `the step printed nothing`
- B3d: the End review failure shows its detail as the red block above the box
- Running board, A4: Verify running shows the spinner and opens on its live tail with the
  `output tail · the engine publishes it every 10s` note, no card
- Round2 board: a round-2 stage with Check held at the memory gate shows the hold text in warning where its command
  reads, and the `Round 1` line opens to its detail (add the step if B3b / B6 do not show both)
- P11: the Verifier row of a passed stage opens the verifier's ended transcript
- `npx vitest run frontend/app/view/agents` and Check pass

### Task 4: Motion and layout scenarios on the new pane
**Depends on:** Task 3 (uses the pane DOM and hooks it builds)
**Files:** `scripts/cdp/scenarios-motion-final.mjs`, `scripts/cdp/scenarios-agent.mjs`

Move motion-final's pane steps and agent-tree-rail L9 to the new DOM (decision 10).

**Acceptance:**
- motion-final step 2: a step passing on screen cross-fades its mark slot to the check square
- motion-final step 5: a pane row's body reveals with PaneReveal and closing collapses it; the rail's part unchanged
- motion-final step 6c is deleted (no body swap left to hide the note behind); steps 4 and 6 still pass
- agent-tree-rail L9: at 1000x700 the pane's step box has no horizontal overflow, no row clips, and the headline
  keeps `failed at Final`
- `ARC_FINAL_OUT=<tmp dir> node scripts/cdp/final-verify.mjs motion-final agent-tree-rail` passes; if the dev app
  crashes with STATUS_HEAP_CORRUPTION, report it rather than loop
