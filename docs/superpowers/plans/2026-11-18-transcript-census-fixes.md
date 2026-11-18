# Transcript renderer: census fixes (groups A-G and the four decisions)

**Effort:** effort:72ccc3bc-d595-40d3-aa42-53aaa3764b87
**Verify:** `node scripts/verify.mjs ./pkg/agentsessions`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs transcript-census-projection transcript-census-layout transcript-census-steps transcript-census-markdown transcript-census-rows transcript-census-wsh transcript-base transcript-arc transcript-media transcript-agents transcript-dag transcript-notes transcript-dagactions transcript-initiative transcript-runs narration-feed`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\transcript-decisions\project\

Verify note: `scripts/verify.mjs` takes Go patterns but derives the frontend tests from the changed paths itself
(`vitest related` over the changed TS files, plus tsc), and runs all of vitest when unscoped in the final stage; no
Go file changes here, so the pattern only satisfies its usage.

**Inputs every worker reads.**

- Findings: `C:\Users\kael02\IdeaProjects\waveterm\.superpowers\census\findings.md` (gitignored: read it at that
  absolute path, it is not in the run tree). Each finding names its root cause and file; fix the shared cause once.
- Specimens: `C:\Users\kael02\IdeaProjects\waveterm\.superpowers\census\out\specimens.json`, an array of
  `{id, file, index, entries}`: `entries` are the projected `AgentEntry[]` the census mounted, `file` + `index` the
  source Claude jsonl and record. Shots: `...\census\out\sheet\{rendered,compact}\<id>.png`.
- Fixture data is checked in: copy the few entries (or raw records) a step needs from a specimen into the scenario or
  test, trimmed to what the defect needs. Nothing at runtime reads the census folder.
- Hosts (the census's, pinned by Task 1 as `HOSTS` in `scripts/cdp/transcript-fixture.mjs`): rendered = width 736,
  `{renderers, thoughts, accentLatest}`; compact = width 360, `{compact, accentLatest}`. Every visual fix gets a
  scenario step at both hosts, each step asserting the fix through the DOM (a geometry or computed-style check, a data
  attribute, text), not only a shot.
- A task that breaks an assertion in an existing scenario updates it only when the file is on its Files line;
  otherwise it reports it.

**Decisions beyond the canvas (lead, autonomous).**

- **Declined is its own outcome**, `"declined"`, beside `"blocked"` on `AgentActionEntry.outcome` and `Step.status`:
  a hook refusal stays "blocked", a user rejection or permission denial on any tool reads "declined". Both use the
  Bash blocked look (Ban square, muted); neither counts in the fold's fail count. Detection is by refusal phrase in the
  errored tool_result (Claude Code's "The user doesn't want to proceed with this tool use", "The tool use was
  rejected", "Permission to use ... has been denied" and the other refusal wordings the worker finds in
  `~/.claude/projects` errored results), never `bashNeverRan`.
- **The declined reason line is decided by the projection**, in `action.error`: an AskUserQuestion the user declined
  reads "You declined the question, so Claude stopped and waited for you." (the canvas's line); any other tool the user
  declined reads "You declined this call, so Claude stopped and waited for you."; a permission denial keeps its own
  first sentence (it names the rule). The raw refusal boilerplate is dropped.
- **Inline bodies cap by line count, not pixels** (C1): one constant, 20 lines, shared by every inline body (bash
  output, read, grep, diff, ask options, recorded output, wsh fallback). The cut is on a whole line and is followed by
  a muted "N more lines" line; a grep group never ends on a file header with none of its lines shown. The modal stays
  uncapped.
- **Status words** (E4), in step rows: failed = error tone, stopped = warning tone, blocked and declined = muted, the
  same in every step row kind, and a row never repeats its status ("failed with exit code 2 · failed" reads once).
- **Wrapping** (C5): list and output text breaks only when a token exceeds the line (`overflow-wrap: break-word`, not
  `anywhere`), and grep/glob path lines wrap with a hanging indent. Column-aligned output still wraps in compact
  (accepted: L, and a horizontal scroll in a 360px card hides more than it saves).
- **Dividers** (E5): "You interrupted", "You approved the design" and "You skipped the questions" share one look,
  the human-action phrase row's (no rules), and two consecutive interruptions with nothing between are one.
- **wsh one-line events** (F6): a successful wsh event with no structured body draws as the flat row
  (`wshchangerow.tsx`); the bordered card is for events with a body. The choice lives in `WshCardItem`
  (`narrationtimeline.tsx`), so F6 is Task 6's, not Task 7's.
- **Durations** (F2): the shared `fmtDuration` gains hours and days ("2h 05m", "3d 4h") instead of a per-card fix.
- **Out of scope, reported:** A9 (its cause is outside the transcript parser: the recorded content puts the attachments
  block first with the typed words after the path on its line, which `appendAttachments` never produces, so the text
  reached Claude another way); the "(unsure)" findings A10, C4, C10, E8, G2, B4 beyond decision 4.
- **Ligatures** (decision 3): the Ligatures board recommended turning them off; the user overruled it on
  2026-11-18 (findings.md "Decisions" 3: "kept. No change."; the initiative's chunk 4 note: "Ligatures KEPT (user's
  call)"). The board's "on" column is the result: nothing is built for it, and Task 4's scenario pins that state (a
  code body and a command line keep `font-variant-ligatures` other than `none`) so the final verifier reads the board
  against the user's call, not the board's recommendation.
- **Shell tool names** (A1): one set in `transcriptprojection.ts`; `permissionmodel.ts`'s own Bash checks are out of
  this plan.

### Task 1: Declined outcome type and the census scenario scaffold
**Depends on:** none
**Files:** `frontend/app/view/agents/agentsviewmodel.ts`, `frontend/app/view/agents/transcriptlayout.ts`, `frontend/app/view/agents/transcriptlayout.test.ts`, `frontend/app/view/agents/narrationfeedfixture.tsx`, `scripts/cdp/transcript-fixture.mjs`, `scripts/cdp/scenarios.mjs`, `scripts/cdp/scenarios-transcript-census-projection.mjs`, `scripts/cdp/scenarios-transcript-census-layout.mjs`, `scripts/cdp/scenarios-transcript-census-steps.mjs`, `scripts/cdp/scenarios-transcript-census-markdown.mjs`, `scripts/cdp/scenarios-transcript-census-rows.mjs`, `scripts/cdp/scenarios-transcript-census-wsh.mjs`

**What to build:** the small shared pieces the other tasks build on, so they run side by side.

**Interfaces:**
- `AgentActionEntry.outcome` is `"ok" | "fail" | "blocked" | "declined"`; `Step["status"]` adds `"declined"`.
  `stepStatus` maps outcome `"declined"` to status `"declined"` ahead of the bash exit check (a declined Bash has
  `exit: null`), and `FoldSummary.failed` does not count it.
- the fixture seam (`narrationfeedfixture.tsx`) passes every host prop through to `NarrationTimeline`, `accentLatest`
  and `thoughts` included (today its props drop `accentLatest`).
- `scripts/cdp/transcript-fixture.mjs` exports `HOSTS = { rendered, compact }` (the widths and props above) and
  `showAt(h, host, entries, extra?)` over `showTranscript`; and `projectInPage(h, lines)`, which runs the tree's own
  `projectTranscript` in the page through the dev server's module import (the `/@fs/` path of the tree's
  `transcriptprojection.ts`, resolved from the script's location so it serves the final tree) and returns the entries.
- Six registered scenarios, `transcript-census-{projection,layout,steps,markdown,rows,wsh}`, one per file above, each a
  stub its task replaces: it waits for the fixture seam and passes. The projection stub also projects one raw user
  record through `projectInPage` and checks it yields a user entry.

**Acceptance:**
- a layout unit test: a declined action lays out with status `"declined"` and adds nothing to the fold's failed count;
  a declined Bash with `exit: null` is not "fail"
- each of the six scenarios passes under `ARC_FINAL_OUT=<tmp> node scripts/cdp/final-verify.mjs <name>`

### Task 2: Projection fixes
**Depends on:** Task 1 (the "declined" outcome, projectInPage)
**Files:** `frontend/app/view/agents/transcriptprojection.ts`, `frontend/app/view/agents/transcriptprojection.test.ts`, `scripts/cdp/scenarios-transcript-census-projection.mjs`

**What to build:** `projectTranscript` emits clean entries for A1-A5, A7, A8, C7, F5 and decision 1.
- A1: PowerShell is a shell tool like Bash: verb "ran", `command`, bash detail with output/exit, blocked/declined.
  One set of shell tool names in `transcriptprojection.ts`, used everywhere that file special-cases Bash.
- A2: task-notification fields decode XML entities.
- A3: a compaction summary loses Claude Code's `<system-reminder>` wrapper, so its sections all render as markdown.
- A4: a failed Edit/Write keeps no edit detail (no +/- counts, no diff shown as applied); its error shows.
- A5: a tool with no mapped verb gets a readable one (`mcp__server__update_plan` -> "update plan",
  `SendFeedback` -> "send feedback", snake_case spaced), and targets come from `query`, `url`, `task_id`/`shell_id`,
  `prompt` where present; Codex `exec` reads its command, not a fragment.
- A7: tool_result bodies drop the harness boilerplate lines ("Shell cwd was reset to ...", "[This command modified N
  file(s) you've previously read ...]", "Command running in background with ID ... do not poll").
- A8: `\r` progress updates collapse to the last state of each line.
- C7: Read bodies are ANSI-stripped like bash output.
- F5: an `InputValidationError` reads as its first line(s), without the JSON schema.
- Decision 1: refusal phrases on any tool give outcome "declined" with the reason line decided in the header.

**Acceptance:**
- unit tests beside `transcriptprojection.ts`, from trimmed raw records of the specimens each finding names (143, 8,
  75, 126, 16, 51, the A5 list, 31, 47, 123, 53, 141, 4), one per finding, each failing without its fix
- a user-rejected Bash and a hook-refused Bash still differ ("declined" vs "blocked"); a real error ("file not found")
  stays "fail"
- `transcript-census-projection` projects those raw records with `projectInPage` and shows them at both hosts, with
  steps: PowerShell row opens to its command and output; notification summary has no `&amp;`; compaction summary has
  no `<system-reminder>` text and no raw `**`/`##`; failed edit row shows no +/- counts; rejected ask row has
  `data-step-status="declined"`, no fail count in its fold, and its text holds "You declined the question, so Claude
  stopped and waited for you." and not "The user doesn't want to proceed"

