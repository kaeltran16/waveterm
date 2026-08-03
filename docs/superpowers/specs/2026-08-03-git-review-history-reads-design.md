# History reads for the Diff surface — filters, pagination, failure panels, persistence

**Date:** 2026-08-03
**Status:** design approved, no plan written yet
**Design source:** `wave-handoff/wave/project/Wave-git-review.dc.html` — the `filtered` state (filter-row markup at lines 166–190, design notes at line 950), `notrepo` (line 897), `failed` (lines 902, 970), `loading` (line 976), `restored` (lines 880, 980). The brief is `docs/superpowers/briefs/2026-07-31-git-review-ui-design-brief.md`.

## Why

Three plans have shipped the Diff surface's history: the read path and lane maths (`010fa7e9`), the three-pane restructure that made uncommitted work row zero (`a7c7c6cd`, with the scope-persistence fix `f8044bd4`), and branch comparison (`cea7ec8a`). What they left is the part that makes a long history usable rather than merely visible: you cannot narrow it, you only ever see the first page, a failed read is indistinguishable from an unreadable one, and leaving the surface loses your place.

Two of those are nearly free and have been sitting unused since the first plan. `HistoryLog` (`pkg/gitinfo/gitinfo.go:518`) already accepts `Author`, `Grep`, `Path`, `Skip` and `Limit` and forwards all five to `git log`; the RPC payload `CommandGitHistoryData` (`pkg/wshrpc/wshrpctypes_git.go`) already carries them; the frontend store calls the command with `{ cwd }` and nothing else (`githistorystore.ts:70`). Filtering and pagination are wiring, not new capability.

The third — telling "this is not a repository" apart from "the read failed" — needs a small backend change, because the failure detail is currently destroyed twice over. See decision 5.

## What already exists — do not rebuild it

| Piece | Where | State |
|---|---|---|
| Filterable, paginated history walk | `gitinfo.HistoryLog`, `GitHistoryCommand` | Shipped `010fa7e9`, including `TestHistoryLogPaginates` and `TestHistoryLogFiltersByAuthorAndPath`. **No caller passes any option.** This spec adds the first one. |
| Row derivation: ref chips, relative time, the synthetic uncommitted row, the scope-anchor divider, default selection | `historyrows.ts` (pure, 13 vitest cases) | Shipped `a7c7c6cd`. Reused unchanged except for one added selection helper (see §3). |
| Lane assignment and SVG geometry | `gitgraph.ts`, `gitgraphgeom.ts`, `graphgutter.tsx` | Shipped. Untouched; the gutter is *suppressed* while filtering (decision 4), not modified. |
| The graph on/off state and its button | `graphOnAtom` in `githistorystore.ts`; button at `filessurface.tsx:545-553` | Shipped. This spec adds the keyboard route to it and moves the button into the filter row. |
| Module-level atoms surviving surface unmount | `githistorystore.ts` | Shipped. The pattern this spec extends for scroll offset and filters. |
| Skeleton while loading | `HistorySkeleton` in `historypane.tsx:30-43` | Shipped. Reused for the first page; the appended-page footer is new. |
| Stderr-preserving git invocation | `runErr` in `pkg/gitinfo/gitinfo.go` | Exists, used by the revert path. **Must not be reused here:** it captures with `CombinedOutput`, which would fold stderr into the very stdout `parseHistory` parses. Decision 5 gets stderr *and* the exit code without changing how git is run. |

## Resolved decisions

**1. Scope is the read surface only.** In: the filter row, pagination, the two repository-failure panels, scroll-offset persistence with its banner, and the keys for all of it, plus one repeatable verification scenario. Excluded, each getting its own spec: the Fetch control and freshness clock (the only repo mutation the brief permits, and a new RPC), commit provenance — the mockup's "Produced by Run #148" (a new backend join from `Run` objects to commit hashes), and the Unified/Split diff toggle with its desaturated diff-text tints (a second diff renderer). Nothing here needs a mutation or a cross-object join, which is what makes it one coherent slice.

