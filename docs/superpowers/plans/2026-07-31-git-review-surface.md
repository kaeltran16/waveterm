# Git review — Diff surface restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Diff surface as three panes — commit history with a graph gutter, commit detail, file diff — on one time axis, and delete Review mode.

**Architecture:** The surface stops being "files, optionally reviewed" and becomes "history, drilled into". Pane 1 lists commits newest-first with an SVG lane gutter drawn from the pure modules plan 1 produced (`gitgraph.ts` for lane assignment, `gitgraphgeom.ts` for coordinates). Pane 2 shows the selected commit's metadata and its changed files. Pane 3 is the existing diff renderer, unchanged in idiom, now fed either by the working tree or by a selected commit. Uncommitted work is row zero of the history rather than a separate mode, which is what lets the Browse / Review segmented control disappear rather than be replaced. All derivation is pure and unit-tested (`historyrows.ts`); the store is thin glue over the typed RPC, following `filesstore.ts`.

**Tech Stack:** Go 1.23 (`pkg/gitinfo`, `pkg/wshrpc`), React 19 + TypeScript, jotai, Tailwind 4, vitest, `motion/react`.

**Design source:** `wave-handoff/wave/project/Wave-git-review.dc.html` (the mockup, authoritative for composition and measurements) and `docs/superpowers/briefs/2026-07-31-git-review-ui-design-brief.md` (the brief).

**Predecessor:** `docs/superpowers/plans/2026-07-31-git-review-read-path.md` (plan 1, shipped as commit `010fa7e9`) built `HistoryLog`, `GetDivergence`, `GitHistoryCommand`, `GitDivergenceCommand`, `gitgraph.ts` and `gitgraphgeom.ts`. This plan consumes all of them.

## Global Constraints

- **Do not commit during execution.** Batch all work into a single commit at the end, and only after the user explicitly approves. This plan document folds into that same commit — never a separate docs-only commit.
- **Never hand-edit generated files.** `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts` and `pkg/wshrpc/wshclient/wshclient.go` are produced by `task generate`. Edit the Go definitions and regenerate.
- **Dark mode only.** No light or Paper variant. Light mode is permanently out of scope for this codebase.
- **Colours come from `@theme` tokens in `frontend/tailwindsetup.css`.** Never a raw hex or rgba in a component. Runtime theming works by overriding those same `--color-*` custom properties, so a hardcoded colour silently opts out of every theme.
- **Prefer Tailwind over new SCSS.** No new `.scss` files.
- **Read-only.** Nothing in this surface stages, composes a commit, rebases, pushes, or mutates the working tree. `fetch` would be the sole permitted mutation and it is not in this plan.
- **No new nav-rail entry.** This grows inside the existing Diff surface (`SurfaceKey` `files`). Rail entries stay capped at eight so `Ctrl+1..8` maps one-to-one.
- **Monospace for hashes, paths, branch names and refs** — `font-mono`, from `--font-mono: "JetBrains Mono", monospace`.
- **No jsdom render or snapshot tests.** Extract logic to a pure module and unit-test that; "does it render" is covered by the Chrome-DevTools-Protocol `surface-smoke` scenario.
- **Typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`.** Bare `npx tsc` stack-overflows on this repo, which also means `task check:ts` is broken. The baseline is clean (exit 0), so any reported error is yours.
- **Go tests need the vendored sqlite header.** From PowerShell at the repo root: `$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"`. The `-I` path must be Windows-style; a Git-Bash POSIX path silently fails with an identical-looking error. Only needed for a whole-tree `go test ./pkg/...`; `go test ./pkg/gitinfo/` alone does not.
- **Do not run `prettier --write` on files you did not author in full.** On a drifted file it reorders imports and rewraps the whole thing, turning a four-line edit into a six-hundred-line diff. Hand-format your own lines.

---

## Scope correction to plan 1's estimate

Plan 1's "Next plans" section described plan 2 as "wiring the existing changed-file and diff panes to commit selection". That assumed the two existing commands — `GitChangesCommand` and `GitDiffCommand` — could answer "what did commit X change". **They cannot.** Both are anchored to the working tree:

- `GetChanges(ctx, cwd, ref)` (`pkg/gitinfo/gitinfo.go:43`) runs `git status` plus `git diff --numstat --relative <ref>`, i.e. **working tree versus ref**. Asked about a historical commit it returns everything that changed between that commit and the current checkout, not what the commit itself introduced.
- `GetDiff(ctx, cwd, path, ref)` (`pkg/gitinfo/gitinfo.go:312`) runs `git diff <ref> -- <path>` — again working tree versus ref.

`GetRangeChanges(ctx, cwd, base, end)` (`pkg/gitinfo/gitinfo.go:92`) is the right shape for the file list but is **not exposed over RPC**, and there is no range equivalent of `GetDiff` at all.

Without commit-scoped reads, panes 2 and 3 are dead for every row except the uncommitted one — which is most of the surface. So Task 1 adds them. This is roughly one extra task's worth of Go and regeneration beyond plan 1's estimate, and it is load-bearing: skip it and the plan does not produce working software.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `frontend/app/view/agents/historyrows.ts` | Pure. Turns `HistoryCommit[]` plus scope options into display rows: ref-chip classification, relative time, the synthetic working-tree row, the anchor divider, and the default selection. |
| `frontend/app/view/agents/historyrows.test.ts` | Unit tests for the above. |
| `frontend/app/view/agents/githistorystore.ts` | jotai atoms plus async loaders for history and commit selection. Thin glue over the typed RPC, mirroring `filesstore.ts`. |
| `frontend/app/view/agents/graphgutter.tsx` | The SVG lane gutter. The only place a lane index becomes a `--color-graphlane-N` token. |
| `frontend/app/view/agents/historypane.tsx` | Pane 1: the commit list, its rows, the anchor divider, and the gutter overlay. |
| `frontend/app/view/agents/commitpane.tsx` | Pane 2: selected-commit metadata plus its changed-file list. |
| `pkg/wshrpc/wshserver/wshserver_git.go` | *(exists — plan 1)* gains two handlers. |

**Modified:**

| File | Change |
|---|---|
| `pkg/gitinfo/gitinfo.go` | Add `CommitChanges` and `CommitDiff` (additive). |
| `pkg/gitinfo/gitinfo_test.go` | Add five tests for the above. |
| `pkg/wshrpc/wshrpctypes_git.go` | Add two commands and four payload types to the `GitCommands` interface. |
| `frontend/tailwindsetup.css` | Add the `--color-graphlane-1..6` plus `--color-graphlane-fold` palette. |
| `frontend/app/view/agents/gitgraph.ts` | Make `assignLanes` generic so display fields survive lane assignment with their types intact. |
| `frontend/app/view/agents/gitgraphgeom.ts` | Add `foldX` to `GraphGeometry`. |
| `frontend/app/view/agents/gitgraphgeom.test.ts` | One test for `foldX`. |
| `frontend/app/view/agents/filessurface.tsx` | Remove Review mode; restructure into three panes with the new subject bar. |
| `frontend/app/store/keybindings/bindings.ts` | Delete `buildReviewBindings` and its `reviewstore` imports. |
| `frontend/app/store/keybindings/bindings.test.ts` | Delete the `review bindings` describe block and its imports. |
| `frontend/app/store/keybindings/store.test.ts` | Delete the review no-conflict test and its import. |

**Deleted:**

- `frontend/app/view/agents/reviewsurface.tsx`
- `frontend/app/view/agents/reviewstore.ts`
- `frontend/app/view/agents/reviewstore.test.ts`

**Generated (never hand-edited, regenerated in Task 1):** `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`, `pkg/wshrpc/wshclient/wshclient.go`.

---

### Task 1: Commit-scoped reads in Go, exposed over RPC

Selecting a commit must show that commit's own changed files and per-file diffs. Neither existing command can answer that (see "Scope correction" above). This task adds both, following the `pkg/gitinfo` idiom exactly: shell out through the package-local `run(ctx, cwd, args...)`, guard with `rev-parse --is-inside-work-tree` returning `IsRepo: false` rather than an error, and wrap the exported entry point in `context.WithTimeout(ctx, gitTimeout)`.

**Files:**
- Modify: `pkg/gitinfo/gitinfo.go` (append at end of file)
- Modify: `pkg/gitinfo/gitinfo_test.go` (append at end of file)
- Modify: `pkg/wshrpc/wshrpctypes_git.go`
- Modify: `pkg/wshrpc/wshserver/wshserver_git.go`

**Interfaces:**
- Consumes: `run`, `gitTimeout`, `Changes`, `Diff`, `nameStatusToStatusZ` — all already in `pkg/gitinfo`. The test fixtures `repoBranchMerge` (`gitinfo_test.go:758`), `gitAuthored` (`:735`) and `commitAuthored` (`:747`) came from plan 1 and are reused as-is.
- Produces: `gitinfo.CommitChanges(ctx, cwd, hash) (*Changes, error)` and `gitinfo.CommitDiff(ctx, cwd, hash, path) (*Diff, error)`. For the frontend, `RpcApi.GitCommitChangesCommand(TabRpcClient, {cwd, hash})` returning `{statusz, numstat, isrepo}` and `RpcApi.GitCommitDiffCommand(TabRpcClient, {cwd, hash, path})` returning `{diff}`. Task 5's store calls both.

- [ ] **Step 1: Write the failing tests**

Append to `pkg/gitinfo/gitinfo_test.go`:

