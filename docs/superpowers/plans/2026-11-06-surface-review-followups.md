# Surface review follow-ups: code fixes Implementation Plan

> **For agentic workers:** each task below is one worker's. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix F2-F16 of the surface review follow-ups (F1 is already fixed on HEAD, see the spec), each with a
unit test and, for rendered UI, a step in an existing CDP scenario that Final runs.

**Architecture:** Fifteen small independent fixes grouped into ten tasks by file ownership: Go guards and reads
(snapshot guard, git and attribution errors, session-to-initiative persistence), frontend logic extracted to pure
functions with vitest beside them, and scenario steps in the surface's existing scenario file. No task depends on
another.

**Tech Stack:** Go (wavesrv), SQLite migrations, React 19 + jotai, vitest, CDP scenarios (`scripts/cdp`).

**Effort:** effort:fdea6d43-219b-4cf2-b4ce-51758338103b
**Spec:** `C:\Users\kael02\AppData\Local\arc-wt\a188f797\docs\superpowers\specs\2026-11-06-surface-review-followups-design.md` (decisions D1-D13; each task names its D)
**Verify:** `node scripts/verify.mjs ./pkg/wavebase ./pkg/blockcontroller ./pkg/wcore ./pkg/wstore ./pkg/gitinfo ./pkg/jarvis ./pkg/jarvisattrib ./pkg/wshrpc/... ./pkg/service/...`
**Check:** `go build ./... && go vet ./pkg/wavebase ./pkg/blockcontroller ./pkg/wcore ./pkg/wstore ./pkg/gitinfo ./pkg/jarvisattrib ./pkg/wshrpc/... && task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs agent-keys agent-tree diff-states palette-review-fixes brief-act brief-live-initiative code-markdown surface-smoke`

## Global Constraints

- Source report: `C:\Users\kael02\IdeaProjects\waveterm\cdp-shots\review\followups\report.md` (gitignored; read it by that path).
- Before changing code for a finding, confirm it still happens on your tree. If it does not, change nothing for it and say so in your completion report.
- Logic is extracted, not rendered: pure `foo.ts` + `foo.test.ts`, thin `.tsx`.
- Colors and spacing from the `@theme` tokens in `frontend/tailwindsetup.css` only; no new tokens. UI follows `DESIGN.md`.
- `tsconfig.json` is `strict: false`: narrow an ok-union with `"reason" in result`, not `result.ok`.
- Errors are handled at boundaries and never silently swallowed: a skip or a fallback logs with context.
- Lint/format only the files you touched (`npx eslint <paths>`, `npx prettier --check <paths>`); keep prettier off `scripts/*.mjs`.
- Never stop `wave-tauri.exe` / `wavesrv.x64.exe` by image name; never touch the user's packaged Arc or any snapshot app.
- Scenario steps are added to the named existing scenario, numbered after its last step, with a screenshot where the step is visual.

## Review Focus

- An `ARC_SNAPSHOT` guard that leaks into normal runs: every guarded handler must behave exactly as before with the variable unset (Task 1 tests both).
- A repo with no commits must still list its files after F4 (Task 2 keeps a test for it).
- Windows paths typed in a startup command (`C:\tools\claude.exe`) must survive the new splitter unchanged (Task 5 test).
- A tab closed before its agent wrote a transcript has no session to persist and must close normally (Task 3 test).
- A history failure with no prior good change list still shows the whole-body failure panel (Task 6 test).

---

### Task 1: Snapshot guard covers review writes, file RPCs, block cwd and agent prompts (F2)
**Depends on:** none
**Chunk:** Snapshot guard: Send review to an agent writes ~/.arc/review (wshserver_code.go:29-38) outside the copy; ARC_SNAPSHOT does not cover it.
**Files:** `pkg/wavebase/wavebase.go`, `pkg/wavebase/snapshot_test.go`, `pkg/blockcontroller/blockcontroller.go`, `pkg/blockcontroller/blockcontroller_test.go`, `pkg/wcore/block.go`, `pkg/wshrpc/wshserver/wshserver.go`, `pkg/wshrpc/wshserver/wshserver_code.go`, `pkg/wshrpc/wshserver/wshserver_files.go`, `pkg/wshrpc/wshserver/wshserver_agentmsg.go`, `pkg/wshrpc/wshserver/snapshotguard_test.go`, `frontend/app/cockpit/cockpit-actions.ts`, `frontend/app/cockpit/cockpit-actions.test.ts`, `frontend/app/view/code/codereviewstore.ts`, `docs/reference/surface-review.md`

