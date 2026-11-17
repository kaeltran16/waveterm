# Diff surface: Fetch and Push

**Goal:** Build the approved Diff surface design: a Push (and first-push Publish) beside Fetch as one joined
control at the right end of the toolbar, ahead/behind counts on Push, the tightened History column header and
filter row, the reworked diff pane header, and no keyboard-shortcut hints inside any Diff surface button.

**Architecture:** One backend task adds `gitinfo.Push`, the `gitpush` command, the no-prompt env for network
git, and the upstream/ahead/behind/remote facts on the change-list read, and regenerates the bindings. The
toolbar task builds on it. The History header and the diff pane header touch no backend and no toolbar file, so
they run beside the backend task from the start. Each UI task owns its own scenario file, so the three never
collide at merge.

**Decisions beyond the design** (each with why):

- **The change-list read reports the remote facts only when asked.** `CommandGitChangesData` gains
  `remote: true`, sent only by the Diff surface's loader (`filesstore.ts`). The read is polled by every
  Cockpit card, the rail and the peek too; three more git processes per tick on each of those buys them
  nothing.
- **`hasremote` moves to the change-list read, and the compare-only copy goes.** Push shows on every range,
  so whether a remote exists must be known outside compare. One source: the toolbar reads it from
  `filesStateAtom` for both buttons. `compareHasRemoteAtom` and `CommandListBranchesRtnData.HasRemote`
  then have no reader, so they are deleted, not left beside it.
- **A failed remote-facts read does not fail the change list.** No upstream (`rev-parse @{u}` exits
  non-zero) is a normal state: empty upstream, Publish. Any other failure of that read is logged in wavesrv
  and the list returns without the facts (no Push detail): the change list is the surface's primary answer,
  the same rule blame uses for its run links.
- **Publish always targets `origin`.** The same default `gitinfo.Fetch` uses. A repo whose only remote has
  another name gets git's own refusal in the failure notice.
- **Push and Fetch share one per-repository state** (`gitremotestore.ts`, replacing `fetchStatesAtom` in
  `comparestore.ts`). "One network action at a time per repository" and "one failure banner" are then one
  field each, not a cross-check between two atoms. `runFetch` moves there with `runPush`. The `git` prefix
  is required: `remotestore.ts` and `remotemodel.ts` already exist and are Remote mode's.
- **Push's reason is a styled tooltip, not a native title.** The WorkingTree, FirstPush, Diverged and
  Detached boards draw it as a tooltip under Push, and only a rendered element can be checked by a scenario.
  It uses the shared `Tooltip` (`frontend/app/element/tooltip.tsx`), wrapping the button so it still opens
  on a disabled Push; that element gains `role="tooltip"`, which it lacked. Fetch keeps a native title.
- **Detached is told from no-upstream by the branch, not the upstream.** Both have an empty upstream; the
  change list's branch is `""` or `"HEAD"` on a detached HEAD (as `diffscope.ts` already treats it), and
  that alone makes Push Detached rather than Publish.
- **Diverged on the working range comes from a fetch made earlier.** Fetch is drawn only in compare, so the
  behind count on the working range reflects the last fetch from compare, or the poll after a git fetch
  made elsewhere; the scenario fetches in its fixture setup.
- **After a successful fetch, the change list is re-read too.** A fetch moves `@{u}`, so the behind count
  changes with it. After a push: the change list, the history column (its `origin/<branch>` chip moved) when
  it shows that repository, and in compare the same refs and pair re-read `runFetch` already does.
- **The rejected push's headline comes from `failureHeadline`.** It ranks a line starting `! [` (git push's
  per-ref status, which only push prints) above `error:` lines, so the `! [rejected]` line is the headline in
  `GitFailureNotice` with no new prop. A push failure is "rejected" when its stderr contains `[rejected]`.
  Banner title is "Push failed" for Push and Publish. The note for a rejected push is
  `<upstream> has commits you lack. Fetch, then merge them before pushing.`; for any other push failure,
  `nothing was pushed`.
