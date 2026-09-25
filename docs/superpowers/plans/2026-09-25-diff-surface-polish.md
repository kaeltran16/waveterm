# Diff Surface Polish Implementation Plan

**Verify:** `npx vitest run && go test ./pkg/gitinfo/`
**Setup:** `task worktree:prepare`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`

> **For agentic workers:** Implement your one task in your worktree, TDD where a pure model is involved.
> Steps use checkbox (`- [ ]`) syntax. Do not spawn subagents or forks.

**Goal:** Bring the live Diff surface to the diff-polish boards, fixing the six known mockup defects.

**Architecture:** Restyle and relocate the existing Diff components under `frontend/app/view/agents/`;
new behaviour lives in small pure models with tests beside them; one Go field (merge-base time)
feeds the compare header. `filessurface.tsx` is edited by Task 7 only.

**Tech Stack:** React 19, jotai, Tailwind 4, Monaco 0.55, lucide-react, vitest; Go (`pkg/gitinfo`).

**Spec:** `docs/superpowers/specs/2026-09-25-diff-surface-polish-design.md` — read it first, and render
the boards it names (`.superpowers/design/diff-polish/project/*.dc.html`, headless Chrome command in
the spec). The boards are the visual spec; the spec's "Deviations" section overrides them.

## Global Constraints

- Colors only from `@theme` tokens in `frontend/tailwindsetup.css`; no raw hex/rgba, no new tokens.
- Pure logic in a `.ts` with a `.test.ts` beside it; no jsdom render tests.
- Icons from `lucide-react`; ages via `formatAgo` / `formatAge` in `agentsviewmodel.ts`.
- Keep every `data-*` hook and the `Expand history` / `Collapse history` button titles listed in the
  spec's "Goal and constraints".
- Never hand-edit generated files (`frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts`,
  `pkg/wshrpc/wshclient/wshclient.go`); edit Go and run `task generate`.
- Comments explain why, not what; match the surrounding comment density.
- Check only files you touched with `npx prettier --check <files>` / `gofmt -l <files>`; never
  `--write` the tree, never run prettier on `scripts/*.mjs`.
- Commit messages: `type(scope): description`, no attribution trailers.

## Review Focus

1. Detached HEAD (`branch` is `""` or `"HEAD"`): the summary and the working-tree caption must say
   "against HEAD" / "Detached HEAD", never "on HEAD" or "on ". Pinned in Task 3 and Task 7 tests.
2. A pure-deletion hunk (Monaco reports `modifiedEndLineNumber = 0`): "change N/M" must still count it
   and not report 0 once the cursor is on it. Pinned in Task 2.
3. Unrelated histories (no merge base): Go returns `MergeBaseTs = 0`, `splitLabel` omits the age,
   `formSentence` does not print "split at ." with an empty hash. Pinned in Tasks 1 and 4.
4. Windows project paths with mixed separators and case (`C:\Repo\.worktrees\x` vs `c:/repo`):
   `worktreeParent` must still find the parent, and must not match a sibling sharing a prefix
   (`C:/repo2`). Pinned in Task 5.
5. A slow first read that is retried: the notice's clock restarts on Retry and the notice vanishes
   when rows arrive or the read fails. Pinned in Task 3.

---

### Task 1: Merge-base commit time on the divergence read
**Depends on:** none

**Files:**
- Modify: `pkg/gitinfo/gitinfo.go` (`Divergence`, `GetDivergence`, ~line 720-757)
- Modify: `pkg/wshrpc/wshrpctypes_git.go` (`CommandGitDivergenceRtnData`)
- Modify: `pkg/wshrpc/wshserver/wshserver_git.go:35` (carry the field)
- Regenerate: `task generate` (updates `frontend/types/gotypes.d.ts`)
- Test: `pkg/gitinfo/gitinfo_test.go`

**Interfaces:**
- Produces: TS `CommandGitDivergenceRtnData.mergebasets: number` (unix milliseconds, like `HistoryCommit.ts`; 0 = unknown).

- [ ] **Step 1: Failing test** — append to `pkg/gitinfo/gitinfo_test.go` beside `TestGetDivergenceReportsMergeBase`:

```go
func TestGetDivergenceReportsMergeBaseTime(t *testing.T) {
	dir := repoDiverged(t)
	d, err := GetDivergence(context.Background(), dir, "main", "feature")
	if err != nil {
		t.Fatalf("GetDivergence: %v", err)
	}
	root, err := HistoryLog(context.Background(), dir, HistoryOpts{Ref: "main"})
	if err != nil {
		t.Fatal(err)
	}
	want := root.Commits[len(root.Commits)-1].Ts
	if d.MergeBaseTs != want {
		t.Errorf("MergeBaseTs = %d, want the root commit's time %d", d.MergeBaseTs, want)
	}
}
```

`HistoryCommit.Ts` is unix milliseconds (`secs * 1000` in `HistoryLog`), so `MergeBaseTs` uses the same unit. Run
`go test ./pkg/gitinfo/ -run MergeBaseTime` — expect a compile failure (`MergeBaseTs` undefined).

- [ ] **Step 2: Implement** — add `MergeBaseTs int64 \`json:"mergebasets"\`` to `Divergence` with the comment
`// unix ms of the merge base's commit, the unit HistoryCommit.Ts uses; 0 when there is none`. In
`GetDivergence`, after computing `mb`, when `strings.TrimSpace(mb) != ""` run
`run(mbCtx, cwd, "show", "-s", "--format=%ct", mbHash)` and `strconv.ParseInt` the trimmed output and multiply by 1000; on a
parse error return the error (a merge base that exists but has no readable time is a real fault). Note
`git merge-base` exits 1 for unrelated histories: if the existing code already errors there, leave that
behaviour alone and do not add a time. Add the same field to `CommandGitDivergenceRtnData` and set it
in `wshserver_git.go`.

- [ ] **Step 3: Regenerate and test** — `task generate`, then `go test ./pkg/gitinfo/` (all pass) and
`gofmt -l pkg/gitinfo pkg/wshrpc`. Confirm `frontend/types/gotypes.d.ts` gained `mergebasets: number`.

- [ ] **Step 4: Commit** — `feat(git): report when the compared refs split`.

### Task 2: Diff pane header, folding, change position, empty states
**Depends on:** none

**Files:**
- Modify: `frontend/app/view/agents/diffoptions.ts`, `diffoptions.test.ts`
- Modify: `frontend/app/view/agents/diffnav.ts`, `diffnav.test.ts` (exists — append with Edit, never Write over it)
- Create: `frontend/app/view/agents/diffempty.ts`, `diffempty.test.ts`
- Modify: `frontend/util/paths.ts`, `frontend/util/paths.test.ts` (append)
- Modify: `frontend/app/view/agents/diffpane.tsx`

**Interfaces:**
- Produces (used by Task 7): `DiffPane` gains an optional prop `nothingToCompare?: { base: string; head: string } | null` (default `null`). All existing props unchanged.
- Produces: `LABELLED_MIN_PX`, `paneHeaderLayout`, `changePosition`, `diffNavPosAtom`, `emptyDiffState`, `splitRepoPath`.

- [ ] **Step 1: Failing tests.** Append to `diffoptions.test.ts`:

```ts
import { LABELLED_MIN_PX, paneHeaderLayout, SPLIT_MIN_PX } from "./diffoptions";

describe("the pane header's layout at a measured width", () => {
    it("drops split and labels on a narrow pane", () => {
        expect(paneHeaderLayout(760)).toEqual({ split: false, labelled: false });
    });
    it("offers split before it can afford labels", () => {
        expect(paneHeaderLayout(SPLIT_MIN_PX)).toEqual({ split: true, labelled: false });
        expect(paneHeaderLayout(LABELLED_MIN_PX - 1)).toEqual({ split: true, labelled: false });
    });
    it("labels the buttons once the pane is wide enough", () => {
        expect(paneHeaderLayout(LABELLED_MIN_PX)).toEqual({ split: true, labelled: true });
    });
    it("treats an unmeasured pane as narrow", () => {
        expect(paneHeaderLayout(0)).toEqual({ split: false, labelled: false });
    });
});

describe("folding", () => {
    it("folds unchanged regions with three lines of context", () => {
        expect(paneOptions(false, false).hideUnchangedRegions).toEqual({
            enabled: true,
            contextLineCount: 3,
            minimumLineCount: 3,
            revealLineCount: 20,
        });
    });
});
```

Append to `diffnav.test.ts`:

```ts
import { changePosition } from "./diffnav";

describe("changePosition", () => {
    const changes = [
        { start: 10, end: 12 },
        { start: 40, end: 0 }, // a pure deletion: Monaco reports end 0
        { start: 90, end: 95 },
    ];
    it("is 0 of N before the first change", () => {
        expect(changePosition(changes, 1)).toEqual({ index: 0, total: 3 });
    });
    it("counts the change the cursor is in or has passed", () => {
        expect(changePosition(changes, 10)).toEqual({ index: 1, total: 3 });
        expect(changePosition(changes, 30)).toEqual({ index: 1, total: 3 });
    });
    it("counts a pure deletion once the cursor reaches it", () => {
        expect(changePosition(changes, 40)).toEqual({ index: 2, total: 3 });
    });
    it("stays on the last change past the end", () => {
        expect(changePosition(changes, 500)).toEqual({ index: 3, total: 3 });
    });
    it("is 0 of 0 with nothing changed", () => {
        expect(changePosition([], 5)).toEqual({ index: 0, total: 0 });
    });
});
```

Create `diffempty.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { emptyDiffState } from "./diffempty";

const pair = (over: Partial<{ binary: boolean; tooLarge: boolean; original: string; modified: string; size: number }> = {}) => ({
    path: "a.ts",
    binary: false,
    tooLarge: false,
    original: "x",
    modified: "y",
    size: 0,
    ...over,
});

describe("emptyDiffState", () => {
    it("says two refs that agree are an answer, not a blank", () => {
        expect(emptyDiffState({ path: null, pair: null, nothingToCompare: { base: "main", head: "origin/main" } })).toEqual({
            kind: "nothing",
            title: "Nothing to compare",
            body: "main and origin/main have no file differences.",
        });
    });
    it("asks for a file when none is selected", () => {
        expect(emptyDiffState({ path: null, pair: null, nothingToCompare: null })?.kind).toBe("nofile");
    });
    it("is null while the pair is still loading, so the pane shows its skeleton", () => {
        expect(emptyDiffState({ path: "a.ts", pair: null, nothingToCompare: null })).toBeNull();
        expect(emptyDiffState({ path: "b.ts", pair: pair(), nothingToCompare: null })).toBeNull();
    });
    it("names the 2 MB limit for a file too large to diff", () => {
        expect(emptyDiffState({ path: "a.ts", pair: pair({ tooLarge: true }), nothingToCompare: null })).toEqual({
            kind: "toolarge",
            title: "Too large to show here",
            body: "Diffs stop at 2 MB. Open it in Code to read the file.",
        });
    });
    it("explains a binary file", () => {
        expect(emptyDiffState({ path: "a.ts", pair: pair({ binary: true }), nothingToCompare: null })?.body).toBe(
            "Git records a change here, but there is no text to compare."
        );
    });
    it("explains a rename or mode change", () => {
        expect(emptyDiffState({ path: "a.ts", pair: pair({ original: "same", modified: "same" }), nothingToCompare: null })).toEqual({
            kind: "unchanged",
            title: "Contents unchanged",
            body: "Only the name or the file mode changed.",
        });
    });
    it("is null when there is a diff to draw", () => {
        expect(emptyDiffState({ path: "a.ts", pair: pair(), nothingToCompare: null })).toBeNull();
    });
});
```

Append to `frontend/util/paths.test.ts`:

```ts
describe("splitRepoPath", () => {
    it("keeps the trailing slash on the directory", () => {
        expect(splitRepoPath("frontend/app/view/agents/agenttree.tsx")).toEqual({
            dir: "frontend/app/view/agents/",
            file: "agenttree.tsx",
        });
    });
    it("has an empty directory at the root", () => {
        expect(splitRepoPath("README.md")).toEqual({ dir: "", file: "README.md" });
    });
});
```
(add `splitRepoPath` to that file's import). Run `npx vitest run frontend/app/view/agents/diffoptions.test.ts frontend/app/view/agents/diffnav.test.ts frontend/app/view/agents/diffempty.test.ts frontend/util/paths.test.ts` — expect failures on the missing exports.

- [ ] **Step 2: Implement the models.**

`diffoptions.ts` — add:

```ts
// Below this the header's labelled buttons wrap: at 1600x950 with history open the pane is ~760px.
// Measured on the pane itself, like SPLIT_MIN_PX, because the window says nothing about the columns.
export const LABELLED_MIN_PX = 1100;

export function paneHeaderLayout(width: number): { split: boolean; labelled: boolean } {
    return { split: width >= SPLIT_MIN_PX, labelled: width >= LABELLED_MIN_PX };
}
```
and in `paneOptions` add
`hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 3, revealLineCount: 20 },`.

`diffnav.ts` — add (import `atom` from jotai):

```ts
export interface ChangeRange {
    start: number;
    // 0 for a pure deletion, which Monaco anchors at start on the modified side
    end: number;
}

// Which change the cursor is on, 1-based; 0 before the first. goToDiff lands the cursor on a change's
// first line, so after a Shift+N this is exact, and between changes it names the one just passed.
export function changePosition(changes: ChangeRange[], cursorLine: number): { index: number; total: number } {
    let index = 0;
    changes.forEach((c, i) => {
        if (c.start <= cursorLine) {
            index = i + 1;
        }
    });
    return { index, total: changes.length };
}

// null while no editor is mounted, so the header can hide the counter instead of printing 0/0
export const diffNavPosAtom = atom<{ index: number; total: number } | null>(null) as PrimitiveAtom<{
    index: number;
    total: number;
} | null>;
```

`diffempty.ts` (new, with the file header comment convention used by neighbours):

```ts
// Pure: why the diff pane has nothing to draw, in words. Null means there is something to draw, or
// the pair is still loading and the pane's skeleton is the honest answer.

export type EmptyDiffKind = "nothing" | "nofile" | "toolarge" | "binary" | "unchanged";

export interface EmptyDiff {
    kind: EmptyDiffKind;
    title: string;
    body: string;
}

export interface EmptyDiffInput {
    path: string | null;
    pair: { path: string; binary: boolean; tooLarge: boolean; original: string; modified: string } | null;
    // set when compare's aggregate is selected and lists no files
    nothingToCompare: { base: string; head: string } | null;
}

export function emptyDiffState(i: EmptyDiffInput): EmptyDiff | null {
    if (i.nothingToCompare != null) {
        const { base, head } = i.nothingToCompare;
        return { kind: "nothing", title: "Nothing to compare", body: `${base} and ${head} have no file differences.` };
    }
    if (!i.path) {
        return {
            kind: "nofile",
            title: "Pick a file to see its changes",
            body: "Choose one from the list, or move through it with the arrow keys.",
        };
    }
    if (i.pair == null || i.pair.path !== i.path) {
        return null;
    }
    if (i.pair.tooLarge) {
        // gitinfo.maxDiffBytes
        return { kind: "toolarge", title: "Too large to show here", body: "Diffs stop at 2 MB. Open it in Code to read the file." };
    }
    if (i.pair.binary) {
        return { kind: "binary", title: "Binary file", body: "Git records a change here, but there is no text to compare." };
    }
    if (i.pair.original === i.pair.modified) {
        return { kind: "unchanged", title: "Contents unchanged", body: "Only the name or the file mode changed." };
    }
    return null;
}
```

`frontend/util/paths.ts` — add:

```ts
// A repo-relative path as the diff header draws it: the directory keeps its trailing slash so the two
// halves concatenate back to the path, and the file name can be styled on its own.
export function splitRepoPath(p: string): { dir: string; file: string } {
    const i = p.lastIndexOf("/");
    return i < 0 ? { dir: "", file: p } : { dir: p.slice(0, i + 1), file: p.slice(i + 1) };
}
```

Run the Step 1 command — all pass.

- [ ] **Step 3: Rewire `diffpane.tsx`** (Main / Compact / Controls §5 boards).
  - Replace `splitAvailable` with `const layout = paneHeaderLayout(width)`; options use `split && layout.split`.
  - `body()`: compute `const empty = emptyDiffState({ path, pair, nothingToCompare: nothingToCompare ?? null })`. If `empty` → render an `EmptyState` (lucide `FileText` icon 16px inside a 28px `rounded-[8px] border border-edge-mid bg-surface` box, title `text-[13px] font-semibold text-ink-hi`, body `text-[12px] text-ink-mid`, centred, gap as on the board). Else if `pair == null || pair.path !== path` → `PaneSkeleton`. Else the Monaco viewer. Delete `Centered` if unused.
  - Header renders when `path` is set (binary / too large / unchanged keep it; too large appends `fmtBytes(pair.size)` in faint mono after the counts).
  - Path: `const { dir, file } = splitRepoPath(path)`; render
    `<span className="flex min-w-0 items-baseline font-mono text-[12.5px]"><span className="min-w-0 truncate text-ink-faint [direction:rtl]"><bdi dir="ltr">{dir}</bdi></span><span className="flex-none font-semibold text-ink-hi">{file}</span></span>` then the +/− spans. Add a comment on why the `<bdi>` exists (rtl alone moves the trailing "/").
  - Change nav (only when `useAtomValue(diffNavPosAtom)` is non-null and `total > 0`): lucide `ChevronUp` button (`title="Previous change (⇧P)"`, `onClick={() => gotoChange("previous")}`), text `change {index}/{total}` in faint mono, `ChevronDown` button (`title="Next change (⇧N)"`). When `layout.labelled` is false, drop the word "change".
  - Unified/Split: render only when `layout.split` — a two-segment control (`rounded-[8px] border border-edge-mid`, active segment `bg-surface-selected text-ink-hi`, inactive `text-muted`), `title="Unified / split (⇧D)"`, writing `splitViewAtom`.
  - Whitespace: when `layout.labelled` a button "Hide whitespace" with lucide `Pilcrow`; else icon-only with `title` and `aria-label` = "Hide whitespace (⇧W)". Active (`ignoreWs`) uses `border-accent/30 bg-accentbg text-ink-hi`.
  - Open in Code: lucide `Code` + "Open in Code" when labelled, icon-only with `title`/`aria-label="Open in Code"` otherwise. Open in editor: always icon-only lucide `ExternalLink`, `title="Open in editor"`.
  - `onMount={(diff) => { ... }}`: after `setDiffNav(diff)`, define `update` that sets `diffNavPosAtom` to `changePosition((diff.getLineChanges() ?? []).map((c) => ({ start: c.modifiedStartLineNumber, end: c.modifiedEndLineNumber })), diff.getModifiedEditor().getPosition()?.lineNumber ?? 0)`; subscribe `diff.onDidUpdateDiff(update)` and `diff.getModifiedEditor().onDidChangeCursorPosition(update)`; the cleanup disposes both, calls `clearDiffNav(diff)`, and sets `diffNavPosAtom` to null.
  - Add the `nothingToCompare` prop with default `null`.

- [ ] **Step 4: Verify** — `npx vitest run frontend/app/view/agents frontend/util`, then the Check command
(about 2 min; give it a 5-minute timeout). Both clean.

- [ ] **Step 5: Commit** — `feat(diff): fold unchanged regions and fit the pane header to its width`.

### Task 3: History column, working-tree row, commit pane, slow and empty states
**Depends on:** none

**Files:**
- Modify: `frontend/app/view/agents/historyrows.ts`, `historyrows.test.ts`
- Modify: `frontend/app/view/agents/historyquery.ts`, `historyquery.test.ts`
- Modify: `frontend/app/view/agents/githistorystore.ts`, `githistorystore.test.ts` (append; never Write over)
- Modify: `frontend/app/view/agents/historypane.tsx`, `historyfilterrow.tsx`, `historyrail.tsx`, `commitpane.tsx`

**Interfaces:**
- Produces (Task 7 wires it): `HistoryPane` optional prop `onCollapse?: () => void` (the collapse button renders only when given). `HistoryPane` renders `HistoryFilterRow` itself.
- Produces: `CommitPane` optional props `caption?: string` (the working-tree caption; Task 7 passes `worktreeCaption(...)`).
- Produces: `historyLoadStartedAtom: PrimitiveAtom<number | null>`, `startFromTop(): void`, `SLOW_HISTORY_MS`, `slowSeconds`, `noMatchSentence`, `worktreeCaption`, `HistoryRow.fileCount?: number`.

- [ ] **Step 1: Failing tests.**

In `historyrows.test.ts`, change the two existing uncommitted-row assertions (lines ~86 and ~93) and the rowLabel cases (~103-107) to the new shape, and add caption tests:

```ts
expect(rows[0].subject).toBe("Uncommitted changes");
expect(rows[0].fileCount).toBe(3);
// rowLabel case:
expect(session[0].subject).toBe("Since session start");
expect(session[0].fileCount).toBe(1);

describe("worktreeCaption", () => {
    it("names the branch and the commit the working tree is measured from", () => {
        expect(worktreeCaption({ kind: "working" }, "main", "3eaffac1234", "")).toBe("On main, measured from 3eaffac");
    });
    it("does not call a detached HEAD a branch", () => {
        expect(worktreeCaption({ kind: "working" }, "", "3eaffac1234", "")).toBe("Detached HEAD, measured from 3eaffac");
        expect(worktreeCaption({ kind: "working" }, "HEAD", "3eaffac1234", "")).toBe("Detached HEAD, measured from 3eaffac");
    });
    it("measures a session from its start commit", () => {
        expect(worktreeCaption({ kind: "session", agentId: "a" }, "main", "3eaffac1234", "9f2c1de0000")).toBe(
            "On main, measured from session start 9f2c1de"
        );
    });
    it("measures a run from its base", () => {
        expect(worktreeCaption({ kind: "run", runId: "r", baseCommit: "b41d000aaaa" }, "wave/r", "x", "")).toBe(
            "On wave/r, measured from run base b41d000"
        );
    });
});
```

In `historyquery.test.ts`, update the restoreNotice expectations to the new wording and add:

```ts
// existing cases, new wording:
).toBe("Back where you left off: commit c41d8ec, your scroll position and 2 filters.");
).toBe("Back where you left off: 1 filter.");

describe("noMatchSentence", () => {
    it("reads the author and the text together", () => {
        expect(noMatchSentence({ author: "Kael", path: "", text: "workerr" })).toBe("No commit by Kael mentions “workerr”.");
    });
    it("reads one filter alone", () => {
        expect(noMatchSentence({ author: "Kael", path: "", text: "" })).toBe("No commit by Kael.");
        expect(noMatchSentence({ author: "", path: "", text: "workerr" })).toBe("No commit mentions “workerr”.");
    });
    it("adds the path as its own clause", () => {
        expect(noMatchSentence({ author: "", path: "pkg/", text: "" })).toBe("No commit touches pkg/.");
        expect(noMatchSentence({ author: "Kael", path: "pkg/", text: "x" })).toBe("No commit by Kael mentions “x” and touches pkg/.");
    });
});

describe("slowSeconds", () => {
    it("is silent for the first ten seconds", () => {
        expect(slowSeconds(1_000, 1_000 + SLOW_HISTORY_MS - 1)).toBeNull();
    });
    it("counts whole seconds once the read is slow", () => {
        expect(slowSeconds(1_000, 1_000 + 14_400)).toBe(14);
    });
    it("is silent when nothing is loading", () => {
        expect(slowSeconds(null, 99_000)).toBeNull();
    });
});
```

Append to `githistorystore.test.ts` (reuse its mocks and fixtures; import the new names):

```ts
describe("the slow-read clock", () => {
    it("starts when a fresh read has nothing on screen and stops when rows arrive", async () => {
        resetHistory();
        let resolve!: (v: any) => void;
        gitHistory.mockReturnValueOnce(new Promise((r) => (resolve = r)));
        const p = loadHistory("C:/other", {});
        expect(globalStore.get(historyLoadStartedAtom)).not.toBeNull();
        resolve({ isrepo: true, head: "aaa", commits: [commit("aaa", "one")] });
        await p;
        expect(globalStore.get(historyLoadStartedAtom)).toBeNull();
    });
    it("stops on a failed read too", async () => {
        resetHistory();
        gitHistory.mockRejectedValueOnce(new Error("socket closed"));
        await loadHistory("C:/other2", {});
        expect(globalStore.get(historyLoadStartedAtom)).toBeNull();
    });
    it("restarts on retry", async () => {
        resetHistory();
        gitHistory.mockReturnValue(new Promise(() => {}));
        void loadHistory("C:/slow", {});
        const first = globalStore.get(historyLoadStartedAtom)!;
        vi.setSystemTime(first + 20_000);
        retryHistory();
        expect(globalStore.get(historyLoadStartedAtom)).toBe(first + 20_000);
        vi.useRealTimers();
        gitHistory.mockReset();
    });
});

describe("startFromTop", () => {
    it("clears filters, scroll and selection, and dismisses the notice", async () => {
        globalStore.set(historyFiltersAtom, { author: "dana", path: "", text: "" });
        globalStore.set(historyScrollAtom, 300);
        globalStore.set(selectedCommitAtom, "bbb");
        globalStore.set(restoreNoticeAtom, "Back where you left off: commit bbb.");
        gitHistory.mockResolvedValueOnce({ isrepo: true, head: "aaa", commits: [commit("aaa", "one"), commit("bbb", "two")] });
        startFromTop();
        await vi.waitFor(() => expect(globalStore.get(selectedCommitAtom)).toBe("aaa"));
        expect(globalStore.get(historyFiltersAtom)).toEqual(NO_FILTERS);
        expect(globalStore.get(historyScrollAtom)).toBe(0);
        expect(globalStore.get(restoreNoticeAtom)).toBeNull();
    });
});
```
(`vi.useFakeTimers({ toFake: ["Date"] })` before `setSystemTime` in the retry case; adapt `filesStateAtom` setup to how the file's other tests seed a cwd — `startFromTop` reloads via `filesStateAtom.cwd`, and a clean tree with no changes makes `aaa` the default selection.) Run
`npx vitest run frontend/app/view/agents/historyrows.test.ts frontend/app/view/agents/historyquery.test.ts frontend/app/view/agents/githistorystore.test.ts` — expect failures.

- [ ] **Step 2: Implement the models.**
  - `historyrows.ts`: add `fileCount?: number` to `HistoryRow` (comment: only the synthetic top row has one). In `buildRows` the synthetic row's `subject` becomes `opts.rowLabel ?? "Uncommitted changes"` and `fileCount: opts.dirtyFileCount`. Add:

```ts
// The working-tree pane's one-line answer to "measured from what". HEAD is not a branch, so a
// detached checkout says so rather than printing "On HEAD".
export function worktreeCaption(range: DiffRange, branch: string, head: string, ref: string): string {
    const on = branch && branch !== "HEAD" ? `On ${branch}` : "Detached HEAD";
    switch (range.kind) {
        case "session":
            return `${on}, measured from session start ${ref.slice(0, 7)}`;
        case "run":
            return `${on}, measured from run base ${range.baseCommit.slice(0, 7)}`;
        default:
            return `${on}, measured from ${head.slice(0, 7)}`;
    }
}
```
  (import `type DiffRange` from `./diffscope`; that file imports only types from here, so no cycle at runtime).
  - `historyquery.ts`: `export const SLOW_HISTORY_MS = 10_000;` and

```ts
export function slowSeconds(startedAt: number | null, now: number): number | null {
    if (startedAt == null || now - startedAt < SLOW_HISTORY_MS) {
        return null;
    }
    return Math.floor((now - startedAt) / 1000);
}

// The empty list's second line: the filters read back as a sentence, so a typo in one is visible.
export function noMatchSentence(f: HistoryFilters): string {
    const author = filled(f.author);
    const text = filled(f.text);
    const path = filled(f.path);
    const verbs = [text ? `mentions “${text}”` : "", path ? `touches ${path}` : ""].filter(Boolean);
    return `No commit${author ? ` by ${author}` : ""}${verbs.length ? ` ${verbs.join(" and ")}` : ""}.`;
}
```
  and in `restoreNotice` change the parts to `commit ${hash7}`, `"your scroll position"`, `plural(n, "filter", "filters")`, and the return to ``Back where you left off: ${list}.`` (no capitalisation step).
  - `githistorystore.ts`: `export const historyLoadStartedAtom = atom<number | null>(null) as PrimitiveAtom<number | null>;`. In `loadHistory`, after the `sameSubject` block, `if (globalStore.get(historyCommitsAtom) == null) globalStore.set(historyLoadStartedAtom, Date.now());`. Clear it (`set(..., null)`) wherever this token's read settles: after the `isrepo`/`failure`/success branches and in the catch — only when `current.token === token`. Also clear it in `resetHistory`. Add:

```ts
// The restore banner's way out: the defaults the surface would have opened with. Selection goes
// null first so the reload's settleSelection picks row zero instead of keeping the remembered row.
export function startFromTop(): void {
    globalStore.set(selectedCommitAtom, null);
    globalStore.set(selectedFileAtom, null);
    dismissRestoreNotice();
    clearHistoryFilters();
}
```
  (`clearHistoryFilters` already zeroes scroll through `reloadFirstPage`.) Run the Step 1 command — pass.

- [ ] **Step 3: Components** (Main / WorkingTree / Compact / Controls §4 / Panels §1 boards).
  - `historypane.tsx`:
    - Header row (`px-[14px] pt-[10px] pb-[8px]`): `HISTORY` eyebrow; the count label (`countLabel` prop) — when `filtered`, render it `text-accent-soft font-semibold` with `data-filter-count`; spacer; when `filtered` a "Clear filters" button with a faint `esc` kbd (`clearHistoryFilters`); the Graph toggle moved from `historyfilterrow.tsx` (lucide `GitGraph` icon + "Graph" + faint `⇧G`, same on/off classes it has today); when `onCollapse` is given, an icon button (lucide `PanelLeftClose`, `title="Collapse history"`). Keep the "N lanes · M folded" chip.
    - Directly under the header render `<HistoryFilterRow />`.
    - Row: when `row.workingTree`, the hash cell renders a 10px dotted ring (`rounded-full border border-dashed border-warning`) instead of text, and the author cell renders `${row.fileCount} ${fileCount === 1 ? "file" : "files"}` (`text-ink-faint text-[11px]`). Delete `shortHash`'s "·······" branch. Keep `indent = graphOn ? geom.gutter : NO_GRAPH_PAD` (spec defect e).
    - Slow notice: read `historyLoadStartedAtom`; while `loading`, tick a 1s `setInterval` in an effect (cleared on unmount / when not loading) and compute `slowSeconds(started, Date.now())`. When non-null, render above the skeleton a card (`mx-[12px] mb-[8px] rounded-[9px] border border-edge-mid bg-surface px-[12px] py-[9px]`): lucide `Clock` in `text-warning`, "Still reading history" (`font-semibold text-ink-hi`), "git log has been running for {n}s" (mono, faint), and a Retry button calling `retryHistory()`.
    - Empty filtered list: replace the one-liner with a centred block — "No commits match" (`font-semibold text-ink-hi`), `noMatchSentence(filters)` (`text-ink-mid`; read `historyFiltersAtom`), a "Clear filters" button. Unfiltered empty keeps "No commits".
  - `historyfilterrow.tsx`: remove the Graph toggle and the summary/"Clear all" block (and their imports); row becomes `flex gap-[8px] px-[12px] pb-[10px]` inside the column; the message field is `flex-1 min-w-0` with placeholder "Filter by message"; chips unchanged apart from placeholder "any" on path. Update the header comment to say the header now owns Graph and Clear.
  - `historyrail.tsx`: keep the expand button (`title="Expand history"`) but render lucide `PanelLeftOpen`; rows become a centred vertical `bg-graphlane-1/40` 2px line with one 8px dot per row (`bg-graphlane-1`; working tree a dashed `border-warning` ring; selected row adds `ring-2 ring-accent/40` and `bg-surface-selected`), `title={r.subject}`, same `ROW_H`. No hash text.
  - `commitpane.tsx`:
    - Commit: first line `flex items-center gap-[8px]` — hash chip (existing classes), a copy icon button (lucide `Copy`, `title="Copy hash"`, `onClick={() => fireAndForget(() => navigator.clipboard.writeText(row.hash))}`), spacer, `formatAgo(Date.now() - row.ts)` faint mono (check `row.ts` units against `toRow`/`ageLabel` — use the same arithmetic `ageLabel` uses). Then subject, then avatar + author, then refs on their own `flex flex-wrap gap-[6px]` line (only when there are refs).
    - Working tree (`row.hash === WORKING_TREE`): eyebrow with a small dashed ring + "WORKING TREE" (`text-warning` mono 9px uppercase), title `row.subject`, then `caption` prop in `text-ink-mid text-[12px]` when given.

- [ ] **Step 4: Verify** — `npx vitest run frontend/app/view/agents`, then Check (5-minute timeout). Clean.

- [ ] **Step 5: Commit** — `feat(diff): put the history's controls in its own column and say what the working tree is`.

### Task 4: Compare column, aggregate pane, ref pair chip
**Depends on:** Task 1

**Files:**
- Modify: `frontend/app/view/agents/comparerows.ts`, `comparerows.test.ts`
- Modify: `frontend/app/view/agents/comparestore.ts` (+ `comparestore.test.ts` if it asserts `CompareSides`)
- Modify: `frontend/app/view/agents/comparecolumn.tsx`, `aggregatepane.tsx`, `refpicker.tsx`

**Interfaces:**
- Consumes: `CommandGitDivergenceRtnData.mergebasets` (Task 1).
- Produces: `CompareSides.mergeBaseTs: number`; `CompareColumn` optional prop `onCollapse?: () => void`; `AggregatePane` optional prop `mergeBase?: string` (default `""`; optional because only Task 7 edits `filessurface.tsx`, which passes `compareSides?.mergeBase ?? ""`); `formSentence`, `splitLabel`; the ref chip carries `data-ref-pair`.

- [ ] **Step 1: Failing tests** — append to `comparerows.test.ts`:

```ts
import { formSentence, splitLabel } from "./comparerows";

describe("the aggregate row", () => {
    it("reads All changes", () => {
        const rows = buildCompareRows({ base: "main", head: "x", ahead: [], behind: [], aggregate: null, now: 0 });
        expect(rows[0]).toMatchObject({ kind: "aggregate", label: "All changes" });
    });
});

describe("formSentence", () => {
    it("says what the merge-base form leaves out", () => {
        expect(formSentence("mergebase", "main", "exp-native", "7a4155cdead")).toBe(
            "Only what exp-native added since the two split at 7a4155c. Commits main gained since are left out."
        );
    });
    it("says what tip to tip includes", () => {
        expect(formSentence("tips", "main", "exp-native", "7a4155cdead")).toBe(
            "Everything that differs between the two tips, including what main gained since the split."
        );
    });
    it("does not print an empty hash when there is no merge base", () => {
        expect(formSentence("mergebase", "main", "x", "")).toBe(
            "Only what x added since the two split. Commits main gained since are left out."
        );
    });
});

describe("splitLabel", () => {
    const DAY = 86_400_000;
    it("names the merge base and how long ago it was", () => {
        expect(splitLabel("7a4155cdead", 1_000, 1_000 + 7 * DAY)).toBe("split at 7a4155c · 7d ago");
    });
    it("omits the age it does not know", () => {
        expect(splitLabel("7a4155cdead", 0, 5 * DAY)).toBe("split at 7a4155c");
    });
    it("is empty without a merge base", () => {
        expect(splitLabel("", 0, 0)).toBe("");
    });
});
```
Run `npx vitest run frontend/app/view/agents/comparerows.test.ts` — fail.

- [ ] **Step 2: Implement** in `comparerows.ts` (import `formatAgo` from `./agentsviewmodel` and `type CompareForm` from `./diffcontent`):
  - `CompareAggregateRow` gains `label: "All changes"`; `buildCompareRows` sets it.

```ts
// The aggregate pane's sentence for each range form, so the switch is never a bare "..." vs "..".
export function formSentence(form: CompareForm, base: string, head: string, mergeBase: string): string {
    if (form === "tips") {
        return `Everything that differs between the two tips, including what ${base} gained since the split.`;
    }
    const at = mergeBase ? ` at ${mergeBase.slice(0, 7)}` : "";
    return `Only what ${head} added since the two split${at}. Commits ${base} gained since are left out.`;
}

// mergeBaseTs is unix ms (gitinfo.Divergence, the unit HistoryCommit.ts uses); 0 = unknown, and an
// unknown age is left out rather than guessed.
export function splitLabel(mergeBase: string, mergeBaseTs: number, now: number): string {
    if (!mergeBase) {
        return "";
    }
    const at = `split at ${mergeBase.slice(0, 7)}`;
    return mergeBaseTs > 0 ? `${at} · ${formatAgo(now - mergeBaseTs)}` : at;
}
```
  - `comparestore.ts`: `CompareSides.mergeBaseTs: number`, set from `div.mergebasets ?? 0`. Fix any test fixture that builds a `CompareSides`.
  Run the Step 1 command — pass.

- [ ] **Step 3: Components** (Compare board).
  - `comparecolumn.tsx`: header = `COMPARE` eyebrow + `splitLabel(mergeBase, mergeBaseTs, Date.now())` (faint mono) + spacer + collapse icon button when `onCollapse` given (lucide `PanelLeftClose`, `title="Collapse history"`). Add prop `mergeBaseTs?: number` (default 0). Aggregate row renders `row.label` (`text-[12.5px] font-semibold text-ink-hi`, full-width selected fill) with files and +/− on the right. Group header: side dot, ref (`SIDE_TEXT`), note ("6 ahead") in `text-muted`; drop the count badge. Commit row: side dot, hash, subject, `row.when` right-aligned (replaces the author). Delete the merge-base footer card. Keep `data-compare-column` and the "These refs do not diverge." line.
  - `aggregatepane.tsx`: `base → head` line as today; replace the two chips with a full-width two-segment control (`rounded-[9px] border border-edge-mid`, segments `flex-1 h-[28px]`, active `bg-surface-selected text-ink-hi`, inactive `text-muted`): "Since the split" + faint "···", "Tip to tip" + faint "··"; below it `formSentence(form, base, head, mergeBase)` in `text-[12px] leading-[1.5] text-ink-mid`. Add optional `mergeBase?: string` prop.
  - `refpicker.tsx`: the non-editing state becomes one chip button with `data-ref-pair` — `● base … ● head` (dots `SIDE_DOT`, names `SIDE_TEXT`, faint "…") + lucide `ChevronDown` — in `rounded-[9px] border border-accent/30 bg-accentbg px-[10px] py-[6px]`, followed by a divider and the swap button (lucide `ArrowLeftRight`, `title="Swap base and head (⇧S)"`). The editing form is unchanged apart from sharing the chip's border classes.

- [ ] **Step 4: Verify** — `npx vitest run frontend/app/view/agents`, then Check. Clean.

- [ ] **Step 5: Commit** — `feat(diff): say where the compared refs split and what each range form includes`.

### Task 5: Source picker filter and worktree annotation
**Depends on:** none

**Files:**
- Modify: `frontend/app/view/agents/diffsource.ts`, `diffsource.test.ts` (append)
- Modify: `frontend/app/view/agents/sourcepicker.tsx`

**Interfaces:**
- Produces: `filterSources`, `worktreeParent`. `SourcePicker` props unchanged.

- [ ] **Step 1: Failing tests** — append to `diffsource.test.ts`:

```ts
import { filterSources, worktreeParent } from "./diffsource";

describe("filterSources", () => {
    const agents = [{ name: "verify-runs" }, { name: "Radar" }];
    const projects = [{ name: "waveterm" }, { name: "exp-native" }];
    it("matches either list, case-insensitively", () => {
        expect(filterSources("RA", agents, projects)).toEqual({ agents: [{ name: "Radar" }], projects: [] });
        expect(filterSources("nat", agents, projects)).toEqual({ agents: [], projects: [{ name: "exp-native" }] });
    });
    it("returns everything for a blank query", () => {
        expect(filterSources("  ", agents, projects)).toEqual({ agents, projects });
    });
});

describe("worktreeParent", () => {
    const projects = [
        { name: "waveterm", path: "C:\\Users\\k\\IdeaProjects\\waveterm" },
        { name: "exp-native", path: "c:/users/k/ideaprojects/waveterm/.worktrees/exp-native" },
        { name: "waveterm2", path: "C:/Users/k/IdeaProjects/waveterm2" },
    ];
    it("finds the project whose path contains this one, across separators and case", () => {
        expect(worktreeParent(projects[1], projects)).toBe("waveterm");
    });
    it("does not treat a sibling that shares a prefix as a parent", () => {
        expect(worktreeParent(projects[2], projects)).toBeNull();
    });
    it("is null for a top-level project", () => {
        expect(worktreeParent(projects[0], projects)).toBeNull();
    });
});
```
Run `npx vitest run frontend/app/view/agents/diffsource.test.ts` — fail.

- [ ] **Step 2: Implement** in `diffsource.ts` (import `normalizeRepoPath` from `@/util/paths`):

```ts
export function filterSources<A extends { name: string }, P extends { name: string }>(
    query: string,
    agents: A[],
    projects: P[]
): { agents: A[]; projects: P[] } {
    const q = query.trim().toLowerCase();
    if (!q) {
        return { agents, projects };
    }
    const hit = (n: { name: string }) => n.name.toLowerCase().includes(q);
    return { agents: agents.filter(hit), projects: projects.filter(hit) };
}

// A registered project inside another registered project is a worktree of it (the repo's
// .worktrees/ convention); the picker names the parent so two "waveterm"s are told apart. The
// longest containing path wins, and "/" is required after it so waveterm2 is not waveterm's child.
export function worktreeParent<P extends { name: string; path: string }>(project: P, projects: P[]): string | null {
    const own = normalizeRepoPath(project.path);
    let best: P | null = null;
    for (const p of projects) {
        const other = normalizeRepoPath(p.path);
        if (p === project || !other || !own.startsWith(other + "/")) {
            continue;
        }
        if (best == null || other.length > normalizeRepoPath(best.path).length) {
            best = p;
        }
    }
    return best?.name ?? null;
}
```
Run — pass.

- [ ] **Step 3: Component** (Controls board "Source picker, open"). In `sourcepicker.tsx`: trigger gets a lucide `Folder` glyph for projects (status dot for agents) and a `ChevronDown`; the popover opens with an autofocused filter field (lucide `Search`, placeholder "Filter agents and projects", `query` in component state, cleared on close; Escape in it closes the popover) and renders `filterSources(query, agents, projects)`; agent rows show `a.state` as faint right-aligned text; project rows show `worktree · {parent}` faint right-aligned when `worktreeParent(p, projects)` is non-null; the current source shows a lucide `Check` in `text-accent`. Keep `data-files-source-picker` and `data-files-source-option`. When the filter matches nothing, show "No match" in faint text.

- [ ] **Step 4: Verify** — `npx vitest run frontend/app/view/agents`, then Check. Clean.

- [ ] **Step 5: Commit** — `feat(diff): filter the source picker and name a worktree's parent`.

### Task 6: Keys and footer
**Depends on:** none

**Files:**
- Modify: `frontend/app/store/keybindings/bindings.ts` (`buildFilesBindings`), `bindings.test.ts`
- Modify: `frontend/app/cockpit/footerhints.ts` (`files`)
- Modify: `docs/keyboard-shortcuts.md` (Diff section)

**Interfaces:**
- Consumes: the `[data-ref-pair]` chip (Task 4) — the binding declines the key when it is absent, so this task does not wait for it.

- [ ] **Step 1: Failing tests** — in `bindings.test.ts`'s files `describe` (it has `find` and a `ctx`):

```ts
it("c enters compare from history and changes the refs inside compare", () => {
    expect(find("files:compare").when?.(ctx)).toBe(true);
    expect(find("files:change-refs").when?.(ctx)).toBe(false);
    globalStore.set(diffScopeAtom, {
        repo: { origin: { kind: "project", name: "p", path: "C:/p" }, label: "p" },
        range: { kind: "compare", base: "main", head: "x", form: "mergebase", from: { kind: "working" } },
    });
    expect(find("files:compare").when?.(ctx)).toBe(false);
    expect(find("files:change-refs").when?.(ctx)).toBe(true);
    expect(find("files:change-refs").keys).toBe("c");
});

it("change-refs declines the key when no ref chip is on screen", () => {
    globalStore.set(diffScopeAtom, {
        repo: { origin: { kind: "project", name: "p", path: "C:/p" }, label: "p" },
        range: { kind: "compare", base: "main", head: "x", form: "mergebase", from: { kind: "working" } },
    });
    vi.stubGlobal("document", { querySelector: () => null });
    expect(find("files:change-refs").run(ctx)).toBe(false);
    vi.unstubAllGlobals();
});
```
(match the scope literal to the one the file's existing compare test uses). Run
`npx vitest run frontend/app/store/keybindings` — fail.

- [ ] **Step 2: Implement.** In `buildFilesBindings`: `files:compare`'s `when` becomes `inHistory`; add after it

```ts
{
    // same key, second meaning: inside compare, c reopens the ref pair rather than re-entering
    id: "files:change-refs",
    keys: "c",
    group: "Diff",
    label: "Change compare refs",
    when: inCompare,
    run: () => {
        const el = document.querySelector<HTMLElement>("[data-ref-pair]");
        if (el == null) {
            return false;
        }
        el.click();
    },
},
```
In `footerhints.ts` replace the `files` list with:

```ts
files: [
    { ids: ["files:filter"], glyph: "/", label: "filter" },
    { ids: ["files:toggle-graph"], glyph: "⇧G", label: "graph" },
    { ids: ["files:change-refs"], glyph: "c", label: "change refs" }, // compare-only via its binding
    { ids: ["files:swap-refs"], glyph: "⇧S", label: "swap" }, // compare-only via its binding
    { ids: ["files:next-change", "files:prev-change"], glyph: "⇧N ⇧P", label: "next / prev change" },
    { ids: ["files:toggle-history"], glyph: "⇧H", label: "history" },
    { ids: ["files:compare"], glyph: "c", label: "compare" }, // history-only via its binding
    { ids: ["files:refresh"], glyph: "r", label: "refresh" },
    { ids: ["files:switch-side"], glyph: "⇥", label: "side" }, // compare-only via its binding
    { ids: ["files:clear-filters"], glyph: "esc", label: "clear filters" }, // filtered-only via its binding
    { ids: ["files:exit-compare"], glyph: "esc", label: "leave compare" }, // compare-only via its binding
],
```
Add a one-line comment above it: ↑↓, ⏎ and `g g` left the footer for room; they still work and are in `?` help. Update `docs/keyboard-shortcuts.md`'s Diff rows: add `c` (in compare) "Change compare refs", and make sure ⇧N/⇧P/⇧H/⇧G/⇧W/⇧D/⇧S are all listed.

- [ ] **Step 3: Verify** — `npx vitest run frontend/app/store/keybindings frontend/app/cockpit` (this includes `assertNoConflicts` and any footer tests; fix a footer test that pinned the old list), then Check. Clean.

- [ ] **Step 4: Commit** — `feat(diff): surface the Diff keys in the footer and give c a meaning in compare`.

### Task 7: Surface shell — subject row, summary, banners, takeovers, wiring
**Depends on:** Task 2, Task 3, Task 4, Task 5

**Files:**
- Modify: `frontend/app/view/agents/diffscope.ts` (`SummaryInput`, `summaryLine`, `rangeSummary`), `diffscope.test.ts`
- Modify: `frontend/app/view/agents/gitstatepanels.tsx`
- Modify: `frontend/app/view/agents/rangestrip.tsx` (the `c` hint)
- Modify: `frontend/app/view/agents/filessurface.tsx`
- Modify: `scripts/cdp/scenarios.mjs` (git-history step 3 only, plus any selector this task moves)

**Interfaces:**
- Consumes: `DiffPane.nothingToCompare` (T2); `HistoryPane.onCollapse`, `CommitPane.caption`, `worktreeCaption`, `startFromTop` (T3); `CompareColumn.onCollapse/mergeBaseTs`, `AggregatePane.mergeBase`, `CompareSides.mergeBaseTs` (T4).

- [ ] **Step 1: Failing tests** — in `diffscope.test.ts`, replace the `summaryLine`/`rangeSummary` cases with:

```ts
const ch = (n: number, adds = 10, dels = 2) => ({ files: Array.from({ length: n }, (_, i) => ({ path: `f${i}`, status: "M", adds: 1, dels: 0 })), adds, dels }) as any;
const base = { branch: "main", ref: "", mergeBase: "", commit: null as string | null };

describe("summaryLine follows what the panes show", () => {
    it("counts uncommitted files on the branch, against HEAD", () => {
        expect(summaryLine({ ...base, range: { kind: "working" }, changes: ch(15, 661, 403) })).toBe(
            "15 uncommitted files on main · +661 −403"
        );
    });
    it("says against HEAD when detached", () => {
        expect(summaryLine({ ...base, branch: "", range: { kind: "working" }, changes: ch(1) })).toBe(
            "1 uncommitted file against HEAD · +10 −2"
        );
        expect(summaryLine({ ...base, branch: "HEAD", range: { kind: "working" }, changes: ch(1) })).toBe(
            "1 uncommitted file against HEAD · +10 −2"
        );
    });
    it("describes a selected commit, not the range", () => {
        expect(summaryLine({ ...base, commit: "3eaffac99", range: { kind: "working" }, changes: ch(1, 2, 2) })).toBe(
            "3eaffac · 1 file · +2 −2"
        );
    });
    it("reads the merge-base comparison from the head's side", () => {
        const range = { kind: "compare", base: "main", head: "exp-native", form: "mergebase", from: { kind: "working" } } as const;
        expect(summaryLine({ ...base, mergeBase: "7a4155cff", range, changes: ch(31, 764, 88) })).toBe(
            "exp-native since 7a4155c · 31 files · +764 −88"
        );
    });
    it("reads tip to tip as both refs", () => {
        const range = { kind: "compare", base: "main", head: "x", form: "tips", from: { kind: "working" } } as const;
        expect(summaryLine({ ...base, range, changes: ch(2) })).toBe("main .. x tip to tip · 2 files · +10 −2");
    });
    it("keeps the run and session phrasing for their top rows", () => {
        expect(summaryLine({ ...base, range: { kind: "run", runId: "r", baseCommit: "b41d000aa" }, changes: ch(3) })).toBe(
            "b41d000 … HEAD · 3 files · +10 −2"
        );
        expect(summaryLine({ ...base, ref: "9f2c1de00", range: { kind: "session", agentId: "a" }, changes: ch(3) })).toBe(
            "worktree against 9f2c1de · 3 files · +10 −2"
        );
    });
});
```
Run `npx vitest run frontend/app/view/agents/diffscope.test.ts` — fail.

- [ ] **Step 2: Implement** — replace `SummaryFacts`/`rangeSummary`/`SummaryInput`/`summaryLine` in `diffscope.ts` with:

```ts
// What the surface has on hand when it captions the panes. `changes` is the list pane 2 is showing
// (history's or compare's), and `commit` is the selected commit's hash — null when the scope's own
// row (the working tree, or compare's All changes) is selected.
export interface SummaryInput {
    range: DiffRange;
    branch: string;
    ref: string;
    mergeBase: string;
    commit: string | null;
    changes: GitChanges | null;
}

// The subject row's right-hand caption. It follows the selection: a caption that kept describing the
// range while a commit's panes showed one file is the contradiction this replaced.
export function summaryLine(i: SummaryInput): string {
    const n = i.changes?.files.length ?? 0;
    const files = `${n} ${n === 1 ? "file" : "files"}`;
    const delta = `+${i.changes?.adds ?? 0} −${i.changes?.dels ?? 0}`;
    const counts = `${files} · ${delta}`;
    if (i.commit != null) {
        return `${shortSha(i.commit)} · ${counts}`;
    }
    switch (i.range.kind) {
        case "compare":
            if (i.range.form === "tips") {
                return `${i.range.base} .. ${i.range.head} tip to tip · ${counts}`;
            }
            return i.mergeBase
                ? `${i.range.head} since ${shortSha(i.mergeBase)} · ${counts}`
                : `${i.range.base} … ${i.range.head} · ${counts}`;
        case "run":
            return `${shortSha(i.range.baseCommit)} … HEAD · ${counts}`;
        case "session":
            return `worktree against ${shortSha(i.ref)} · ${counts}`;
        case "working": {
            // measured against HEAD, whatever branch that is — never "against main"
            const where = i.branch && i.branch !== "HEAD" ? `on ${i.branch}` : "against HEAD";
            return `${n} uncommitted ${n === 1 ? "file" : "files"} ${where} · ${delta}`;
        }
    }
}
```
Grep for other callers of `rangeSummary`/`SummaryFacts` (`grep -rn "rangeSummary\|SummaryFacts" frontend`) and migrate them. Run — pass.

- [ ] **Step 3: `gitstatepanels.tsx`** (Panels board §2-3).
  - Add `SurfaceBanner({ tone, icon, children, action, onDismiss })`: `mx-[18px] mb-[10px] flex items-center gap-[10px] rounded-[9px] border px-[12px] py-[8px]`; `tone="error"` → `border-error/25 bg-error/12`, `neutral` → `border-edge-mid bg-surface`; `action?: { label: string; onClick: () => void }` rendered as a bordered button; dismiss ✕ (lucide `X`, `title="Dismiss"`).
  - `GitFailureNotice` becomes a `SurfaceBanner` tone error with lucide `CircleAlert`: "Fetch failed" (`font-semibold text-error`), "· showing refs as of the last fetch" (`text-ink-mid`), then stderr (or the exit-code fallback) in faint mono, truncating; action Retry → new prop `onRetry`. Keep `data-git-failure-notice`.
  - `NotARepoPanel({ path, onChooseSource })`: lucide `Folder`, "This folder isn’t a Git repository", `path` in faint mono, "There’s no history to show here. Pick another agent or project.", button "Choose a source". Keep `data-not-a-repo`.
  - `GitFailurePanel`: lucide `CircleAlert` (error), "Couldn’t read this repository" (`text-ink-hi`), "Git stopped with an error. Nothing was changed, so retrying is safe.", the command block with the exit chip plus a copy icon button (copies `command + "\n\n" + stderr` via `navigator.clipboard.writeText` in `fireAndForget`), and Retry as the primary button (`rounded-[7px] bg-accent px-[14px] py-[6px] text-[12px] font-semibold text-background hover:bg-accenthover`, the primary style `surfacescaffold.tsx` uses). Keep `data-git-failure` and `data-git-failure-retry`.

- [ ] **Step 4: `rangestrip.tsx`** — the compare chip appends a faint mono `c` kbd (`text-[9.5px] text-ink-faint`) after its label.

- [ ] **Step 5: `filessurface.tsx`** (Main / Compact / WorkingTree / Compare boards).
  - Subject row: `Diff`, source picker wrapper (drop its own border — the picker draws it now), `RangeStrip`, then in compare `RefPicker` and the Fetch group: a labelled button — lucide `RefreshCw` (spinning while `fetchState.running`) + "Fetch" / "Fetching…", `title="Update remote-tracking refs"` — plus "fetched Xm ago" as today. Then `<div className="flex-1" />` and the summary span (`data-files-range-summary`, `min-w-0 truncate font-mono text-[11.5px] text-ink-faint`, +/− coloured via splitting is not required — plain text is fine) rendered from
    `summaryLine({ range: scope.range, branch: state?.branch ?? "", ref: state?.ref ?? "", mergeBase: compareSides?.mergeBase ?? "", commit: compareOn ? (compareSelection === AGGREGATE ? null : compareSelection) : (selectedCommit === WORKING_TREE ? null : selectedCommit), changes: shownChanges })`.
    Delete the second summary line. Keep `flex-wrap` and its comment.
  - Banners: the restore notice becomes `<SurfaceBanner tone="neutral" icon={<RotateCcw/>} action={{ label: "Start from the top", onClick: startFromTop }} onDismiss={dismissRestoreNotice}>` with `restoreMsg`; keep `data-restore-notice`. `GitFailureNotice` gets `onRetry={() => state?.cwd && fireAndForget(() => runFetch(state.cwd!))}`.
  - Delete the top-level `<HistoryFilterRow />` render and its import, and the `‹` collapse strip. Pass `onCollapse={() => globalStore.set(historyCollapsedAtom, true)}` to both `HistoryPane` and `CompareColumn`; pass `mergeBaseTs={compareSides?.mergeBaseTs ?? 0}` to `CompareColumn` and `mergeBase={compareSides?.mergeBase ?? ""}` to `AggregatePane`.
  - `CommitPane` (history branch): `caption={scope && state ? worktreeCaption(scope.range, state.branch, state.head, state.ref) : undefined}`.
  - `NotARepoPanel path={state.cwd} onChooseSource={() => document.querySelector<HTMLElement>("[data-files-source-picker]")?.click()}`.
  - `DiffPane nothingToCompare={compareOn && compareSelection === AGGREGATE && compareChanges != null && compareChanges.files.length === 0 ? { base: compareRefs?.base ?? "", head: compareRefs?.head ?? "" } : null}`.
  - Remove imports that became unused.

- [ ] **Step 6: CDP scenario** — in `scripts/cdp/scenarios.mjs` git-history step 3, change `countChip.includes("1 filter")` to `countChip.includes("matching")` and its label to "…states the matching count…". Do not run prettier on this file.

- [ ] **Step 7: Verify**
  - `npx vitest run` and the Check command (5-minute timeout) — clean.
  - If the dev app is available (`curl -s localhost:9222/json` answers), run
    `task verify:ui -- surface-smoke git-history diff-compare code-diff` and report the table verbatim.
    If it is not, say so in the completion report rather than claiming CDP passed. Never kill
    `wave-tauri.exe`/`wavesrv.x64.exe` by image name (AGENTS.md).
  - Screenshot at 1600x950 and 1000x700 with `node scripts/cdp-shot.mjs` and compare against the
    Main and Compact boards; note any visible deviation in the completion report.

- [ ] **Step 8: Commit** — `feat(diff): one subject row whose caption follows the selection`.
