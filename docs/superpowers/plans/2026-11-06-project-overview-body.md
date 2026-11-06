# Project Overview body: Activity, Running, Finished, Branches, History

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement your task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Effort:** effort:64c2895d-bb17-436f-9d68-115d0c0e5dd1
**Verify:** `node scripts/verify.mjs ./pkg/waveobj ./pkg/wshrpc/... ./cmd/wsh/cmd`
**Check:** `task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs project-overview`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\project-overview\project\Main.dc.html

**Goal:** Fill the project Overview modal's empty `[data-overview-body]` with the five regions the canvas draws (Activity, Running, Finished not read, Branches, History) and their empty, loading and failure states.

**Architecture:** `frontend/app/view/agents/projectoverview.tsx` (built in b4214c7f2) lays out four region slots; each region is a thin `.tsx` over a pure `.ts` model with a `.test.ts` beside it. Every region reads data Arc already has: the usage scan for Activity, the roster/lineage/Events rail for Running and Finished, the Diff surface's git history modules for Branches, and the Sessions archive plus the project channel's runs for History. The only backend change is one new `Run` field that links a run to the agent session that started it.

**Tech Stack:** React 19, jotai, Tailwind 4 `@theme` tokens, vitest; Go (`pkg/waveobj`, `pkg/wshrpc`, `cmd/wsh`); CDP scenario harness in `scripts/cdp/`.

## The design and what to read

