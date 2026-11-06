# Surface review follow-ups: round 3 fix plan

> **For agentic workers:** each task below is one worker's. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix round 2's Final defect: while the working tree's line counts are unknown (`FilesState.numstatError`
set), the Diff surface still draws counts in the toolbar summary and the diff pane header.

**Architecture:** Round 2 hid the counts on the change-list rows and the commit pane's totals (`lineCounts` prop on
`ChangedFileList` and `CommitPane`). The same flag now reaches the two remaining places: the pure `summaryLine`
caption and the `DiffPane` header.

**Tech Stack:** React 19 + jotai, vitest, CDP scenarios.

**Effort:** effort:fdea6d43-219b-4cf2-b4ce-51758338103b
**Spec:** `C:\Users\kael02\AppData\Local\arc-wt\a188f797\docs\superpowers\specs\2026-11-06-surface-review-followups-design.md` (D3 as revised: line counts are shown as unknown, never as zeros)
**Verify:** `node scripts/verify.mjs ./pkg/wavebase ./pkg/blockcontroller ./pkg/wcore ./pkg/wstore ./pkg/gitinfo ./pkg/jarvis ./pkg/jarvisattrib ./pkg/wshrpc/... ./pkg/service/...`
**Check:** `go build ./... && go vet ./pkg/wavebase ./pkg/blockcontroller ./pkg/wcore ./pkg/wstore ./pkg/gitinfo ./pkg/jarvisattrib ./pkg/wshrpc/... && task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs agent-keys agent-tree diff-states palette-review-fixes brief-act brief-live-initiative code-markdown surface-smoke`

## Global Constraints

- Logic is extracted, not rendered: pure `foo.ts` + `foo.test.ts`, thin `.tsx`.
- Colors and spacing from the `@theme` tokens in `frontend/tailwindsetup.css` only; no new tokens.
- Lint/format only the files you touched; keep prettier off `scripts/*.mjs`.
- Never stop `wave-tauri.exe` / `wavesrv.x64.exe` by image name; never touch the user's packaged Arc.

## Review Focus

- Counts known (no `numstatError`, or a commit selected, or a compare/run range): every caption and header reads
  exactly as before; the existing `summaryLine` tests keep passing unchanged.

---

### Task 1: The Diff toolbar summary and pane header show no line counts while they are unknown
**Depends on:** none
**Chunk:** pkg/gitinfo GetChanges ignores git diff --numstat errors (numstat, _ := run(...)): a cut-off git shows the file count with +0 -0 (seen as repo+0-0 on a Cockpit card). Pre-existing on base.
**Files:** `frontend/app/view/agents/diffscope.ts`, `frontend/app/view/agents/diffscope.test.ts`, `frontend/app/view/agents/diffpane.tsx`, `frontend/app/view/agents/filessurface.tsx`, `scripts/cdp/scenarios-files-states.mjs`

- [ ] `SummaryInput` (diffscope.ts) gains `lineCounts?: boolean` (default true). When false, `summaryLine` omits the
  `+N −N` delta from every form it builds: the file count stays, and the caption ends after it (e.g. `7 uncommitted
  files on main`), with no " · " left dangling.
- [ ] `diffscope.test.ts`: with `lineCounts: false`, the `working` form reads `N uncommitted files on <branch>`
  with no `+` or `−`, and the `session` forms (with and without a ref) carry no delta; the existing cases are
  unchanged.
- [ ] `DiffPane` (diffpane.tsx) gains `lineCounts?: boolean` (default true); when false it renders neither
  `[data-diff-adds]` nor `[data-diff-dels]`.
- [ ] `filessurface.tsx`: compute the flag once, as the existing `lineCounts` prop at ~line 805 does
  (`selectedCommit !== WORKING_TREE || !state?.numstatError`), and pass it to `summaryLine` (~line 579), to that
  existing prop, and to the `DiffPane` for the selected working-tree file.
- [ ] `diff-states` step 7: inside the deny window, also read `[data-files-range-summary]`'s text and whether any
  `[data-diff-adds]` renders; the step passes only if the summary matches no `/[+−]\d/` and no `[data-diff-adds]`
  is present. Add both to the detail. Do not weaken any existing condition.
- [ ] Run `npx vitest run frontend/app/view/agents/diffscope.test.ts`, then `task verify:ui -- diff-states` against
  your own dev app.
- [ ] Acceptance: every `diff-states` step passes in Final, step 7 included.