- **Publish runs as "Publishing…"**, as the prototype draws it. Push runs as "Pushing…".
- **Compare summary drops every ref.** Merge-base form: `since <sha> · N files · +a −d`. Tip-to-tip form:
  `tip to tip · N files · +a −d`. With no merge base yet: the counts alone. The ref picker beside it names
  both refs in every form.
- **The diff pane header draws its divider when either Open in Code or Mark reviewed is drawn.** The
  divider separates view toggles from file actions, and each of those two is conditional.
- **The comment send bar's Send button loses its `⇧↵` hint too** (`commentsendbar.tsx`). The goal bans
  hints inside buttons anywhere in the Diff surface; that button was not in its list.
- **The no-prompt env is a gitinfo constant**, not shared with `pkg/wavevault/git.go`. Two strings do not
  justify coupling the two packages.
- **Network git commands are never run by a worker's own shell.** The Go tests push to a local bare remote
  through `exec`, which the agent push guard does not see. A worker must not type `git push` in its shell
  (the guard blocks it, and it is out of scope).

**Verify:** `node scripts/verify.mjs ./pkg/gitinfo/... ./pkg/wshrpc/...`
**Check:** `task check:ts && go vet ./pkg/gitinfo/... ./pkg/wshrpc/...`
**Final:** `node scripts/cdp/final-verify.mjs diff-push git-history diff-states diff-scope diff-compare diff-review-marks diff-comments`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\diff-fetch\project\Main.dc.html

### Task 1: Push command and the change list's remote facts
**Depends on:** none
**Files:** `pkg/gitinfo/gitinfo.go`, `pkg/gitinfo/remote.go`, `pkg/gitinfo/remote_test.go`, `pkg/wshrpc/wshrpctypes_git.go`, `pkg/wshrpc/wshrpctypes_projects.go`, `pkg/wshrpc/wshserver/wshserver_git.go`, `pkg/wshrpc/wshserver/wshserver_projects.go`, `pkg/wshrpc/wshserver/wshserver_git_test.go`, `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`

**What to build:** wavesrv pushes for the human, and the Diff surface's change-list read says where the
branch stands against its upstream.

- `gitinfo.Push(ctx, cwd)` pushes the branch checked out in `cwd`: `git push` when it has an upstream, else
  `git push -u origin <branch>`. Never a force flag. A detached HEAD returns a `GitFailure` (stderr
  `HEAD is detached: check out a branch to push`) without running git. Its own 55s budget like
  `fetchTimeout`; git's refusal is `GitFailure` data (via `failureOf`), not an error. Not a repo:
  `IsRepo: false`.
- Every network git command (this push and the existing `Fetch`) runs with `GIT_TERMINAL_PROMPT=0` and
  `GCM_INTERACTIVE=never` added to the environment, as `pkg/wavevault/git.go` does.
- `gitpush` wshrpc command in `GitCommands`, server handler beside `GitFetchCommand`, then `task generate`.
- `gitinfo.RemoteStatus(ctx, cwd)`: whether a remote exists, the current branch's upstream
  (`origin/feat`, "" when none or detached), and ahead/behind from
  `git rev-list --left-right --count @{u}...HEAD`. `GitChangesCommand` fills the new return fields from it
  only when the request carries `remote: true`; a failure of that read other than "no upstream" is logged
  and leaves the fields empty (see header).

**Interfaces:**

```go
// wshrpctypes_git.go
type CommandGitPushData struct { Cwd string `json:"cwd"` }
type CommandGitPushRtnData struct {
	PushedAt int64               `json:"pushedat"` // unix seconds; 0 on failure
	Failure  *gitinfo.GitFailure `json:"failure,omitempty"`
	IsRepo   bool                `json:"isrepo"`
}
// GitCommands: GitPushCommand(ctx, CommandGitPushData) (*CommandGitPushRtnData, error)  — wire "gitpush"

// wshrpctypes_projects.go
// CommandGitChangesData gains:   Remote bool `json:"remote,omitempty"`
// CommandGitChangesRtnData gains: HasRemote bool `json:"hasremote,omitempty"`; Upstream string `json:"upstream,omitempty"`;
//                                 Ahead int `json:"ahead,omitempty"`; Behind int `json:"behind,omitempty"`
```

