# Surface review follow-ups: code fixes (design)

Source: `C:\Users\kael02\IdeaProjects\waveterm\cdp-shots\review\followups\report.md` (F1-F16), initiative
effort:fdea6d43 "Surface review on real data". Each finding was checked against HEAD `75d1aeb44` before this was
written. Every decision below was made by the lead of an autonomous run; the reason follows each one.

## Status on HEAD

| Finding | On HEAD | Where |
|---|---|---|
| F1 pending launch listed twice | **Already fixed, no change** | `deriveTerminalVMs` (agentsviewmodel.ts:624-627) skips any row whose tab carries `session:agent` (not "terminal"), added in c72797986 (2026-07-02). `launchAgent` (cockpit-actions.ts) sets `session:agent` on the tab before it registers the pending launch, and it is the only writer of `pendingLaunchesAtom`. A pending launch therefore never reaches the Terminals group. |
| F2 snapshot guard gaps | Present | `wshserver_code.go` writes `~/.arc/review`; file RPCs, block cwd and agent prompts are unguarded |
| F3 hints footer posture | Present in the scenario; cause unconfirmed | `hints-footer.tsx` recomputes on focusin/focusout only |
| F4 numstat errors dropped | Present | `pkg/gitinfo/gitinfo.go:80,89,91` |
| F5 quoted startup command | Present | `launch.ts` `buildLaunchMeta` and `composeStartupCommand` split on `\s+` |
| F6 history failure blanks the body | Present | `filessurface.tsx:690-692` |
| F7 ResizeObserver `[]` deps | Present | `filessurface.tsx:229-239` |
| F8 final-verify exit 127 | Present (no handle cleanup before `process.exit`) | `final-verify.mjs:408-446` |
| F9 session effort only from open tabs | Present | `usagesessions.go` `tabEffort` |
| F10 palette record failure only logged | Present | `recordactions.ts` `reportFailure` |
| F11 Runs row keys | Present | `briefingmodel.ts` `uniqueKeys`, keyless rows key `run:run:` |
| F12 commit list skeleton | Present, and the same bug sits in `comparestore.ts` | `githistorystore.ts:443`, `comparestore.ts:331` |
| F13 Markdown TOC dead | Present | `markdown.tsx` (`showTocAtom`, `RemarkFlexibleToc`, `.toc`), `markdown.scss:229+` |
| F14 Waiting header total | Present | `briefwaiting.tsx` `count={queue.length}` |
| F15 unparsable record skipped silently | Present | `pkg/jarvisattrib/lifecycle.go` `taskDossiers` |
| F16 empty span in Edit footer | Present | `effortcreateform.tsx:388-391` |

## Decisions

### D1. F2: one containment rule per kind of reach, in `pkg/wavebase`

`ARC_SNAPSHOT=1` already refuses a process start outside `arc-snap\scratch` (`snapshotMayStart` in
blockcontroller). That predicate moves to `wavebase.SnapshotMayStart(cwd)` and blockcontroller calls it (one
source of truth). A second predicate, `wavebase.SnapshotMayWrite(path)`, allows a path only inside the snapshot
base (`filepath.Dir(GetWaveDataDir())`, the `arc-snap` folder, which holds the store and the vault copy). Both
return true whenever `ARC_SNAPSHOT` is unset, so nothing changes outside a snapshot. Every refusal is an error
starting `snapshot store:` naming the path and the allowed folder, the wording the Jira and process guards use.

Applied at the server boundary, so every UI path that reaches it is covered:

- `CodeReviewWriteCommand` (Send review): refused before `writeReview`, by `SnapshotMayWrite`.
- The wshfs-backed file RPCs in `wshserver_files.go` (write, create, mkdir, delete, move: source and
  destination): refused by `SnapshotMayWrite`. Their paths are wshfs paths, which may be connection URIs, so
  each is resolved through connparse first: a local host is checked on its path, a non-local host is refused
  (a snapshot reaches no remote). Brainstorm's Close calls `FileDeleteCommand`, so it is covered
  here. `WriteTempFileCommand` stays open: it writes under the OS temp dir, which is not user data, and its only
  consumer is an agent send that is refused below.
