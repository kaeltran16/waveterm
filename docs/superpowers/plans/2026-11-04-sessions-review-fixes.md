# Sessions review fixes (F1-F21) Implementation Plan

> **For agentic workers:** each task below is one worker's job. It carries its design decisions, files, interfaces
> and acceptance; you write the implementation. Logic goes in pure `.ts` files with a vitest test beside them, or in
> Go functions with tests beside them; `.tsx` stays a thin consumer (AGENTS.md "Logic is extracted, not
> rendered"). The spec restates every finding's decision and why; the review report it comes from is background.

**Goal:** Fix the 21 findings (F1-F21) of the Sessions surface review; its "Tooling and procedure" section is out
of scope.

**Architecture:** Index rules (waiting, sidechains, titles, finished, resumability, pins) move into
`pkg/agentsessions` and the sessions RPC handlers, behind two new wire fields that Task 1 lands first with the
scenario scaffold. The launch guard and its toast land early and small (Task 4), so the Agent surface's
start-failure state (Task 5) and the Sessions detail (Task 8) build on it side by side. The Sessions pure models
change in one task, then the list and the detail render them in two tasks side by side.

**Tech Stack:** Go, React 19, jotai, Tailwind 4 (`@theme` tokens only), vitest, the CDP harness in `scripts/cdp/`.

**Spec:** `docs/superpowers/specs/2026-11-04-sessions-review-fixes-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/agentsessions ./pkg/wshrpc/... ./pkg/blockcontroller`
**Check:** `task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs sessions-list-states sessions-detail-states sessions-palette-resume agent-start-failed`

## Global Constraints

- Colors and spacing from existing `@theme` tokens in `frontend/tailwindsetup.css` only (DESIGN.md); no new tokens.
- New and changed scenario steps write nothing into `~/.claude/projects`: Sessions fixtures are injected in the
  page through `scripts/cdp/sessions-page-fixtures.mjs` (Task 1). Do not run or extend the existing
  `scripts/cdp/scenarios-sessions*.mjs` scenarios.
- After changing a wshrpc type, run `task generate`; never hand-edit generated files.
- `tsconfig.json` is `strict: false`: narrow unions with `"reason" in x`, not a boolean flag.
- Lint/format only the files you touch (`npx eslint <paths>`, `npx prettier --check <paths>`); keep prettier off
  `scripts/*.mjs`. `task check:ts` takes ~2 min: give it a longer timeout.
- A fixture WaveObj id must be a UUID (`ParseORef` rejects anything else).
- The Cockpit review run (2293fd95) edits `frontend/app/cockpit/cockpit-actions.ts` (its F24: `launchAgent` starts
  the controller itself) and adds `AgentVM.booting`. If it lands first, keep both behaviors: its controller start
  goes through Task 5's `resyncController` helper, and `withStartError` clears `booting`.

## Review Focus

- An ask answered with a `tool_result` and followed only by a commit-less tool call reads done, not waiting
  (Task 2 test `TestClaudeWaitingClearedByLaterAssistant`).
- A pinned session whose transcript was deleted from disk is pruned, not kept forever (Task 3 test
  `TestPinnedSessionsSkipsMissingTranscript`; Task 6 keeps `prunePins` pruning absent keys).
- Two sessions sharing one deleted cwd stat it once per call (Task 3 test `TestResumeBlockerStatsEachPathOnce`).
- A live session's transcript poll never yanks a reader who scrolled up (Task 8 test `shouldStick`).
- A cancelled run with an asking task shows no ask banner and no needs-you row (Task 6 test
  `cancelled run has no needs and no ask`).

---

### Task 1: Wire fields, scenario scaffold and page fixtures
**Depends on:** none
**Files:** `pkg/wshrpc/wshrpctypes_agents.go`, `frontend/types/gotypes.d.ts`, `scripts/cdp/scenarios.mjs`, `scripts/cdp/scenarios-sessions-list-states.mjs`, `scripts/cdp/scenarios-sessions-detail-states.mjs`, `scripts/cdp/scenarios-sessions-palette-resume.mjs`, `scripts/cdp/scenarios-agent-start-failed.mjs`, `scripts/cdp/sessions-page-fixtures.mjs`, `scripts/cdp/sessions-page-fixtures.test.mjs`

- `wshrpc.SessionActivity` gains `ResumeBlocker string \`json:"resumeblocker,omitempty"\`` (empty = resumable, else
  the reason). `CommandGetSessionsActivityData` gains `Pinned []string \`json:"pinned,omitempty"\`` (pin keys,
  `runtime:id` or `run:<id>`). Run `task generate`; only `gotypes.d.ts` should change.
- Four scenario modules, each `export default function (kit) { return [scenario]; }` with one scenario named
  `sessions-list-states`, `sessions-detail-states`, `sessions-palette-resume`, `agent-start-failed` (surfaces
  `sessions`, `sessions`, `sessions`, `agent`). Each stub's `assert` returns exactly one failing step
  `{ step: "<name>: steps not written yet", ok: false }`. Register them in `SCENARIOS` with `SESSIONS_KIT`, after
  the `sessionsPalette` entry and before `agentComposer` (which must stay last).
- `sessions-page-fixtures.mjs` (no disk writes):
  - `fixtureSession(overrides): SessionActivity` builds a full record: a fresh UUID id, `runtime: "claude"`,
    `status: "done"`, `transcriptpath` `C:\\arc-verify-sessions-fixture\\<id>.jsonl` (never created),
    `resumecommand: "claude --resume <id>"`, timestamps from `Date.now()`, one `started` event.
  - `fixtureRun({ status, dagStatus, tasks })` returns `{ run, dag }` with UUID ids, the run's `dagoref` naming the dag.
  - `tailLines(lines, maxlines)`: all lines for `maxlines <= 0`, else the last `maxlines`.
  - In-page installers taking `h`: `installSessions(h, sessions)` stubs `RpcApi.GetSessionsActivityCommand` to
    resolve `{ sessions, incomplete: false }` and sets `sessionsArchiveAtom`, `sessionsIncompleteAtom=false`,
    `sessionsErrorAtom=false`. `installRuns(h, list)` holds each run and dag in the WOS cache the way `holdObject`
    in `scripts/cdp/scenarios-runs.mjs` does (`getWaveObjectValue`, a never-resolving `pendingPromise`, set
    `dataAtom`, put the hold back after every push); `WOS.mockObjectForPreview` is not usable, it throws outside a
    preview window. `stubTranscripts(h, byPath)` stubs `RpcApi.GetAgentTranscriptCommand` (`{ lines }` honoring
    `tailLines`, or `{ error }` which rejects) and records each call's `{ path, maxlines }` on
    `window.__sessionsFixtureCalls`; `setTranscript(h, path, entry)` replaces one path's entry.
    `restoreSessions(h)` removes every stub, releases each held object as `releaseObject` does
    (`reloadWaveObject`), and calls `loadSessionsArchive()`. Import app modules the way `MOD` in
    `scenarios-sessions.mjs` does.
- Tests in `sessions-page-fixtures.test.mjs`: `fixtureSession fills every SessionActivity field`, `fixtureSession
  ids are UUIDs`, `fixtureRun links the run to its dag`, `tailLines returns all for -1 and the last N otherwise`.

Acceptance: `node --check` passes on the six `.mjs` files; `node -e "import('./scripts/cdp/scenarios.mjs').then((m)
=> console.log(m.SCENARIOS.map((s) => s.name).join(' ')))"` prints the four names, `agent-composer` still last;
`npx vitest run scripts/cdp/sessions-page-fixtures.test.mjs` passes; `go build ./...` passes.

### Task 2: Index rules: waiting, sidechains, titles, recent finish (F1, F6, F9, F19)
**Depends on:** none
**Files:** `pkg/agentsessions/agentsessions.go`, `pkg/agentsessions/agentsessions_test.go`, `pkg/agentsessions/events_test.go`

- F1: `claudeEventsFrom` tracks whether the last `AskUserQuestion` tool_use is still pending: cleared by a
  `tool_result` with its id or by any later assistant record. `assembleEvents(raw, firstTs, lastTs, waiting bool,
  startedText, finishedText)` sets `status = "waiting"` from that flag only. Its three callers are claude, codex
  (`extractCodexEvents`) and opencode (`extractOpencodeEvents`); codex and opencode pass false. Pi does not call it
  (`extractPiEvents` is always done).
- F6: the claude provider's walk skips directories named `subagents` (`filepath.SkipDir`); `claudeSessionFrom`
  returns nil when the transcript's records are sidechain (the first parsed record has `IsSidechain`). If the pi
  walk lists pi-subagents child sessions (`<parent stem>/<runId>/run-<n>/session.jsonl`), skip those too, with a test.
- F9: `sessionTitle` removes `effort:<uuid>` tokens and an enclosing `( )` pair, collapsing whitespace; returns ""
  for a message starting with `<local-command-stdout>` or `<local-command-stderr>`; for a `Work by these
  principles` preamble returns the first non-blank line after the `- ` bullets and the "Where a principle above
  conflicts" line, with a `Goal: ` prefix unwrapped.
- F19: `withoutRecentFinish(events []SessionEvent, lastActive, now time.Time) []SessionEvent` drops a trailing
  `finished` event when `now.Sub(lastActive) < finishedQuietFor` (`const finishedQuietFor = 5 * time.Minute`),
  returning a copy, never mutating the cached slice. `sessionOf` applies it with `time.Now()`.
- Tests: `TestClaudeWaitingUnansweredAsk`, `TestClaudeWaitingClearedByToolResult`,
  `TestClaudeWaitingClearedByLaterAssistant`, `TestClaudeWaitingSecondAskPending`, `TestWalkSkipsSubagentsDir`,
  `TestSidechainTranscriptIsNotASession`, `TestSessionTitleStripsEffortRef` (`"Fix the bug (effort:<uuid>)"` →
  `"Fix the bug"`, `"Fix every chunk of initiative effort:<uuid>"` → `"Fix every chunk of initiative"`),
  `TestSessionTitleSkipsLocalCommandOutput`, `TestSessionTitlePreambleWithoutGoal` (the real shape in the spec →
  `"You are the lead for run …"`), `TestWithoutRecentFinish` (4 min old drops it, 6 min old keeps it, the input slice
  unchanged).

Acceptance: `go test ./pkg/agentsessions -run 'TestClaudeWaiting|TestWalkSkipsSubagentsDir|TestSidechainTranscript|TestSessionTitle|TestWithoutRecentFinish'` passes.

### Task 3: Resumability and pinned sessions in the handlers (F3, F15, F21)
**Depends on:** Task 1 (uses the `resumeblocker` and `pinned` wire fields)
**Files:** `pkg/agentsessions/resumable.go`, `pkg/agentsessions/resumable_test.go`, `pkg/agentsessions/index.go`, `pkg/agentsessions/index_test.go`, `pkg/wshrpc/wshserver/wshserver_agents.go`, `pkg/wshrpc/wshserver/sessionsearch.go`, `pkg/wshrpc/wshserver/sessionsearch_test.go`

- `resumable.go`: `type DirCheck struct` with `NewDirCheck(stat func(string) error) *DirCheck` and
  `(*DirCheck) Blocker(projectPath string) string`: "" when the dir exists; `"no working directory was recorded"`
  for ""; `"its working directory " + path + " no longer exists"` when stat fails. Each distinct path is statted
  once per `DirCheck`.
- `sessionActivityOf(s, check *agentsessions.DirCheck)` sets `ResumeBlocker`; `GetSessionsActivityCommand` and
  `searchResults` each make one `DirCheck` per call (`os.Stat`). Measure the handler on the real archive (log the
  time once); add a cache only if the check costs over 50 ms, and say so in your report.
- `index.go`: `PinnedSessions(keys []string, have map[string]bool) []SessionInfo` resolves each `runtime:id` key
  not in `have` (keyed `runtime:id`) with `TranscriptForSession(SessionRoot(runtime), runtime, "", id)` for claude
  and pi, parses it through the scan cache (`parseCandidate`/`cachedEntry`, stamping via `sessionOf`), and skips
  keys it cannot find or parse. `run:` keys are ignored here (the lead's key, pinned beside it, brings the run).
  `GetSessionsActivityCommand` appends these before `linkSessionsToRuns`.
- Tests: `TestResumeBlockerExisting`, `TestResumeBlockerMissing`, `TestResumeBlockerEmptyPath`,
  `TestResumeBlockerStatsEachPathOnce`, `TestPinnedSessionsFindsOldClaudeSession` (a transcript with an mtime 40
  days back, under a temp home), `TestPinnedSessionsSkipsMissingTranscript`, `TestPinnedSessionsSkipsHave`, and in
  `sessionsearch_test.go` `TestSearchResultsCarryResumeBlocker`.

Acceptance: `go test ./pkg/agentsessions -run 'TestResumeBlocker|TestPinnedSessions'` and `go test
./pkg/wshrpc/wshserver -run 'TestSearchResultsCarryResumeBlocker'` pass.

### Task 4: Launch guard and launch-error toast (F3, F4 toast)
**Depends on:** Task 1 (fills the `sessions-palette-resume` stub; the palette reads `resumeblocker`)
**Files:** `frontend/app/cockpit/cockpit-actions.ts`, `frontend/app/cockpit/cockpit-actions.test.ts`, `frontend/app/cockpit/palette-items.ts`, `frontend/app/cockpit/palette-items.test.ts`, `scripts/cdp/scenarios-sessions-palette-resume.mjs`

- `launchAgent`: a non-terminal launch with a non-empty `projectPath` throws `Working directory no longer exists:
  <path>` when `FileInfoCommand` returns `notfound`, before any tab is created; the pi `resumePath` check tests
  `notfound` too (keeping its catch for a thrown error).
- `launchAgentOrToast(model: AgentsViewModel, opts: LaunchAgentOpts): Promise<string | null>`: on error it
  `console.error`s with the opts' project and `pushToast({ level: "error", title: "Couldn't start the agent",
  message: <error message> })`, returning null; else the tab id.
- `palette-items.ts` `sessionRows`: lists only sessions with a resume command and no `resumeblocker`, and resumes
  through `launchAgentOrToast(model, resumeLaunchOpts(s))`. Using `resumeLaunchOpts` (from `sessionsruns.ts`) is
  intended: the resumed tab is named after the session (`label`), as a Resume from Sessions is, and the two paths
  stop building launch opts separately.
- Tests: `cockpit-actions.test.ts` `launchAgent refuses a missing projectPath before creating a tab`, `launchAgent
  refuses a pi resumePath that FileInfo reports notfound`, `launchAgentOrToast toasts the reason and returns null`;
  `palette-items.test.ts` `sessionRows leaves out a session with a resumeblocker`, `sessionRows resumes with the
  session's label`.
