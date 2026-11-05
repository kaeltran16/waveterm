# Diff surface review fixes (F1-F26)

Source: the Diff surface review of 2026-11-05 (`C:\Users\kael02\IdeaProjects\waveterm\cdp-shots\review\diff\report.md`,
gitignored; screenshots beside it). Each finding's cause was re-checked against main at `6222895e5`; every cause
below holds as reported unless the decision says otherwise. Out of scope: the report's "Tooling and procedure" and
"Related to known items" sections.

All logic changes go in pure model files (frontend) or Go functions, with tests beside them. Colors and spacing
come from existing `@theme` tokens only. Every fixed visual state or interaction gets a step in a files CDP
scenario: `diff-scope` (new, `scripts/cdp/scenarios-files-scope.mjs`), `diff-states` (new,
`scripts/cdp/scenarios-files-states.mjs`) or the existing `diff-compare` (`scripts/cdp/scenarios-files.mjs`).

## Backend (Go)

- **F9, worktree side of a diff.** `CommandGitFileAtRefData` gains `Worktree bool`: read `<cwd>/<path>` from disk
  instead of a blob, with the same answers as a ref read: `Missing` when the file is absent, `TooLarge` by stat
  before reading when the size exceeds `MaxBytes`, `Binary` when the bytes are not valid UTF-8 or hold a NUL in the
  first 8000 bytes (git's own heuristic), plus `IsRepo`/`Root`/`Prefix` as `FileAtRef` sets them. New
  `gitinfo.FileInWorktree`. Why: the frontend's plain `FileReadCommand` has no cap and no binary check, and giving
  the one file reader both modes keeps the caps in one place instead of re-implementing them in TypeScript.
- **F3, bounded change list.** `CommandGitChangesData` gains `End string`. When set, the list is
  `gitinfo.GetRangeChanges(cwd, ref, end)` (commits only, no working tree), and `Branch`/`Head` are still the
  checkout's. Why: a landed run's change list must stop at the run's own tip; `GetRangeChanges` already computes
  exactly that for evidence.
- **F14, remote presence.** `CommandListBranchesRtnData` gains `HasRemote bool` (`git remote` lists at least one).
  Why: "no remote-tracking branches" is not "no remote" (a fresh clone of a never-fetched remote), so the Fetch
  button's visibility needs the real answer.
- **F26, stash.** `HistoryLog` walks `--exclude=refs/stash --all` instead of `--all`. Why: a stash's WIP and index
  commits are not history; excluding them removes both the mislabelled chip and two noise rows, with no new chip
  kind to style.

## Scope and range model (pure)

- **F3, landed run range.** `DiffOrigin` run and `DiffRange` run gain optional `headCommit` (the run's tip; absent
  = live). `rangeKey` appends it only when set, so an unbounded run keeps today's key (review marks persist by
  it). `openRunDiff` for a landed run resolves the tip: `land.commit`'s second parent
  (a land is a `--no-ff` merge, so parent 2 is the run branch's tip), else `land.commit` itself when it has one
  parent (a fast-forward or a hand-merge that `mergedCommit` recorded as the tip), else `run.endcommit`, else
  unbounded as today. Parents come from `GitHistoryCommand({ref: land.commit, limit: 1})`; the choice is a pure
  function in `agentdiffnav.ts`. The change list passes `End`; `FilesState` carries `end`; the working-tree row's
  diff selection under a bounded run reads `base` vs `end` (`DiffSelection` worktree gains optional `end`, and
  `pairRefsFor` makes the modified side that ref). The summary reads `<base> … <tip>`, the caption "measured from run
  base X to its landed tip Y". Why: the land merge already records the commit; bounding at the run's own tip is the
  only answer that excludes what landed after it.
- **F7, session/run history.** `historyOptsFor` returns a `ref` for session and run ranges: the run's `headCommit`
  when bounded, else `HEAD`; working and compare keep `--all` (`ref` absent). `historyKey` includes the ref (so
  switching between a walked-all and a walked-from-HEAD list re-reads; the old "range-free" comment is replaced).
  `buildRows` puts the divider above the anchor row and dims the anchor row with everything older
  (`before: i >= anchorIdx`); the pane draws the divider before its row. Why: `--all` lists other branches' and
  other worktrees' commits above the anchor, so positional dimming lied; walking from the scope's own head makes
  "above the divider" mean "in this session/run".
- **F10, session range without a start.** The agent default stays "Since session start". When no start is resolved
  (`ref` ""), the summary reads `N files against HEAD (no session start yet) · +a −d`, the caption "On X, measured
  from HEAD (no session start yet)", and the active session chip is drawn enabled with detail "not yet" (its title
  keeps the reason). Why: the start usually resolves once the agent's first prompt writes a transcript, so switching
  the range away would lose it; saying what is measured is the honest fix. Known limit: the 10 s poll does not
  re-resolve the start; re-opening the agent's diff does.