The client calls `RpcApi.GitPushCommand(TabRpcClient, { cwd }, { timeout: 60000 })`.

**Acceptance** (Go tests against a local bare remote):
- push with an upstream: the remote branch moves to the local tip; `PushedAt` set, no failure.
- first push of a branch with no upstream: the remote gains the branch and the local branch's upstream is
  now `origin/<branch>`.
- a non-fast-forward push (the remote has a commit the clone lacks) returns a `GitFailure` whose stderr
  contains `[rejected]`, and the remote branch is unchanged (no force).
- a detached HEAD returns a `GitFailure` and the remote is unchanged.
- `RemoteStatus` reports ahead 2 / behind 0 with two local commits, ahead 2 / behind 1 once the remote gained
  one and was fetched, empty upstream for a branch with no upstream, and no remote for a repo without one.
- `GitChangesCommand` (tested in `wshserver_git_test.go`) without `remote` returns none of the new fields,
  and with `remote` on a clone two commits ahead returns its upstream and ahead 2.
- Fetch and Push commands carry both no-prompt variables (checked at whatever seam builds the command).

### Task 2: Fetch | Push in the Diff toolbar
**Depends on:** Task 1
**Files:** `frontend/app/view/agents/filessurface.tsx`, `frontend/app/view/agents/surfacescaffold.tsx`, `frontend/app/view/agents/gitremotestore.ts`, `frontend/app/view/agents/gitremotestore.test.ts`, `frontend/app/view/agents/gitremotemodel.ts`, `frontend/app/view/agents/gitremotemodel.test.ts`, `frontend/app/view/agents/comparestore.ts`, `frontend/app/view/agents/comparestore.test.ts`, `frontend/app/view/agents/filesstore.ts`, `frontend/app/view/agents/filesstore.test.ts`, `frontend/app/view/agents/diffscope.ts`, `frontend/app/view/agents/diffscope.test.ts`, `frontend/app/view/agents/gitfailure.ts`, `frontend/app/view/agents/gitfailure.test.ts`, `frontend/app/element/tooltip.tsx`, `pkg/wshrpc/wshrpctypes_projects.go`, `pkg/wshrpc/wshserver/wshserver_projects.go`, `frontend/types/gotypes.d.ts`, `scripts/cdp/scenarios-files-push.mjs`, `scripts/cdp/scenarios-files-scope.mjs`, `scripts/cdp/scenarios.mjs`

**What to build:** the boards Main, Fetching, Fetched, FetchFailed, NoRemote, WorkingTree (its Push and
tooltip), FirstPush, Pushing, Pushed, PushRejected, Diverged and Detached.

- `filesstore.ts` sends `remote: true` and keeps `hasRemote`, `upstream`, `ahead`, `behind` on `FilesState`
  (optional fields, so existing fixtures stay valid).
- `gitremotestore.ts` holds one per-repository state (which action is running, if any; last fetch time; last
  push time; the last failure and which action it came from), `runFetch` (moved from `comparestore.ts`,
  same 60s client budget and same compare re-read) and `runPush`, and the re-reads after success listed in
  the header. `gitremotemodel.ts` is pure: each button's label, icon, title, disabled reason and detail, and the
  push banner's note, from `FilesState` plus that state.
- Toolbar: Fetch and Push are one joined control (`role="group"`, `aria-label="Remote"`) at the right end,
  after the range summary and a 1px divider. The summary truncates with the full text in its title instead of
  wrapping the toolbar, and in compare drops the refs (header). Fetch shows only in compare and only with a
  remote; Push shows on every range when the repo has a remote; with no remote the group and divider are
  absent. Icons: Fetch `ArrowDownToLine`, Push `ArrowUpFromLine`; running: spinning `LoaderCircle` and
  "Fetching…" / "Pushing…" / "Publishing…"; a failed last action: `CircleAlert` in the error colour in place
  of its icon. While one action runs, the other button is disabled. The last fetch/push time sits inside its
  button as a small mono detail (`formatAgo`). Push detail: `↑N` when ahead, `↑N ↓M` in the warning colour
  when ahead and behind, the push time when 0 ahead after a push, nothing otherwise. No upstream: label
  "Publish" (brighter ink). Detached (branch `""` or `"HEAD"`): Push disabled, reason
  `HEAD is detached: check out a branch to push`. Push's reason, shown in the shared `Tooltip` (header):
  `Push N commit(s) to <upstream>`, `<upstream> has N commit(s) you lack: merge before pushing`,
  `Nothing to push: <upstream> has every commit`, `Publish <branch> to origin and track it`.