- Scenario `sessions-palette-resume` (Task 1's fixtures): "the palette's session rows leave out a session whose cwd
  is gone" and "Resume from the palette on a session whose cwd vanished after loading shows the error toast" (a
  fixture with a missing `projectpath` and no blocker; read `[data-notification-toast="error"]`).

Acceptance: `npx vitest run frontend/app/cockpit/cockpit-actions.test.ts frontend/app/cockpit/palette-items.test.ts` passes; both `sessions-palette-resume` steps pass against the dev app.

### Task 5: Start failures in the shared roster (F4)
**Depends on:** Task 4
**Files:** `frontend/app/view/agents/agentcontrollerstore.ts`, `frontend/app/view/agents/agentcontrollerstore.test.ts`, `frontend/app/view/term/termwrap.ts`, `frontend/app/view/agents/agentsviewmodel.ts`, `frontend/app/view/agents/agentsviewmodel.test.ts`, `frontend/app/view/agents/agents.tsx`, `frontend/app/view/agents/agentheader.tsx`, `frontend/app/view/agents/agenttree.tsx`, `frontend/app/cockpit/cockpit-actions.ts`, `pkg/blockcontroller/blockcontroller.go`, `scripts/cdp/scenarios-agent-start-failed.mjs`

- `agentcontrollerstore.ts`: `getStartErrorAtom(blockId): PrimitiveAtom<string | undefined>` and
  `resyncController(data: CommandControllerResyncData): Promise<void>`, which calls
  `RpcApi.ControllerResyncCommand`, clears the atom on success, and on failure sets it to the error's message and
  rethrows. The `controllerstatus` handler clears it on `running`. `termwrap.resyncController` uses it and on
  failure writes `\r\n\x1b[31m[arc] could not start: <message>\x1b[0m\r\n` (ANSI red, which the terminal theme
  maps to its error color; the other `[arc]` notices stay dim).
