# History reads for the Diff surface — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a long commit history usable in the Diff surface — filter it, page through it, tell "not a repository" apart from "the read failed" with real evidence, and come back to where you were.

**Architecture:** Filtering and pagination are frontend-only: `HistoryLog` and the history RPC payload already carry `Author`, `Grep`, `Path`, `Skip` and `Limit`, and nothing has ever passed them. The one backend change is a structured `GitFailure` (command, exit code, stderr) on the history response, so a failed read stops masquerading as an unreadable repository. All new derivation is pure and unit-tested (`historyquery.ts`); the store stays glue; the graph modules are untouched and simply suppressed while filtering.

**Tech Stack:** Go 1.23 (`pkg/gitinfo`, `pkg/wshrpc`), React 19 + TypeScript, jotai, Tailwind 4, vitest, Node CDP harness (`scripts/cdp/`).

**Spec:** `docs/superpowers/specs/2026-08-03-git-review-history-reads-design.md`. Read it first — its nine numbered decisions are the *why* behind choices this plan states without re-arguing.

**Design source:** `wave-handoff/wave/project/Wave-git-review.dc.html` — the `filtered` state (filter-row markup lines 166–190), `notrepo` (line 897), `failed` (lines 902, 970), `loading` (976), `restored` (880, 980).

**Predecessors:** `docs/superpowers/plans/2026-07-31-git-review-read-path.md` (`010fa7e9`), `-git-review-surface.md` (`a7c7c6cd`, fix `f8044bd4`), `-git-branch-comparison.md` (`cea7ec8a`). All three are shipped; this plan consumes their output and rebuilds none of it.

## Global Constraints

- **Do not commit during execution.** All work lands as **one commit at the end, with explicit user approval** (project rule). This plan document and its spec fold into that same commit — never a separate docs-only commit. Tasks end with verification, not `git commit`.
- **Never hand-edit generated files.** `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts` and `pkg/wshrpc/wshclient/wshclient.go` come from `task generate`. Edit the Go definitions and regenerate.
- **Dark mode only.** No light or Paper variant; it is permanently out of scope for this codebase.
- **Colours come from `@theme` tokens in `frontend/tailwindsetup.css`.** Never a raw hex or `rgba()` in a component — runtime theming overrides those same `--color-*` properties, so a hardcoded colour silently opts out of every theme.
- **Prefer Tailwind over new SCSS.** No new `.scss` files.
- **Read-only.** Nothing here stages, composes a commit, reverts, fetches or mutates the working tree.
- **No new nav-rail entry.** This grows inside the existing Diff surface (`SurfaceKey` `files`).
- **Monospace for hashes, paths, branch names and refs** — `font-mono`.
- **No jsdom render or snapshot tests.** Extract logic to a pure module and unit-test that.
- **Typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`.** Bare `npx tsc` stack-overflows on this repo, which also means `task check:ts` is broken. Baseline is clean (exit 0), so any error it reports is yours.
- **`go test ./pkg/gitinfo/` needs no CGO flag;** a whole-tree `go test ./pkg/...` does — from PowerShell at the repo root: `$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"`. The `-I` path must be Windows-style; a Git-Bash POSIX path silently fails with an identical-looking error.
- **Do not run `prettier --write` on files you did not author in full.** On a drifted file it reorders imports and rewraps everything, turning a four-line edit into a six-hundred-line diff. Hand-format your own lines. Never `--write` on `scripts/*.mjs` — `.editorconfig` omits `.mjs`, so Prettier reindents it to two spaces.
- **Row height stays 34px and there are no responsive breakpoints** (spec decision 2). Do not add a density control or width-conditional layout.

---

## Two defects found while planning — both fixed here

**1. Commit selection does not actually survive a surface switch.** The branch-comparison plan's deferred list claims selection and open file "already persist, because they are module-level atoms". The atoms do survive, but `loadHistory` ends with an unconditional re-select (`githistorystore.ts:87-90`: `const pick = defaultSelection(rows); ... void selectCommit(cwd, pick)`), and the surface's load effect re-runs on every mount — so returning to the Diff surface throws the selection back to row zero and reopens its first file. Task 4 fixes it with the selection helper from Task 3. Without this fix, "returning to the surface returns you to where you were" is false no matter how well the scroll offset is stored.

**2. A repository with no commits would show a scary evidence panel.** `git log` in a freshly initialised repository exits 128 ("does not have any commits yet"). Reporting that as a failed read would greet every brand-new project with the failure panel. Task 1 discriminates it via `rev-parse --verify --quiet HEAD` — git exits **1** for "no such ref" and **128** for a fatal error — so an unborn branch reads as empty history.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `frontend/app/view/agents/historyquery.ts` | Pure. Everything between "the user typed" and "the store issues a read": filter shape, active count, summary and count labels, the mapping onto the RPC's `author`/`grep`/`path`, page size, the has-more rule, and the restore-banner gate with the sentence it produces. |
| `frontend/app/view/agents/historyquery.test.ts` | Unit tests for the above. |
| `frontend/app/view/agents/historyfilterrow.tsx` | The filter row: search field, author and path chips, active count with "Clear all · esc", and the Graph toggle relocated from the subject bar. |
| `frontend/app/view/agents/gitstatepanels.tsx` | The two full-pane repository states: not-a-repository (calm, no retry) and read-failed (command, exit code, stderr, Retry). |

**Modified:**

| File | Change |
|---|---|
| `pkg/gitinfo/gitinfo.go` | Add `GitFailure`, `exitCodeOf`, `failureOf`; add `Failure` to `History`; change `HistoryLog`'s log-error branch. |
| `pkg/gitinfo/gitinfo_test.go` | Three new table tests. |
| `pkg/wshrpc/wshrpctypes_git.go` | Add `Failure *gitinfo.GitFailure` to `CommandGitHistoryRtnData`. |
| `pkg/wshrpc/wshserver/wshserver_git.go` | Pass `Failure` through the existing handler. |
| `frontend/app/view/agents/historyrows.ts` | Add `keepSelection`. |
| `frontend/app/view/agents/historyrows.test.ts` | Four cases for `keepSelection`. |
| `frontend/app/view/agents/githistorystore.ts` | Filters, pagination, failure, scroll/left-at/restore atoms; rows become derived; selection no longer resets on remount. |
| `frontend/app/view/agents/historypane.tsx` | Scroll persistence, append-on-scroll with its footer, filter-aware count label, stable `data-*` hooks. |
| `frontend/app/view/agents/filessurface.tsx` | Render the filter row and the two panels, the Restored banner, the unmount stamp; move the Graph button out of the subject bar; source-picker `data-*` hooks. |
| `frontend/app/store/keybindings/bindings.ts` | `/`, `Shift:g`, `g g`, and Escape ordering for clear-filters. |
| `frontend/app/store/keybindings/bindings.test.ts` | Cases for the three new Diff-surface bindings. |
| `frontend/app/store/keybindings/store.test.ts` | Escape no-conflict case with filters active. |
| `frontend/app/cockpit/footerhints.ts` | Hint chips for the three new bindings. |
| `scripts/cdp/scenarios.mjs` | The `git-history` scenario. |
| `docs/deferred.md` | Record narrow-window folding and row density as declined. |

**Generated (regenerated in Task 1, never hand-edited):** `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`, `pkg/wshrpc/wshclient/wshclient.go`.

---

### Task 1: Structured git failure, and an unborn branch is not a failure

**Files:**
- Modify: `pkg/gitinfo/gitinfo.go` — the import block (line 10), `History` (line 508), `HistoryLog`'s error branch (lines 555–558), and append the new helpers at the end of the file
- Modify: `pkg/gitinfo/gitinfo_test.go` (append)
- Modify: `pkg/wshrpc/wshrpctypes_git.go:35-39`
- Modify: `pkg/wshrpc/wshserver/wshserver_git.go:14-27`

**Interfaces:**
- Consumes: the package-local `run(ctx, cwd, args...)`, `gitTimeout`, `History`, `HistoryOpts` — all already in `pkg/gitinfo`. Test fixtures `gitAuthored` (`gitinfo_test.go:735`), `commitAuthored` (`:747`) and `repoBranchMerge` (`:758`) are reused as-is.
- Produces: `gitinfo.GitFailure{Command, ExitCode, Stderr}`; `History.Failure *GitFailure`; and on the frontend, `h.failure` on the value `RpcApi.GitHistoryCommand` resolves to, typed as the global `GitFailure`. Task 4's store reads it; Task 5's panel renders it.

- [x] **Step 1: Write the failing tests**

Append to `pkg/gitinfo/gitinfo_test.go`:

```go
func TestHistoryLogReportsFailureDetail(t *testing.T) {
	dir := repoBranchMerge(t)
	h, err := HistoryLog(context.Background(), dir, HistoryOpts{Ref: "no-such-ref-anywhere"})
	if err != nil {
		t.Fatalf("HistoryLog should describe a git failure, not return an error: %v", err)
	}
	if !h.IsRepo {
		t.Fatal("IsRepo = false, want true — the directory IS a repo; the read is what failed")
	}
	if h.Failure == nil {
		t.Fatal("Failure = nil, want the failing command described")
	}
	if h.Failure.ExitCode != 128 {
		t.Errorf("ExitCode = %d, want 128 (git's fatal-error code)", h.Failure.ExitCode)
	}
	if !strings.Contains(h.Failure.Command, "log") {
		t.Errorf("Command = %q, want it to name the log invocation", h.Failure.Command)
	}
	if !strings.Contains(h.Failure.Stderr, "no-such-ref-anywhere") {
		t.Errorf("Stderr = %q, want git's own message naming the bad revision", h.Failure.Stderr)
	}
}

// A freshly initialised repo has no commits, and git log exits 128 there. That is an empty history,
// not a failed read: reporting it as a failure would greet every new project with an error panel.
func TestHistoryLogEmptyRepoIsNotAFailure(t *testing.T) {
	dir := t.TempDir()
	gitAuthored(t, dir, "init", "--initial-branch=main")
	h, err := HistoryLog(context.Background(), dir, HistoryOpts{})
	if err != nil {
		t.Fatalf("HistoryLog: %v", err)
	}
	if !h.IsRepo {
		t.Error("IsRepo = false, want true for an initialised repo with no commits")
	}
	if h.Failure != nil {
		t.Errorf("Failure = %+v, want nil for an unborn branch", h.Failure)
	}
	if len(h.Commits) != 0 {
		t.Errorf("got %d commits, want 0", len(h.Commits))
	}
}

func TestHistoryLogHealthyReadHasNoFailure(t *testing.T) {
	dir := repoBranchMerge(t)
	h, err := HistoryLog(context.Background(), dir, HistoryOpts{})
	if err != nil {
		t.Fatalf("HistoryLog: %v", err)
	}
	if h.Failure != nil {
		t.Errorf("Failure = %+v, want nil — a working repo must not be able to trip the panel", h.Failure)
	}
}
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/gitinfo/ -run "TestHistoryLog(ReportsFailureDetail|EmptyRepoIsNotAFailure|HealthyReadHasNoFailure)" -v`
Expected: FAIL to **build**, with `h.Failure undefined (type *History has no field or method Failure)`.