**2. Narrow-window folding and row density are dropped, not postponed.** The mockup folds the commit pane to a chip below ~1100px, drops the author column, folds the graph to three lanes, and turns history into a drawer below 900px; it also exposes comfortable 34px versus compact 28px rows. Both are declined: the cockpit runs at roughly 1600×950, so every breakpoint would be an untested path that rots, and `historypane.tsx` keeping its single `ROW_H = 34` costs nothing. Recorded in `docs/deferred.md` as design-declared and deliberately unbuilt, so the omission is a decision on the record rather than an oversight.

**3. Filtering happens server-side, and there is exactly one filter mechanism.** Each filter change re-issues `GitHistoryCommand` with `Author` / `Grep` / `Path`, debounced, resetting to the first page. The tempting alternative — load a big page once and filter in the browser — cannot answer the path filter at all, because a commit record carries no file list; only `git log -- <path>` knows. Splitting filters across two mechanisms (two in the client, one on the server) would be worse than one round trip per settled keystroke.

*Consequence:* while a filter is active the synthetic uncommitted row is suppressed. It is not a commit, so it cannot satisfy an author, path or text filter, and leaving it pinned at the top of a filtered list would misrepresent the result. The store passes a dirty-file count of zero while filtering; `historyrows.ts` already omits the row on a clean tree, so the pure module needs no change.

**4. The graph gutter hides while a filter is active.** The mockup's own note says a filtered graph is a list. The mechanical reason is stronger: a filtered set mostly lacks its own parents, and `assignLanes` reserves a lane for every unresolved parent, so lanes would sprawl to the fold limit and draw edges to nothing. Suppressing the gutter is one boolean at the call site, not a change to either graph module. The Graph button and its `G` key stay live and their state is remembered, so clearing the filter brings the graph back as you left it.

**5. A failed git read is a *successful* RPC carrying a described failure, not an RPC error.** Today the detail is destroyed twice. The package-local `run()` helper uses `cmd.Output()` and returns the bare `*exec.ExitError`, whose message is `exit status 128` with no stderr; then `loadHistory`'s `catch {}` discards even that and sets a bare boolean `historyErrorAtom`, which the surface renders as a one-line banner reading "Couldn't read this repository" (`filessurface.tsx:557`). That banner is exactly the failure mode the design brief calls out — a failed call masquerading as an unreadable repository.

The fix is small and additive. `cmd.Output()` already populates `ExitError.Stderr`, so **nothing about how git is invoked changes**: a new helper reads the exit code and stderr off the error that `run()` already returns. `HistoryLog` catches a failed log invocation and returns a populated `History` whose new `Failure` field describes it. The response then says one of three things unambiguously — not a repository (`isrepo: false`), read failed (`failure` populated), or here are your commits. Returning an RPC error instead would force the frontend to reconstruct fields by parsing an error string, which is fragile and would lose the exit code entirely.

**6. The "Restored" banner is gated, not unconditional.** The surface unmounts on every nav switch, so returning is a constant gesture and announcing it every time would train the user to ignore it. The banner appears only when both hold: something non-default came back (a commit other than the top row, a non-zero scroll offset, or active filters) **and** the absence exceeded two minutes. It auto-dismisses after six seconds. Persisting the state is the deliverable; the announcement is a courtesy for the case where you have genuinely lost your place.

**7. Escape has one meaning per state, in a stated order.** The mockup labels the filter row's clear affordance "Clear all · esc", but Escape is already claimed twice on this surface: it exits compare while compare is on (`bindings.ts:177`), and otherwise returns to the Cockpit (`ESC_HOME_SURFACES`, `bindings.ts:41`). Order is: filters active → clear filters; else compare on → exit compare; else → home. The three guards are made mutually exclusive (the clear-filters guard requires filters active *and* compare off), so the existing `assertNoConflicts` keybinding test keeps passing rather than being weakened.