```go
// commitBySubject finds a commit hash in the repo's history by its subject line, so the tests below
// do not depend on --date-order tie-breaking between commits made in the same second.
func commitBySubject(t *testing.T, dir, subject string) string {
	t.Helper()
	h, err := HistoryLog(context.Background(), dir, HistoryOpts{})
	if err != nil {
		t.Fatalf("HistoryLog: %v", err)
	}
	for _, c := range h.Commits {
		if c.Subject == subject {
			return c.Hash
		}
	}
	t.Fatalf("no commit with subject %q in %d commits", subject, len(h.Commits))
	return ""
}

func TestCommitChangesIsolatesOneCommit(t *testing.T) {
	dir := repoBranchMerge(t)
	hash := commitBySubject(t, dir, "second on main")
	ch, err := CommitChanges(context.Background(), dir, hash)
	if err != nil {
		t.Fatalf("CommitChanges: %v", err)
	}
	if !ch.IsRepo {
		t.Fatal("IsRepo = false, want true")
	}
	// that commit added a.txt and nothing else — root.txt already existed, b.txt did not yet
	if !strings.Contains(ch.StatusZ, "a.txt") {
		t.Errorf("StatusZ = %q, want it to mention a.txt", ch.StatusZ)
	}
	if strings.Contains(ch.StatusZ, "root.txt") {
		t.Errorf("StatusZ = %q, want it NOT to mention root.txt", ch.StatusZ)
	}
	if !strings.Contains(ch.Numstat, "a.txt") {
		t.Errorf("Numstat = %q, want it to mention a.txt", ch.Numstat)
	}
}

func TestCommitChangesHandlesRootCommit(t *testing.T) {
	dir := repoBranchMerge(t)
	hash := commitBySubject(t, dir, "root commit")
	ch, err := CommitChanges(context.Background(), dir, hash)
	if err != nil {
		t.Fatalf("CommitChanges: %v", err)
	}
	// a root commit has no parent; every file in it reads as added against the empty tree
	if !strings.Contains(ch.StatusZ, "root.txt") {
		t.Errorf("StatusZ = %q, want it to mention root.txt", ch.StatusZ)
	}
	if !strings.Contains(ch.StatusZ, "A") {
		t.Errorf("StatusZ = %q, want an A status", ch.StatusZ)
	}
}

func TestCommitChangesOnMergeUsesFirstParent(t *testing.T) {
	dir := repoBranchMerge(t)
	hash := commitBySubject(t, dir, "merge feature into main")
	ch, err := CommitChanges(context.Background(), dir, hash)
	if err != nil {
		t.Fatalf("CommitChanges: %v", err)
	}
	// against its first parent (main's tip) the merge brings in exactly b.txt
	if !strings.Contains(ch.StatusZ, "b.txt") {
		t.Errorf("StatusZ = %q, want it to mention b.txt", ch.StatusZ)
	}
	if strings.Contains(ch.StatusZ, "a.txt") {
		t.Errorf("StatusZ = %q, want it NOT to mention a.txt", ch.StatusZ)
	}
}

func TestCommitDiffReturnsThatCommitsPatch(t *testing.T) {
	dir := repoBranchMerge(t)
	hash := commitBySubject(t, dir, "second on main")
	d, err := CommitDiff(context.Background(), dir, hash, "a.txt")
	if err != nil {
		t.Fatalf("CommitDiff: %v", err)
	}
	if !strings.Contains(d.Diff, "+a") {
		t.Errorf("Diff = %q, want it to contain the added line +a", d.Diff)
	}
	if d.Untracked {
		t.Error("Untracked = true, want false for a committed file")
	}
}

func TestCommitChangesNotARepo(t *testing.T) {
	ch, err := CommitChanges(context.Background(), t.TempDir(), "HEAD")
	if err != nil {
		t.Fatalf("CommitChanges: %v", err)
	}
	if ch.IsRepo {
		t.Error("IsRepo = true, want false outside a repository")
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/gitinfo/ -run "TestCommit" -v`
Expected: FAIL to **build**, with `undefined: CommitChanges` and `undefined: CommitDiff`.

- [ ] **Step 3: Implement the two readers**

Append to `pkg/gitinfo/gitinfo.go`:

```go
// git's well-known empty-tree object. Diffing a root commit against it is how you get "everything
// this commit introduced" when there is no parent to measure against.
const emptyTreeHash = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

// commitBase returns the ref a commit's own change should be measured against: its first parent, or
// the empty tree for a root commit. Merge commits deliberately use the first parent — "what did this
// merge bring in" is the conventional presentation, and a combined diff is unreadable in a file list.
func commitBase(ctx context.Context, cwd, hash string) (string, error) {
	out, err := run(ctx, cwd, "rev-list", "--parents", "-n", "1", hash)
	if err != nil {
		return "", err
	}
	fields := strings.Fields(strings.TrimSpace(out))
	if len(fields) < 2 {
		return emptyTreeHash, nil
	}
	return fields[1], nil
}

// CommitChanges lists the per-file changes one commit introduced, as name-status + numstat in the
// same shape GetChanges and GetRangeChanges produce. Unlike GetChanges it never consults the working
// tree, so selecting a commit in the history shows that commit and not "everything since it".
// Paths are cwd-relative (--relative), matching the rest of the package.
func CommitChanges(ctx context.Context, cwd, hash string) (*Changes, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	inside, err := run(ctx, cwd, "rev-parse", "--is-inside-work-tree")
	if err != nil || strings.TrimSpace(inside) != "true" {
		return &Changes{IsRepo: false}, nil
	}
	base, err := commitBase(ctx, cwd, hash)
	if err != nil {
		return nil, err
	}
	nameStatus, err := run(ctx, cwd, "diff", "--name-status", "-z", "--relative", base, hash)
	if err != nil {
		return nil, err
	}
	numstat, err := run(ctx, cwd, "diff", "--numstat", "--relative", base, hash)
	if err != nil {
		return nil, err
	}
	return &Changes{StatusZ: nameStatusToStatusZ(nameStatus), Numstat: numstat, IsRepo: true}, nil
}

// CommitDiff returns one file's unified diff as introduced by one commit. The Diff shape is shared
// with GetDiff so the frontend parses both the same way; Untracked is never set here, because a
// committed file is by definition tracked.
func CommitDiff(ctx context.Context, cwd, hash, path string) (*Diff, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	base, err := commitBase(ctx, cwd, hash)
	if err != nil {
		return nil, err
	}
	diff, err := run(ctx, cwd, "diff", base, hash, "--", path)
	if err != nil {
		return nil, err
	}
	return &Diff{Diff: diff}, nil
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/gitinfo/ -run "TestCommit" -v`
Expected: PASS — all five cases.

- [ ] **Step 5: Add the two RPC commands**

In `pkg/wshrpc/wshrpctypes_git.go`, add to the `GitCommands` interface (after `GitDivergenceCommand`):

```go
	GitCommitChangesCommand(ctx context.Context, data CommandGitCommitChangesData) (*CommandGitCommitChangesRtnData, error)
	GitCommitDiffCommand(ctx context.Context, data CommandGitCommitDiffData) (*CommandGitCommitDiffRtnData, error)
```

and append the four payload types to the same file:

```go
type CommandGitCommitChangesData struct {
	Cwd  string `json:"cwd"`
	Hash string `json:"hash"`
}

// Mirrors CommandGitChangesRtnData minus Branch and Ref, which are properties of the working-tree
// view and meaningless for a single commit.
type CommandGitCommitChangesRtnData struct {
	StatusZ string `json:"statusz"`
	Numstat string `json:"numstat"`
	IsRepo  bool   `json:"isrepo"`
}

type CommandGitCommitDiffData struct {
	Cwd  string `json:"cwd"`
	Hash string `json:"hash"`
	Path string `json:"path"`
}

type CommandGitCommitDiffRtnData struct {
	Diff string `json:"diff"`
}
```

- [ ] **Step 6: Add the two handlers**

Append to `pkg/wshrpc/wshserver/wshserver_git.go`:

```go
func (ws *WshServer) GitCommitChangesCommand(ctx context.Context, data wshrpc.CommandGitCommitChangesData) (*wshrpc.CommandGitCommitChangesRtnData, error) {
	ch, err := gitinfo.CommitChanges(ctx, data.Cwd, data.Hash)
	if err != nil {
		return nil, err
	}
	return &wshrpc.CommandGitCommitChangesRtnData{StatusZ: ch.StatusZ, Numstat: ch.Numstat, IsRepo: ch.IsRepo}, nil
}

func (ws *WshServer) GitCommitDiffCommand(ctx context.Context, data wshrpc.CommandGitCommitDiffData) (*wshrpc.CommandGitCommitDiffRtnData, error) {
	d, err := gitinfo.CommitDiff(ctx, data.Cwd, data.Hash, data.Path)
	if err != nil {
		return nil, err
	}
	return &wshrpc.CommandGitCommitDiffRtnData{Diff: d.Diff}, nil
}
```

- [ ] **Step 7: Regenerate the bindings**

Run: `task generate`
Expected: no errors. Confirm the two new commands landed:

Run: `grep -n "GitCommitChangesCommand\|GitCommitDiffCommand" frontend/app/store/wshclientapi.ts`
Expected: one line each.

Run: `grep -n "CommandGitCommitChangesRtnData" frontend/types/gotypes.d.ts`
Expected: one type declaration.

- [ ] **Step 8: Verify the Go tree still builds and passes**

Run: `go build ./...`
Expected: exit 0.

Run: `go test ./pkg/gitinfo/ ./pkg/wshrpc/...`
Expected: exit 0.

Note: `gofmt -l pkg/wshrpc/wshclient/wshclient.go` lists that file. That is true at HEAD too — it is generator output, not yours. Your two hand-written files must be gofmt-clean: `gofmt -l pkg/gitinfo/gitinfo.go pkg/wshrpc/wshrpctypes_git.go pkg/wshrpc/wshserver/wshserver_git.go` should print nothing.

---

### Task 2: Delete Review mode

Review mode was the hunk-level accept/reject workflow: `reviewstore.ts`'s `rejectedPatchPlan()` turned per-hunk *reject* decisions into revert operations sent through `RpcApi.GitRevertCommand`, which mutated the working tree. Plan 1 recorded the decision to remove it (see that plan's "Resolved decisions"): its mode lived in component state and so reset to Browse on every surface unmount, making it a workflow you could never stay in; it had no Chrome-DevTools-Protocol verification scenario; and keeping it as a mode would partially revert this design's central move of collapsing two modes onto one time axis.

Doing the deletion first means Task 8 restructures a two-pane surface rather than a two-pane-plus-mode-switch surface.

**Files:**
- Delete: `frontend/app/view/agents/reviewsurface.tsx`, `frontend/app/view/agents/reviewstore.ts`, `frontend/app/view/agents/reviewstore.test.ts`
- Modify: `frontend/app/store/keybindings/bindings.ts:11-20` (the `reviewstore` import block), `:226-285` (`buildReviewBindings`)
- Modify: `frontend/app/store/keybindings/bindings.test.ts:8` (import), `:19` (import), `:290-325` (the `review bindings` describe block)
- Modify: `frontend/app/store/keybindings/store.test.ts:13` (import), `:116-120` (the review no-conflict test)
- Modify: `frontend/app/view/agents/filessurface.tsx` — imports at `:29-30`, the `modeState` hook at `:299` and `mode` at `:301`, the segmented control at `:390-397`, the review progress meter at `:429-445`, the review branch of the sidebar list at `:448-477`, the `mode === "browse"` guard in `browseNav` at `:346-360`, the review effect at `:337-341`, the review model reads at `:287-289`, the `rprog`/`rSelPath` locals at `:376-379`, and the pane switch at `:523`

**Interfaces:**
- Consumes: nothing new.
- Produces: a Diff surface with no mode concept. `FilesSurface({ model })` keeps its signature. `buildReviewBindings` no longer exists; nothing outside the deleted files referenced it except the two keybinding test files.

- [ ] **Step 1: Confirm the blast radius before deleting anything**

Run: `grep -rn "reviewstore\|reviewsurface\|ReviewSurface\|buildReviewBindings" --include=*.ts --include=*.tsx frontend/`

Expected: matches only in the three files to delete plus `bindings.ts`, `bindings.test.ts`, `store.test.ts`, and `filessurface.tsx`. If anything else appears, stop and report it — the plan's list is out of date.

- [ ] **Step 2: Delete the three review files**

```bash
git rm frontend/app/view/agents/reviewsurface.tsx frontend/app/view/agents/reviewstore.ts frontend/app/view/agents/reviewstore.test.ts
```

- [ ] **Step 3: Prune the keybinding registry**

In `frontend/app/store/keybindings/bindings.ts`, delete the entire import block:

