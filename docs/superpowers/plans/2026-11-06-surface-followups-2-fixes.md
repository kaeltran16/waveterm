# Surface review follow-ups, round 2: code fixes

> **For agentic workers:** each task below is one worker's. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix F1-F17 of the round-2 surface review follow-ups: the store, router, layout and Go fixes, and the CDP
scenario steps that make each one seen in the running app.

**Architecture:** Twelve independent tasks, one per area, each owning its scenario file so all run side by side.
Pure logic goes in a `.ts` beside its test; each UI change is proven by a step in an existing scenario, run at the
width where it was broken. The one Go fix (F16) evicts the shared-object cache on bulk delete.

**Tech Stack:** Go (wstore), React 19 + jotai, vitest, CDP scenarios (`scripts/cdp`).

**Effort:** effort:fdea6d43-219b-4cf2-b4ce-51758338103b
**Spec:** `docs/superpowers/specs/2026-11-06-surface-followups-2-fixes-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/wstore`
**Check:** `go vet ./pkg/wstore && task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs sessions-pin code-session usage-charts usage-states usage-work dag-lifecycle brainstorm-check-review cockpit-card-layout resmon-footer agent-tree-rail jira-post code-diff-states diff-states brief-profile`

## Global Constraints

- **Never attach to CDP :9222 and never run `task verify:ui` against the default port**: a surface review is
  driving that app. See your scenario only in an isolated app:
  `ARC_FINAL_OUT=<a new temp dir> node scripts/cdp/final-verify.mjs <scenario...>` (its own ports, store and
  WebView2 profile; it waits for a lock if another worker holds it).
- Logic is extracted, not rendered: pure `foo.ts` + `foo.test.ts`, thin `.tsx`.
- Colors and spacing from the `@theme` tokens in `frontend/tailwindsetup.css` only; no new tokens.
- Never lower an existing step's bar; add lettered sub-steps (e.g. `6c`) rather than renumbering steps other
  scenarios or docs cite.
- Lint/format only the files you touched; keep prettier off `scripts/*.mjs`.
- Never stop `wave-tauri.exe` / `wavesrv.x64.exe` by image name; never touch the user's packaged Arc.
- Measure-first items (F6, F8): report the measured numbers in your completion note whatever they show.

## Review Focus

- F1: a pin removed by the user during an in-flight load must stay removed (the "sent" rule must not resurrect
  it); Task 2's test pins this.
- F4: a run that is not an engine child must still open its own sheet exactly as before; Task 5's test pins it.
- F10: with no `numstaterror`, every count renders exactly as today; the existing `gitstatus.test.ts` cases and
  every `GitChanges` literal in other tests (`cardgitstore.test.ts`, `comparerows.test.ts`) stay valid unchanged,
  which is why `lineCounts` is optional.
- F13: stderr with no `fatal:`/`error:` line (only warnings) still shows something, never an empty line.
- F16: deleting a channel with no runs or dags must not error.

---

### Task 1: DeleteChannel evicts the shared runs and dags it deletes
**Depends on:** none
**Chunk:** wstore shared run reader: DeleteChannel's bulk DELETE FROM db_run does not evict GetAllRunsShared entries (DBDelete does). Only a run re-inserted under the same oid and version would read stale; fresh UUIDs make that unlikely.
**Files:** `pkg/wstore/wstore_dbops.go`, `pkg/wstore/wstore_channel.go`, `pkg/wstore/wstore_channel_test.go`

Spec D13.

- [ ] Write the failing tests in `wstore_channel_test.go`:
  `TestDeleteChannelEvictsSharedRuns`: create a channel and a run in it, read it with `GetAllRunsShared`,
  `DeleteChannel`, re-insert a run with the same oid at the same version but a different goal, then
  `GetAllRunsShared` returns the new goal. `TestDeleteChannelEvictsSharedDags`: the same with a dag in the channel
  read through `GetDagShared`. `TestDeleteChannelEmpty`: deleting a channel with no runs or dags returns nil.