**8. Jump-to-top is `g g`, not the mockup's `g h`.** `g h` is already the g-leader chord for Cockpit (home) — `{ letter: "h", surface: "cockpit" }` in `bindings.ts`. Taking it would break the home chord on one surface only, which is worse than deviating from the mockup's footer. `g g` is free and is the established vim idiom for "top". The hint footer says `g g`.

**9. Pagination appends, and a failed append never destroys the page you are reading.** Scrolling near the bottom loads the next page and appends it; the derived rows recompute over the accumulation. This is the one failure that is *not* full-pane: if an append fails, the loaded commits stay exactly as they are and the page footer swaps from "loading commits 51–100…" to an inline retry row. A full-pane takeover there would throw away readable content to report a fault in something optional.

## 1. Backend

One additive change in `pkg/gitinfo/gitinfo.go`:

```go
// GitFailure describes a git invocation that failed, in the shape the Diff surface's failure panel
// renders: the command as run, its exit code, and stderr verbatim. ExitCode is -1 when the failure
// was not an exit status at all (git missing from PATH, a context deadline), because inventing a
// number there would be a lie the panel then displays.
type GitFailure struct {
	Command  string `json:"command"`
	ExitCode int    `json:"exitcode"`
	Stderr   string `json:"stderr"`
}

// failureOf turns the error run() already returns into a GitFailure. cmd.Output() populates
// ExitError.Stderr, so the detail is available without changing how git is invoked.
func failureOf(args []string, err error) *GitFailure
```

`HistoryLog` changes in one place: where it currently returns `nil, err` from the log invocation (`gitinfo.go:555-558`), it returns `&History{IsRepo: true, Failure: failureOf(args, err)}, nil`. Its `Ref`, `Skip`, `Limit`, `Author`, `Grep` and `Path` handling is already correct and is not touched. `History` gains `Failure *GitFailure` with `json:"failure,omitempty"`.

RPC, in the git domain: `CommandGitHistoryRtnData` in `pkg/wshrpc/wshrpctypes_git.go` gains `Failure *gitinfo.GitFailure`, and the existing thin handler in `pkg/wshrpc/wshserver/wshserver_git.go` passes it through. No new command. Then `task generate` — never hand-edit `wshclientapi.ts`, `gotypes.d.ts` or `wshclient.go`.

**A repository with no commits yet is empty history, not a failure.** Found while planning: `git log` in a freshly initialised repository exits 128 ("does not have any commits yet"), which the change above would report as a failed read — so registering a brand-new project would show a scary evidence panel for a perfectly healthy repository. On a log failure `HistoryLog` therefore probes `rev-parse --verify --quiet HEAD`; git's convention is exit **1** for "no such ref" against **128** for a fatal error, so an exit of 1 there means an unborn branch and the read returns empty history with no failure. Any other outcome reports the original log failure. Discriminating on the exit code rather than matching git's message text keeps this independent of git's wording.

**Backend tests** (table tests in `pkg/gitinfo/gitinfo_test.go`, on the existing temp-repo fixtures):

1. `HistoryLog` with an unresolvable `Ref` reports `IsRepo: true`, a non-nil `Failure` whose `ExitCode` is 128, whose `Stderr` names the bad revision, and whose `Command` contains `log`.
2. A repository with no commits reports `IsRepo: true`, no commits, and **no** failure.
3. A healthy read leaves `Failure` nil — so a working repository cannot trip the failure panel.

The pagination and author/path filter tests already exist and stay untouched. `go test ./pkg/gitinfo/` needs no CGO flag; a whole-tree run does (see `CLAUDE.md`).

## 2. Frontend state

`githistorystore.ts` gains the following. Every atom is module-level, which is what survives the surface's unmount — the same reasoning as the shipped selection atoms and the fix in `f8044bd4`.