- `agentsviewmodel.ts`: `AgentVM.startError?: string`; `withStartError(agent, err): AgentVM` returns the agent
  unchanged for no error, else `{ ...agent, state: "idle", startError: err }` (also clearing `booting` if present).
  `PendingLaunch` gains `runtime?: string`, `pendingToVM` sets `agent` from it, and `launchAgent` puts
  `opts.runtime` on the pending launch. `agents.tsx` applies `withStartError(agent,
  get(getStartErrorAtom(agent.blockId)))` for agents with a `blockId`.
- `agentheader.tsx`: a start-failed agent's state text reads "failed to start" in `text-error`, with the error on
  the line below; `agenttree.tsx`: its row's dot uses the error tone.
- `blockcontroller.go`: `ResyncController` logs every error its start path returns (the remote-connection and
  snapshot refusals, which return before `controller.Start`, and the `Start` failure) with the block id, once, at
  the point it returns.
- Tests: `agentcontrollerstore.test.ts` (mock `RpcApi` as `codereviewstore.test.ts` does) `records the error and
  rethrows`, `clears the error on success`; `agentsviewmodel.test.ts` `withStartError folds to idle with the error`,
  `withStartError leaves an agent without error untouched`, `pendingToVM carries the runtime`.
- Scenario `agent-start-failed`, a real failure through the resync path, not an injected atom: create an agent tab
  as `launchAgent` does, with block meta naming a remote connection (`connection: "ssh:arc-verify-none"`), which
  `ResyncController` refuses before starting. Steps: "a booting launch's header names its runtime, not Unknown"
  (read before the refusal lands, or from a second pending launch that is never started), "a launch whose
  controller is refused reads failed to start with the error in the Agent header", "its tree row shows the error
  tone", "the terminal prints could not start". Teardown deletes the tabs.

