# Agent's edits: round 1 fixes

**Spec:** `docs/superpowers/specs/2026-11-18-agent-edits-range-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/gitinfo ./pkg/wshrpc/... $(test -d pkg/agentedits && echo ./pkg/agentedits)`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && go vet ./pkg/wshrpc/... $(test -d pkg/agentedits && echo ./pkg/agentedits)`
**Final:** `node scripts/cdp/final-verify.mjs diff-agent-edits diff-scope diff-source-row diff-comments diff-push workspace-changes surface-headers`

Two defects the run's tasks reported and left open: t-3 found that a path spelled in another case than git's
index entry splits into a delete plus an add, and t-5 noted that the commit pane heads the synthetic B..H range
"Working tree". The two tasks share no file.

### Task 1: A path spelled in another case maps onto git's own entry
**Depends on:** none
**Files:** `pkg/agentedits/commits.go`, `pkg/agentedits/commits_test.go`, `pkg/agentedits/agentedits.go`, `pkg/agentedits/agentedits_test.go`, `pkg/wshrpc/wshserver/wshserver_agentedits.go`, `pkg/wshrpc/wshserver/wshserver_agentedits_test.go`

**What to build:** in a repository whose git config has `core.ignorecase=true` (the Windows default), an agent
that names a tracked file in a different case than the anchor commit's tree (`SRC/foo.txt` for `src/Foo.txt`)
gets that file read, committed and reported under the tree's own spelling. Today `File.Path` keeps the agent's
spelling, so the base read misses, the temporary index gains a second entry and `B..H` shows a delete plus an
add. Decide from git's `core.ignorecase`, not from the OS, so the behaviour is testable on any platform; with
`core.ignorecase` false or unset, paths stay as spelled. A path the tree does not hold (a file the agent
created) keeps the agent's spelling. Where the mapping happens (before `Replay` through the base lookup, or in
the handler) is the worker's call; it must happen once, so the base read, the commits and the reply agree.

**Acceptance:**
- In a temporary repository with `core.ignorecase=true` and tracked `src/Foo.txt`, a transcript whose Edit
  names `<root>/SRC/foo.txt` (with a `file-history-delta` backup) yields `git diff --name-status B H` of exactly
  one line, `M	src/Foo.txt`, and the reply's `files[]` holds `src/Foo.txt` with no flag.
- The same transcript without a backup record reads its pre-image from the anchor's `src/Foo.txt` (the diff is
  still one `M` line) and flags the file `approximate`.
- With `core.ignorecase=false`, the same spelling is not remapped.
- A created file's path keeps the agent's spelling.

### Task 2: The commit pane names the edits range instead of "Working tree"
**Depends on:** none
**Files:** `frontend/app/view/agents/historyrows.ts`, `frontend/app/view/agents/historyrows.test.ts`, `frontend/app/view/agents/commitpane.tsx`, `frontend/app/view/agents/filessurface.tsx`, `scripts/cdp/scenarios-files-edits.mjs`

**What to build:** the commit pane's label for the scope's own row (`WorkingTreeHeader` and `LineHeader` in
`commitpane.tsx`, both hard-coded "Working tree") reads "Agent's edits" when the range is the edits range,
because its B..H commits are rebuilt from the transcript, not read from the working tree. Every other range
keeps "Working tree". The label comes from a pure function in `historyrows.ts` beside `worktreeCaption`, reusing
diffscope's label for the edits range rather than a second copy of the string, and `filessurface.tsx` passes it
to `CommitPane`. In the full header, the row subject is not repeated under a label that already says the same.
No new tokens; the dashed warning dot stays.

**Acceptance:**
- The heading function returns "Agent's edits" for an edits range and "Working tree" for the working, session,
  run and compare ranges.
- `diff-agent-edits` gains a step: with the edits chip pressed and the scope's row selected, the commit pane's
  header reads "Agent's edits" and no "Working tree" text is in that pane. Steps before it keep passing.
- `diff-source-row` and `diff-scope` still pass unchanged (their working-tree and session rows keep
  "Working tree").
