# Usage attribution implementation plan

**Spec:** `docs/superpowers/specs/2026-10-08-usage-attribution-design.md` Read it first: it is the design, and every task's requirements include it. Where it and this plan differ, this plan wins (the differences are listed under Decisions).
**Verify:** `node scripts/verify.mjs ./pkg/usagestats ./pkg/agentsessions ./pkg/pisession ./pkg/wstore ./pkg/wshrpc/... ./pkg/jarvis`
**Check:** `go vet ./pkg/usagestats/ ./pkg/agentsessions/ ./pkg/wstore/ ./pkg/wshrpc/... && node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs usage-charts usage-work run-cost`
**Prototype:** C:/Users/kael02/IdeaProjects/waveterm/.superpowers/design/usage-attribution/project/Main.dc.html

## Goal and shape

The Usage surface learns what usage was spent on. The usage scan keys its buckets by session and returns a
session directory; `GetUsageStatsCommand` links each claude and pi session to its run and project; the Usage
surface gains a By provider | By work switch with project, run and session pages; run surfaces show the
API-equivalent estimate of a run's tokens.

Tasks 1, 2 and 4 start together. Task 3 joins the scan and the wire types. Task 5 needs only the generated
TypeScript types, so it runs beside Task 3. Task 6 writes the scenarios once both frontends are in.

The mockup folder holds two boards and both are the spec for layout and copy: `Main.dc.html` (the Usage
surface; interactive, its `renderVals` is the reference for every label, sentence, count and fold rule) and
`RunCost.dc.html` (run surfaces). The folder is gitignored and lives only in the main checkout, at the absolute
path on the Prototype line: read it there.

## Decisions (approved; they settle what the spec and mockup leave open)

- Frontend files stay in `frontend/app/view/agents`. The spec's `frontend/app/view/usage` does not exist.
- Run rail follows `RunCost.dc.html`: the Tokens row keeps "35.6M tok · 93% cached" and a new Cost row reads
  "≈ $29.11 API-equiv". `usageText` appends "≈ $x" (DAG header and task rail). Run sheet and peek meta read
  "35.6M tok · ≈ $29.11". The cockpit card keeps tokens only. The per-role panel on that board is not built.
- The estimate covers priced rows only. A run with no priced model shows no "≈" anywhere, never "≈ $0.00".
- A session page has no open button, though the mockup draws "Open session".
- `UsageSession.Role` uses the run rail's vocabulary, `jarvis.UsageRole`: lead, worker, reviewer,
  plan-reviewer, verifier. The owning run comes from `runLinkOf`. `SessionActivity`'s "review" is left alone.
- A quick run's session links to its own run with `runmode` quick and no role. `runLinkOf` does not place it,
  so the usage directory handles that one case itself.
- `wstore.GetRunsBySessionIds` matches `leadsessionids` entries too. This also makes the Sessions activity link
  a lead's earlier sessions to its run, which is wanted.
- A project is keyed by its repo root path and labelled by its folder name.
- The dev fixture `wave:dev-usage-buckets` becomes one object `{buckets, sessions}`. The bare-array form is
  dropped.
- By work resets to All usage when the window changes or the selected project leaves the rail.
- No new design tokens. Every color maps onto an existing `@theme` token in `frontend/tailwindsetup.css`; the
  mockup's hex values are those tokens' values. No raw hex or rgba in components.
- Personal-use app: no extra empty states, onboarding or settings beyond what the mockup shows.

## Global constraints

- Never hand-edit generated files (`frontend/types/gotypes.d.ts` and the others AGENTS.md lists). Change the Go
  type and run `task generate`.
- Do not run `npx tsc`, `task check:ts` or `task dev` in the worktree: typecheck with the Check line's
  `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`.
- TypeScript here is non-strict: an ok-union does not narrow, so test a discriminated result with
  `"field" in value`.
- Comments say why, never what, lower case, only when needed. No attribution trailer in any commit.
- Testable logic is a pure `foo.ts` with `foo.test.ts` beside it; no jsdom render tests.
- Dedupe stays corpus-wide and before bucketing: no existing usage total may move.