- [x] **Step 3: Add `errors` to the import block**

In `pkg/gitinfo/gitinfo.go`, the import block currently reads `bytes, context, fmt, os, os/exec, path/filepath, strconv, strings, time`. Add `"errors"` in alphabetical position (after `"context"`).

- [x] **Step 4: Add the failure type and its two helpers**

Append to the end of `pkg/gitinfo/gitinfo.go`:

```go
// GitFailure describes a git invocation that failed, in the shape the Diff surface's failure panel
// renders: the command as run, its exit code, and stderr verbatim. It exists so a failed read can be
// reported as data rather than as an RPC error — "this is not a repository" and "the read failed"
// are different screens, and an error string cannot carry the fields the second one shows.
type GitFailure struct {
	Command  string `json:"command"`
	ExitCode int    `json:"exitcode"`
	Stderr   string `json:"stderr"`
}

// exitCodeOf reports git's own exit status, or -1 when the failure was not an exit status at all
// (git missing from PATH, a context deadline). Callers discriminate on it: git uses 1 for "no such
// ref" and 128 for a fatal error, which is how HistoryLog tells an unborn branch from a real fault.
func exitCodeOf(err error) int {
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode()
	}
	return -1
}

// failureOf turns the error run() already returns into a GitFailure. cmd.Output() populates
// ExitError.Stderr, so both the code and git's message are available without changing how git is
// invoked — and without CombinedOutput, which would fold stderr into the stdout callers parse.
func failureOf(args []string, err error) *GitFailure {
	f := &GitFailure{Command: "git " + strings.Join(args, " "), ExitCode: exitCodeOf(err)}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		f.Stderr = strings.TrimSpace(string(ee.Stderr))
	}
	if f.Stderr == "" && err != nil {
		f.Stderr = err.Error() // no stderr to show (git absent, deadline): the Go error is the evidence
	}
	return f
}
```

- [x] **Step 5: Add the field to `History`**

In `pkg/gitinfo/gitinfo.go`, the `History` struct (line 508) becomes:

```go
// History is a page of commits plus the current HEAD, which the surface needs to anchor a synthetic
// working-tree row to the commit it sits on top of. Failure is set when the directory is a work tree
// but the log read failed: IsRepo:false and Failure:non-nil are deliberately different answers.
type History struct {
	Commits []HistoryCommit `json:"commits"`
	Head    string          `json:"head"`
	IsRepo  bool            `json:"isrepo"`
	Failure *GitFailure     `json:"failure,omitempty"`
}
```

- [x] **Step 6: Change `HistoryLog`'s error branch**

In `pkg/gitinfo/gitinfo.go`, replace:

```go
	out, err := run(ctx, cwd, args...)
	if err != nil {
		return nil, err
	}
```

with:

```go
	out, err := run(ctx, cwd, args...)
	if err != nil {
		// A repo with no commits yet is empty history, not a failed read — git log exits 128 there.
		// rev-parse --verify --quiet exits 1 for "no such ref" and 128 for a fatal error, so the exit
		// code discriminates an unborn branch without matching git's wording, which changes between
		// versions.
		if _, verr := run(ctx, cwd, "rev-parse", "--verify", "--quiet", "HEAD"); verr != nil && exitCodeOf(verr) == 1 {
			return &History{IsRepo: true}, nil
		}
		return &History{IsRepo: true, Failure: failureOf(args, err)}, nil
	}
```

- [x] **Step 7: Run the tests to verify they pass**

Run: `go test ./pkg/gitinfo/ -run "TestHistoryLog" -v`
Expected: PASS — the three new cases plus the five that already existed (`ParentsAndOrder`, `DecoratesRefs`, `Paginates`, `FiltersByAuthorAndPath`, `NotARepo`).

- [x] **Step 8: Expose the field over RPC**

In `pkg/wshrpc/wshrpctypes_git.go`, `CommandGitHistoryRtnData` becomes:

```go
type CommandGitHistoryRtnData struct {
	Commits []gitinfo.HistoryCommit `json:"commits"`
	Head    string                  `json:"head"`
	IsRepo  bool                    `json:"isrepo"`
	// Set when the directory is a work tree but the log read failed. IsRepo:false and a populated
	// Failure are different states and the surface draws a different panel for each.
	Failure *gitinfo.GitFailure `json:"failure,omitempty"`
}
```

In `pkg/wshrpc/wshserver/wshserver_git.go`, the return of `GitHistoryCommand` becomes:

```go
	return &wshrpc.CommandGitHistoryRtnData{Commits: h.Commits, Head: h.Head, IsRepo: h.IsRepo, Failure: h.Failure}, nil
```

- [x] **Step 9: Regenerate the bindings**

Run: `task generate`
Expected: no errors.

Run: `grep -n "GitFailure" frontend/types/gotypes.d.ts`
Expected: a `GitFailure` type declaration with `command`, `exitcode`, `stderr`, plus the optional `failure` field on `CommandGitHistoryRtnData`.

- [x] **Step 10: Verify the Go tree**

Run: `go build ./...`
Expected: exit 0.

Run: `go test ./pkg/gitinfo/ ./pkg/wshrpc/...`
Expected: exit 0.

Run: `gofmt -l pkg/gitinfo/gitinfo.go pkg/gitinfo/gitinfo_test.go pkg/wshrpc/wshrpctypes_git.go pkg/wshrpc/wshserver/wshserver_git.go`
Expected: no output. (`gofmt -l pkg/wshrpc/wshclient/wshclient.go` does list that file — true at HEAD too, it is generator output, not yours.)

---

### Task 2: The pure query module

Everything between "the user typed" and "the store issues a read". Pure, so it is unit-tested rather than exercised through the UI, following `historyrows.ts` and `comparerows.ts`.

**Files:**
- Create: `frontend/app/view/agents/historyquery.ts`
- Create: `frontend/app/view/agents/historyquery.test.ts`

**Interfaces:**
- Consumes: nothing. Deliberately dependency-free so it can be tested without a store or a DOM.
- Produces: `HistoryFilters`, `NO_FILTERS`, `HISTORY_PAGE_SIZE`, `FILTER_DEBOUNCE_MS`, `RESTORE_THRESHOLD_MS`, `RESTORE_DISMISS_MS`, `SCROLL_THROTTLE_MS`, `NEAR_BOTTOM_PX`, `activeFilterCount`, `anyFilterActive`, `toHistoryQuery`, `filterSummary`, `countLabel`, `hasMorePages`, `RestoreState`, `restoreNotice`. Tasks 4, 6, 7 and 8 all consume from here.

- [x] **Step 1: Write the failing test**

Create `frontend/app/view/agents/historyquery.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    HISTORY_PAGE_SIZE,
    NO_FILTERS,
    RESTORE_THRESHOLD_MS,
    activeFilterCount,
    anyFilterActive,
    countLabel,
    filterSummary,
    hasMorePages,
    restoreNotice,
    toHistoryQuery,
} from "./historyquery";

describe("activeFilterCount / anyFilterActive", () => {
    it("counts only non-blank fields", () => {
        expect(activeFilterCount(NO_FILTERS)).toBe(0);
        expect(anyFilterActive(NO_FILTERS)).toBe(false);
        expect(activeFilterCount({ author: "dana", path: "", text: "" })).toBe(1);
        expect(activeFilterCount({ author: "dana", path: "src/**", text: "refund" })).toBe(3);
    });

    it("treats whitespace as blank, so a stray space does not read as a filter", () => {
        expect(activeFilterCount({ author: "   ", path: "", text: "" })).toBe(0);
        expect(anyFilterActive({ author: "   ", path: "", text: "" })).toBe(false);
    });
});

describe("toHistoryQuery", () => {
    it("omits blank fields rather than sending empty strings", () => {
        expect(toHistoryQuery(NO_FILTERS)).toEqual({});
        expect(toHistoryQuery({ author: "dana", path: "", text: "" })).toEqual({ author: "dana" });
    });

    it("maps free text onto grep and trims every field", () => {
        expect(toHistoryQuery({ author: " dana ", path: " src/** ", text: " refund " })).toEqual({
            author: "dana",
            path: "src/**",
            grep: "refund",
        });
    });
});

describe("filterSummary", () => {
    it("counts filters and matches, singular and plural", () => {
        expect(filterSummary({ author: "dana", path: "src/**", text: "" }, 4)).toBe("2 filters · 4 matching commits");
        expect(filterSummary({ author: "dana", path: "", text: "" }, 1)).toBe("1 filter · 1 matching commit");
    });

    it("is null when nothing is filtered, so the row shows no count chip", () => {
        expect(filterSummary(NO_FILTERS, 12)).toBeNull();
    });
});

describe("countLabel", () => {
    it("reports what is loaded, never a repository total the surface has not counted", () => {
        expect(countLabel(NO_FILTERS, 50, false)).toBe("50 commits loaded");
        expect(countLabel(NO_FILTERS, 1, false)).toBe("1 commit loaded");
        expect(countLabel({ author: "dana", path: "", text: "" }, 4, false)).toBe("4 matching commits");
        expect(countLabel(NO_FILTERS, 0, true)).toBe("");
    });
});

describe("hasMorePages", () => {
    it("assumes more only when the page came back full", () => {
        expect(hasMorePages(HISTORY_PAGE_SIZE)).toBe(true);
        expect(hasMorePages(HISTORY_PAGE_SIZE - 1)).toBe(false);
        expect(hasMorePages(0)).toBe(false);
    });
});

describe("restoreNotice", () => {
    const away = RESTORE_THRESHOLD_MS + 1;

    it("stays silent for a quick flip away and back, however much was restored", () => {
        expect(
            restoreNotice({
                awayMs: RESTORE_THRESHOLD_MS - 1,
                commit: "c41d8ecafe",
                scroll: 420,
                filters: { author: "dana", path: "", text: "" },
                topRowHash: "aaaaaaa",
            })
        ).toBeNull();
    });

    it("stays silent when nothing but the default came back", () => {
        expect(
            restoreNotice({ awayMs: away, commit: "aaaaaaa", scroll: 0, filters: NO_FILTERS, topRowHash: "aaaaaaa" })
        ).toBeNull();
    });

    it("names the short hash, the scroll offset and the filter count", () => {
        expect(
            restoreNotice({
                awayMs: away,
                commit: "c41d8ecafe0011",
                scroll: 420,
                filters: { author: "dana", path: "src/**", text: "" },
                topRowHash: "aaaaaaa",
            })
        ).toBe("Commit c41d8ec, history scroll offset and 2 filters came back with the surface.");
    });

    it("uses the singular for one filter and no list separator for a single item", () => {
        expect(
            restoreNotice({ awayMs: away, commit: null, scroll: 0, filters: { author: "dana", path: "", text: "" }, topRowHash: "aaa" })
        ).toBe("1 filter came back with the surface.");
    });

    // the working-tree row's hash is "" and it is the default selection on a dirty tree, so it must
    // never count as "you were somewhere unusual"
    it("does not count the uncommitted row as a restored selection", () => {
        expect(restoreNotice({ awayMs: away, commit: "", scroll: 0, filters: NO_FILTERS, topRowHash: "" })).toBeNull();
    });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/historyquery.test.ts`
