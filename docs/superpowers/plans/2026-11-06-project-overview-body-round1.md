# Project Overview body: round 1 fixes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement your task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Effort:** effort:64c2895d-bb17-436f-9d68-115d0c0e5dd1
**Verify:** `node scripts/verify.mjs ./pkg/waveobj ./pkg/wshrpc/... ./cmd/wsh/cmd`
**Check:** `task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs project-overview`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\project-overview\project\Main.dc.html

**Goal:** Fix two defects in the History region that Final round 1 found: a cancelled run with no dag reads "run · cancelled · cancelled", and an ended run's row lands on no card.

**Architecture:** One task in the History region's pure model (`frontend/app/view/agents/projecthistorymodel.ts`), its thin view (`projecthistory.tsx`) and its CDP scenario module (`scripts/cdp/project-overview-history.mjs`). Read the main plan `docs/superpowers/plans/2026-11-06-project-overview-body.md` (decisions 8 and 12) for context.

**Tech Stack:** React 19, jotai, vitest; CDP scenario harness in `scripts/cdp/`.

## Decisions, and why

1. **A run with no dag does not repeat the status that its warn already names.** When `runWarn` returns `" · cancelled"`, `runItem`'s no-dag `line` is `""`, and the row reads `run · cancelled`. A cancelled run has no dag when it was cancelled before DagSubmit, so this happens in real data. Every other no-dag line is unchanged: `merged` when landed, otherwise `run.status`. A `done` run with a held land still reads `run · done · land held`. A cancelled run whose Final failed reads `run · cancelled · Final failed`, because the warn names Final, not the cancel. The view writes the `" · "` before `line` only when `line` is non-empty. The warn keeps its own leading `" · "`.
2. **A History run row opens the run's Cockpit card only when the Cockpit has one; otherwise it opens the run's sheet on the Hub.** The Cockpit has a card for a run only while the run is in the lineage (`lineage.runs[runId]`, meaning a member is still in the roster); see `buildGridCards` in `cardgridlayout.ts`. An ended run, which is most History rows, has no card, and the cursor would fall on whatever card is first. The run sheet (`openTarget(model, { kind: "run", runId })`, the Hub/`jarvis` surface) is where the run's record lives. This refines main-plan decision 12 for runs with no card, so the Now region is unaffected: every run it lists is in the lineage.

## Review Focus

- A cancelled run that also has a dag keeps `"<done>/<total> tasks · cancelled"`. Only the no-dag line changes.
- A run in the lineage whose lead is not in the roster still lands on its leadless card (`leadlessCardId(runId)`), not on the Hub.

---

### Task 1: History run line and run-row target

**Chunk:** History with nested runs

**Files:** `frontend/app/view/agents/projecthistorymodel.ts`, `frontend/app/view/agents/projecthistorymodel.test.ts`, `frontend/app/view/agents/projecthistory.tsx`, `scripts/cdp/project-overview-history.mjs`

The edits:
- `projecthistorymodel.ts`: change `runItem` and add `runCardId`.
- `projecthistory.tsx`: change the run row's meta line, around `<span className="text-accent-soft">run</span> · {run.line}`, and `openRun`.

**Interfaces:**
- Produces: `runCardId(lineage: Lineage, roster: AgentVM[], runId: string): string | undefined` in `projecthistorymodel.ts`. It returns the run's Cockpit card id (`leadAgentOf(lineage, roster, runId)?.id ?? leadlessCardId(runId)`) when `lineage.runs[runId]` exists, and `undefined` otherwise.

- [ ] **Step 1: Write the failing tests** in `projecthistorymodel.test.ts`:
  - Extend `"a run with no dag says merged when landed, else its status"`:
    - `runItem(run("r", { status: "cancelled" }))` matches `{ line: "", warn: " · cancelled", tone: "muted" }`.
    - A `done` run with `land: { state: "held" }` and no dag matches `{ line: "done", warn: " · land held" }`.
  - Add `"a cancelled run with a dag keeps its task count"`: build the dag the way the file's existing dag cases do, and expect `line` to be `"<done>/<total> tasks"` and `warn` to be `" · cancelled"`.
  - Add `describe("runCardId")`:
    - A run in `lineage.runs` with its lead in the roster returns the lead's id.
    - A run in `lineage.runs` with no lead in the roster returns `leadlessCardId(runId)`.
    - A run not in `lineage.runs` returns `undefined`.
- [ ] **Step 2: Run them and see them fail.** Run `npx vitest run frontend/app/view/agents/projecthistorymodel.test.ts`. Expect the new cases to FAIL.
- [ ] **Step 3: Implement.**
  - In `runItem`'s no-dag branch, compute the warn first and set `line` to `""` when the warn is `" · cancelled"`.
  - Add `runCardId` and move the `leadlessCardId` and `leadAgentOf` imports it needs into the model.
  - In `projecthistory.tsx`, render `run` followed by `" · {line}"` only when `line` is non-empty, then the warn.
  - In `openRun`, when `runCardId` returns an id, set `cursorIdAtom` and switch to `"cockpit"` as today. Otherwise call `fireAndForget(() => openTarget(model, { kind: "run", runId }))`. Close the modal on both paths.
- [ ] **Step 4: Run the tests and see them pass.** Run `npx vitest run frontend/app/view/agents/projecthistorymodel.test.ts`, then `task check:ts`. Both pass.
- [ ] **Step 5: Update the scenario** `scripts/cdp/project-overview-history.mjs`:
  - In the "Main board, history" step, read the cancelled row's flattened text and assert that it contains `run · cancelled` and does not contain `cancelled · cancelled`.
  - After the existing "a run row opens the run's card on the Cockpit" step, add a step with the mock roster restored, so the run has no member and is not in the lineage. Click the cancelled run's row (`[data-history-run="<cancelled.id>"]`). Assert three things: the modal closes, `model.surfaceAtom` becomes `"jarvis"`, and the cursor is not moved onto a Cockpit card. Name it `"Main board, history: an ended run's row opens its sheet on the Hub, the modal closed"`, take a `history-to-run-sheet` shot, then reopen the Overview as the other steps do.
  - Keep the file's 4-space hand formatting (no prettier on `scripts/*.mjs`).
- [ ] **Step 6: Run the scenario** with `node scripts/cdp/final-verify.mjs project-overview`. Every History step passes. Look at `project-overview-history-main.png` and check that the cancelled row reads `run · cancelled`.
- [ ] **Step 7: Commit**

```bash
git add frontend/app/view/agents/projecthistorymodel.ts frontend/app/view/agents/projecthistorymodel.test.ts frontend/app/view/agents/projecthistory.tsx scripts/cdp/project-overview-history.mjs
git commit -m "fix(overview): History run line and ended-run target"
```
