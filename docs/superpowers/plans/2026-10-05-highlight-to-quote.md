# Highlight-to-quote in the review dialog implementation plan

**Effort:** effort:43b12224-7afd-4632-a600-13bdb96064dd
**Verify:** `node scripts/verify.mjs ./pkg/agentask ./pkg/jarvis ./pkg/orchestrate`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs doc-review doc-review-notes`
**Prototype:** C:/Users/kael02/IdeaProjects/waveterm/.superpowers/design/highlight-to-quote/project/Main.dc.html

## Approved design and scope

The human approved the mockup and the decisions below in the run's single Spec review. There is no separate
spec. Read `Main.dc.html` (the design, interactive: its `<script>` is the behaviour), `Crowded.dc.html` (many
decisions, many notes) and `canvas.json` in the Prototype folder, plus `DESIGN.md` and `AGENTS.md`. The canvas
is gitignored scaffolding: read it at its absolute path, it is not in a worker checkout. Do not commit it and
do not delete it (the lead removes it after the final verifier has used it).

**Goal:** in the spec/plan review dialog (`frontend/app/view/agents/docreviewdialog.tsx`), selecting text in
the document opens a note field under the selection; notes collect in the rail under the decisions and travel
with Approve or Request changes to the lead as one message.

What the mockup settles (copy, sizes, layout, states): take them from the boards. In short:

- Selecting text in the document pane opens a note field directly under the selection. Enter adds the note,
  Esc drops it. The passage is tinted while the field is open and stays highlighted until its note is removed.
- Notes sit in the right rail under the decisions, pinned to the rail's bottom under a divider. Decisions
  scroll on their own above; the notes list is capped at 300px and scrolls inside itself. A note is a compact
  two-line row (passage on one line with an ellipsis, note on one line, "No note yet" in muted when empty);
  clicking a row opens it (whole passage plus an editable field; Enter or Esc closes it), one open at a time;
  each row has a remove button. The "Your notes · N" header collapses the list. With no notes the section is
  not rendered and the decisions get the whole rail.
- Footer copy with notes: "<approve label> with N notes", "Request changes · N notes", the textarea label
  "Anything beyond your N notes?" with placeholder "Optional", "Send N notes to the lead", and the sent line
  "Sent: <approve label>, with N notes" / "Sent: Request changes, with N notes". "1 note" is singular.
  Without notes every string is what it is today.
- The dialog is at most 1240 x 870 (from 1160 x 780), the rail 460px (from 380px).
- Document pane only, for both the spec and the plan review. The canvas pane has nothing to quote.

Decisions made beyond the mockup (approved):

1. An approval with notes is one text answer: the Approve option's own cleaned label on the first line, a
   blank line, then the notes. An approval with no notes stays the plain option pick it is today. No wire or
   RPC type changes (`AgentAnswerItem` still carries picks or text, never both).
2. Request changes sends the overall message (if any), a blank line, then the notes, with no label line. With
   notes the message may be empty; without notes it is required, as today.
3. Each note is `> <passage>` on one line (whitespace collapsed to single spaces, the whole passage, never
   cut), the note on the next line, and a blank line between notes. A note left empty sends its passage alone.
   Notes go in document order, not the order written.
4. A note stores its passage's character offsets in the rendered document text. That gives document order and
   lets highlights be repainted when the dialog is hidden and reopened. If the file changed and the offsets no
   longer hold the passage, the note is kept and sent but not painted.
5. Notes live per ask (keyed by `askId`) in a jotai atom, survive hiding the dialog, and are cleared when the
   ask goes away, not at send: the rail and the sent line keep them until the lead picks the answer up.
6. A selection counts only when it starts and ends inside the document text. The field opens under it, or
   above it when there is no room below. A passage can be quoted twice and passages may overlap.
7. Highlights are painted with the CSS Custom Highlight API (WebView2 is Chromium, which has it); the rendered
   markdown is never rewrapped. Kept notes use `--color-accentbg`; the open one uses
   `color-mix(in srgb, var(--color-accent) 32%, transparent)`. No new tokens.
8. A session without Arc's Claude mod has answers typed into its terminal picker, which takes one line only.
   There the server folds the message onto one line instead of refusing it.
9. The lead's Spec review and Plan review instructions say that an answer starting with the approve label is
   an approval whose quoted notes are applied before proceeding.

Out of scope: the Code surface's markdown preview and the run report; quoting from the decisions list;
selecting with the keyboard; clicking a note to scroll the document to its passage; merging `MarkdownMessage`
into `element/markdown.tsx`.

## Global constraints

- Build on `MarkdownMessage` (`frontend/app/view/agents/markdownmessage.tsx`) as the dialog uses it; do not
  change what it renders.
- Colors come from existing `@theme` tokens in `frontend/tailwindsetup.css` only. The mockup's raw
  `rgba(...)` values are stand-ins for tokens the dialog already uses (`border-accent/45`, `bg-background/20`).
- Pure logic lives in `docreviewnotes.ts` with `docreviewnotes.test.ts` beside it; there are no jsdom render
  tests in this repo. The rendered result is proven by the CDP scenario.
- Comments say why, never what, lower case, only when needed. No new dependencies.
- Never hand-edit generated files. Nothing here changes a wshrpc type.

## Review focus

- A selection that starts in the document and ends outside it (the file card, the rail): nothing opens.
- Esc in the note field or in an open row drops or closes only that field; it must not hide the dialog
  (`ModalShell` listens for Escape on `window`). Enter in those fields must not approve.
- Ctrl+Enter approves with the notes; while the Request changes textarea is open it sends the request.
- Hide the dialog and reopen it: notes are still listed and their passages are highlighted again.
- A second ask on the same agent starts with no notes.

---

### Task 1: Notes model and answer text
**Depends on:** none

Files: create `frontend/app/view/agents/docreviewnotes.ts` and `frontend/app/view/agents/docreviewnotes.test.ts`.
Follow `docreview.ts` / `docreview.test.ts` for shape and test style.

Produces (Task 3 relies on these exact names):

```ts
export interface DocNote { id: string; start: number; end: number; text: string; note: string }
export type DocReviewSent = "approve" | "request";
export interface DocNotesState { notes: DocNote[]; sent?: DocReviewSent }