- [ ] Run `go test ./pkg/wstore -run '^TestDeleteChannel(EvictsSharedRuns|EvictsSharedDags|Empty)$'`: the two
  evict tests fail.
- [ ] Add `forgetShared(otype string, ids ...string)` in `wstore_dbops.go`; `DBDelete` uses it for its own
  eviction. Update the `sharedObjs` comment (it no longer says a bulk delete leaves entries).
- [ ] `DeleteChannel` selects the oids of the channel's `db_run` and `db_dag` rows inside its tx, before the
  deletes, and calls `forgetShared` for each type after the tx returns without error.
- [ ] Run the three tests again: pass.

### Task 2: Sessions pins survive an in-flight archive load
**Depends on:** none
**Chunk:** Sessions pins: if a real archive load is in flight when restoreSessions (scripts/cdp/sessions-page-fixtures.mjs) runs, its reload is skipped by the loading guard in sessionsarchivestore.ts, and the in-flight load's prune can drop restored pins older than the 30-day window. Closing it needs app code (e.g. prune against the pins sent with the load).
**Files:** `frontend/app/view/agents/sessionspins.ts`, `frontend/app/view/agents/sessionspins.test.ts`, `frontend/app/view/agents/sessionsarchivestore.ts`, `frontend/app/view/agents/sessionsarchivestore.test.ts`, `scripts/cdp/scenarios-sessions.mjs`, `scripts/cdp/sessions-page-fixtures.mjs`

Spec D1.

- [ ] `sessionspins.test.ts`, failing first: `prunePins(pins, sessions, sent)` with sent `[a]`, current `[a, b]`,
  sessions returning neither → `[b]`; sent `[a, b]`, current `[b]` (the user unpinned `a` mid-load), sessions
  returning `b` → `[b]` (an unpin is not undone); sent `[a]`, current `[a]`, sessions returning `a` → the same
  array instance (unchanged identity, as today).
- [ ] `prunePins(pins: string[], sessions: SessionActivity[], sent: readonly string[]): string[]`: drop a pin only
  when it is in `sent` and no session matches it. Update every caller.
- [ ] `loadSessionsArchive`: keep the pins it sends and prune with them; a call that meets the `loading` guard sets
  a pending flag, and when the in-flight load ends the load runs once more if the flag is set.
  `sessionsarchivestore.test.ts`: a second call during a held load triggers exactly one more
  `GetSessionsActivityCommand` after the first resolves.
- [ ] `sessions-pin` step (lettered after its last step): with the fixture's archive read held, set the pins to
  include a key the held load will not return, release the load, and assert the pin is still in
  `sessionsPinnedAtom` and that a second read was made. Restore the pins in teardown.
- [ ] Run `npx vitest run frontend/app/view/agents/sessionspins.test.ts frontend/app/view/agents/sessionsarchivestore.test.ts`,
  then the `sessions-pin` scenario in an isolated app: every step passes.

### Task 3: Code tree duplicate-name check is a tested function, tried live
**Depends on:** none
**Chunk:** Code tree: the new-folder/rename duplicate check that counts session folders (codetreepane.tsx, inline) has no unit test and was not tried in the live app
**Files:** `frontend/app/view/code/codemutate.ts`, `frontend/app/view/code/codemutate.test.ts`, `frontend/app/view/code/codetreepane.tsx`, `scripts/cdp/scenarios-code-session.mjs`

Spec D2.

- [ ] `codemutate.test.ts`, failing first: `existingTreePaths(["src/a.ts"], ["src/empty"])` contains both;
  `validateName("empty", "src", existingTreePaths(["src/a.ts"], ["src/empty"]))` is `"exists"`;
  `validateName("a.ts", "src", existingTreePaths(["src/a.ts"], []))` is `"exists"`; a fresh name is `null`.
- [ ] `existingTreePaths(indexPaths: readonly string[], sessionDirs: readonly string[]): string[]` in
  `codemutate.ts`; `codetreepane.tsx` uses it in place of its inline merge (keep the `useMemo`).