- Failures render through the existing `GitFailureNotice` (title, note, Retry, dismiss), Fetch's text as
  today.
- Delete `compareHasRemoteAtom` and the ListBranches `HasRemote` field (header), then `task generate`.
- No confirmation dialog.
- State changes and their moments: the ahead count changing rolls (moment 12, `TickNumber`); the failure
  banner keeps `GitFailureNotice`'s existing reveal; running uses the spinner only.

**Interfaces:** `[data-files-remote]` (the group), `[data-files-fetch]`, `[data-files-push]`, the fetch clock
`[data-files-fetched]`, the push detail `[data-files-push-detail]`.

**Acceptance:**
- `gitremotemodel` unit tests: every Push state above (ahead, diverged, nothing to push, publish, detached,
  running, held by a running fetch, failed) gives the specified label, title, disabled flag and detail; a
  rejected push failure gives the rejected note with the upstream in it, any other push failure
  `nothing was pushed`.
- `gitremotestore` unit tests: a push or fetch sets the state running and clears the previous failure; while one
  runs the other is refused; a failed push keeps the previous push time; a successful push re-reads the change
  list; a successful fetch re-reads the change list and, in compare on that repository, the refs and pair;
  an RPC error leaves a failure, not a spinning button.
- `failureHeadline` returns the `! [rejected] …` line for a rejected push's stderr; existing cases unchanged.
- `summaryLine` compare cases read `since 7a4155c · 31 files · +764 −88` and `tip to tip · 2 files · +10 −2`.
- New scenario `diff-push` (`scripts/cdp/scenarios-files-push.mjs`, registered in `scenarios.mjs`) on a
  clone of a local bare remote, one step per board: Main (compare: Fetch and Push `↑2` in one group right of
  the summary, summary not naming the head branch); Fetching and Pushing (the action held in flight by
  overriding `window.TabRpcClient.wshRpcCall` for `gitfetch` / `gitpush` with a promise the step resolves
  afterwards, the pattern of `stubRpc` in `scenarios-files-states.mjs`: spinner, running label, other button
  disabled); Fetched (`just now` inside Fetch); FetchFailed (the notice with git's headline); NoRemote (no
  group, no divider); WorkingTree (working range: Push `↑2`, no Fetch; hovering Push shows `[role=tooltip]`
  reading `Push 2 commits to origin/<branch>`); FirstPush (a branch with no upstream reads Publish, its
  tooltip reads the Publish reason, and clicking it publishes: then Push with nothing ahead); Pushed (after a
  real push, `↑` gone and the push time inside the button); PushRejected (the remote gained a commit from a
  second clone: the notice reads Push failed with the `! [rejected]` headline and the upstream in its note);
  Diverged (after a fetch in the fixture, `↑N ↓M` in the warning colour, and the hovered tooltip reads the
  diverged reason); Detached (Push disabled; hovering it shows the detached reason in `[role=tooltip]`).
  Each step takes a screenshot, with the tooltip open where it hovers. Its fixture project names must not
  contain `diff-remote`: diff-scope step 2 counts the sources that fragment matches.
- `diff-scope` step 17 reads the new in-button clock instead of `fetched just now`, and its `lookEval`
  (`scenarios-files-scope.mjs`, which imports `fetchStatesAtom` from `comparestore.ts`) reads the new state
  from `gitremotestore.ts` instead.