### Task 1: Session key and session metadata in the usage scan
**Depends on:** none
**Files:** `pkg/usagestats/usagestats.go`, `pkg/usagestats/usagestats_test.go`, `pkg/usagestats/pi.go`, `pkg/usagestats/pi_test.go`, `pkg/agentsessions/agentsessions.go`, `pkg/agentsessions/humanprompts.go`, `pkg/pisession/pisession.go`, `pkg/pisession/pisession_test.go`, `pkg/wshrpc/wshserver/wshserver_agents.go`

Implements the spec's "Data model and scan" section.

Design:

- `Record` and `Bucket` gain `Session string`. `bucket()` keys by harness, provider, model, day and session.
- The session id comes from the file's path, per the spec: claude is the second path segment under the
  projects root minus `.jsonl` (so `<slug>/<id>/subagents/*.jsonl` folds into `<id>`); pi is the id after the
  last `_` of the second path segment under the sessions root (subagent sessions under the parent's stem dir
  fold into the parent); codex is the rollout file's base name; opencode is the `storage/message/<sessionID>/`
  dir name. Derive it once per file from the path and the walked root, and stamp it on that file's records.
- The per-file `parseCache` entry also keeps the session's cwd and title, read in the same parse: claude `cwd`
  and `aiTitle`; pi session header `cwd` and its title (the session name, else the first user line); codex
  `session_meta.cwd`; opencode `storage/session` `directory` and `title`. A subagent file contributes records
  but never overrides its parent's cwd or title.