| Atom | Holds |
|---|---|
| `historyFiltersAtom` | `{ author, path, text }`, all empty when off |
| `historyCommitsAtom` | the accumulated raw commits across loaded pages, or null before the first read |
| `historyRowsAtom` | **becomes derived** from commits + filters + the working-tree file count, via the shipped `buildRows` |
| `historyHasMoreAtom` | whether another page may exist |
| `historyAppendingAtom` | an append in flight, and whether it failed |
| `historyFailureAtom` | **replaces** the boolean `historyErrorAtom`; holds the `GitFailure` or null |
| `historyScrollAtom` | the history list's scroll offset in pixels |
| `historyLeftAtAtom` | when the surface last unmounted |
| `restoreNoticeAtom` | the banner's sentence, or null |

`historyRowsAtom` changing from a stored value to a derived one is required by pagination: appending a page must not duplicate the divider and uncommitted-row logic that `buildRows` already owns. Its consumers only read it (`filessurface.tsx:278`, and the row list that feeds keyboard list-nav at `:410`), so the change is source-compatible.

Loaders: `loadHistory(cwd, opts)` reads the first page with the active filters; `loadMoreHistory(cwd)` appends; `setHistoryFilter(cwd, patch)` debounces then reloads the first page; `clearHistoryFilters(cwd)`; `retryHistory(cwd)` clears the failure first so the panel shows a loading state rather than sitting on stale evidence; `noteSurfaceLeft()` and `consumeRestoreNotice()` for the banner gate. The existing single-flight guard token pattern is extended to cover appends, so a filter change mid-append cannot let the stale page land.

**Filters persist across a surface switch but reset when the scope changes.** Surviving the unmount is the whole point of decision 6, and a filter is part of where you were. A scope change is different: it is a different repository or a different agent's working directory, where a path like `src/coupons/**` or an author who never committed there is meaningless and would silently produce an empty history that looks broken. The existing `resetHistory()` therefore clears filters and scroll offset along with the selection it already clears.

## 3. Components

**`historyquery.ts`** — new, pure, unit-tested. Owns everything between "the user typed" and "the store issues a read": the filter shape, the count of active filters, the summary label ("2 filters · 4 commits"), the mapping onto the RPC's `author` / `grep` / `path` (blank fields **omitted**, not sent as empty strings), the page size, the has-more rule, and the restore-banner gate with the sentence it produces. Same role `historyrows.ts` and `comparerows.ts` play for their areas.

**`historyrows.ts`** — one addition beside the shipped `defaultSelection`: a helper that keeps the current selection when it survives a filter change and otherwise falls back to the default. Selection rules already live there; this is one more.

**`historyfilterrow.tsx`** — new. The mockup's filter row, rendered below the subject bar in history state only (compare has no filter): the `/`-prefixed search field, the author and path chips, the active count with "Clear all · esc", then the Graph toggle moved here from the subject bar (`filessurface.tsx:545-553`) where the mockup puts it, badge `G` included.

*How the three filters are entered, stated because the mockup only shows them populated.* Three plain inputs, no query language: the `/` field is free text matched against commit subjects (the `grep` parameter), and the author and path chips each open a one-line inline input on click, showing an ✕ to clear when set. Deliberately **not** a prefix syntax (`author:dana`, `path:src/**`) in the one field — that is a parser, an error state, and a discoverability problem in exchange for one fewer input.

**`gitstatepanels.tsx`** — new, two exports. A calm "This source is not a Git repository" panel with no retry, because retrying cannot make it one; it points at the scope pills instead. And a failure panel showing the command, exit code and stderr verbatim as selectable monospace, with Retry. These replace the one-line "Not a git repository" text (`filessurface.tsx:562`) and the "Couldn't read this repository" banner (`:557`).

**`historypane.tsx`** — modified: writes its scroll offset to the store (throttled) and restores it on mount, requests the next page when scrolled near the bottom, renders the appended-page footer with its inline retry, takes the graph-suppressed-by-filter flag, and makes its existing count label filter-aware. Row height stays `ROW_H = 34` per decision 2.

*Counts are relative, not absolute — a deliberate deviation.* The mockup's labels quote repository totals ("2,918 commits · 4 active branches", "4 of 2,918 commits"), which the paginated read cannot know: it has only the pages it has loaded. Supplying a total would mean a second git call (`rev-list --count`) on every history read, walking the whole graph to populate a decoration. So the label reads what is true — "50 commits loaded", "4 matching commits" while filtered — and no screen implies a total the surface has not counted.