### Task 3: History header, filter row and comment hints
**Depends on:** none
**Files:** `frontend/app/view/agents/historypane.tsx`, `frontend/app/view/agents/historyfilterrow.tsx`, `frontend/app/view/agents/diffcommentcard.tsx`, `frontend/app/view/agents/commentsendbar.tsx`, `scripts/cdp/scenarios-files.mjs`

**What to build:** the WorkingTree board's History column header and filter row, and the comment buttons
without hints.

- Header: Graph toggle (26px tall, radius 7, `aria-pressed`, title `Graph (⇧G)`, no inline `⇧G`) and the
  collapse button (26x26) aligned; Clear filters loses its inline `esc` and gets title
  `Clear filters (esc)`.
- Filter row: the field and the Author/Path chips all 28px tall with radius 7; a search icon replaces the
  `/` glyph (the input's title `Filter by message (/)`); chip labels in sentence case (`Author`, `Path`, not
  mono uppercase, editing state included); the row fits the 380px column without clipping.
- `diffcommentcard.tsx`: Cancel and Add comment / Save lose their `Esc` / `Ctrl+↵` text; titles
  `Cancel (Esc)`, `Add comment (Ctrl+↵)`, `Save (Ctrl+↵)`. `commentsendbar.tsx`: the Send button loses its
  `⇧↵` text; its title carries `(⇧↵)`.
- No new state changes: these are restyles of existing controls.

**Acceptance:**
- `git-history` scenario gains a step at a 380px history column: Graph and collapse both 26px tall with
  centres aligned; the filter field and both chips 28px tall with 7px radius; a search icon in the field and
  no `/` text; chip labels read `Author` and `Path`; no element of the filter row extends past the column's
  right edge; the Graph button's text is `Graph` and its title `Graph (⇧G)`. Screenshot of the header and
  filter row.
- the `diff-comments` scenario's assertions that read the send button's text match the hint-free text:
  `Start agent with 3 comments⇧↵`, `Send 3 comments⇧↵` and `Send again⇧↵` become `Start agent with 3
  comments`, `Send 3 comments` and `Send again`; and a step asserts the draft card's buttons hold no `<kbd>` and
  carry the titles above.

### Task 4: Diff pane header and the range strip hint
**Depends on:** none
**Files:** `frontend/app/view/agents/diffpane.tsx`, `frontend/app/view/agents/rangestrip.tsx`, `scripts/cdp/scenarios-files-states.mjs`

**What to build:** the DiffPaneHeader board (wide, wide with toggles on, narrow), and the Compare chip
without its inline `c`.

- The previous/next chevrons and `change i/n` become one joined control (`role="group"`,
  `aria-label="Changes"`, keeps `data-diff-nav`); every header control 28px tall, radius 8.
- Order: changes group, Unified/Split (when labelled), Hide whitespace, a 1px divider, Open in Code
  (borderless), Mark reviewed last. The divider rule is in the header.
- Mark reviewed loses its inline `v` (title keeps `(v)`); its check is the accent colour when reviewed.
- The narrow layout stays icon-only as today (`change` word dropped, labels hidden).
- `rangestrip.tsx`: the Compare chip loses its `<kbd>c</kbd>`; its title is `Compare (c)` when available, its
  unavailable reason otherwise.
- State change: Mark reviewed turning reviewed keeps today's colour change; no new moment.

**Acceptance:**
- `diff-states` scenario gains steps, wide and at 1000x700: the nav group is one element containing both
  chevrons and the counter; every header control is 28px tall; Open in Code has no visible border; the
  divider sits directly before Open in Code; Mark reviewed is the last control and its check's stroke is the
  accent colour once marked; at 1000x700 the controls are icon-only and the counter reads `i/n`; no header
  button holds a `<kbd>`. Screenshots of both widths, marked and unmarked.
- a `diff-states` step for the board's "wide with toggles on" strip: Split on, Hide whitespace on and the
  file marked reviewed, all three pressed (`aria-pressed="true"`) in one wide header; screenshot.
- the same scenario asserts the Compare range chip holds no `<kbd>` and its title is `Compare (c)`.
- the existing `1c` long-filename step still passes (name, counts and nav do not overlap).