Acceptance: `npx vitest run frontend/app/view/agents/agentcontrollerstore.test.ts frontend/app/view/agents/agentsviewmodel.test.ts` passes; the four `agent-start-failed` steps pass against the dev app.

### Task 6: Sessions pure models (F1, F2, F3, F7, F8, F9 run titles, F15, F18, F20, F21)
**Depends on:** Task 1 (uses the `resumeblocker` and `pinned` wire fields)
**Files:** `frontend/app/view/agents/sessionsruns.ts`, `frontend/app/view/agents/sessionsruns.test.ts`, `frontend/app/view/agents/sessionsarchivestore.ts`, `frontend/app/view/agents/sessionsarchivestore.test.ts`, `frontend/app/view/agents/sessionssearch.ts`, `frontend/app/view/agents/sessionssearch.test.ts`, `frontend/app/view/agents/sessionspins.ts`, `frontend/app/view/agents/sessionspins.test.ts`, `frontend/app/view/agents/sessionstime.ts`, `frontend/app/view/agents/sessionstime.test.ts`, `frontend/app/view/agents/runlineage.ts`, `frontend/app/view/agents/runlineage.test.ts`, `frontend/app/view/agents/sessionssurface.tsx`, `frontend/app/view/agents/sessionsdetail.tsx`, `frontend/app/cockpit/actions/session.ts`, `frontend/app/cockpit/command-palette.tsx`