// askId -> that ask's notes
export const docNotesAtom: PrimitiveAtom<Record<string, DocNotesState>>;

export function normalizePassage(raw: string): string;
export function addNote(notes: DocNote[], n: Omit<DocNote, "id">): DocNote[];
export function setNoteText(notes: DocNote[], id: string, note: string): DocNote[];
export function removeNote(notes: DocNote[], id: string): DocNote[];
export function orderNotes(notes: DocNote[]): DocNote[];
export function isPaintable(note: DocNote, docText: string): boolean;
export function composeAnswer(input: {
    kind: DocReviewSent;
    approveLabel: string;
    message: string;
    notes: DocNote[];
}): string;
export function pruneNotes(
    state: Record<string, DocNotesState>,
    liveAskIds: Set<string>
): Record<string, DocNotesState>;
export function notesCopy(input: {
    count: number;
    approveLabel: string;
    placeholder: string;
}): {
    approve: string;
    request: string;
    noteLabel: string;
    notePlaceholder: string;
    send: string;
    sentApprove: string;
    sentRequest: string;
};
```

Rules:

- `start`/`end` are offsets into the document container's text (its text nodes concatenated in order).
  `text` is the passage as shown and sent: `normalizePassage` collapses every whitespace run to one space and
  trims.
- `addNote` trims `note`, gives the note an id unique within the list, and returns the list in document order.
  It allows a duplicate passage and overlapping ranges. `setNoteText` and `removeNote` return new arrays and
  leave an unknown id as a no-op.
- `orderNotes`: by `start`, then `end`, then insertion order. Never mutates.
- `isPaintable`: `docText.slice(start, end)` and `note.text` are equal once all whitespace is removed from
  both (a selection's text and the text nodes disagree on whitespace between blocks). False for an empty or
  out-of-range slice.
- `composeAnswer`: blocks joined by one blank line. Approve: `approveLabel` first, then the note blocks.
  Request: the trimmed `message` first when not empty, then the note blocks. A note block is `> ${text}`,
  plus `\n${note}` when the trimmed note is not empty. Notes go through `orderNotes`. No trailing newline.
- `pruneNotes` drops every ask id not in `liveAskIds`, and returns the same object when nothing is dropped
  (so a `globalStore.set` with it is a no-op for subscribers).
- `notesCopy` with `count === 0` returns today's strings: `approve` = `approveLabel`, `request` =
  "Request changes", `noteLabel` = "What should change?", `notePlaceholder` = `placeholder`, `send` =
  "Send to the lead", `sentApprove` = `approveLabel`, `sentRequest` = "Request changes, with your note".
  With notes: "<approveLabel> with N notes", "Request changes · N notes", "Anything beyond your N notes?",
  "Optional", "Send N notes to the lead", "<approveLabel>, with N notes", "Request changes, with N notes";
  "1 note" for one.

Acceptance, proven by `npx vitest run frontend/app/view/agents/docreviewnotes.test.ts`:

- notes added out of order come back in document order, ties broken by `end` then insertion;
- a passage quoted twice makes two notes with different ids;
- `composeAnswer` for approve with two notes, for request with a message and notes, for request with notes
  and an empty message, and for a note with no text (passage line alone); each asserted as an exact string;
- `normalizePassage` collapses newlines and tabs;
- `isPaintable` true across a block boundary where only whitespace differs, false when the document text
  changed, false when the range is past the end;
- `pruneNotes` drops a gone ask and returns the identical object when all are live;
- `notesCopy` for 0, 1 and 6 notes, with the plan review's label "Accept all and proceed".

### Task 2: Server folds a multi-line answer for the typed path; lead instructions
**Depends on:** none

Files: `pkg/agentask/deliver.go`, `pkg/agentask/encode.go` (only if the helper belongs there),
`pkg/agentask/deliver_test.go`, `pkg/jarvis/leadprompt.go` and its test file, `pkg/orchestrate/planreview.go`
and its test file.

Background: `agentask.injectAnswer` has two deliveries. A waiter (`wsh ask --wait`: Arc's Claude mod and pi)
receives the answers as JSON, so multi-line text arrives whole and must stay untouched. With no waiter the
answer is typed into the terminal (`EncodeAnswer` for a picker, `proseTextKeys` for a prose ask), where
`validateFreeText` refuses any control character, so a quoted-notes answer would be refused after the
cockpit already showed it as sent.

Do:

- In `injectAnswer`, after the waiter miss and before validation/encoding, fold each answer's `Text`: every
  run of CR/LF, with the spaces and tabs around it, becomes `" | "`; leading and trailing breaks are trimmed.
  Text with no line break is unchanged byte for byte. Other control characters are still refused by
  `validateFreeText`. `ValidateAnswers` itself does not change (the Gatekeeper relies on it).
- Mark the simplification where the fold lives: `// ponytail: typed one rune per KeystrokeDelay, so a long
  folded answer is slow; a bracketed paste if this path matters`.
- `pkg/jarvis/leadprompt.go`, in the architectural path's `Spec review` instructions, and in the
  `plan review failed` line's `Plan review` ask; and `pkg/orchestrate/planreview.go` `proceedPastPlanReview`:
  add one sentence each saying that the human can quote passages of the document with a note on each, so an
  answer that starts with the approve option's label is an approval, and its `> ` quoted notes are applied
  before proceeding; any other text is a change request. Keep each prompt's existing wording otherwise.

Acceptance:

- `go test ./pkg/agentask -run 'TestDeliverAnswerFoldsMultilineText|TestDeliverAnswerWaiterKeepsMultilineText|TestFoldAnswerLines'`:
  a keystroke delivery of `"Approve\n\n> a passage\nreword it"` types `Approve | > a passage | reword it`
  then enter (captured through `SetSendInputForTest` or the package's own `sendInput` swap, as the existing
  deliver tests do), and returns delivered; a waiter delivery receives the text with its newlines; the fold
  helper covers `\r\n`, a run of blank lines, surrounding spaces, and text with no break.
- `go test ./pkg/jarvis -run 'TestLeadPromptApprovalWithNotes'` and
  `go test ./pkg/orchestrate -run 'TestPlanReviewAskMentionsQuotedNotes'`: the prompts carry the sentence.
  If an existing test pins the full prompt text, update it in the same task.

### Task 3: The dialog: select, note, highlight, rail, footer
**Depends on:** Task 1

Files: `frontend/app/view/agents/docreviewdialog.tsx`; create `frontend/app/view/agents/docreviewnotes.tsx`
(the note field, the rail's notes section, and the DOM half: text offsets, ranges, highlights);
`frontend/tailwindsetup.css` (the two `::highlight()` rules only); `frontend/app/view/agents/cockpitshell.tsx`
(pruning). Anything that turns out to be pure goes into `docreviewnotes.ts` with a test, not into the tsx.

Consumes everything Task 1 produces. Read `agents.tsx` `submitAnswer` / `setAnswerText` / `toggleAnswer`,
`askanswer.ts` and `modals/modalshell.tsx` before wiring.

Produces (Task 4's scenario relies on these exact hooks):

- `data-doc-review-doc` on the element wrapping the rendered `MarkdownMessage`; offsets count its text nodes.
- `data-doc-note-field` on the note field's container; it holds one `input`, a Cancel and an Add note button.
- `data-doc-notes` on the rail's notes section; `data-doc-notes-toggle` on its "Your notes · N" header
  button, which carries `aria-expanded`.
- `data-doc-note-row="<note id>"` on each row, with `data-open="true"` on the open one; the remove button's
  `aria-label` is "Remove this note".
- Highlight registry names `doc-review-quoted` and `doc-review-pending` (`CSS.highlights`).

Behaviour:

- Layout and copy as the boards: dialog `h-[min(870px,calc(100vh-5rem))] w-[min(1240px,calc(100vw-5rem))]`,
  rail `w-[460px]`; the decisions list keeps its own scroll, the notes section is `flex-none` under a
  `border-t border-edge-mid` with its list capped at 300px. No notes: the section is absent.
- On mouseup in the document pane: read the selection. Ignore it when it is collapsed, when its normalized
  text is empty, or when either end is outside `[data-doc-review-doc]`. Otherwise it becomes the pending
  passage (offsets, normalized text), the field opens under the selection's bounding rect, 340px wide,
  focused, and flips above the selection when it would not fit below within the dialog. A new selection
  replaces the pending one. The field never renders once the ask is sent.
- Field keys: Enter adds the note (an empty note is allowed) and closes the field; Esc drops it. Both stop
  the event so `ModalShell` neither hides the dialog nor submits. The open row's field: Enter or Esc closes
  the row, same rule. Ctrl+Enter is left to `ModalShell`.
- Highlights: after each render that changes notes, the pending passage or the loaded text, rebuild ranges
  from offsets and set `doc-review-quoted` (every note that `isPaintable`) and `doc-review-pending`. Delete
  both registry entries when the document pane unmounts. If `CSS.highlights` is missing, skip painting; the
  notes still work.
- State: notes and `sent` live in `docNotesAtom` under the ask's `askId`. The pending passage, its draft,
  the open row and the collapsed flag are dialog-local and reset when the `askId` changes. The Request
  changes message stays local as today.
- Approve: with no notes, exactly today's path (toggle the approve option, submit). With notes:
  `model.setAnswerText(agent.id, 0, composeAnswer({ kind: "approve", approveLabel, ... }))`, submit, record
  `sent: "approve"`. `approveLabel` is the cleaned label the button already shows without its count.
- Request changes: Send is enabled when the message is not empty or there are notes; it sends
  `composeAnswer({ kind: "request", ... })` and records `sent: "request"`.
- Sent line: from `notesCopy` and the recorded `sent`; with no notes, today's logic.
- Pruning: in `cockpitshell.tsx`, beside `useResetAnswerDraftsOnAskChange`, set `docNotesAtom` to
  `pruneNotes(current, <the askIds of every agent's live ask>)` whenever that id set changes.
- The canvas pane is untouched: no field, no notes section.

Acceptance: the plan's Check command is clean, `npx vitest run frontend/app/view/agents/docreviewnotes.test.ts`
and `npx vitest run frontend/app/view/agents/docreview.test.ts` pass, and `npx eslint` plus
`npx prettier --check` are clean on the touched files. The rendered views and interactions are shown by
Task 4's scenario `doc-review-notes`: step 2 (selection opens the field, passage tinted), step 3 (Enter adds
and does not approve; the Main board), step 4 (Esc drops the field, the dialog stays), step 5 (a selection
ending outside the document opens nothing), step 6 (the field flips above a selection at the pane's bottom),
step 7 (hide and reopen keeps notes and highlights), step 8 (the Crowded board: open row, empty note row,
capped list), step 9 (editing in the open row: Enter saves and closes, Esc closes, the dialog stays), step 10
(collapse, remove, empty rail), step 11 (Request changes with notes), step 12 (Ctrl+Enter approves with the
notes; the sent line). That a new ask starts with no notes is proven by Task 1's `pruneNotes` test and the
`askId` key, not by a scenario step.

### Task 4: CDP scenario `doc-review-notes`
**Depends on:** Task 3
**Chunk:** Build: highlight-to-quote in the review dialog

Files: `scripts/cdp/scenarios.mjs` only (the scenario, registered in the export list beside `docReview`).
Reuse the `doc-review` scenario's helpers (`docReviewRoster`, `docReviewTreeRow`, `docReviewWait`,
`docReviewEscape`, `arrangeFixtureRun`, `teardownFixtureRun`); give `docReviewRoster` an optional decisions
argument rather than copying it. Do not change what `doc-review` asserts.

