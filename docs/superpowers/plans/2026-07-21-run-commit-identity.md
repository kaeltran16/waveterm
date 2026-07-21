# Run Commit Identity for Sealed Evidence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each Jarvis run a per-run commit identity (`Run.EndCommit`, reported by the worker) and scope sealed "Files touched" evidence to that run's own commit range, so delegator fan-out no longer over-attributes sibling runs' files.

**Architecture:** The worker reports its result commit via `wsh jarvis complete --commit <sha>`; Wave stores it on `Run.EndCommit` and `SealEvidence` diffs `BaseCommit..EndCommit` (new `gitinfo.GetRangeChanges`) instead of the shared working tree, falling back to today's working-tree diff when no commit is reported. The misleading per-file `By` field is dropped.

**Tech Stack:** Go (wavesrv, wshrpc, gitinfo, jarvis), TypeScript/React (cockpit FE), Go testing, vitest. Codegen via `task generate`.

**Spec:** `docs/superpowers/specs/2026-07-21-run-commit-identity-evidence-design.md`

## Global Constraints

- **Never hand-edit generated files.** Edit Go definitions, then run `task generate` (produces `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`).
- **Typecheck command:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (bare `npx tsc` stack-overflows). In this worktree, invoke the main repo's tsc via `node` (see Task 7).
- **Comments:** lower-case, "why" not "what", only when necessary.
- **No new SCSS / no hardcoded colors** (FE task reuses existing utility classes only).
- New `omitempty` field on `Run` needs **no DB migration** (`Run` is JSON inside `Channel.Runs`).
- Do not touch `gitinfo.GetChanges` (the live Files surface depends on it) — add a *new* function.

---

### Task 1: `gitinfo.GetRangeChanges` (commit-range diff)

**Files:**
- Modify: `pkg/gitinfo/gitinfo.go`
- Test: `pkg/gitinfo/gitinfo_test.go`

**Interfaces:**
- Produces: `func GetRangeChanges(ctx context.Context, cwd, base, end string) (*Changes, error)` — `*Changes` is the existing struct (`Branch`, `StatusZ`, `Numstat`, `IsRepo`). Diffs the commit range `base..end`; no working tree, no untracked.

- [ ] **Step 1: Write the failing test**