- Block cwd: a block gets its working directory either from `wcore.CreateBlock`'s block def or, on the launch
  path, from a later `SetMetaCommand` on the default block that `CreateTab` made. Both refuse a `cmd:cwd`
  outside scratch (`SnapshotMayStart`). Refusing only at process start (today) leaves a dead block pointing at
  a real repo; refusing where the cwd is given stops the launch before it exists.
- `AgentPromptCommand` (pane Approve, Keep talking, every brainstorm line): refused when the target block's
  `cmd:cwd` is not inside scratch. The copied agents' tabs are real sessions' tabs; an agent the reviewer
  launches in scratch still takes prompts. Approve sends its line before it opens the launcher, so a refused
  send keeps the launcher closed with no further change.
- `launchAgent` (cockpit-actions.ts): when a step between `CreateTab` and the controller start throws, it deletes
  the tab it made and rethrows. A refused controller start keeps its tab, so its "failed to start" row still shows
  (decided during the run; the cwd guard refuses a snapshot launch before the start anyway). Without this a refused launch leaves an empty terminal tab behind (true of any launch failure, so
  it is not snapshot-only code). The palette resume and New agent paths already surface a thrown launch
  error; the worker confirms that each of the four reported paths shows the refusal. A swallowing caller
  inside the task's files (`codereviewstore.ts`) is fixed; one outside them is reported as an open issue, not
  edited, since another task may own that file.

Not covered by Final: the Final app is not a snapshot app. Go unit tests (with `t.Setenv("ARC_SNAPSHOT","1")`
and unset) are the proof, plus `cockpit-actions.test.ts` for the tab cleanup. `docs/reference/surface-review.md`
lists the new guards.

### D2. F3: settle the cause before changing the app

The scenario drives the app over CDP, where a page without OS focus fires no focus events, so the miss may be
the harness, not the app. The worker first runs the agent-keys rest posture with
`Emulation.setFocusEmulationEnabled` on (the pattern scenarios-code-keys.mjs uses) and the synthetic focusin
removed. If the footer then follows, the bug was the harness: the scenario keeps focus emulation on for the step
and the app is unchanged. If it still misses, the cause is focus leaving without an event (a focused xterm
textarea removed from the DOM fires no focusout): the footer then also recomputes when that happens. Either way
the synthetic `focusin` is removed and step 6 must pass without it.

### D3. F4: a git read that fails is an error, except a repo with no commits

In ref mode `GetChanges` returns the name-status and numstat errors. In live mode with a HEAD, a numstat failure
does not fail the read: `git diff --numstat HEAD` exits 128 when one file's bytes cannot be read ("cannot hash"),
while status still lists every file, so failing the whole read would hide the list and the per-file "Couldn't read
this file" state the Diff pane already has (round 1's Final caught this on diff-states step 7). `GetChanges` then
returns the list with `NumstatError` set, and the line counts are shown as unknown, never as zeros. The no-commits
case keeps today's behavior (status is still the answer). The error carries git's stderr. Callers already handle an error: the Cockpit card's catch drops the chip (no fake +0 -0)
and now logs the error with the agent id; the Diff surface shows its failure state. `pkg/jarvis/evidence.go`
falls back to `GetChanges` when the range read fails: an unresolvable base now fails evidence with the error
instead of reporting zero files, which is the honest result.

### D4. F15: log the skip, keep the tolerance

`taskDossiers` keeps skipping a record it cannot load (one bad record must not stop attribution) and logs
`jarvisattrib: skipping record <id> (<path>): <err>`.

### D5. F9: persist the link when the tab goes, keyed by session