Arrange: write a fixture spec whose text is the mockup document (the "Highlight-to-quote in the review
dialog" headings and paragraphs from `Main.dc.html`), a roster whose lead asks a Spec review of it with the
mockup's 4 decisions, pin the viewport to 1600 x 950, reload, and open the dialog through the lead's tree
tag as `doc-review` does. Selections are made in the page: find the passage's text node under
`[data-doc-review-doc]`, build a `Range`, put it in `getSelection()`, and dispatch `mouseup` on that
container. Type into an input with the native value setter plus an `input` event, and send Enter/Escape as
`KeyboardEvent`s dispatched on the focused input (CDP `Input.dispatchKeyEvent` does not reliably reach the
WebView). Scope every query to the dialog panel or a `data-*` container, never the document.

Steps, each recorded with a detail JSON, shots under `cdp-shots/`:

1. The dialog is open on the fixture spec with 4 decisions, no `[data-doc-notes]`, and the footer reads
   "Approve" and "Request changes". The panel is 1240 wide and the rail 460.
2. Selecting "The passage stays highlighted in the document until its note is removed." opens
   `[data-doc-note-field]` under the selection (its top at or below the selection's bottom) with its input
   focused, and `doc-review-pending` holds one range.
3. Typing a note and Enter: the field closes, `[data-doc-notes]` shows "Your notes · 1" with one row holding
   the passage and the note, `doc-review-quoted` holds one range, the footer reads "Approve with 1 note"
   and "Request changes · 1 note", and no "Sent:" line appeared (Enter in the field did not approve). Then
   select "A long passage is cut to its first and last lines." and type a draft without Enter. Shot
   `doc-review-notes-main.png`: the Main board (one kept note, the field open under the tinted passage).
4. Escape in the field drops it: no field, still one note, `doc-review-pending` empty, and the dialog is
   still open.
5. A selection that ends outside the document: a `Range` from a text node under `[data-doc-review-doc]` to
   a text node in the rail's decisions, then `mouseup` on the document container. Assert no
   `[data-doc-note-field]` and an empty `doc-review-pending`. Clear the selection.
6. The field flips: the fixture spec ends with enough extra paragraphs that the document pane scrolls.
   Scroll the pane so a passage in the last paragraph sits at the pane's bottom edge, select it, and assert
   the field's bottom is at or above the selection's top and the field's rect is inside the dialog panel.
   Shot `doc-review-notes-flip.png`. Escape drops it; scroll the pane back to the top.
7. Escape hides the dialog; reopening it through the lead's tag shows the note still listed and
   `doc-review-quoted` holding one range again.
8. Rewrite the roster with the mockup's 9 decisions and a new `askId`, reload and reopen (the reload also
   empties the notes, so this step claims nothing about pruning). Add the Crowded board's six notes, written
   out of document order, one of them with no text, then click one row that has a note. Assert the rows are
   in document order, the empty note's row reads "No note yet", exactly one row has `data-open="true"` and
   shows an input, the notes list's client height is at most 300, the decisions list scrolls on its own, and
   the footer reads "Approve with 6 notes" and "Request changes · 6 notes". Shot
   `doc-review-notes-crowded.png`: the Crowded board.
9. Editing in the open row: type a new note into its input and press Enter. Assert no row is open, that
   row's compact line shows the new note, the dialog is still open and no "Sent:" line appeared. Click the
   row again, press Escape in its input: no row is open and the dialog is still open.
10. The header toggle collapses the list (`aria-expanded="false"`, no rows shown) and expands it again;
    removing one note leaves five rows, five quoted ranges and "Approve with 5 notes". Removing all leaves
    no `[data-doc-notes]` and the footer back to "Approve". Add two notes back for the next steps.
11. Request changes opens the textarea labelled "Anything beyond your 2 notes?" with the placeholder
    "Optional", and "Send 2 notes to the lead" is enabled with the textarea empty. Shot
    `doc-review-notes-request.png`. Cancel returns to the two buttons.
12. Approve by a Ctrl+Enter `keydown` dispatched where focus is (not a click): the footer shows
    "Sent: Approve, with 2 notes", the notes stay listed, and a new selection opens no note field. Shot
    `doc-review-notes-sent.png`. (The fixture ask has no live block, so nothing is delivered; the cockpit's
    own sent lock is what this shows.)

Teardown as `doc-review`, and restore the viewport override.

Acceptance: `node --check scripts/cdp/scenarios.mjs` passes; the scenario is in the export list so
`node scripts/cdp/final-verify.mjs doc-review doc-review-notes` runs it; every step above exists with the
shot names given. Never run prettier on `scripts/*.mjs`.
