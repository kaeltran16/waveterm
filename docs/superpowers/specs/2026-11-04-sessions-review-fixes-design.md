# Sessions review fixes (F1-F21): design

Source: the Sessions surface review of 2026-11-04 (`cdp-shots/review/sessions/report.md` in the main checkout,
gitignored). Its "Tooling and procedure" section is out of scope. Each cause below was checked against the code at
`b988de7cf`; where the code supports a different fix than the report suggests, the decision says so and why.

## Verified causes that differ from the report

- **F3, resume into a missing cwd.** `shellexec` falls back to the home dir when `cmd:cwd` is missing
  (`pkg/shellexec/shellexec.go:224-226`). `claude --resume <id>` looks sessions up by the cwd's project slug, so a
  resume from home cannot find the session. Offering "the run's project root" (the report's suggestion) fails for
  the same reason: the root has a different slug. So a session whose cwd is gone is not resumable at all: its
  Resume is disabled with the reason (in the member pane too), and the run header's "Open run sheet" is the way on
  from a run member.
- **The pi pre-flight never fired.** `launchAgent` treats a throw from `FileInfoCommand` as "missing"
  (`cockpit-actions.ts:40-48`), but `FileInfoCommand` returns `{ notfound: true }` without throwing
  (`pkg/wshrpc/wshremote/wshremote_file.go:337-347`). A pi resume of a deleted session file therefore went ahead.
- **F4.** The controller's start error comes back from `ControllerResyncCommand` to `termwrap.resyncController`,
  which only `console.log`s it (`termwrap.ts:780-787`). The pending launch then stays a "booting" working row
  forever (`pendingToVM`), and it carries no runtime, hence `? Unknown`. `getProcExitAtom` is set but read nowhere.
- **F6.** Confirmed: `walkCandidates` takes every `.jsonl` under `~/.claude/projects`, including
  `<session>/subagents/agent-*.jsonl`, whose records carry `isSidechain: true`.
- **F9.** The preamble shape with no `Goal:` line is: the lead line, `- ` bullets, a "Where a principle above
  conflicts…" line, a blank, then the body. The run-card noise ("initiative effort:89d8…") is the run goal as
  typed, titled by the frontend's `runTitle`, not by the Go index.
- **F14.** A live session's `lastactivets` only changes when the archive reloads, which happens on a visit or
  while indexing, so "refetch on lastactivets" would never fire while the user watches. The transcript polls
  instead while the session is live.
- **F20.** `runView` takes `now` only to format a finished run's age (`headStatus`), and that makes every row,
  title and the merged feed re-derive each second. Moving the age to render time removes the per-second chain.

## Decisions

### Index (Go, `pkg/agentsessions`)

- **F1 waiting.** A claude session is `waiting` only while its last `AskUserQuestion` tool_use has neither a
  `tool_result` nor a later assistant record. `assembleEvents` takes the waiting decision from the extractor
  instead of reading it off the last event type; codex and opencode pass false (pi never calls it: its events
  are always done). Why: events are only
  asked/committed/errored, so "last event was asked" was true of any session that answered and went on quietly.
- **F6 sidechains.** The claude walk skips `subagents` directories, and `claudeSessionFrom` returns nil for a
  transcript whose records are sidechain. If the pi walk lists pi-subagents child sessions
  (`<parent stem>/<runId>/run-<n>/session.jsonl`), they are skipped the same way. Search loses subagent-only text;
  the parent transcript holds the Task prompt and result, so the work stays findable.
- **F9 titles.** `sessionTitle` drops `effort:<uuid>` tokens (with an enclosing parenthesis pair), skips
  `<local-command-stdout>` / `<local-command-stderr>` records as title candidates (returns "", so the next prompt
  titles), and for a "Work by these principles" preamble takes the first line after the bullet list and the
  "Where a principle above conflicts" line, unwrapping a `Goal: ` prefix. The frontend's `runTitle` strips effort
  refs the same way. Replacing the ref with the initiative's name was rejected: the Go index has no store access,
  and two different titles for one session in two places is worse than a shorter one.
- **F19 finished.** The synthetic `finished` event is dropped at read time (in `sessionOf`, not in the cached
  derivation) while the transcript was written within the last 5 minutes. Why read time: the scan cache keys on
  mtime+size, so a decision cached while fresh would never be revisited for an idle file.
- **F3/F21 resumability.** `SessionActivity` gains `resumeblocker`: empty means resumable, else the reason
  ("its working directory <path> no longer exists", or "no working directory was recorded"). The handler decides
  it per call with one `os.Stat` per distinct project path (deduped within the call). Measure on the real
  ~2,900-session set; add a cache only if a call spends over 50 ms on it. Why server-side: one decision for the
  list, the detail, Enter, and the palette.
- **F15 pins.** `GetSessionsActivity` takes `pinned` (the pin keys). A `runtime:id` pin whose session is not in
  the window is located with `TranscriptForSession` (claude and pi; other runtimes stay window-bound), parsed
  through the scan cache and returned. Pinning a run row also pins its lead session's key, so a pinned run older
  than the window comes back with its lead and is linked to its run as today. The surface says "last 30 days".

### Agent surface (shared, F4)

- One resync helper in `agentcontrollerstore.ts` calls `ControllerResyncCommand`, records the error on a per-block
  start-error atom on failure, and clears it on success or on a `running` controller status. `termwrap` uses it
  and also prints the error into the terminal. A second caller (the Cockpit run 2293fd95's F24 makes
  `launchAgent` start the controller) must use the same helper; whoever lands second wires it.
- `AgentVM.startError` is applied in the roster atom (`agents.tsx`) by a pure `withStartError`: the agent reads
  idle (not working, not booting) with the error. The Agent header shows "failed to start" in `text-error` plus
  the error; the tree row's dot uses the error tone. Sessions reads the same roster, so both surfaces agree.
- A pending launch carries its runtime, so the booting header shows it instead of `Unknown`.
- `launchAgent` pre-flights a non-terminal launch's non-empty `projectPath` (FileInfo `notfound`) and fixes the pi
  check the same way. `launchAgentOrToast` catches a launch error, logs it, and pushes an error toast naming the
  reason; the Sessions Resume, list-nav Enter and the palette's session Resume use it.
- `ResyncController` logs every error its start path returns (the remote and snapshot refusals return before
  `controller.Start`) with the block id, so it reaches `waveapp.log`.
- The palette's session rows resume through `resumeLaunchOpts` too, so a palette Resume names the tab after the
  session as a Sessions Resume does.

### Sessions models (pure)

- **F1 status words.** One `soloStatus` feeds the card and the detail: live asking → asking, live → running,
  ended waiting → "needs you" (asking tone), else done (the card shows the age in its place).
- **F2/F18 runs.** A run is open unless its run or dag is cancelled or done. Only an open run has needs-you
  members and an ask banner; a cancelled run's head reads "cancelled", checked before asking/failed. A blocked run
  whose lead has ended keeps its needs-you rows: it still waits on a human decision on its run sheet (the report's
  "ended run whose lead is gone" rule was not taken for that reason). Done keeps a run only when `view.complete`.
- **F3/F21 primary action.** `sessionPrimary` returns jump, resume, or blocked with the reason, or null when no
  resume command exists. The detail renders blocked as a disabled Resume with the reason in muted text beside it.
- **F7 time.** `sessionstime.ts`: `startedLabel(ts, now)` ("Oct 23 09:13", the year added when not this year,
  en-US month as `memorymodel.ts` formats), `eventTime(ts, now)` (HH:MM today, else the date too), `ranLabel(ms)`
  ("ran 3h"). The detail meta reads `started … · ran …`; Activity rows from another day carry the date; the run
  card reads `<project> · ran 23m`.
- **F8 empty list.** `emptyListState(filter, project)`: "No live sessions" / "Nothing needs you" / "No finished
  sessions" with a Show all action that resets the status filter; only the unfiltered empty list offers New agent.
  The project scope is the shell's and is named, not reset.
- **F20.** `runView` and `overlayLive` drop `now`; a finished run's head text is empty and the card renders the
  age. The surface memoizes the rows, scoped sessions, run titles and the feed.

### Sessions rendering

- **F5.** A "Show earlier turns" row tops a transcript that may be cut: the tail came back full (2,000 lines) or
  the grouped items exceed the 200 render cap. It refetches with `maxlines: -1` and renders all, the path find uses.
- **F10.** "Open run sheet".
- **F11.** `sessions:search` on `/` focuses the search field, shaped like `files:filter`; the docs gain the list
  keys (`j`/`k`, `Enter` = Jump/Resume, `/`). `Space` peek stays unbound on Sessions: the surface has no peek
  target, so the docs do not claim one.
- **F12.** While a new query is in flight over old results, the list dims and carries a pending marker; the
  failure line reads "Search failed: <reason>".
- **F13.** The claude projection unwraps `<pasted_content id="…">` in user text, with the regex the Go side uses.
- **F14.** While a session is live and its transcript is shown, it refetches every 5 s, keeps the old entries
  during the fetch, and sticks to the bottom only if the reader was already there.
- **F16.** A failed read shows "Couldn't read the transcript" with the path and the error, not the empty text.
- **F17.** The current member row scrolls into view (`block: "nearest"`) when the member changes.

## Verification

Final runs four new scenarios, `sessions-list-states`, `sessions-detail-states`, `sessions-palette-resume` and
`agent-start-failed`. Their Sessions fixtures are injected in the page (a stubbed `GetSessionsActivityCommand` and
`GetAgentTranscriptCommand`, run and dag objects held in the WOS cache as `holdObject` in `scenarios-runs.mjs`
does); nothing is written to `~/.claude/projects`. The existing
`scenarios-sessions*.mjs` scenarios are not run by Final, since they write fixtures there. F6, F9 and F19 are
index rules with no view of their own and are proven by Go tests; F20 by unit tests on the dropped `now` plus a
guard step on idle long tasks.