Expected: FAIL with `Failed to resolve import "./historyquery"`.

- [x] **Step 3: Write the module**

Create `frontend/app/view/agents/historyquery.ts`:

```ts
// frontend/app/view/agents/historyquery.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: what the history pane asks for, and how the answer is labelled. Filter shape, the mapping
// onto the RPC's own parameters, the count labels, the page-size rule, and the gate on the
// "Restored" banner. Dependency-free on purpose — the store is glue around this, not the other way
// round. Rows are historyrows.ts; lanes are gitgraph.ts.

export interface HistoryFilters {
    // matched against the commit author (git log --author)
    author: string;
    // a pathspec (git log -- <path>)
    path: string;
    // free text matched against commit subjects (git log --grep)
    text: string;
}

export const NO_FILTERS: HistoryFilters = { author: "", path: "", text: "" };

// One page of history. 50 is the mockup's own page ("loading commits 51–100"); gitinfo's own
// default of 200 is a different bound — an unpaginated read's ceiling, not a page.
export const HISTORY_PAGE_SIZE = 50;
// A settled keystroke, not every keystroke: each filter change is a git invocation.
export const FILTER_DEBOUNCE_MS = 250;
// Long enough to have lost your place. Below it, returning restores silently.
export const RESTORE_THRESHOLD_MS = 120_000;
export const RESTORE_DISMISS_MS = 6_000;
export const SCROLL_THROTTLE_MS = 150;
// How close to the bottom counts as "asking for the next page".
export const NEAR_BOTTOM_PX = 200;

const filled = (s: string): string => s.trim();

export function activeFilterCount(f: HistoryFilters): number {
    return [f.author, f.path, f.text].filter((v) => filled(v) !== "").length;
}

export function anyFilterActive(f: HistoryFilters): boolean {
    return activeFilterCount(f) > 0;
}

// The RPC's own parameter names. Blank fields are omitted rather than sent as "": HistoryLog treats
// "" as "no filter", but sending it anyway would make every payload look filtered to a reader.
export function toHistoryQuery(f: HistoryFilters): { author?: string; grep?: string; path?: string } {
    const q: { author?: string; grep?: string; path?: string } = {};
    if (filled(f.author) !== "") {
        q.author = filled(f.author);
    }
    if (filled(f.text) !== "") {
        q.grep = filled(f.text);
    }
    if (filled(f.path) !== "") {
        q.path = filled(f.path);
    }
    return q;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

// The chip beside "Clear all". Null when nothing is filtered, so the row stays quiet.
export function filterSummary(f: HistoryFilters, shown: number): string | null {
    const n = activeFilterCount(f);
    if (n === 0) {
        return null;
    }
    return `${plural(n, "filter", "filters")} · ${plural(shown, "matching commit", "matching commits")}`;
}

// Deliberately relative, never absolute: a paginated read knows what it loaded and nothing about the
// repository's total, and quoting a total would mean a second git call to decorate a label.
export function countLabel(f: HistoryFilters, shown: number, loading: boolean): string {
    if (loading) {
        return "";
    }
    if (anyFilterActive(f)) {
        return plural(shown, "matching commit", "matching commits");
    }
    return `${plural(shown, "commit", "commits")} loaded`;
}

// A full page means there may be another; a short page is the end. Cheaper and more honest than a
// count query, and wrong only in the harmless case where the last page is exactly full.
export function hasMorePages(pageLength: number): boolean {
    return pageLength >= HISTORY_PAGE_SIZE;
}

export interface RestoreState {
    awayMs: number;
    // the selected row's hash; "" is the synthetic uncommitted row, null is nothing selected
    commit: string | null;
    scroll: number;
    filters: HistoryFilters;
    // the hash of row zero, i.e. what would have been selected by default
    topRowHash: string | null;
}

// The banner's sentence, or null for silence. Two gates, both required: something non-default came
// back, AND you were away long enough to have lost the thread. The surface unmounts on every nav
// switch, so an unconditional announcement would fire constantly and teach the user to ignore it.
export function restoreNotice(s: RestoreState): string | null {
    if (s.awayMs < RESTORE_THRESHOLD_MS) {
        return null;
    }
    const parts: string[] = [];
    // "" is the uncommitted row, which is the default selection on a dirty tree — not a restored place
    if (s.commit != null && s.commit !== "" && s.commit !== s.topRowHash) {
        parts.push(`commit ${s.commit.slice(0, 7)}`);
    }
    if (s.scroll > 0) {
        parts.push("history scroll offset");
    }
    const n = activeFilterCount(s.filters);
    if (n > 0) {
        parts.push(plural(n, "filter", "filters"));
    }
    if (parts.length === 0) {
        return null;
    }
    const list =
        parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
    return `${list[0].toUpperCase()}${list.slice(1)} came back with the surface.`;
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/historyquery.test.ts`
Expected: PASS — all 14 cases.

- [x] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

### Task 3: Selection that survives a filter change

One helper beside the shipped `defaultSelection`, because selection rules already live in `historyrows.ts`. Task 4 uses it in two places: a filter change, and the reload that happens on every surface remount.

**Files:**
- Modify: `frontend/app/view/agents/historyrows.ts` (append after `defaultSelection`, line 157)
- Modify: `frontend/app/view/agents/historyrows.test.ts` (append)

**Interfaces:**
- Consumes: `HistoryRow`, `defaultSelection`, `WORKING_TREE` — all already in the file.
- Produces: `keepSelection(rows: HistoryRow[], selected: string | null): string | null`.

- [x] **Step 1: Write the failing test**

Append to `frontend/app/view/agents/historyrows.test.ts`:

```ts
describe("keepSelection", () => {
    it("keeps a selection that is still on screen", () => {
        const rows = buildRows([commit("aaa"), commit("bbb")], { head: "aaa", dirtyFileCount: 0, now: NOW });
        expect(keepSelection(rows, "bbb")).toBe("bbb");
    });

    it("keeps the uncommitted row, whose hash is the empty string", () => {
        const rows = buildRows([commit("aaa")], { head: "aaa", dirtyFileCount: 2, now: NOW });
        expect(keepSelection(rows, WORKING_TREE)).toBe(WORKING_TREE);
    });

    it("falls back to the default when the selection was filtered away", () => {
        const rows = buildRows([commit("aaa"), commit("bbb")], { head: "aaa", dirtyFileCount: 0, now: NOW });
        expect(keepSelection(rows, "zzz")).toBe("aaa");
    });

    it("returns null for an empty result, so nothing is selected", () => {
        expect(keepSelection([], "aaa")).toBeNull();
    });
});
```