Implements spec D1.

- [ ] Add to `pkg/wavebase/wavebase.go`: `SnapshotMayStart(cwd string) bool` (moved from blockcontroller's `snapshotMayStart`: true when not a snapshot, else cwd absolute and inside `SnapshotScratchDir()`), `SnapshotMayWrite(path string) bool` (true when not a snapshot, else path absolute and inside `filepath.Dir(GetWaveDataDir())`), and `SnapshotBaseDir() string`. blockcontroller calls `SnapshotMayStart`; move its table test to `pkg/wavebase/snapshot_test.go` and add `SnapshotMayWrite` cases (inside base, base itself, sibling with the base as a name prefix, `..` escape, relative path, variable unset → true).
- [ ] Refuse, under `ARC_SNAPSHOT=1`, with an error starting `snapshot store:` that names the path and the allowed folder:
  - `CodeReviewWriteCommand` before `writeReview` (`SnapshotMayWrite` on the review root).
  - `FileWriteCommand`, `FileCreateCommand`, `FileMkdirCommand`, `FileDeleteCommand`, `FileMoveCommand` (source and destination) via `SnapshotMayWrite`. Their paths are wshfs paths, which may be connection URIs: resolve each through `connparse.ParseURIAndReplaceCurrentHost` first (as `wshfs.parseConnection` does); a local host is checked on its `conn.Path`, a non-local host is refused. Put that resolution in one helper in `wshserver_files.go` that the five handlers share. Leave `WriteTempFileCommand` open (spec D1).
  - `wcore.CreateBlock` when the block def's meta has `cmd:cwd` outside scratch, and `SetMetaCommand` when it sets `cmd:cwd` on a block oref outside scratch (`SnapshotMayStart`).
  - `AgentPromptCommand` when the target block's `cmd:cwd` is not inside scratch.
- [ ] `launchAgent` in `cockpit-actions.ts`: when a step after `WorkspaceService.CreateTab` throws, close the tab it made (through the same service the tab close uses), then rethrow the original error. Test in `cockpit-actions.test.ts` (its `WorkspaceService` mock has only `CreateTab`: add `CloseTab`): a rejected `SetMetaCommand` closes the created tab and the launch rejects with the original message.
- [ ] Confirm each reported path surfaces its refusal: Send review (`codereviewstore.ts`), palette resume (Enter on a session, a "Resume ·" row), brainstorm Close (`brainstormrun.tsx` already rethrows), pane Approve / Keep talking (`sendBrainstorm` throws). Fix `codereviewstore.ts` if it swallows; any other swallowing caller you find is reported as an open issue in your completion report, not edited (spec D1: it is outside this task's files).
- [ ] Go tests in `pkg/wshrpc/wshserver/snapshotguard_test.go`, each with `t.Setenv("ARC_SNAPSHOT", "1")` and a temp data dir: `TestSnapshotRefusesReviewWrite`, `TestSnapshotRefusesFileDeleteOutsideBase`, `TestSnapshotAllowsFileWriteInsideBase` (a bare absolute path and a `wsh://local/<path>` URI, both inside the base; plus a non-local host URI refused), `TestSnapshotRefusesAgentPromptOutsideScratch`, `TestSnapshotRefusesBlockCwdOutsideScratch` (CreateBlock and SetMeta), and `TestNoSnapshotLeavesHandlersOpen` (variable unset: a file write and a review write outside the base succeed). Run `go test ./pkg/wavebase ./pkg/blockcontroller -run 'Snapshot' && go test ./pkg/wshrpc/wshserver -run 'Snapshot'`.
- [ ] `docs/reference/surface-review.md`: add the new guards to the `ARC_SNAPSHOT=1 makes wavesrv` list.
- Not in Final (the Final app is not a snapshot app); say so in the completion report.

### Task 2: Git numstat errors and unparsable records are reported (F4, F15)
**Depends on:** none
**Chunk:** pkg/gitinfo GetChanges ignores git diff --numstat errors (numstat, _ := run(...)): a cut-off git shows the file count with +0 -0 (seen as repo+0-0 on a Cockpit card). Pre-existing on base.
**Chunk:** Attribution: a record LoadDossier cannot parse is skipped silently by taskDossiers, so its accepts stop claiming their runs; report the skip
**Files:** `pkg/gitinfo/gitinfo.go`, `pkg/gitinfo/gitinfo_test.go`, `frontend/app/view/agents/cardgitstore.ts`, `frontend/app/view/agents/cardgitstore.test.ts`, `pkg/jarvisattrib/lifecycle.go`, `pkg/jarvisattrib/lifecycle_test.go`

Implements spec D3 and D4.

- [ ] `GetChanges`: live mode returns the `diff --numstat HEAD` error when `head != ""`; ref mode returns the `--name-status` and `--numstat` errors. Wrap with git's stderr (`*exec.ExitError`.Stderr) and the command. A repo with no commits keeps returning its untracked files with no error.
- [ ] Tests in `gitinfo_test.go`: `TestGetChangesRefModeUnknownRefErrors` (ref `deadbeef` → error, no Changes), `TestGetChangesNoCommitsStillLists` (fresh `git init` + one untracked file → no error, the file listed), and a live-mode failure if one can be produced deterministically (e.g. HEAD's tree object removed from `.git/objects`); if not, say why in the report.
- [ ] `refreshCardGit`'s catch logs `console.warn` with the agent id and the error, and still drops the stats (no fake zeros). Add a `cardgitstore.test.ts` case: a rejected `GitChangesCommand` leaves no stats for the id.
- [ ] `pkg/jarvis/evidence.go` is not edited: run `go test ./pkg/jarvis -run 'Evidence'` and, if a test relied on the silent empty result, report it rather than restore the swallow.
- [ ] `taskDossiers` logs `jarvisattrib: skipping record <id> (<path>): <err>` for each record `LoadDossier` cannot load, and keeps going. Test `TestTaskDossiersLogsUnparsableRecord` in `lifecycle_test.go` captures `log` output (`log.SetOutput`) with one good and one malformed record: the good one is returned, the log line names the bad one's id and the parse error.
- [ ] Run `go test ./pkg/gitinfo -run 'GetChanges' && go test ./pkg/jarvisattrib -run 'TaskDossiers' && npx vitest run frontend/app/view/agents/cardgitstore.test.ts`.

### Task 3: A session's initiative survives its tab closing (F9)
**Depends on:** none
**Chunk:** Usage initiatives count sessions only from open tabs: the session:effort tag is tab meta and leaves with the tab; persist it per session so closed-tab sessions stay in their initiative
**Files:** `db/migrations-wstore/000026_sessioneffort.up.sql`, `db/migrations-wstore/000026_sessioneffort.down.sql`, `pkg/wstore/wstore_sessioneffort.go`, `pkg/wstore/wstore_sessioneffort_test.go`, `pkg/wcore/workspace.go`, `pkg/wshrpc/wshserver/usagesessions.go`, `pkg/wshrpc/wshserver/usagesessions_test.go`

Implements spec D5.

- [ ] Migration `000026_sessioneffort`: `CREATE TABLE db_sessioneffort (harness TEXT NOT NULL, transcript TEXT NOT NULL, effortoid TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (harness, transcript))`; down drops it. If `000026` is taken on your base, take the next free number.
- [ ] `pkg/wstore/wstore_sessioneffort.go` (follow `wstore_runevent.go`'s tx style): `RecordTabSessionEffort(ctx context.Context, tab *waveobj.Tab) error` (reads `session:effort`, `session:agent` and the first block's `agent:transcriptpath`; does nothing and returns nil when any is empty; upserts with the bare effort oid and now) and `GetSessionEfforts(ctx context.Context) ([]SessionEffort, error)` with `type SessionEffort struct { Harness, Transcript, EffortOID string; Ts int64 }`.
- [ ] `wcore.DeleteTab` (workspace.go:266) calls `wstore.RecordTabSessionEffort` right after it loads the tab (`DBGet`, line ~280) and before `WorkerTabCloseHook` and the `DeleteBlock` loop: after that loop the first block and its `agent:transcriptpath` are gone and nothing would be recorded. An error is logged with the tab id and never stops the delete.
- [ ] `usageDir.tabEffort` builds its map from `GetSessionEfforts` (session id via `usagestats.SessionIdOf(harness, transcript)`), then overlays open tabs as today, so an open tab's tag wins. Update the comment that says a closed tab takes the tag along.
- [ ] Tests: `TestRecordTabSessionEffortUpserts` (record, re-tag, one row with the later effort), `TestRecordTabSessionEffortSkipsNoTranscript` (no row, nil error) in wstore; `TestUsageCountsClosedTabSessionInEffort` in `usagesessions_test.go` (a persisted row with no open tab maps its session to the effort; an open tab with a different tag overrides); and `TestDeleteTabPersistsSessionEffort` in `usagesessions_test.go` (pkg/wcore has no test setup; wshserver's TestMain inits wstore): a tab with `session:effort` and `session:agent` whose block has `agent:transcriptpath`, closed through `wcore.DeleteTab`, leaves its row in `GetSessionEfforts`. Run `go test ./pkg/wstore -run 'SessionEffort' && go test ./pkg/wshrpc/wshserver -run 'Usage'`.
- Not in Final (needs a real closed agent tab with a transcript in the Final store); say so in the report.

### Task 4: The hints footer follows focus leaving a terminal (F3)
**Depends on:** none
**Chunk:** Hints footer stays in its in-terminal posture (shift-esc leave, no up/down move) after focus moves from a terminal's xterm to the surface wrapper: hints-footer.tsx recomputes only on focusin/focusout and that move fires none. Repro: focus a terminal row, then the wrapper. agent-keys step 6 works around it with a synthetic focusin.
**Files:** `frontend/app/cockpit/hints-footer.tsx`, `scripts/cdp/scenarios-agent-keys.mjs`

Implements spec D2.

- [ ] Remove the synthetic `window.dispatchEvent(new FocusEvent("focusin"))` from `restChips` in `scenarios-agent-keys.mjs`, run `task verify:ui -- agent-keys` against your own dev app (see `docs/reference/cdp-verification.md` for a second dev app beside the main one), and record whether step 6 fails.
- [ ] Turn on `Emulation.setFocusEmulationEnabled` for the steps that move focus (pattern: `scenarios-code-keys.mjs:22`, turned off in teardown) and rerun. If step 6 now passes, the cause was the harness: keep emulation on, leave `hints-footer.tsx` unchanged, and say so in the report.
- [ ] Only if it still fails: make the footer recompute when focus leaves without an event (the focused xterm textarea removed from the DOM), keeping the logic in a pure helper if it is more than a listener. Step 6 must pass without the synthetic focusin.
- [ ] Acceptance: `agent-keys` step 6 passes with no synthetic focus event, in Final.

### Task 5: A quoted startup command keeps its quoted argument whole (F5)
**Depends on:** none
**Chunk:** New agent launch splits a quoted startup command at whitespace: claude --model haiku "a b c" delivers only "a as the prompt (found by diff review fixes t-11)
**Files:** `frontend/app/view/agents/launch.ts`, `frontend/app/view/agents/launch.test.ts`, `scripts/cdp/scenarios-agent-tree.mjs`

Implements spec D6.

- [ ] Tests first in `launch.test.ts` for `splitCommandLine(s: string): string[]`: `claude --model haiku "a b c"` → `["claude","--model","haiku","a b c"]`; single quotes literal (`'a "b"'` → `['a "b"']`); `"say \"hi\""` → `['say "hi"']`; `C:\tools\claude.exe --x` → `["C:\\tools\\claude.exe","--x"]`; unclosed `"a b` → `["a b"]`; extra whitespace and empty string → no empty tokens. Plus `buildLaunchMeta` with startupCommand `claude --model haiku "a b c"` and task `T` → `cmd:args` `["--model","haiku","a b c","T"]`, `agent:baseargs` without `T`; `composeStartupCommand` does not re-add a flag present inside the parsed tokens.
- [ ] Export `splitCommandLine` from `launch.ts` and use it in `buildLaunchMeta` and in `composeStartupCommand`'s presence check. Update `buildLaunchMeta`'s comment (no longer whitespace-only).
- [ ] Run `npx vitest run frontend/app/view/agents/launch.test.ts`.
- [ ] Add a step to the `agent-tree` scenario: a launch through the app's `launchAgent` with a quoted startup command whose block's `cmd:args` holds the quoted text as one argument (a command that cannot start a real agent, as the scenario's existing launches use). Acceptance: that `agent-tree` step passes in Final.

### Task 6: The Diff surface keeps the working tree on a history failure, measures late mounts, and fails a commit read visibly (F6, F7, F12)
**Depends on:** none
**Chunk:** Diff: pressing r while the history read fails (broken object store) sets historyFailureAtom and GitFailurePanel replaces the whole body, working-tree row included; F20 keeps the last good state only for the change-list half
**Chunk:** Diff: FilesSurface's ResizeObserver effect has [] deps, so it never attaches when the first render is the early empty return; filesSurfaceWidthAtom only keeps the last measured width
**Chunk:** Diff: a commit's file list stays on its skeleton forever when GitCommitChanges returns isrepo:false, because selectCommit sets commitChangesAtom to null with no failure. Seen once, as a one-off failure of diff-states steps 9-10. Cause plausible, not confirmed.
**Files:** `frontend/app/view/agents/filessurface.tsx`, `frontend/app/view/agents/gitstatepanels.tsx`, `frontend/app/view/agents/githistorystore.ts`, `frontend/app/view/agents/githistorystore.test.ts`, `frontend/app/view/agents/comparestore.ts`, `frontend/app/view/agents/comparestore.test.ts`, `frontend/app/view/agents/difflayout.ts`, `frontend/app/view/agents/difflayout.test.ts`, `scripts/cdp/scenarios-files-states.mjs`

Implements spec D7.

- [ ] F12 tests first: in `githistorystore.test.ts`, `selectCommit` with `GitCommitChangesCommand` resolving `{isrepo:false}` sets `commitChangesFailureAtom` to a non-empty message and `retrySelectedCommit` reads again; the same for the compare row in `comparestore.test.ts` (`compareCommitFailureAtom`). Then fix both stores so `isrepo:false` sets the failure, never null with no failure.
- [ ] F6: extract the body choice into a pure function (in `difflayout.ts` or beside it, with its test) that, given whether a history failure is set and whether the change list holds a good state (`isRepo === true` with changes loaded), returns `"history-failure-in-column" | "whole-body-failure" | "not-a-repo" | "body"`. Test all four. `filessurface.tsx` renders the history failure (message + Retry, `GitFailureNotice` or a column-sized variant from `gitstatepanels.tsx`) inside the history column for `history-failure-in-column`, keeping the working-tree row, change list and diff panes.
- [ ] F7: attach the width observer when the measured element mounts (callback ref, or an effect keyed on the element), disconnect on unmount/replace.
- [ ] Run `npx vitest run frontend/app/view/agents/githistorystore.test.ts frontend/app/view/agents/comparestore.test.ts frontend/app/view/agents/difflayout.test.ts`.
- [ ] Add `diff-states` steps: (a) history failure with a loaded working tree: the failure shows in the history column and the working-tree row is still present and selectable, with a screenshot; (b) a commit whose read returns `isrepo:false` (stub in the page, removed by teardown) shows the failure with Retry, not a skeleton, with a screenshot; (c) the surface first rendered in its empty state then given a repo updates `filesSurfaceWidthAtom` to the surface's width. Acceptance: these `diff-states` steps pass in Final.

### Task 7: A failed record status change from the palette shows an error (F10)
**Depends on:** none
**Chunk:** Brief F12 known limit: a record status change made from the palette, off the Brief, still only logs a failure (recordactions reportFailure toasts through briefUndo, which only the Brief draws); give the palette path a visible error
**Files:** `frontend/app/view/jarvis/recordactions.ts`, `frontend/app/view/jarvis/recordactions.test.ts`, `frontend/app/cockpit/cockpit-root.tsx`, `scripts/cdp/scenarios-palette.mjs`

Implements spec D8.

- [ ] Test first in `recordactions.test.ts`: a failing write with the current surface not the Brief pushes one cockpit toast (`toastsAtom` gains a `level: "error"` entry whose message names the action and the error) and no Brief toast; with the Brief as the current surface it goes to `briefUndo.error` as today and pushes no cockpit toast.
- [ ] There is no global current-surface accessor: the surface is `AgentsViewModel.surfaceAtom`, and `effortstore.ts:134` reads it through a reader handed in from `cockpit-root.tsx:86` (`subscribeEffortUpdates(model)`). Follow that: `recordactions.ts` exports `setRecordSurfaceReader(read: () => SurfaceKey): () => void` (returns an unregister), registered in `cockpit-root.tsx` beside `subscribeEffortUpdates` as `() => globalStore.get(model.surfaceAtom)`. `reportFailure` routes by it: the Brief's surface key (`"jarvis"`) → `briefUndo.error`; any other surface, or no reader registered →  `pushToast({ title: "Couldn't <what>", message, level: "error" })`. Keep the `console.error`.
- [ ] Run `npx vitest run frontend/app/view/jarvis/recordactions.test.ts`.
- [ ] Add a `palette-review-fixes` step: on a non-Brief surface, a record status change from the palette whose RPC is stubbed to fail shows an error toast (screenshot). Acceptance: that step passes in Final.

### Task 8: Brief row keys, Waiting header count and the Edit footer (F11, F14, F16)
**Depends on:** none
**Chunk:** Brief Runs keys (F5 follow-up): a lone run row with no navtarget keys run: and gains :<ts> only once a second such row arrives, so its id and the j/k cursor on it change then (rare; uniqueKeys in briefingmodel.ts)
**Chunk:** Brief: the WAITING ON YOU section header still shows the unfiltered total while a filter is active (F16 covered the summary and chips only)
**Chunk:** Initiative form: the Edit footer renders an empty span where the removed line was (cosmetic)
**Files:** `frontend/app/view/jarvis/briefingmodel.ts`, `frontend/app/view/jarvis/briefingmodel.test.ts`, `frontend/app/view/jarvis/briefwaiting.tsx`, `frontend/app/view/jarvis/briefprimitives.tsx`, `frontend/app/view/jarvis/briefsurface.tsx`, `frontend/app/view/jarvis/briefrows.ts`, `frontend/app/view/jarvis/briefrows.test.ts`, `frontend/app/view/jarvis/effortcreateform.tsx`, `frontend/app/view/jarvis/briefingfixtures.ts`, `scripts/cdp/scenarios-brief.mjs`

Implements spec D9, D10, D11.

- [ ] F11 test first in `briefingmodel.test.ts`: `mergeActiveWork` with one keyless run row gives the same key for that row as `mergeActiveWork` with that row plus a second keyless row of a different ts; two keyless rows with the same ts still get distinct keys. Then key a keyless run row from its own ts in `mergeActiveWork` and reduce `uniqueKeys` to the ordinal for exact collisions (update its comment).
- [ ] F14: a pure count label (in `briefrows.ts`, tested in `briefrows.test.ts`): no filter → `"M"`; filter → `"N of M"`. `RegionHead`'s `count` accepts the label; the Waiting region passes it, N being the queue rows the filter keeps (the same filter the Waiting summary uses).
- [ ] F16: in Edit, `effortcreateform.tsx`'s footer renders no hint span and Cancel/Save stay right-aligned.
- [ ] Run `npx vitest run frontend/app/view/jarvis/briefingmodel.test.ts frontend/app/view/jarvis/briefrows.test.ts`.
- [ ] Scenario steps in `scenarios-brief.mjs`: in `brief-act`, extend or follow step 40 so the Waiting header reads `0 of <N>` under the no-match filter and `<N>` once cleared, and add a step for F11. Keyless run rows come from `active` items of kind `run` with no `navtarget` (briefingmodel.ts:664), and no fixture has one: add two fixtures to `briefingfixtures.ts`, selected through `briefingFixtureAtom` as `actFixture(h, name)` does, `keyless-one` (one keyless run item) and `keyless-two` (the same item plus a second keyless run item with a different ts). The step opens `keyless-one`, puts the j/k cursor on the keyless row, switches to `keyless-two`, and asserts that row's key attribute and the cursor on it are unchanged; in `brief-act` or `brief-live-initiative` (whichever opens the initiative Edit form), a step asserting the Edit footer has no empty span and Cancel/Save are right-aligned (screenshot). Acceptance: those steps pass in Final.

### Task 9: Remove the Markdown TOC (F13)
**Depends on:** none
**Chunk:** Markdown TOC is dead code: no caller passes showTocAtom. Its jump scrolls the OS viewport, which never scrolls without the overlayscrollbars css, and .toc keeps overflow:scroll. Remove it or fix it.
**Files:** `frontend/app/element/markdown.tsx`, `frontend/app/element/markdown.scss`

Implements spec D12.

- [ ] Grep every reference first (`showTocAtom`, `tocRef`, `TocItem`, `RemarkFlexibleToc`, `remark-flexible-toc`, `toc-item`, `toc-inner`, `.toc`, the TOC jump effect) across `frontend/` and `scripts/`; any caller outside these two files means stop and report.
- [ ] Remove from `markdown.tsx` the `showTocAtom` prop, its read, `tocRef`, the `RemarkFlexibleToc` plugin entry and import, the `toc` memo, its render and the jump effect; remove the `.toc` rules from `markdown.scss`. Leave `remark-flexible-toc` in package.json (spec D12) and name it in the report as a follow-up.
- [ ] Run `task check:ts` and `npx eslint frontend/app/element/markdown.tsx`.
- [ ] Acceptance: `code-markdown` passes unchanged in Final (Markdown still renders).

### Task 10: final-verify exits with its result's code (F8)
**Depends on:** none
**Chunk:** final-verify.mjs can exit 127 after a fully passing result (libuv UV_HANDLE_CLOSING assertion at node teardown, src/win/async.c:76); a passing Final could read as failed
**Files:** `scripts/cdp/final-verify.mjs`, `scripts/cdp/final-verify.test.mjs`

Implements spec D13.

- [ ] Find the handles still open at `process.exit` (`process.getActiveResourcesInfo()` logged just before exit on a real run): at least the dev child's stdin pipe (`stdio: ["pipe", log, log]`), the log file descriptors and any CDP socket.
- [ ] Before exiting, close or destroy each and await its close (child stdio destroyed after `killTree`, the lock closed, sockets ended), then exit with the outcome's code. If a handle cannot be awaited, set `process.exitCode` and let the loop drain instead of calling `process.exit` on the pass path.
- [ ] If the teardown is extracted to a function, test it in `final-verify.test.mjs` (`npx vitest run scripts/cdp/final-verify.test.mjs`): it resolves only after the child's streams report closed.
- [ ] Run `node scripts/cdp/final-verify.mjs surface-smoke` once and record its exit code and that no `UV_HANDLE_CLOSING` assertion printed. Acceptance: this run's own Final exits with its result's code.