Interfaces later tasks use (keep these names):
- `sessionsruns.ts`: `soloStatus(s: LiveSession): Status` (live asking → `{asking,"asking"}`, live →
  `{running,"running"}`, ended `needsAttention` → `{asking,"needs you"}`, else `{done,"done"}`).
  `type SessionPrimary = { kind: "jump" } | { kind: "resume" } | { kind: "blocked"; reason: string }` and
  `sessionPrimary(s: Pick<LiveSession, "live" | "resumecommand" | "resumeblocker">): SessionPrimary | null` (null only
  with no resume command). `RunViewInput` loses `now`; `RunView` gains `open: boolean`; a finished run's `head` is
  `{ key: "done", text: "" }`; a cancelled run's head is `{ key: "muted", text: "cancelled" }`, checked first.
  `needs` and `ask` are empty unless `open` (run and dag neither `cancelled` nor `done`).
- `sessionsarchivestore.ts`: `overlayLive(base, roster)` (no `now`); `SESSIONS_WINDOW_DAYS = 30` exported;
  `loadSessionsArchive` passes `pinned: globalStore.get(sessionsPinnedAtom)`.
- `sessionssearch.ts`: `keepRow` keeps a run under Done only when `view.complete`;
  `emptyListState(filter: SessionStatusFilter, project: string): { title: string; body: string; action: "show-all"
  | "new-agent" | null }`: live "No live sessions", needs "Nothing needs you", done "No finished sessions", each
  with `show-all` (a project scope is named in the body, e.g. "in waveterm"); all with a project scope "No
  sessions in <project>" with `null` (the scope is the shell's); all unscoped keeps "No sessions found" with
  `new-agent`.