```ts
import {
    appliedAtom,
    applyReview,
    decide,
    decisionsAtom,
    hunkKey,
    reviewModelAtom,
    reviewSelectedAtom,
    undoLast,
} from "@/app/view/agents/reviewstore";
```

and delete the whole `buildReviewBindings` function together with its leading comment — everything from the line `// Files "Review" mode triage keys. Registered by ReviewSurface via useKeybindings, so they exist` down to and including the closing `}` of the function (the line immediately before the `// Run-body ask keys:` comment).

- [ ] **Step 4: Prune the keybinding tests**

In `frontend/app/store/keybindings/bindings.test.ts`: delete the line

```ts
import { appliedAtom, decisionsAtom, reviewModelAtom, reviewSelectedAtom } from "@/app/view/agents/reviewstore";
```

remove `buildReviewBindings,` from the import list from `./bindings`, and delete the entire `describe("review bindings", () => { ... });` block.

In `frontend/app/store/keybindings/store.test.ts`: remove `buildReviewBindings,` from the import list, and delete this test:

```ts
    it("global + review bindings (files review mode) do not conflict", () => {
        const model = {} as any;
        globalStore.set(listNavAtom, null);
        expect(() => assertNoConflicts([...buildGlobalBindings(model), ...buildReviewBindings()])).not.toThrow();
    });
```

- [ ] **Step 5: Strip the mode out of the surface**

In `frontend/app/view/agents/filessurface.tsx`:

Delete both review imports:

```ts
import { ReviewSurface } from "./reviewsurface";
import { decisionsAtom, fileDecision, hunkKey, loadReview, progressOf, reviewModelAtom, reviewSelectedAtom } from "./reviewstore";
```

Also delete the now-unused `StackedMeter` import (`import { StackedMeter } from "@/app/element/meter";`) — the review progress bar was its only user in this file.

Delete these three atom reads:

```ts
    const reviewModel = useAtomValue(reviewModelAtom);
    const decisions = useAtomValue(decisionsAtom);
    const reviewSel = useAtomValue(reviewSelectedAtom);
```

Delete the mode state and its run-scope override:

```ts
    const [modeState, setMode] = useState<"browse" | "review">("browse");
    const runSource = useAtomValue(model.filesRunAtom);
    const mode = runSource ? "browse" : modeState; // run view is read-only: no Review/revert
```

and replace with just:

```ts
    const runSource = useAtomValue(model.filesRunAtom);
```

Delete the review-loading effect entirely:

```ts
    useEffect(() => {
        if (mode === "review" && state?.cwd) {
            void loadReview(state.cwd);
        }
    }, [mode, state?.cwd]);
```

Simplify `browseNav` — drop the `mode === "browse" &&` condition and rewrite its comment, since there is no longer another mode to withdraw for:

```ts
    // publish the file list for global j/k list-nav. cursor==selection: moving selects the file,
    // which loads its diff. Must run before the early return (hooks rules).
    const browseNav = useMemo<ListNavController | null>(
        () =>
            state?.cwd
                ? {
                      surface: "files",
                      navigableIds: filePaths,
                      cursorId: selected ?? undefined,
                      setCursor: (path) => fireAndForget(() => selectFile(state.cwd!, path)),
                      // moving already loads the diff; Enter opens the selected file in the editor (its
                      // primary action button), mirroring the CenterPane "Open in editor" control.
                      activate: selected ? () => getApi().openExternal(joinPath(state.cwd!, selected)) : undefined,
                  }
                : null,
        [state?.cwd, filePaths.join(" "), selected]
    );
```

Delete the `rprog` / `rSelPath` locals and the comment above them:

```ts
    // review mode reuses this one sidebar list: progress header + per-file verdict/counts,
    // selection driven through reviewSelectedAtom (the hunk pane lives in ReviewSurface).
    const rprog = reviewModel ? progressOf(reviewModel.files, decisions) : null;
    const rSelPath = reviewModel
        ? (reviewModel.files.find((f) => f.path === reviewSel)?.path ?? reviewModel.files[0]?.path ?? null)
        : null;
```

Delete the segmented control — the whole `{!runSource && ( ... )}` block containing the two Browse/Review buttons — leaving the header as just `<h1 className="text-[16px] font-bold">Diff</h1>`.

Delete the review progress meter block — the whole `{mode === "review" && rprog && ( ... )}` expression.

In the sidebar list, remove the `mode === "review" ? ( ... ) : ` arm so the chain starts at `loadError ? (`.

Finally, replace the pane switch:

```ts
                {mode === "review" ? <ReviewSurface /> : <CenterPane path={selected} view={diff} cwd={state?.cwd ?? null} />}
```

with:

```ts
                <CenterPane path={selected} view={diff} cwd={state?.cwd ?? null} />
```

- [ ] **Step 6: Verify nothing dangles**

Run: `grep -rn "reviewstore\|reviewsurface\|ReviewSurface\|buildReviewBindings\|modeState" --include=*.ts --include=*.tsx frontend/`
Expected: no output.

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

Run: `npx vitest run frontend/app/store/keybindings/`
Expected: PASS, with the review cases gone.

- [ ] **Step 7: Note the orphaned backend, do not delete it**

Removing the frontend orphans the revert path: `GitRevertCommand` in `pkg/wshrpc/wshrpctypes_projects.go:15` and `pkg/wshrpc/wshserver/wshserver_projects.go`, plus `RevertFile` and `RevertHunk` in `pkg/gitinfo/gitinfo.go` (covered by `TestRevertFileSubdir` and `TestRevertHunkSubdir`). **Leave all of it in place.** Removing tested Go code here widens the blast radius for no user-visible gain, and it follows the precedent already set for the orphaned standalone WaveAI chat block.

Add one line to `docs/deferred.md` under its existing structure recording the orphan:

```markdown
- **Git revert backend is orphaned** (2026-07-31). Deleting Review mode from the Diff surface left `GitRevertCommand` (`pkg/wshrpc/wshrpctypes_projects.go`) and `gitinfo.RevertFile` / `gitinfo.RevertHunk` with no caller. Kept deliberately — tested Go code, zero runtime cost, and a cleanup candidate rather than a defect.
```

---

### Task 3: Make the plan-1 graph modules usable by a component

Three small gaps between what plan 1 produced and what a React component needs. All three are in the two pure modules and all three are testable without rendering.

1. `assignLanes` is typed `(commits: GraphCommit[]) => LanedRow[]`. It spreads the input (`{...commit, lane, merge}`), so display fields survive at runtime but TypeScript erases them. Making it generic keeps them.
2. `GraphGeometry` reports `foldedCount` but not *where* to draw the fold indicator. `PAD_L` and `LANE_W` are module-private, so a component cannot compute it. Add `foldX`.
3. The `--color-graphlane-*` palette does not exist yet.

**Files:**
- Modify: `frontend/app/view/agents/gitgraph.ts:42` (the `assignLanes` signature)
- Modify: `frontend/app/view/agents/gitgraphgeom.ts:42-49` (the `GraphGeometry` interface) and `:116-117` (the return)
- Modify: `frontend/app/view/agents/gitgraphgeom.test.ts` (append one test)
- Modify: `frontend/tailwindsetup.css` (after the avatar palette, currently ending line 89)

**Interfaces:**
- Consumes: `GraphCommit`, `LanedRow`, `GraphGeometry` from plan 1.
- Produces: `assignLanes<T extends GraphCommit>(commits: T[]): (T & { lane: number; merge: boolean })[]`; `GraphGeometry.foldX: number`; the CSS custom properties `--color-graphlane-1` … `--color-graphlane-6` and `--color-graphlane-fold`, available as Tailwind colour utilities and as `var(--color-graphlane-N)` in inline SVG attributes. Task 6's `graphgutter.tsx` uses all of them.

- [ ] **Step 1: Write the failing test for `foldX`**

Append to `frontend/app/view/agents/gitgraphgeom.test.ts`:

```ts
it("reports where to draw the fold indicator, just left of the last drawable lane", () => {
    const rows = assignLanes([
        { hash: "a", parents: ["b"] },
        { hash: "b", parents: [] },
    ]);
    // lanes are 15px wide starting at a 13px left pad, and the indicator is centred on the last
    // drawable lane: 13 + (3 - 1) * 15 - 7 = 36
    expect(graphGeometry(rows, { rowH: 34, maxLanes: 3 }).foldX).toBe(36);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/gitgraphgeom.test.ts`
Expected: FAIL — `Property 'foldX' does not exist on type 'GraphGeometry'` at typecheck, or `expected undefined to be 36` at runtime.

- [ ] **Step 3: Add `foldX` to the geometry**

In `frontend/app/view/agents/gitgraphgeom.ts`, add the field to the interface:

```ts
export interface GraphGeometry {
    width: number;
    height: number;
    gutter: number;
    edges: GraphEdge[];
    nodes: GraphNode[];
    foldedCount: number;
    // x of the fold indicator, centred on the last drawable lane. Meaningful only when foldedCount > 0.
    foldX: number;
}
```

and include it in the return:

```ts
    const gutter = PAD_L + maxLanes * LANE_W + 4;
    return {
        width: gutter,
        height: rows.length === 0 ? 0 : acc + BOTTOM_PAD,
        gutter,
        edges,
        nodes,
        foldedCount,
        foldX: x(lastLane) - 7,
    };
```

- [ ] **Step 4: Make `assignLanes` generic**

In `frontend/app/view/agents/gitgraph.ts`, change the signature and the internal row type so display fields carried on the input survive with their types:

```ts
// Generic in the commit type so callers that carry display fields (subject, author, refs) get them
// back on the laned rows instead of having them erased to GraphCommit.
export function assignLanes<T extends GraphCommit>(commits: T[]): (T & { lane: number; merge: boolean })[] {
    const slots: Slots = [];
    const rows: (T & { lane: number; merge: boolean })[] = [];
```

The body is otherwise unchanged — `rows.push({ ...commit, lane, merge: commit.parents.length > 1 })` already produces exactly that type. Leave `LanedRow` exported as-is; it remains the shape `graphGeometry` accepts, and `T & { lane; merge }` is assignable to it.

- [ ] **Step 5: Add the lane palette**

In `frontend/tailwindsetup.css`, insert immediately after the `--color-avatar-6` line (the end of the avatar palette block):

```css
    /* Commit-graph lane palette (positional, never identity — see gitgraph.ts / graphgutter.tsx).
       Distinct from --color-lane, which is the agent-card lane fill and means something else.
       Literal hexes, matching how the avatar palette above is defined. */
    --color-graphlane-1: #7c95ff;
    --color-graphlane-2: #54c79a;
    --color-graphlane-3: #e6b450;
    --color-graphlane-4: #c9a4ff;
    --color-graphlane-5: #e0726c;
    --color-graphlane-6: #5cc8d8;
    --color-graphlane-fold: #6b7178;
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/gitgraph.test.ts frontend/app/view/agents/gitgraphgeom.test.ts`
Expected: PASS — the seven lane-assignment cases and the ten geometry cases (nine from plan 1 plus the new `foldX` case).

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. The generic change is source-compatible; if it reports an error at an existing `assignLanes` call site, the call is passing a union type — fix it there, not by reverting the generic.