The file's existing imports need `keepSelection` added to the `./historyrows` import list; `WORKING_TREE`, `buildRows` and the local `commit` helper are already there from the shipped tests.

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/historyrows.test.ts`
Expected: FAIL — `keepSelection is not a function` (or a TypeScript error that it is not exported).

- [x] **Step 3: Implement it**

Append to `frontend/app/view/agents/historyrows.ts`:

```ts
// Selection across a reload: keep where the user was if that row is still present, else fall back to
// the default. Used both when a filter narrows the list and on the reload that runs when the surface
// remounts — an unconditional default there is what used to throw you back to row zero on every
// return to the surface. `selected` may legitimately be "" (the uncommitted row), so the guard is an
// explicit null check, never a truthiness test.
export function keepSelection(rows: HistoryRow[], selected: string | null): string | null {
    if (selected != null && rows.some((r) => r.hash === selected)) {
        return selected;
    }
    return defaultSelection(rows);
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/historyrows.test.ts`
Expected: PASS — the 13 shipped cases plus the 4 new ones.

---

### Task 4: Rewire the store

The spine of the plan. Rows become derived (pagination must not duplicate the divider and uncommitted-row logic), the boolean error becomes a failure record, and the reload stops resetting the user's place.

**Files:**
- Modify: `frontend/app/view/agents/githistorystore.ts` (full replacement of the file's atom and loader sections; `selectCommit` and `selectCommitFile` are unchanged)

**Interfaces:**
- Consumes: `RpcApi.GitHistoryCommand`; `filesStateAtom`, `filesDiffAtom`, `selectFile` from `./filesstore`; `parseGitChanges`/`GitChanges` from `./gitstatus`; `parseUnifiedDiff`/`FileView` from `./gitdiff`; `buildRows`, `keepSelection`, `WORKING_TREE`, `HistoryRow` from `./historyrows` (Task 3); everything from `./historyquery` (Task 2); the generated global type `GitFailure` (Task 1).
- Produces: atoms `historyCommitsAtom`, `historyHeadAtom`, `historyRowsAtom` (now derived, read-only), `historyFailureAtom`, `historyFiltersAtom`, `historyFilteredAtom`, `historyHasMoreAtom`, `historyAppendAtom`, `historyScrollAtom`, `restoreNoticeAtom`, plus the shipped `selectedCommitAtom`, `selectedFileAtom`, `graphOnAtom`, `activeChangesAtom`, `activeDiffAtom`. Loaders `loadHistory(cwd, opts)`, `loadMoreHistory()`, `setHistoryFilter(patch)`, `clearHistoryFilters()`, `retryHistory()`, `resetHistory()`, `noteSurfaceLeft()`, `dismissRestoreNotice()`, `selectCommit(cwd, hash)`, `selectCommitFile(cwd, hash, path)`. `historyErrorAtom` is **removed**; Task 5 updates its only consumer.

- [x] **Step 1: Replace the imports and the atom block**

In `frontend/app/view/agents/githistorystore.ts`, replace everything from the file's header comment down to and including the `const current = { token: "" };` line (i.e. lines 1–39) with:

```ts
// frontend/app/view/agents/githistorystore.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Commit-history state for the Diff surface. Mirrors filesstore.ts: module-level atoms written by
// async loaders via globalStore, with a guard token so a stale load cannot clobber a newer one.
// Module scope is deliberate — the surface unmounts on nav switch, so anything held in component
// state would be lost; the selected commit, the open file, the filters and the scroll offset all
// survive here. Derivation is pure and lives elsewhere: rows in historyrows.ts, the query and its
// labels in historyquery.ts.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import { filesDiffAtom, filesStateAtom, selectFile } from "./filesstore";
import { parseUnifiedDiff, type FileView } from "./gitdiff";
import { parseGitChanges, type GitChanges } from "./gitstatus";
import {
    FILTER_DEBOUNCE_MS,
    HISTORY_PAGE_SIZE,
    NO_FILTERS,
    anyFilterActive,
    hasMorePages,
    restoreNotice,
    toHistoryQuery,
    type HistoryFilters,
} from "./historyquery";
import { WORKING_TREE, buildRows, keepSelection, type HistoryRow } from "./historyrows";

// Raw commits, accumulated across loaded pages. null = nothing read yet (the pane shows a skeleton).
export const historyCommitsAtom = atom<HistoryCommit[] | null>(null) as PrimitiveAtom<HistoryCommit[] | null>;
export const historyHeadAtom = atom<string>("") as PrimitiveAtom<string>;
// A described git failure, deliberately distinct from "this is not a repository" (isrepo:false).
export const historyFailureAtom = atom<GitFailure | null>(null) as PrimitiveAtom<GitFailure | null>;
export const historyFiltersAtom = atom<HistoryFilters>(NO_FILTERS) as PrimitiveAtom<HistoryFilters>;
export const historyHasMoreAtom = atom<boolean>(false) as PrimitiveAtom<boolean>;
export const historyAppendAtom = atom<"idle" | "loading" | "failed">("idle") as PrimitiveAtom<
    "idle" | "loading" | "failed"
>;
export const historyScrollAtom = atom<number>(0) as PrimitiveAtom<number>;
export const restoreNoticeAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
// null = nothing selected yet; WORKING_TREE ("") = the uncommitted row; otherwise a commit hash
export const selectedCommitAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
export const selectedFileAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
export const graphOnAtom = atom<boolean>(true) as PrimitiveAtom<boolean>;

const commitChangesAtom = atom<GitChanges | null>(null) as PrimitiveAtom<GitChanges | null>;
const commitDiffAtom = atom<FileView | null>(null) as PrimitiveAtom<FileView | null>;
// The scope's anchor/labels, held so the debounced filter reload can reissue the same scoped read.
const historyOptsAtom = atom<LoadHistoryOpts>({}) as PrimitiveAtom<LoadHistoryOpts>;
// When the current page was read. Relative ages are computed against this rather than a live clock,
// so the derived rows below are stable between reads instead of changing on every unrelated render.
const historyNowAtom = atom<number>(0) as PrimitiveAtom<number>;
// Stamped when the surface unmounts; read once by the next load to decide whether to announce a
// restore. null = we are not returning from anywhere.
const historyLeftAtAtom = atom<number | null>(null) as PrimitiveAtom<number | null>;

export const historyFilteredAtom = atom((get) => anyFilterActive(get(historyFiltersAtom)));

// Derived, not stored: appending a page must not duplicate the divider / uncommitted-row logic that
// buildRows already owns, so every page lands in historyCommitsAtom and the rows fall out of it.
export const historyRowsAtom = atom<HistoryRow[] | null>((get) => {
    const commits = get(historyCommitsAtom);
    if (commits == null) {
        return null;
    }
    const opts = get(historyOptsAtom);
    return buildRows(commits, {
        head: get(historyHeadAtom),
        // A filter suppresses the synthetic uncommitted row: it is not a commit, so it cannot satisfy
        // an author, path or text filter, and pinning it atop a filtered list would misreport the
        // result. buildRows already omits the row when the count is 0, so nothing else changes.
        dirtyFileCount: get(historyFilteredAtom) ? 0 : (get(filesStateAtom)?.changes?.files.length ?? 0),
        rowLabel: opts.rowLabel,
        anchor: opts.anchor,
        anchorLabel: opts.anchorLabel,
        now: get(historyNowAtom),
    });
});

// Panes 2 and 3 read one source regardless of what is selected: the working-tree row reuses the
// scope's already-loaded change set from filesstore, a commit uses its own.
export const activeChangesAtom = atom<GitChanges | null>((get) =>
    get(selectedCommitAtom) === WORKING_TREE ? (get(filesStateAtom)?.changes ?? null) : get(commitChangesAtom)
);
export const activeDiffAtom = atom<FileView | null>((get) =>
    get(selectedCommitAtom) === WORKING_TREE ? get(filesDiffAtom) : get(commitDiffAtom)
);

const current = { token: "" };
let filterTimer: ReturnType<typeof setTimeout> | null = null;
```

- [x] **Step 2: Replace `resetHistory` and `loadHistory`**

Replace the existing `resetHistory` and `loadHistory` functions (the block from `export function resetHistory` through the closing brace of `loadHistory`) with:

```ts
export interface LoadHistoryOpts {
    // scope anchor: an agent's session-start commit or a run's base commit
    anchor?: string;
    anchorLabel?: string;
    // What the working-tree row's file count is actually counting — see BuildRowsOpts.rowLabel.
    rowLabel?: string;
}

// A different repository (or run) is a different subject: filters and scroll offset from the old one
// are meaningless here and a stale path filter would silently produce an empty history that looks
// broken. Surviving a *nav switch* is a different thing, and that still works — nothing calls this
// on remount.
export function resetHistory(): void {
    current.token = "";
    if (filterTimer != null) {
        clearTimeout(filterTimer);
        filterTimer = null;
    }
    globalStore.set(historyCommitsAtom, null);
    globalStore.set(historyHeadAtom, "");
    globalStore.set(historyFailureAtom, null);
    globalStore.set(historyFiltersAtom, NO_FILTERS);
    globalStore.set(historyHasMoreAtom, false);
    globalStore.set(historyAppendAtom, "idle");
    globalStore.set(historyScrollAtom, 0);
    globalStore.set(restoreNoticeAtom, null);
    globalStore.set(selectedCommitAtom, null);
    globalStore.set(selectedFileAtom, null);
    globalStore.set(commitChangesAtom, null);
    globalStore.set(commitDiffAtom, null);
}

// The guard token covers scope AND filters: a page that arrives after either changed is stale and
// must be dropped rather than merged into a list it does not belong to.
function loadToken(cwd: string, opts: LoadHistoryOpts, filters: HistoryFilters): string {
    return `${cwd}|${opts.anchor ?? ""}|${filters.author}|${filters.path}|${filters.text}`;
}

function synthFailure(command: string, e: unknown): GitFailure {
    // Not an exit status at all (websocket down, timeout, handler panic). -1 renders as "no exit
    // code" rather than a fabricated number the panel would then display as fact.
    return { command, exitcode: -1, stderr: String((e as Error)?.message ?? e) };
}

export async function loadHistory(cwd: string | null, opts: LoadHistoryOpts = {}): Promise<void> {
    if (!cwd) {
        resetHistory();
        return;
    }
    const filters = globalStore.get(historyFiltersAtom);
    const token = loadToken(cwd, opts, filters);
    current.token = token;
    globalStore.set(historyOptsAtom, opts);
    globalStore.set(historyCommitsAtom, null);
    globalStore.set(historyFailureAtom, null);
    globalStore.set(historyAppendAtom, "idle");
    try {
        const h = await RpcApi.GitHistoryCommand(TabRpcClient, {
            cwd,
            limit: HISTORY_PAGE_SIZE,
            ...toHistoryQuery(filters),
        });
        if (current.token !== token) {
            return;
        }
        if (!h.isrepo) {
            globalStore.set(historyCommitsAtom, []);
            globalStore.set(historyHasMoreAtom, false);
            return;
        }
        if (h.failure) {
            globalStore.set(historyFailureAtom, h.failure);
            globalStore.set(historyCommitsAtom, []);
            globalStore.set(historyHasMoreAtom, false);
            return;
        }
        const page = h.commits ?? [];
        globalStore.set(historyNowAtom, Date.now());
        globalStore.set(historyHeadAtom, h.head);
        globalStore.set(historyCommitsAtom, page);
        globalStore.set(historyHasMoreAtom, hasMorePages(page.length));
        settleSelection(cwd);
        announceRestore();
    } catch (e) {
        if (current.token === token) {
            globalStore.set(historyFailureAtom, synthFailure("githistory", e));
            globalStore.set(historyCommitsAtom, []);
            globalStore.set(historyHasMoreAtom, false);
        }
    }
}

// Keep the user's place. The surface's load effect re-runs on every mount, so the unconditional
// re-select this replaced is what threw the selection back to row zero (and reopened its first file)
// every time you came back to the Diff surface.
function settleSelection(cwd: string): void {
    const rows = globalStore.get(historyRowsAtom) ?? [];
    const prev = globalStore.get(selectedCommitAtom);
    const pick = keepSelection(rows, prev);
    if (pick == null) {
        return;
    }
    // Re-read only when the selection actually moved, or when there is nothing loaded to show for it
    // (first load, or a scope whose panes were cleared).
    if (pick !== prev || globalStore.get(selectedFileAtom) == null) {
        void selectCommit(cwd, pick);
    }
}

function announceRestore(): void {
    const leftAt = globalStore.get(historyLeftAtAtom);
    globalStore.set(historyLeftAtAtom, null);
    if (leftAt == null) {
        return;
    }
    const rows = globalStore.get(historyRowsAtom) ?? [];
    globalStore.set(
        restoreNoticeAtom,
        restoreNotice({
            awayMs: Date.now() - leftAt,
            commit: globalStore.get(selectedCommitAtom),
            scroll: globalStore.get(historyScrollAtom),
            filters: globalStore.get(historyFiltersAtom),
            topRowHash: rows[0]?.hash ?? null,
        })
    );
}

// Called from the surface's unmount cleanup. Stamping the time is all the surface has to do; the
// next load decides whether anything is worth announcing.
export function noteSurfaceLeft(): void {
    globalStore.set(historyLeftAtAtom, Date.now());
}

export function dismissRestoreNotice(): void {
    globalStore.set(restoreNoticeAtom, null);
}

// Appends the next page. Reads cwd from the store rather than taking it as an argument, so the pane
// can call it from a scroll handler without threading scope through the component tree.
export async function loadMoreHistory(): Promise<void> {
    const cwd = globalStore.get(filesStateAtom)?.cwd;
    const commits = globalStore.get(historyCommitsAtom);
    if (
        !cwd ||
        commits == null ||
        !globalStore.get(historyHasMoreAtom) ||
        globalStore.get(historyAppendAtom) === "loading"
    ) {
        return;
    }
    const token = current.token;
    globalStore.set(historyAppendAtom, "loading");
    try {
        const h = await RpcApi.GitHistoryCommand(TabRpcClient, {
            cwd,
            limit: HISTORY_PAGE_SIZE,
            skip: commits.length,
            ...toHistoryQuery(globalStore.get(historyFiltersAtom)),
        });
        if (current.token !== token) {
            return; // scope or filters moved on: this page belongs to a list that no longer exists
        }
        if (h.failure) {
            globalStore.set(historyAppendAtom, "failed");
            return;
        }
        const page = h.commits ?? [];
        // A failed append must never destroy the page being read, which is why this is the one
        // failure that does not take over the surface — it only marks the footer.
        globalStore.set(historyCommitsAtom, [...commits, ...page]);
        globalStore.set(historyHasMoreAtom, hasMorePages(page.length));
        globalStore.set(historyAppendAtom, "idle");
    } catch {
        if (current.token === token) {
            globalStore.set(historyAppendAtom, "failed");
        }
    }
}

function reloadFirstPage(): void {
    const cwd = globalStore.get(filesStateAtom)?.cwd ?? null;
    globalStore.set(historyScrollAtom, 0);
    void loadHistory(cwd, globalStore.get(historyOptsAtom));
}

// Debounced: one git invocation per settled keystroke, not per keystroke.
export function setHistoryFilter(patch: Partial<HistoryFilters>): void {
    globalStore.set(historyFiltersAtom, { ...globalStore.get(historyFiltersAtom), ...patch });
    if (filterTimer != null) {
        clearTimeout(filterTimer);
    }
    filterTimer = setTimeout(() => {
        filterTimer = null;
        reloadFirstPage();
    }, FILTER_DEBOUNCE_MS);
}

export function clearHistoryFilters(): void {
    if (filterTimer != null) {
        clearTimeout(filterTimer);
        filterTimer = null;
    }
    globalStore.set(historyFiltersAtom, NO_FILTERS);
    reloadFirstPage(); // immediate: clearing is a decision, not typing
}

export function retryHistory(): void {
    globalStore.set(historyFailureAtom, null); // show the skeleton, not stale evidence, while retrying
    reloadFirstPage();
}
```

`selectCommit` and `selectCommitFile` below this point are unchanged.

- [x] **Step 3: Typecheck and run the full frontend suite**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: **errors in `filessurface.tsx` only** — it still imports the removed `historyErrorAtom`. That is expected and Task 5 fixes it. Any error in another file is yours.

Run: `npx vitest run frontend/app/view/agents/`
Expected: PASS. No test imports the store (it is glue by convention), so this proves the pure modules still agree with it.

---

### Task 5: The two repository-state panels

**Files:**
- Create: `frontend/app/view/agents/gitstatepanels.tsx`
- Modify: `frontend/app/view/agents/filessurface.tsx` — the store import block (`:59-71`), the atom reads (`:278-279`), the error banner (`:557`), and the three-pane block (`:559-562`)

**Interfaces:**
- Consumes: the generated global `GitFailure`; `historyFailureAtom`, `retryHistory` from the store (Task 4).
- Produces: `NotARepoPanel()` and `GitFailurePanel({ failure, onRetry })`. Both carry `data-*` hooks the Task 9 scenario asserts on: `data-not-a-repo` and `data-git-failure`.

- [x] **Step 1: Write the panels**

Create `frontend/app/view/agents/gitstatepanels.tsx`:

```tsx
// frontend/app/view/agents/gitstatepanels.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The two repository states that take over the whole Diff surface. They are deliberately different
// screens: "not a repository" is a calm fact about the source you picked, while "the read failed" is
// a fault worth acting on, so it carries the failing command, its exit code, stderr verbatim, and a
// retry. Collapsing them into one banner is the failure mode the design brief called out.

export function NotARepoPanel() {
    return (
        <div data-not-a-repo className="flex min-h-0 flex-1 flex-col items-center justify-center gap-[10px] px-[40px]">
            <div className="text-[14px] font-semibold text-ink-hi">This source is not a Git repository</div>
            <div className="max-w-[520px] text-center text-[12.5px] leading-[1.6] text-ink-mid">
                There is no history to read here. Pick a different repository or agent with the scope control
                above.
            </div>
        </div>
    );
}

export function GitFailurePanel({ failure, onRetry }: { failure: GitFailure; onRetry: () => void }) {
    // -1 means the failure was not an exit status at all (git missing, a timeout, a dropped socket).
    // Showing "no exit code" beats printing -1 as though git had returned it.
    const code = failure.exitcode < 0 ? "no exit code" : `exit ${failure.exitcode}`;
    return (
        <div data-git-failure className="flex min-h-0 flex-1 flex-col items-center justify-center gap-[12px] px-[40px]">
            <div className="text-[14px] font-semibold text-error">Couldn’t read this repository</div>
            <div className="max-w-[560px] text-center text-[12.5px] leading-[1.6] text-ink-mid">
                The repository exists — the read failed. Nothing has been changed, so retrying is worth doing.
            </div>
            <div className="w-full max-w-[720px] rounded-[8px] border border-edge-mid bg-surface-code px-[12px] py-[10px]">
                <div className="flex items-center gap-[8px] pb-[6px]">
                    <span className="font-mono text-[8.5px] font-bold uppercase tracking-[0.1em] text-ink-faint">
                        Command
                    </span>
                    <span className="min-w-0 flex-1 select-text truncate font-mono text-[11.5px] text-ink-mid">
                        {failure.command}
                    </span>
                    <span className="flex-none rounded-[5px] border border-error/25 bg-error/12 px-[7px] py-[2px] font-mono text-[9.5px] font-semibold text-error">
                        {code}
                    </span>
                </div>
                {failure.stderr ? (
                    <pre className="max-h-[220px] select-text overflow-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-[1.5] text-ink-mid">
                        {failure.stderr}
                    </pre>
                ) : null}
            </div>
            <button
                data-git-failure-retry
                onClick={onRetry}
                className="rounded-[7px] border border-edge-mid bg-surface-raised px-[12px] py-[6px] text-[11.5px] font-semibold text-ink-mid hover:border-edge-strong hover:text-foreground"
            >
                Retry
            </button>
        </div>
    );
}
```

- [x] **Step 2: Swap the panels into the surface**

In `frontend/app/view/agents/filessurface.tsx`:

Add to the `./githistorystore` import list, and remove `historyErrorAtom` from it: `historyFailureAtom`, `retryHistory`. Add a new import line:

```tsx
import { GitFailurePanel, NotARepoPanel } from "./gitstatepanels";
```

Replace the two atom reads at `:278-279`:

```tsx
    const historyRows = useAtomValue(historyRowsAtom);
    const historyFailure = useAtomValue(historyFailureAtom);
```

Replace the banner line at `:557` — it must no longer speak for a history failure, which now has a whole panel:

```tsx
                {loadError ? <SurfaceError message="Couldn’t read this repository." /> : null}
```

Then wrap the three-pane block. The existing line `:559` opens it:

```tsx
                <div className="flex min-h-0 flex-1 border-t border-edge-faint">
```

Change that opening so the two panels replace the whole block, and delete the old one-line not-a-repo branch inside the left column (`:561-562`, the `state?.isRepo === false && state?.cwd ? (...)` arm, so the column's chain now starts at `compareOn ? (`):

```tsx
                {state?.isRepo === false && state?.cwd ? (
                    <NotARepoPanel />
                ) : historyFailure ? (
                    <GitFailurePanel failure={historyFailure} onRetry={() => retryHistory()} />
                ) : (
                    <div className="flex min-h-0 flex-1 border-t border-edge-faint">
```

Leave every child of that block exactly as it is — the three columns, the compare branches, the panes. Only the wrapper changes: the closing `)}` for the new conditional goes immediately after the existing three-pane `</div>`, and the block's contents are re-indented one level.

- [x] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. The Task 4 breakage is now repaired.

- [x] **Step 4: Lint what you wrote**

Run: `npx eslint frontend/app/view/agents/gitstatepanels.tsx frontend/app/view/agents/historyquery.ts`
Expected: no errors.

Run: `npx prettier --check frontend/app/view/agents/gitstatepanels.tsx frontend/app/view/agents/historyquery.ts frontend/app/view/agents/historyquery.test.ts`
Expected: pass. These files are wholly yours, so `--write` on **them specifically** is safe. Do **not** `--write` `filessurface.tsx`, `historypane.tsx`, `historyrows.ts`, `githistorystore.ts` or `bindings.ts` — pre-existing files, where `--write` reorders imports and rewraps everything.

---

### Task 6: The filter row

**Files:**
- Create: `frontend/app/view/agents/historyfilterrow.tsx`
- Modify: `frontend/app/view/agents/filessurface.tsx` — remove the Graph button from the subject bar (`:544-553`), render the filter row below it
- Modify: `frontend/app/view/agents/historypane.tsx` — the count label (`:154-156`)

**Interfaces:**
- Consumes: `historyFiltersAtom`, `historyFilteredAtom`, `historyRowsAtom`, `graphOnAtom`, `setHistoryFilter`, `clearHistoryFilters` from the store; `filterSummary` from `historyquery.ts`.
- Produces: `HistoryFilterRow()`. Reads and writes the store directly rather than taking props — it is a control panel for state that already lives in atoms, and prop-threading it through the surface would add a layer with no decision in it. Carries `data-history-filter` (the text input, which the `/` key focuses in Task 8) and `data-filter-count`.

- [x] **Step 1: Write the component**

Create `frontend/app/view/agents/historyfilterrow.tsx`:

```tsx
// frontend/app/view/agents/historyfilterrow.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The filter row (Wave-git-review.dc.html, the `filtered` state): free text over commit subjects,
// plus an author and a path chip, the active count with "Clear all", and the Graph toggle — which
// lives here rather than in the subject bar because the mockup puts it at the end of this row.
// Three plain inputs, deliberately not a prefix query language: a parser buys one fewer field and
// costs an error state plus a discoverability problem.

import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useState } from "react";
import {
    clearHistoryFilters,
    graphOnAtom,
    historyFiltersAtom,
    historyRowsAtom,
    setHistoryFilter,
} from "./githistorystore";
import { filterSummary } from "./historyquery";

// A chip is a button until you click it, then a one-line input. Which chip is open is transient, so
// it is the one piece of state here that is allowed to be component-local.
function FilterChip({
    label,
    value,
    placeholder,
    onChange,
}: {
    label: string;
    value: string;
    placeholder: string;
    onChange: (v: string) => void;
}) {
    const [editing, setEditing] = useState(false);
    const on = value.trim() !== "";
    if (editing) {
        return (
            <span className="flex items-center gap-[7px] rounded-[7px] border border-accent/30 bg-accentbg px-[9px] py-[4px]">
                <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.06em] text-ink-faint">
                    {label}
                </span>
                <input
                    autoFocus
                    value={value}
                    placeholder={placeholder}
                    onChange={(e) => onChange(e.target.value)}
                    onBlur={() => setEditing(false)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === "Escape") {
                            setEditing(false);
                        }
                    }}
                    className="w-[150px] bg-transparent font-mono text-[11.5px] text-ink-hi outline-none placeholder:text-ink-faint"
                />
            </span>
        );
    }
    return (
        <span
            className={cn(
                "flex items-center gap-[7px] rounded-[7px] border px-[9px] py-[4px] text-[11.5px] font-semibold",
                on ? "border-accent/30 bg-accentbg text-ink-hi" : "border-edge-mid bg-surface text-muted"
            )}
        >
            <button onClick={() => setEditing(true)} className="flex items-center gap-[7px]">
                <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.06em] text-ink-faint">
                    {label}
                </span>
                <span className="max-w-[170px] truncate font-mono text-[11.5px]">{on ? value : placeholder}</span>
            </button>
            {on ? (
                <button onClick={() => onChange("")} className="flex-none text-[11px] opacity-70 hover:opacity-100">
                    ✕
                </button>
            ) : null}
        </span>
    );
}