**`filessurface.tsx`** — modified: renders the filter row and the two panels, shows the Restored banner, and stamps the left-at timestamp in its unmount cleanup.

**`bindings.ts` / `footerhints.ts`** — modified: `/` focuses the filter field, `G` toggles the graph, `g g` jumps to the top of history, Escape clears filters under the ordering in decision 7. Footer entries alongside the shipped `↑↓ commit`, `⏎ open file`, `c compare`.

## 4. Errors and what gets tested

**Four outcomes, one path each.** Not a repository (`isrepo: false`) → the calm panel. Read failed (`failure` populated) → the failure panel with Retry. The RPC itself threw — websocket down, timeout, handler panic, git missing from PATH → the *same* failure panel, from a synthesized record whose command is the RPC name, whose stderr is the error message, and whose exit code renders as "no exit code" rather than a fabricated number. Filters matching nothing → not a failure at all: an empty list reading "No commits match these filters", with Clear all offered.

Stated rather than quietly fixed: if selecting a commit fails its changed-file read, the middle pane still just clears, as it does today. That is a separate gap and out of scope here.

**Tests.** Two Go table tests (§1). Vitest for `historyquery.ts` — the RPC mapping including omission of blank fields, the active count, the summary with and without filters, the has-more rule, and the restore gate across its four combinations — plus cases for the added selection helper in `historyrows.test.ts`. No test for the store itself: the repo convention is that pure derivation is tested and RPC glue is not (`filesstore.ts`, `githistorystore.ts` and `comparestore.ts` all have none), which is precisely why the three rules above are extracted rather than left inline.

**One repeatable scenario, `git-history`, in `scripts/cdp/scenarios.mjs`** — the first for this surface; every earlier check was an ad-hoc screenshot. It asserts populated history (rows present, gutter drawn), filtered history (row count drops, gutter suppressed, count label correct, uncommitted row absent), filters cleared, the not-a-repository panel by pointing the scope at a non-repository directory, and that selection, scroll offset and filters come back after navigating away and returning.

*Corrected while planning: state cannot be injected.* The harness exposes only `globalAtoms`, `globalWS` and `TabRpcClient` on `window` — `globalStore` is not reachable, so a scenario cannot set an atom, and asserts must be RPC-based or DOM-based (`scripts/cdp/scenarios.mjs` header states this). The failure panel is therefore arranged **for real**: create a temporary repository, commit, delete its `.git/objects` directory, register it as a project over the `createproject` RPC, and scope the surface to it. `git log` then fails on an unreadable object while the directory is still a work tree, which is exactly the state the panel exists for. Teardown deletes the project and the directory.

*Stated limit:* the Restored banner has no automated check. Its gate and its sentence are pure and unit-tested, and the persistence underneath it is asserted by the scenario, but the rendered banner is confirmed by a one-off screenshot only — waiting out a two-minute threshold in a verification run is not worth the wall-clock, and the state cannot be faked.

## Assumed constants

Chosen during design rather than asked about, all in one place so they are cheap to change: page size 50 (the mockup's footer reads "loading commits 51–100"), filter debounce 250ms, restore threshold 2 minutes, banner auto-dismiss 6 seconds, scroll-offset writes throttled to 150ms, next page requested within 200px of the bottom.

## Not in this spec

- **The Fetch control and its freshness clock** — the only mutation the brief permits, needs a new RPC, and is also the real answer to the stale-local-default caveat in the branch-comparison spec's decision 4.
- **Commit provenance**, the "Produced by Run #148" line — a new backend join; `Run` objects reach the frontend only per active channel, so the surface has nothing to join against today.
- **The Unified / Split diff toggle**, and the desaturated diff-text tints `--color-diff-add-ink` / `--color-diff-del-ink`.
- **Narrow-window folding and row density** — declined outright by decision 2, not merely postponed.
- **Blame** — never proposed; the brief and the mockup both exclude it.