- [ ] `code-session` step after step 3: New folder again with the name of the folder step 3 made shows the
  "exists" message (`nameErrorMessage("exists")`) beside `[data-code-name-input]`, Enter creates no second row,
  Escape cancels.
- [ ] Run `npx vitest run frontend/app/view/code/codemutate.test.ts`, then `code-session` in an isolated app: all
  steps pass.

### Task 4: Usage scenarios: By work failure, Cockpit after Esc, app-bar search with two providers
**Depends on:** none
**Chunk:** usage-states: add a By work step for a failed range switch (dashed project/initiative share pills, hidden other-folders note); only the provider lens is exercised today. usage-work step 18 could also assert the Cockpit shows after Esc
**Chunk:** App-bar search: with two usage providers reporting, the meters are wider than with one, and near 1200px the search can fall back to its 160px floor. Measure it with two providers.
**Files:** `scripts/cdp/scenarios-usage.mjs`, `frontend/app/cockpit/app-bar.tsx`, `frontend/app/view/agents/usagemeters.tsx`

Spec D3, D7 (F8).

- [ ] `usage-states` gains a By work step: switch to By work, make the range switch's read reject (stub it in the
  page, as the provider-lens failure step does), and assert the project and initiative share pills draw dashed
  and the other-folders note is absent. Restore the stub.
- [ ] `usage-work` step 18 also asserts the Cockpit surface is the shown surface after the final Esc.
- [ ] F8 measure: with a two-provider fixture (Claude plus Codex `planUsageAtom` donuts), read
  `[data-app-search]`'s rendered width at 1200, 1366 and 1440 wide. Report the three numbers.
- [ ] If the search sits at 160 px at any of the three: the meters drop their text labels under an `@container`
  breakpoint of the app bar (the bar already is `@container`) so the search clears its floor at all three; no new
  tokens. If not, change no app code.
- [ ] `usage-charts` step: with the two-provider fixture, at 1200, 1366 and 1440 the search is wider than 160 px;
  the detail lists the widths.
- [ ] Run `usage-charts usage-states usage-work` in an isolated app: all steps pass.

### Task 5: A hidden run opened by oref lands on its owner's sheet
**Depends on:** none
**Chunk:** Opening a hidden (non-lead) run by oref, e.g. run:f53d3936, lands on another run's sheet (openref.ts). Records no longer link such runs; entry in docs/open-issues.md.
**Files:** `frontend/app/view/jarvis/openref.ts`, `frontend/app/view/jarvis/openref.test.ts`, `scripts/cdp/scenarios-runs.mjs`, `docs/open-issues.md`

Spec D4 (revised). The channel's run list is NOT filtered (`GetChannelRunChanges` returns every run), so the
cause is unknown: reproduce first. In an isolated app, open `run:<id>` of an engine child (a run with `stagerole`,
then one with `taskid`) and find which sheet shows and why; put the cause in your completion note. The hidden
predicate is `isEngineChild` (`frontend/app/cockpit/palette-data.ts:30`), imported, not copied or edited; owner
resolution reuses `runRoleOf` (`frontend/app/view/agents/runlineage.ts:78`) and the dag's owning run, imported,
not edited. Note step 10 of `dag-lifecycle` already opens a task-child stand-in onto its own sheet with "Open in
the run's DAG"; if the cause shows a task child's own sheet is correct, keep that behavior for task children and
apply the owner rule to the cases that do land on a stranger's sheet, and say so in your note.