- `sessionspins.ts`: `togglePinnedRow` pinning a run adds `run:<id>` and its lead session's key
  (`memberSession(group.lead)`); unpinning drops every `rowPinKeys` key as today.
- `sessionstime.ts`: `startedLabel(ts: number, now: number): string` (`"Oct 23 09:13"`, `"Oct 23 2025 09:13"`
  in another year; en-US short month as `memorymodel.ts`, 24-hour clock), `eventTime(ts, now)` (`"09:13"` today,
  else `startedLabel`), `ranLabel(ms: number): string` (`"ran " + formatAgeShort(ms)`, "" for 0).
- `runlineage.ts`: `stripEffortRefs(text: string): string` (same rule as Task 2's Go), applied in `runTitle`.

Update every current caller to the changed signatures (Tasks 7 and 8 do the rest of the rendering):
- `sessionssurface.tsx`: drop `now` from `overlayLive`/`runView`; the run card renders a finished run's age
  (`formatAge(now - view.lastactivets)`) where `head.text` was.
- `sessionsdetail.tsx`: `PrimaryButton` reads `sessionPrimary(...)?.kind`; `RunDetail`'s finished head reads
  `done · <formatAge(now - view.lastactivets)> ago` (it read `head.text`, now empty).
- `cockpit/actions/session.ts`: the Resume action applies when `sessionPrimary(t.session)?.kind === "resume"`;
  `entries` calls `overlayLive(base, roster)` and lists only sessions whose primary is resume or jump (its comment
  says resumable ones only, as the palette rows).
- `cockpit/command-palette.tsx`: `overlayLive([result.session], agents)`.

Tests: `soloStatus maps live, asking, ended waiting and done`, `cancelled run has no needs and no ask`, `cancelled
run head reads cancelled even with a failed task`, `blocked run with an ended lead keeps its needs`, `runView needs
no now`, `sessionPrimary returns blocked with the reason`, `sessionPrimary is null without a resume command`,
`keepRow keeps only complete runs under Done`, `emptyListState per filter`, `pinning a run also pins its lead`,
`startedLabel same year and other year`, `eventTime today vs another day`, `ranLabel`, `stripEffortRefs`,
`loadSessionsArchive sends the pins` (mock `RpcApi`).

Acceptance: `npx vitest run frontend/app/view/agents/sessionsruns.test.ts frontend/app/view/agents/sessionsarchivestore.test.ts frontend/app/view/agents/sessionssearch.test.ts frontend/app/view/agents/sessionspins.test.ts frontend/app/view/agents/sessionstime.test.ts frontend/app/view/agents/runlineage.test.ts` passes, `grep -rn "overlayLive(\|sessionPrimary(" frontend --include=*.ts --include=*.tsx` shows no old-shape call, and `task check:ts` is clean.

### Task 7: The Sessions list (F2, F7 run card, F8, F11, F12, F15 header, F18, F20)
**Depends on:** Task 6
**Files:** `frontend/app/view/agents/sessionssurface.tsx`, `frontend/app/view/agents/sessionssearchstore.ts`, `frontend/app/store/keybindings/bindings.ts`, `frontend/app/store/keybindings/bindings.test.ts`, `docs/keyboard-shortcuts.md`, `scripts/cdp/scenarios-sessions-list-states.mjs`

- Cards use `soloStatus` (a done solo shows its age) and the run head (a finished run shows its age, a cancelled
  one "cancelled"); the run card's meta reads `<project> · <ranLabel(elapsed)>`.
- The empty list renders `emptyListState`; `show-all` sets the status filter to `all`, `new-agent` opens New agent,
  `null` renders no button.
- The toolbar gains a `ToolbarFact` "last 30 days" (from `SESSIONS_WINDOW_DAYS`).
- `useSessionsSearch` exposes `loading` as today; while `loading` and results are shown, the list dims
  (`opacity-60`) and carries `data-sessions-search-pending`; the failure line reads `Search failed: <error>`.
- `bindings.ts`: `sessions:search` on `/` (group "Sessions"), shaped like `files:filter`: active on the sessions
  surface when not editable and no modal; focuses `[data-sessions-search]`, returns false when absent.
  `docs/keyboard-shortcuts.md` Sessions table adds `/`, `j`/`k` (or arrows), and `Enter` (Jump or Resume).
- F20: memoize `rows`, `scoped`, `scopedSessions` and `runTitles`; `MergedFeed` memoizes `mergedFeed` on
  `[list, titles]`. Nothing derived from the archive may list `now` as a dependency.
- Test: `bindings.test.ts` `sessions:search focuses the search field on the sessions surface`.
- Scenario `sessions-list-states` (fixtures from Task 1's helper):
  - "an idle 10 s on All activity spends under 1 s in long tasks" (real archive, before any fixture; record the
    total in the detail).
  - "a cancelled run with a failed task reads cancelled, has no needs-you row and is not counted in Needs you".
  - "Done lists a complete run and leaves out the cancelled one".
  - "the run card's time reads ran <n>".
  - "Live with no live session says No live sessions, and Show all returns to All".
  - "/ focuses the search field" (dispatch the key on `document`).
  - "a pending search dims the old results" and "a failed search names its reason" (stub `SearchSessionsCommand`
    as `stubSearch` in `scenarios-sessions.mjs` does: one pending promise, then a rejection).
  - "the toolbar says last 30 days".
  - Teardown: `restoreSessions`.

Acceptance: `npx vitest run frontend/app/store/keybindings/bindings.test.ts` passes; every `sessions-list-states` step passes against the dev app.

### Task 8: The Sessions detail (F1, F3, F4 toast, F5, F7, F10, F13, F14, F16, F17)
**Depends on:** Task 6, Task 4 (uses `launchAgentOrToast`)
**Files:** `frontend/app/view/agents/sessionsdetail.tsx`, `frontend/app/view/agents/sessionstranscript.ts`, `frontend/app/view/agents/sessionstranscript.test.ts`, `frontend/app/view/agents/narrationtimeline.tsx`, `frontend/app/view/agents/transcriptprojection.ts`, `frontend/app/view/agents/transcriptprojection.test.ts`, `scripts/cdp/scenarios-sessions-detail-states.mjs`

- `sessionstranscript.ts`: `TAIL_LINES = 2000`, `TIMELINE_RENDER_CAP = 200` (moved here as the one source;
  `narrationtimeline.tsx` imports it instead of declaring its own), `transcriptMaxLines(runtime, full): number`
  (-1 for pi or full, else `TAIL_LINES`), `mayHaveEarlier(fetched: number, maxlines: number, items: number, full:
  boolean): boolean`, `LIVE_REFRESH_MS = 5000`, `shouldStick(scrollTop, scrollHeight, clientHeight): boolean`
  (within 40 px of the bottom).
- `useTranscript` returns `{ entries, error, fetched }`; while the session is live it refetches every
  `LIVE_REFRESH_MS` without resetting entries, and the body sticks to the bottom only when `shouldStick` held before
  the update. A failed read renders "Couldn't read the transcript" with the path and the error
  (`data-sessions-transcript-error`).
- A "Show earlier turns" row (`data-sessions-earlier`) tops the transcript when `mayHaveEarlier`; it sets `full`
  (the find path), refetching with `maxlines: -1` and rendering all.
- SoloDetail's status is `soloStatus`; meta reads `started <startedLabel>` and `ran …` (both detail panes);
  Activity rows use `eventTime`. The run button reads "Open run sheet". A `blocked` primary renders a disabled
  "Resume" with the reason beside it in `text-muted` (`data-sessions-resume-blocked`), in the solo detail and the
  run member pane; the run header's "Open run sheet" is the way on from a run member. `runSessionPrimary` resumes
  through `launchAgentOrToast` and does nothing for blocked.
- The current member row scrolls into view (`block: "nearest"`) when the member changes.
- `transcriptprojection.ts`: user text (string content and text blocks) unwraps
  `<pasted_content id="…">…</pasted_content id="…">` with the Go `pastedContentRe` pattern.
- Tests: `transcriptMaxLines`, `mayHaveEarlier` (full tail, over the cap, neither, already full), `shouldStick`;
  `transcriptprojection.test.ts` `unwraps pasted_content in a string prompt` and `in a text block`.
- Scenario `sessions-detail-states` (fixtures from Task 1's helper, transcripts stubbed):
  - "an ended waiting session reads needs you on its card and its detail".
  - "a session whose cwd is gone shows a disabled Resume with the reason", and the same for a run member.
  - "Resume on a session whose cwd vanished after loading toasts the reason and stays on Sessions" (fixture with a
    missing `projectpath` and no blocker).
  - "a 2,000-line tail shows Show earlier turns, and clicking it fetches the whole file and shows the first prompt".
  - "the meta reads started <date> and ran <n>", "an Activity row from another day carries its date".
  - "the run detail's button reads Open run sheet", "a finished run's head reads done · <age> ago".
  - "a pasted_content prompt shows without its tags".
  - "a live session's transcript shows a line appended after it opened" (a fixture roster agent whose
    `transcriptPath` matches; `setTranscript` grows the stub).
  - "a failed transcript read shows the error with its path".
  - "selecting task 11 of a 12-task run keeps its row in view in the member list".
  - Teardown: `restoreSessions`.

Acceptance: `npx vitest run frontend/app/view/agents/sessionstranscript.test.ts frontend/app/view/agents/transcriptprojection.test.ts` passes; every `sessions-detail-states` step passes against the dev app.