export function HistoryFilterRow() {
    const filters = useAtomValue(historyFiltersAtom);
    const rows = useAtomValue(historyRowsAtom);
    const graphOn = useAtomValue(graphOnAtom);
    const summary = filterSummary(filters, rows?.length ?? 0);
    return (
        <div className="flex flex-none items-center gap-[8px] border-b border-edge-faint px-[18px] pb-[11px]">
            <div className="flex w-[250px] items-center gap-[8px] rounded-[8px] border border-edge-mid bg-surface px-[10px] py-[5px] focus-within:border-accent/30">
                <span className="flex-none font-mono text-[11px] font-semibold text-ink-faint">/</span>
                <input
                    data-history-filter
                    value={filters.text}
                    placeholder="Filter history — message text"
                    onChange={(e) => setHistoryFilter({ text: e.target.value })}
                    onKeyDown={(e) => {
                        // Escape here means "leave the field", not "clear the filters" — the key's
                        // surface-level meaning is claimed by a binding that only fires outside a field.
                        if (e.key === "Escape") {
                            (e.target as HTMLInputElement).blur();
                        }
                    }}
                    className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-ink-hi outline-none placeholder:text-ink-faint"
                />
            </div>
            <FilterChip
                label="author"
                value={filters.author}
                placeholder="anyone"
                onChange={(v) => setHistoryFilter({ author: v })}
            />
            <FilterChip
                label="path"
                value={filters.path}
                placeholder="any path"
                onChange={(v) => setHistoryFilter({ path: v })}
            />
            {summary ? (
                <div className="flex items-center gap-[8px] text-[11.5px]">
                    <span data-filter-count className="font-semibold text-accent-soft">
                        {summary}
                    </span>
                    <button onClick={() => clearHistoryFilters()} className="text-muted underline hover:text-foreground">
                        Clear all · esc
                    </button>
                </div>
            ) : null}
            <div className="flex-1" />
            <button
                onClick={() => globalStore.set(graphOnAtom, !graphOn)}
                className={cn(
                    "flex items-center gap-[7px] rounded-[7px] border px-[10px] py-[5px] text-[11.5px] font-semibold",
                    graphOn ? "border-accent/30 bg-accentbg text-ink-hi" : "border-edge-mid bg-surface text-muted"
                )}
            >
                Graph
                <span className="font-mono text-[9.5px] text-ink-faint">G</span>
            </button>
        </div>
    );
}
```

- [x] **Step 2: Render it, and move the Graph button out of the subject bar**

In `frontend/app/view/agents/filessurface.tsx`:

Add the import:

```tsx
import { HistoryFilterRow } from "./historyfilterrow";
```

Delete the Graph button block from the subject bar — the `<div className="flex-1" />` at `:544` **and** the `<button onClick={() => globalStore.set(graphOnAtom, !graphOn)}>…</button>` at `:545-553`. The row's remaining children are the title, the source/scope control, and the ref expression or `RefPicker`.

The `graphOn` atom read at `:282` is still needed (the pane takes it as a prop), so leave it.

Immediately after the subject-bar wrapper closes (the `</div>` pair at `:554-555`) and before the `loadError` banner, add:

```tsx
                {/* nothing to filter in the two failure states, and compare has its own column */}
                {!compareOn && historyFailure == null && state?.isRepo !== false ? <HistoryFilterRow /> : null}