---

### Task 4: Derive display rows from the raw commit log

Everything between "the RPC returned commits" and "the pane renders rows" is pure and belongs here: classifying git's ref decoration into chip kinds, formatting the relative time, synthesising the uncommitted row, marking the scope anchor with a divider, dimming commits before it, and choosing what is selected by default.

**Files:**
- Create: `frontend/app/view/agents/historyrows.ts`
- Create: `frontend/app/view/agents/historyrows.test.ts`

**Interfaces:**
- Consumes: `GraphCommit` from `./gitgraph`; `formatAge(ms?: number): string` from `./agentsviewmodel` (returns `"just now"` / `"42m"` / `"3h"` / `"5d"`); the generated global type `HistoryCommit = { hash, parents, author, email, ts, subject, refs? }` — `ts` is UnixMilli.
- Produces: `WORKING_TREE`, `RefKind`, `RefChip`, `HistoryRow`, `BuildRowsOpts`, `classifyRef(raw: string): RefChip | null`, `refChipClass(kind: RefKind): string`, `buildRows(commits: HistoryCommit[], opts: BuildRowsOpts): HistoryRow[]`, `defaultSelection(rows: HistoryRow[]): string | null`. Tasks 5, 6 and 7 all consume `HistoryRow`; Tasks 6 and 7 both consume `refChipClass`, which is why it lives here rather than being duplicated in each pane — the same reasoning that puts `statusColor` in `gitstatus.ts`.

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/agents/historyrows.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { WORKING_TREE, buildRows, classifyRef, defaultSelection, refChipClass, type RefKind } from "./historyrows";

const NOW = 1_800_000_000_000;

function commit(hash: string, over: Partial<HistoryCommit> = {}): HistoryCommit {
    return { hash, parents: [], author: "dana k", email: "dana@example.com", ts: NOW, subject: `subject ${hash}`, ...over };
}

describe("classifyRef", () => {
    it("reads HEAD, remotes, tags and plain branches apart", () => {
        expect(classifyRef("HEAD -> main")).toEqual({ label: "main", kind: "head" });
        expect(classifyRef("HEAD")).toEqual({ label: "HEAD", kind: "head" });
        expect(classifyRef("tag: v0.9.4")).toEqual({ label: "v0.9.4", kind: "tag" });
        expect(classifyRef("origin/main")).toEqual({ label: "origin/main", kind: "remote" });
        expect(classifyRef("feature/idempotent-retries")).toEqual({
            label: "feature/idempotent-retries",
            kind: "branch",
        });
    });

    it("drops empty decorations", () => {
        expect(classifyRef("")).toBeNull();
        expect(classifyRef("   ")).toBeNull();
    });
});