- `pkg/agentsessions` already imports `pkg/usagestats`, so usagestats cannot import it. Where the
  recent-sessions scan already has the reading you need (pi's `piBranchMeta` and `piUserText`), move it to a
  package both import (`pkg/pisession`) and call it from both. Do not write a second parser for the same field.
  `pkg/agentsessions/humanprompts.go` also calls `piUserText`: update that call when it moves.
- `SumTranscript`, `TranscriptUsage`, `LastCacheWrite` and `WindowTokens` keep their signatures and results.

Interface other tasks rely on:

- `type SessionMeta struct { Harness, Session, Cwd, Title string }`
- `func ScanUsage(windowDays int) ([]Bucket, []SessionMeta, error)`: the buckets, and one `SessionMeta` per
  (harness, session) that has a bucket in the window. Cwd and Title may be empty.
- `Bucket.Session`.
- In `wshserver_agents.go` change only the `ScanUsage` call site so the package compiles (ignore the new
  return). Task 3 owns the rest of that handler.

Acceptance, each a focused test in `pkg/usagestats`:

- `TestBucketSessionSumsMatchOldKey`: over a fixture corpus with several sessions per model and day, summing
  the new buckets across sessions equals, field for field, what the old four-part key produced.
- `TestSessionKeyPerHarness`: the session id for each harness layout above, including a claude
  `subagents/*.jsonl` file and a pi subagent session, both folding into the parent.
- `TestMessageInTwoFilesCountedOnce`: one message id present in two session files is counted once in total.
- `TestScanSessionMeta`: `ScanUsage`'s directory lists exactly the sessions with a bucket in the window, with
  cwd and title per harness, and a session whose only in-window usage is in a subagent file still carries the
  parent's cwd.
- `TestParseCacheKeepsMeta`: a second scan of an unchanged file returns the same cwd and title without
  re-reading it.
- Existing tests in `pkg/usagestats`, `pkg/agentsessions` and `pkg/pisession` still pass.

Run: `go test ./pkg/usagestats -run 'TestBucketSessionSumsMatchOldKey|TestSessionKeyPerHarness|TestMessageInTwoFilesCountedOnce|TestScanSessionMeta|TestParseCacheKeepsMeta'`

### Task 2: Wire types and run lookup by any lead session
**Depends on:** none
**Files:** `pkg/wshrpc/wshrpctypes.go`, `pkg/wshrpc/wshrpctypes_agents.go`, `frontend/types/gotypes.d.ts`, `pkg/wstore/wstore_channel.go`, `pkg/wstore/wstore_channel_test.go`, `pkg/wshrpc/wshserver/sessionruns.go`, `pkg/wshrpc/wshserver/sessionruns_test.go`

Implements the type half of the spec's "RPC" section and the store lookup it needs.

Design:

- `wshrpc.UsageBucket` gains `Session string` with json `session,omitempty`.
- `wshrpc.UsageSession` exactly as the spec's Go block: `harness`, `session`, and omitempty `title`,
  `project`, `runid`, `channelid`, `rungoal`, `runmode`, `role`, `taskid`.
- `CommandGetUsageStatsRtnData` gains `Sessions []UsageSession` with json `sessions`.
- Run `task generate`; commit the regenerated `frontend/types/gotypes.d.ts`. No command signature changes, so
  the other generated files should come out unchanged; if one does change, stop and report it instead of
  committing it, since it is not in this task's Files.
- `wstore.GetRunsBySessionIds` returns the runs whose `sessionid` is one of the ids or whose `leadsessionids`
  array holds one. Extend the one function; do not add a sibling. Still a pure read.
- In `sessionruns.go`, add `runsBySession(ctx, ids []string) (map[string]*waveobj.Run, error)`: each requested
  id mapped to its run, by `SessionId` or by a `LeadSessionIds` entry. `linkSessionsToRuns` uses it in place of
  its own `bySession` map. Task 3 uses it too.

Acceptance:

- `TestGetRunsBySessionIds` (extend the existing test in `pkg/wstore`): a run found by its `sessionid`, a run
  found by a `leadsessionids` entry that is not its `sessionid`, a run matching both returned once, an unknown
  id and a nil list returning none.
- `TestRunsBySession` in `pkg/wshrpc/wshserver`: the map carries both the current session id and an earlier
  lead session id of one run, and nothing for an unlinked id.
- `TestLinkSessionsToRunsLeadSessionIds`: a `SessionActivity` whose id is an earlier lead session of an
  orchestrator run gets that run's id and role lead.
- The typecheck in Check passes with the regenerated types.

Run: `go test ./pkg/wstore -run '^TestGetRunsBySessionIds$'` and `go test ./pkg/wshrpc/wshserver -run 'TestRunsBySession|TestLinkSessionsToRuns'`

### Task 3: Session directory in GetUsageStatsCommand
**Depends on:** Task 1, Task 2
**Files:** `pkg/wshrpc/wshserver/wshserver_agents.go`, `pkg/wshrpc/wshserver/usagesessions.go`, `pkg/wshrpc/wshserver/usagesessions_test.go`

Implements the handler half of the spec's "RPC" section.

Consumes: `usagestats.ScanUsage` and `usagestats.SessionMeta` (Task 1); `wshrpc.UsageSession`,
`UsageBucket.Session`, `CommandGetUsageStatsRtnData.Sessions` and `runsBySession` (Task 2); the existing
`runLinkOf` and `jarvis.UsageRole`.

Design:

- `usageBucketToWire` copies `Session`. `GetUsageStatsCommand` returns the buckets and the directory.
- `usagesessions.go` holds `usageSessions(ctx, metas []usagestats.SessionMeta) []wshrpc.UsageSession`: one
  entry per meta, harness, session and title copied through.
- Run fields are filled for claude and pi sessions only. For a session with a run:
  - Owner and task come from `runLinkOf` (a DAG child reports its DAG's owning run). Load each DAG and each
    owning run once per call.
  - `Role` is `jarvis.UsageRole(run)` of the session's own run, not `runLinkOf`'s role string.
  - A run `runLinkOf` does not place (a quick run) links to itself: its own id and channel, no role, no task.
  - `RunGoal` is the first line of the owning run's goal; `RunMode` is the owning run's mode.
- `Project` is the owning run's `ProjectPath` when linked, else the session cwd, in both cases with a trailing
  `/.worktrees/<x>` or `/.claude/worktrees/<x>` cut back to the repo root (either path separator). Any other
  cwd stays as it is. Empty cwd and no run leaves it empty.
- A store read failure is returned as an error from the command with context, as the handler does for the
  scan. A DAG that cannot be loaded is logged and its session left unlinked, as `linkSessionsToRuns` does.

Acceptance, focused tests in `usagesessions_test.go` on the package's real test store (follow
`sessionruns_test.go` and `wshserver_runusage_test.go` for fixtures):

- `TestUsageSessionsLead`: an orchestrator run's current session id: its run id, channel, mode orchestrator,
  role lead, goal's first line, project from `ProjectPath`.
- `TestUsageSessionsLeadEarlierSession`: a `leadsessionids` entry links the same way.
- `TestUsageSessionsWorkerAndReviewer`: a DAG worker and a DAG reviewer session report the owning run's id,
  goal and mode, their task id, and roles worker and reviewer; a stage session reports plan-reviewer or
  verifier.
- `TestUsageSessionsQuickRun`: a quick run's session links to itself with mode quick and an empty role.
- `TestUsageSessionsUnlinked`: a session with no run has no run fields and takes its project from the cwd.
- `TestUsageSessionsWorktreeCwdFoldsToRepo`: `<repo>/.worktrees/x` and `<repo>/.claude/worktrees/x`, with
  forward and back slashes, both give `<repo>`; a lane folder elsewhere is unchanged.
- `TestUsageSessionsCodexNotLinked`: a codex or opencode session id that happens to equal a run's session id
  gets no run fields.

Run: `go test ./pkg/wshrpc/wshserver -run 'TestUsageSessions'`

### Task 4: Estimated cost on run surfaces
**Depends on:** none
**Files:** `frontend/app/view/agents/runusage.ts`, `frontend/app/view/agents/runusage.test.ts`, `frontend/app/view/agents/runrailsections.tsx`, `frontend/app/view/jarvis/runsheet.tsx`, `frontend/app/view/jarvis/peek/peekrunmodel.ts`, `frontend/app/view/jarvis/peek/peekrunmodel.test.ts`

Implements the spec's "Run surfaces" section as amended under Decisions. Layout and copy:
`RunCost.dc.html` in the Prototype folder (boards 1, 3 and 4; board 2, the per-role panel, is not built).

Design:

- `runusage.ts` gains a pure estimate over `UsageRow`s using `priceFor` and the existing pricing functions in
  `usagepricing.ts`: reuse them (map a row to the record shape they take), do not write a second price
  calculation. `cachewrite1h` rows price at the 1-hour cache-write rate, as the Usage surface does.
- `UsageSummary` gains `estimateUsd?: number`: the sum over rows whose model is priced; undefined when no row
  in the summary is priced. Rows marked `missing` add nothing.
- `usageText(s, sealed)` appends "≈ $x" after the cached share when `estimateUsd` is defined, so the DAG header
  (`daggraph-header.tsx`) and the task rail (`dagdetailrail.tsx`) show it with no edit to those files. Dollar
  formatting is `usd` from `usagestats.ts`.
- Run rail (`runrailsections.tsx`): the Tokens row keeps "35.6M tok · 93% cached" with no estimate in it, and a
  Cost row directly under it reads "≈ $29.11 API-equiv". The Cost row carries `data-run-cost`. No Cost row
  when `estimateUsd` is undefined. Export what the two rows need from `runusage.ts` so `usageText` and the rail
  share one piece of formatting.
- Run sheet (`runsheet.tsx`): the meta line shows "35.6M tok · ≈ $29.11" from the run's usage (`useRunUsage`,
  `summarizeUsage`), in place of the live-workers `costusd` sum, which is removed along with anything only it
  used. The span carries `data-run-sheet-usage`. Tokens alone when there is no estimate; nothing when the run
  has no usage yet.
