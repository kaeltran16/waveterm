# Diff Surface Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-11-05-diff-surface-review-fixes-design.md` (every decision and its why; read it first)
**Verify:** `node scripts/verify.mjs ./pkg/gitinfo ./pkg/wshrpc/...`
**Check:** `task check:ts && go vet ./pkg/gitinfo ./pkg/wshrpc/...`
**Final:** `node scripts/cdp/final-verify.mjs diff-scope diff-states diff-compare git-history diff-review-marks diff-source-row diff-comments`

**Goal:** Fix all 26 findings (F1-F26) of the 2026-11-05 Diff surface review.

**Architecture:** Four small first tasks land the interfaces everything else builds on: the Go wire fields (generated into TS), the file-list order helpers, and the two new CDP scenario modules. The Go implementations, the pure scope/range models and the source decisions run beside them. Stores, compare and the diff pane then build in parallel, keys/docs and the surface wiring last. Every task names the CDP scenario step that shows its visible change.

**Tech Stack:** Go (`pkg/gitinfo`, `pkg/wshrpc`), React 19 + jotai + vitest (`frontend/app/view/agents`), CDP scenarios (`scripts/cdp`).

## Global Constraints

- Logic goes in pure model files with `*.test.ts` beside them (or Go functions with tests); `.tsx` files stay thin. A pure model never imports a store or RPC module.
- Colors and spacing from existing `@theme` tokens only (`frontend/tailwindsetup.css`, DESIGN.md). No new tokens.
- Generated files (`frontend/types/gotypes.d.ts` etc.) change only through `task generate`.
- `tsconfig` is `strict: false`: narrow ok-unions with `"reason" in x`, not `x.ok`.
- Scenario steps go in the module the task owns: `diff-scope` = `scripts/cdp/scenarios-files-scope.mjs`, `diff-states` = `scripts/cdp/scenarios-files-states.mjs`, `diff-compare` = `scripts/cdp/scenarios-files.mjs`. Fixture repos live in `%TEMP%` (the existing scenarios' pattern) and are deleted, with their projects, in teardown.
- A step whose behavior needs Task 2's backend (bounded list, worktree caps, `hasremote`, stash exclusion) is written in full; if Task 2 has not merged into your tree when you run it, say so in your report and leave proving it to Final.
- Lint/format only the files you touched (`npx eslint <paths>`, `npx prettier --check <paths>`); keep prettier off `scripts/*.mjs`.
- Two other runs (cad1a593: `agentdiffnav.ts`, `bindings.ts`, shortcut docs; 5638249e: `bindings.ts`, shortcut docs, open-in-Code) may land first; resolve conflicts keeping every run's behavior.

## Review Focus

- A repository with no commits (unborn HEAD): `FileInWorktree` reads the file, and `HistoryLog` with `Ref: "HEAD"` answers empty history, not a failure. Task 2 tests both.
- A landed run whose `land.commit` is empty or no longer resolves (gc'd, shallow clone): the run diff falls back to `endcommit`, then to today's unbounded read, never a failure panel. Task 8 tests `landedRunTip` and the fallback.
- A filter typed in the source picker that matches nothing: `Enter` does nothing and the popover stays open with "No match". Task 7 test.
- `n`/`p` at the first/last file and in a subject with no files: the key is declined (returns false), no wrap. Task 11 test.
- A refresh failure followed by a success: `filesRefreshFailedAtom` clears and the notice goes. Task 8 test, Task 12 step.

---

### Task 1: Go wire fields and generated types
**Depends on:** none
**Files:** `pkg/wshrpc/wshrpctypes_git.go`, `pkg/wshrpc/wshrpctypes_projects.go`, `frontend/types/gotypes.d.ts`

Spec sections: Backend (the field names only). Interface-only: handlers ignore the new fields until Task 2.
- [ ] Add `CommandGitFileAtRefData.Worktree bool` (`json:"worktree,omitempty"`, comment: read the file on disk under cwd instead of a blob; Ref ignored), `CommandGitChangesData.End string` (`json:"end,omitempty"`, comment: with Ref, list only the commits in Ref..End; Branch and Head stay the checkout's), `CommandListBranchesRtnData.HasRemote bool` (`json:"hasremote,omitempty"`).
- [ ] `task generate`; `go vet ./pkg/wshrpc/...` clean; `gotypes.d.ts` shows `worktree?`, `end?`, `hasremote?`. Commit.

### Task 2: Backend: worktree file read, bounded change list, remote presence, stash out of history
**Depends on:** Task 1 (fills the three fields it adds)
**Files:** `pkg/gitinfo/gitinfo.go`, `pkg/gitinfo/gitinfo_test.go`, `pkg/wshrpc/wshserver/wshserver_git.go`, `pkg/wshrpc/wshserver/wshserver_projects.go`

Spec sections: Backend (F9, F3, F14, F26).

**Interfaces produced:**
- `gitinfo.FileInWorktree(ctx, cwd, path string, maxBytes int64) (*FileContent, error)`: `GitFileAtRefCommand` calls it when `Worktree` is set.
- `gitinfo.GetChangesTo(ctx, cwd, ref, end string) (*Changes, error)`: `GetRangeChanges` plus the checkout's `Branch` and `Head`; `GitChangesCommand` uses it when `End` and a ref are set.
- `gitinfo.HasRemote(ctx, cwd string) (bool, error)`: fills `HasRemote`; an error degrades to false like `Default`.
- `HistoryLog` with no `Ref` walks `--exclude=refs/stash --all`.

- [ ] Write failing tests in `gitinfo_test.go` against temp repos: `TestFileInWorktree` (text file → Content; absent → Missing; size > maxBytes → TooLarge with Size and no Content; a NUL in the bytes → Binary; invalid UTF-8 → Binary; subdirectory cwd → Prefix set; a repo with no commits → the file is read; non-repo → IsRepo false); `TestGetChangesTo` (base..end lists only end's commits, ignores an uncommitted edit and an untracked file, returns the checkout's Branch and Head); `TestHasRemote` (none → false; `git remote add origin <bare>` → true); `TestHistoryLogExcludesStash` (after `git stash`, no commit carries a `refs/stash` ref and the stash's WIP commit is absent); `TestHistoryLogUnbornHead` (`Ref: "HEAD"` in a repo with no commits → IsRepo true, no commits, no Failure).
- [ ] Run `go test ./pkg/gitinfo -run '^(TestFileInWorktree|TestGetChangesTo|TestHasRemote|TestHistoryLogExcludesStash|TestHistoryLogUnbornHead)$'`: FAIL.
- [ ] Implement; wire the handlers. Re-run: PASS. `go vet` clean. Commit.

### Task 3: File-list order helpers
**Depends on:** none
**Files:** `frontend/app/view/agents/filetree.ts`, `frontend/app/view/agents/filetree.test.ts`, `frontend/app/view/agents/reviewmarks.ts`

Spec sections: F25, F19 helpers.

**Interfaces produced:** `listOrder(files: GitChange[], tree: boolean): string[]` (what `reviewOrder` computes today; `reviewOrder` delegates to it), `firstInList(files: GitChange[], tree: boolean): string | undefined`, `stepInList(order: string[], from: string | null, dir: 1 | -1): string | null` (null past either end; `from` null → first for 1, null for -1).
- [ ] Failing tests in `filetree.test.ts`: tree order differs from input order and `firstInList` follows the tree; flat follows input; `stepInList` forward, back, clamped at both ends, `from` not in order → first.
- [ ] `npx vitest run frontend/app/view/agents/filetree.test.ts frontend/app/view/agents/reviewmarks.test.ts`: FAIL, implement, PASS. Commit.

### Task 4: Scenario scaffolding: diff-scope and diff-states
**Depends on:** none
**Files:** `scripts/cdp/scenarios-files-scope.mjs`, `scripts/cdp/scenarios-files-states.mjs`, `scripts/cdp/scenarios.mjs`

Two new scenario modules, registered in `SCENARIOS`, each with one step that opens its fixture project on the Diff surface and shows the history and a diff. Later tasks add steps.
- `diffScope` (name `diff-scope`, surface `files`). Arrange: a temp repo `verify-diff-scope` with 60+ commits on `main` (so the history pages), a `side` branch committed in a second worktree, one uncommitted edit, one `git stash`; a temp plain folder `verify-diff-plain`; a temp repo `verify-diff-remote` cloned from a local bare repo (so it has a remote); all registered as projects.
- `diffStates` (name `diff-states`, surface `files`). Arrange: a temp repo `verify-diff-states` with a tracked `src/old.py` and a tracked empty `src/gone.txt`, both deleted in the working tree, an untracked 1 KB random `src/blob.bin`, an untracked 3 MB `big.log`, an untracked empty `src/empty.txt`, and an `--allow-empty` commit (a commit with no files); registered as a project.
- Both export the helpers later steps reuse: open project on Diff, pick a history row by subject, pick a file by path, read an element's text, set the viewport (re-applied per CDP session).
- [ ] Write both, run `node scripts/cdp/verify.mjs diff-scope diff-states` against a running dev app (`tail -f /dev/null | task dev`): both pass. Commit.

### Task 5: Pure models: range, rows, history query, layout
**Depends on:** none
**Files:** `frontend/app/view/agents/diffscope.ts`, `frontend/app/view/agents/diffscope.test.ts`, `frontend/app/view/agents/historyrows.ts`, `frontend/app/view/agents/historyrows.test.ts`, `frontend/app/view/agents/historyquery.ts`, `frontend/app/view/agents/historyquery.test.ts`, `frontend/app/view/agents/historypane.tsx`, `frontend/app/view/agents/diffcontent.ts`, `frontend/app/view/agents/diffcontent.test.ts`, `frontend/app/view/agents/difflayout.ts`, `frontend/app/view/agents/difflayout.test.ts`

Spec sections: Scope and range model (F3 labels, F7, F10, F24, F16, F21, F11). Every change is additive, so current callers compile unchanged.

**Interfaces produced:**
- `DiffOrigin` run and `DiffRange` run: optional `headCommit?: string`; `defaultRangeFor` copies it. `rangeKey` run appends `:<head>` only when `headCommit` is set, so an unbounded run keeps today's key (review marks persist by it, `reviewmarks.ts:52`).
- `LoadHistoryOpts.ref?: string`; `historyOptsFor(range, resolvedRef)`: session → `ref: "HEAD"`, run → `ref: range.headCommit || "HEAD"`, working/compare → no ref.
- `historyKey(cwd, f, ref = "")` includes the ref (rewrite its "range-free" comment: the walked ref changes git's answer, the range's labels do not).
- `RangeCtx.isRepo?: boolean` (default true); Compare omitted when false. The session chip when active with no start: `available: true`, `detail: "not yet"`, `reason` kept.
- `summaryLine` run: `<base7> … <head7 or HEAD> · counts`; session with `ref` "": `N files against HEAD (no session start yet) · +a −d`.
- `worktreeCaption`: session with ref "" → `On X, measured from HEAD (no session start yet)`; run with `headCommit` → `On X, measured from run base B to its landed tip T`.
- `buildRows`: the anchor row carries `divider` and `before: true`; older rows `before: true`. `commitCount(rows: HistoryRow[]): number` (rows that are not the synthetic top row).
- `historyquery.ts`: `HISTORY_RPC_TIMEOUT_MS = 15_000`, `SLOW_HISTORY_MS = 4_000`.
- `DiffSelection` worktree: optional `end?: string`; `pairRefsFor` makes the modified side `{kind: "ref", ref: end}` when set.
- `difflayout.ts`: `type HistoryLayout = "rail" | "column" | "overlay"`; `historyLayout(explicit: boolean | null, width: number): HistoryLayout` (collapsed or auto-collapsed → rail; explicitly expanded below `HISTORY_COLLAPSE_PX` → overlay; else column; unmeasured width → column). `resolveCollapsed` stays.

- [ ] Failing tests for each item above, with the exact strings: `rangeKey` of an unbounded run equals today's `run:<id>:<base>`; `buildRows` puts the divider and `before: true` on the anchor row and `before: false` on the row above; `historyLayout(false, 1000) === "overlay"`, `(false, 1600) === "column"`, `(true, 1600) === "rail"`, `(null, 1000) === "rail"`; `commitCount` ignores the working-tree row.
- [ ] `npx vitest run frontend/app/view/agents/{diffscope,historyrows,historyquery,diffcontent,difflayout}.test.ts`: FAIL. Implement. `historypane.tsx`: draw `Divider` before its row; the paging footer reads `loading commits ${commitCount(rows) + 1}–${commitCount(rows) + HISTORY_PAGE_SIZE}…`. PASS. Commit.

Acceptance (rendered and stepped in later tasks): divider above the anchor, `diff-scope` "session divider" (Task 8); counts, `diff-scope` "history counts" and session label, "agent without a session start" (Task 12). The slow-read notice (F21) is unit-tested only: a `git log` over 4 s cannot be arranged reliably in a fixture.

### Task 6: Source decisions, source picker keys, Cockpit card chip
**Depends on:** Task 4 (shares scenarios-files-scope.mjs)
**Files:** `frontend/app/view/agents/diffsource.ts`, `frontend/app/view/agents/diffsource.test.ts`, `frontend/app/view/agents/sourcepicker.tsx`, `frontend/app/view/agents/cockpitsurface.tsx`, `scripts/cdp/scenarios-files-scope.mjs`

Spec sections: Surface (F5, F6 decision, F2, F18).

**Interfaces produced:**
- `type SubjectState = "empty" | "pick" | "ended" | "ready"`; `subjectState(scope: DiffScope | null, agents: SourceAgent[], projects: {name: string}[]): SubjectState`.
- `endedAgentScope(cwd: string | undefined, projects: {name: string; path: string}[]): DiffScope | null`: the registered project whose normalized path equals cwd, else a project origin named for the folder; the range from `defaultRangeFor` (diffscope.ts). Built inline: diffsource.ts stays pure and does not import `agentdiffnav.ts`. Null with no cwd.
- `pickerRows(agents, projects): Array<{kind: "agent"; id: string} | {kind: "project"; name: string}>` (agents first, as drawn) and `moveHighlight(count: number, cur: number, dir: 1 | -1): number` (clamped).

- [ ] Failing tests in `diffsource.test.ts`: `subjectState` for each state (agent origin not in agents → "ended"; null scope + one project → "pick"; null scope, no sources → "empty"); `endedAgentScope` (registered match by normalized path, unregistered folder, undefined); `pickerRows` order and empty under a no-match filter; `moveHighlight` clamps.
- [ ] `npx vitest run frontend/app/view/agents/diffsource.test.ts`: FAIL, implement, PASS.
- [ ] `sourcepicker.tsx`: highlight index over `pickerRows(filtered…)`, `ArrowDown`/`ArrowUp` move it, `Enter` picks it (no-op with no rows, popover stays with "No match"), the highlight drawn with the existing hover/selected token.
- [ ] `cockpitsurface.tsx`: the card's diff chip calls `openDiff(model, agentDiffScope(id, agent name))` from `agentdiffnav.ts`; drop the stale comment.
- [ ] `diff-scope` steps: "picker keyboard" (type a fragment matching two sources, `ArrowDown`, `Enter` → the second is the scoped source and the popover is closed; a no-match fragment + `Enter` → still open); "card chip scopes to the agent" (with Diff pinned to `verify-diff-scope`, click an agent card's diff chip on the Cockpit → the Diff picker names that agent; use `npm run cockpit:fixtures` agents if their cards render the chip, else a real Claude Code agent on Haiku launched through New agent in the fixture repo, closed in teardown).
- [ ] `node scripts/cdp/verify.mjs diff-scope`; commit.

### Task 7: History and change-list stores; run links
**Depends on:** Task 1 (uses `end` on GitChangesCommand), Task 3 (uses `firstInList`), Task 5 (uses `headCommit`, `LoadHistoryOpts.ref`, `historyKey` ref, `HISTORY_RPC_TIMEOUT_MS`), Task 6 (shares scenarios-files-scope.mjs)
**Files:** `frontend/app/view/agents/filesstore.ts`, `frontend/app/view/agents/filesstore.test.ts`, `frontend/app/view/agents/githistorystore.ts`, `frontend/app/view/agents/githistorystore.test.ts`, `frontend/app/view/agents/agentdiffnav.ts`, `frontend/app/view/agents/agentdiffnav.test.ts`, `scripts/cdp/scenarios-files-scope.mjs`

Spec sections: F3 (resolve and read), F4, F6 (remembered cwd), F7 (read), F20 (stores), F21 (timeout), F25.

**Interfaces produced:**
- `landedRunTip(landCommit: string | undefined, parents: string[] | undefined, endCommit: string | undefined): string` ("" = unbounded): parents ≥ 2 → parents[1]; 1 parent → landCommit; no land commit or no parents read → endCommit ?? "". `runDiffScope(runId, cwd, baseCommit?, headCommit?)`. `openRunDiff` reads parents with `GitHistoryCommand({cwd: root, ref: land.commit, limit: 1}, {timeout: HISTORY_RPC_TIMEOUT_MS})`; a failed read logs and falls back.
- `FilesState.end: string` ("" = live); the run range passes `end: headCommit`.
- `agentCwdOf(id: string): string | undefined`.
- `filesRefreshFailedAtom: PrimitiveAtom<boolean>`: set by a failed `reloadChanges` (state kept), cleared by any successful read; an initial-load failure behaves as today.
- `commitChangesFailureAtom: PrimitiveAtom<string | null>`, `retrySelectedCommit(): void`.
- Every `GitHistoryCommand` call (`loadHistory` and `loadMoreHistory`) sends `ref` from the stored `historyOptsAtom` and `{timeout: HISTORY_RPC_TIMEOUT_MS}`; the load token is `historyKey(cwd, filters, opts.ref)`. `settleSelection` drops the remembered row when the scope key differs from the one it last settled for.
- The first file picked on load (`loadChangesForCwd`, `selectCommit`) is `firstInList(files, globalStore.get(treeModeAtom))`.

- [ ] Failing tests: `landedRunTip` (merge, single parent, missing land commit with/without endcommit); landed `openRunDiff` → the scope's range has the tip and `GitHistoryCommand` was asked for `land.commit`; a failed parents read → endcommit; a bounded run sends `end` and stores `state.end`; `reloadChanges` rejection keeps the state and sets `filesRefreshFailedAtom`, the next success clears it; `agentCwdOf` after an agent load; `loadHistory` sends `ref` and the timeout and a ref change re-reads; `loadMoreHistory` under a session range sends the same `ref` and the timeout; selection: same cwd, new scope key → the default row (`""` when the synthetic row exists), same scope key → kept; `selectCommit` rejection sets `commitChangesFailureAtom`, `retrySelectedCommit` clears it and re-reads; tree mode → the first file is the first tree row, not `files[0]`.
- [ ] `npx vitest run frontend/app/view/agents/{filesstore,githistorystore,agentdiffnav}.test.ts`: FAIL. Implement; PASS.
- [ ] `diff-scope` steps: "run range bounded" (a run record via `createchannel` + `createrun` whose base is a fixture commit and whose land commit is a `--no-ff` merge, then a later commit on main; open it through the app's `openRunDiff`; the summary reads `<base> … <tip>` and the count excludes the later commit); "run link selects Run changes" (select a commit on the project, then open the run → "Run changes" is selected); "session divider" (run scope: the `side` commit is absent and the divider sits above the dimmed anchor row); "first file is first row" (tree mode: the opened file is the first file row drawn); "stash not listed" (no row and no chip for the fixture's stash).
- [ ] `node scripts/cdp/verify.mjs diff-scope`; commit.

### Task 8: Compare: refresh, default pair, remote-aware Fetch, picker blur
**Depends on:** Task 1 (uses `hasremote` on ListBranches), Task 3 (uses `firstInList`)
**Files:** `frontend/app/view/agents/comparestore.ts`, `frontend/app/view/agents/comparestore.test.ts`, `frontend/app/view/agents/refpicker.tsx`, `scripts/cdp/scenarios-files.mjs`

Spec sections: Compare (F8, F13, F14), F20 and F25 for compare.

**Interfaces produced:**
- `refreshCompare(cwd: string): Promise<void>` (re-runs `setCompareRefs` with `compareRefsAtom`'s pair; no-op without one).
- `defaultComparePair(i: {def: string; current: string; prev: {base: string; head: string} | null; branches: BranchInfo[]}): {base: string; head: string}`, used by `enterCompare`.
- `compareHasRemoteAtom: Atom<boolean>` from `hasremote`.
- `compareCommitFailureAtom: PrimitiveAtom<string | null>`, `retryCompareRow(cwd: string): void`.
- The first file of the aggregate and of a commit row: `firstInList`.

- [ ] Failing tests: `defaultComparePair` (head == base → the most recent local non-base branch; remote branches skipped; no other branch → unchanged; a remembered pair wins); `refreshCompare` re-reads divergence and aggregate for the same pair; `hasremote` false/true reaches the atom; a rejected commit-row read sets the failure, retry clears it; the first file follows tree order.
- [ ] `npx vitest run frontend/app/view/agents/comparestore.test.ts`: FAIL. Implement; PASS.
- [ ] `refpicker.tsx`: `onBlur` on both fields clears `focused` (picks stay on mousedown, which fires first); fix the comment at the Suggestions mousedown.
- [ ] `diff-compare` steps: "suggestions close on blur" (type in base, click the diff pane → no suggestions popover); "compare opens on two different refs" (on main with a side branch → head is the side branch, not main…main); "compare opens the first listed file" (tree mode: the aggregate opens the first file row drawn).
- [ ] `node scripts/cdp/verify.mjs diff-compare`; commit.

### Task 9: Diff pane content: worktree caps, failures, empty-file and split states
**Depends on:** Task 1 (uses `worktree` on GitFileAtRef), Task 4 (shares scenarios-files-states.mjs)
**Files:** `frontend/app/view/agents/diffcontentstore.ts`, `frontend/app/view/agents/diffcontentstore.test.ts`, `frontend/app/view/agents/diffempty.ts`, `frontend/app/view/agents/diffempty.test.ts`, `frontend/app/view/agents/diffpane.tsx`, `frontend/app/view/agents/diffoptions.ts`, `frontend/app/view/agents/diffoptions.test.ts`, `frontend/app/view/agents/diffcommentcard.tsx`, `scripts/cdp/scenarios-files-states.mjs`

Spec sections: Diff pane (F9, F12, F17, F19 text, F20).

**Interfaces produced:**
- `readSide` worktree → `GitFileAtRefCommand({cwd, path, ref: "", worktree: true, maxbytes: MAX_DIFF_BYTES})`.
- `DiffPair.originalMissing?: boolean`, `DiffPair.modifiedMissing?: boolean` (optional, so existing `DiffPair` literals such as `reviewmarks.test.ts:31` still compile).
- `diffPairFailureAtom: PrimitiveAtom<string | null>`, `retryDiffPair(): void` (re-runs the last `loadDiffPair` arguments).
- `EmptyDiffInput.failure?: string | null` → kind `"failed"`, title "Couldn’t read this file", body the message. Empty-file kinds `"newempty"` ("New empty file" / "It was added with no content.") and `"deletedempty"` ("Deleted empty file" / "It had no content."). `nofile` body: "Choose one from the list, or step through it with n / p."
- `splitAvailableAtom: PrimitiveAtom<boolean>`, written by the pane from `paneHeaderLayout(width).split`.

- [ ] Failing tests: the worktree side sends `worktree: true` and maps `binary`/`toolarge`/`missing`; a rejected read sets the failure and keeps the pair null, `retryDiffPair` re-reads; each new `emptyDiffState` kind with its exact copy; the `nofile` copy.
- [ ] `npx vitest run frontend/app/view/agents/{diffcontentstore,diffempty,diffoptions}.test.ts`: FAIL. Implement; PASS.
- [ ] `diffpane.tsx`: render the failure with a Retry button (existing button tokens); write `splitAvailableAtom`. `diffcommentcard.tsx`: "Removed lines: switch to split (⇧D) to comment on them" when split is available, else "Removed lines: collapse history (⇧H) or widen the window to use split view and comment on them".
- [ ] `diff-states` steps: "untracked binary" (`src/blob.bin` → "Binary file"); "untracked too large" (`big.log` → "Too large to show here"); "new empty file" (`src/empty.txt` → "New empty file"); "deleted empty file" (`src/gone.txt` → "Deleted empty file"); "pick a file" (select the no-files commit → "Pick a file to see its changes" with the n / p copy); "narrow-pane hint" (`src/old.py` at 1600x950 with history expanded → the collapse-history wording); "diff read failure" (open a file, replace it with a directory of the same name, trigger a re-read with `r` → "Couldn’t read this file" with Retry; restore it and Retry → the diff).
- [ ] `node scripts/cdp/verify.mjs diff-states`; commit.

### Task 10: Asking-agent recipient
**Depends on:** none
**Files:** `frontend/app/view/agents/commentsend.ts`, `frontend/app/view/agents/commentsend.test.ts`

Spec section: F23.
- [ ] Failing tests: an agent in state `asking` → `{kind: "wait", reason: "<name> is asking a question — answer it first"}`; `sendBarText` for it does not read "Start agent"; a working and an idle agent stay `live`.
- [ ] `npx vitest run frontend/app/view/agents/commentsend.test.ts`: FAIL, implement, PASS. Commit. (Its scenario step is in Task 11.)

### Task 11: Keys and shortcut docs
**Depends on:** Task 8 (uses `refreshCompare`; shares scenarios-files.mjs), Task 9 (uses `splitAvailableAtom`; shares scenarios-files-states.mjs), Task 3 (uses `listOrder`, `stepInList`), Task 10 (its step shows Task 10's wait state)
**Files:** `frontend/app/store/keybindings/bindings.ts`, `frontend/app/store/keybindings/bindings.test.ts`, `docs/keyboard-shortcuts.md`, `scripts/cdp/scenarios-files.mjs`, `scripts/cdp/scenarios-files-states.mjs`

Spec sections: Keys, docs (F19, F8 and F12 bindings, the F1 doc line).
- [ ] Failing tests in `bindings.test.ts`: `files:refresh` in compare calls `refreshCompare` (not `refreshHistory`); `files:toggle-split` returns false and leaves `splitViewAtom` when `splitAvailableAtom` is false; `files:next-file` `n` / `files:prev-file` `p` (group "Diff", labels "Next file" / "Previous file") select via `activeReviewAtom.select` in `listOrder` order, decline at the ends and with no active review; `assertNoConflicts` still passes.
- [ ] `npx vitest run frontend/app/store/keybindings/bindings.test.ts`: FAIL. Implement; PASS.
- [ ] `docs/keyboard-shortcuts.md` Diff table: `j`/`k` → "Next / previous commit"; `Enter` → "Open the open file in Code"; add `n` / `p` "Next / previous file in the list"; `r` → "Refresh changes and history (in compare: the comparison)"; delete the "Files — Review mode" section. The cheat sheet's text is the binding labels.
- [ ] Steps: `diff-compare` "r refreshes the comparison" (commit on the head branch, press `r` → the ahead count goes up); `diff-states` "n / p step files" (`n` → the next list row opens and is not marked reviewed; `p` back); "⇧D declined when narrow" (history expanded at 1600x950 → `⇧D` leaves the pane unified); "asking agent waits" (a real Claude Code agent on Haiku, launched through New agent in `verify-diff-states` and prompted to ask a question with AskUserQuestion; comment on its diff with `m` → the send bar reads "answer it first" and `⇧Enter` sends nothing; close the agent in teardown).
- [ ] `node scripts/cdp/verify.mjs diff-compare diff-states`; commit.

### Task 12: Surface wiring: subject states, overlay history, rail, counts, Fetch, Enter
**Depends on:** Task 7 (shares scenarios-files-scope.mjs), Task 8 (uses `compareHasRemoteAtom`, `compareCommitFailureAtom`, `retryCompareRow`), Task 9 (shares diffpane.tsx), Task 6 (uses `subjectState`, `endedAgentScope`)
**Files:** `frontend/app/view/agents/filessurface.tsx`, `frontend/app/view/agents/historyrail.tsx`, `frontend/app/view/agents/commitpane.tsx`, `frontend/app/view/agents/changedfilelist.tsx`, `frontend/app/view/agents/diffpane.tsx`, `scripts/cdp/scenarios-files-scope.mjs`

Spec sections: Surface (F5, F6, F22, F24, F16, F14, F15, F11, F20 notices), F1, F3 selection. No new logic: every decision is a function from Tasks 3-9; this task renders them.
- [ ] `subjectState`: `empty` → today's state; `pick` → toolbar plus body `SurfaceEmptyState` "Pick something to review" / "Choose an agent or a project to see its changes." / action "Choose a source" (clicks `[data-files-source-picker]`); `ended` → "This agent has ended" / "Its changes are in <cwd>." / action "Open its folder" scoping to `endedAgentScope(agentCwdOf(id), projects)`, or "Choose a source" when null.
- [ ] F1: remove `editorCwd` and the Open-in-editor button from `diffpane.tsx`; the list-nav `activate` calls `openInCode(model, {projectPath: cwd, rel: file, line})`, with `line = firstDifferingLine(pair.original, pair.modified)` when the open pair is that file.
- [ ] F3: the working-tree selection passes `end: state.end`. F24: `availableRanges(..., {isRepo: state?.isRepo !== false})`. F16: `countLabel(filters, commitCount(rows), loading)`. F15: `fetched ${formatAgo(...)}`. F14: Fetch only when `compareHasRemoteAtom`. F20: `CommitPane` gets `failure` + `onRetry` (history: `commitChangesFailureAtom`/`retrySelectedCommit`; compare: `compareCommitFailureAtom`/`retryCompareRow`), drawn in `ChangedFileList` instead of the skeleton; `filesRefreshFailedAtom` → toolbar fact "couldn’t refresh · showing the last read".
- [ ] F11: `historyLayout(...)`: `overlay` renders the rail in flow plus the 460 px history (pane or compare column) absolutely over the commit and diff panes, raised with the existing popover shadow token; `⇧H` and the rail's expand button toggle it.
- [ ] F22: `HistoryRail` takes `hasMore` + `onLoadMore` (near-bottom scroll, `NEAR_BOTTOM_PX`) and, in compare, an "All changes" dot first that selects `AGGREGATE`.
- [ ] `diff-scope` steps: "no source picked" (focus a terminal with the scope cleared → "Pick something to review"; its action opens the picker); "ended agent" (scope to an agent, then close it → "This agent has ended"; the action scopes to its folder); "agent without a session start" (a just-launched agent → the summary reads "(no session start yet)" and the session chip is not disabled); "not a repo has no Compare" (`verify-diff-plain` → no `[data-range-chip="compare"]`); "history counts" (the summary count excludes the uncommitted row); "overlay at 1000x700" (`⇧H` → history drawn over the panes, the diff pane's width unchanged); "rail pages and has All changes" (1000x700: scrolling the rail loads the next page; in compare the first dot selects All changes); "no Fetch without a remote" (`verify-diff-scope` in compare → no Fetch) and "fetched just now" (`verify-diff-remote`: Fetch → "fetched just now"); "Enter opens in Code" (`Enter` → the Code surface on that file); "commit list failure" (empty the repo's objects after load, pick a commit → the failure with Retry); "compare row failure" (same, picking a compare commit row); "refresh failed notice" (empty the objects after load, press `r` → the working-tree row stays and the toolbar reads "couldn’t refresh"; restore and `r` → the notice is gone). Agents launched for steps are Claude Code on Haiku and are closed in teardown.
- [ ] `node scripts/cdp/verify.mjs diff-scope diff-states diff-compare`; commit.