- [ ] `openref.test.ts`, failing first: opening `run:<engine child that lands wrong today>` resolves its owner's
  sheet (owner's channel and run id); `run:<run that is not an engine child>` resolves its own sheet as before; an
  engine child whose owner cannot be resolved returns not-ok with "That run is part of another run and has no
  sheet of its own" and selects nothing.
- [ ] Fix the cause through a pure resolver beside `loadRun`.
- [ ] `dag-lifecycle` step (after step 12): make the engine child kind that reproduced (the stand-in pattern of
  step 10), open `run:<its id>`, and assert the sheet shown is the owner's (its run id), never another run's.
- [ ] Remove the "Opening a hidden run by oref lands on another run's sheet" entry from `docs/open-issues.md`.
- [ ] Run `npx vitest run frontend/app/view/jarvis/openref.test.ts`, then `dag-lifecycle` in an isolated app.

### Task 6: Brainstorm pane: approve bar keeps its buttons on one row; refused sends show a toast
**Depends on:** none
**Chunk:** Brainstorm approve bar: at mid widths the blocker text can push Approve and its sibling onto a second row (harmless, wraps rather than overflows).
**Chunk:** Snapshot: brainstorm keyboard sends (bindings.ts sendBrainstorm(...).catch(console.warn)) and brainstormsend.ts notifyRun swallow a refused agent prompt into a console warning only
**Files:** `frontend/app/view/agents/brainstormcheck.tsx`, `frontend/app/view/agents/brainstormsend.ts`, `frontend/app/view/agents/brainstormsend.test.ts`, `frontend/app/store/keybindings/bindings.ts`, `scripts/cdp/scenarios-brainstorm-review.mjs`

Spec D5, D6.

- [ ] `ApproveBar`: row one holds the text column (`min-w-0`, truncating) and the two buttons (`flex-none`, never
  wrapping); the blocker, when present, is a second full-width row that wraps on its own. No blocker: one row.
- [ ] `brainstormsend.test.ts`, failing first: `reportSendFailure(agentId, err)` calls `pushToast` once with level
  `error` and the error's message; `notifyRun` with a rejecting send calls it (not `console.warn`).
- [ ] `reportSendFailure` in `brainstormsend.ts` (precedent: `recordactions.ts` `reportFailure`); `notifyRun` and
  `bindings.ts:951` use it.
- [ ] `brainstorm-check-review` steps: at 1000 and at 1600 wide with a blocker shown, `[data-brainstorm-approve]`
  and Keep talking share one top edge (±1 px) and `[data-brainstorm-approve-reason]` sits below them; with the
  agent prompt RPC stubbed to reject, a review send key raises an error toast with the refusal text (restore the
  stub).
- [ ] Run `npx vitest run frontend/app/view/agents/brainstormsend.test.ts`, then `brainstorm-check-review` in an
  isolated app.

### Task 7: Cockpit card Finished strip threshold, bisected
**Depends on:** none
**Chunk:** Cockpit card Finished strip: the 330px narrow threshold sits between the measured 279px and 579px cards. A card between 330px and about 360px may still clip Open slightly; bisect the threshold.
**Files:** `frontend/app/view/agents/agentrow.tsx`, `scripts/cdp/scenarios-cockpit-card.mjs`

Spec D7 (F6).

- [ ] In an isolated app, with a finished card, bisect the card width (330-400 px) at which the Finished strip's
  Open button is clipped while its button words show. Report the widths tried and the result.
- [ ] Set `NARROW_HIDE` to the first width where Open does not clip, rounded up to the next 10 px; if 330 already
  holds, keep it.
- [ ] `cockpit-card-layout` steps at a card width just below and just above the threshold (331 and 360 if it stays
  330): Open's right edge is inside the card's and not clipped by its strip.
- [ ] Run `cockpit-card-layout` in an isolated app.

### Task 8: Agent scenarios: resmon-footer with the remote chip, agent-tree-rail that scrolls
**Depends on:** none
**Chunk:** resmon-footer steps 6 and 6b were only seen with remote mode off, because the Final app has no remote chip. With the chip present they are settled only by reading the code. Add a fixture with the remote chip shown.
**Chunk:** agent-tree-rail step 10 (F20 avatar room) never scrolls: the fixture roster fits, so the padding is proven only by the roomEnds geometry and the step was never seen failing against the unpadded tree. A longer fixture roster would make the scroll part real.
**Files:** `scripts/cdp/scenarios-agent.mjs`, `scripts/cdp/agent-page-fixtures.mjs`, `scripts/cockpit-fixtures/scenarios.mjs`, `frontend/app/view/agents/agenttree.tsx`

Spec D8. No app code lands: `agenttree.tsx` is listed only for the temporary padding removal below, which must be
restored before completing (its diff in your commit is empty). The longer roster goes in `COCKPIT_FIXTURES`
(`scripts/cockpit-fixtures/scenarios.mjs`), where the `agent-tree-rail` roster comes from. If a step fails against
the app, report it as a finding, do not fix app code here.

- [ ] `resmon-footer`: a fixture shows `[data-remote-pill]` by setting the state it reads (never turning remote mode
  on); steps 6 and 6b run again with it shown as `6c`/`6d`; teardown restores the state.
- [ ] `agent-tree-rail` step 10: a roster long enough that the tree scrolls; scroll to the end and assert the last
  row clears the avatar.
- [ ] Remove the tree's avatar-room padding locally (`agenttree.tsx`, the `paddingBottom: AVATAR_SURFACE_REACH_PX + 20`
  style), run `agent-tree-rail`, record that step 10 fails (put the
  detail in your completion note), restore the padding.
