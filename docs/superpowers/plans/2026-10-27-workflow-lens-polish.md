# Workflow lens polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Verify:** `node scripts/verify.mjs ./pkg/workflowscan`
**Check:** `task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs workflow-scan`
**Prototype:** C:\Users\kael02\AppData\Local\arc-wt\48f63f64\.superpowers\design\workflow-lens-polish\project\Main.dc.html

**Goal:** Usage > Workflow stops reading as a stranded debug panel. Every state after a scan starts gets the same head row, and the in-progress and finished states put a stage column beside a pane that says what the scan is doing or did.

**Architecture:** `workflowlens.ts` (pure model) gains per-stage detail, the verdict and pick facts, and the stage list for done and nothing. `workflowlensview.tsx` draws the approved boards from it. The `workflow-scan` CDP scenario seeds each board's state and asserts it. No Go, RPC or record change: everything shown is already on the run and its `WorkflowScan`.

**Tech Stack:** React 19, jotai, Tailwind 4 `@theme` tokens, lucide-react, vitest, the CDP scenario harness.

**Design:** the approved canvas on the Prototype line is the spec. Its boards: `Main.dc.html` (scanning, Opus checks files), `ScanningEarly.dc.html` (scanning, Sonnet patterns), `Applying.dc.html`, `Done.dc.html`, `Nothing.dc.html`, `Idle.dc.html` (idle after a failed scan). The earlier approved canvas (`workflow-scan` Main/States, in the main checkout's `.superpowers/design/workflow-scan/project/`) settled the content of the cards and states. This plan keeps that content and changes only what the decisions below name.

## Global Constraints

Approved decisions, beyond what the boards show:

- Layout is full width inside the lens's existing `px-7` gutters. Scanning, applying, done and nothing to suggest use a two-column grid: a 380px stage column, then a `minmax(0,1fr)` detail pane, with a 16px gap (`lg:grid-cols-[380px_minmax(0,1fr)]`). Below `lg` the two stack, stage column first. Picking keeps the approved full-width cards and has no stage column. Idle keeps its full-width empty-state panel (its content is unchanged).
- Every non-idle state shows the head row (`Scan of MM-DD`, the window span, a status, `Open run`). Scanning shows no head row today, so this adds one. While the scan is scanning at stage `read`, the span is only the date range, with no run or project counts.
- Head status:
  - scanning: the cockpit's working dot (`StatusDot state="working" pulse` from `./statusdot`), then `scanning · <elapsed>`.
  - applying: the same dot, then `applying your picks`.
  - picking: unchanged (`N to decide`, warning).
  - done and nothing: a lucide `Check` in `text-success`, then `done`.
  - This replaces the green `scanning` label.
- Stage marks:
  - done: a lucide `Check`, size 14, strokeWidth 2.4, `text-success`.
  - now: the pulsing working `StatusDot`.
  - todo: a hollow 9px ring, `border-[1.5px] border-ink-faint`.
  - A 1px vertical line joins each mark to the next: `bg-edge-strong` below a done row, `bg-border` otherwise, and none after the last row.
  - Labels are 13.5px: `font-semibold text-primary` on the now row, `font-medium text-primary` on done rows, `text-muted` on todo rows. The fact sits right-aligned in `font-mono text-[11px] text-ink-mid`.
  - These replace the `✓ ● ○` text glyphs.
- Elapsed time is `fmtDuration(now - run.createdts)` from `./runcompletion` (`31s`, `4m 12s`). Reuse it, don't write a new formatter. The ScanningEarly board's `0m 31s` is intentionally drawn as `31s`, matching the cockpit's other clocks. It ticks every second, only while the view is `scanning`. There is no time estimate and there are no per-stage times.
- Stage facts, shown on a row once it is done (the read row's fact is unchanged: `N runs · N projects[ · N cut for size]`):
  - Sonnet patterns: `N named`.
  - Recount: `N kept`, plus ` · N under 3 runs` when `underfloor` is non-empty.
  - Opus checks files: `N suggested · N covered · N declined`, counted from `verdicts`, with zero parts left out (`3 suggested · 2 covered`).
  - Your picks: `N applied · N declined` from `picks`, zero parts left out, or `none to pick` when there are no picks.
- Stage phases:
  - scanning: unchanged.
  - applying: the first four rows done, `Your picks` now. Today all five are done, so this changes.
  - done and nothing: all five rows done.
- The detail pane title and body, per scanning stage. The copy is exact, with numbers from the record:
  - read: `Reading run records` / `Every project's runs from MM-DD to MM-DD.`
  - patterns: `Sonnet reads N runs from N projects` / `It names the problems that recur in them. Code then recounts each one against the run records and sets aside any seen in fewer than 3 runs.`
  - recount: `Recounting N patterns` / `Code counts each one against the run records and sets aside any seen in fewer than 3 runs.`
  - checking: `Opus checks N patterns against the files` / `The scan's agent reads each pattern's fix target and docs/deferred.md, marks it covered, declined or a suggestion, and drafts the fix. Your picks open here when it is done.`
  - Under the checking body comes one row per kept pattern (survivors): its title, then `<b>N</b> runs · N days · <where>` in mono. `<where>` is `#name` for one project and `N projects` for more. A line `N under 3 runs set aside` follows the rows when `underfloor` is non-empty.
- Applying pane: title `Opus applies your picks`, body `<sent> sent. The scan's agent edits the files, writes each Declined entry to docs/deferred.md and commits. The commit shows here when it is done.`, where `<sent>` is `ctaLabel` over the stored picks (`Apply 2, decline 1`). The delivery error (`SendError`) moves into this pane. The applying footer is removed. Picking's footer (`PicksBar`) stays as it is. The read-only cards still follow below the split, full width.
- Done pane: the approved Done content (Committed, the short commit, Open in Diff, one tagged row per pick), now in the detail pane.
- Nothing pane: the check, `Nothing to suggest` and its facts line on one row. Below a `border-edge-faint` divider comes a sentence-case `Not raised` heading (13px semibold `text-secondary`), then the tagged rows. This is one pane. It replaces the two panels and the uppercase eyebrow.
- Colors only from `@theme` utilities. Add no new tokens. Keep visible text at 10.5px or larger (`MIN_FONT_PX`).

## Review Focus

- A scan at stage `read` has `runs` 0 and `projects` 0. The head span must not read `0 runs · 0 projects`, and the read pane must not either. Task 1 pins this with a test.
- A survivor with an empty `projects` list. `<where>` must not render `0 projects` or a bare `#`: leave the part out. Task 1 pins this with a test.
- Verdicts that name an id with no survivor are already dropped by `verdictsOf`. The Opus fact must count through the same filter, so a stray verdict is not counted. Task 1 pins this with a test.
- The elapsed clock must tick while scanning and be gone once the view leaves `scanning`, with no interval left running after a state change or an unmount. Task 2's steps 2 (ticks), 3, 6 and 7 (absent) pin this in Final.
- A scan that was cancelled or failed mid-scan still maps to idle, as today. The new head and stage column must never show for it. The existing `workflowView` tests pin the mapping, and Task 2's steps 9 and 10 assert that no head row or stage row renders.

---

### Task 1: Lens model and view, drawn to the approved boards
**Depends on:** none
**Files:** `frontend/app/view/agents/workflowlens.ts`, `frontend/app/view/agents/workflowlens.test.ts`, `frontend/app/view/agents/workflowlensview.tsx`

**Interfaces (produces):** the scenario task relies only on these DOM attributes. Keep every existing `data-workflow-*` attribute, and add:
- `data-workflow-head` on the head row, in every non-idle state, scanning included.
- `data-workflow-status="<view kind>"` on the head status element.
- `data-workflow-elapsed` on the elapsed text, while scanning.
- `data-workflow-stage="<label>"` and `data-phase` on each stage row (unchanged), plus `data-workflow-stage-fact` on each row's fact span.
- `data-workflow-detail="<read|patterns|recount|checking|applying|done|nothing>"` on the detail pane.
- `data-workflow-kept="<pattern id>"` on each kept-pattern row in the checking pane.
- `data-workflow-send-error` (unchanged), now rendered inside `[data-workflow-detail="applying"]` while applying.

**Model (`workflowlens.ts`):**
```ts
export interface KeptRow { id: string; title: string; runs: number; days: number; where: string }
export type StageDetail =
    | { stage: "read"; from: string; to: string }               // mmdd
    | { stage: "patterns"; runs: number; projects: number }
    | { stage: "recount"; candidates: number }
    | { stage: "checking"; kept: KeptRow[]; underFloor: number };
// WorkflowView members that change (the others are unchanged):
//   { kind: "scanning"; stages: StageRow[]; detail: StageDetail; startedTs: number }   // startedTs = run.createdts
//   { kind: "applying"; stages: StageRow[]; cards: WorkflowCard[]; sent: string }
//   { kind: "done"; commit?: string; rows: DoneRow[]; stages: StageRow[] }
//   { kind: "nothing"; covered: FiledRow[]; declined: FiledRow[]; underFloor: FiledRow[]; stages: StageRow[] }
```
`scanHead` leaves the counts out of `span` while the scan is scanning at stage `read`. The stage facts, the phases and the `where` rule are as given under Global Constraints.

- [ ] **Step 1: Write the failing tests** in `workflowlens.test.ts`, using the file's existing `run`/`scan`/`pattern` helpers:
  - `stage facts`:
    - checking: `["47 runs · 4 projects", "7 named", "3 kept", "", ""]` (fixture scan with `underfloor: []`).
    - With two underfloor patterns, the recount fact is `"3 kept · 2 under 3 runs"`.
  - `applying phases`: `["done","done","done","done","now"]`. This replaces today's all-done test. The Opus fact counts verdicts with zero parts left out (`"3 suggested · 2 covered"`), and a verdict whose id has no survivor is not counted.
  - `done and nothing stages`: all five rows done.
    - Done's picks fact for two applies and a drop is `"2 applied · 1 declined"`.
    - Nothing's picks fact is `"none to pick"`.
  - `scanning detail`:
    - read: `{ stage: "read", from: "10-12", to: "10-26" }`.
    - patterns: `{ stage: "patterns", runs: 47, projects: 4 }`.
    - recount: `{ stage: "recount", candidates: 7 }`.
    - checking: `kept` has one row per survivor, `where` is `"#waveterm"` for one project, `"3 projects"` for three, and `""` for none, and `underFloor` is the count.
    - `startedTs === run.createdts`.
  - `applying sent`: picks of two applies and a drop give `sent === "Apply 2, decline 1"`.
  - `scanHead at read`: span `"10-12 → 10-26"`, with no counts. At patterns it is unchanged (`"10-12 → 10-26 · 47 runs · 4 projects"`).
- [ ] **Step 2: Run** `npx vitest run frontend/app/view/agents/workflowlens.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement the model** in `workflowlens.ts`. Facts are built from the same `verdictsOf` and `count` helpers. `sent` reuses `ctaLabel(cards, storedPicks(scan))`.
- [ ] **Step 4: Run the tests again.** Expected: PASS, the existing tests included. Update only the ones whose expectations this plan changes:
  - `has every row done while the agent applies the picks` (now ends in `now`).
  - `shows a row's count once it is done` (`"7"` → `"7 named"`, and the recount fact gains ` · N under 3 runs` if its fixture keeps underfloor patterns).
  - `is done with one row per pick` and `is nothing-to-suggest`, whose `toEqual` gains `stages`.
- [ ] **Step 5: Draw the view** in `workflowlensview.tsx` to the boards and Global Constraints:
  - A `Split` (stage column + detail pane) for scanning, applying, done and nothing.
  - A `StageList` with the new marks and connector.
  - A `Detail` per `StageDetail`.
  - The head row in scanning.
  - The applying footer removed, with `SendError` in the applying pane.
  - Done and Nothing moved into the pane.
  - Remove the old `Stages` and the local `StatusDot`/`Check` once nothing uses them. Picking's `N to decide` keeps its warning look.
  - The elapsed clock is a 1s `setInterval` in a small component that only mounts while scanning, and it clears on unmount.

  Acceptance, runnable in this task's tree:
  - `npx vitest run frontend/app/view/agents/workflowlens.test.ts` exits 0.
  - `task check:ts` exits 0.
  - Every attribute in the Interfaces block is rendered where it says. Final proves the drawn views with Task 2's `workflow-scan` steps: 2 (Main, and the clock ticks), 2a (ScanningEarly), 2b (read head), 2c (recount pane), 3 (picking head, no clock), 6 (Applying), 7 (Done), 8 (Nothing), 9 and 10 (Idle, no head or stages).
- [ ] **Step 6: Commit** `feat(usage): polish the Workflow lens states` with the three files.

### Task 2: workflow-scan scenario steps for every board
**Depends on:** none
**Files:** `scripts/cdp/scenarios.mjs`

The scenario seeds records and reads only the DOM attributes in Task 1's Interfaces block, so it runs beside Task 1. Edit only the `workflow-scan` scenario (`const workflowScan`, around line 27210) and its `wfs*` helpers. Keep step numbers, names and shots for the steps not listed below. Every new or changed step shoots `cdp-shots/workflow-scan-<name>.png` and records pass or fail with its evidence, as the other steps do.

- [ ] **Step 1: Change step 2** (recount) to seed `stage: "checking"` instead. Shot `scanning`. Board: Main.
  - Keep the fixture survivors p1..p5 and `verdicts: []`. Drop the `survivors: []` / `kept: 0` override, and set `kept: 5`.
  - Assert the phases are `["done","done","done","now","todo"]`, with stage 3 labelled `Opus checks files`.
  - Assert `[data-workflow-head]` is present, and `[data-workflow-status="scanning"]` is present.
  - The clock ticks: read the `[data-workflow-elapsed]` text, assert it matches `/^\d+s$|^\d+m \d{2}s$/`, wait about 2.2s, then read it again and assert it changed.
  - Assert `[data-workflow-detail="checking"]` holds 5 `[data-workflow-kept]` rows. Row `p1` includes `#verify-workflow-scan`, row `p2` includes `3 projects`, and the pane text includes `2 under 3 runs set aside` (the fixture's u1 and u2).
  - Assert the fact on the `Sonnet patterns` row is `7 named`, and the header Scan button is disabled.
- [ ] **Step 2: Add step 2a**, scanning at `stage: "patterns"`. Shot `scanning-early`. Board: ScanningEarly.
  - Assert the phases are `["done","now","todo","todo","todo"]`.
  - Assert `[data-workflow-detail="patterns"]` text includes `Sonnet reads 47 runs from 4 projects`.
- [ ] **Step 3: Add step 2b**, scanning at `stage: "read"` with `runs: 0, projects: 0`. Shot `scanning-read`.
  - Assert the `[data-workflow-head]` text has no `runs`, and `[data-workflow-detail="read"]` is present.
- [ ] **Step 4: Add step 2c**, scanning at `stage: "recount"` (the fixture's `candidates: 7`). Shot `scanning-recount`.
  - Assert the phases are `["done","done","now","todo","todo"]`.
  - Assert `[data-workflow-detail="recount"]` text includes `Recounting 7 patterns`.
- [ ] **Step 5: Extend step 3** (picking).
  - Assert `[data-workflow-head]` is present, `[data-workflow-status="picking"]` text includes `3 to decide`, and `[data-workflow-elapsed]` is absent.
- [ ] **Step 6: Extend step 6** (applying). Board: Applying.
  - Assert `[data-workflow-detail="applying"]` contains `[data-workflow-send-error]` and the text `Apply 1, decline 1 sent`.
  - Assert the stage phases end in `now`, `[data-workflow-status="applying"]` text includes `applying your picks`, and `[data-workflow-elapsed]` is absent.
- [ ] **Step 7: Extend step 7** (done). Board: Done.
  - Assert all five phases are `done`.
  - Assert the `Opus checks files` fact is `3 suggested · 2 covered`, and the `Your picks` fact is `2 applied · 1 declined`.
  - Assert `[data-workflow-detail="done"]` contains `[data-workflow-commit]`, `[data-workflow-status="done"]` text includes `done`, and `[data-workflow-elapsed]` is absent.
- [ ] **Step 8: Extend step 8** (nothing). Board: Nothing.
  - Assert `[data-workflow-detail="nothing"]` contains every `[data-workflow-filed]` row and the text `Not raised`.
  - Assert the `Your picks` fact is `none to pick`, and `[data-workflow-status="nothing"]` text includes `done`.
- [ ] **Step 9: Extend steps 9 and 10** (cancelled and failed, board Idle). Assert that `[data-workflow-head]` and `[data-workflow-stage]` both count 0. Change nothing else in them.
- [ ] **Step 10: Check the file** with `node --check scripts/cdp/scenarios.mjs`. Expected: exit 0. This task's tree lacks Task 1's view, so the new assertions are proven only by Final's `node scripts/cdp/final-verify.mjs workflow-scan` on the merged result.
- [ ] **Step 11: Commit** `test(cdp): workflow-scan steps for each polished lens state` with `scripts/cdp/scenarios.mjs`.
