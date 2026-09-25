# Diff surface polish — design

Status: approved in brainstorming 2026-09-25. The mockup is the spec for everything visual:
`.superpowers/design/diff-polish/project/{Main,Compact,WorkingTree,Compare,Panels,Controls}.dc.html`
(gitignored; `Before*.dc.html` and `before-*.png` show today). Render one with
`chrome.exe --headless=new --window-size=1600,950 --screenshot=out.png file:///<abs>/Main.dc.html`
(Panels/Controls are 1320/1330 tall). This document records what the boards do not say: where each
piece lives, the pure models, the deliberate deviations from the boards, and the task split.

## Goal and constraints

Bring the live Diff surface (`frontend/app/view/agents/`) to the boards. Most machinery exists
(failure and not-a-repo takeovers, fetch-failure strip, restore notice, rail, ref picker with swap,
ahead/behind rows, merge-base/tips form, whitespace and split atoms); the work is relocation,
restyling, and a handful of new pure models.

- Colors only from `@theme` tokens in `frontend/tailwindsetup.css`. The mockup's hex values map
  onto existing tokens (`surface`, `surface-raised`, `surface-selected`, `accentbg`, `accent-soft`,
  `edge-faint/mid/strong`, `ink-hi/mid/faint`, `muted`, `success`, `error`, `warning`,
  `graphlane-N`). No new tokens; if one seems missing, stop and ask.