- [ ] Run `resmon-footer agent-tree-rail` in an isolated app: all steps pass.

### Task 9: Run jira-post; drop remark-flexible-toc
**Depends on:** none
**Chunk:** jira-post scenario step 1 now expects 'Post to Jira' but was not run live (not in this run's Final)
**Chunk:** Drop the unused remark-flexible-toc dependency from package.json (TOC removed in F13; nothing imports it)
**Files:** `scripts/cdp/scenarios-jira-post.mjs`, `package.json`, `package-lock.json`

Spec D9.

- [ ] Run `jira-post` in an isolated app; if step 1 fails, fix the step's selector or expectation to the app's real
  'Post to Jira' control (the app is the reference), and run it again until it passes.
- [ ] Grep every reference to `remark-flexible-toc` (imports, `import type`, config, scripts, docs). Remove it from
  `package.json`, then `npm install --package-lock-only --ignore-scripts`, which rewrites the lockfile only. Do
  not run a plain `npm install` (it would rewrite the junctioned main checkout's `node_modules`).
- [ ] `task check:ts` passes.

### Task 10: Uncountable files show no line counts in the rail, Code and peeks
**Depends on:** none
**Chunk:** GitChangesCommand callers ignore numstaterror and can show +0 -0 for uncountable files: railstore, agentbranchstore, newagentmodal, codestore, codepeekstore, peekagent
**Files:** `frontend/app/view/agents/gitstatus.ts`, `frontend/app/view/agents/gitstatus.test.ts`, `frontend/app/view/agents/railstore.ts`, `frontend/app/view/agents/agentdetailsrail.tsx`, `frontend/app/view/code/codestore.ts`, `frontend/app/view/code/codestatus.ts`, `frontend/app/view/code/codestatus.test.ts`, `frontend/app/view/code/codechangedpane.tsx`, `frontend/app/view/code/codepeekstore.ts`, `frontend/app/view/code/codepeekcard.tsx`, `frontend/app/view/jarvis/peek/peekagent.tsx`, `scripts/cdp/scenarios-code-diff-states.mjs`

Spec D10 (revised). `agentbranchstore` and `newagentmodal` read only the branch, and `comparestore` /
`githistorystore` read commit ranges where a numstat failure fails the read: no change in any of them.

- [ ] `gitstatus.test.ts`, failing first: `parseGitChanges(statusZ, numstat, "fatal: cannot hash x")` lists every
  status file and has `lineCounts: false`; `lineCountsShown` of it is false, and of a result with no `lineCounts`
  key is true. Without the third argument (or with `""`) the result has no `lineCounts` key, so the existing
  cases (including the `toEqual({ files: [], adds: 0, dels: 0 })` one) pass unchanged.
- [ ] `GitChanges` gains optional `lineCounts?: false` (absent = known);
  `parseGitChanges(statusZ: string, numstat: string, numstatError?: string): GitChanges`;
  `lineCountsShown(changes: { lineCounts?: false } | null | undefined): boolean` in `gitstatus.ts`.
- [ ] `codestatus.ts` `statusByPath` carries the flag through to `codeStatusAtom` (a test in `codestatus.test.ts`:
  counts are reported unknown when the input has `lineCounts: false`).
- [ ] The four counting callers pass `numstaterror`; `agentdetailsrail.tsx`, `codechangedpane.tsx`,
  `codepeekcard.tsx` and `peekagent.tsx` ask `lineCountsShown` and render no `+N`/`−N` (per file or total) when it
  is false. Code peek's `{adds, dels}` result becomes `null` in that case (read how the card treats `null`).
- [ ] `code-diff-states` step: deny read on one modified file (`icacls /deny <user>:(RD)`, as `diff-states` step 7
  does, removed in a `finally`), refresh, and assert the Code changed pane lists that file with no `+`/`−` count,
  and the Code peek opened on that file shows no `+`/`−` stat.
- [ ] The Agent details rail and the Hub agent peek are proven by the `lineCountsShown` tests only (they need a
  live agent in a repo with an unreadable file); say so in your completion note.
- [ ] Run `npx vitest run frontend/app/view/agents/gitstatus.test.ts frontend/app/view/code/codestatus.test.ts`,
  then `code-diff-states` in an isolated app.

### Task 11: diff-states: the notice leads with git's error, and the arrange waits for readiness
**Depends on:** none
**Chunk:** Diff 'Line counts unavailable' notice shows git's stderr in order, so a leading CRLF warning fills the truncated line ahead of the 'fatal: cannot hash' line
**Chunk:** diff-states flakes in a fresh Final dev app under backend warm-up: createproject arrange left 'No projects yet' (t-12), step 11 agent never started (t-11)
**Files:** `frontend/app/view/agents/gitfailure.ts`, `frontend/app/view/agents/gitfailure.test.ts`, `frontend/app/view/agents/gitstatepanels.tsx`, `scripts/cdp/scenarios-files-states.mjs`

Spec D11, D12.

- [ ] `gitfailure.test.ts`, failing first: `failureHeadline("warning: in the working copy of 'a', LF will be replaced by CRLF\nfatal: cannot hash a")`
  is the `fatal:` line; `"error: x\nfatal: y"` → `"error: x"`; `"warning: w\nplain"` → `"plain"`;
  `"warning: only"` → `"warning: only"`; `""` → `""`.
- [ ] `failureHeadline(stderr: string): string` in `gitfailure.ts`; `GitFailureNotice` shows it (falling back to the
  exit label when empty) and keeps the whole stderr in its `title`.
- [ ] `diff-states` step 7 also asserts the Line counts notice's visible line starts with `fatal:` or `error:`; if
  the seeded repo prints no warning ahead of git's error, seed one (a CRLF file under `core.autocrlf`) so the
  order is tested.
- [ ] `diff-states` arrange: after `createproject`, wait (bounded, e.g. 30 s) until the app lists the project before
  reloading; step 11 waits (bounded, e.g. 60 s) until its agent's controller reports started before acting. A
  timeout fails with what was seen. No step's bar is lowered.
- [ ] Run `npx vitest run frontend/app/view/agents/gitfailure.test.ts`, then `diff-states` in an isolated app:
  all steps pass.

### Task 12: brief-profile drives a partial save
**Depends on:** none
**Chunk:** Profile modal: a save that fails part-way (global lands, project refused) is covered by the saveScopes unit test and by reading, never driven live in brief-profile.
**Files:** `scripts/cdp/scenarios-brief.mjs`

Spec D14. Scenario-only; if the app misbehaves, report it, do not fix app code here.

- [ ] `brief-profile` step: stub the project scope's profile save to reject (in the page, restored after), edit
  both scopes, save, and assert the global scope reads saved and its stored value is the new one, the project
  scope stays dirty, and the footer shows the refusal.
- [ ] Run `brief-profile` in an isolated app: all steps pass.