```

- [x] **Step 3: Suppress the graph while filtering, and make the count label honest**

In `frontend/app/view/agents/filessurface.tsx`, the `HistoryPane` call gains two props — a filtered set mostly lacks its own parents, so lane assignment would sprawl to the fold limit and draw edges to nothing:

```tsx
                            <HistoryPane
                                rows={historyRows ?? []}
                                selected={selectedCommit}
                                graphOn={graphOn && !historyFiltered}
                                countLabel={countLabel(historyFilters, historyRows?.length ?? 0, historyRows == null)}
                                loading={historyRows == null}
                                onSelect={(hash) => state?.cwd && fireAndForget(() => selectCommit(state.cwd!, hash))}
                            />
```

Add the two atom reads beside the others (`:278`), and the label import:

```tsx
    const historyFiltered = useAtomValue(historyFilteredAtom);
    const historyFilters = useAtomValue(historyFiltersAtom);
```

```tsx
import { countLabel } from "./historyquery";
```

with `historyFilteredAtom` and `historyFiltersAtom` added to the `./githistorystore` import list.

In `frontend/app/view/agents/historypane.tsx`, add `countLabel: string` to the props type and replace the hardcoded count at `:154-156`:

```tsx
                <span className="font-mono text-[10px] text-ink-faint">{countLabel}</span>