### Task 3: Layout fixes
**Depends on:** Task 1
**Files:** `frontend/app/view/agents/transcriptlayout.ts`, `frontend/app/view/agents/transcriptlayout.test.ts`, `scripts/cdp/scenarios-transcript-census-layout.mjs`

**What to build:** in `layoutTranscript`:
- A6: a session-closing wsh call (`wsh jarvis complete`, `wsh jarvis dag planreview`, `wsh jarvis dag final`, matched
  through `wshcall.ts`) that is pending at the end of an ended session lays out "ok", not "stopped".
- E6: a Monitor notice directly after the Monitor step it reports on draws once.
- E5 (dedupe half): consecutive interruptions with nothing between lay out as one.

**Acceptance:**
- layout unit tests for each, from specimens 7/27 (A6), 79/83 (E6), 39/153 (E5)
- `transcript-census-layout` at both hosts: the closing call's row has `data-step-status="ok"`; one Monitor row where
  there were two; one "You interrupted"

### Task 4: Step rows and tool bodies
**Depends on:** Task 1 (the "declined" status)
**Files:** `frontend/app/view/agents/steprows.tsx`, `frontend/app/view/agents/tooldetailbody.tsx`, `frontend/app/view/agents/toolrenderers.tsx`, `frontend/app/view/agents/tooldetailmodal.tsx`, `frontend/app/view/agents/recordedoutput.tsx`, `frontend/app/view/agents/bodycap.ts`, `frontend/app/view/agents/bodycap.test.ts`, `frontend/app/view/agents/unifieddiff.ts`, `frontend/app/view/agents/unifieddiff.test.ts`, `frontend/app/view/agents/tooldetailmodel.ts`, `frontend/app/view/agents/tooldetailmodel.test.ts`, `scripts/cdp/scenarios-transcript-census-steps.mjs`, `scripts/cdp/scenarios-transcript-base.mjs`, `scripts/cdp/scenarios-transcript-agents.mjs`, `scripts/cdp/scenarios-transcript-dag.mjs`, `scripts/cdp/scenarios-transcript-notes.mjs`, `scripts/cdp/narrationfeed.mjs`