The canvas is approved; do not reopen it. Read all three boards at their absolute paths (the folder is gitignored, so it is not in your worktree): `C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\project-overview\project\` has `Main.dc.html` (busy project), `Quiet.dc.html` (quiet project with no git: every region empty) and `Failures.dc.html` (reads that failed). The boards' names, numbers, paths and commit subjects are samples, not constants. Read `DESIGN.md`, `AGENTS.md` and the existing `projectoverview.tsx` before you start.

The canvas uses raw hex colors; map each onto the existing `@theme` tokens in `frontend/tailwindsetup.css` and never add a token. The mapping that matters: region labels are `REGION_LABEL` / `MONO_META` / `MONO_FAINT` from `frontend/app/view/jarvis/briefstyle.ts`, rows are `ROW_BORDER`, the bordered link is `LINK_BTN`, the Retry button is `SMALL_BTN`. The calendar ramp is exactly `edge-mid` (0), `accent-700`, `accent-500`, `accent-300`, `accent-100` (4). Dashed days use `border-edge-strong`, today's ring is `muted`, and the hovered or focused day's ring is `primary`. The error icon is `text-error`, and the uncommitted row is `text-warning`.

## Decisions beyond the design, and why

1. **Activity's day counts come from the existing usage scan, with no new table or migration.** `GetUsageStatsCommand` already returns buckets per (harness, model, local day, session) and a session directory with each session's `project` (repo root) and `channelid`. One call with `windowdays: 371` (53 weeks) gives tokens per day. The fork's per-day session table would duplicate what the transcripts already record. The call goes through `usagestore.ts`'s `fetchUsage`, now exported, so its DEV fixture seam (`wave:dev-usage-buckets` with `delayMs` / `fail`) drives the CDP states. Tokens are counted as `bucketTokens` (the Usage surface's definition), so the two surfaces agree.
2. **A session belongs to the project when its `project` path equals the registry path, or its `channelid` is the project's channel.** The second rule counts run workers, whose `project` is their `arc-wt` worktree, not the checkout. Paths compare normalized: slashes unified, trailing slash dropped, case-insensitive.
3. **"Before Arc tracked it" (dashed days) means days before the earlier of two dates:** the day the project's channel was created (`Channel.createdts`), and the first day the scan has usage for the project. The registry has no "tracked since" stamp. Transcripts can predate registration, and those days are real data, not unknown.
4. **Calendar levels are quartiles** of the project's non-zero days in the window: level 1 up to the 25th percentile, 2 up to the 50th, 3 up to the 75th, 4 above. A zero day is level 0. This matches the familiar contribution-calendar reading and needs no constant.
5. **Running is live work only.** It lists plain agents in state `working`, runs with a member at work, and terminals running a command. A terminal `AgentVM` is always `idle`, so whether it runs a command comes from its block's RT info: `shell:state === "running-command"`, with `shell:lastcmd` as its line. `osc-handlers.ts` writes both, and `RpcApi.GetRTInfoCommand` reads them for the project's terminals when the region opens. A shell without integration never shows as running. Asking agents are the Brief's Needs you, which the design removed on purpose. When Running and Finished are both empty they collapse into one "Now" region reading "Nothing runs in <project>." (Quiet and Failures boards).
6. **"Finished, not read" uses the Events rail's unread cursor; it does not add new unread tracking.** It shows the rail's fresh `finished` / `landed` events in the project, newest per agent or run. The rail's tracking (`useRailTracking`) moves from `cockpitsurface.tsx` into the always-mounted shell (`cockpit-root.tsx`): the modal opens over any surface, and a finish that happened while the Cockpit was unmounted would otherwise never be recorded. Run events (a run's `landed`) load only through `ensureRunEvents`, which `cockpitsurface.tsx` calls only while the Cockpit is mounted. `projectnow.tsx` therefore calls `ensureRunEvents(runId, channelId)` itself for the project's `lineage.runs` and reads their `runEventsAtom`. A run shows in Finished only while it is in the lineage (a member still in the roster), as it does in the rail. Opening the Overview does not mark anything read; the rail's "mark all read" stays the one way.
7. **A run nests under the session that started it through a new `Run.origintranscript` field.** `wsh runs start` sends its `WAVETERM_BLOCKID`, and `CreateRunCommand` stores that block's `agent:transcriptpath` on the run. Our `Run` had no such link; the fork had one. It is a field on an existing JSON object, not a store, so there is no migration. Runs started from the cockpit, and runs from before this change, have no origin. They sit top-level among the sessions by time, as do runs whose origin session is outside the window or still live.
8. **History lists only ended sessions** that are not run members, in the project, active in the last 7 days, newest first. Live sessions are Running's. Runs are the project channel's top-level runs (`GetChannelRunsCommand`, dropping runs with `taskid`, `stagerole` or `parentleadoref`) created in the last 7 days. Sessions come from the Sessions surface's archive (`loadSessionsArchive` / `sessionsArchiveAtom` / `sessionsErrorAtom`), so opening the Overview also warms the Sessions surface. Search is a case-insensitive substring match, not a regex, on a session's title or a nested run's title. A session whose child run matches stays, with all its children. Rows render 30 at a time, with more added when a sentinel at the list's end scrolls into view.
9. **Branches is the first page of `GitHistoryCommand` with no `ref`** (`git log --all --date-order`), limited to 10 commits, drawn with `assignLanes` + `graphGeometry` (`rowH: 28`, `maxLanes: 4`) + `GraphGutter`. The Diff surface's `githistorystore.ts` is not used for state. Its atoms are module-global for the one Diff surface, and the Overview must not clobber them. The region therefore calls the RPC itself and reuses the store's pure helpers (`buildRows`, `refChipClass`, `toRow`). The head count is the number of commit rows shown (the board's "9" over nine rows). The uncommitted row's file count is the header's existing git read, passed down rather than read twice.
10. **The tooltip appears only on hover or keyboard focus.** The board shows one open as a mockup still. The day grid is one tab stop (today), and the arrow keys move between days.
11. **The calendar legend always shows** whenever the calendar renders. The Quiet board leaves it out for brevity, but it still has colored days, and the legend is what explains them.
12. **Row targets:** a running agent or terminal opens on the Agent surface, and a run opens on the Cockpit, both through `openTarget` in `frontend/app/view/jarvis/openref.ts`. A finished row opens the same way as its agent or run. A commit row and "open in Diff ↗" both go through `openDiff(model, projectDiffScope(project, path))` from `agentdiffnav.ts`. That sets the Diff scope to this project's repo, whatever the Diff surface showed before. A commit row first records a pending commit link with a new `requestCommitLink`, which the Diff's own history load consumes, as a file link already is (Task 5). If the commit is not in the rows the Diff loads, the link is dropped and the Diff keeps its default selection. A session row opens the Sessions surface with it selected (`model.sessionsSelAtom`). A History run row opens the run. "older sessions in Sessions ↗" opens the Sessions surface; the project scope is already this project. Every navigation closes the modal.
13. **Failure copy names the real reason** (the error message, or `GitFailure.stderr`). It never uses the board's sample "timed out after 5s".

## Global Constraints

- `@theme` tokens only, no new tokens; Tailwind over SCSS.
- Pure `foo.ts` + `foo.test.ts` beside a thin `foo.tsx`; no render tests exist, so the CDP scenario is the UI check.
- Every region guards its async load against a stale result. The modal can close, or reopen on another project, before a read lands; use a live flag in the effect, as `useProjectGit` does.
- No "Needs you" section, no New agent / Terminal buttons, no councils, no Later bookmarks.
- Loading uses `SkeletonLine` / `SkeletonRows` from `@/app/element/skeleton`.
- Lint and format only the paths you touch (`npx eslint <paths>`, `npx prettier --check <paths>`); keep prettier off `scripts/*.mjs`.

## Review Focus

1. **The same project spelled differently** in the registry, a usage session's `project` and an archived session's `projectpath`: case, `\` vs `/`, trailing slash. It must still match. This is tested in Task 3 and Task 6.
2. **A run's worker tokens** live in an `arc-wt` worktree path, yet they count toward the project through the session's `channelid`. This is tested in Task 3.
3. **A run whose origin session is outside the 7-day window, live, or missing** still shows, top-level by time, never dropped. This is tested in Task 6.
4. **A project with exactly one active day, or none**, gets sane levels: no division by zero, and the single day is level 4. This is tested in Task 3.
5. **Today falling on a Monday or a Sunday:** the last column holds today, later days in that week are blank, and the grid is still 53 columns of 7 Monday-first rows. This is tested in Task 3.

---

### Task 1: Body layout, shared region parts, and the scenario's region hooks
**Depends on:** none
**Files:** `frontend/app/view/agents/projectoverview.tsx`, `frontend/app/view/agents/projectoverviewmodel.ts`, `frontend/app/view/agents/projectoverviewmodel.test.ts`, `frontend/app/view/agents/overviewregion.tsx`, `frontend/app/view/agents/projectactivity.tsx`, `frontend/app/view/agents/projectnow.tsx`, `frontend/app/view/agents/projectbranches.tsx`, `frontend/app/view/agents/projecthistory.tsx`, `scripts/cdp/scenarios-project-overview.mjs`, `scripts/cdp/project-overview-kit.mjs`, `scripts/cdp/project-overview-activity.mjs`, `scripts/cdp/project-overview-now.mjs`, `scripts/cdp/project-overview-branches.mjs`, `scripts/cdp/project-overview-history.mjs`

This task lays the body out so the four region tasks can each fill one file at the same time.

**Interfaces (produced, used by Tasks 3-6):**
- `projectoverviewmodel.ts` adds `samePath(a: string, b: string): boolean`. It unifies `\` and `/`, drops a trailing slash, and compares case-insensitively; an empty side never matches. Its test in `projectoverviewmodel.test.ts` covers `C:\Repo\X\` vs `c:/repo/x` (true), `C:\Repo\X` vs `C:\Repo\Xy` (false) and `""` vs `""` (false).
- `overviewregion.tsx` exports:
  - `type OverviewRegionProps = { model: AgentsViewModel; project: string; path: string; close: () => void }`
  - `RegionHead({ label, count?, aside? }: { label: string; count?: React.ReactNode; aside?: React.ReactNode })`: the board's head row. It draws the mono uppercase label, an optional count, a flexible 1px `edge-faint` rule, and an optional aside (a faint mono caption or a link).
  - `RegionNote({ children })`: the muted empty sentence (12.5px, `text-muted`, `px-[11px] py-1`).
  - `RegionAlert({ children, onRetry }: { children: React.ReactNode; onRetry: () => void })`: `role="alert"`, the error-tone circle icon, the text, and a Retry `SMALL_BTN`.
  - `RegionSkeleton({ rows }: { rows: number })`: the skeleton lines.
- Region components, each in its own file with this exact export, rendered by `projectoverview.tsx`:
  - `ProjectActivity(props: OverviewRegionProps)`
  - `ProjectNow(props: OverviewRegionProps)`
  - `ProjectBranches(props: OverviewRegionProps & { changedFiles: number })`
  - `ProjectHistory(props: OverviewRegionProps)`

  In this task each one renders only its `RegionHead` and a `RegionSkeleton`. Tasks 3-6 replace the bodies and keep the signature.
- Scenario: `scripts/cdp/project-overview-kit.mjs` takes `LIB`, `pageEval`, `shot`, `overview()` and an `openOverview(h, project)` helper out of `scenarios-project-overview.mjs`. `openOverview` sets the project scope, opens the modal through the switcher entry, and waits for `[data-project-overview="<project>"]` with its four `[data-overview-region]` wrappers. It never waits on `[data-overview-changes]`, which a non-git project never renders. A `closeOverview(h)` helper sets `model.projectOverviewAtom` to null. Each `project-overview-<region>.mjs` exports `async function steps(h, ctx): Promise<Step[]>` and `async function cleanup(h, ctx): Promise<void>`. In this task both return `[]` / do nothing.
  - `scenarios-project-overview.mjs` calls `activity`, `now`, `branches` and `history` steps in that order. It does so after its existing step 3 (modal open on `ctx.project`) and before step 4 (Escape), and calls every `cleanup` from `teardown`.
  - The contract each module keeps: it starts and ends with the modal open on `ctx.project`; it restores in a `finally` whatever fixtures or stubs it installed; and it names its steps `project-overview: <Board> board, <region>: <state>`.

**What to build:**
- [ ] The body follows the board: padding `18px 20px 22px`, a 26px gap, Activity full width on top, then a row with a 28px gap. That row has a left column at `flex: 2` (Now above Branches, 24px gap) and History on the right at `flex: 3`.
  - Each slot is wrapped in an element carrying `data-overview-region="activity" | "now" | "branches" | "history"`, owned here, so the region tasks can change their insides freely.
  - The body keeps `overflow-y-auto` inside the modal's `max-h-[84vh]`.
  - Thread `model` into `OverviewBody`, which has no such prop today. The regions need it.
  - The switcher offers only registered projects, and those all have a path, so there is no "no folder" state. With `path` undefined (a registry entry removed while the modal is open), the body renders no regions.
- [ ] Pass `changedFiles` (the header's `git?.files ?? 0`) to `ProjectBranches`.
- [ ] Scenario step (added in `scenarios-project-overview.mjs` right after step 3): `project-overview: Main board, body: Activity spans the top, Now and Branches left of History`. It asserts that the four `[data-overview-region]` wrappers exist and that Activity's box is above the others. It also asserts that Now's and Branches' boxes are left of History's, and that History's width is greater than Now's. It takes a screenshot.

**Acceptance:** `task check:ts` is clean. `node scripts/cdp/final-verify.mjs project-overview` passes all existing steps plus the new layout step in the dev app.

### Task 2: Record the agent session that started a run
**Depends on:** none
**Files:** `pkg/waveobj/wtype.go`, `pkg/wshrpc/wshrpctypes_runs.go`, `pkg/wshrpc/wshserver/wshserver_runs.go`, `pkg/wshrpc/wshserver/wshserver_run_test.go`, `cmd/wsh/cmd/wshcmd-runs.go`, `cmd/wsh/cmd/wshcmd-runs_test.go`, `frontend/types/gotypes.d.ts`

**Interfaces (produced, used by Task 6):**
- `waveobj.Run.OriginTranscript string` with JSON `origintranscript,omitempty`. Its doc comment says it is the transcript of the agent session whose `wsh runs start` created the run, and that it is empty for cockpit-started runs and runs from before the field.
- `wshrpc.CommandCreateRunData.OriginBlockId string` with JSON `originblockid,omitempty`.
- The frontend type `Run.origintranscript?: string` (via `task generate`).

**What to build:**
- [ ] Failing tests first:
  - `TestCreateRunCommand_RecordsOriginTranscript` in `wshserver_run_test.go`:
    - A block with `agent:transcriptpath` set, passed as `OriginBlockId`, gives a run whose `OriginTranscript` equals that path.
    - An `OriginBlockId` naming no block still creates the run, with `OriginTranscript == ""`.
    - No `OriginBlockId` gives `""`.
  - `TestRunsStartData_OriginBlock` in `wshcmd-runs_test.go`: the block id handed to `runsStartData` lands in `OriginBlockId`. Pass it through `runsStartOpts` so the function stays pure. The command reads `WAVETERM_BLOCKID`.
- [ ] Implement:
  - In `createRun`, resolve the block's transcript with the existing `readBlockTranscriptMeta` (in `wshserver_agentmsg.go`) and set it on the `Run` before its first write.
  - A failed read logs with the run and block ids and does not refuse the run: an origin link is advisory.
  - Run `task generate`, then commit the regenerated `frontend/types/gotypes.d.ts`.
- [ ] `go test ./pkg/wshrpc/wshserver -run '^TestCreateRunCommand_RecordsOriginTranscript$'` and `go test ./cmd/wsh/cmd -run '^TestRunsStartData_OriginBlock$'` pass.

### Task 3: Activity calendar from the usage scan
**Depends on:** Task 1
**Chunk:** Decide: where activity day counts come from
**Chunk:** Activity calendar
**Files:** `frontend/app/view/agents/projectactivity.ts`, `frontend/app/view/agents/projectactivity.test.ts`, `frontend/app/view/agents/projectactivity.tsx`, `frontend/app/view/agents/usagestore.ts`, `scripts/cdp/project-overview-activity.mjs`

Decisions 1-4, 10, 11 and 13 above are this task's.

**Interfaces:**
- `usagestore.ts`: export the existing `fetchUsage(windowDays: number): Promise<CommandGetUsageStatsRtnData>`. Add the `export` keyword and nothing else.
- `projectactivity.ts`:
  - `ACTIVITY_WEEKS = 53`
  - `projectDays(reply: CommandGetUsageStatsRtnData, project: { path: string; channelId?: string }): Map<string, { tokens: number; sessions: number }>`, keyed by `"YYYY-MM-DD"`.
  - `calendar(days, opts: { now: number; trackedSinceMs?: number }): { weeks: DayCell[][]; months: { label: string; week: number }[]; total: number }`, where `DayCell = { day: string; tokens: number; sessions: number; level: 0|1|2|3|4; state: "tracked" | "before" | "future"; today: boolean }`.
  - `lastWeek(reply, project, now): { tokens: number; sessions: number; runs: number }`, where runs counts the distinct `runid` values.
  - `tooltipLines(cell: DayCell): { title: string; line: string }`. The title is like "Fri, Nov 6". The line is "61k tokens · 3 sessions", "no sessions", or "before Arc tracked this project".
  - `moveFocus(week: number, row: number, key: string): { week: number; row: number }`. The arrow keys move, clamped to the grid and to non-future days.

**What to build:**
- [ ] Failing tests in `projectactivity.test.ts`:
  - `projectDays` matches `C:\Repo\X\`, `c:/repo/x` and `C:\Repo\X` as one project (Review Focus 1). It counts a session in `C:\Users\u\AppData\Local\arc-wt\abc` whose `channelid` is the project's (Review Focus 2). It sums `bucketTokens` across a session's models on one day and counts distinct sessions per day.
  - `calendar` builds 53 weeks of 7 Monday-first rows for a Friday today, a Monday today and a Sunday today. Today sits in the last column, and the days after it are `future` (Review Focus 5).
  - Levels follow the quartile rule, and a single active day is level 4 (Review Focus 4).
  - `trackedSinceMs` marks earlier days `before`.
  - `months` gets a label at each week whose Monday starts a new month, and none in the last 2 columns.
  - `lastWeek` totals the last 7 local days, today included. `tooltipLines` gives all three wordings, `formatTokens`-formatted.
- [ ] `projectactivity.tsx` follows the Main board:
  - The head reads "Activity", then the window total via `formatTokens` + " tokens", then the aside "tokens per day · last 53 weeks".
  - Month labels, Mon/Wed/Fri row labels, and 14px cells with a 4px gap.
  - The grid is `role="group"` with `aria-label="Tokens per day, arrow keys move between days"` and a roving tab stop on today. The tooltip (`role="tooltip"`) is placed beside the cell and flips left near the right edge.
  - The "last 7 days …" line, then the legend (decision 11).
  - `trackedSinceMs` is the earlier of the project channel's `createdts` (from `projectListAtom`) and the first day `projectDays` holds.
  - Loading shows `RegionSkeleton`. Failure shows the Failures board's `RegionAlert`, "Could not read activity: <reason>.", with Retry re-running the read. The head count is hidden then.
- [ ] Scenario steps in `project-overview-activity.mjs`, each with a screenshot. Each seeds `localStorage['wave:dev-usage-buckets']`, restores the previous value in `finally`, and reopens the modal to re-read:
  - Main board, Activity: a busy calendar. Use a fixture of sessions in `ctx.dir` spread over the last ~40 weeks. Assert 371 cells, the head total, the last-7-days line, dashed cells before the first fixture day, and the legend.
  - Main board, Activity: hovering a cell shows the tooltip with its date and tokens. Focusing the grid and pressing ArrowLeft moves the focused cell.
  - Main board, Activity: loading shows skeleton lines (`delayMs`).
  - Main board, Activity: hovering a cell in the last 5 columns shows the tooltip flipped to the cell's left, inside the region's box.
  - Quiet board, Activity: seed two sessions in `ctx.dir` on two weekdays three weeks ago and nothing since, as the board draws. Assert:
    - the head total is their sum;
    - those two cells are colored and the tracked days since then are level 0, not dashed;
    - days before the first seeded day are dashed;
    - the line reads "last 7 days no sessions";
    - the legend shows (decision 11).
  - Failures board, Activity: `fail: true` shows the alert, then Retry with a good fixture shows the calendar.

### Task 4: Running and Finished, not read
**Depends on:** Task 1
**Chunk:** Now: running and finished in the project
**Files:** `frontend/app/view/agents/projectnow.ts`, `frontend/app/view/agents/projectnow.test.ts`, `frontend/app/view/agents/projectnow.tsx`, `frontend/app/view/agents/cockpiteventsrail.tsx`, `frontend/app/view/agents/cockpitsurface.tsx`, `frontend/app/cockpit/cockpit-root.tsx`, `scripts/cdp/project-overview-now.mjs`

Decisions 5, 6 and 12 above are this task's.

**Interfaces:**
- `projectnow.ts`:
  - `type RunningRow = { kind: "agent" | "run" | "terminal"; id: string; name: string; line: string; since: number }`
  - `runningRows(agents: AgentVM[], terminals: { vm: AgentVM; command: string | null }[], lineage: Lineage, project: string, now: number): RunningRow[]`:
    - agents are plain (no lineage role), `state === "working"`, `projectOf(a) === project`; the line is `activity || task`.
    - runs are `lineage.runs` with `project === project`, not done or cancelled, and at least one member working; the line is "<n> at work · <landed>/<total> tasks".
    - terminals are the project's terminals whose `command` is non-null (read from RT info, decision 5); the line is the command.
    - The order is agents, runs, terminals, each oldest `since` first.
  - `type FinishedRow = { id: string; kind: "agent" | "run"; name: string; line: string; ts: number }`
  - `finishedRows(input: { agentEvents: RailEvent[]; runEvents: Record<string, RunEvent[]>; seenTs: number; project: string; agents: AgentVM[]; lineage: Lineage }): FinishedRow[]`.
    - It merges the plain-agent events with `runRailEvents` for each run in `runEvents`.
    - It scopes them to the project with `scopeRailRows` and keeps those after `seenTs` (`splitUnread`).
    - It keeps kinds `finished` and `landed` only, newest per `focusId` / `group`, newest first.
  - `isQuiet(running, finished): boolean`.
- `cockpiteventsrail.tsx`: export `agentEventsAtom` and `seenTsAtom` (read-only use) so `projectnow.tsx` can read them without the Cockpit surface mounted. `projectnow.tsx` calls `ensureRunEvents` for the project's `lineage.runs` (decision 6) and reads `runEventsAtom(runId)` from `runeventstore.ts`.

**What to build:**
- [ ] Failing tests in `projectnow.test.ts`:
  - An agent of another project is excluded.
  - An asking agent is excluded (decision 5).
  - A run member is shown only under its run row.
  - A run with nothing working is excluded.
  - A terminal whose `command` is null is excluded, and a running one shows its command.
  - Two finishes by one agent give one row, the newest.
  - A run's `landed` run event gives a run row.
  - Events at or before `seenTs` are excluded.
  - An event of another project's run is excluded.
  - `isQuiet` holds only when both lists are empty.
- [ ] Move the `useRailTracking(agents, lineage)` call from `cockpitsurface.tsx` into `cockpit-root.tsx`'s always-mounted shell, reading `model.agentsAtom` and `model.lineageAtom`, so it runs exactly once.
- [ ] `projectnow.tsx` reads each project terminal's RT info (`GetRTInfoCommand` on its block oref) when the region mounts and when the terminal list changes. It follows the Main board: "Running <n>" rows have a working dot with a soft ring for agents, a diamond for runs and a muted dot for terminals, then a 150px name, the line, and the age (`formatAge`). "Finished, not read <n>" rows have a hollow ring. Both empty gives the single "Now" region with "Nothing runs in <project>." (Quiet board). Clicking a row opens it (decision 12) and closes the modal.
- [ ] Scenario steps in `project-overview-now.mjs`, each with a screenshot. Inject the roster with the cockpit fixture seam the other cockpit scenarios use, scoped to `ctx.project`, and restore it in `finally`.
  - Main board, Running: an agent, a run and a terminal show with their lines.
    - The agent and the run's members come from `devMockAgentsAtom` (`app/view/agents/devmock.ts`, as `show()` in `scenarios-cockpit-roster.mjs` sets it, no reload), with project `ctx.project`.
    - The run's `Run` object comes from `installRuns` in `sessions-page-fixtures.mjs`, so it is in the lineage.
    - The terminal is a project terminal whose RT info comes from a stubbed `RpcApi.GetRTInfoCommand` returning `shell:state: "running-command"` and `shell:lastcmd: "task dev"`.
    - Restore every stub and the mock roster in `finally`.
  - Main board, Running: clicking the run row lands on the Cockpit with the modal closed (then reopen it).
  - Main board, Finished: set the mock roster with the agent `working`, wait, then set it with the same agent `idle`, without a reload. The shell's rail tracking records the finish after the rail's unread cursor (`seenTsAtom` is still 0 in a fresh session), and the row shows. Clicking it lands on the Agent surface with the modal closed (then reopen it).
  - Main board, Finished: a run in the lineage whose events (a stubbed `RpcApi.JarvisRunEventsCommand` returning one `landed` event) load through `ensureRunEvents` shows a "landed" row, with the Cockpit surface not mounted.
  - Quiet board, Now: an empty roster gives "Nothing runs in <project>."

### Task 5: Branches over the commit graph
**Depends on:** Task 1
**Chunk:** Branches: every branch's newest commits
**Files:** `frontend/app/view/agents/projectbranches.ts`, `frontend/app/view/agents/projectbranches.test.ts`, `frontend/app/view/agents/projectbranches.tsx`, `frontend/app/view/agents/githistorystore.ts`, `frontend/app/view/agents/githistorystore.test.ts`, `scripts/cdp/project-overview-branches.mjs`

Decisions 9, 12 and 13 above are this task's.

**Interfaces:**
- `projectbranches.ts`:
  - `BRANCH_ROWS = 10`, `BRANCH_ROW_H = 28`, `BRANCH_MAX_LANES = 4`
  - `type BranchesState = { kind: "loading" } | { kind: "norepo" } | { kind: "empty" } | { kind: "failed"; reason: string } | { kind: "rows"; rows: HistoryRow[] }`
  - `branchesState(reply: CommandGitHistoryRtnData | null, changedFiles: number, now: number): BranchesState`, where `null` means loading. It reuses `buildRows` from `historyrows.ts`, with `dirtyFileCount: changedFiles`, so the uncommitted row hangs off HEAD.
  - `authorInitial(author: string): string`.
- `githistorystore.ts`: `requestCommitLink(scope: string, hash: string): void`, the commit twin of `filesstore.ts`'s `requestFileLink`.
  - `settleSelection` consumes it when the load's `scope` equals the link's scope. If the loaded rows hold the hash, it settles the selection on that commit (`selectCommit`) and clears the link. If they don't, it clears the link and falls through to the default.
  - A pending file link still outranks it.
  - The commit row calls `requestCommitLink(scopeKey(scope), hash)` and then `openDiff(model, scope)`, with `scope = projectDiffScope(project, path)` from `agentdiffnav.ts`.

**What to build:**
- [ ] Failing tests in `projectbranches.test.ts`:
  - `isrepo: false` gives `norepo`.
  - `failure` gives `failed` with its stderr.
  - No commits gives `empty`.
  - Commits with `changedFiles: 3` give the uncommitted row first, parented on `head`.
  - `changedFiles: 0` gives no uncommitted row.
  - Ref decorations become chips through `classifyRef`.
  - `authorInitial("kael")` is `"K"`, and an empty author is `"?"`.
  - In `githistorystore.test.ts` (mocking `GitHistoryCommand` as the file already does), a requested commit link makes `loadHistory(cwd, opts, scope)` select that commit over the default and is consumed once. A link for another scope is ignored. A link whose hash is not in the page leaves the default selection and is cleared.
- [ ] `projectbranches.tsx` follows the Main board.
  - It reads `RpcApi.GitHistoryCommand(TabRpcClient, { cwd: path, limit: BRANCH_ROWS }, { timeout: HISTORY_RPC_TIMEOUT_MS })`.
  - The head reads "Branches <rows>" with the aside "open in Diff ↗".
  - The `GraphGutter` sits beside 28px rows: hash (7 chars), `refChipClass` chips, subject, author initial, age. The uncommitted row reads "Uncommitted changes" with "<n> files".
  - `norepo` shows "<project> is not a git repository." `empty` shows "No commits yet."
  - `failed` shows "Could not read the commits:" followed by the stderr in mono, with Retry.
  - Loading shows `RegionSkeleton`.
  - Clicking a commit or the link opens the Diff surface (decision 12) and closes the modal.
- [ ] Scenario steps in `project-overview-branches.mjs`, each with a screenshot. Add a second branch with two commits to `ctx.dir` using `git` from `scenarios-shared.mjs`.
  - Main board, Branches: the uncommitted row is first, commit rows carry `main` and the side-branch chips, and the gutter SVG draws two lanes.
  - Main board, Branches: clicking a commit lands on the Diff surface with that commit selected and the modal closed (then reopen it).
  - Main board, Branches: "open in Diff ↗" lands on the Diff surface scoped to this project's repo with the modal closed (then reopen it).
  - Main board, Branches: loading shows skeleton lines while a stubbed `RpcApi.GitHistoryCommand` holds its reply.
  - Main board, Branches: a second registered project on a temp folder with `git init` and no commit shows "No commits yet."
  - Quiet board, Branches: a second registered project on a plain temp folder shows "is not a git repository." Remove that project and folder in `finally`, as for the no-commit one.
  - Failures board, Branches: stub `RpcApi.GitHistoryCommand` to return a `failure` and the alert shows. Restore the stub, press Retry, and the rows return.

### Task 6: History with nested runs
**Depends on:** Task 1, Task 2 (uses `Run.origintranscript` in `gotypes.d.ts`)
**Chunk:** History with nested runs
**Files:** `frontend/app/view/agents/projecthistory.ts`, `frontend/app/view/agents/projecthistory.test.ts`, `frontend/app/view/agents/projecthistory.tsx`, `scripts/cdp/project-overview-history.mjs`

Decisions 7, 8, 12 and 13 above are this task's.

**Interfaces:**
- `projecthistory.ts`:
  - `HISTORY_WINDOW_MS = 7 * 86_400_000`, `HISTORY_PAGE = 30`
  - `type HistoryRunItem = { key: string; runId: string; title: string; line: string; warn: string; tone: "ok" | "warn" | "muted"; ts: number }`
  - `type HistoryEntry = { kind: "session"; key: string; session: LiveSession; runs: HistoryRunItem[]; ts: number } | { kind: "run"; key: string; run: HistoryRunItem; ts: number }`
  - `historyEntries(sessions: LiveSession[], runs: Run[], dags: Record<string, TaskGroup | undefined>, path: string, now: number, query: string): HistoryEntry[]`, newest first.
  - `runItem(run: Run, dag?: TaskGroup): HistoryRunItem`:
    - The title is the goal's first line, with `stripEffortRefs` applied.
    - The line is "<done>/<total> tasks" when there is a dag, followed by " · merged" when `land.state === "landed"`.
    - `warn` is " · land held", " · Final failed" (a failed verification), " · cancelled" or "", and `tone` follows it.
  - `sessionLine(s: LiveSession): string` gives "claude · 22m · 61k tokens", using `runtimeMeta`, the existing duration formatting and `formatTokens`.
  - Path matching uses `samePath` from `projectoverviewmodel.ts` (Task 1).

**What to build:**
- [ ] Failing tests in `projecthistory.test.ts`:
  - Only ended, non-run sessions of the project (path matched case- and slash-insensitively, Review Focus 1) inside 7 days are kept.
  - A run whose `origintranscript` names a listed session nests under it.
  - A run whose origin is outside the window, live, unknown or empty is a top-level entry placed by `createdts` (Review Focus 3).
  - Child runs (`taskid` / `stagerole` / `parentleadoref`) are dropped.
  - The query `"a.b"` matches literally, not as a regex. A session whose nested run matches stays with all its runs. A top-level run stays only on its own title.
  - `runItem` produces the line and warn for landed, held, failed-verification, cancelled and no-dag runs.
- [ ] `projecthistory.tsx` follows the Main board.
  - The head reads "History <n> sessions" with the aside "last 7 days".
  - Below it is the search box with a "/" hint. "/" pressed in the modal outside an input focuses the box.
  - Session rows show the title, the age, and a runtime-colored square with the meta line. Nested run rows have a stem, a diamond, a "run · …" line and the warn in `text-warning`. Top-level run rows have no stem.
  - The paging sentinel grows the list by `HISTORY_PAGE`. "older sessions in Sessions ↗" is a `LINK_BTN`.
  - Data:
    - Sessions come from `loadSessionsArchive()` → `sessionsArchiveAtom` overlaid with the roster (`overlayLive`); `sessionsErrorAtom` shows `RegionAlert` "Could not read sessions." with Retry.
    - Runs come from `RpcApi.GetChannelRunsCommand` for the project channel (`projectListAtom`'s row). A failure shows the Failures board's "Could not read runs, so sessions show without them." alert with Retry, and the sessions still list.
    - Dags are read through WOS, as `sessionssurface.tsx`'s `runObjsAtom` does.
  - Empty shows "No sessions in <project> in the last 7 days." A search with no match shows "No sessions match “<query>”." Loading shows `RegionSkeleton`.
- [ ] Scenario steps in `project-overview-history.mjs`, each with a screenshot. Use `installSessions` / `restoreSessions` from `sessions-page-fixtures.mjs`, with sessions whose `projectpath` is `ctx.dir`. Stub `RpcApi.GetChannelRunsCommand` with runs whose `origintranscript` matches a fixture session, and restore it in `finally`.
  - Main board, History: sessions newest first, a run nested under its origin session, a top-level cockpit run, and the warn text on a cancelled run.
  - Main board, History: pressing "/" with focus in the modal body focuses the search box. Typing narrows the list. A query that matches nothing shows "No sessions match “<query>”." Clearing it restores the list.
  - Main board, History: loading shows skeleton lines while `holdArchiveRead` holds the archive read (released with `releaseArchiveRead`).
  - Main board, History: clicking a session row lands on the Sessions surface with that session selected (`model.sessionsSelAtom` is its `sessionKey`) and the modal closed (then reopen it).
  - Main board, History: clicking a run row opens that run, with the modal closed (then reopen it).
  - Main board, History: with 40 sessions installed, scrolling the body to the end renders more than 30.
  - Main board, History: "older sessions in Sessions ↗" lands on the Sessions surface with the modal closed (then reopen it).
  - Quiet board, History: no sessions shows "No sessions in <project> in the last 7 days." and "0 sessions".
  - Failures board, History: a failing runs stub shows the runs alert above the sessions. A failing archive read shows the sessions alert.