- **F24, Compare chip.** `availableRanges` takes `isRepo` in its context (default true) and omits Compare when false.
- **F16, history counts.** `commitCount(rows)` in `historyrows.ts` counts rows that are not the synthetic top row;
  the toolbar count label and the paging footer ("loading commits N–M") use it.
- **F21, slow-read notice.** `historyquery.ts`: `HISTORY_RPC_TIMEOUT_MS = 15_000` (above gitinfo's 10 s
  `gitTimeout`, so git's budget, not the RPC's 5 s default, ends a hung read and the failure panel names the git
  command), `SLOW_HISTORY_MS` 10 s → 4 s so the notice shows inside that budget. Every `GitHistoryCommand` call passes
  the timeout.
- **F11, history at narrow widths.** `difflayout.historyLayout(explicit, width)` returns `rail | column | overlay`:
  below `HISTORY_COLLAPSE_PX` an expanded history (by `⇧H` or the rail's expand button) is an overlay drawn over the
  commit and diff panes, with the 44 px rail staying in flow; at or above it, expanded is the column as today. Why:
  the report's 162 px diff pane comes from pushing two fixed columns into 1000 px; an overlay keeps the panes'
  width without folding the file list, and the explicit choice no longer costs the diff its room.
- **F25, F19 list order.** `filetree.ts` gains `listOrder(files, tree)` (what `reviewOrder` computes today; it now
  delegates), `firstInList(files, tree)` and `stepInList(order, from, dir)` (clamped, null at either end). Why: the
  first file opened and `n`/`p` must follow the order the list draws, and three stores pick a first file.

## Stores

- **F4, run link selection.** `settleSelection` remembers the scope key its selection belongs to; a load for a
  different scope key drops the remembered row and takes `defaultSelection` (the synthetic "Run changes" / "Since
  session start" row when present). A remount with the same scope keeps the user's place as today.
- **F6, ended agent's folder.** `filesstore` remembers each agent's last resolved cwd (`agentCwdOf(id)`), set when
  an agent scope resolves.
- **F20, failures.** A failed diff-pair read stores a failure (message) instead of nulling the pair, with
  `retryDiffPair()`; a failed commit file list (history and compare) stores a failure with a retry for the selected
  row. A failed change-list *refresh* (the poll, `r`) keeps the last good state and sets `filesRefreshFailedAtom`;
  only the initial load of a scope still takes over the surface. Why: one failed 10 s tick must not wipe the working
  tree row, and an endless skeleton hides the error.
- **F25.** The first file selected on load (working tree, commit, compare aggregate, compare commit row) is
  `firstInList(files, treeMode)`.

## Compare

- **F8.** `refreshCompare(cwd)` re-runs `setCompareRefs` with the current pair; `r` calls it in compare (after the
  change-list reload) instead of `refreshHistory`.
- **F13.** The ref picker clears `focused` on blur; picks stay on `mousedown`, which fires before the blur.
- **F14.** A pure `defaultComparePair({def, current, prev, branches})`: base = remembered or the default branch, head
  = remembered or the current branch, and when head equals base, head becomes the most recently committed local
  branch other than base (branches arrive sorted by recency); with none, it stays and the picker (which `c` already
  opens) is where to change it. Fetch renders only when `HasRemote` (`compareHasRemoteAtom`).
- **F15.** "fetched X" uses `formatAgo` ("just now" / "5m ago").

## Diff pane

- **F1.** The "Open in editor" button is removed and `Enter` opens the file in Code (`openInCode`, at the first
  differing line, like the header's Open in Code). Why: there is no safe "open with the OS default app" for a path:
  ShellExecute runs executables and scripts, which is why `open_external` allowlists http/https/mailto and its tests
  assert bare paths are rejected. Arc's Code surface already opens any repo file.
- **F12.** `splitAvailableAtom` (diffoptions) is written by the pane from `paneHeaderLayout(width).split`; `⇧D`
  declines when it is false. The removed-lines hint reads "switch to split (⇧D)…" when split is available and
  "collapse history (⇧H) or widen the window to use split view and comment on them" when not.
- **F17.** `DiffPair` records optional `originalMissing` / `modifiedMissing`; equal empty texts read "New empty file" (left
  missing) or "Deleted empty file" (right missing) instead of "Only the name or the file mode changed".
- **F19 text.** The "Pick a file" state says "Choose one from the list, or step through it with n / p".
- **F20.** The pane renders the pair failure with its message and a Retry button.

## Keys, docs, comments

- **F19 keys.** `n` / `p` on the Diff surface open the next / previous file in list order without marking it
  (`files:next-file`, `files:prev-file`, via `activeReviewAtom`'s `files/open/select`); declined at either end and
  with no file list. Free on this surface: `n` is Code's tree-scoped new-file and `p` the Agent surface's hand-off.
  `docs/keyboard-shortcuts.md`: `j`/`k` row → "Next / previous commit", `Enter` → "Open the open file in Code", add
  `n`/`p`, `r` notes compare, delete the "Files — Review mode" section (no code). The cheat sheet is generated from
  the bindings, so the labels are its text.
- **F23.** `resolveRecipient` returns `wait` with "<name> is asking a question — answer it first" for an agent in
  state `asking`; Send and `⇧Enter` decline.

## Surface

- **F5.** `diffsource.subjectState(scope, agents, projects)`: `empty` (no agents, no projects: today's empty state),
  `pick` (no scope but sources exist), `ended` (agent origin not in the roster), `ready`. `pick` renders the toolbar
  and a body state "Pick something to review" with a "Choose a source" action that opens the picker.
- **F6.** `ended` renders "This agent has ended" with "Its changes are in <cwd>" and an action that re-scopes to the
  registered project at that path, else a project scope on the folder itself (`endedAgentScope` in diffsource.ts,
  built from `defaultRangeFor` so the pure model imports no store);
  with no remembered cwd the action is "Choose a source".
- **F2.** The Cockpit card's diff chip calls `openDiff(model, agentDiffScope(id, name))`, as the palette action does.
- **F18.** The source picker's filter: `Enter` picks the highlighted row (first match by default), `↑`/`↓` move the
  highlight across the Agents then Projects groups (pure helpers in diffsource.ts).
- **F22.** The collapsed rail pages on scroll (`onLoadMore` near the bottom, as the pane does) and, in compare,
  starts with an "All changes" dot that selects the aggregate.
- **F24, F16, F14, F15, F11, F20** are wired here from the decisions above, plus the refresh-failed notice: a quiet
  toolbar fact "couldn't refresh · showing the last read" while `filesRefreshFailedAtom` is set.

## Coordination

Runs cad1a593 (Agent surface: `agentdiffnav.ts`, rail View diff, `bindings.ts`, shortcut docs) and 5638249e (Code
surface: `bindings.ts`, shortcut docs, open-in-Code) are in flight. Conflicts at land are resolved keeping every
run's behavior.