**What to build:** B1, B2, B3, C1, C2, C3, C5, C6, C8, C9, E4 and the declined look.
- Declined (Main board): Ban square, muted "declined" in the row's facts, the reason line muted under the call (no red
  error block, no mono refusal text); the modal shows it the same way.
- B1: a long title truncates with an ellipsis; duration, status and chevron never shrink or overlap it.
- B2: compact ask answer uses the card's width.
- B3: a step titled by its command does not repeat it as the body's first line; a Skill body does not repeat its header.
- C1: the line cap from the header, as a pure `bodycap.ts` with its tests, applied to every inline body; the pixel
  max-heights go. It is the one source: `unifieddiff.ts`'s `capDiffLines`/`hiddenLinesLabel` fold into it (their
  callers in `toolrenderers.tsx` and `tooldetailbody.tsx` move over), and the grep-group rule uses
  `tooldetailmodel.ts`'s `groupGrepMatches`. The existing scenarios on this task's Files line whose asserts the cap,
  the fallback or the footer move (transcript-agents "Could not load the agent list", transcript-dag,
  transcript-notes, narration-feed's Open full view and grep/bash panels) are updated to the new behaviour.
- C2: the compact Tests card gives the test name the width; file:line yields.
- C3: the wsh fallback (`LoadFailure`) output is boxed, capped and has "Open full view".
- C5, C6, C8: break-word wrapping with hanging indent for path lists; grep paths left-truncate at a segment boundary;
  a gap between a bash command and its first output line.
- C9: "Open full view" sits inside the box for every card.
- E4: status words per the header.

**Acceptance:**
- `bodycap.test.ts`: a body over the cap cuts on a line and reports the rest; a grep group never ends on a bare header
- `transcript-census-steps` at both hosts, from specimens: 4 (declined row: Ban square, muted tone, "declined"), 4/43/
  123 (title's right edge is left of the facts, ellipsis via `text-overflow`), 142 (compact answer wider than 200px),
  10 (body's first line is not the command), 0/9/51 (capped body ends with "N more lines", last line not clipped),
  0 compact (test name wider than file:line), 108 (fallback capped, has Open full view), 0/19 (Open full view inside
  the card's box), 40/86 (no repeated status), 109 (grep path starts at a segment), 8 (command-output gap), and
  further steps: Main board, a declined ask's reason line computes the muted token, is not mono, and no
  `[data-tool-error]` is drawn for it; C5, from 11/37, a wrapped grep path line computes `overflow-wrap: break-word`
  and its continuation starts right of its first line (hanging indent); E4, a failed row's status text computes the
  error token, a stopped row's the warning token, a blocked or declined row's the muted token; the Ligatures pin per
  the header (a code body and a command line keep `font-variant-ligatures` other than `none`)

### Task 5: Markdown
**Depends on:** Task 1 (HOSTS, the scenario stub)
**Files:** `frontend/app/view/agents/markdownmessage.tsx`, `frontend/tailwindsetup.css`, `frontend/app/element/markdown.scss`, `frontend/app/view/agents/chartcard.tsx`, `scripts/cdp/scenarios-transcript-census-markdown.mjs`

**What to build:** `.agent-md` and the prose renderer fix D1-D7: ordered list markers of two and three digits show
whole; tables sit in a horizontal scroll container with a minimum column width; fenced code scrolls horizontally with
a visible cue; long tokens and inline code break inside the column; the inline code pill keeps its padding on wrap
and does not break between `-` and `-flag` or gap before punctuation; block margins around lists and rules; a
blockquote bar is one bar; compact chart x-labels do not collide and the rendered chart has no wide empty gutter.
`markdown.scss` changes only where it mirrors `.agent-md` (its comment says both renderers agree).

**Acceptance:**
- `transcript-census-markdown` at both hosts, from specimens 2 (marker "10." fully inside the card), 8/121 (table
  wrapper scrollable, no cell narrower than its minimum, nothing clipped outside it), 13/91 (code block scrollWidth >
  clientWidth with overflow-x auto), 16/88 (no descendant's right edge past the card), 6/44 (code pill), 132 (list
  spacing, one blockquote bar), 173 (compact chart labels' boxes do not overlap; rendered: the plot area's left
  edge sits within 48px of the card's content edge)

### Task 6: Feed rows: wakes, notifications, dividers, user bubbles
**Depends on:** Task 1 (HOSTS, the scenario stub)
**Files:** `frontend/app/view/agents/arcmessagerow.tsx`, `frontend/app/view/agents/narrationtimeline.tsx`, `frontend/app/view/agents/clampedtext.tsx`, `scripts/cdp/scenarios-transcript-census-rows.mjs`, `scripts/cdp/scenarios-transcript-arc.mjs`, `scripts/cdp/scenarios-transcript-media.mjs`

**What to build:** E1, E2, E3, E5 (look), E7, F6, G1, decisions 2 and 4.
- F6: in `WshCardItem`, a successful wsh event with no structured body draws the flat `WshChangeRow` (per the header),
  using the card components as they are.
- E1: a "Final failed" log body is one mono block that keeps indentation; failing lines read in the error tone.
- E2: notification and wake bodies render markdown through the agent prose renderer (`markdownmessage.tsx`, used as
  it is).
- E3: compact wake rows keep the status label whole; the secondary text truncates first.
- E5: the three human-action markers share one look per the header.
- E7: the sender's "… N more characters: <wsh command>" tail is not shown as text.
- Decision 2 (Bubbles board): user bubbles render markdown through the agent prose renderer, keep the bubble shape
  and the Show more clamp: a long bubble rendered through markdown stays clamped (its height no more than the clamp's
  bound plus the Show more line) until Show more is pressed, fixing `clampedtext.tsx` if markdown children escape it. G1: a bubble that is a JSON document reads as code; a slash-command bubble
  sets only the command mono.
- Decision 4 (Compact board): compact keeps dropping the icons and loses the 19px indent (`EventBody` and the
  several-parts wrapper, and the head's second line); rendered is unchanged.

**Acceptance:**
- `transcript-census-rows` at both hosts, from specimens: 6/95/133 (Final log is one `pre`-like mono block, indentation
  kept, and the failing line computes the error token while a passing line does not), 71/89 (Retried and Run complete
  draw the same flat row), 52/95 (no raw `**` or backtick text in wake/notification bodies), 27/133 compact (status label not truncated:
  its scrollWidth equals clientWidth), 39/165 (the three markers have the same computed style), 7 (no "more
  characters:" text), 3 (bubble renders a heading and a list, Show more present and clamped height under its bound),
  35/162 (G1), 3 with a long brief (bubble height within the clamp bound before Show more, larger after), 6 compact (body's left edge equals the head's left edge, no 19px offset) and 6 rendered (indent kept)

### Task 7: wsh cards
**Depends on:** Task 1 (HOSTS, the scenario stub)
**Files:** `frontend/app/view/agents/wshcards-agents.tsx`, `frontend/app/view/agents/wshcards-dag.tsx`, `frontend/app/view/agents/wshcards-dagactions.tsx`, `frontend/app/view/agents/wshcards-initiative.tsx`, `frontend/app/view/agents/wshcards-notes.tsx`, `frontend/app/view/agents/wshcards-runs.tsx`, `frontend/app/view/agents/wshchangerow.tsx`, `frontend/app/view/agents/wshcall.ts`, `frontend/app/view/agents/wshcall.test.ts`, `frontend/app/view/agents/runcompletion.ts`, `frontend/app/view/agents/runcompletion.test.ts`, `frontend/app/view/agents/runscards.ts`, `frontend/app/view/agents/runscards.test.ts`, `frontend/app/view/agents/dagactioncards.ts`, `frontend/app/view/agents/dagactioncards.test.ts`, `frontend/app/view/agents/initiativecards.ts`, `frontend/app/view/agents/initiativecards.test.ts`, `scripts/cdp/scenarios-transcript-census-wsh.mjs`, `scripts/cdp/scenarios-transcript-dagactions.mjs`, `scripts/cdp/scenarios-transcript-initiative.mjs`, `scripts/cdp/scenarios-transcript-runs.mjs`

**What to build:** F1-F4, F7 (F6 is Task 6's).
- F1: a chunk row reads "Chunk N" only with a number; with none the chunk title truncates in the flexible span.
- F2: `fmtDuration` handles hours and days per the header.
- F3: change cards summarize the change (no doubled word, no raw initiative dump).
- F4: the dag-answer card names the picked option's label (0-based index) and its header names the task, not a bare id.
- F7: each row names its target from the call's argv, or drops the empty noun ("Noted on chunk" with no chunk, a bare
  "Amended").

**Acceptance:**
- unit tests in the model files: `fmtDuration` at 59m, 1h, 25h; the dag answer for `selectedindexes:[0]` names option
  0's label; a change summary without the doubled word
- `transcript-census-wsh` at both hosts, from specimens 108 (chunk card's width within the column), 137 (no "m" figure
  over 59), 45/50 (change card has no raw initiative dump), 85 (answer names the label), 14/15 (no row ends on "chunk" or reads only "Amended")