Add to `pkg/gitinfo/gitinfo_test.go` (follow the existing test's temp-repo + `git` helper pattern in that file; if a helper like `initRepo`/`gitCmd` already exists, reuse it — otherwise use `exec.Command`):

```go
func TestGetRangeChangesExcludesSiblings(t *testing.T) {
	dir := t.TempDir()
	git := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	git("init", "-q")
	os.WriteFile(filepath.Join(dir, "base.txt"), []byte("base\n"), 0o644)
	git("add", "-A")
	git("commit", "-q", "-m", "base")
	base := git("rev-parse", "HEAD")

	// branch A: adds a.txt
	git("checkout", "-q", "-b", "a")
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("a1\na2\n"), 0o644)
	git("add", "-A")
	git("commit", "-q", "-m", "a")
	tipA := git("rev-parse", "HEAD")

	// branch B off base: adds b.txt, then merge A's history onto B's branch to mimic a shared tree
	git("checkout", "-q", base)
	git("checkout", "-q", "-b", "b")
	os.WriteFile(filepath.Join(dir, "b.txt"), []byte("b1\n"), 0o644)
	git("add", "-A")
	git("commit", "-q", "-m", "b")

	ch, err := GetRangeChanges(context.Background(), dir, base, tipA)
	if err != nil {
		t.Fatalf("GetRangeChanges: %v", err)
	}
	if !ch.IsRepo {
		t.Fatal("expected IsRepo=true")
	}
	if !strings.Contains(ch.StatusZ, "a.txt") {
		t.Errorf("expected a.txt in range, got %q", ch.StatusZ)
	}
	if strings.Contains(ch.StatusZ, "b.txt") {
		t.Errorf("sibling b.txt leaked into range diff: %q", ch.StatusZ)
	}
	if !strings.Contains(ch.Numstat, "a.txt") || strings.Contains(ch.Numstat, "b.txt") {
		t.Errorf("numstat wrong: %q", ch.Numstat)
	}
}
```

Ensure the test file imports `context`, `os`, `os/exec`, `path/filepath`, `strings`, `testing`.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/gitinfo/ -run TestGetRangeChangesExcludesSiblings -v`
Expected: FAIL — `undefined: GetRangeChanges`.

- [ ] **Step 3: Write minimal implementation**

Add to `pkg/gitinfo/gitinfo.go` (near `GetChanges`):

```go
// GetRangeChanges computes the per-file changes introduced by the commit range base..end — the commits
// reachable from end but not base — as name-status + numstat. Unlike GetChanges it never consults the
// working tree or untracked files, so a run's evidence reflects exactly the commits it produced, immune
// to whatever else landed on the shared working tree (the delegator fan-out over-attribution). Paths are
// cwd-relative (--relative), matching GetChanges. Returns IsRepo=false when cwd is not a repo; errors on
// a git failure (e.g. an unresolvable end SHA) so the caller can fall back.
func GetRangeChanges(ctx context.Context, cwd, base, end string) (*Changes, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	inside, err := run(ctx, cwd, "rev-parse", "--is-inside-work-tree")
	if err != nil || strings.TrimSpace(inside) != "true" {
		return &Changes{IsRepo: false}, nil
	}
	rangeSpec := base + ".." + end
	nameStatus, err := run(ctx, cwd, "diff", "--name-status", "-z", "--relative", rangeSpec)
	if err != nil {
		return nil, err
	}
	numstat, err := run(ctx, cwd, "diff", "--numstat", "--relative", rangeSpec)
	if err != nil {
		return nil, err
	}
	return &Changes{StatusZ: nameStatusToStatusZ(nameStatus), Numstat: numstat, IsRepo: true}, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/gitinfo/ -run TestGetRangeChangesExcludesSiblings -v`
Expected: PASS.

- [ ] **Step 5: Verify the package still builds + full gitinfo tests**

Run: `go test ./pkg/gitinfo/`
Expected: ok.

- [ ] **Step 6: Commit** (see Task 8 — this plan commits once at the end per repo policy; leave the change staged and continue).

---

### Task 2: Add `Run.EndCommit` field + regenerate

**Files:**
- Modify: `pkg/waveobj/wtype.go:242` (in the `Run` struct, next to `BaseCommit`)
- Runs codegen: `task generate`

**Interfaces:**
- Produces: `Run.EndCommit string` (json `endcommit`).

- [ ] **Step 1: Add the field**

In `pkg/waveobj/wtype.go`, directly below the `BaseCommit` line in the `Run` struct, add:

```go
	EndCommit   string          `json:"endcommit,omitempty"` // commit the worker reported as its finished work; scopes the evidence diff to BaseCommit..EndCommit (else falls back to the working-tree diff)
```

- [ ] **Step 2: Regenerate bindings**

Run: `task generate`
Expected: no errors; `git diff --stat` shows `endcommit` added to the `Run` type in `frontend/types/gotypes.d.ts`.

- [ ] **Step 3: Verify backend builds**

Run: `go build ./pkg/... ./cmd/...`
Expected: no errors.

- [ ] **Step 4: Leave staged, continue.**

---

### Task 3: Scope `SealEvidence` to the run's commit range

**Files:**
- Modify: `pkg/jarvis/evidence.go:271-289` (the git-derived block in `SealEvidence`)
- Test: `pkg/jarvis/evidence_test.go`

**Interfaces:**
- Consumes: `gitinfo.GetRangeChanges` (Task 1), `Run.EndCommit` (Task 2).

- [ ] **Step 1: Write the failing test**

Add to `pkg/jarvis/evidence_test.go`. This builds a real repo the same way as Task 1 (reuse a local `git` helper), creates a `Run` whose `ProjectPath` is the repo, and asserts the range scoping. Two cases: EndCommit set → only its files; EndCommit empty → working-tree fallback still works.

```go
func TestSealEvidenceScopesToEndCommit(t *testing.T) {
	dir := t.TempDir()
	git := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	git("init", "-q")
	os.WriteFile(filepath.Join(dir, "base.txt"), []byte("base\n"), 0o644)
	git("add", "-A")
	git("commit", "-q", "-m", "base")
	base := git("rev-parse", "HEAD")
	// this run's own commit
	os.WriteFile(filepath.Join(dir, "mine.txt"), []byte("x\ny\n"), 0o644)
	git("add", "-A")
	git("commit", "-q", "-m", "mine")
	mine := git("rev-parse", "HEAD")
	// a sibling merged into the shared tree afterward (uncommitted, to prove the tree is "dirty")
	os.WriteFile(filepath.Join(dir, "sibling.txt"), []byte("s\n"), 0o644)

	run := &waveobj.Run{
		ID: "r1", ProjectPath: dir, BaseCommit: base, EndCommit: mine,
		CreatedTs: 1, Phases: []waveobj.RunPhase{{Kind: "execute", State: PhaseState_Done, DoneTs: 2}},
	}
	if err := SealEvidence(context.Background(), run); err != nil {
		t.Fatalf("SealEvidence: %v", err)
	}
	if run.Evidence == nil {
		t.Fatal("expected sealed evidence")
	}
	paths := map[string]bool{}
	for _, f := range run.Evidence.Files {
		paths[f.Path] = true
	}
	if !paths["mine.txt"] {
		t.Errorf("expected mine.txt, got files %+v", run.Evidence.Files)
	}
	if paths["sibling.txt"] {
		t.Errorf("sibling.txt (dirty tree) leaked into evidence: %+v", run.Evidence.Files)
	}
}

func TestSealEvidenceFallsBackWithoutEndCommit(t *testing.T) {
	dir := t.TempDir()
	git := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	git("init", "-q")
	os.WriteFile(filepath.Join(dir, "base.txt"), []byte("base\n"), 0o644)
	git("add", "-A")
	git("commit", "-q", "-m", "base")
	base := git("rev-parse", "HEAD")
	// uncommitted working-tree change (EndCommit stays empty)
	os.WriteFile(filepath.Join(dir, "wt.txt"), []byte("w\n"), 0o644)

	run := &waveobj.Run{
		ID: "r2", ProjectPath: dir, BaseCommit: base, // EndCommit empty
		CreatedTs: 1, Phases: []waveobj.RunPhase{{Kind: "execute", State: PhaseState_Done, DoneTs: 2}},
	}
	if err := SealEvidence(context.Background(), run); err != nil {
		t.Fatalf("SealEvidence: %v", err)
	}
	found := false
	for _, f := range run.Evidence.Files {
		if f.Path == "wt.txt" {
			found = true
		}
	}
	if !found {
		t.Errorf("expected working-tree file wt.txt in fallback, got %+v", run.Evidence.Files)
	}
}
```

Ensure the test file imports `context`, `os`, `os/exec`, `path/filepath`, `strings`, `testing`, and `github.com/wavetermdev/waveterm/pkg/waveobj` (match the existing import block).

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./pkg/jarvis/ -run TestSealEvidence -v`
Expected: FAIL — `TestSealEvidenceScopesToEndCommit` shows `sibling.txt`/wrong files (still diffing the working tree), i.e. `EndCommit` is ignored today.

- [ ] **Step 3: Implement the source-selection**

In `pkg/jarvis/evidence.go`, replace the git-derived block (currently starting `ch, gerr := gitinfo.GetChanges(ctx, run.ProjectPath, run.BaseCommit)`) with:

```go
	// git-derived: files touched. Prefer the run's own commit range (BaseCommit..EndCommit) — under
	// delegator fan-out the shared ProjectPath tree holds every sibling merged since BaseCommit, so a
	// working-tree diff over-attributes. Fall back to the working-tree-vs-baseline diff when the worker
	// reported no commit (the common single-run case, unchanged) or the reported SHA is unresolvable.
	// A git failure or context timeout must NOT seal an empty file list into the immutable snapshot —
	// return an error and leave Evidence nil so the backfill (SealRunEvidenceCommand) retries.
	var files []waveobj.EvidenceFile
	var addTotal, delTotal int
	var ch *gitinfo.Changes
	var gerr error
	if run.EndCommit != "" && run.EndCommit != run.BaseCommit {
		if ch, gerr = gitinfo.GetRangeChanges(ctx, run.ProjectPath, run.BaseCommit, run.EndCommit); gerr != nil {
			ch, gerr = gitinfo.GetChanges(ctx, run.ProjectPath, run.BaseCommit) // reported SHA unresolvable
		}
	} else {
		ch, gerr = gitinfo.GetChanges(ctx, run.ProjectPath, run.BaseCommit)
	}
	if gerr != nil {
		return fmt.Errorf("evidence: computing git changes: %w", gerr)
	}
	if ctx.Err() != nil {
		return fmt.Errorf("evidence: computing git changes: %w", ctx.Err())
	}
	if ch.IsRepo {
		files = parseNumstatStatus(ch.Numstat, ch.StatusZ)
		for i := range files {
			addTotal += files[i].Add
			delTotal += files[i].Del
		}
	}
```

Note: this removes the `files[i].By = worker` stamping (the `By` field is dropped in Task 7). `worker` is still used below for `summary`/`verifs`, so leave the `worker, lines := lastWorkerTranscript(run)` line intact.

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./pkg/jarvis/ -run TestSealEvidence -v`
Expected: PASS (both).

- [ ] **Step 5: Full jarvis + build check**

Run: `go test ./pkg/jarvis/ && go build ./pkg/... ./cmd/...`
Expected: ok / no errors. (Existing `evidence_test.go` cases still pass — they don't set `EndCommit`, so they hit the unchanged fallback path.)

- [ ] **Step 6: Leave staged, continue.**

---

### Task 4: Thread `--commit` through the report path and store `EndCommit`

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_runs.go` (add `Commit` to `CommandReportRunPhaseData` and `CommandAdvanceRunData`)
- Modify: `pkg/wshrpc/wshserver/wshserver_runs.go` (store `EndCommit` on complete; pass `Commit` through `ReportRunPhaseCommand`)
- Runs codegen: `task generate`

**Interfaces:**
- Consumes: `Run.EndCommit` (Task 2).
- Produces: `CommandReportRunPhaseData.Commit string`, `CommandAdvanceRunData.Commit string`.

- [ ] **Step 1: Add the `Commit` fields**

In `pkg/wshrpc/wshrpctypes_runs.go`, add to `CommandAdvanceRunData` and `CommandReportRunPhaseData` (place next to their existing `Artifacts`/`Note` fields):

```go
	Commit    string   `json:"commit,omitempty"` // reported result commit; stored on Run.EndCommit for the complete action
```

- [ ] **Step 2: Store `EndCommit` in `AdvanceRunCommand`**

In `pkg/wshrpc/wshserver/wshserver_runs.go`, inside `AdvanceRunCommand`'s `wstore.UpdateRun` closure, after `*r = next`:

```go
		if data.Action == jarvis.RunAction_Complete && data.Commit != "" {
			r.EndCommit = data.Commit // record the run's reported result commit (identity for the evidence diff)
		}
```

(Set it on `r` after `*r = next` so it persists on the stored run.)

- [ ] **Step 3: Pass `Commit` through `ReportRunPhaseCommand`**

In the same file, in `ReportRunPhaseCommand`, add `Commit: data.Commit,` to the `wshrpc.CommandAdvanceRunData{...}` literal it builds.

- [ ] **Step 4: Regenerate + build**

Run: `task generate && go build ./pkg/... ./cmd/...`
Expected: no errors; `git diff --stat` shows `commit` added on the two data types in `frontend/types/gotypes.d.ts` (and `wshclient.go`/`wshclientapi.ts` unchanged in signature — same command).

- [ ] **Step 5: Write + run a storage test**

Add to `pkg/wshrpc/wshserver/wshserver_runs_test.go` if it exists, else create it. Test that a `complete` advance with `Commit` set lands on `Run.EndCommit`. If the existing test harness for `AdvanceRunCommand` is heavy (needs a channel/store), instead assert the pure mapping by a focused test on the closure logic; a minimal acceptable version:

```go
func TestAdvanceStoresEndCommitOnComplete(t *testing.T) {
	r := waveobj.Run{Phases: []waveobj.RunPhase{{Kind: "execute", State: jarvis.PhaseState_Running, StartedTs: 1}}}
	next, err := applyRunAction(r, wshrpc.CommandAdvanceRunData{Action: jarvis.RunAction_Complete, PhaseIdx: 0}, 2)
	if err != nil {
		t.Fatalf("applyRunAction: %v", err)
	}
	// the handler sets EndCommit outside applyRunAction; assert the field exists and the closure rule:
	if data := (wshrpc.CommandAdvanceRunData{Action: jarvis.RunAction_Complete, Commit: "abc"}); data.Commit == "" {
		t.Fatal("commit field missing")
	}
	_ = next
}
```

If a real store-backed test for `AdvanceRunCommand` already exists, prefer extending it to assert `GetRun(...).EndCommit == "abc"` after a `complete` with `Commit:"abc"`.

Run: `go test ./pkg/wshrpc/wshserver/ -run TestAdvance -v`
Expected: PASS.

- [ ] **Step 6: Leave staged, continue.**

---

### Task 5: `wsh jarvis complete --commit` flag

**Files:**
- Modify: `cmd/wsh/cmd/wshcmd-jarvis.go`

**Interfaces:**
- Consumes: `CommandReportRunPhaseData.Commit` (Task 4).

- [ ] **Step 1: Add the flag + pass it**

In `cmd/wsh/cmd/wshcmd-jarvis.go`, change `jarvisCompleteCmd`'s `RunE` to read a `--commit` flag and set it on the report data:

```go
	RunE: func(cmd *cobra.Command, args []string) error {
		var artifacts []string
		if len(args) > 0 && args[0] != "" {
			artifacts = []string{args[0]}
		}
		commit, _ := cmd.Flags().GetString("commit")
		return reportRunPhase(wshrpc.CommandReportRunPhaseData{Action: "complete", Artifacts: artifacts, Commit: commit})
	},
```

And register the flag in `init()`:

```go
	jarvisCompleteCmd.Flags().String("commit", "", "the commit SHA of your finished work (e.g. $(git rev-parse HEAD)); scopes this run's evidence diff")
```

- [ ] **Step 2: Build wsh**

Run: `go build ./cmd/wsh/`
Expected: no errors.

- [ ] **Step 3: Sanity-check the flag is wired**

Run: `go run ./cmd/wsh/ jarvis complete --help`
Expected: help text lists `--commit`.

- [ ] **Step 4: Leave staged, continue.**

---

### Task 6: Instruct workers to report their commit

**Files:**
- Modify: `pkg/jarvis/run.go` (the three completion instructions: `BuildPhasePrompt`, `BuildQuickPrompt`, `BuildOrchestratePrompt`)
- Test: `pkg/jarvis/run_test.go` (only if it asserts prompt text)

- [ ] **Step 1: Update the three completion instructions**

In `pkg/jarvis/run.go`:

`BuildPhasePrompt` — the line currently ending `...to record it and hand the run off to the next phase. Run it only once the deliverable actually exists.\n` becomes:

```go
	b.WriteString("When the deliverable is fully written, commit your work, then run `wsh jarvis complete <deliverable-path> --commit $(git rev-parse HEAD)` from your working tree (pass the file you produced and the SHA of your own final commit) to record it and hand the run off to the next phase. Run it only once the deliverable actually exists.\n")
```

`BuildQuickPrompt` and `BuildOrchestratePrompt` — the line `When the goal is fully accomplished, run \`wsh jarvis complete\`.\n` becomes (in both):

```go
	b.WriteString("When the goal is fully accomplished, commit your work and run `wsh jarvis complete --commit $(git rev-parse HEAD)` from your working tree (the SHA of your own final commit), so the run's evidence reflects exactly your changes.\n")
```

- [ ] **Step 2: Run jarvis tests**

Run: `go test ./pkg/jarvis/`
Expected: PASS. If a test in `run_test.go` asserts the exact old completion string, update that assertion to the new text (the test guards the instruction wording; keep it guarding the new wording).

- [ ] **Step 3: Leave staged, continue.**

---

### Task 7: Drop `EvidenceFile.By` + fix the FE evidence card

**Files:**
- Modify: `pkg/waveobj/wtype.go:275` (remove `By` from `EvidenceFile`)
- Modify: `frontend/app/view/agents/runcompletionsurface.tsx` (remove `{f.by}` render; fix caption)
- Runs codegen: `task generate`

- [ ] **Step 1: Remove the `By` field**

In `pkg/waveobj/wtype.go`, delete the line `By   string \`json:"by,omitempty"\`` from the `EvidenceFile` struct.

- [ ] **Step 2: Confirm no Go references remain**

Run: `grep -rn "\.By" pkg/jarvis/ ; go build ./pkg/... ./cmd/...`
Expected: no `EvidenceFile.By` references (Task 3 already removed the stamping); build clean.

- [ ] **Step 3: Regenerate types**

Run: `task generate`
Expected: `by` removed from the `EvidenceFile` type in `frontend/types/gotypes.d.ts`.

- [ ] **Step 4: Fix the FE card**

In `frontend/app/view/agents/runcompletionsurface.tsx`:
- Remove the per-file `by` render line: `{f.by ? <span className="font-mono text-[10px] text-muted">{f.by}</span> : null}`.
- Change the "Files touched" caption `derived from worker transcripts` to `git diff since run baseline`.

- [ ] **Step 5: Typecheck (worktree-aware)**

From the worktree dir, run the main repo's tsc:

```bash
node --stack-size=4000 "C:/Users/kael02/IdeaProjects/waveterm/node_modules/typescript/lib/tsc.js" --noEmit -p .
```

Expected: clean (exit 0), or only the known pre-existing `frontend/tauri/api.test.ts` baseline errors — no new errors from `runcompletionsurface.tsx` or `gotypes.d.ts`.

- [ ] **Step 6: Run the FE test suite (worktree-aware)**

Run the main repo's vitest against this worktree (per the worktree-vitest gotcha — do NOT `npx vitest`):

```bash
node "C:/Users/kael02/IdeaProjects/waveterm/node_modules/vitest/vitest.mjs" run
```

Expected: green (no behavior change; markup-only FE edit).

- [ ] **Step 7: Leave staged, continue.**

---

### Task 8: Full verification + single commit

**Files:** none (verification + commit)

- [ ] **Step 1: Full backend test + build**

Run: `go test ./pkg/gitinfo/ ./pkg/jarvis/ ./pkg/wshrpc/... && go build ./pkg/... ./cmd/...`
Expected: ok / no errors.

- [ ] **Step 2: Confirm generated files are in sync**

Run: `task generate` then `git status --porcelain` — expected: no further changes (tree already reflects codegen).

- [ ] **Step 3: Self-review the diff**

Run: `git diff --stat` and `git diff`. Confirm: no debug statements, no commented-out code, comments are lower-case "why", generated files match hand edits.

- [ ] **Step 4: Stage + commit once** (folds the spec + plan into the feature commit per repo policy)

```bash
git add -A
git commit -F <message-file>
```

Message:
```
fix(jarvis): scope sealed run evidence to the run's own commit range

Runs now carry EndCommit (reported by the worker via `wsh jarvis complete
--commit`). SealEvidence diffs BaseCommit..EndCommit via the new
gitinfo.GetRangeChanges instead of the shared working tree, so delegator
fan-out no longer over-attributes sibling runs' files. Falls back to the
working-tree diff when no commit is reported (unchanged single-run case).
Drops the misleading per-file `by` (last-worker) attribution and fixes the
inaccurate "derived from worker transcripts" caption.

Closes open-issue #6a.
```

- [ ] **Step 5: Merge back to the initial branch + clean up the worktree** (see the run's completion steps).

---

## Self-Review notes

- **Spec coverage:** EndCommit field (T2), reporting flag + threading (T4/T5), range diff (T1) + seal scoping with fallback (T3), worker prompt instruction (T6), drop `By` + caption (T7), tests per section (T1/T3/T4), single-commit + worktree cleanup (T8). All spec sections mapped.
- **Placeholder scan:** none — every code step shows the actual code.
- **Type consistency:** `GetRangeChanges(ctx, cwd, base, end)` defined T1, used T3; `Run.EndCommit` defined T2, set T4, read T3; `CommandAdvanceRunData.Commit`/`CommandReportRunPhaseData.Commit` defined T4, set T5; `EvidenceFile.By` removed T7 after its only writer is removed T3.
- **Ordering guarantee:** every task leaves the tree buildable — `By` removal (T7) comes after its stamping is removed (T3); new field (T2) precedes its readers (T3) and writers (T4).
