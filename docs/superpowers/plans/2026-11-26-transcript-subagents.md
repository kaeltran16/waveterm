# Subagents in the transcript

**Spec:** `C:\Users\kael02\AppData\Local\arc-wt\9460c361\docs\superpowers\specs\2026-11-26-transcript-subagents-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/wshrpc/...`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && go vet ./pkg/wshrpc/...`
**Final:** `node scripts/cdp/final-verify.mjs transcript-subagents-step transcript-subagents-view transcript-subagents-nowline agent-subagents agent-rendered`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\transcript-subagents

## Decisions beyond the spec

- **The facts come from the listing, read incrementally on the server.** `GetSubagentsCommand` returns, per file, its
  meta (toolUseId, type, description, background, finished, stopped by user), its tool count, its running call and its
  start/end times. Why: measured on this machine, subagent files average 15 MB and reach 65 MB (api-request-blob
  records replay whole requests), so a frontend tail per running child, or a full server re-read each poll, is too
  heavy. wavesrv caches each file's scan by path and reads only the bytes appended since; a file that shrank is
  rescanned.
- **The running call travels as name + input; the frontend names it** through the projection's own verb/target code
  and `stepTitle`, so the live line names a call exactly as a step row does (a Grep reads "Searched" + its pattern in
  mono, not the prototype's "Grep \"parsePlan(\" pkg/"), with no Go copy of that naming.
- **The first listing must fit the RPC budget.** Real sessions hold three 55-66 MB children (session 08416bd2), and
  today's listing reads only each file's first and last record. Task 2 skips records that are neither user nor
  assistant without decoding them, and Task 3 calls `GetSubagentsCommand` with a 30 s timeout as the backstop, since a
  timed-out read only keeps the last list.
- **Refresh while the parent is quiet:** while any subagent of a parent is working, its listing alone is re-read every
  2 s (`SUBAGENT_POLL_MS`), correlated against the spawns of the last full refresh; the full refresh (listing + parent
  tail) stays on parent activity. A background finish wakes the parent (its notification starts a turn), and that
  activity brings the notification's outcome in.
- **"The parent's session ended"** = the parent's block reports its process exited (`getProcExitAtom(blockId)` set).
  Read at each refresh/poll, so the next 2 s tick turns an unfinished child stopped and the poll stops.
- **Outcome precedence:** file stopped (meta `stoppedByUser` or ends on the interrupt marker) → stopped; the spawn's
  result or notification → failure/success; file finished (terminal turn or meta `finished`) → done; parent ended →
  stopped; else working. `SubagentState` gains `"stopped"`, drawn muted like `done`. A finished file ends the step even
  before the parent's result lands (anti-goal: no frozen spinner).
- **Scope of the step features:** only the Rendered view passes the subagent list to `NarrationTimeline`; agent rows,
  lead cards, Sessions and ended transcripts keep today's Agent steps. The parent's subagent now line is likewise the
  Rendered view's (non-compact) tail only.
- **Held running in layout:** `LayoutOpts.runningSubagents` (the toolUseIds of working subagents) makes those steps
  `running` whatever their result; in a folded (non-live) turn they leave their stretch and draw as one stretch right
  after that fold item. A live turn keeps them in place, so steps never reorder while the parent works.
- **The "background" tag** the PickStep and NowLineSubagents boards draw on a background Agent step is built
  (Task 4), from the step's subagent's background flag.
- **Row order on the Agent step:** facts (elapsed or duration), then Open, then the chevron, on every Agent step (three
  of the four prototype rows use it). Open and the time never truncate; the description truncates first.
- **"N subagents running" shows only with more than one**, as the spec says; the NowLineSubagents board's
  "1 subagent running" is not followed. The working parent's chip reads "1 subagent" / "N subagents".
- **The subagent view replaces `subagentinterior.tsx`** with `subagentview.tsx`. The parent's Rendered view stays
  mounted and laid out but invisible under it (as the terminal is under Rendered), so going back keeps its scroll.
  Opened from the Terminal view, going back returns to the terminal (spec amended to say so).
- **Colours** come from the existing theme tokens only (Open: `text-accent-soft` on `border-edge-mid`, as the
  prototype's #aebfff / #20262e map); no new tokens.
- **Scenarios:** three new ones over one fixture module. Task 3 lands the fixture and registers all three, so the UI
  tasks each own one scenario file and none edits `scenarios.mjs`. A scenario that is not about the Open button opens
  a subagent through `openSubagent`, so Tasks 5 and 6 do not depend on Task 4's button.
- **Task 3 stays one task** (the review proposed splitting its interfaces out): Tasks 5 and 6 could start on the types
  alone, but their scenario steps need the correlated states, calls and counts Task 3 computes, so they would wait for
  it anyway.

### Task 1: Subagent facts on the wire
**Depends on:** none
**Files:** `pkg/wshrpc/wshrpctypes.go`, `frontend/types/gotypes.d.ts`

Add the fields Tasks 2 and 3 share to `SubagentFileInfo`, then `task generate`. No behaviour.

**Interfaces:**
```go
type SubagentFileInfo struct {
	AgentId        string        `json:"agentid"`
	TranscriptPath string        `json:"transcriptpath"`
	FirstPrompt    string        `json:"firstprompt"`
	StartedAtMs    int64         `json:"startedatms"`          // first record's timestamp; the file's mtime without one
	Done           bool          `json:"done"`                 // ends on a terminal assistant turn, or meta finished
	Stopped        bool          `json:"stopped,omitempty"`    // meta stoppedByUser, or ends on the user's interrupt marker
	EndedAtMs      int64         `json:"endedatms,omitempty"`  // last record's timestamp, once Done or Stopped
	ToolUseId      string        `json:"tooluseid,omitempty"`  // meta: the Agent call that spawned it
	AgentType      string        `json:"agenttype,omitempty"`  // meta agentType
	Description    string        `json:"description,omitempty"`
	Background     bool          `json:"background,omitempty"` // meta requestShape "background"
	ToolCount      int           `json:"toolcount"`
	CurrentCall    *SubagentCall `json:"currentcall,omitempty"` // its running call, only while neither Done nor Stopped
}
type SubagentCall struct {
	Name        string         `json:"name"`
	Input       map[string]any `json:"input,omitempty"`
	StartedAtMs int64          `json:"startedatms,omitempty"`
}
```

**Acceptance:**
- `SubagentFileInfo` and `SubagentCall` in `gotypes.d.ts` carry these fields; tsc and `go vet` pass.

### Task 2: wavesrv reads each subagent's facts incrementally
**Depends on:** Task 1 (fills the `SubagentFileInfo` fields it adds)
**Files:** `pkg/wshrpc/wshserver/transcript.go`, `pkg/wshrpc/wshserver/transcript_test.go`, `pkg/wshrpc/wshserver/subagentfacts.go`, `pkg/wshrpc/wshserver/subagentfacts_test.go`

`listSubagents` fills every Task 1 field from `agent-<id>.jsonl` and its `agent-<id>.meta.json` (meta fields as
Claude Code writes them: `agentType`, `description`, `toolUseId`, `requestShape`, `finished`, `stoppedByUser`). The
scan is cached per path and reads only bytes appended since the last listing; a smaller file is rescanned; cache
entries for files no longer on disk are dropped. Only `user` and `assistant` records count; others (api-request-blob)
are skipped.

**Acceptance:**
- A file with a meta gets its ToolUseId, AgentType, Description, Background; meta `finished` sets Done, `stoppedByUser`
  sets Stopped. No meta, or a malformed one, leaves those empty and still lists the file (a malformed meta is logged).
- A transcript whose last user record is `[Request interrupted by user…` is Stopped.
- StartedAtMs is the first record's timestamp; EndedAtMs is the last record's once Done or Stopped, else 0.
- ToolCount counts distinct tool_use ids in assistant records, excluding `SubagentHandback`; tool_use blocks inside an
  api-request-blob record do not count.
- CurrentCall is the last tool_use with no tool_result after it, with its name, input and its record's timestamp; nil
  once Done or Stopped, and nil while the child is between calls.
- After a record is appended, the next listing reflects it (count and current call), reading only the appended bytes;
  a repeat listing of an unchanged file reads none of it (proved through a read counter the cache exposes to tests).
- A file rewritten shorter is rescanned from the start.
- A record whose type is neither user nor assistant is skipped without a full JSON decode. Measured and stated in the
  task's report: the first and a repeat listing of a copy of session 08416bd2's subagents (three 55-66 MB children),
  against the 5 s RPC default.

### Task 3: The frontend knows each subagent's call, count and outcome
**Depends on:** Task 1 (uses the generated `SubagentFileInfo` fields)
**Files:** `frontend/app/view/agents/agentsviewmodel.ts`, `frontend/app/view/agents/transcriptprojection.ts`, `frontend/app/view/agents/transcriptprojection.test.ts`, `frontend/app/view/agents/session-models/sessionviewmodel.ts`, `frontend/app/view/agents/subagentcorrelate.ts`, `frontend/app/view/agents/subagentcorrelate.test.ts`, `frontend/app/view/agents/subagentsstore.ts`, `frontend/app/view/agents/subagentsstore.test.ts`, `frontend/app/view/agents/subagenttracking.ts`, `frontend/app/view/agents/subagenttracking.test.ts`, `frontend/app/view/agents/subagentmodel.ts`, `frontend/app/view/agents/subagentmodel.test.ts`, `frontend/app/view/agents/nowline.ts`, `frontend/app/view/agents/agentdetailsrail.tsx`, `frontend/app/view/agents/agentrow.tsx`, `frontend/app/view/agents/agenttree.tsx`, `scripts/cdp/agent-page-fixtures.mjs`, `scripts/cdp/transcript-subagents-fixture.mjs`, `scripts/cdp/scenarios-transcript-subagents-step.mjs`, `scripts/cdp/scenarios-transcript-subagents-view.mjs`, `scripts/cdp/scenarios-transcript-subagents-nowline.mjs`, `scripts/cdp/scenarios.mjs`

The projection tags Agent/Task action entries and subagent-finish notifications with their tool-use id; correlation
joins on the meta toolUseId (prompt match stays the fallback for files without one) and resolves the outcome by the
header's precedence; the store polls running children and applies the parent-ended signal. Add the `stopped` colour
(muted, like `done`) to the three `SUB_COLOR` maps. Export nowline's tool-count wording for reuse.

Fixture: one parent transcript ("fix-plan-parse") holding a finished foreground Explore ("List the plan format tests",
14 tools), a running foreground Explore ("Find where plans are parsed", running Grep `"parsePlan(" pkg/`, 9 tools),
two running background general-purpose subagents ("Research app store gaps" on a WebFetch, and "Audit the release
notes", started after it), and a finished background one ("Check the plan guide is current") with its completed task-notification;
every child with a meta file, and one child's first prompt differing from its spawn's. An option ends the turn (the
foreground ones finished, a final reply) for an idle parent. The three scenario files arrange it in the Rendered view
and tear it down; none asserts anything yet (Tasks 4, 5 and 6 add their steps). `GetSubagentsCommand` is called with a
30 s timeout.

**Interfaces:**
- Action entry (`kind: "action"`) and notification entry gain `toolUseId?: string` (set for Agent/Task calls and subagent finishes).
- `SubagentState = "working" | "success" | "failure" | "done" | "stopped"`; `SubagentVM` gains optional
  `toolUseId`, `description`, `startedAtMs`, `endedAtMs`, `toolCount`, `currentCall?: AgentActionEntry` (pending, named by the projection).
- `subagentsstore.ts`: `openSubagent(parentId: string, sub: SubagentVM): void` (sets `focusSubagentAtom`), `SUBAGENT_POLL_MS = 2000`.
- `subagentmodel.ts`: `subagentOutcome(sub): "running" | "done" | "failed" | "stopped"`, `subagentElapsedMs(sub, now): number | undefined`
  (start to end once finished, start to now while running), `runningBackground(subs): SubagentVM[]` (working background ones, most recently started first).
- `transcript-subagents-fixture.mjs` exports `writeSubagentsFixture(dir, { turnEnded })`, `arrangeSubagentsAgent(h, ctx, { state })`,
  `finishSubagent(childPath)` (appends a terminal assistant turn), `teardownSubagentsAgent(h, ctx)`, and the fixture's names and paths.

**Acceptance:**
- A file whose prompt differs from its spawn's but whose meta names the spawn takes that spawn's type, background flag and outcome.
- Outcomes follow the header's precedence, each case once: stopped file over a successful notification; failed spawn;
  finished file with no result yet reads done, not working; parent ended with an unfinished file reads stopped.
- `currentCall` names a Grep as a step row names it (stepTitle of the same input).
- While a child is working, the listing is re-read every 2 s with no parent-transcript read; with none working, no poll runs.

### Task 4: The live line on each Agent step, held running, kept out of the fold, Open
**Depends on:** Task 3, Task 2 (its scenario reads the facts the listing returns)
**Files:** `frontend/app/view/agents/transcriptlayout.ts`, `frontend/app/view/agents/transcriptlayout.test.ts`, `frontend/app/view/agents/narrationtimeline.tsx`, `frontend/app/view/agents/steprows.tsx`, `frontend/app/view/agents/renderedview.tsx`, `scripts/cdp/scenarios-transcript-subagents-step.mjs`

The Rendered view passes its agent's subagents to `NarrationTimeline` (new prop `subagents?: SubagentVM[]`). An Agent
step matched by toolUseId draws a second line: `↳` + the running call (title and mono target as a step row names it)
on the left and the tool count on the right; once finished, the outcome word (done, failed, stopped; failed in the
error tone, stopped neutral) with the count. The step's facts show elapsed with the spinner while running, the
subagent's own duration once finished. An Open button (`openSubagent`) sits after the facts; the step row's own click
still expands its body. A background Agent step carries a muted "background" tag after its description, as the
PickStep board draws it. A subagent finish notice whose toolUseId matches carries Open too. Layout per the header
(`LayoutOpts.runningSubagents`). Motion: the call/outcome text and facts cross-fade (`CrossFade`, as StepFacts does);
the count rolls (moment 12, `TickNumber`); the spinner leaves as today.

**Acceptance:**
- `transcript-subagents-step` step 1: the parent's subagent list joins all five fixture files to their Agent calls,
  the prompt-mismatched one included, with the fixture's states.
- Layout: a background step whose ack landed is `running` while its toolUseId is in `runningSubagents`, and `ok` once not.
- Layout: a finished turn holding such a step folds without it and draws it right after the fold item; once it is not
  running it is back inside the fold. A live turn keeps it in place. An older turn behaves the same with later turns after it.
- `transcript-subagents-step` step 2: the running foreground step shows the spinner, its elapsed, Open, and the live
  line `Searched` + `parsePlan(` (its stepTitle) with `9 tools`; the finished one reads `done` with `14 tools` and its duration.
- Step 3: the background step whose launch ack landed shows the spinner, the "background" tag and its live line; the finished background
  notice shows Open.
- Step 4: with the parent turned idle and its turn ended, the turn folds into "Worked for" and both running background
  steps sit right under the fold line.
- Step 5: after `finishSubagent` on one, its step reads `done` with no spinner and joins the fold; no step shows a spinner for a finished child.
- Step 6: Open on a step sets the focused subagent to that child (`focusSubagentAtom`), and Open on the finished
  notice to its child; the center view itself is Task 5's to check.

### Task 5: The subagent view in the center
**Depends on:** Task 3, Task 2 (its scenario reads the facts the listing returns)
**Files:** `frontend/app/view/agents/subagentview.tsx`, `frontend/app/view/agents/subagentviewmodel.ts`, `frontend/app/view/agents/subagentviewmodel.test.ts`, `frontend/app/view/agents/subagentinterior.tsx`, `frontend/app/view/agents/agentsurface.tsx`, `scripts/cdp/scenarios-transcript-subagents-view.mjs`, `scripts/cdp/scenarios-agent-subagents.mjs`, `DESIGN.md`, `docs/keyboard-shortcuts.md`

Replace the compact interior (delete `subagentinterior.tsx`) with `SubagentView`, marked `data-subagent-view`: the
child's streamed transcript in `TRANSCRIPT_COLUMN` at full size (renderers and thoughts on, not compact), `active`
while running, with the jump-to-latest pill; above it a banner like the ended worker's: state icon, type,
"subagent of <parent>", running/done/failed/stopped with elapsed or duration, tool count, read-only, and "↑ parent"
(Esc as today). No message box. Its own now line under the timeline: the running call's title and target, that
call's elapsed and the tool count; between calls "working" with the subagent's elapsed; finished, the outcome word
with duration and count; this line is built in `subagentview.tsx` and does not use or edit `nowlineview.tsx` (Task 6
edits it at the same time). The parent's Rendered view stays mounted, laid out but invisible, while the view is open.
State from the store's `SubagentVM` (by agentId), falling back to the streamed entries when the list lacks it.
Update DESIGN.md's Transcript hosts line and the Esc row in `docs/keyboard-shortcuts.md`. Motion: the view fades in
as the interior does; the banner's state icon turns done with `DrawCheck` (moment 16); the now line's call cross-fades.

**Acceptance:**
- Model: the view's now line and banner text for running with a call, running between calls, done, failed and stopped.
- `transcript-subagents-view` step 1: opening the running foreground child (`openSubagent`) shows `data-subagent-view` with a banner
  naming Explore, "subagent of" the parent, running, `9 tools`, read-only and "↑ parent"; the child's steps draw at
  full size; no message box is on screen; the now line shows the running Grep.
- Step 2: after `finishSubagent`, the banner and the now line read done.
- Step 3: with the parent scrolled up before `openSubagent`, Esc returns to its Rendered view at the same scroll
  offset (within 2 px).
- Step 4: opened while the parent is in the Terminal view, "↑ parent" returns to the terminal.
- `agent-subagents` step 4 finds the child's transcript in the new view (the SubagentHandback call still left out).

### Task 6: Running subagents in the parent's now line
**Depends on:** Task 3, Task 2 (its scenario reads the facts the listing returns)
**Files:** `frontend/app/view/agents/nowline.ts`, `frontend/app/view/agents/nowline.test.ts`, `frontend/app/view/agents/nowlineview.tsx`, `scripts/cdp/scenarios-transcript-subagents-nowline.mjs`

A pure `subagentNowLine(subs, parentWorking, now)` decides from `runningBackground`: hidden with none; parent idle →
the most recent one named (type, current call, elapsed since it started) plus "N subagents running" only when N > 1;
parent working → a chip "1 subagent" / "N subagents" at the working line's right end, which never truncates the
spinner side. The NowLineSubagents board's "1 subagent running" with one running is deliberately not drawn (the spec
shows the count only for more than one). The Rendered view's tail (non-compact `LiveWorkingLine`, reading the agent's list by id) draws it: the
named entry and the chip are buttons that open the most recent one. Compact hosts are unchanged; an idle agent with no
running background subagent keeps no line. Motion: the idle line reveals and leaves like the working line
(`composerReveal`, moment 6); the count rolls (moment 12); a change of the named subagent cross-fades.

**Acceptance:**
- Model: hidden with none or only foreground/finished ones; idle with one names it with no count; idle with two names
  the most recently started and "2 subagents running"; working gives the chip with the count.
- `transcript-subagents-nowline` step 1: the idle parent's now line names "Audit the release notes" (the more recently
  started) with its call and elapsed, and "2 subagents running"; a click sets the focused subagent
  (`focusSubagentAtom`) to that child.
- Step 2: after `finishSubagent` on one, the count text leaves and the other is named.
- Step 3: with the parent set working, the working line shows the "1 subagent" chip at its right end.
- Step 4: with the parent idle again and the last child finished, the now line is gone.