- Peek (`peekrunmodel.ts`): the run's meta entry reads "35.6M tok · ≈ $29.11". Task rows keep tokens only.
- The cockpit card is not touched.

Acceptance, focused vitest:

- `runusage.test.ts`: the estimate for rows on a priced model equals the pricing table's figure for those
  token classes, including a 1-hour cache write; rows on two models sum; an unpriced model adds nothing and a
  summary with only unpriced or missing rows has `estimateUsd` undefined; a task-scoped summary estimates only
  that task's rows; `usageText` with an estimate ends "· ≈ $29.11" (and still puts "N unreadable" where it did
  when sealed), and without one is unchanged from today.
- `peekrunmodel.test.ts`: the run meta carries "tok · ≈ $" for priced usage and tokens alone for unpriced.
- Rendered: the `run-cost` scenario (Task 6) shows the run sheet meta (step 1), the DAG header text (step 2), the
  peek meta (step 3) and the run rail Cost row (step 4).

Run: `npx vitest run frontend/app/view/agents/runusage.test.ts frontend/app/view/jarvis/peek/peekrunmodel.test.ts`

### Task 5: Usage surface By work
**Depends on:** Task 2
**Files:** `frontend/app/view/agents/usageattribution.ts`, `frontend/app/view/agents/usageattribution.test.ts`, `frontend/app/view/agents/usagestore.ts`, `frontend/app/view/agents/usagestore.test.ts`, `frontend/app/view/agents/usagesurface.tsx`, `frontend/app/view/agents/usagestats.ts`, `frontend/app/view/agents/usagestats.test.ts`, `frontend/app/view/agents/agents.tsx`

