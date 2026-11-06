# Surface review follow-ups, round 2: code fixes (design)

Source: `C:\Users\kael02\IdeaProjects\waveterm\cdp-shots\review\followups-2\report.md` (F1-F17), initiative
effort:fdea6d43 "Surface review on real data", chunk 20 "Fix run: code follow-ups round 2". Each finding was
checked against HEAD `192cfd3a7` before this was written. Every decision below was made by the lead of an
autonomous run; the reason follows each one.

A separate surface review drives a snapshot dev app on CDP :9222 during this run. No worker attaches to :9222 or
runs `task verify:ui` against the default port: a worker sees its scenario only in an isolated app started by
`ARC_FINAL_OUT=<a temp dir> node scripts/cdp/final-verify.mjs <scenario...>` (its own ports, store and profile).

## Status on HEAD

| Finding | On HEAD | Where |
|---|---|---|
| F1 pins pruned by an in-flight load | Present | `sessionsarchivestore.ts` `loadSessionsArchive` prunes `globalStore.get(sessionsPinnedAtom)` read when the load returns; a call during a load returns at the `loading` guard |
| F2 tree duplicate check untested | Present | `codetreepane.tsx:87` merges `index.paths` and `codeSessionDirsAtom` inline; no test, no live step |
| F3 usage-states By work failure step | Present | `usage-states` exercises only the provider lens; `usage-work` step 18 stops at All usage |
| F4 hidden run opens another run's sheet | Present | `openref.ts` `loadRun` selects the run id on its channel; `stageRunAtom` → `resolveActiveRunId` falls back to the default run when the id is not in the list; entry in `docs/open-issues.md` |
| F5 approve bar wraps | Present | `brainstormcheck.tsx` `ApproveBar`: one `flex-wrap` row holds the text column, the blocker and both buttons |
| F6 Finished strip threshold | Present (unmeasured) | `agentrow.tsx:84` `NARROW_HIDE = "@max-[330px]:hidden"` |
| F7 resmon-footer without remote chip | Present | `resmon-footer` steps 6/6b run with remote mode off only |
| F8 app-bar search with two providers | Present (unmeasured) | `app-bar.tsx:37` `min-w-[160px] flex-1` search beside `UsageMeters` |
| F9 jira-post step 1 never run | Present | not in any Final since the step changed |
| F10 numstaterror ignored | Present in 4 of the 6 callers | `parseGitChanges(statusZ, numstat)` (gitstatus.ts) counts a missing numstat line as 0; only `cardgitstore` and `filesstore` read `numstaterror`; `agentbranchstore` and `newagentmodal` read only the branch |
| F11 refused brainstorm sends only logged | Present | `bindings.ts:951` and `brainstormsend.ts:78` `.catch(console.warn)` |
| F12 unused remark-flexible-toc | Present | `package.json:91`, `package-lock.json`; no import anywhere in frontend, scripts or config |
| F13 notice shows a warning line first | Present | `gitstatepanels.tsx` `GitFailureNotice` renders `failure.stderr` whole into one truncated line |
| F14 diff-states warm-up flakes | Present | `diff-states` arrange creates the project, reloads and asserts with no readiness wait |
| F15 agent-tree-rail step 10 never scrolls | Present | fixture roster fits the tree |
| F16 DeleteChannel leaves shared entries | Present, and dags too | `wstore_channel.go:116-119` bulk-deletes `db_run` and `db_dag`; `sharedObjs` (wstore_dbops.go) is evicted only by `DBDelete`; `GetDagShared` reads `db_dag` through the same cache |
| F17 profile partial save never driven live | Present | `brief-profile` has no failing-save step |

## Decisions

### D1. F1: prune only the pins the load was asked about, and reload once after a skipped call

`loadSessionsArchive` keeps the pins it sends. When the load returns, a pin is dropped only if it was among the
sent pins and the scan did not return it; a pin added during the load is kept (its session was never asked for).
The rule is a pure function in `sessionspins.ts` (`prunePins` gains the sent list), unit-tested with the race:
pins `[a]` sent, `[a, b]` current at return, scan returns neither → `[b]` kept. A call that hits the `loading`
guard sets a flag, and the load reruns once when the in-flight one ends, so a restore during a load is also
shown, not only kept. Rejected: cancelling the in-flight load (the RPC cannot be cancelled and its result is
still good data).

### D2. F2: the tree's existing-name list is a pure function