- Testable logic in a pure `.ts` with a `.test.ts` beside it; no jsdom render tests.
- Icons from `lucide-react` (already a dependency). Relative times reuse `formatAgo`/`formatAge`
  from `agentsviewmodel.ts` ("10h ago", not the mockup's "10 hours ago").
- Keep every existing `data-*` hook the CDP scenarios use: `data-files-range-summary`,
  `data-files-source-picker`, `data-files-source-option`, `data-history-filter`,
  `data-filter-count`, `data-history-rail`, `data-history-row`, `data-history-scroll`,
  `data-range-chip`, `data-compare-column`, `data-diff-pane`, `data-git-failure`,
  `data-not-a-repo`, `data-graph-gutter`, `data-changed-file-row`; and the button titles
  `Expand history` / `Collapse history`.

## Deviations from the boards (known mockup defects)

a. **Diff-pane header overflow.** With history open at 1600x950 the pane is ~760px and the board's
   labelled buttons wrap. The whitespace toggle and Open in Code render as icon buttons (with
   `title` and `aria-label`) unless the pane's own measured width is `>= LABELLED_MIN_PX` (1100),
   the same measurement that gates split (`SPLIT_MIN_PX`, 900). The Unified/Split segmented control
   renders only when split fits (the Compact board already omits it); Shift+D still flips the
   stored preference.
b. **Path truncation.** Split into `dir` (faint, ends in "/") and `file` (bold). The dir box
   truncates from the left with `direction: rtl` on the outer span and the text inside a
   `<bdi dir="ltr">`, so the trailing slash stays trailing. Never bare `direction: rtl`.
c. **Working-tree summary.** It is measured against HEAD, not "main": "15 uncommitted files on
   main · +661 −403"; detached HEAD reads "15 uncommitted files against HEAD · …".
d. **Summary vs selection.** The right-aligned summary captions what the panes show (decided:
   follow the selection) — see `summaryLine` below.
e. **Graph padding.** Already correct in code: `historypane` indents rows by `geom.gutter`, which
   grows with the lane count (covered by `gitgraphgeom.test.ts` "derives gutter width from the lane
   cap"). Keep `indent = geom.gutter`; do not copy the board's fixed padding.
f. **Fetch.** Compare keeps a labelled "Fetch" button (with "fetched Xm ago" once one has run),
   distinct from the `r` refresh — not the board's icon-only button.

## Layout

### Subject row (`filessurface.tsx`)

One row, still `flex-wrap` (the 1000px compare case needs it): `Diff` title, source picker,
`RangeStrip`, and in compare the ref pair chip plus Fetch; then a spacer; then the summary
right-aligned, single line, truncating (`data-files-range-summary`). The second summary line under
the row is removed. The Compare range chip carries a faint `c` key hint.

- **Ref pair chip** (restyled `RefPicker`): `● base … ● head ▾` in `SIDE_TEXT` colours, a swap
  button beside it; clicking the chip opens the existing editing form. The chip element carries
  `data-ref-pair` (the `files:change-refs` binding clicks it).
- **Source picker** (`sourcepicker.tsx`, Controls board): folder / status-dot glyphs, a filter
  field at the top of the popover ("Filter agents and projects"), AGENTS then PROJECTS groups, the
  agent's state as faint text on the right, a check on the current source, and "worktree ·
  <parent>" on a project whose path sits inside another registered project's path.

### History column (`historypane.tsx`, `historyfilterrow.tsx`, `historyrail.tsx`)

- The header moves into `HistoryPane`: `HISTORY` + count label ("51 loaded" / "50 matching"), then
  a spacer, then — when filtered — "Clear filters esc", the Graph toggle (`⇧G` hint), and a collapse
  icon button (`title="Collapse history"`, calls a new `onCollapse` prop). When filtered the count
  label reads "50 matching" in `text-accent-soft` and carries `data-filter-count`; the git-history
  CDP scenario's step 3 (which asserts `"1 filter"`) is updated in task 7 to assert `"matching"`.
- `HistoryFilterRow` renders directly under that header, inside the 460px column: message field
  (flex-1), author chip, path chip. The Graph toggle and the summary/"Clear all" leave it (they are
  in the header now).
- The old full-width `‹` collapse strip in `filessurface.tsx` is deleted.
- **Working-tree row:** a dotted ring in the hash column (no "·······"), the label in `text-warning`
  — "Uncommitted changes", or the scope's `rowLabel` ("Since session start", "Run changes") — and
  "N files" where the author goes, "now" in the time column.
- **Slow read:** while the first page is loading (`rows == null`) and more than `SLOW_HISTORY_MS`
  (10s) has passed since the load started, a notice sits above the skeleton: "Still reading
  history · git log has been running for 14s" with a Retry button (`retryHistory`).
- **Filters match nothing:** centred "No commits match", the `noMatchSentence`, and a "Clear
  filters" button.
- **Rail** (Compact board): expand icon button at the top (`title="Expand history"`), then one lane
  dot per row on a vertical line (dotted ring for the working tree, ringed when selected), `title`
  = subject. No hash text.

### Commit pane (`commitpane.tsx`)

- Commit: hash chip + copy button (`navigator.clipboard.writeText` of the full hash) + spacer +
  `formatAgo` on the right; subject; avatar initial + author; refs on their own wrapping line.
- Working tree: eyebrow "WORKING TREE", title = the row label, caption from `worktreeCaption`
  ("On main, measured from 3eaffac").

### Compare (`comparecolumn.tsx`, `aggregatepane.tsx`, `comparerows.ts`)

- Column header: `COMPARE` + `splitLabel` ("split at 7a4155c · 7d ago") + collapse icon button
  (`title="Collapse history"`, `onCollapse` prop).
- Row zero reads "All changes" with files and +/−. Group headers "● exp-native 6 ahead" /
  "● main 152 behind" (the duplicate count badge goes). Commit rows: side dot, hash, subject, age.
- The merge-base footer card is removed (its facts are in the header now).
- Aggregate pane: `base → head`, a two-segment control "Since the split ··· / Tip to tip ··"
  replacing the two chips, then the `formSentence`, then the files header.

### Diff pane (`diffpane.tsx`, `diffoptions.ts`, `diffnav.ts`)

- Header: dir/file path (b), +/−, change nav (⌃ button, "change N/M", ⌄ button; the buttons call
  `gotoChange`), Unified/Split segmented control when split fits, whitespace toggle ("Hide
  whitespace" / icon), Open in Code (label / icon), Open in editor (icon, working tree only).
  Tooltips name the keys: ⇧N / ⇧P, ⇧D, ⇧W.
- Monaco folds unchanged regions: `paneOptions` adds
  `hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 3, revealLineCount: 20 }`.
  Monaco draws its own fold widget; no custom one.
- Empty states (Controls board, §5): icon + title + sentence, from `emptyDiffState`. Binary, too
  large and rename/mode keep the path header (too large shows the size in it).

### Banners and takeovers (`gitstatepanels.tsx`)

- One banner shell, `SurfaceBanner` (tone `error` | `neutral`, icon, message node, optional action
  button, dismiss ✕), used by:
  - fetch failed (error): "Fetch failed · showing refs as of the last fetch" + git's stderr in mono,
    Retry (`runFetch`), dismiss.
  - restore (neutral): the `restoreNotice` sentence + "Start from the top" (`startFromTop`),
    dismiss; still auto-dismisses after `RESTORE_DISMISS_MS`.
- `NotARepoPanel`: folder icon, "This folder isn't a Git repository", the path in mono, "There's no
  history to show here. Pick another agent or project.", and a "Choose a source" button that clicks
  `[data-files-source-picker]` (the clickThrough pattern the bindings use).
- `GitFailurePanel`: alert icon, "Couldn't read this repository", "Git stopped with an error.
  Nothing was changed, so retrying is safe.", the command block with the exit chip and a copy
  button, and a primary Retry.

### Keys and footer (`bindings.ts`, `cockpit/footerhints.ts`, `docs/keyboard-shortcuts.md`)

- `files:compare` becomes `inHistory`-only; new `files:change-refs` (`c`, `inCompare`, label
  "Change compare refs") clicks `[data-ref-pair]`, returning `false` when it is absent. Guards stay
  mutually exclusive so `assertNoConflicts` passes.
- Footer, history: `/` filter, `⇧G` graph, `⇧N ⇧P` next / prev change, `⇧H` history, `c` compare,
  `r` refresh, plus the existing conditional `esc` clear filters. Compare: `c` change refs, `⇧S`
  swap, `⇧N ⇧P` next / prev change, `⇧H` history, `r` refresh, `⇥` side, `esc` leave compare.
  `↑↓` commit, `⏎` open file and `g g` top leave the footer (the bindings still work and stay in `?`
  help).

## Pure models (each with tests beside it)

| File | Addition | Behaviour to test |
|---|---|---|
| `diffoptions.ts` | `LABELLED_MIN_PX = 1100`; `paneHeaderLayout(width) -> { split: boolean; labelled: boolean }`; `hideUnchangedRegions` in `paneOptions` | 0/760/900/1100 boundaries; options carry the fold config |
| `diffnav.ts` | `changePosition(changes: {start: number; end: number}[], cursorLine) -> { index: number; total: number }` (index 1-based, 0 before the first change); `diffNavPosAtom` the pane updates from Monaco's `onDidUpdateDiff` and modified-editor cursor events | before first, inside, between, after last, no changes |
| `diffempty.ts` (new) | `emptyDiffState({ path, pair, compareAggregateEmpty, base, head }) -> { title; body } \| null` | no file ("Pick a file to see its changes"), nothing to compare ("{base} and {head} have no file differences."), binary, too large ("Diffs stop at 2 MB. Open it in Code to read the file."), rename/mode ("Only the name or the file mode changed."), null when drawable |
| `diffscope.ts` | `summaryLine` follows the selection: working-tree row → "N uncommitted files on {branch} · +a −d" ("against HEAD" when detached); session/run top row → today's range phrasing; a selected commit → "{hash7} · N files · +a −d"; compare aggregate → "{head} since {mb7} · N files · …" (tips: "{base} .. {head} tip to tip · …"); a compare commit → the commit form | each branch, including detached and 1-file singular |
| `historyrows.ts` | working-tree row gets `fileCount`, `subject` = bare label; `worktreeCaption(range, branch, head, ref) -> string` | repo / session / run captions; row shape |
| `historyquery.ts` | `noMatchSentence(filters)` ("No commit by Kael mentions “workerr”.", author-only, text-only, path clause); `SLOW_HISTORY_MS = 10_000`, `slowSeconds(startedAt, now) -> number \| null`; `restoreNotice` reworded to "Back where you left off: commit 3eaffac, your scroll position and 2 filters." | wording per combination; threshold boundary; existing gates unchanged |
| `githistorystore.ts` | `historyLoadStartedAtom` (set when a load starts with no rows on screen, cleared when it settles); `startFromTop()` = clear filters, scroll 0, default selection, dismiss notice | store tests in `githistorystore.test.ts` |
| `comparerows.ts` | aggregate label "All changes"; `formSentence(form, base, head, mergeBase)` (board wording for both forms); `splitLabel(mergeBase, mergeBaseTs, now)` | both forms; missing ts omits the age |
| `diffsource.ts` | `filterSources(query, agents, projects)`; `worktreeParent(project, projects) -> string \| null` (longest registered path that strictly contains it, via `normalizeRepoPath`) | case-insensitive filter; nested/sibling/same-path cases, Windows separators |
| Go `pkg/gitinfo` | `Divergence.MergeBaseTs int64` in unix ms like `HistoryCommit.Ts` (`git show -s --format=%ct <mb>` × 1000, 0 when there is no merge base) carried through `CommandGitDivergenceRtnData` → `task generate` → `CompareSides.mergeBaseTs` | `gitinfo` test on a temp repo |

## Error handling

- Clipboard writes are `fireAndForget`; a rejected write is logged, not swallowed silently.
- Slow-history Retry supersedes the in-flight read through the existing load token; the old
  result is dropped by the token check, as today.
- Divergence without a merge base (unrelated histories) keeps today's behaviour; `MergeBaseTs` is 0
  and `splitLabel` omits the age.

## Verification

- `npx vitest run` and `task check:ts` (about 2 minutes) clean; `go test ./pkg/gitinfo/...`.
- CDP: `surface-smoke`, `git-history`, `diff-compare`, and `code-diff` pass against the dev app;
  update a scenario's expectation only where this design changes the text it reads, and say so in
  the commit.
- Screenshot the live surface at 1600x950 and 1000x700 and compare with Main / Compact / WorkingTree
  / Compare.

## Task split

1. Go merge-base time (`pkg/gitinfo`, `pkg/wshrpc`, generate) — independent.
2. Diff pane: `diffoptions`, `diffnav`, `diffempty`, `diffpane.tsx` — independent.
3. History column + commit pane: `historyrows`, `historyquery`, `githistorystore`, `historypane`,
   `historyfilterrow`, `historyrail`, `commitpane` — independent. New props default so the current
   `filessurface.tsx` still compiles.
4. Compare: `comparerows`, `comparestore` (carry `mergeBaseTs`), `comparecolumn`, `aggregatepane`,
   `refpicker` — after 1.
5. Source picker: `diffsource`, `sourcepicker.tsx` — independent.
6. Keys and footer: `bindings.ts`, `footerhints.ts`, `docs/keyboard-shortcuts.md` — independent.
7. Surface shell: `filessurface.tsx` (subject row, summary, banners, takeovers, wiring
   `onCollapse` and the new props, removing the old strip, summary line and top filter row),
   `gitstatepanels.tsx`, `diffscope.summaryLine`, CDP scenarios — after 2, 3, 4, 5. The only task
   that edits `filessurface.tsx`.