Implements the spec's "Usage surface" section. Layout and copy: `Main.dc.html` on the Prototype line. Its
`renderVals` is the reference for every string (rail titles and pills, header meta keys, card labels and subs,
list titles, meta, summary sentences, the "other folders" line, split notes, "Show top N" labels, "Back to").
Match it verbatim except where Decisions or the spec say otherwise.

Consumes: the generated `UsageBucket.session`, `UsageSession` and `sessions` on the RPC reply (Task 2). It does
not need Task 3: the store reads whatever the reply carries, and tests and the scenario use fixtures.

Design:

- `usagestore.ts`: `usageSessionsAtom` beside `usageBucketsAtom`, both set from one reply. The dev fixture is
  one object `{buckets, sessions}`; anything else falls through to the RPC. New atoms, because the surface
  unmounts on switch: the lens (`"provider" | "work"`, default provider), the By work scope (`"all"` or a
  project key), the drilled item key (or null) with the scope to go back to, and the list's expanded flag.
- `usageattribution.ts` (pure) builds, from buckets and the session directory:
  - Work items. A run (key `run:<runid>`) is every session whose directory entry names that run, lead, workers,
    reviewers and stage sessions together; a session with no run is its own item (key
    `session:<harness>:<session>`). Kind is orchestrator run, quick run or session. Title is the run's goal
    line, else the session title, else the session id. A bucket whose session is not in the directory is a
    session item with no project.
  - Projects, keyed by repo root path and labelled by folder name. A project gets a rail row when it holds at
    least 1% of the window's estimated spend, eight at most, ranked by spend; the rest, and items with no
    project, fold into "other folders" (count, tokens, spend), which still rank under All usage.
  - Scope aggregates for All usage, a project, a run and a session. Get them by filtering the buckets to the
    scope's sessions and calling the existing `aggregateBuckets`, so the header, stat cards, Daily chart and
    model groups are today's components fed a narrower set. Extend `usagestats.ts` only if a field the mockup
    shows is missing from `UsageStats`; do not fork the aggregation.
  - Splits by the next level down: projects (plus other folders) for All usage; orchestrator runs, quick runs
    and sessions no run started, each with its count, for a project; roles with their session counts for a
    run; token classes (today's split) for a single session, including a run of one session.
  - The ranked list: rows by estimated spend, then tokens. Where a row's scope has no priced tokens and its
    source reported a cost, the row shows the reported cost marked "reported".
- `usagesurface.tsx`:
  - Rail: "All usage" on top, then the By provider | By work switch, then the lens's rows. By provider is
    today's rail and today's detail page, pixel for pixel, with no work list.
  - By work detail page for All usage, a project, a run or a session: header, four stat cards (with "x% of all
    usage" and "x% of all spend" on a narrower scope), the ranked list, Where it goes, Daily, model groups. No
    Live limits section in By work.
  - One ranked list: "Spent on" for All usage, "Runs and sessions" for a project, "Sessions in this run" for a
    run with more than one session, none for a session. Eight rows, then the mockup's "Show top N" toggle up
    to 25. The run page's list has no summary sentence above it and its rows do not navigate.
  - A row on All usage or a project opens that run or session as the same page, with "Back to <scope>" above
    the header returning to where it was opened from.
  - A run page has "Open run", which calls `openTarget` from `frontend/app/view/jarvis/openref.ts` with the
    run's id and channel. A session page has no open button.
  - The split card for work scopes takes generic parts (label, color, tokens, spend); generalize the existing
    `SplitCard` rather than adding a second card. Part colors come from existing `@theme` tokens.
  - Changing the window, or a reload that drops the selected project from the rail, returns By work to All
    usage and clears the drilled item. Rail keyboard navigation (`useSurfaceListNav`) covers the rows of the
    lens on screen.
  - Selectors the scenarios use: `data-usage-lens="provider|work"` on the two switch buttons with
    `aria-pressed`; `data-usage-project="<project key>"` on each project rail row; `data-usage-harness` stays
    on provider rows and on All usage as today; `data-usage-detail` on the detail container holding the scope
    shown (`all`, a harness, `project:<key>`, or the item key); `data-usage-list` on the ranked list with
    `data-usage-item="<item key>"` on each row; `data-usage-more` on the toggle; `data-usage-back` on the back
    button; `data-usage-open-run` on Open run; `data-usage-split` on the Where it goes card with
    `data-usage-split-part` on each legend entry.
- `agents.tsx`: only if the view model's usage atoms need a change to feed the scoped stats; otherwise leave it.

Acceptance, focused vitest:

- `usageattribution.test.ts`:
  - a run's lead, two workers, a reviewer and a verifier session form one work item whose tokens and spend are
    their sum; an unlinked session is its own item; a quick run is kind quick run;
  - a bucket whose session is missing from the directory still counts, as a session with no project;
  - project cutoff: a project at exactly 1% of spend gets a row, one below does not; a ninth qualifying
    project folds; the fold's count, tokens and spend are right and its items still rank under All usage;
  - two repo paths with the same folder name stay two projects;
  - each scope's split: projects for All usage, the three kinds with counts for a project (a kind with nothing
    is left out), roles with counts for a run, token classes for a session and for a one-session run;
  - split parts sum to the scope's tokens and spend;
  - ranking by spend then tokens, and an unpriced session that reports cost shows that cost marked reported;
  - the scope aggregate for a project equals `aggregateBuckets` over that project's buckets, and All usage in
    By work equals today's all-provider totals;
  - an empty directory and empty buckets give no items, no projects and no throw.
- `usagestore.test.ts`: a `{buckets, sessions}` fixture fills both atoms; a bare array or malformed fixture
  falls through to the RPC; a superseded load sets neither atom; an RPC failure keeps the last sessions as it
  keeps the last buckets; the lens, scope and item atoms keep their values across a reload of the same window.
- Rendered: the `usage-work` scenario (Task 6) shows By work for All usage, a project, a run with Back, the window reset (step 8), Open run (step 10)
  and a single session; `usage-charts` (Task 6) still passes on By provider.

Run: `npx vitest run frontend/app/view/agents/usageattribution.test.ts frontend/app/view/agents/usagestore.test.ts frontend/app/view/agents/usagestats.test.ts`

### Task 6: CDP scenarios usage-work and run-cost
**Depends on:** Task 4, Task 5
**Files:** `scripts/cdp/scenarios.mjs`

The Final line runs `usage-charts`, `usage-work` and `run-cost`. Read `docs/reference/cdp-run-fixtures.md`
before the run fixture, and scope every query to a `data-*` container: a document-wide button or text query
hits the app bar. Pin the viewport as the other scenarios do before clicking by position or name. Wait for the
element a step is about, never for a fixed sleep, and record what was observed in the step's detail.

- `usage-charts`: `buildUsageFixture` returns `{buckets, sessions}`, each bucket with a `session`. Every
  existing step still passes unchanged on the By provider lens, which is the default. Add one step: the lens
  switch is present with By provider pressed, and the detail page shows no ranked list (`data-usage-list`
  absent).
- `usage-work` (surface `usage`), seeded through the same fixture key and restored in teardown like
  `usage-charts`. The fixture needs: two projects above 1% of spend and one folder below it; in the larger
  project one orchestrator run of at least four sessions (lead, two workers, a reviewer) on two models, one
  quick run, and unlinked sessions; one pi session on an unpriced model that reports cost; more than eight
  work items in total so the list has a toggle. Steps, each with a screenshot under `cdp-shots/`:
  1. By work, All usage: clicking `data-usage-lens="work"` shows the project rail rows with share pills, the
     "other folders" line, no Live limits section, the "Spent on" list with eight rows, and a Where it goes
     split whose parts are the projects.
  2. The toggle (`data-usage-more`) expands the list past eight rows and collapses it again.
  3. A project: clicking its rail row shows the project header, "x% of all usage" and "x% of all spend" on the
     stat cards, "Runs and sessions", and a split by orchestrator runs, quick runs and sessions no run started.
  4. A run: clicking the orchestrator run's row shows its page with "Back to <project>", "Open run", "Sessions
     in this run" listing its sessions with roles, and a split by role.
  5. Back returns to the project page with its list.
  6. A session: clicking an unlinked session's row from All usage shows a page with no ranked list, no open
     button, and the token-class split.
  7. The unpriced pi session's row shows its reported cost marked "reported".
  8. Window change: with a project selected in By work, clicking "All time" in the header returns the detail
     to All usage (`data-usage-detail="all"`, no project row pressed) with the lens still By work. Switch the
     window back to 7 days afterwards.
  9. Switching back to By provider restores today's rail (`data-usage-harness` rows) and the Live limits
     section.
  10. Open run, last because it leaves the surface: on the run page, clicking `data-usage-open-run` goes through
      `openTarget`. The fixture's run id names no stored run, so the step asserts what the router does with it
      and records it in the detail: the click reaches the router (the surface switches, or the router's failure
      notice shows) and no error is thrown on the page. If the router gives nothing observable for an unknown
      run, give the fixture run the id and channel of a run the scenario creates with `arrangeSheetDagRun`
      (torn down with `teardownFixtureRun`) and assert the surface leaves `usage` and that run's sheet opens.
- `run-cost` (surface `jarvis`). The Cost row lives in `UsageRows` of `RunSection` and `TaskSection`
  (`runrailsections.tsx`), which only `agentdetailsrail.tsx` mounts, on the Agent surface, for a selected agent
  with a run role. `arrangeSheetDagRun` defers the run's start, so there is no lead: the rail is reached through
  the dispatched worker of `t-1`.
  - Arrange: `arrangeSheetDagRun`, then `waitForDispatch` for `t-1` (as `attention` scenarios do) and record
    the worker in `ctx`. Seed `evidence.usage` on the run with `waveService` `object.UpdateObject`: rows on two
    priced models, at least one with `taskid` `t-1` and role worker, and one lead row with no task, so the run
    total and the task total differ. `useRunUsage` (`runtokenstore.ts`) loads at mount and then once a minute,
    and a DAG meta bump does not refetch it, so after seeding reload the page and reopen the run
    (`window.__openAddress("run:<id>")`) before any assert. Tear down with `teardownFixtureRun`.
  - Steps, each with a screenshot under `cdp-shots/`:
    1. Run sheet: the meta (`data-run-sheet-usage`) reads "<n> tok · ≈ $<x>", x being the figure all seeded
       rows price to.
    2. DAG header: open the DAG modal from the sheet (`[data-dag-modal-kind]`, as `dag-lifecycle` does) and
       assert, scoped to the modal, that the header's usage text ends "· ≈ $<x>". Close the modal.
    3. Peek: `window.__peekAddress("run:<id>")` (as `peek-item-views` does) shows the run peek whose meta holds
       "tok · ≈ $<x>". Close the peek.
    4. Run rail: go to the Agent surface, select the `t-1` worker, and in its Task section assert a Tokens row
       with no "≈" in it and a Cost row (`data-run-cost`) reading "≈ $<y> API-equiv", y being the figure the
       `t-1` rows alone price to.
- Add both new scenarios to `SCENARIOS`.

Acceptance: `node scripts/cdp/verify.mjs`'s scenario list names `usage-work` and `run-cost`
(`node -e "import('./scripts/cdp/scenarios.mjs').then(m => { const n = m.SCENARIOS.map(s => s.name); for (const want of ['usage-charts','usage-work','run-cost']) if (!n.includes(want)) { console.error('missing', want); process.exit(1); } })"`
exits 0), and `node --check scripts/cdp/scenarios.mjs` passes. The
scenarios themselves run in the Final stage against the merged app.