`existingTreePaths(indexPaths, sessionDirs)` in `codemutate.ts` (beside `validateName`, which consumes it),
tested: an empty folder made this session (in `sessionDirs`, not in the index) makes `validateName` return
`exists` for its name; a rename onto a sibling file's name does too. `codetreepane.tsx` calls it. The
`code-session` scenario gains a step: New folder with the name of the folder made in its step 3 shows the
"exists" error and Enter creates nothing.

### D3. F3: By work failure step; Cockpit after Esc

`usage-states` gains a By work step: a failed range switch shows the project/initiative share pills dashed and
hides the other-folders note (stub the range read to reject, as the provider-lens step does). `usage-work` step
18 also asserts the Cockpit surface is shown after the last Esc.

### D4. F4: a hidden run opens its owner's sheet, never a stranger's

Revised after plan review round 1: the channel's run list is not filtered (`GetChannelRunChanges` returns every run
of the channel and `activeChannelRunsAtom` holds them all), so the "falls back to the default run" mechanism
first written here was wrong and the root cause is unproven. The worker reproduces it first (open
`run:<engine child>` and see which sheet shows and why), then fixes the cause it finds.

The contract: a run that is not an engine child opens its own sheet as today. An engine child (the existing
predicate `isEngineChild`, `frontend/app/cockpit/palette-data.ts:30`: a run with a `taskid` or `stagerole`,
imported, not copied) opens its owner's sheet, with the child selected where that sheet has a place for it (a
task child's dag task, as `dag:` addresses already do). The owner comes from the existing lineage
(`runRoleOf`, `frontend/app/view/agents/runlineage.ts:78`, and the dag's owning run), not new lineage code. When
no owner resolves, the open fails with "That run is part of another run and has no sheet of its own" and nothing
changes. Pure resolver plus unit tests; a `dag-lifecycle` step opens an engine child by `run:<id>` and asserts the
sheet is its owner's. The open-issues entry is removed. Rejected: listing engine children as runs of their own
(the palette hides them on purpose).

### D5. F5: the buttons own the bar's row; the blocker gets its own line

The approve bar is two rows when a blocker exists: row one is the text column (shrinks, truncates) and the two
buttons (never wrap, `flex-none`); row two is the blocker text, full width, wrapping on its own. With no blocker it
is one row. Checked in `brainstorm-check-review` at 1000 and 1600 wide: Approve and Keep talking share one top
edge with the title text, and the blocker sits below them.

### D6. F11: a refused send is a toast

Keyboard sends and `notifyRun` have no component to hold an error line, and `notifyRun` can finish after the
user has left the pane, so both report through the app-wide cockpit toast (`pushToast`, level error, precedent
`recordactions.ts` `reportFailure`), with the refusal's own message. One helper in `brainstormsend.ts` is used by
`bindings.ts` and `notifyRun`; every other `sendBrainstorm(...).catch(console.warn)` found by grep goes through it
too. The pane's buttons keep their inline error line. A `brainstorm-check-review` step stubs the agent prompt to
reject, presses a review send key and finds the toast.

### D7. F6, F8: measure first, change only what the numbers show

- F6: in an isolated app, bisect the card width at which the Finished strip's Open starts to clip with the
  button words shown. Set `NARROW_HIDE` to the first width where it does not clip (rounded up to the next 10 px),
  and add a `cockpit-card-layout` step at a width just below the new threshold and one just above, each asserting
  Open is not clipped. If 330 already holds, keep it, add the steps at 331 and 360, and report the numbers.
- F8: with a two-provider fixture, read the search's width at 1200, 1366 and 1440 wide. If it sits at its 160 px
  floor at any of them, the meters take a compact form (their text labels dropped under an `@container`
  breakpoint of the app bar) so the search clears the floor; no new tokens. A `usage-charts` step records the
  widths at those sizes with two providers and asserts the search is above its floor at each.

### D8. F7, F15: make the scenarios exercise what they claim

- F7: a fixture shows the remote chip by setting the state the chip reads, without turning remote mode on; steps
  6 and 6b run again with it shown (new lettered steps), and teardown restores the state.
- F15: `agent-tree-rail` step 10 uses a roster long enough that the tree scrolls; it asserts the last row scrolls
  clear of the avatar. The worker runs it once with the padding removed, records that it fails, and restores the
  padding before completing.

### D9. F9, F12: run it; remove it

- F9: `jira-post` is named in Final; its worker runs it in an isolated app first and fixes step 1 if it fails.
- F12: remove `remark-flexible-toc` from `package.json` and regenerate the lockfile with
  `npm install --package-lock-only --ignore-scripts`, which leaves `node_modules` untouched, so the junctioned
  main checkout is not rewritten mid-run. The extraneous copy in `node_modules` is harmless.

### D10. F10: line counts unknown is a property of the parse

`parseGitChanges(statusZ, numstat, numstatError?)` returns `lineCounts: false` (counts left at 0, never shown)
when `numstatError` is set; otherwise the field is absent, meaning known (revised after plan review: optional,
so existing `GitChanges` literals and `toEqual` assertions stay valid). A pure `lineCountsShown(changes)` in
`gitstatus.ts` is what every renderer asks. `codestatus.ts` `statusByPath` carries the flag through to
`codeStatusAtom` for the Code changed pane. The compare and commit-history readers (`comparestore.ts`,
`githistorystore.ts`) are out: they read commit ranges, where a numstat failure fails the read (D3 of the round-1
spec) rather than setting `numstaterror`. Of the six named callers, `agentbranchstore` and
`newagentmodal` read only `branch` from the result and show no counts, so they need no change. The four that
count (`railstore` → `agentdetailsrail.tsx`, `codestore` → `codechangedpane.tsx`, `codepeekstore` →
`codepeekcard.tsx`, `peekagent.tsx`) pass `numstaterror` and their renderers draw no `+N −N` (per file and in
totals) when `lineCounts` is false; the file list and file counts stay, as the Diff surface does. Root cause in the shared parser, so a future caller cannot repeat the mistake by forgetting a
check. `cardgitstore` keeps its own drop of the chip. A `code-diff-states` step denies read on one changed file
(the `icacls` trick `diff-states` step 7 uses) and asserts the Code changed pane lists it with no counts. The
Code peek is not checked live (revised after plan review): denying read fails the peek's file read before its
change is computed, so a live step would pass without the fix. Instead `peekStat` (`codepeekmodel.ts`) returns a
"line counts unknown" result for a `lineCounts: false` change, not "no changes", pinned by a unit test. The Agent
details rail and the Hub agent peek are proven by the `lineCountsShown` unit tests only (both need a live agent in
a repo with an unreadable file; recorded as not verified live).

### D11. F13: the notice leads with git's error line

A pure `failureHeadline(stderr)` (new `gitfailure.ts` with a test): the first line starting `fatal:` or `error:`,
else the first line that is not a `warning:`/`hint:` line, else the first line. `GitFailureNotice` shows it; its
title keeps the whole stderr. Every notice benefits (fetch failures too). `diff-states` step 7 asserts the line
reads the `fatal:` line; if the seeded repo prints no warning ahead of it, the step seeds one (a CRLF file under
`core.autocrlf`) so the order is actually tested.

### D12. F14: wait for readiness, not time

The `diff-states` arrange waits until the project is listed in the app (the projects atom or picker holds it)
before reload and assertions, and step 11 waits for its agent's controller to report started, each with a bounded
wait that fails the arrange or step with what it saw. No step's bar is lowered.

### D13. F16: every bulk delete evicts what it removes

A helper `forgetShared(otype, ids...)` evicts entries from `sharedObjs`; `DBDelete` uses it, and `DeleteChannel`
selects the run and dag oids it is about to delete (inside its tx) and evicts them after the tx. Go tests: a run
read through `GetAllRunsShared` and a dag through `GetDagShared`, then `DeleteChannel`, then a re-insert under the
same oid at the same version with different data, reads the new data.

### D14. F17: drive the partial save live

A `brief-profile` step stubs the project-scope profile save to reject, edits both scopes and saves: the global
scope reads saved (and its value is stored), the project scope stays dirty, and the footer shows its error.

## Verification

- Go: D13 unit tests.
- Frontend logic: vitest beside each pure module (D1, D2, D4, D10, D11).
- Rendered UI, each a step in an existing scenario run by Final: D1 `sessions-pin`, D2 `code-session`, D3
  `usage-states` and `usage-work`, D4 `dag-lifecycle`, D5/D6 `brainstorm-check-review`, D7 `cockpit-card-layout`
  and `usage-charts`, D8 `resmon-footer` and `agent-tree-rail`, D9 `jira-post`, D10 `code-diff-states`,
  D11/D12 `diff-states`, D14 `brief-profile`.
- D12 is proven only to the extent a Final run is fresh: the flake was intermittent.