A table `db_sessioneffort` (migration `000026`), primary key (harness, transcript path), columns effort oid and
ts. It is written in `wcore.DeleteTab`, the one function both tab-closing paths call, from the tab's
`session:effort` and `session:agent` and its first block's `agent:transcriptpath`, upserted so a session
re-tagged to a later initiative keeps the latest. The call sits right after DeleteTab loads the tab and before
its worker close hook and block-delete loop, because that loop removes the block holding the transcript path. A
test closes a tagged tab through `wcore.DeleteTab` and finds the row. The write goes through a wstore function so it is testable;
a failure is logged and never blocks the close. Tab close is the only moment the link can be lost: an open tab,
even across a restart, still carries it. Usage builds its session-to-initiative map from the table, then
overlays the open tabs (an open tab's live tag wins). The transcript path, not the session id, is stored so the
derivation stays in one place (`usagestats.SessionIdOf`, as `tabAgentSession` uses). Rejected: a session list
on the effort object (a re-tag would have to find and remove the old entry) and a write at tag time (the
transcript is not known yet when a launch tags its tab).

### D6. F5: a small shell-style splitter in launch.ts

`splitCommandLine` in launch.ts: whitespace separates tokens; `'...'` is literal; `"..."` groups, with `\"` and
`\\` as its only escapes; a backslash outside quotes is literal, because Windows paths are typed that way; an
unclosed quote runs to the end. No dependency: none is installed and the rule set is small. Used by
`buildLaunchMeta` and by `composeStartupCommand`'s flag-presence check, so both read the command the same way.

### D7. F6, F7, F12: the Diff surface keeps what still works

- F6: a history failure while the change list holds a good state draws in the history column, in place of the
  commit list, with Retry. The working-tree row, change list and diff stay usable. The whole-body
  `GitFailurePanel` is kept only when there is no good change-list state (the read that failed is also the one
  that would say isRepo).
- F7: the width observer is attached when the measured element mounts (a callback ref, or an effect keyed on
  the element), not once on first render.
- F12: `isrepo:false` from `GitCommitChanges` sets the commit's failure (with Retry) in both
  `githistorystore.selectCommit` and `comparestore`, never null with no failure. Fixing both is the root cause:
  they share the pattern.

### D8. F10: the error shows on the surface where the change was made

`reportFailure` keeps the Brief's toast (`briefUndo.error`) when the Brief is the current surface, and
otherwise pushes the app-wide cockpit toast (`pushToast`, level error, drawn by `NotificationToasts` in
cockpit-root on every surface). The current surface is read through a reader registered from cockpit-root,
the way `subscribeEffortUpdates` gets it, since no global surface accessor exists; with no reader registered
the cockpit toast is used. The Brief keeps the toast F12 of the Brief review chose; other surfaces get a
toast they actually draw.

### D9. F11: a row's key comes from the row alone

A run row with no navtarget is keyed from its own ts when it is built (`mergeActiveWork`), so its key does not
depend on other rows. `uniqueKeys` keeps only the ordinal for exact collisions (two keyless rows with one ts).

### D10. F14: the Waiting header counts like its summary

Under a filter the Waiting header reads "N of M" (N the rows the filter keeps, M the whole queue), as the summary
and chips do since the Brief live pass F16. With no filter it reads M as now.

### D11. F16: no empty element, same layout

In Edit the footer renders no hint span; the Cancel and Save buttons keep their right alignment (e.g. `ml-auto`
on Cancel when no hint precedes it).

### D12. F13: remove the TOC entirely

The `showTocAtom` prop, `tocRef`, the `RemarkFlexibleToc` plugin, the TOC render and its jump effect leave
`markdown.tsx`; the `.toc` rules leave `markdown.scss`. Every reference is grepped first. The
`remark-flexible-toc` entry stays in package.json for now: removing it means an install that, through the
worktree junctions, rewrites the main checkout's node_modules mid-run. It is reported as a follow-up.

### D13. F8: release every handle before exiting

The Final's teardown kills the dev app's process tree but leaves the child's stdin pipe (and possibly other
handles) open, and `process.exit` then closes them mid-teardown. The worker finds what is still closing at exit
and closes or destroys it, awaiting its close, before the exit; the exit code is the result's. This run's own
Final exercises the path.

## Verification

- Go: unit tests per decision (D1, D3, D4, D5).
- Frontend logic: vitest beside each pure module (D6, D7, D8, D9; D1's tab cleanup).
- Rendered UI, each a step in an existing scenario run by Final: D2 `agent-keys`, D6 `agent-tree`, D7
  `diff-states`, D8 `palette-review-fixes`, D9/D10/D11 `brief-act` or `brief-live-initiative`, D12 `code-markdown`
  (markdown still renders), and `surface-smoke`.
- Not verifiable in Final: D1 (needs a snapshot app), D5's closed-tab count (needs a real closed agent tab in the
  Final store), D13 beyond the run's own Final exit.
