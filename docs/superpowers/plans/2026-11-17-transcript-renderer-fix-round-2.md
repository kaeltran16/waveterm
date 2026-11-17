# Transcript renderer, fix round 2

**Effort:** effort:2bd27b27-0403-43cd-a540-ff66edce3b3c
**Spec:** `docs/superpowers/specs/2026-11-17-transcript-renderer-fix-round-2-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/remotemode/...`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs transcript-base transcript-live transcript-media transcript-boards transcript-arc transcript-initiative narration-feed agent-rendered sessions-detail-states`

The spec holds every decision (the user's and the calls made beyond them, numbered 1-22); a task cites them as
"spec #N". Each chunk's evidence is in `wsh effort show 2bd27b27-0403-43cd-a540-ff66edce3b3c`. All paths below are
under `frontend/app/view/agents/` unless they start with another top-level directory. Colours from the existing
`@theme` tokens only (`DESIGN.md`); motion from `docs/reference/motion-system.md`. Projection changes are followed by
`task sync:remoteweb`, and the regenerated `pkg/remotemode/web/static/projectors.js` is committed with them. The
transcript-* scenarios feed entries straight to `NarrationTimeline` (no projection), so render tasks build on the
entry types of Task 2, not on the projection task.

### Task 1: Split narrationtimeline.tsx into rows, panel body and clamp modules
**Depends on:** none
**Files:** `frontend/app/view/agents/narrationtimeline.tsx`, `frontend/app/view/agents/steprows.tsx`, `frontend/app/view/agents/tooldetailbody.tsx`, `frontend/app/view/agents/clampedtext.tsx`, `frontend/app/view/agents/tooldetailmodal.tsx`, `frontend/app/view/agents/toolrenderers.tsx`, `frontend/app/view/agents/permissionband.tsx`

**What to build:** a pure move, no behaviour change (spec #1), so later tasks own separate files.
`tooldetailbody.tsx` takes `ToolDetailBody`, `StatusSquare` and their helpers (`DiffRow`, `HighlightedCode`,
`ExitChip`, `lineWrap`). `steprows.tsx` takes the step stretch: `StepBox`, `StepRow`, `StepBody`, `StepTitle`,
`StepFacts`, `ImageReadsRow`, `ThoughtText`, `Elapsed` and their helpers. `clampedtext.tsx` takes `ClampedText` and
`CLAMP_LINES`. Small shared bits (`TurnChevron`, `Affordance`, `AddsDels`) go where their users can import them
without a cycle. `narrationtimeline.tsx` keeps the feed, `TurnFold`, the event and notification rows, and the
exports hosts import from it today (`NarrationTimeline`, `CommandChip`, `PersonBubble`, `VERB`).

**Interfaces:** `tooldetailbody.tsx` exports `ToolDetailBody({ detail, variant })` and `StatusSquare`;
`steprows.tsx` exports `StepBox` (same props as today); `clampedtext.tsx` exports `ClampedText` and `CLAMP_LINES`.
Importers of the moved symbols (`tooldetailmodal.tsx`, `toolrenderers.tsx`, `permissionband.tsx`) import from the new
modules.

**Acceptance:**
- Check is clean and the existing vitest suites under `frontend/app/view/agents/` pass unchanged.
- `transcript-base` and `narration-feed` pass unchanged (no scenario edits).

### Task 2: Entry types for errors, notification source and panel data
**Depends on:** none
**Files:** `frontend/app/view/agents/agentsviewmodel.ts`

**What to build:** the type fields the projection fills and the render tasks draw, so neither waits on the other
(spec #3, #5, #6, #15, #16). Types only, all optional, so the pi, codex and opencode projections are untouched.

**Interfaces:** `AgentActionEntry.error?: string`; the notification entry gains `ts?: number` and
`source?: "command" | "monitor" | "subagent"`; `ActionDetail` read gains `path?: string`; grep gains
`pattern?: string` and `ignoreCase?: boolean`.

**Acceptance:**
- Check is clean.

### Task 3: Projection: anchored tags, ANSI, errors, notification source, panel data
**Depends on:** Task 2 (fills the fields it adds)
**Chunk:** Claude projection: a user record with an interruption text block plus images yields an extra empty-text user bubble
**Chunk:** Prompt that mentions <task-notification> or <local-command-stdout> is dropped; worker briefs draw as an empty 'Subagent finished' card
**Chunk:** Bash output shows raw ANSI escape codes
**Files:** `frontend/app/view/agents/transcriptprojection.ts`, `frontend/app/view/agents/transcriptprojection.test.ts`, `frontend/app/view/agents/tooldetail.ts`, `pkg/remotemode/web/static/projectors.js`

**What to build:** the projection side of chunks 21, 24, 25, 41, 42, 43, 44, 45, 46, 50 (spec #3, #5, #6, #14, #15,
#16, #22). The drawing belongs to Tasks 6, 7, 9 and 10.
- 21: a user record holding an interruption marker yields no empty-text user entry for its images.
- 24: `<task-notification>` and `<local-command-stdout>` are recognised only when the record's text starts with
  them; a prompt that quotes them later is a user entry with its full text.
- 25: a notification projected from a user record carries the record's `ts`.
- 41: a Bash tool result's `detail.output` is ANSI-stripped with the existing `stripAnsi`.
- 42/43: `error` set per spec #3, with the `<tool_use_error>` wrapper removed; a refused Bash call's `detail.output`
  no longer holds the wrapper.
- 44: detail paths under the record's `cwd` (edit file paths, grep locations, the read path) are relative to it,
  forward slashes; a path outside the cwd stays absolute with forward slashes.
- 45/46: the grep detail carries the tool input's pattern and case-insensitive flag; the read detail carries the
  file path.
- 47 (data): a Write that created a file keeps badge `A`; a Write whose result is an update with a structured patch
  draws that patch with badge `M` (confirm what the projection does today and keep or fix it).
- 50: a notification's `source` from its summary's leading words (spec #5).
Then `task sync:remoteweb`.

**Acceptance:**
- Unit tests in `transcriptprojection.test.ts` cover each bullet above through `projectTranscript` with record
  fixtures shaped like the evidence sessions (a brief quoting both tags; a Monitor-started notification record; an
  Edit and a Monitor call that failed; a refused Bash call; a cat -n Read; a Grep with `-i`).
- `pkg/remotemode/web/static/projectors.js` is regenerated, never hand-edited, and `pkg/remotemode/web/projectors.test.js`
  passes.

### Task 4: wshcall quoting and display flags; wsh cards fall back to the recorded output
**Depends on:** none
**Chunk:** wshcall: a single-quoted '$E' is expanded like a double-quoted one (tokenizer drops quote type); shell keeps it literal
**Chunk:** wshcall: a display-only flag holding $ (e.g. --note "costs $5") marks the call unresolved, so the card draws as the generic row
**Files:** `frontend/app/view/agents/wshcall.ts`, `frontend/app/view/agents/wshcall.test.ts`, `frontend/app/view/agents/recordedoutput.tsx`, `frontend/app/view/agents/wshcards-initiative.tsx`, `frontend/app/view/agents/wshcards-dag.tsx`, `frontend/app/view/agents/wshcards-dagactions.tsx`, `frontend/app/view/agents/wshcards-runs.tsx`, `frontend/app/view/agents/wshcards-notes.tsx`, `frontend/app/view/agents/wshcards-agents.tsx`, `scripts/cdp/scenarios-transcript-initiative.mjs`

**What to build:** spec #12 for chunks 19 and 20, and the card half of chunk 49 (spec #11): a wsh card or view whose
fetch fails draws its step's recorded output (ANSI stripped) under one muted line naming the error, instead of the
error line alone. The recorded output is one new component, reused by Task 9 for the "Raw output" toggle and by
Task 10 for the test/diff cards' raw view. Touch only the card files that draw a load error today. `tokenize`'s
`Token` type stays compatible (`commandtitle.ts` uses it): any new field is optional.

**Interfaces:** `recordedoutput.tsx` exports `RecordedOutput({ output, compact }: { output: string; compact?: boolean })`,
drawing the output ANSI-stripped in the style of today's `RawOutput` (`toolrenderers.tsx`).

**Acceptance:**
- `wsh effort chunk add '$E' x` keeps `$E` literal and resolved; `E=abc && wsh effort chunk add "$E" x` still
  expands to `abc`; `wsh effort chunk note abc 3 --note "costs $5"` keys `chunk-note`, not `other-change`; an id
  positional holding an unexpanded `$X` still marks the call unresolved; the existing `$(wsh ...)` cases keep passing.
- `transcript-initiative` gains a step: an `effort show` step whose fetch fails (no seeded data, recorded output
  present) opens to the recorded output with the error line above it, and no bare "Couldn't load" alone.

### Task 5: One Show earlier control; markdown table cells wrap
**Depends on:** none
**Chunk:** Show earlier control JSX is duplicated in renderedview.tsx and sessionsdetail.tsx; extract one component
**Chunk:** Markdown tables never wrap: prose cells clip behind a horizontal scroll
**Files:** `frontend/app/view/agents/showearlier.tsx`, `frontend/app/view/agents/renderedview.tsx`, `frontend/app/view/agents/sessionsdetail.tsx`, `frontend/tailwindsetup.css`, `scripts/cdp/scenarios-agent-rendered.mjs`

**What to build:** spec #19 and #20. The component keeps today's look and its entrance (`viewFade` under
`AnimatePresence initial={false}`, moment 5's opacity fade), and each host keeps its own data attribute. Check
whether `task sync:remoteweb` output changes from the CSS edit; commit any generated change.

**Acceptance:**
- The existing `agent-rendered` "show earlier" step and the `sessions-detail-states` earlier step pass unchanged.
- `agent-rendered` gains a step: a reply holding a table with a long description column draws every cell's text
  within the column width (cells wrap; the table's scroll width does not exceed its box), shown in a screenshot.

### Task 6: Layout: notification turns, stopped steps, merged edits, latest turn, command titles
**Depends on:** Task 1, Task 2 (the notification entry's ts it reads), Task 5 (both edit scenarios-agent-rendered.mjs)
**Chunk:** A turn started by a background-task notification does not start a new turn: hours of separate turns fold into one
**Chunk:** Command rows: verb taken from a wrapper or subshell, and repeats the command's first word
**Chunk:** Command preview spends its width on 'cd <worktree> &&'
**Chunk:** An ended session's last unanswered step spins forever with a live clock
**Files:** `frontend/app/view/agents/transcriptlayout.ts`, `frontend/app/view/agents/transcriptlayout.test.ts`, `frontend/app/view/agents/commandtitle.ts`, `frontend/app/view/agents/commandtitle.test.ts`, `frontend/app/view/agents/narrationtimeline.tsx`, `scripts/cdp/scenarios-transcript-base.mjs`, `scripts/cdp/scenarios-transcript-live.mjs`, `scripts/cdp/scenarios-transcript-media.mjs`, `scripts/cdp/scenarios-transcript-boards.mjs`, `scripts/cdp/scenarios-agent-rendered.mjs`

**What to build:** spec #6 (25), #7 (40), #8 (29, layout half), #9 (28, 34) and the layout half of #2 (27/35): the
turn item no longer starts open for a tool card; it carries `latest` per spec #2 (never while active; when not
active, on every turn item of the last finished turn), `TurnFold` stops reading the removed field, and
`LayoutOpts.renderers` goes with it (its only use). Substitutions for chunk 28 are skipped inside `commandtitle.ts`
(do not change `tokenize`, whose `$(wsh ...)` handling `wshcall.ts` relies on).
Update every scenario step that reads a tool output card (test, diff or image) or an open fold in a finished turn,
since the fold now starts closed: open it first (`openFolds` from `scripts/cdp/transcript-fixture.mjs`). Known ones:
`agent-rendered` ~564 (diff card), 603/691 (git-diff `showCard`), 653/661 (test card), 700 (image card), the "cards in
a turn" step at 705 and the "turn header" step after it (which asserts the fold starts expanded: rewrite it to the
new rule); `transcript-media` ~93 (image thumbs); `transcript-boards` ~523 (image cards); and any in
`transcript-base`.

**Interfaces:** `LayoutItem` turn: `{ kind: "turn"; startIndex; items; fold; latest: boolean }` (no `open`).
`Step.edits?: number` (set when two or more edits merged). `stepTitle(action).mono` is the preview without a leading
`cd`.

**Acceptance:**
- Unit tests: six turns each started by a non-queued notification fold into six turns with their five middle replies
  outside the folds, while a queued notice mid-turn does not split; a pending step lays out `stopped` when not active
  and `running` when active; four consecutive edits to one file make one step with summed counts and `edits: 4`, and a
  failed edit between them breaks the merge; not active, every turn item of the last turn (also one split by a mark)
  has `latest: true` and no earlier one does; active, no turn item has it; `timeout 120 claude plugin validate x`
  titles from `claude`, `env | grep FOO` from `grep`, `cd ~/p && F=$(ls -t | head -1); node -e "..."` reads "Ran a
  Node script", and a title that only names the program is dropped; `cd C:/x && npm test` previews as `npm test`.
- `transcript-live` gains a step: an inactive transcript whose last step is pending shows that row as stopped with no
  spinner and no elapsed clock.
- `transcript-base` gains a step: two notification-started turns draw as two "Worked for" lines, each with its reply
  visible after it; and a step where a `cd <dir> && <cmd>` row's preview shows `<cmd>`.
- Every scenario named in Files passes.

### Task 7: Tool panels: relative paths, grouped grep, line gutter, new-file preview, wide full view
**Depends on:** Task 1, Task 2 (the read path and grep pattern fields it draws)
**Chunk:** Panel paths are absolute, so the file name is cut off
**Chunk:** Search panel: path on every line, code cut off even in full view, match not marked
**Chunk:** Read panel: line numbers are coloured as code and wraps run under them
**Chunk:** Decide: a newly written file draws as an all-green diff
**Chunk:** Open full view adds little over the inline panel
**Files:** `frontend/app/view/agents/tooldetailbody.tsx`, `frontend/app/view/agents/tooldetailmodal.tsx`, `frontend/app/view/agents/tooldetailmodel.ts`, `frontend/app/view/agents/tooldetailmodel.test.ts`, `scripts/cdp/narrationfeed.mjs`

**What to build:** spec #14 (render half: truncate from the left), #15, #16, #17 and decision 47 as the spec scopes
it: every edit file with badge `A` (a Write's new file, and a new file in a git diff card) draws as a file preview
through the read renderer with a "new" badge. The pure parts (cat -n gutter parse, grep grouping and match ranges,
the code/plain decision by extension, left truncation if done in JS) go in `tooldetailmodel.ts` with tests beside it.
The full view also leads with `action.error` when set (spec #4). This changes the grep panel that `transcript-base`'s
StepsOpen step reads; Task 9 updates that step.

**Acceptance:**
- Unit tests in `tooldetailmodel.test.ts`: a cat -n snippet (tab and `→` forms) parses to numbers and text, a snippet
  without the prefix gets no gutter; grep matches group by file in order with match ranges, an invalid regex yields
  no ranges; `.ts` is code and `.output`/`.log`/no extension is plain.
- `narration-feed` gains steps, each with a screenshot: an Edit panel header ends with the file name; a grep panel
  shows one header per file with marked matches; a Read panel's numbers sit in a gutter with a wrapped line hanging
  under its text; a Write of a new file shows the preview with "new" and no `+` rows; Open full view is wider than
  the inline panel and shows a grep line whole, with no status square on a successful call.

### Task 8: Clamp the latest wake card's items
**Depends on:** Task 1 (uses ClampedText from clampedtext.tsx)
**Chunk:** Latest wake card's 'Since the last wake' items are unclamped walls
**Files:** `frontend/app/view/agents/arcmessagerow.tsx`, `frontend/app/view/agents/clampedtext.tsx`, `scripts/cdp/scenarios-transcript-arc.mjs`

**What to build:** spec #21: each "Since the last wake" item in the open (latest) wake clamps to 3 lines behind Show
more through `ClampedText` (a new `CLAMP_LINES` key). The toggle is `ClampedText`'s, no new motion.

**Acceptance:**
- `transcript-arc` gains a step: the latest wake with a ~12-line item draws it at 3 lines with Show more, a short
  item has no Show more, and a click shows the whole item.

### Task 9: Step rows: errors, merged edits, colours, durations, raw output
**Depends on:** Task 6, Task 2 (draws the error field), Task 4 (uses RecordedOutput), Task 7 (updates the StepsOpen grep step its grouped panel changed)
**Chunk:** Consecutive edits to one file draw as one row each
**Chunk:** 'Raw output, 1 lines'
**Chunk:** Sub-second durations on every step row
**Chunk:** Decide: an open turn's text is one mid-grey; step labels and thoughts share a colour
**Chunk:** A refused command shows the raw <tool_use_error> wrapper
**Chunk:** A failed call never shows why it failed
**Chunk:** A wsh card that cannot load hides the recorded output; 'Raw output' is a label, not a control
**Files:** `frontend/app/view/agents/steprows.tsx`, `scripts/cdp/scenarios-transcript-base.mjs`

**What to build:** in `steprows.tsx`: the merged-edits row draws "N edits" beside its summed counts (29); spec #10
(38, `STEP_DURATION_MIN_MS` named as a constant); the user's decision on 39 (titles `text-secondary` always, thoughts
`text-ink-mid`, commands and durations `text-muted`); spec #4 (42, 43), drawn in `StepBody`, not in
`ToolDetailBody`: a row with `error` is clickable; a failed call's body leads with the error in the error tone; a
refused Bash call's body shows the command, then the reason as a note under it. Spec #11 (49 row half, 30): drop the
label under test/diff cards, make "Raw output" under a wsh view a toggle (`aria-pressed`) revealing
`RecordedOutput`, opening with `PaneReveal` (moment 6b). Update the `transcript-base` StepsOpen step for Task 7's
grouped grep panel and the dropped "Raw output, N lines" footer.

**Acceptance:**
- `transcript-base` gains steps, each with a screenshot: four edits to one file draw one row with the summed counts
  and "4 edits", whose body shows each edit; a 0.2 s row shows no duration and a 3 s row does; a done row's title and
  a running row's title share `text-secondary`; a failed Edit with an error opens to the error first; a failed
  Monitor call with no detail opens to its error; a refused Bash row opens to its command with the reason as a note
  under it and no `<tool_use_error>` text; a wsh view's "Raw output" toggle reveals the recorded output; no
  "Raw output, N lines" label is left under a test card, and no step's text reads "1 lines".
- The StepsOpen step passes against the grouped grep panel.

### Task 10: Folded turns draw card headers; thoughts unclamped; notification labels
**Depends on:** Task 9, Task 8
**Chunk:** Decide: one output card opens a whole long turn
**Chunk:** Decide: output cards draw at full size in finished turns
**Chunk:** Clamped thought ending at a sentence reads '....'
**Chunk:** Decide: thoughts outweigh steps in an open turn
**Chunk:** Background shell commands are labelled 'Subagent finished'
**Files:** `frontend/app/view/agents/steprows.tsx`, `frontend/app/view/agents/narrationtimeline.tsx`, `frontend/app/view/agents/toolrenderers.tsx`, `frontend/app/view/agents/clampedtext.tsx`, `scripts/cdp/scenarios-transcript-base.mjs`, `scripts/cdp/scenarios-agent-rendered.mjs`

**What to build:** the render half of spec #2 (27/35): `TurnFold` passes whether its turn is `latest` down to its
step rows; steps outside any fold count as latest. A test or diff card in a non-latest turn draws as its header only,
and a click on the header opens its body (`PaneReveal`, moment 6b); in the latest or live turn cards draw open as
today. The image card draws the same in every turn (spec #2). The test/diff cards' raw view (`RawOutput`) uses
`RecordedOutput` (spec #11). The user's decision on 33/31: thoughts (inside a stretch and standalone) draw in full
with no Show more; remove the now-unused `thought` clamp key and check no other `ClampedText` use can show the
"...." (bubbles keep their clamp). Spec #5 (50): the notification row and the notice row label by `source`, and a
summary that starts with the label's words does not repeat them. Update the `agent-rendered` and `transcript-base`
steps that read cards in earlier turns to the header-only rule.

**Acceptance:**
- `transcript-base` gains steps, each with a screenshot: a transcript of three finished turns, the first holding a
  diff card, a test card and an image read, draws every turn folded; opening the first shows the diff and test cards
  as headers only (diff files and +/-, tests passed/failed) with no scroll box, the image read's thumbnails as usual,
  and a header click opens the card; the last turn's cards draw open when it is opened; a merged five-thought block
  draws in full with no Show more; a "Background command" notification, a "Monitor event" one and a subagent one
  carry their own labels.
- `agent-rendered` passes.

### Task 11: Image rows: thumbnail strip, fitted frame
**Chunk:** ImageThumbs compact prop has no caller; drop it or use it in compact feeds
**Chunk:** Grouped image reads show no thumbnails until opened
**Chunk:** Image read: small thumbnail in a large empty frame
**Files:** `frontend/app/view/agents/steprows.tsx`, `frontend/app/view/agents/toolrenderers.tsx`, `frontend/app/view/agents/imagethumbs.tsx`, `scripts/cdp/scenarios-transcript-media.mjs`

**What to build:** spec #18 and #13: a closed "Read N images" row shows a small strip of its thumbnails (the compact
height, clicking one opens the zoom view as elsewhere); the image read card's frame fits its thumbnails. Confirm the
`compact` prop's callers and record in the task report that chunk 23 closes because `BubbleAttachments` uses it (or
drop the prop if that is no longer true).

**Acceptance:**
- `transcript-media` gains steps, each with a screenshot: a closed "Read 4 images" row shows four thumbnails no
  taller than `THUMB_MAX_HEIGHT_COMPACT_PX`; a single image read's card is no wider than its thumbnails plus padding;
  the existing thumbnail and zoom steps pass.