```

The empty state one line below (`:162`, currently the literal `No commits`) must also distinguish "this repository has none" from "your filter matched none" — otherwise a filter that matches nothing reads as an empty repository. Add a `filtered: boolean` prop and use it:

```tsx
                ) : rows.length === 0 ? (
                    <div className="px-[14px] py-[6px] text-[12px] text-ink-mid">
                        {filtered ? "No commits match these filters" : "No commits"}
                    </div>
                ) : (
```

and pass `filtered={historyFiltered}` from the surface alongside the props above.

- [x] **Step 4: Typecheck and lint**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

Run: `npx eslint frontend/app/view/agents/historyfilterrow.tsx`
Expected: no errors.

Run: `npx prettier --check frontend/app/view/agents/historyfilterrow.tsx`
Expected: pass (safe to `--write` this file — you wrote all of it).

---

### Task 7: Scroll persistence and paging

**Files:**
- Modify: `frontend/app/view/agents/historypane.tsx` — the props type and `HistoryPane` body (`:126-181`)
- Modify: `frontend/app/view/agents/filessurface.tsx` — pass the new props, stamp the unmount, render the Restored banner

**Interfaces:**
- Consumes: `NEAR_BOTTOM_PX`, `SCROLL_THROTTLE_MS`, `RESTORE_DISMISS_MS` from `historyquery.ts`; `historyScrollAtom`, `historyHasMoreAtom`, `historyAppendAtom`, `restoreNoticeAtom`, `loadMoreHistory`, `noteSurfaceLeft`, `dismissRestoreNotice` from the store.
- Produces: `HistoryPane` gains `countLabel`, `initialScroll`, `onScroll`, `hasMore`, `appendState`, `onLoadMore`. It carries `data-history-scroll` on its scroll container and `data-history-row` on each row, which Task 9 asserts on.

- [x] **Step 1: Take the new props and wire the scroll container**

In `frontend/app/view/agents/historypane.tsx`, add the imports:

```tsx
import { useEffect, useRef } from "react";
import { NEAR_BOTTOM_PX, SCROLL_THROTTLE_MS } from "./historyquery";
```

Extend the props and body of `HistoryPane`:

```tsx
export function HistoryPane({
    rows,
    selected,
    graphOn,
    loading,
    countLabel,
    filtered,
    initialScroll,
    hasMore,
    appendState,
    onSelect,
    onScroll,
    onLoadMore,
}: {
    rows: HistoryRow[];
    selected: string | null;
    graphOn: boolean;
    loading: boolean;
    countLabel: string;
    // only for the empty state's wording — the graph is suppressed by the surface passing graphOn=false
    filtered: boolean;
    initialScroll: number;
    hasMore: boolean;
    appendState: "idle" | "loading" | "failed";
    onSelect: (hash: string) => void;
    onScroll: (top: number) => void;
    onLoadMore: () => void;
}) {
    const laned = assignLanes(rows);
    const lanes = Math.min(Math.max(laneCount(laned), 1), MAX_LANES);
    const geom = graphGeometry(laned, { rowH: ROW_H, maxLanes: lanes });
    const indent = graphOn ? geom.gutter : NO_GRAPH_PAD;
    const scrollRef = useRef<HTMLDivElement>(null);
    const restored = useRef(false);
    const lastWrite = useRef(0);

    // Restore once, on the first render that actually has rows to scroll through — setting scrollTop
    // before then would be clamped to 0 by a zero-height container. The surface unmounts on every nav
    // switch, so this runs on every return.
    useEffect(() => {
        const el = scrollRef.current;
        if (el == null || restored.current || rows.length === 0) {
            return;
        }
        restored.current = true;
        el.scrollTop = initialScroll;
    }, [rows.length, initialScroll]);

    const handleScroll = () => {
        const el = scrollRef.current;
        if (el == null) {
            return;
        }
        // Throttled: this fires per frame while scrolling and every write re-renders the surface.
        const now = Date.now();
        if (now - lastWrite.current >= SCROLL_THROTTLE_MS) {
            lastWrite.current = now;
            onScroll(el.scrollTop);
        }
        if (hasMore && appendState !== "loading" && el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX) {
            onLoadMore();
        }
    };
```

- [x] **Step 2: Attach it, and add the page footer**

Replace the scroll container's opening tag at `:158` and add the footer as the last child inside the row list. The container:

```tsx
            <div ref={scrollRef} onScroll={handleScroll} data-history-scroll className="min-h-0 flex-1 overflow-y-auto pb-[24px]">
```

Add `data-history-row` to the row wrapper (`:167`), so a scenario can count rows without matching text:

```tsx
                            <div key={row.hash || "__wt__"} data-history-row>
```

And immediately after the `laned.map(...)` expression, still inside the `<div className="relative">`, add the footer:

```tsx
                        {appendState === "failed" ? (
                            <button
                                onClick={onLoadMore}
                                className="flex h-[34px] w-full items-center gap-[8px] px-[14px] text-left text-[12px] text-error hover:text-foreground"
                            >
                                Couldn’t load more commits — retry
                            </button>
                        ) : appendState === "loading" ? (
                            <div className="flex h-[34px] items-center px-[14px] font-mono text-[11px] text-ink-faint">
                                {`loading commits ${rows.length + 1}–${rows.length + HISTORY_PAGE_SIZE}…`}
                            </div>
                        ) : null}
```

which needs `HISTORY_PAGE_SIZE` added to the `./historyquery` import.

- [x] **Step 3: Wire the surface, stamp the unmount, show the banner**

In `frontend/app/view/agents/filessurface.tsx`, add to the `./githistorystore` import list: `historyAppendAtom`, `historyHasMoreAtom`, `historyScrollAtom`, `restoreNoticeAtom`, `dismissRestoreNotice`, `loadMoreHistory`, `noteSurfaceLeft`. Add `RESTORE_DISMISS_MS` to the `./historyquery` import.

Add the atom reads beside the others:

```tsx
    const historyScroll = useAtomValue(historyScrollAtom);
    const historyHasMore = useAtomValue(historyHasMoreAtom);
    const historyAppend = useAtomValue(historyAppendAtom);
    const restoreMsg = useAtomValue(restoreNoticeAtom);
```

Pass the new props to `HistoryPane` (alongside the two from Task 6):

```tsx
                                initialScroll={historyScroll}
                                hasMore={historyHasMore}
                                appendState={historyAppend}
                                onScroll={(top) => globalStore.set(historyScrollAtom, top)}
                                onLoadMore={() => fireAndForget(() => loadMoreHistory())}
```

Add two effects next to the existing ones:

```tsx
    // The surface unmounts on every nav switch; stamping the time on the way out is all it has to do.
    // The next history load decides whether anything is worth announcing (historyquery.restoreNotice).
    useEffect(() => () => noteSurfaceLeft(), []);

    useEffect(() => {
        if (restoreMsg == null) {
            return;
        }
        const t = setTimeout(() => dismissRestoreNotice(), RESTORE_DISMISS_MS);
        return () => clearTimeout(t);
    }, [restoreMsg]);
```

Render the banner immediately above the filter row:

```tsx
                {restoreMsg ? (
                    <div
                        data-restore-notice
                        className="mx-[18px] mb-[10px] flex flex-none items-center gap-[9px] rounded-[8px] border border-success/25 bg-success/12 px-[11px] py-[7px]"
                    >
                        <span className="font-mono text-[8.5px] font-bold uppercase tracking-[0.1em] text-graphlane-2">
                            Restored
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[12px] text-ink-mid">{restoreMsg}</span>
                        <button
                            onClick={() => dismissRestoreNotice()}
                            className="flex-none text-[11px] text-ink-faint hover:text-foreground"
                        >
                            ✕
                        </button>
                    </div>
                ) : null}
```

- [x] **Step 4: Typecheck and run everything**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

Run: `npx vitest run`
Expected: PASS. Against the shipped baseline this adds `historyquery.test.ts` (14 cases) and four `historyrows` cases and removes none, so the total rises and failures stay at zero.

---

### Task 8: Keys and hints

**Files:**
- Modify: `frontend/app/store/keybindings/bindings.ts` — the import block, `surface:back-home`'s guard (`:172-180`), and `buildFilesBindings` (`:512-559`)
- Modify: `frontend/app/store/keybindings/bindings.test.ts` (append a describe block)
- Modify: `frontend/app/store/keybindings/store.test.ts` (append one case)
- Modify: `frontend/app/cockpit/footerhints.ts` — the `files` entry (`:38-44`)

**Interfaces:**
- Consumes: `historyFiltersAtom`, `graphOnAtom`, `clearHistoryFilters`, `historyScrollAtom` from the store; `anyFilterActive` from `historyquery.ts`; the existing `on`/`inCompare` guards in `buildFilesBindings`.
- Produces: bindings `files:filter` (`/`), `files:toggle-graph` (`Shift:g`), `files:clear-filters` (`Escape`), `files:top` (`g g`), and their hint chips.

- [x] **Step 1: Write the failing tests**

Append to `frontend/app/store/keybindings/bindings.test.ts`:

```ts
describe("diff-surface history bindings", () => {
    const ctx = { surface: "files", editable: false, modalOpen: false } as KeyContext;
    const find = (id: string) => buildFilesBindings().find((b) => b.id === id)!;

    beforeEach(() => {
        globalStore.set(historyFiltersAtom, NO_FILTERS);
        globalStore.set(compareOnAtom, false);
        globalStore.set(graphOnAtom, true);
    });

    it("toggles the graph on Shift+g — bare 'g' is the leader key", () => {
        const b = find("files:toggle-graph");
        expect(b.keys).toBe("Shift:g");
        expect(b.when?.(ctx)).toBe(true);
        b.run();
        expect(globalStore.get(graphOnAtom)).toBe(false);
    });

    it("does not claim the graph or filter keys while compare is on", () => {
        globalStore.set(compareOnAtom, true);
        expect(find("files:toggle-graph").when?.(ctx)).toBe(false);
        expect(find("files:filter").when?.(ctx)).toBe(false);
    });

    it("offers clear-filters only when a filter is actually active", () => {
        expect(find("files:clear-filters").when?.(ctx)).toBe(false);
        globalStore.set(historyFiltersAtom, { author: "dana", path: "", text: "" });
        expect(find("files:clear-filters").when?.(ctx)).toBe(true);
    });

    it("passes the filter key through when the field is not on screen", () => {
        // no [data-history-filter] element exists in this environment
        expect(find("files:filter").run()).toBe(false);
    });

    it("scrolls history to the top on the g g chord", () => {
        globalStore.set(historyScrollAtom, 800);
        const b = find("files:top");
        expect(b.keys).toBe("g g");
        b.run();
        expect(globalStore.get(historyScrollAtom)).toBe(0);
    });
});
```

Append to `frontend/app/store/keybindings/store.test.ts`:

```ts
    it("Escape stays unambiguous on the Diff surface with filters active", () => {
        const model = {} as any;
        globalStore.set(listNavAtom, null);
        globalStore.set(compareOnAtom, false);
        globalStore.set(historyFiltersAtom, { author: "dana", path: "", text: "" });
        expect(() => assertNoConflicts([...buildGlobalBindings(model), ...buildFilesBindings()])).not.toThrow();
        globalStore.set(historyFiltersAtom, NO_FILTERS);
    });
```

Both files need imports added: `historyFiltersAtom`, `graphOnAtom`, `historyScrollAtom` from `@/app/view/agents/githistorystore`, `NO_FILTERS` from `@/app/view/agents/historyquery`, and (in `store.test.ts`) `compareOnAtom` from `@/app/view/agents/comparestore` if not already imported.

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/store/keybindings/`
Expected: FAIL — `Cannot read properties of undefined (reading 'keys')`, because none of the four ids exist yet.

- [x] **Step 3: Add the four bindings**

In `frontend/app/store/keybindings/bindings.ts`, add to the imports:

```ts
import { clearHistoryFilters, graphOnAtom, historyFiltersAtom, historyScrollAtom } from "@/app/view/agents/githistorystore";
import { anyFilterActive } from "@/app/view/agents/historyquery";
```

Inside `buildFilesBindings`, add a guard beside the existing two and the four bindings to the returned array:

```ts
    // History keys are off while compare is on: compare has no filter row and draws no graph.
    const inHistory = (ctx: KeyContext) => on(ctx) && !globalStore.get(compareOnAtom);
    const filtering = (ctx: KeyContext) => inHistory(ctx) && anyFilterActive(globalStore.get(historyFiltersAtom));
```

```ts
        {
            id: "files:filter",
            keys: "/",
            group: "Diff",
            label: "Filter history",
            when: inHistory,
            run: () => {
                const el = document.querySelector<HTMLInputElement>("[data-history-filter]");
                if (el == null) {
                    return false; // no filter row on screen (a failure panel, say) — let the key pass
                }
                el.focus();
            },
        },
        {
            // Shift:g, not bare "g": g is the leader key for the surface chords, and a bare letter
            // that shadows a leader can never fire. The footer shows it as "G".
            id: "files:toggle-graph",
            keys: "Shift:g",
            group: "Diff",
            label: "Toggle graph",
            when: inHistory,
            run: () => globalStore.set(graphOnAtom, !globalStore.get(graphOnAtom)),
        },
        {
            // Escape's order on this surface: clear filters, else leave compare, else go home. The
            // three guards are mutually exclusive by construction (this one requires filters active
            // and compare off), which is what keeps assertNoConflicts passing.
            id: "files:clear-filters",
            keys: "Escape",
            group: "Diff",
            label: "Clear filters",
            when: filtering,
            run: () => clearHistoryFilters(),
        },
        {
            // The mockup's footer says "g h" for top-of-history, but g h is already the chord for
            // Cockpit (home) in GO_TARGETS. g g is free and is the vim idiom for "top".
            id: "files:top",
            keys: "g g",
            group: "Diff",
            label: "Top of history",
            when: inHistory,
            run: () => {
                globalStore.set(historyScrollAtom, 0);
                const el = document.querySelector<HTMLElement>("[data-history-scroll]");
                if (el != null) {
                    el.scrollTop = 0;
                }
            },
        },
```

- [x] **Step 4: Exclude filter-active from the go-home Escape**

In the same file, `surface:back-home`'s `when` gains one clause, mirroring the `compareOnAtom` exclusion directly above it:

```ts
                // the Diff surface's compare state owns Escape while it is on: leaving compare is what
                // Escape means there, and going home instead would strand a two-ref read behind the Cockpit
                !globalStore.get(compareOnAtom) &&
                // and with filters active, Escape clears them — the filter row says so ("Clear all · esc")
                !(ctx.surface === "files" && anyFilterActive(globalStore.get(historyFiltersAtom))),
```

- [x] **Step 5: Add the hint chips**

In `frontend/app/cockpit/footerhints.ts`, the `files` array becomes:

```ts
    files: [
        { ids: ["list:prev-k", "list:next-j", "list:prev", "list:next"], glyph: "↑↓", label: "commit" },
        { ids: ["list:activate"], glyph: "⏎", label: "open file" },
        { ids: ["files:filter"], glyph: "/", label: "filter" },
        { ids: ["files:toggle-graph"], glyph: "G", label: "graph" },
        { ids: ["files:top"], glyph: "g g", label: "top" },
        { ids: ["files:compare"], glyph: "c", label: "compare" },
        { ids: ["files:switch-side"], glyph: "⇥", label: "side" }, // compare-only via its binding
        { ids: ["files:clear-filters"], glyph: "esc", label: "clear filters" }, // filtered-only via its binding
        { ids: ["files:exit-compare"], glyph: "esc", label: "history" }, // compare-only via its binding
    ],
```

- [x] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/store/keybindings/ frontend/app/cockpit/footerhints.test.ts`
Expected: PASS, including the new Escape-ownership case. A conflict naming `"/"` or `"Escape"` means a guard is too broad — read the error's surface/editable/modalOpen and narrow the guard rather than deleting the assertion.

- [x] **Step 7: Typecheck and lint**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

Run: `npx eslint frontend/app/store/keybindings/bindings.ts frontend/app/cockpit/footerhints.ts frontend/app/view/agents/filessurface.tsx frontend/app/view/agents/historypane.tsx frontend/app/view/agents/githistorystore.ts`
Expected: no errors.

---

### Task 9: The repeatable verification scenario

The Diff surface has never had one — every earlier check was an ad-hoc screenshot. Asserts are RPC-based or DOM-based; `globalStore` is **not** exposed on `window`, so no state can be injected and every state below is arranged for real.

**Files:**
- Modify: `scripts/cdp/scenarios.mjs` (add the scenario and register it in `SCENARIOS`)
- Modify: `frontend/app/view/agents/filessurface.tsx` — two `data-*` hooks on the source picker

**Interfaces:**
- Consumes: the harness `h` from `scripts/cdp/attach.mjs` (`ev`, `rpc`, `cdp`, `goto`, `shot`); the `createproject` / `deleteproject` RPCs (`CommandCreateProjectData{Name, Path}`, `CommandDeleteProjectData{Name}`); the `data-*` hooks added in Tasks 5–7.
- Produces: a `SCENARIOS` entry named `git-history`, runnable as `task verify:ui -- git-history`.

- [x] **Step 1: Make the source picker clickable from a scenario**

In `frontend/app/view/agents/filessurface.tsx`, inside `SourcePicker`, add `data-files-source-picker` to the trigger `<button>` (`:109`), and `data-files-source-option={p.name}` to each project row's button in the dropdown. Text matching is not enough here: agent names and project names can collide, and the dropdown renders both.

- [x] **Step 2: Write the scenario**

In `scripts/cdp/scenarios.mjs`, add `execFileSync` to the node imports:

```js
import { execFileSync } from "node:child_process";
```

and add the scenario before the `SCENARIOS` export:

```js
// --- git history: filters, paging, the two repository-failure panels, persistence ----------------
// Every state is arranged for real — globalStore is not on window, so nothing can be injected. The
// broken repo is a genuine failure: its ref file resolves but the object it names is gone, so
// `git log` fails while the directory is still a work tree.
const git = (dir, ...args) =>
    execFileSync("git", ["-C", dir, ...args], {
        stdio: "pipe",
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: "dana k",
            GIT_AUTHOR_EMAIL: "dana@example.com",
            GIT_COMMITTER_NAME: "dana k",
            GIT_COMMITTER_EMAIL: "dana@example.com",
        },
    });

const gitHistory = {
    name: "git-history",
    surface: "files",
    async arrange(h) {
        const good = mkdtempSync(join(tmpdir(), "verify-git-good-"));
        git(good, "init", "-q", "--initial-branch=main");
        writeFileSync(join(good, "refunds.txt"), "refunds\n");
        git(good, "add", ".");
        git(good, "commit", "-q", "-m", "split refund path from capture path");
        // 60 empty commits so the second page has something in it (page size is 50)
        for (let i = 0; i < 60; i++) {
            git(good, "commit", "-q", "--allow-empty", "-m", `filler commit ${i}`);
        }

        const broken = mkdtempSync(join(tmpdir(), "verify-git-broken-"));
        git(broken, "init", "-q", "--initial-branch=main");
        git(broken, "commit", "-q", "--allow-empty", "-m", "only commit");
        rmSync(join(broken, ".git", "objects"), { recursive: true, force: true });

        const notRepo = mkdtempSync(join(tmpdir(), "verify-git-plain-"));

        const names = { good: "verify-git-good", broken: "verify-git-broken", notRepo: "verify-git-plain" };
        await h.rpc("createproject", { name: names.good, path: good });
        await h.rpc("createproject", { name: names.broken, path: broken });
        await h.rpc("createproject", { name: names.notRepo, path: notRepo });
        return { dirs: [good, broken, notRepo], names };
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const pick = async (name) => {
            await h.ev(`document.querySelector('[data-files-source-picker]').click()`);
            await sleep(150);
            const ok = await h.ev(
                `(() => { const b = document.querySelector('[data-files-source-option=${JSON.stringify(name)}]');
                  if (!b) return false; b.click(); return true; })()`
            );
            if (!ok) throw new Error(`source option "${name}" not in the picker`);
            await sleep(1200); // change list + history page
        };
        const rowCount = () => h.ev(`document.querySelectorAll('[data-history-row]').length`);
        const text = (sel) => h.ev(`(document.querySelector(${JSON.stringify(sel)})?.textContent || '').trim()`);
        const present = (sel) => h.ev(`!!document.querySelector(${JSON.stringify(sel)})`);

        await pick(ctx.names.good);
        const first = await rowCount();
        const gutter = await present("[data-graph-gutter]");
        rec("1. history populated: a full page of rows, graph gutter drawn", first === 50 && gutter, `rows=${first} gutter=${gutter}`);
        await h.shot("cdp-shots/git-history-populated.png");

        // paging: scrolling to the bottom appends the next page
        await h.ev(`(() => { const el = document.querySelector('[data-history-scroll]'); el.scrollTop = el.scrollHeight; })()`);
        await sleep(1500);
        const paged = await rowCount();
        rec("2. scrolling to the bottom appends a second page", paged > first, `rows=${first} -> ${paged}`);

        // filtering: real text into the real field, via a real input event
        await h.ev(`document.querySelector('[data-history-filter]').focus()`);
        await h.cdp("Input.insertText", { text: "refund" });
        await sleep(1200);
        const filtered = await rowCount();
        const countChip = await text("[data-filter-count]");
        const gutterStillThere = await present("[data-graph-gutter]");
        rec(
            "3. filter narrows the list, states the count, and hides the graph",
            filtered > 0 && filtered < first && countChip.includes("1 filter") && !gutterStillThere,
            `rows=${filtered} chip="${countChip}" gutterStillThere=${gutterStillThere}`
        );
        await h.shot("cdp-shots/git-history-filtered.png");

        // Escape clears the filters (the row says "Clear all · esc"), not navigate home
        await h.ev(`document.querySelector('[data-history-filter]').blur()`);
        await h.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
        await h.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
        await sleep(1200);
        const cleared = await rowCount();
        const stillHere = (await h.activeSurfaceLabel()) === SURFACE_LABEL.files;
        rec("4. Escape clears the filters and stays on the surface", cleared === 50 && stillHere, `rows=${cleared} onSurface=${stillHere}`);

        // persistence: leave the surface and come back
        await h.ev(`(() => { const el = document.querySelector('[data-history-scroll]'); el.scrollTop = 300; })()`);
        await sleep(400);
        const before = await text("[data-history-scroll] [data-history-row]:nth-child(1)");
        await h.goto("cockpit");
        await h.goto("files");
        await sleep(1200);
        const scrollBack = await h.ev(`document.querySelector('[data-history-scroll]').scrollTop`);
        const after = await text("[data-history-scroll] [data-history-row]:nth-child(1)");
        rec("5. returning restores the scroll offset and the same top row", scrollBack > 0 && after === before, `scrollTop=${scrollBack}`);

        await pick(ctx.names.notRepo);
        const calm = await present("[data-not-a-repo]");
        const noFailure = await present("[data-git-failure]");
        rec("6. a plain directory reads as not-a-repository, not a failure", calm && !noFailure, `notRepo=${calm} failure=${noFailure}`);
        await h.shot("cdp-shots/git-history-notrepo.png");

        await pick(ctx.names.broken);
        const failed = await present("[data-git-failure]");
        const evidence = await text("[data-git-failure]");
        rec(
            "7. an unreadable repository reads as a failure, with git's own message",
            failed && evidence.includes("git log") && evidence.length > 40,
            `failure=${failed} evidence="${evidence.slice(0, 120)}"`
        );
        await h.shot("cdp-shots/git-history-failed.png");

        return steps;
    },
    async teardown(h, ctx) {
        for (const name of Object.values(ctx.names)) {
            try {
                await h.rpc("deleteproject", { name });
            } catch {
                /* leave a stale registry entry rather than failing teardown */
            }
        }
        for (const dir of ctx.dirs) {
            rmSync(dir, { recursive: true, force: true });
        }
    },
};
```

Add `writeFileSync` to the `node:fs` import at the top of the file, and register the scenario in the `SCENARIOS` array.

- [x] **Step 3: Add the gutter hook**

In `frontend/app/view/agents/graphgutter.tsx`, add `data-graph-gutter` to the root `<svg>`. Step 2's assertions 1 and 3 both key off it.

- [x] **Step 4: Check the syntax and the indentation by hand**

Run: `node --check scripts/cdp/scenarios.mjs`
Expected: exit 0.

Then read your addition back for 4-space indentation. `.editorconfig` omits `.mjs`, so **do not run `prettier --write` on `scripts/cdp/scenarios.mjs`** — it would reindent the entire file to two spaces and bury your change in a whole-file diff.

- [ ] **Step 5: Run the scenario against the dev app** — **NOT RUN (2026-08-03).** The dev app was live,
  but it served pre-change source and a `wavesrv` built before `History.Failure` existed, so step 7's
  failure panel could not have passed. Restarting the dev app was declined, so the scenario code landed
  unrun. Run `task verify:ui -- git-history` after the next `task build:backend` + `task dev`.

With the dev app running (`task dev`; if it is not, say so and skip rather than reporting a pass):

Run: `task verify:ui -- git-history`
Expected: seven PASS rows and exit 0. Screenshots land in `cdp-shots/` and the contact sheet at `cdp-shots/index.html`.

If the page is blank, do a full `location.reload()` first — HMR blanks the cockpit when modules move. If the run fails with `ECONNREFUSED :9222`, the dev app died (often another session's edit crashed it); check the dev log before assuming a harness fault.

- [x] **Step 6: Record the declined items**

Add to `docs/deferred.md`, under its existing structure:

```markdown
- **Diff surface narrow-window folding and row density declined** (2026-08-03). The Git-review mockup folds the commit pane to a chip below ~1100px, drops the author column, folds the graph to three lanes and turns history into a drawer below 900px, and exposes comfortable 34px / compact 28px rows. Both declined in `docs/superpowers/specs/2026-08-03-git-review-history-reads-design.md` decision 2: the cockpit runs at roughly 1600×950, so every breakpoint would be an untested path, and `historypane.tsx` keeps its single `ROW_H = 34`. Revive only on evidence of a narrow-window user.
```

- [x] **Step 7: Full verification, then report — do not commit**

Run:

```
go build ./...
go test ./pkg/gitinfo/ ./pkg/wshrpc/...
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
npx vitest run
npx eslint frontend/app/view/agents/ frontend/app/store/keybindings/ frontend/app/cockpit/footerhints.ts
task verify:ui -- git-history
```

Expected: all six clean.

Summarise for review: the three Go tests from Task 1; the 14 `historyquery` cases; the four `keepSelection` cases; the five new keybinding cases plus the Escape no-conflict case; the full frontend suite total; the typecheck; and the seven scenario rows with what the screenshots showed. Name explicitly anything skipped. Then stop and hand back for the single end-of-work commit, which needs explicit approval and includes this plan and its spec.

---

## Not in this plan

Each is a control the mockup declares, so the surface will visibly lack it:

- **The Fetch button and its freshness clock** — the only mutation the brief permits; needs a new RPC, and is the real answer to the stale-local-default caveat in the branch-comparison spec.
- **Commit provenance**, the "Produced by Run #148" line — a new backend join from `Run` objects to commit hashes.
- **The Unified / Split diff toggle** and the desaturated diff-text tints `--color-diff-add-ink` / `--color-diff-del-ink`.
- **Narrow-window folding and row density** — declined outright, not postponed (Task 9 step 7 records this).
- **Blame** — never proposed; the brief and the mockup both exclude it.
