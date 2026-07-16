# Run Evidence Base-Anchored Diff — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make run evidence diffs survive commits — capture a base commit at run start, diff against it, and open the run's changes in the Diff tab.

**Architecture:** Add `Run.BaseCommit` (project `HEAD` at creation). Give `gitinfo.GetChanges`/`GetDiff` an optional `ref`; `ref == ""` reproduces today's `HEAD`-anchored behavior verbatim, `ref != ""` diffs base→working-tree (committed + uncommitted). The evidence seal and a new read-only Diff-tab "run source" pass the base commit; the completion card's "Open repository diff" button switches to that source instead of opening the OS folder.

**Tech Stack:** Go (backend, `pkg/gitinfo` / `pkg/jarvis` / `pkg/wshrpc`), TypeScript + React + jotai (frontend, `frontend/app/view/agents`), Task-driven codegen (`task generate`).

## Global Constraints

- **Typecheck command:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (bare `npx tsc` stack-overflows on this repo). Baseline is clean (exit 0).
- **Codegen:** after any change to `pkg/waveobj` or `pkg/wshrpc/wshrpctypes.go`, run `task generate`. Never hand-edit generated files (`frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts`, `pkg/wshrpc/wshclient/wshclient.go`).
- **Backward-compat contract:** `gitinfo.GetChanges`/`GetDiff` with `ref == ""` MUST produce byte-identical output to today. This is regression-guarded by the existing `gitinfo` tests (updated to pass `""`).
- **No new SCSS, no raw hex colors** — use existing `@theme` tokens (no new UI colors are introduced here anyway).
- **Git policy (repo convention overrides the skill's per-task commit):** do NOT commit without explicit user approval. Each task ends with a **Checkpoint** (stage + full verification), not a commit. All tasks + the spec doc fold into a **single** commit at the end, made only after the user approves. Do not add a Co-Authored-By trailer.
- **No render-test harness exists for the cockpit.** Frontend behavior is verified by typecheck + CDP against the live dev app (`node scripts/cdp-shot.mjs`, `node scripts/inject-live-agents.mjs`), per project convention.

---

### Task 1: `Run.BaseCommit` + `HeadCommit` + capture at run creation

**Files:**
- Modify: `pkg/gitinfo/gitinfo.go` (add `HeadCommit`)
- Test: `pkg/gitinfo/gitinfo_test.go` (add `TestHeadCommit`)
- Modify: `pkg/waveobj/wtype.go:237-251` (add `Run.BaseCommit`)
- Modify: `pkg/wshrpc/wshserver/wshserver.go:1855` (capture in `CreateRunCommand`)
- Regenerate: `frontend/types/gotypes.d.ts` via `task generate`

**Interfaces:**
- Produces: `gitinfo.HeadCommit(ctx context.Context, cwd string) (string, error)` — trimmed SHA of `HEAD`, error when not a repo / no commits.
- Produces: `waveobj.Run.BaseCommit string` (json `basecommit`).

- [ ] **Step 1: Write the failing test**

Add to `pkg/gitinfo/gitinfo_test.go`:

```go
func TestHeadCommit(t *testing.T) {
	dir := repoWithChange(t) // has one commit ("init") + uncommitted edits
	sha, err := HeadCommit(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(strings.TrimSpace(sha)) != 40 {
		t.Fatalf("HeadCommit = %q, want a 40-char sha", sha)
	}
	// not a repo -> error, empty
	if _, err := HeadCommit(context.Background(), t.TempDir()); err == nil {
		t.Fatal("expected error for a non-repo dir")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/gitinfo/ -run TestHeadCommit`
Expected: FAIL — `undefined: HeadCommit`.

- [ ] **Step 3: Implement `HeadCommit`**

Add to `pkg/gitinfo/gitinfo.go` (after `GetChanges`, before `stripPrefixZ`):

```go
// HeadCommit returns the trimmed SHA of HEAD in cwd. Errors when cwd is not a repo or has no commits
// yet — callers treat that as "no baseline" and degrade gracefully.
func HeadCommit(ctx context.Context, cwd string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	out, err := run(ctx, cwd, "rev-parse", "HEAD")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out), nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/gitinfo/ -run TestHeadCommit`
Expected: PASS.

- [ ] **Step 5: Add the `BaseCommit` field**

In `pkg/waveobj/wtype.go`, inside `type Run struct` (after the `ProjectPath` line at `:243`):

```go
	BaseCommit  string          `json:"basecommit,omitempty"` // HEAD of ProjectPath at run creation; anchors the evidence diff
```

- [ ] **Step 6: Capture the base commit in `CreateRunCommand`**

In `pkg/wshrpc/wshserver/wshserver.go`, in `CreateRunCommand`, immediately after the `run := jarvis.NewRun(...)` line (`:1855`) and before `run.RadarOrigin = data.RadarOrigin`:

```go
	// capture the repo baseline so the evidence diff survives the worker committing its changes;
	// non-fatal — an unborn/absent repo just leaves BaseCommit "" and the diff falls back to HEAD.
	if head, herr := gitinfo.HeadCommit(ctx, ch.ProjectPath); herr == nil {
		run.BaseCommit = head
	}
```

Confirm `gitinfo` is already imported in this file (it is — `GitChangesCommand` uses it). No new import needed.

- [ ] **Step 7: Regenerate bindings and build**

Run: `task generate`
Then: `grep -n basecommit frontend/types/gotypes.d.ts`
Expected: a `basecommit?: string;` line inside the `Run` type.
Then: `go build ./pkg/...`
Expected: exit 0.

- [ ] **Step 8: Checkpoint**

Run: `go test ./pkg/gitinfo/`
Expected: PASS (all gitinfo tests still green).
Stage: `git add pkg/gitinfo/gitinfo.go pkg/gitinfo/gitinfo_test.go pkg/waveobj/wtype.go pkg/wshrpc/wshserver/wshserver.go frontend/types/gotypes.d.ts`
Do NOT commit (see Global Constraints).

---

### Task 2: `gitinfo` ref-mode + RPC `Ref` + seal against base

**Files:**
- Modify: `pkg/gitinfo/gitinfo.go` (`GetChanges`/`GetDiff` gain `ref`; add `nameStatusToStatusZ`, `untrackedEntriesZ`)
- Test: `pkg/gitinfo/gitinfo_test.go` (add ref tests; update existing call sites to pass `""`)
- Modify: `pkg/wshrpc/wshrpctypes.go:633-647` (`Ref` on both data structs)
- Modify: `pkg/wshrpc/wshserver/wshserver.go:1329-1343` (handlers pass `data.Ref`)
- Modify: `pkg/jarvis/evidence.go:268` (seal passes `run.BaseCommit`)
- Test: `pkg/jarvis/evidence_test.go` (add `TestSealEvidenceBaseAnchored`)
- Regenerate: `wshclientapi.ts` + `wshclient.go` via `task generate`

**Interfaces:**
- Consumes: `waveobj.Run.BaseCommit` (Task 1).
- Produces: `gitinfo.GetChanges(ctx, cwd, ref string) (*Changes, error)`, `gitinfo.GetDiff(ctx, cwd, path, ref string) (*Diff, error)`.
- Produces: `wshrpc.CommandGitChangesData.Ref string`, `wshrpc.CommandGitDiffData.Ref string`.

- [ ] **Step 1: Write the failing tests**

Add to `pkg/gitinfo/gitinfo_test.go`:

```go
// repoCommittedOnBase makes a repo with an initial commit, records that SHA as the base, then commits
// a modification and a new file on top. Returns (dir, baseSHA). No uncommitted changes remain.
func repoCommittedOnBase(t *testing.T) (string, string) {
	t.Helper()
	dir := t.TempDir()
	git(t, dir, "init", "-b", "main")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\ntwo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git(t, dir, "add", ".")
	git(t, dir, "commit", "-m", "init")
	base, err := HeadCommit(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\ntwo\nthree\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "c.txt"), []byte("added\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git(t, dir, "add", ".")
	git(t, dir, "commit", "-m", "work")
	return dir, base
}

func TestGetChangesRefIncludesCommitted(t *testing.T) {
	dir, base := repoCommittedOnBase(t)
	// HEAD-mode sees nothing (work is committed) — this is the bug we are fixing.
	head, err := GetChanges(context.Background(), dir, "")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(head.Numstat, "a.txt") {
		t.Fatalf("HEAD-mode unexpectedly shows committed change: %q", head.Numstat)
	}
	// ref-mode against the base sees the committed modification (a.txt) and the added file (c.txt).
	ch, err := GetChanges(context.Background(), dir, base)
	if err != nil {
		t.Fatal(err)
	}
	if !ch.IsRepo {
		t.Fatal("expected IsRepo true")
	}
	if !strings.Contains(ch.StatusZ, "a.txt") || !strings.Contains(ch.StatusZ, "c.txt") {
		t.Fatalf("ref statusz missing committed files: %q", ch.StatusZ)
	}
	if !strings.Contains(ch.Numstat, "1\t0\ta.txt") {
		t.Fatalf("ref numstat missing a.txt +1: %q", ch.Numstat)
	}
}

func TestGetDiffRefShowsCommittedPatch(t *testing.T) {
	dir, base := repoCommittedOnBase(t)
	d, err := GetDiff(context.Background(), dir, "a.txt", base)
	if err != nil {
		t.Fatal(err)
	}
	if d.Untracked {
		t.Fatal("a.txt is tracked; Untracked should be false")
	}
	if !strings.Contains(d.Diff, "+three") {
		t.Fatalf("ref diff missing the added line: %q", d.Diff)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./pkg/gitinfo/ -run 'TestGetChangesRef|TestGetDiffRef'`
Expected: FAIL — `GetChanges`/`GetDiff` do not yet take a `ref` argument (compile error: too many arguments).

- [ ] **Step 3: Implement ref-mode in `gitinfo.go`**

Replace `GetChanges` (`:43-73`) with:

```go
func GetChanges(ctx context.Context, cwd, ref string) (*Changes, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	inside, err := run(ctx, cwd, "rev-parse", "--is-inside-work-tree")
	if err != nil || strings.TrimSpace(inside) != "true" {
		return &Changes{IsRepo: false}, nil
	}
	branch, _ := run(ctx, cwd, "rev-parse", "--abbrev-ref", "HEAD")
	prefix, _ := run(ctx, cwd, "rev-parse", "--show-prefix")
	prefix = strings.TrimSpace(prefix)
	// status drives untracked detection in both modes; -uall expands wholly-new dirs (see below).
	statusZ, err := run(ctx, cwd, "status", "--porcelain=v1", "-z", "-uall", "--", ".")
	if err != nil {
		return nil, err
	}
	statusZ = stripPrefixZ(statusZ, prefix)
	if ref == "" {
		// live mode (unchanged): working tree vs HEAD, plus synthetic rows for untracked files.
		numstat, _ := run(ctx, cwd, "diff", "--numstat", "--relative", "HEAD")
		numstat += untrackedNumstat(cwd, statusZ)
		return &Changes{Branch: strings.TrimSpace(branch), StatusZ: statusZ, Numstat: numstat, IsRepo: true}, nil
	}
	// ref mode: tracked changes come from the base diff (committed + uncommitted); untracked files
	// are not in the base, so their ?? rows are carried over from status verbatim.
	nameStatus, _ := run(ctx, cwd, "diff", "--name-status", "-z", "--relative", ref)
	trackedZ := nameStatusToStatusZ(nameStatus)
	untrackedZ := untrackedEntriesZ(statusZ)
	numstat, _ := run(ctx, cwd, "diff", "--numstat", "--relative", ref)
	numstat += untrackedNumstat(cwd, untrackedZ)
	return &Changes{Branch: strings.TrimSpace(branch), StatusZ: trackedZ + untrackedZ, Numstat: numstat, IsRepo: true}, nil
}

// nameStatusToStatusZ converts `git diff --name-status -z` output into the porcelain -z entries
// ("X  path\0") that parseStatusZ (TS) and parseNumstatStatus (Go) already consume. Rename/copy
// (R/C) collapse to "M" on the new path, so no extra source-path field is emitted (the parsers only
// consume a source field when the status letter is R/C).
func nameStatusToStatusZ(nameStatus string) string {
	toks := strings.Split(nameStatus, "\x00")
	var b strings.Builder
	for i := 0; i < len(toks); i++ {
		st := toks[i]
		if st == "" {
			continue
		}
		letter := st[0]
		var path string
		if letter == 'R' || letter == 'C' {
			if i+2 >= len(toks) { // Rxxx \0 old \0 new
				break
			}
			path = toks[i+2]
			i += 2
			letter = 'M'
		} else {
			if i+1 >= len(toks) {
				break
			}
			path = toks[i+1]
			i++
		}
		if path != "" {
			fmt.Fprintf(&b, "%c  %s\x00", letter, path)
		}
	}
	return b.String()
}

// untrackedEntriesZ keeps only the "??" rows of a porcelain -z blob (each re-terminated with NUL).
func untrackedEntriesZ(statusZ string) string {
	var b strings.Builder
	parts := strings.Split(statusZ, "\x00")
	for i := 0; i < len(parts); i++ {
		entry := parts[i]
		if len(entry) < 3 {
			continue
		}
		if entry[0] == 'R' || entry[0] == 'C' {
			i++ // skip the rename/copy source path
			continue
		}
		if entry[:2] == "??" {
			b.WriteString(entry)
			b.WriteByte(0)
		}
	}
	return b.String()
}
```

Replace `GetDiff` (`:155-171`) with:

```go
func GetDiff(ctx context.Context, cwd, path, ref string) (*Diff, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	st, _ := run(ctx, cwd, "status", "--porcelain=v1", "--", path)
	if strings.HasPrefix(strings.TrimSpace(st), "??") {
		content, err := os.ReadFile(filepath.Join(cwd, path))
		if err != nil {
			return nil, err
		}
		return &Diff{Content: string(content), Untracked: true}, nil
	}
	base := ref
	if base == "" {
		base = "HEAD"
	}
	diff, err := run(ctx, cwd, "diff", base, "--", path)
	if err != nil {
		return nil, err
	}
	return &Diff{Diff: diff}, nil
}
```

- [ ] **Step 4: Update existing `gitinfo_test.go` call sites**

Every existing call to `GetChanges(ctx, dir)` becomes `GetChanges(ctx, dir, "")` and every `GetDiff(ctx, cwd, path)` becomes `GetDiff(ctx, cwd, path, "")`. Find them all:

Run: `grep -n "GetChanges(context\|GetDiff(context\|GetChanges(ctx\|GetDiff(ctx" pkg/gitinfo/gitinfo_test.go`
Edit each hit to add the trailing `""` argument (the new ref tests already pass a real ref / `""` explicitly).

- [ ] **Step 5: Run the gitinfo suite**

Run: `go test ./pkg/gitinfo/`
Expected: PASS — new ref tests green, all existing tests still green (the `ref == ""` regression guard).

- [ ] **Step 6: Add `Ref` to the RPC data structs**

In `pkg/wshrpc/wshrpctypes.go`:

```go
type CommandGitChangesData struct {
	Cwd string `json:"cwd"`
	Ref string `json:"ref,omitempty"`
}
```
```go
type CommandGitDiffData struct {
	Cwd  string `json:"cwd"`
	Path string `json:"path"`
	Ref  string `json:"ref,omitempty"`
}
```

- [ ] **Step 7: Thread `Ref` through the handlers and the seal**

In `pkg/wshrpc/wshserver/wshserver.go`:
```go
func (ws *WshServer) GitChangesCommand(ctx context.Context, data wshrpc.CommandGitChangesData) (*wshrpc.CommandGitChangesRtnData, error) {
	ch, err := gitinfo.GetChanges(ctx, data.Cwd, data.Ref)
```
```go
func (ws *WshServer) GitDiffCommand(ctx context.Context, data wshrpc.CommandGitDiffData) (*wshrpc.CommandGitDiffRtnData, error) {
	d, err := gitinfo.GetDiff(ctx, data.Cwd, data.Path, data.Ref)
```

In `pkg/jarvis/evidence.go` (`:268`):
```go
	if ch, err := gitinfo.GetChanges(ctx, run.ProjectPath, run.BaseCommit); err == nil && ch.IsRepo {
```

- [ ] **Step 8: Write the seal-against-base test**

Add to `pkg/jarvis/evidence_test.go`. Add imports `os`, `os/exec`, `path/filepath` if missing.

```go
func gitCmd(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func TestSealEvidenceBaseAnchored(t *testing.T) {
	dir := t.TempDir()
	gitCmd(t, dir, "init", "-b", "main")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitCmd(t, dir, "add", ".")
	gitCmd(t, dir, "commit", "-m", "init")
	base, err := gitinfo.HeadCommit(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	// the run's work: modify + commit on top of the base
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\ntwo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitCmd(t, dir, "commit", "-am", "work")

	run := &waveobj.Run{
		ID: "r1", Status: RunStatus_Done, ProjectPath: dir, BaseCommit: base, CreatedTs: 1000,
		Phases: []waveobj.RunPhase{{Kind: PhaseKind_Execute, State: PhaseState_Done, DoneTs: 5000}},
	}
	if err := SealEvidence(context.Background(), run); err != nil {
		t.Fatal(err)
	}
	if run.Evidence == nil || len(run.Evidence.Files) == 0 {
		t.Fatalf("expected committed files in evidence, got %+v", run.Evidence)
	}
	if run.Evidence.AddTotal == 0 {
		t.Fatalf("expected AddTotal > 0, got %d", run.Evidence.AddTotal)
	}
}
```

Note: `pkg/jarvis/evidence.go` already imports `gitinfo`, so the test package can reference it.

- [ ] **Step 9: Regenerate, build, and run backend tests**

Run: `task generate`
Then: `grep -n '"ref"' frontend/app/store/wshclientapi.ts frontend/types/gotypes.d.ts | head`
Expected: `ref` appears on the git changes/diff command data types.
Then: `go build ./pkg/... && go test ./pkg/gitinfo/ ./pkg/jarvis/`
Expected: exit 0, all PASS.

- [ ] **Step 10: Checkpoint**

Stage the Go + regenerated files. Do NOT commit.

---

### Task 3: Diff-tab run source (`filesstore.ts`)

**Files:**
- Modify: `frontend/app/view/agents/filesstore.ts`
- Test: `frontend/app/view/agents/filesstore.test.ts` (create)

**Interfaces:**
- Consumes: `RpcApi.GitChangesCommand({ cwd, ref })`, `RpcApi.GitDiffCommand({ cwd, path, ref })` (Task 2 regen).
- Produces: `loadFilesForRun(runId: string, cwd: string, baseCommit: string): Promise<void>`; `FilesState.ref: string`.

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/agents/filesstore.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { globalStore } from "@/app/store/jotaiStore";

const gitChanges = vi.fn();
const gitDiff = vi.fn();
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        GitChangesCommand: (...a: any[]) => gitChanges(...a),
        GitDiffCommand: (...a: any[]) => gitDiff(...a),
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import { filesDiffAtom, filesSelectedPathAtom, filesStateAtom, loadFilesForRun } from "./filesstore";

afterEach(() => {
    gitChanges.mockReset();
    gitDiff.mockReset();
    globalStore.set(filesStateAtom, null);
    globalStore.set(filesSelectedPathAtom, null);
    globalStore.set(filesDiffAtom, null);
});

describe("loadFilesForRun", () => {
    it("threads the base commit as ref into GitChanges and the follow-up GitDiff", async () => {
        gitChanges.mockResolvedValue({ isrepo: true, branch: "main", statusz: "M  x.ts\0", numstat: "1\t0\tx.ts\n" });
        gitDiff.mockResolvedValue({ diff: "", content: "", untracked: false });

        await loadFilesForRun("run-1", "/repo", "abc123");
        // let the fire-and-forget selectFile settle
        await new Promise((r) => setTimeout(r, 0));

        expect(gitChanges).toHaveBeenCalledWith({}, { cwd: "/repo", ref: "abc123" });
        expect(gitDiff).toHaveBeenCalledWith({}, { cwd: "/repo", path: "x.ts", ref: "abc123" });
        expect(globalStore.get(filesStateAtom)?.ref).toBe("abc123");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/filesstore.test.ts`
Expected: FAIL — `loadFilesForRun` is not exported / `FilesState.ref` undefined.

- [ ] **Step 3: Implement ref threading + `loadFilesForRun`**

In `frontend/app/view/agents/filesstore.ts`:

Add `ref` to the interface and the empty state:
```ts
export interface FilesState {
    cwd: string | null;
    branch: string;
    isRepo: boolean;
    changes: GitChanges | null;
    ref: string; // base commit to diff against; "" = live working-tree-vs-HEAD
}
```
```ts
const EMPTY: FilesState = { cwd: null, branch: "", isRepo: false, changes: null, ref: "" };
```

Give `loadChangesForCwd` a `ref` param and thread it into the RPC + stored state:
```ts
async function loadChangesForCwd(token: string, cwd: string | null, ref: string): Promise<void> {
    if (!cwd) {
        if (current.token === token) {
            globalStore.set(filesStateAtom, EMPTY);
        }
        return;
    }
    try {
        const ch = await RpcApi.GitChangesCommand(TabRpcClient, { cwd, ref });
        if (current.token !== token) {
            return;
        }
        const changes = ch.isrepo ? parseGitChanges(ch.statusz, ch.numstat) : null;
        globalStore.set(filesStateAtom, { cwd, branch: ch.branch, isRepo: ch.isrepo, changes, ref });
        const requested =
            requestedSelection.token === token && changes?.files.some((f) => f.path === requestedSelection.path)
                ? requestedSelection.path
                : undefined;
        const first = requested ?? changes?.files[0]?.path;
        if (requested) {
            requestedSelection.token = "";
            requestedSelection.path = "";
        }
        if (first) {
            void selectFile(cwd, first);
        }
    } catch {
        if (current.token === token) {
            globalStore.set(filesStateAtom, { ...EMPTY, cwd });
        }
    }
}
```

Update `reloadChanges` to preserve the active ref:
```ts
export async function reloadChanges(cwd: string | null): Promise<void> {
    if (!current.token) return;
    const ref = globalStore.get(filesStateAtom)?.ref ?? "";
    await loadChangesForCwd(current.token, cwd, ref);
}
```

Update the two existing loaders to pass `""`, and add the run loader:
```ts
export async function loadFilesForAgent(
    id: string,
    transcriptPath: string | undefined,
    blockId?: string
): Promise<void> {
    const token = `agent:${id}`;
    beginLoad(token);
    const cwd = await resolveCwd(transcriptPath, blockId);
    if (current.token !== token) {
        return;
    }
    await loadChangesForCwd(token, cwd, "");
}

// Project-scoped load: the registry path IS the cwd, so no transcript resolution is needed.
export async function loadFilesForProject(name: string, path: string): Promise<void> {
    const token = `project:${name}`;
    beginLoad(token);
    await loadChangesForCwd(token, path || null, "");
}

// Run-scoped load: base-anchored, read-only. baseCommit "" degrades to the live HEAD diff.
export async function loadFilesForRun(runId: string, cwd: string, baseCommit: string): Promise<void> {
    const token = `run:${runId}`;
    beginLoad(token);
    await loadChangesForCwd(token, cwd || null, baseCommit);
}
```

Update `selectFile` to read the active ref from state and pass it to `GitDiffCommand`:
```ts
export async function selectFile(cwd: string, path: string): Promise<void> {
    globalStore.set(filesSelectedPathAtom, path);
    globalStore.set(filesDiffAtom, null);
    const ref = globalStore.get(filesStateAtom)?.ref ?? "";
    try {
        const d = await RpcApi.GitDiffCommand(TabRpcClient, { cwd, path, ref });
        if (globalStore.get(filesSelectedPathAtom) !== path) {
            return; // selection moved on
        }
        globalStore.set(filesDiffAtom, d.untracked ? plainFileView(d.content) : parseUnifiedDiff(d.diff));
    } catch {
        if (globalStore.get(filesSelectedPathAtom) === path) {
            globalStore.set(filesDiffAtom, null);
        }
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/filesstore.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 6: Checkpoint**

Stage `filesstore.ts` + `filesstore.test.ts`. Do NOT commit.

---

### Task 4: Diff-tab run mode + "Open repository diff" button

**Files:**
- Modify: `frontend/app/view/agents/agents.tsx:84` (add `filesRunAtom`)
- Modify: `frontend/app/view/agents/filessurface.tsx` (run mode: load, pin browse, run header)
- Modify: `frontend/app/view/agents/runcompletionsurface.tsx:54,207` (accept `model`; rewire button)
- Modify: `frontend/app/view/agents/runbody.tsx:827` (pass `model`)

**Interfaces:**
- Consumes: `loadFilesForRun` (Task 3); `AgentsViewModel.surfaceAtom`, `AgentsViewModel.filesRunAtom` (new).
- Produces: `AgentsViewModel.filesRunAtom = atom<{ runId: string; cwd: string; baseCommit: string } | null>(null)`.

- [ ] **Step 1: Add the run-source atom to the view model**

In `frontend/app/view/agents/agents.tsx`, next to `focusIdAtom` (`:84`):

```ts
    // run-scoped Diff-tab source: set by the run-completion "Open repository diff" button. Non-null
    // overrides agent/project scoping with a read-only, base-anchored view of that run's changes.
    filesRunAtom = atom<{ runId: string; cwd: string; baseCommit: string } | null>(null) as PrimitiveAtom<{
        runId: string;
        cwd: string;
        baseCommit: string;
    } | null>;
```

(`atom` and `PrimitiveAtom` are already imported in this file.)

- [ ] **Step 2: Add run mode to `FilesSurface`**

In `frontend/app/view/agents/filessurface.tsx`:

Add imports:
```ts
import { filesDiffAtom, filesSelectedPathAtom, filesStateAtom, loadFilesForAgent, loadFilesForProject, loadFilesForRun, selectFile } from "./filesstore";
import { runShortId } from "./runcompletion";
```

Read the run source and derive the effective mode (rename the `mode` state read to keep browse pinned in run mode). Replace the `const [mode, setMode] = useState<"browse" | "review">("browse");` line with:
```ts
    const [modeState, setMode] = useState<"browse" | "review">("browse");
    const runSource = useAtomValue(model.filesRunAtom);
    const mode = runSource ? "browse" : modeState; // run view is read-only: no Review/revert
```

Replace the load effect (`:317-323`) so a run source wins and clears when the user picks a source:
```ts
    useEffect(() => {
        if (runSource) {
            fireAndForget(() => loadFilesForRun(runSource.runId, runSource.cwd, runSource.baseCommit));
        } else if (projectSel) {
            fireAndForget(() => loadFilesForProject(projectSel.name, projectSel.path));
        } else if (focusId) {
            fireAndForget(() => loadFilesForAgent(focusId, agent?.transcriptPath, agent?.blockId));
        }
    }, [runSource?.runId, runSource?.cwd, runSource?.baseCommit, projectSel?.name, projectSel?.path, focusId, agent?.transcriptPath, agent?.blockId]);
```

In the sidebar header, swap the mode toggle + picker for a run header when `runSource` is set. Replace the `<div className="mb-[11px] flex items-center gap-[9px]">…</div>` block and the following `<SourcePicker .../>` (`:370-388`) with:
```tsx
                    <div className="mb-[11px] flex items-center gap-[9px]">
                        <h1 className="text-[16px] font-bold">Diff</h1>
                        {!runSource && (
                            <div className="ml-auto flex gap-[2px] rounded-[7px] border border-border p-[2px]">
                                <button onClick={() => setMode("browse")}
                                    className={cn("rounded-[5px] px-[9px] py-[3px] text-[11px] font-[600]", mode === "browse" ? "bg-surface-selected text-foreground" : "text-ink-mid")}>Browse</button>
                                <button onClick={() => setMode("review")}
                                    className={cn("rounded-[5px] px-[9px] py-[3px] text-[11px] font-[600]", mode === "review" ? "bg-surface-selected text-foreground" : "text-ink-mid")}>Review</button>
                            </div>
                        )}
                    </div>
                    {runSource ? (
                        <div className="flex items-center gap-[8px] rounded border border-border px-[10px] py-[7px]">
                            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-mid">run {runShortId(runSource.runId)} · read-only</span>
                            <button
                                onClick={() => globalStore.set(model.filesRunAtom, null)}
                                className="flex-none rounded border border-border px-[8px] py-[3px] text-[11px] text-ink-mid hover:text-foreground"
                            >
                                Exit
                            </button>
                        </div>
                    ) : (
                        <SourcePicker
                            agents={agents}
                            projects={projects}
                            source={source}
                            onPickAgent={(id) => {
                                setProjectSel(null);
                                globalStore.set(model.focusIdAtom, id);
                            }}
                            onPickProject={(p) => setProjectSel(p)}
                        />
                    )}
```

Note: the "default to first agent" effect (`:311-315`) stays as-is — it only fires when `!projectSel && !focusId`, and in run mode the run-load effect wins regardless, so no guard change is needed.

- [ ] **Step 3: Accept `model` and rewire the button in `runcompletionsurface.tsx`**

Add imports:
```ts
import { getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import type { AgentsViewModel } from "./agents";
import { loadFilesForRun } from "./filesstore";
```
(Keep the existing `getApi` import; add the others.)

Change the component signature (`:54`):
```ts
export function RunCompletion({ channel, run, model }: { channel: Channel; run: Run; model: AgentsViewModel }) {
```

Replace the "Open repository diff" button `onClick` (`:207`):
```tsx
                            <button
                                onClick={() => {
                                    globalStore.set(model.filesRunAtom, { runId: run.id, cwd: run.projectpath, baseCommit: run.basecommit ?? "" });
                                    globalStore.set(model.surfaceAtom, "files");
                                }}
                                className="flex items-center gap-2.5 rounded-[9px] bg-accent px-4 py-2.5 text-[12.5px] font-bold text-background hover:bg-accent/90"
                            >
```
(The `openPath`/`getApi().openExternal` usages for file and artifact rows stay unchanged — only the repository-diff button changes.)

- [ ] **Step 4: Pass `model` from `runbody.tsx`**

At `frontend/app/view/agents/runbody.tsx:827`:
```tsx
        return <RunCompletion channel={channel} run={run} model={model} />;
```

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 6: Behavioral verification via CDP (no render harness exists)**

Start the dev app if not running (`task dev`, per project docs). Then:
```bash
node scripts/inject-live-agents.mjs <scenario-with-a-done-run>
node scripts/cdp-shot.mjs scratchpad/run-diff-before.png
```
Manually (or via the CDP `Input` API) click "Open repository diff" on a completed run whose work is **committed**, then:
```bash
node scripts/cdp-shot.mjs scratchpad/run-diff-after.png
```
Expected: the Diff tab opens showing the run's changed files and a non-empty per-file diff — not an empty "No changes" pane. Confirm the header reads `run <id> · read-only` with no Browse/Review toggle, and that "Exit" returns to the normal source picker.

If a committed-run scenario isn't available in `inject-live-agents.mjs`, verify the same flow against a real run in the running dev app after committing its work.

- [ ] **Step 7: Checkpoint**

Stage the four frontend files. Do NOT commit.

---

## Final commit (after user approval)

Once all four tasks are checkpointed and green, and the user approves:
- Stage everything above plus the spec doc `docs/superpowers/specs/2026-07-16-run-evidence-diff-design.md` and this plan (spec/plan fold into the feature commit per repo convention).
- Also fold in the previously-staged ANSI-strip fix if it hasn't been committed yet (it is part of the same evidence-card work): `pkg/util/utilfn/utilfn.go`, `pkg/jarvis/evidence.go`, `pkg/jarvis/evidence_test.go`.
- One commit, message describing the base-anchored run diff + button rewire. No Co-Authored-By trailer.

## Self-Review

**Spec coverage:**
- Data model `Run.BaseCommit` → Task 1. ✓
- Git layer optional `Ref`, name-status normalization, untracked augmentation, `ref==""` compat → Task 2. ✓
- Run lifecycle capture at `CreateRunCommand`, seal against base → Task 1 (capture) + Task 2 (seal). ✓
- Diff-tab run source + read-only run mode → Task 3 (store) + Task 4 (surface). ✓
- Button rewire → Task 4. ✓
- Error handling (no base → HEAD fallback; non-repo) → covered by `ref==""` path (Task 2/3) + existing "Not a git repository" state. ✓
- Testing (Go ref-mode + seal; FE store threading; CDP visual) → Tasks 2, 3, 4. ✓

**Placeholder scan:** no TBD/TODO; every code step shows full code; test code is complete.

**Type consistency:** `GetChanges(ctx,cwd,ref)` / `GetDiff(ctx,cwd,path,ref)` used identically in gitinfo, handlers, evidence, and tests. `CommandGitChangesData.Ref`/`CommandGitDiffData.Ref` consumed by `filesstore` as `{ cwd, ref }` / `{ cwd, path, ref }`. `FilesState.ref` set in `loadChangesForCwd`, read in `selectFile`/`reloadChanges`. `loadFilesForRun(runId, cwd, baseCommit)` signature matches the call in `filessurface`. `filesRunAtom` shape `{ runId, cwd, baseCommit }` matches the button's `globalStore.set` and the surface's `loadFilesForRun` args. `runShortId` imported from `runcompletion`. Consistent throughout.
