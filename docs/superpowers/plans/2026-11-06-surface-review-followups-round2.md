# Surface review follow-ups: round 2 fix plan

> **For agentic workers:** each task below is one worker's. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the one Final failure of round 1: diff-states step 7 ("a modified file denied read-data says Couldn't
read this file with Retry") fails because one unreadable file now fails the whole change read.

**Architecture:** Round 1's F4 fix made `GetChanges` return the live-mode `git diff --numstat HEAD` error. That
command exits 128 ("cannot hash <file>") when any one file's bytes cannot be read, while `git status` still lists
every file. The change read then fails as a whole, the Diff surface keeps its last good list, and the file is never
re-read, so the pane never reaches its read-failure state. The fix keeps the list and reports the counts as unknown.

**Tech Stack:** Go (wavesrv), wshrpc + `task generate`, React 19 + jotai, vitest, CDP scenarios.

**Effort:** effort:fdea6d43-219b-4cf2-b4ce-51758338103b
**Spec:** `C:\Users\kael02\AppData\Local\arc-wt\a188f797\docs\superpowers\specs\2026-11-06-surface-review-followups-design.md` (D3, revised for this round)
**Verify:** `node scripts/verify.mjs ./pkg/wavebase ./pkg/blockcontroller ./pkg/wcore ./pkg/wstore ./pkg/gitinfo ./pkg/jarvis ./pkg/jarvisattrib ./pkg/wshrpc/... ./pkg/service/...`
**Check:** `go build ./... && go vet ./pkg/wavebase ./pkg/blockcontroller ./pkg/wcore ./pkg/wstore ./pkg/gitinfo ./pkg/jarvisattrib ./pkg/wshrpc/... && task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs agent-keys agent-tree diff-states palette-review-fixes brief-act brief-live-initiative code-markdown surface-smoke`

## Global Constraints

- Logic is extracted, not rendered: pure `foo.ts` + `foo.test.ts`, thin `.tsx`.
- Colors and spacing from the `@theme` tokens in `frontend/tailwindsetup.css` only; no new tokens. UI follows `DESIGN.md`.
- `tsconfig.json` is `strict: false`: narrow an ok-union with `"reason" in result`, not `result.ok`.
- Errors are handled at boundaries and never silently swallowed: a fallback logs with context.
- Generated files are never hand-edited: change the Go type, then run `task generate`.
- Lint/format only the files you touched; keep prettier off `scripts/*.mjs`.
- Never stop `wave-tauri.exe` / `wavesrv.x64.exe` by image name; never touch the user's packaged Arc.

## Review Focus

- A numstat failure must never show as `+0 −0`: on the Cockpit card (no chip) and on the Diff surface (no counts).
- A repo with no commits still lists its files with no error and no notice (existing `TestGetChangesNoCommitsStillLists`).
- Ref mode still fails on an unresolvable ref (existing `TestGetChangesRefModeUnknownRefErrors`).

---

### Task 1: One unreadable file no longer fails the whole change read
**Depends on:** none
**Chunk:** pkg/gitinfo GetChanges ignores git diff --numstat errors (numstat, _ := run(...)): a cut-off git shows the file count with +0 -0 (seen as repo+0-0 on a Cockpit card). Pre-existing on base.
**Files:** `pkg/gitinfo/gitinfo.go`, `pkg/gitinfo/gitinfo_test.go`, `pkg/wshrpc/wshrpctypes_projects.go`, `pkg/wshrpc/wshserver/wshserver_projects.go`, `frontend/types/gotypes.d.ts`, `frontend/app/view/agents/cardgitstore.ts`, `frontend/app/view/agents/cardgitstore.test.ts`, `frontend/app/view/agents/filesstore.ts`, `frontend/app/view/agents/filesstore.test.ts`, `frontend/app/view/agents/filessurface.tsx`, `frontend/app/view/agents/changedfilelist.tsx`, `scripts/cdp/scenarios-files-states.mjs`

Implements spec D3 as revised. Repro of the cause (confirmed by the lead): in a repo with one commit, modify a
tracked file to a new size, `icacls <file> /deny %USERNAME%:(RD)`; `git status --porcelain` exits 0 listing it,
`git diff --numstat --relative HEAD` exits 128 with `fatal: cannot hash <file>`.

- [ ] `gitinfo.Changes` gains `NumstatError string`. In live mode with `head != ""`, a numstat failure no longer
  returns an error: `GetChanges` returns the status list (untracked synthetic numstat rows still appended) with
  `NumstatError` set to `describeGitError(...)`'s text. Ref-mode errors and the no-commits case are unchanged.
- [ ] `TestGetChangesLiveModeNumstatFailureErrors` (the missing-loose-blob setup) is renamed
  `TestGetChangesLiveModeNumstatFailureKeepsList` and asserts: no error, the modified file is in `StatusZ`,
  `NumstatError` contains `diff --numstat`. If `git status` also fails in that setup on your machine, produce the
  failure another way and say how in the report.
- [ ] `wshrpc.CommandGitChangesRtnData` gains `NumstatError string \`json:"numstaterror,omitempty"\``;
  `GitChangesCommand` copies it; run `task generate`.
- [ ] `cardgitstore.ts`: when `numstaterror` is set, `console.warn` with the agent id and the error and leave no
  stats for the id (no chip, as for a rejected call). `cardgitstore.test.ts` case: a resolved `GitChangesCommand`
  with `numstaterror` leaves no stats and warns.
- [ ] `filesstore.ts`: the change list loads as normal and its state carries `numstatError?: string`.
  `filesstore.test.ts` case: a result with `numstaterror` stores the files and the error, and no failure.
- [ ] Diff surface: while `numstatError` is set, `filessurface.tsx` shows `GitFailureNotice` (title
  "Line counts unavailable", note: git's error) above the panes, and `changedfilelist.tsx` shows no `+N −N` on rows
  or totals. Picking a file still reads it, so an unreadable file reaches the pane's "Couldn't read this file" state.
- [ ] Other `GitChangesCommand` callers (railstore, agentbranchstore, newagentmodal, codestore, codepeekstore,
  peekagent) are not edited; name them in Found not fixed.
- [ ] `diff-states` step 7: inside the deny window (before the `finally` that removes the ACE), also read whether
  the change list still lists `src/old.py` and the "Line counts unavailable" notice shows; add both to the step's
  pass condition and detail. Do not weaken any existing condition of the step.
- [ ] Run `go test ./pkg/gitinfo -run 'GetChanges' && npx vitest run frontend/app/view/agents/cardgitstore.test.ts frontend/app/view/agents/filesstore.test.ts`, then `task verify:ui -- diff-states` against your own dev app.
- [ ] Acceptance: every `diff-states` step passes in Final, step 7 included.