describe("refChipClass", () => {
    it("gives each kind a distinct class string built only from existing tokens", () => {
        const kinds: RefKind[] = ["head", "remote", "branch", "tag"];
        const classes = kinds.map(refChipClass);
        expect(new Set(classes).size).toBe(4);
        // a raw hex here would silently opt the chip out of runtime theming
        expect(classes.join(" ")).not.toMatch(/#[0-9a-f]{3}/i);
    });
});

describe("buildRows", () => {
    it("puts uncommitted work above the tip, parented to HEAD", () => {
        const rows = buildRows([commit("aaa"), commit("bbb")], {
            head: "aaa",
            dirtyFileCount: 3,
            now: NOW,
        });
        expect(rows).toHaveLength(3);
        expect(rows[0].hash).toBe(WORKING_TREE);
        expect(rows[0].workingTree).toBe(true);
        expect(rows[0].parents).toEqual(["aaa"]);
        expect(rows[0].subject).toBe("Uncommitted — 3 files in the working tree");
        expect(rows[0].when).toBe("now");
        expect(rows[1].hash).toBe("aaa");
    });

    it("uses the singular when exactly one file is dirty", () => {
        const rows = buildRows([commit("aaa")], { head: "aaa", dirtyFileCount: 1, now: NOW });
        expect(rows[0].subject).toBe("Uncommitted — 1 file in the working tree");
    });

    it("omits the uncommitted row on a clean tree", () => {
        const rows = buildRows([commit("aaa")], { head: "aaa", dirtyFileCount: 0, now: NOW });
        expect(rows).toHaveLength(1);
        expect(rows[0].hash).toBe("aaa");
    });

    it("marks the anchor with a divider and dims everything older", () => {
        const rows = buildRows([commit("aaa"), commit("bbb"), commit("ccc")], {
            head: "aaa",
            dirtyFileCount: 0,
            anchor: "bbb",
            anchorLabel: "session start",
            now: NOW,
        });
        expect(rows[0].before).toBe(false);
        expect(rows[1].hash).toBe("bbb");
        expect(rows[1].divider).toBe("session start");
        expect(rows[1].before).toBe(false);
        expect(rows[2].before).toBe(true);
    });

    it("leaves every row undimmed when the anchor is not in the page", () => {
        const rows = buildRows([commit("aaa"), commit("bbb")], {
            head: "aaa",
            dirtyFileCount: 0,
            anchor: "zzz",
            anchorLabel: "session start",
            now: NOW,
        });
        expect(rows.every((r) => !r.before)).toBe(true);
        expect(rows.every((r) => r.divider == null)).toBe(true);
    });

    it("formats age compactly and collapses sub-minute to now", () => {
        const rows = buildRows(
            [commit("aaa", { ts: NOW - 30_000 }), commit("bbb", { ts: NOW - 7_200_000 }), commit("ccc", { ts: NOW - 172_800_000 })],
            { head: "aaa", dirtyFileCount: 0, now: NOW }
        );
        expect(rows.map((r) => r.when)).toEqual(["now", "2h", "2d"]);
    });

    it("carries parents and classified refs through", () => {
        const rows = buildRows(
            [commit("aaa", { parents: ["bbb", "ccc"], refs: ["HEAD -> main", "tag: v1.0"] })],
            { head: "aaa", dirtyFileCount: 0, now: NOW }
        );
        expect(rows[0].parents).toEqual(["bbb", "ccc"]);
        expect(rows[0].refs).toEqual([
            { label: "main", kind: "head" },
            { label: "v1.0", kind: "tag" },
        ]);
    });
});

describe("defaultSelection", () => {
    it("prefers the uncommitted row", () => {
        const rows = buildRows([commit("aaa")], { head: "aaa", dirtyFileCount: 2, now: NOW });
        expect(defaultSelection(rows)).toBe(WORKING_TREE);
    });

    it("falls back to the tip commit on a clean tree", () => {
        const rows = buildRows([commit("aaa"), commit("bbb")], { head: "aaa", dirtyFileCount: 0, now: NOW });
        expect(defaultSelection(rows)).toBe("aaa");
    });

    it("returns null for an empty history", () => {
        expect(defaultSelection([])).toBeNull();
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/historyrows.test.ts`
Expected: FAIL with `Failed to resolve import "./historyrows"`.

- [ ] **Step 3: Write the module**

Create `frontend/app/view/agents/historyrows.ts`:

```ts
// frontend/app/view/agents/historyrows.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: raw commit log -> the rows the history pane draws. Ref-chip classification, relative time,
// the synthetic uncommitted row, the scope anchor's divider and what is selected by default all live
// here so the pane stays a renderer. Lane assignment is gitgraph.ts; coordinates are gitgraphgeom.ts.

import { formatAge } from "./agentsviewmodel";
import type { GraphCommit } from "./gitgraph";

// Sentinel hash for the synthetic uncommitted row. Empty on purpose: gitgraphgeom skips falsy hashes
// when indexing rows, so nothing can draw an edge *into* the working tree — which is correct, it has
// no children. Its own edge to HEAD still draws, because that reads its parents.
export const WORKING_TREE = "";

export type RefKind = "head" | "remote" | "branch" | "tag";

export interface RefChip {
    label: string;
    kind: RefKind;
}

export interface HistoryRow extends GraphCommit {
    subject: string;
    author: string;
    email: string;
    ts: number;
    when: string;
    refs: RefChip[];
}

export interface BuildRowsOpts {
    // current HEAD; the uncommitted row hangs off it
    head: string;
    // how many files are dirty; 0 suppresses the uncommitted row entirely
    dirtyFileCount: number;
    // scope anchor (agent session-start commit, run base commit). Gets a labelled divider; commits
    // older than it are context and render dimmed.
    anchor?: string;
    anchorLabel?: string;
    now: number;
}

// git's %D decoration, one entry at a time: "HEAD -> main", "origin/main", "tag: v0.9.4", "feature/x".
export function classifyRef(raw: string): RefChip | null {
    const s = raw.trim();
    if (!s) {
        return null;
    }
    if (s.startsWith("tag: ")) {
        return { label: s.slice(5).trim(), kind: "tag" };
    }
    if (s.startsWith("HEAD -> ")) {
        return { label: s.slice(8).trim(), kind: "head" };
    }
    if (s === "HEAD") {
        return { label: s, kind: "head" };
    }
    // a slash means a remote-tracking ref ("origin/main"); a local branch can contain a slash too
    // ("feature/x"), so only treat the first segment as a remote when it is not the whole name.
    return { label: s, kind: s.includes("/") && !s.startsWith("refs/") ? "remote" : "branch" };
}

// Tailwind classes for a ref chip, kept beside the type it describes — the same shape as
// gitstatus.ts's statusColor, so both panes share one mapping instead of duplicating it.
export function refChipClass(kind: RefKind): string {
    switch (kind) {
        case "head":
            return "text-accent-soft bg-accentbg border-accent/30";
        case "tag":
            return "text-warning bg-warning/12 border-warning/25";
        case "branch":
            return "text-graphlane-2 bg-success/12 border-success/25";
        default:
            return "text-muted bg-surface-raised border-edge-mid";
    }
}

function ageLabel(ts: number, now: number): string {
    const ms = now - ts;
    return ms < 60_000 ? "now" : formatAge(ms);
}

export function buildRows(commits: HistoryCommit[], opts: BuildRowsOpts): HistoryRow[] {
    const anchorIdx = opts.anchor ? commits.findIndex((c) => c.hash === opts.anchor) : -1;
    const rows: HistoryRow[] = commits.map((c, i) => ({
        hash: c.hash,
        parents: c.parents ?? [],
        subject: c.subject,
        author: c.author,
        email: c.email,
        ts: c.ts,
        when: ageLabel(c.ts, opts.now),
        refs: (c.refs ?? []).map(classifyRef).filter((r): r is RefChip => r != null),
        divider: anchorIdx >= 0 && i === anchorIdx ? opts.anchorLabel : undefined,
        before: anchorIdx >= 0 && i > anchorIdx,
    }));
    if (opts.dirtyFileCount <= 0) {
        return rows;
    }
    const noun = opts.dirtyFileCount === 1 ? "file" : "files";
    rows.unshift({
        hash: WORKING_TREE,
        parents: opts.head ? [opts.head] : [],
        workingTree: true,
        subject: `Uncommitted — ${opts.dirtyFileCount} ${noun} in the working tree`,
        author: "you",
        email: "",
        ts: opts.now,
        when: "now",
        refs: [],
        before: false,
    });
    return rows;
}

// What the surface selects when history first arrives: uncommitted work if there is any, else the tip.
export function defaultSelection(rows: HistoryRow[]): string | null {
    if (rows.length === 0) {
        return null;
    }
    return rows[0].workingTree ? WORKING_TREE : rows[0].hash;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/historyrows.test.ts`
Expected: PASS — all thirteen cases.

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

### Task 5: The history store

Atoms plus async loaders, structured exactly like `filesstore.ts`: module-level atoms written by loaders through `globalStore`, guarded by a token so a stale load cannot overwrite a newer one. Being module-level is also what gives commit selection persistence across surface unmount for free — the Diff surface unmounts when the user navigates away, but module atoms do not.

Panes 2 and 3 must show either the working tree or a commit. Rather than teaching each pane that branch, two derived atoms resolve it once here.

**Files:**
- Create: `frontend/app/view/agents/githistorystore.ts`

**Interfaces:**
- Consumes: `RpcApi.GitHistoryCommand` and the two commands from Task 1; `WORKING_TREE`, `buildRows`, `defaultSelection`, `HistoryRow` from Task 4; `filesStateAtom`, `filesDiffAtom`, `selectFile` from `./filesstore`; `parseGitChanges`, `GitChanges` from `./gitstatus`; `parseUnifiedDiff`, `FileView` from `./gitdiff`.
- Produces: `historyRowsAtom`, `historyErrorAtom`, `selectedCommitAtom`, `selectedFileAtom`, `graphOnAtom`, `activeChangesAtom`, `activeDiffAtom`, `loadHistory(cwd, opts)`, `selectCommit(cwd, hash)`, `selectCommitFile(cwd, hash, path)`, `resetHistory()`. Tasks 6, 7 and 8 read these.

- [ ] **Step 1: Write the store**

Create `frontend/app/view/agents/githistorystore.ts`:

```ts
// frontend/app/view/agents/githistorystore.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Commit-history state for the Diff surface. Mirrors filesstore.ts: module-level atoms written by
// async loaders via globalStore, with a guard token so a stale load cannot clobber a newer one.
// Module scope is deliberate — the surface unmounts on nav switch, so anything held in component
// state would be lost; the selected commit and open file survive here.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import { filesDiffAtom, filesStateAtom, selectFile } from "./filesstore";
import { parseUnifiedDiff, type FileView } from "./gitdiff";
import { parseGitChanges, type GitChanges } from "./gitstatus";
import { WORKING_TREE, buildRows, defaultSelection, type HistoryRow } from "./historyrows";

export const historyRowsAtom = atom<HistoryRow[] | null>(null) as PrimitiveAtom<HistoryRow[] | null>;
// true = the history read failed, which is deliberately distinct from "this is not a repository"
export const historyErrorAtom = atom<boolean>(false) as PrimitiveAtom<boolean>;
// null = nothing selected yet; WORKING_TREE ("") = the uncommitted row; otherwise a commit hash
export const selectedCommitAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
export const selectedFileAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
export const graphOnAtom = atom<boolean>(true) as PrimitiveAtom<boolean>;

const commitChangesAtom = atom<GitChanges | null>(null) as PrimitiveAtom<GitChanges | null>;
const commitDiffAtom = atom<FileView | null>(null) as PrimitiveAtom<FileView | null>;

// Panes 2 and 3 read one source regardless of what is selected: the working-tree row reuses the
// scope's already-loaded change set from filesstore, a commit uses its own.
export const activeChangesAtom = atom<GitChanges | null>((get) =>
    get(selectedCommitAtom) === WORKING_TREE ? (get(filesStateAtom)?.changes ?? null) : get(commitChangesAtom)
);
export const activeDiffAtom = atom<FileView | null>((get) =>
    get(selectedCommitAtom) === WORKING_TREE ? get(filesDiffAtom) : get(commitDiffAtom)
);

const current = { token: "" };

export interface LoadHistoryOpts {
    // scope anchor: an agent's session-start commit or a run's base commit
    anchor?: string;
    anchorLabel?: string;
}

export function resetHistory(): void {
    current.token = "";
    globalStore.set(historyRowsAtom, null);
    globalStore.set(historyErrorAtom, false);
    globalStore.set(selectedCommitAtom, null);
    globalStore.set(selectedFileAtom, null);
    globalStore.set(commitChangesAtom, null);
    globalStore.set(commitDiffAtom, null);
}

export async function loadHistory(cwd: string | null, opts: LoadHistoryOpts = {}): Promise<void> {
    const token = `${cwd ?? ""}|${opts.anchor ?? ""}`;
    if (!cwd) {
        resetHistory();
        return;
    }
    current.token = token;
    globalStore.set(historyRowsAtom, null);
    globalStore.set(historyErrorAtom, false);
    try {
        const h = await RpcApi.GitHistoryCommand(TabRpcClient, { cwd });
        if (current.token !== token) {
            return;
        }
        if (!h.isrepo) {
            globalStore.set(historyRowsAtom, []);
            return;
        }
        const rows = buildRows(h.commits ?? [], {
            head: h.head,
            dirtyFileCount: globalStore.get(filesStateAtom)?.changes?.files.length ?? 0,
            anchor: opts.anchor,
            anchorLabel: opts.anchorLabel,
            now: Date.now(),
        });
        globalStore.set(historyRowsAtom, rows);
        const pick = defaultSelection(rows);
        if (pick != null) {
            void selectCommit(cwd, pick);
        }
    } catch {
        if (current.token === token) {
            globalStore.set(historyErrorAtom, true);
            globalStore.set(historyRowsAtom, []);
        }
    }
}

export async function selectCommit(cwd: string, hash: string): Promise<void> {
    globalStore.set(selectedCommitAtom, hash);
    globalStore.set(selectedFileAtom, null);
    globalStore.set(commitDiffAtom, null);
    if (hash === WORKING_TREE) {
        // the working tree's file list is already loaded by filesstore for the active scope; just pick
        // its first file so pane 3 is never blank
        const first = globalStore.get(filesStateAtom)?.changes?.files[0]?.path;
        if (first) {
            globalStore.set(selectedFileAtom, first);
            void selectFile(cwd, first);
        }
        return;
    }
    globalStore.set(commitChangesAtom, null);
    try {
        const ch = await RpcApi.GitCommitChangesCommand(TabRpcClient, { cwd, hash });
        if (globalStore.get(selectedCommitAtom) !== hash) {
            return; // selection moved on
        }
        const changes = ch.isrepo ? parseGitChanges(ch.statusz, ch.numstat) : null;
        globalStore.set(commitChangesAtom, changes);
        const first = changes?.files[0]?.path;
        if (first) {
            void selectCommitFile(cwd, hash, first);
        }
    } catch {
        if (globalStore.get(selectedCommitAtom) === hash) {
            globalStore.set(commitChangesAtom, null);
        }
    }
}

export async function selectCommitFile(cwd: string, hash: string, path: string): Promise<void> {
    globalStore.set(selectedFileAtom, path);
    if (hash === WORKING_TREE) {
        void selectFile(cwd, path);
        return;
    }
    globalStore.set(commitDiffAtom, null);
    try {
        const d = await RpcApi.GitCommitDiffCommand(TabRpcClient, { cwd, hash, path });
        if (globalStore.get(selectedFileAtom) !== path || globalStore.get(selectedCommitAtom) !== hash) {
            return; // selection moved on
        }
        globalStore.set(commitDiffAtom, parseUnifiedDiff(d.diff));
    } catch {
        if (globalStore.get(selectedFileAtom) === path) {
            globalStore.set(commitDiffAtom, null);
        }
    }
}
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. If `GitCommitChangesCommand` is reported as missing on `RpcApi`, Task 1's `task generate` did not run — go back and run it.

- [ ] **Step 3: Confirm the existing suite still passes**

Run: `npx vitest run frontend/app/view/agents/`
Expected: PASS. This store has no test of its own by design — it is glue, and the repo convention is that pure derivation is tested (Task 4 covers it) while thin RPC plumbing is not. `filesstore.ts` has no test either.

---

### Task 6: The graph gutter and the history pane

Pane 1. The gutter is a separate file because it is the single place a lane index becomes a colour token — keeping that mapping in one small module is what makes runtime theming provably intact.

Measurements come from the mockup: 34px rows, a 52px hash column, a 92px author cap, a 42px right-aligned time column, and a 2px accent bar on the selected row. The graph is absolutely positioned behind the rows and each row is left-padded by the gutter width, so the two stay in register without the rows knowing anything about SVG.

**Files:**
- Create: `frontend/app/view/agents/graphgutter.tsx`
- Create: `frontend/app/view/agents/historypane.tsx`

**Interfaces:**
- Consumes: `GraphGeometry` from `./gitgraphgeom` (including Task 3's `foldX`); `assignLanes`, `laneCount` from `./gitgraph`; `graphGeometry` from `./gitgraphgeom`; `HistoryRow`, `RefChip`, `WORKING_TREE` from `./historyrows`; `SkeletonLine` from `@/app/element/skeleton`; `cn` from `@/util/util`.
- Produces: `GraphGutter({ geom })` and `HistoryPane({ rows, selected, graphOn, loading, onSelect })`. Task 8 renders `HistoryPane`.

- [ ] **Step 1: Write the gutter**

Create `frontend/app/view/agents/graphgutter.tsx`:

```tsx
// frontend/app/view/agents/graphgutter.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The commit-graph lane gutter. The only place a lane index becomes a colour: gitgraphgeom returns
// lane indices and flags, and this maps them onto --color-graphlane-N so a runtime theme override
// still reaches the graph. Lane hue is positional, never identity — nothing is claimed by a colour.

import type { GraphGeometry } from "./gitgraphgeom";

const LANE_TOKENS = [
    "var(--color-graphlane-1)",
    "var(--color-graphlane-2)",
    "var(--color-graphlane-3)",
    "var(--color-graphlane-4)",
    "var(--color-graphlane-5)",
    "var(--color-graphlane-6)",
];
const FOLD_TOKEN = "var(--color-graphlane-fold)";
const FOLD_W = 14;

function laneColor(lane: number, folded: boolean): string {
    return folded ? FOLD_TOKEN : LANE_TOKENS[lane % LANE_TOKENS.length];
}

export function GraphGutter({ geom }: { geom: GraphGeometry }) {
    if (geom.nodes.length === 0) {
        return null;
    }
    return (
        <svg
            width={geom.width}
            height={geom.height}
            className="pointer-events-none absolute left-0 top-0"
            aria-hidden="true"
        >
            {geom.foldedCount > 0 ? (
                <>
                    <rect x={geom.foldX} y={0} width={FOLD_W} height={geom.height} rx={4} fill={FOLD_TOKEN} opacity={0.13} />
                    <text x={geom.foldX} y={11} fill={FOLD_TOKEN} fontSize={8} fontWeight={600} className="font-mono">
                        +{geom.foldedCount}
                    </text>
                </>
            ) : null}
            {geom.edges.map((e, i) => (
                <path
                    key={i}
                    d={e.d}
                    fill="none"
                    stroke={laneColor(e.lane, e.folded)}
                    strokeWidth={1.8}
                    strokeDasharray={e.dashed ? "3 3" : undefined}
                    opacity={e.folded ? 0.5 : 1}
                />
            ))}
            {geom.nodes.map((n, i) => (
                <circle
                    key={i}
                    cx={n.x}
                    cy={n.y}
                    r={n.r}
                    // hollow for merges and for the working tree, so both read as "not an ordinary commit"
                    fill={n.merge || n.workingTree ? "var(--color-background)" : laneColor(n.lane, n.folded)}
                    stroke={laneColor(n.lane, n.folded)}
                    strokeWidth={2}
                    strokeDasharray={n.workingTree ? "2.5 2.5" : undefined}
                />
            ))}
        </svg>
    );
}
```

- [ ] **Step 2: Write the pane**

Create `frontend/app/view/agents/historypane.tsx`:

```tsx
// frontend/app/view/agents/historypane.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pane 1 of the Diff surface (Wave-git-review.dc.html): commits newest-first, the uncommitted row at
// the top, an optional lane gutter behind them. Rows are left-padded by the gutter width so the SVG
// and the list stay in register without the rows knowing any geometry.

import { SkeletonLine } from "@/app/element/skeleton";
import { cn } from "@/util/util";
import { assignLanes, laneCount } from "./gitgraph";
import { graphGeometry } from "./gitgraphgeom";
import { GraphGutter } from "./graphgutter";
import { WORKING_TREE, refChipClass, type HistoryRow } from "./historyrows";

const ROW_H = 34;
const HASH_W = 52;
// lanes past this fold into one grey column; nine concurrent lanes will not fit the history column
const MAX_LANES = 7;
const NO_GRAPH_PAD = 14;

function shortHash(hash: string): string {
    return hash === WORKING_TREE ? "·······" : hash.slice(0, 7);
}

// SkeletonLine takes only className, so the ragged widths are literal utility classes rather than an
// inline style — Tailwind cannot generate a class from a computed string either, so no template here.
const SKELETON_WIDTHS = ["w-[120px]", "w-[190px]", "w-[150px]", "w-[210px]", "w-[135px]"];

function HistorySkeleton() {
    return (
        <div className="px-[14px]">
            {Array.from({ length: 10 }).map((_, i) => (
                <div key={i} className="flex h-[34px] items-center gap-[10px]">
                    <SkeletonLine className="h-[9px] w-[9px] rounded-full" />
                    <SkeletonLine className={cn("h-[8px]", SKELETON_WIDTHS[i % SKELETON_WIDTHS.length])} />
                    <div className="flex-1" />
                    <SkeletonLine className="h-[8px] w-[34px]" />
                </div>
            ))}
        </div>
    );
}

function Row({
    row,
    laneIndent,
    selected,
    onSelect,
}: {
    row: HistoryRow;
    laneIndent: number;
    selected: boolean;
    onSelect: () => void;
}) {
    // refs eat the subject's width fast; show the first and collapse the rest into a count
    const chips = row.refs.length > 1 ? row.refs.slice(0, 1) : row.refs;
    const overflow = row.refs.length - chips.length;
    return (
        <button
            onClick={onSelect}
            style={{ height: ROW_H, paddingLeft: laneIndent }}
            className={cn(
                "relative flex w-full items-center gap-[9px] pr-[12px] text-left transition-colors duration-[140ms] hover:bg-surface",
                selected && "bg-surface-selected"
            )}
        >
            {selected ? <div className="absolute bottom-0 left-0 top-0 w-[2px] bg-accent" /> : null}
            <span
                style={{ width: HASH_W }}
                className={cn("flex-none font-mono text-[11px]", row.workingTree ? "text-ink-faint" : "text-muted")}
            >
                {shortHash(row.hash)}
            </span>
            {chips.map((r) => (
                <span
                    key={r.label}
                    className={cn(
                        "max-w-[110px] flex-none truncate rounded-[4px] border px-[6px] py-[1px] font-mono text-[9.5px] font-semibold",
                        refChipClass(r.kind)
                    )}
                >
                    {r.label}
                </span>
            ))}
            {overflow > 0 ? (
                <span className="flex-none rounded-[4px] border border-edge-mid bg-surface-raised px-[6px] py-[1px] font-mono text-[9.5px] font-semibold text-muted">
                    +{overflow}
                </span>
            ) : null}
            <span
                className={cn(
                    "min-w-[140px] flex-1 truncate text-[12.5px]",
                    row.before
                        ? "text-ink-faint"
                        : selected
                          ? "font-semibold text-ink-hi"
                          : row.workingTree
                            ? "text-warning"
                            : "text-foreground"
                )}
            >
                {row.subject}
            </span>
            {row.refs.length === 0 ? (
                <span className="flex-none truncate text-[11px] text-ink-faint" style={{ maxWidth: 92 }}>
                    {row.author}
                </span>
            ) : null}
            <span className="w-[42px] flex-none text-right font-mono text-[10.5px] text-ink-faint">{row.when}</span>
        </button>
    );
}

function Divider({ label }: { label: string }) {
    return (
        <div className="flex items-center gap-[9px] py-[6px] pl-[14px] pr-[12px]" style={{ height: 30 }}>
            <span className="flex-none rounded-[5px] border border-accent/30 bg-accentbg px-[7px] py-[2px] font-mono text-[8.5px] font-bold uppercase tracking-[0.1em] text-accent-soft">
                {label}
            </span>
            <div className="h-px flex-1 bg-accent/30" />
        </div>
    );
}

export function HistoryPane({
    rows,
    selected,
    graphOn,
    loading,
    onSelect,
}: {
    rows: HistoryRow[];
    selected: string | null;
    graphOn: boolean;
    loading: boolean;
    onSelect: (hash: string) => void;
}) {
    const laned = assignLanes(rows);
    const lanes = Math.min(Math.max(laneCount(laned), 1), MAX_LANES);
    const geom = graphGeometry(laned, { rowH: ROW_H, maxLanes: lanes });
    const indent = graphOn ? geom.gutter : NO_GRAPH_PAD;

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex flex-none items-center gap-[9px] px-[14px] pb-[8px] pt-[10px]">
                <span className="font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-muted">History</span>
                {graphOn && geom.foldedCount > 0 ? (
                    <span className="rounded-[5px] border border-edge-mid bg-surface-raised px-[7px] py-[2px] font-mono text-[9.5px] font-semibold text-graphlane-fold">
                        {laneCount(laned)} lanes · {geom.foldedCount} folded
                    </span>
                ) : null}
                <div className="flex-1" />
                <span className="font-mono text-[10px] text-ink-faint">
                    {loading ? "" : `${rows.length} commit${rows.length === 1 ? "" : "s"}`}
                </span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto pb-[24px]">
                {loading ? (
                    <HistorySkeleton />
                ) : rows.length === 0 ? (
                    <div className="px-[14px] py-[6px] text-[12px] text-ink-mid">No commits</div>
                ) : (
                    <div className="relative">
                        {graphOn ? <GraphGutter geom={geom} /> : null}
                        {laned.map((row) => (
                            <div key={row.hash || "__wt__"}>
                                <Row
                                    row={row}
                                    laneIndent={indent}
                                    selected={selected === row.hash}
                                    onSelect={() => onSelect(row.hash)}
                                />
                                {row.divider ? <Divider label={row.divider} /> : null}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
```

- [ ] **Step 3: Confirm every colour class resolves to a token**

Run: `grep -n "#[0-9a-fA-F]\{3,8\}\|rgba(" frontend/app/view/agents/graphgutter.tsx frontend/app/view/agents/historypane.tsx`
Expected: no output. Every colour must be a `--color-*` token via a Tailwind utility or a `var()`.

Four token names the mockup uses do **not** exist in this codebase: `--color-accent-hi`, `--color-accent-edge`, `--color-warningbg`, `--color-successbg`. The code in this plan already avoids them — do not reintroduce them from the mockup. The substitutions, all onto tokens that do exist:

| Mockup token | Use instead | Why |
|---|---|---|
| `--color-accent-hi` (#aebfff) | `text-accent-soft` | `--color-accent-soft` is already `#aebfff` — the identical value under a different name. |
| `--color-accent-edge` | `border-accent/30` | An opacity modifier on the existing accent, rather than a fifth near-duplicate token. |
| `--color-warningbg` | `bg-warning/12` | Same. |
| `--color-successbg` | `bg-success/12` | Same. |

Confirm the tokens these components *do* rely on all exist:

Run: `for t in graphlane-2 graphlane-fold accent accent-soft accentbg warning success edge-mid edge-faint edge-strong surface-raised surface-selected ink-hi ink-mid ink-faint muted; do printf "%-18s " "$t"; grep -c -- "--color-$t:" frontend/tailwindsetup.css; done`

Expected: `1` on every line. A `0` means either Task 3's palette block was not added or a token was renamed since this plan was written — stop and report it rather than inventing a colour.

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

### Task 7: The commit pane

Pane 2: the selected commit's identity and what it touched. 300px fixed, per the mockup.

Provenance ("Produced by Run #148") appears in the mockup but nothing in the codebase computes the commit-to-run join today; the brief calls it out as new work. It is **not** in this plan — see "Not in this plan".

**Files:**
- Create: `frontend/app/view/agents/commitpane.tsx`

**Interfaces:**
- Consumes: `HistoryRow`, `WORKING_TREE` from `./historyrows`; `GitChanges`, `statusColor` from `./gitstatus`; `SkeletonLine` from `@/app/element/skeleton`; `cn` from `@/util/util`.
- Produces: `CommitPane({ row, changes, selectedFile, onSelectFile })`. Task 8 renders it.

- [ ] **Step 1: Write the pane**

Create `frontend/app/view/agents/commitpane.tsx`:

```tsx
// frontend/app/view/agents/commitpane.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pane 2 of the Diff surface (Wave-git-review.dc.html): who made the selected commit, when, and which
// files it touched. Read-only — no stage control, no message box, nothing that authors a commit.

import { SkeletonLine } from "@/app/element/skeleton";
import { cn } from "@/util/util";
import { statusColor, type GitChanges } from "./gitstatus";
import { WORKING_TREE, refChipClass, type HistoryRow } from "./historyrows";

function initials(name: string): string {
    return name.slice(0, 2).toUpperCase();
}

function FileListSkeleton() {
    return (
        <div className="space-y-[7px] px-[8px] py-[6px]">
            {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-[8px] px-[8px] py-[5px]">
                    <SkeletonLine className="h-[12px] flex-1" />
                    <SkeletonLine className="h-[10px] w-[22px]" />
                </div>
            ))}
        </div>
    );
}

export function CommitPane({
    row,
    changes,
    selectedFile,
    onSelectFile,
}: {
    row: HistoryRow | null;
    changes: GitChanges | null;
    selectedFile: string | null;
    onSelectFile: (path: string) => void;
}) {
    if (row == null) {
        return (
            <div className="flex h-full items-center justify-center px-[20px] text-center text-[12.5px] text-muted">
                Select a commit
            </div>
        );
    }
    const isWorkingTree = row.hash === WORKING_TREE;
    const count = changes?.files.length ?? 0;
    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex-none border-b border-edge-faint px-[15px] pb-[12px] pt-[14px]">
                <div className="mb-[9px] flex flex-wrap items-center gap-[8px]">
                    <span className="rounded-[5px] border border-accent/30 bg-accentbg px-[7px] py-[2px] font-mono text-[12px] font-semibold text-accent-soft">
                        {isWorkingTree ? "working tree" : row.hash.slice(0, 7)}
                    </span>
                    {row.refs.map((r) => (
                        <span
                            key={r.label}
                            className={cn(
                                "rounded-[4px] border px-[6px] py-[2px] font-mono text-[9.5px] font-semibold",
                                refChipClass(r.kind)
                            )}
                        >
                            {r.label}
                        </span>
                    ))}
                </div>
                <div className="mb-[8px] text-[14px] font-semibold leading-[1.4] text-ink-hi">{row.subject}</div>
                <div className="flex items-center gap-[8px]">
                    <span className="flex h-[20px] w-[20px] items-center justify-center rounded-full bg-surface-raised font-mono text-[9px] font-bold text-ink-mid">
                        {initials(row.author)}
                    </span>
                    <span className="text-[12px] text-ink-mid">{row.author}</span>
                    <span className="font-mono text-[11px] text-ink-faint">
                        {isWorkingTree ? "not committed" : row.when}
                    </span>
                </div>
            </div>
            <div className="flex flex-none items-center gap-[9px] px-[15px] pb-[8px] pt-[10px]">
                <span className="font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-muted">
                    {count} {count === 1 ? "file" : "files"}
                </span>
                <div className="flex-1" />
                <span className="font-mono text-[11px] font-semibold text-success">+{changes?.adds ?? 0}</span>
                <span className="font-mono text-[11px] font-semibold text-error">−{changes?.dels ?? 0}</span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-[8px] pb-[20px]">
                {changes == null ? (
                    <FileListSkeleton />
                ) : count === 0 ? (
                    <div className="px-[8px] py-[6px] text-[12px] text-ink-mid">No files changed</div>
                ) : (
                    changes.files.map((f) => (
                        <button
                            key={f.path}
                            onClick={() => onSelectFile(f.path)}
                            className={cn(
                                "flex w-full items-center gap-[8px] rounded-[7px] px-[8px] py-[7px] text-left transition-colors duration-[140ms] hover:bg-surface-raised",
                                f.path === selectedFile && "bg-surface-selected"
                            )}
                        >
                            <span className={cn("w-[13px] flex-none text-center font-mono text-[10px] font-bold", statusColor(f.status))}>
                                {f.status}
                            </span>
                            <span
                                className={cn(
                                    "min-w-0 flex-1 truncate font-mono text-[11.5px]",
                                    f.path === selectedFile ? "text-ink-hi" : "text-ink-mid"
                                )}
                            >
                                {f.path}
                            </span>
                            <span className="flex-none font-mono text-[10px] font-semibold text-success">+{f.adds}</span>
                            <span className="flex-none font-mono text-[10px] font-semibold text-error">−{f.dels}</span>
                        </button>
                    ))
                )}
            </div>
        </div>
    );
}
```

- [ ] **Step 2: Confirm no raw colour and typecheck**

Run: `grep -n "#[0-9a-fA-F]\{3,8\}\|rgba(" frontend/app/view/agents/commitpane.tsx`
Expected: no output.

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

### Task 8: Restructure the surface

The last task assembles the three panes and replaces the header. The source dropdown becomes a repository chip plus three scope pills — Repository, Agent, Run — which is a *presentation* of the scoping the surface already does (`projectSel` / `focusId` / `filesRunAtom`), not a new model. The ref expression states what the history is being read against.

`SourcePicker` is reused verbatim as the repository chip's dropdown; do not rewrite it.

**Files:**
- Modify: `frontend/app/view/agents/filessurface.tsx`

**Interfaces:**
- Consumes: `HistoryPane` (Task 6), `CommitPane` (Task 7), and from `./githistorystore` (Task 5) `historyRowsAtom`, `historyErrorAtom`, `selectedCommitAtom`, `selectedFileAtom`, `graphOnAtom`, `activeChangesAtom`, `activeDiffAtom`, `loadHistory`, `selectCommit`, `selectCommitFile`, `resetHistory`; `WORKING_TREE` from `./historyrows`.
- Produces: nothing new. `FilesSurface({ model })` keeps its signature and its `SurfaceKey` (`files`).

- [ ] **Step 1: Add the imports**

In `frontend/app/view/agents/filessurface.tsx`, add:

```ts
import { CommitPane } from "./commitpane";
import {
    activeChangesAtom,
    activeDiffAtom,
    graphOnAtom,
    historyErrorAtom,
    historyRowsAtom,
    loadHistory,
    resetHistory,
    selectCommit,
    selectCommitFile,
    selectedCommitAtom,
    selectedFileAtom,
} from "./githistorystore";
import { HistoryPane } from "./historypane";
import { WORKING_TREE } from "./historyrows";
```

- [ ] **Step 2: Read the new atoms and derive the scope**

Inside `FilesSurface`, after the existing `const diff = useAtomValue(filesDiffAtom);`, add:

```ts
    const historyRows = useAtomValue(historyRowsAtom);
    const historyError = useAtomValue(historyErrorAtom);
    const selectedCommit = useAtomValue(selectedCommitAtom);
    const selectedFile = useAtomValue(selectedFileAtom);
    const graphOn = useAtomValue(graphOnAtom);
    const activeChanges = useAtomValue(activeChangesAtom);
    const activeDiff = useAtomValue(activeDiffAtom);
```

After the existing `source` derivation, add the scope label and ref expression:

```ts
    // The three scopes the surface already had, now named. Run wins, then a picked project, then the
    // focused agent — the same precedence the load effect below uses.
    const scope: "run" | "repo" | "agent" = runSource ? "run" : projectSel ? "repo" : "agent";
    const refExpr = runSource
        ? `${(runSource.baseCommit || "HEAD").slice(0, 7)} … HEAD`
        : scope === "agent" && state?.ref
          ? `session start ${state.ref.slice(0, 7)} … worktree`
          : `${state?.branch || "—"} · all refs`;
```

- [ ] **Step 3: Load history alongside the change list**

Add an effect immediately after the existing change-loading effect. It depends on `state?.cwd` rather than the source, so history loads once the change list has resolved the working directory — the uncommitted row's file count comes from that same change list.

```ts
    // History follows whatever cwd the change-list load resolved, and anchors on the scope's base so
    // the session-start / run-base commit gets a labelled divider.
    useEffect(() => {
        if (!state?.cwd || !state.isRepo) {
            resetHistory();
            return;
        }
        const anchor = runSource ? runSource.baseCommit : state.ref;
        fireAndForget(() =>
            loadHistory(state.cwd, {
                anchor: anchor || undefined,
                anchorLabel: runSource ? "run base" : anchor ? "session start" : undefined,
            })
        );
    }, [state?.cwd, state?.isRepo, state?.ref, runSource?.runId]);
```

- [ ] **Step 4: Point list-nav at the history**

Replace the `browseNav` memo (as left by Task 2) so `j`/`k` move through commits rather than files — the history is now the surface's primary list:

```ts
    // publish the commit list for global j/k list-nav. cursor==selection: moving selects the commit,
    // which loads its files and first diff. Must run before the early return (hooks rules).
    const commitIds = (historyRows ?? []).map((r) => r.hash);
    const historyNav = useMemo<ListNavController | null>(
        () =>
            state?.cwd && commitIds.length > 0
                ? {
                      surface: "files",
                      navigableIds: commitIds,
                      cursorId: selectedCommit ?? undefined,
                      setCursor: (hash) => fireAndForget(() => selectCommit(state.cwd!, hash)),
                      activate:
                          selectedFile && state.cwd
                              ? () => getApi().openExternal(joinPath(state.cwd!, selectedFile))
                              : undefined,
                  }
                : null,
        [state?.cwd, commitIds.join(" "), selectedCommit, selectedFile]
    );
    useSurfaceListNav(historyNav);
```

Delete the old `filePaths`-based `browseNav` and its `useSurfaceListNav(browseNav)` call.

The no-cascade entrance guard (`entranceRef` / `computeEntrances` / `filePaths` / `guardKey`) animated the old sidebar file list, which no longer exists. Delete the guard, its `useEffect`, the `filePaths` local, the `sourceKey` import, and the `AnimatePresence` / `cardVariants` / `computeEntrances` / `initialEntranceState` / `EntranceState` imports. **Keep `motion` and `MOTION`** — `CenterPane` still uses both.

That leaves `frontend/app/view/agents/filesmotion.ts` (whose only export, `sourceKey`, existed solely for that guard) with no caller. Delete it **and its test**:

```bash
git rm frontend/app/view/agents/filesmotion.ts frontend/app/view/agents/filesmotion.test.ts
```

`FilesSource` stays exported from `filessurface.tsx` — `SourcePicker` still takes it.

- [ ] **Step 5: Replace the render**

Replace everything from the `return (` of `FilesSurface` (as left by Task 2) through the end of the function with:

```tsx
    const selectedRow = (historyRows ?? []).find((r) => r.hash === selectedCommit) ?? null;

    return (
        <MotionConfig reducedMotion="user">
            <div className="absolute inset-0 flex min-h-0 flex-col">
                {/* subject bar: what am I looking at, and against what */}
                <div className="flex-none px-[18px] pt-[14px]">
                    <div className="flex items-center gap-[14px] pb-[11px]">
                        <h1 className="flex-none text-[16px] font-bold">Diff</h1>
                        <div className="flex items-center overflow-hidden rounded-[9px] border border-edge-mid bg-surface">
                            <div className="w-[210px] border-r border-edge-mid">
                                {runSource ? (
                                    <div className="flex items-center gap-[8px] px-[11px] py-[6px]">
                                        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink-mid">
                                            run {runShortId(runSource.runId)}
                                        </span>
                                        <button
                                            onClick={() => globalStore.set(model.filesRunAtom, null)}
                                            className="flex-none rounded border border-border px-[8px] py-[2px] text-[11px] text-ink-mid hover:text-foreground"
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
                            </div>
                            {(
                                [
                                    ["repo", "Repository", projectSel?.name ?? ""],
                                    ["agent", "Agent", agent?.name ?? ""],
                                    ["run", "Run", runSource ? runShortId(runSource.runId) : ""],
                                ] as const
                            ).map(([key, label, sub]) => (
                                <div
                                    key={key}
                                    className={cn(
                                        "flex items-center gap-[6px] border-r border-edge-faint px-[11px] py-[6px] text-[11.5px] font-semibold",
                                        scope === key ? "bg-surface-selected text-ink-hi" : "text-muted"
                                    )}
                                >
                                    {label}
                                    <span
                                        className={cn(
                                            "max-w-[90px] truncate font-mono text-[10.5px]",
                                            scope === key ? "text-accent-soft" : "text-edge-strong"
                                        )}
                                    >
                                        {sub}
                                    </span>
                                </div>
                            ))}
                        </div>
                        <div className="flex items-center gap-[8px] rounded-[9px] border border-edge-mid bg-surface px-[11px] py-[6px]">
                            <span className="font-mono text-[8.5px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
                                Reading
                            </span>
                            <span className="font-mono text-[12px] text-ink-mid">{refExpr}</span>
                        </div>
                        <div className="flex-1" />
                        <button
                            onClick={() => globalStore.set(graphOnAtom, !graphOn)}
                            className={cn(
                                "flex items-center gap-[7px] rounded-[7px] border px-[10px] py-[5px] text-[11.5px] font-semibold",
                                graphOn ? "border-accent/30 bg-accentbg text-ink-hi" : "border-edge-mid bg-surface text-muted"
                            )}
                        >
                            Graph
                        </button>
                    </div>
                </div>

                {loadError || historyError ? <SurfaceError message="Couldn’t read this repository." /> : null}

                <div className="flex min-h-0 flex-1 border-t border-edge-faint">
                    <div className="flex w-[460px] flex-none flex-col border-r border-edge-faint">
                        {state?.isRepo === false && state?.cwd ? (
                            <div className="px-[14px] py-[10px] text-[12px] text-ink-mid">Not a git repository</div>
                        ) : (
                            <HistoryPane
                                rows={historyRows ?? []}
                                selected={selectedCommit}
                                graphOn={graphOn}
                                loading={historyRows == null}
                                onSelect={(hash) => state?.cwd && fireAndForget(() => selectCommit(state.cwd!, hash))}
                            />
                        )}
                    </div>
                    <div className="flex w-[300px] flex-none flex-col border-r border-edge-faint bg-surface">
                        <CommitPane
                            row={selectedRow}
                            changes={activeChanges}
                            selectedFile={selectedFile}
                            onSelectFile={(path) =>
                                state?.cwd &&
                                selectedCommit != null &&
                                fireAndForget(() => selectCommitFile(state.cwd!, selectedCommit, path))
                            }
                        />
                    </div>
                    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                        <CenterPane
                            path={selectedFile}
                            view={activeDiff}
                            cwd={selectedCommit === WORKING_TREE ? (state?.cwd ?? null) : null}
                        />
                    </div>
                </div>
            </div>
        </MotionConfig>
    );
}
```

Note the `cwd` passed to `CenterPane`: null for a historical commit, which suppresses the "Open in editor" button. Opening the *current* file on disk while reading a *past* commit's diff would show something that does not match what is on screen.

- [ ] **Step 6: Remove what the restructure orphaned**

The old left column is gone, so `FileRow`, `FileListSkeleton`, the `ContextMenuModel` file context menu and the `Copy` / `Pencil` lucide imports have no caller in this file. Delete each one whose usage `grep` shows is now zero:

Run: `grep -n "FileRow\|FileListSkeleton\|ContextMenuModel\|Pencil\|Copy\|StackedMeter\|sourceKey\|cardVariants\|AnimatePresence" frontend/app/view/agents/filessurface.tsx`

Delete every symbol this reports as declared-but-unused, along with its import. `EmptyCenter`, `DiffRow`, `CenterPane`, `SourcePicker`, `baseName` and `joinPath` all stay — `CenterPane` is pane 3 and `SourcePicker` is the repository chip. If `baseName` and `dirLabel` are now unused, delete them too.

- [ ] **Step 7: Typecheck and run the full frontend suite**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

Run: `npx vitest run`
Expected: PASS. Against plan 1's merged baseline the suite was 1449 passed / 2 skipped / 0 failed; this plan removes `reviewstore.test.ts` and adds `historyrows.test.ts` plus one geometry case, so expect a different total but still zero failures.

- [ ] **Step 8: Lint the files you touched**

Run: `npx eslint frontend/app/view/agents/historyrows.ts frontend/app/view/agents/githistorystore.ts frontend/app/view/agents/graphgutter.tsx frontend/app/view/agents/historypane.tsx frontend/app/view/agents/commitpane.tsx frontend/app/view/agents/filessurface.tsx`
Expected: no errors.

Run: `npx prettier --check frontend/app/view/agents/historyrows.ts frontend/app/view/agents/historyrows.test.ts frontend/app/view/agents/githistorystore.ts frontend/app/view/agents/graphgutter.tsx frontend/app/view/agents/historypane.tsx frontend/app/view/agents/commitpane.tsx`

Expected: pass. These six files are wholly yours, so `npx prettier --write` on **them specifically** is safe if it complains. Do **not** run `--write` on `filessurface.tsx` — it is a pre-existing file and `--write` reorders its imports and rewraps the whole thing, turning your edit into a several-hundred-line diff. Hand-format your own lines there.

- [ ] **Step 9: Verify the rendered surface over the Chrome DevTools Protocol**

There are no render tests, so this is how "does it draw" is answered. With the dev app running (`task dev`):

Run: `node scripts/cdp-shot.mjs cdp-shots/git-review.png`

Then open the PNG and confirm, against `wave-handoff/wave/project/Wave-git-review.dc.html`: three panes at 460 / 300 / remainder; the uncommitted row at the top of history with a dashed hollow node; coloured lane lines connecting commits; ref chips on decorated commits; the commit pane populated for the selected row; the diff pane showing the selected file. If the page is blank, do a full `location.reload()` first — HMR blanks the cockpit when modules move.

Report what you see. If the dev app is not running, say so and skip this step rather than reporting it as passed.

- [ ] **Step 10: Report for review — do not commit**

Summarise: the five Go tests from Task 1, the thirteen `historyrows` cases, the `foldX` case, the full frontend suite result, `go build ./...`, the typecheck, and what the screenshot showed. Then stop and hand back for the single end-of-work commit, which needs explicit approval.

---

## Not in this plan

Deliberately deferred so this plan produces working software on its own. Each is a state in the mockup, so the surface will visibly lack them.

**Plan 3 — branch comparison**, on plan 1's `GetDivergence` / `GitDivergenceCommand`. Two labelled commit lists coloured by side, the merge base stated, the aggregate two-ref file diff, `c` to enter and `esc` to leave, and the ref expression becoming an interactive two-ref control instead of the static chip Task 8 renders. Also **commit provenance** — the "Produced by Run #148" line in the mockup's commit pane. Runs capture a base commit so the join is possible, but nothing computes it today; it is new backend work and it pairs naturally with plan 3's divergence wiring.

**Plan 4 — the remaining states:**

- The filter row (author, path, free text) above the history. `HistoryLog` already accepts `Author`, `Grep` and `Path`; nothing calls them yet.
- Pagination. `HistoryLog` accepts `Skip` and `Limit` and defaults to 200 commits; this plan reads one page and never appends. Task 6 renders a skeleton while loading, which is *not* the same as the mockup's incremental-load treatment.
- "Not a repository" versus "the Git read failed" as distinct full-pane states. Task 8 keeps today's behaviour — a one-line "Not a git repository" in the history column and the existing `SurfaceError` banner. The mockup gives each a full panel, the failed one carrying the failing command, its exit code, the stderr verbatim, and a retry.
- History scroll-offset persistence and the "Restored" banner. Commit selection, open file, filters and scope already persist, because Task 5 holds them in module-level atoms that survive the surface's unmount — only the scroll offset and the announcement are missing.
- Narrow-window folding: commit pane folds to a chip in the diff header below roughly 1100px, then the author column drops, then the graph folds to three lanes, then history becomes a drawer below 900px.
- The declared keyboard map and its hint-footer entries, plus `G` to toggle the graph as a key rather than only the button Task 8 renders.
- A Chrome-DevTools-Protocol `verify:ui` scenario in `scripts/cdp/scenarios.mjs`, so the composition is checked by `task verify:ui` rather than by an ad-hoc screenshot.
- The `Fetch` button and its freshness clock. `fetch` is the only mutation the brief permits, and it needs a new RPC.
- The `Unified` / `Split` diff toggle. Split view is a new renderer.
- Density (comfortable 34px / compact 28px rows). The mockup exposes it as a design prop; `historypane.tsx` hardcodes 34px.

## Resolved decisions

**No parallel diff-colour token family (decided while writing this plan).** The mockup defines `--color-diff-add: #54c79a` and `--color-diff-del: #e0726c`, which are byte-identical to the existing `--color-success` and `--color-error`. Adding a second family for the same two values would create two sources of truth for one colour and silently split runtime theming — a theme overriding `--color-success` would no longer move the diff pane. The existing diff renderer already uses `text-success` / `text-error` with `color-mix(in srgb, var(--color-success) 12%, transparent)` for the row tint, which is within a rounding error of the mockup's `rgba(84,199,154,.10)`. Keep it. The brief's instruction — "keep the existing diff pane's visual idiom unless you are deliberately proposing a change to it" — points the same way.

The mockup's `--color-diff-add-ink: #bfe9d3` and `--color-diff-del-ink: #e9b9b6` are genuinely new: desaturated tints for the *text* of added and deleted lines, where the current renderer uses full-strength `text-success` / `text-error`. That is a real legibility improvement and a real change to the diff pane, so it belongs in a deliberate follow-up rather than smuggled in here. Noted, not built.

**Lane tokens are literal hexes, not aliases (decided while writing this plan).** Four of the six lane hues equal existing tokens (`graphlane-1` = `accent`, `-2` = `success`, `-3` = `warning`, `-5` = `error`) and two are new (`#c9a4ff`, `#5cc8d8`). Defining the family as `var(--color-accent)` and friends would make a theme's accent override shift lane 1, which sounds desirable until you notice it would collapse two lanes onto one hue in any theme where accent happens to land near success. The neighbouring `--color-avatar-1..6` palette has exactly the same overlap and is defined as literals; match it.

**`assignLanes` becomes generic rather than callers casting.** Task 4's rows carry display fields that `assignLanes` preserves at runtime but erased at the type level. The alternatives were a cast at the call site (lies to the compiler) or a parallel lookup from hash back to row (a second source of truth for row identity, and the working-tree row's hash is empty). One generic parameter is smaller than either.

**The uncommitted row's sentinel hash is the empty string.** `gitgraphgeom.ts` already skips falsy hashes when building its row index, so nothing can draw an edge *into* the working tree — which is correct, since it has no children — while its own edge down to HEAD still draws, because that reads its parents. This was accidental in plan 1 and is load-bearing now, so it is documented at the `WORKING_TREE` declaration.

The obvious worry is that an empty-string id gets swallowed somewhere as falsy. It was checked, not assumed: `moveCursor` (`agentsviewmodel.ts:573`) guards with `current != null` and looks the id up with `indexOf`, both of which treat `""` as an ordinary value, and `buildListNavBindings` (`bindings.ts:205-207`) forwards the result under `next != null`. So the working-tree row is reachable by `j`/`k` like any commit. Two places still need the explicit falsy guard, and both have it: the React key in `historypane.tsx` (`key={row.hash || "__wt__"}`) and the `hash === WORKING_TREE` branches in `githistorystore.ts`.
