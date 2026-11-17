# Brainstorm and canvas inline in the Rendered transcript

**Verify:** `node scripts/verify.mjs ./pkg/brainstormcheck`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs rendered-bs-host rendered-bs-question rendered-bs-boards rendered-bs-mockup rendered-bs-rows rendered-bs-composer rendered-bs-design rendered-bs-check rendered-bs-review rendered-bs-run agent-rendered transcript-arc brainstorm-mode brainstorm-run-landed canvas-mark canvas-tabs`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\rendered-panes\project

**Goal:** a brainstorm runs end to end from the Agent surface's Rendered transcript (question cards with their
boards, the judge, the design to confirm, the builder check and its review, the run) while the header's
Rendered | Brainstorm (and Canvas) switch and both panes stay as they are.

The canvas is the spec: 16 boards, each a state the built UI reaches, named by its `canvas.json` title. A board's
small mono left-margin labels ("building", "unreadable", ...) name the state and are not UI.
`[REASON FROM THE JUDGE RECORD]` is `judgeWork(q)`'s failure reason. Copy the pane already has is kept as the pane
words it; every other string is the board's.

## Settled while designing (the boards alone do not show these)

- The header switch and both panes stay. Open brainstorm / Open canvas / Edit / Mark open the pane at the matching
  place (the part, the board). Drawing marks, the Decided rail and editing a part's text stay pane-only.
- One live brainstorm card at a time, at the end of the transcript, drawn from the brainstorm file through the
  pane's own derived views (`mainView`, `checkMain`, `reviewHead`, `checkReview`, `handoffView`, `judgeWork`,
  `checkClock`, `runStepView`, `paneView`, ...). Its actions send exactly what the pane sends (`BrainstormAction`
  through `brainstormsend`). Answered questions fold to one row: "picked here" or "picked in the brainstorm pane".
- Boards drawn for a question live inside that question's card: tabs for the boards its options name, the live
  board, Mark and Open canvas; an option's board chip switches the board shown. A canvas revealed with no question
  gets the standalone Mockup card. Only the latest reveal draws a live board; older reveals stay "Opened in Arc"
  rows, and the `wsh ui reveal` step folds into Worked like any other step.
- The box: while a talk or builder question is open it answers it ("Answers question N"); with none open, a line
  goes to the agent as pushback or a question back. While the agent works there is no brainstorm card: the turn's
  own steps and working line show it, the box is the normal steer box, and buttons on earlier cards are disabled
  with the pane's working tooltip (`WORKING_TITLE`).
- The review of what the builder check changed (Keep the change / Put mine back / Keep all / Send choices) is in
  the transcript too.
- The compact (narrow) Rendered view: the same cards, stacked, at the compact sizes the timeline already uses.

## Decisions beyond the design, and why

1. **Where the live card sits.** After the timeline inside the transcript column, where `AskCard` sits today
   (`renderedview.tsx`), so it is always the transcript's last item and scrolls with it. The standalone Mockup card
   takes the same place when the agent has a canvas but no brainstorm. Why: "one live card at the end of the
   transcript", and that slot already sticks to the bottom.
2. **Which card draws** is one pure function over the brainstorm state and its builder-check view
   (`renderedCard`, Task 1), so every slice agrees on it:
   - no state, or no file read yet → none; `removed` → gone (removed); unreadable with no last good file → gone
     (unreadable); `f.run` → run.
   - a builder check pending or failed (`builderCheckView`) with no talk question open → check.
   - check phase (`f.check`): `checkMain(f, false, linePending)`: working → none; judging / question →
     question; builder → check; review → **review** while `checkReview(f)` has a changed decision waiting on
     Keep the change / Put mine back, else **design** while a guess waits to be confirmed (the KeepTalking board),
     else **check** (the settled approve bar).
   - talk phase: `mainView(f, false, linePending)`: working → none; judging / question → question; design →
     design.
   Why: these are exactly the pane's main views with the pane-only "design opened over the question" removed, so
   the card and the pane can never disagree on what is asked. "Working" is the pane's working view, not the agent's
   process state: the Judging board keeps its card while the judge runs.
3. **"Picked here" vs "picked in the brainstorm pane"** cannot come from the line, which must read the same from
   either place. `sendBrainstorm` takes an `origin` (default `"pane"`) and records each sent answer (line, question
   number or builder question, answer text, origin) in an in-memory atom keyed by the brainstorm file's path, beside
   `brainstormSeenAtom`. A transcript prompt matching a record draws the folded row with its origin. A prompt that
   matches an answered question in the file's history but no record (Arc restarted, or typed in the terminal)
   draws the centered "You answered question N: <answer>" row the Main board shows for question 3. Why: no
   persistence and no wire change for a label; the fallback never claims a place it cannot know.
4. **A folded answer row expands read-only** to the question, its why and its options with the pick marked (from
   the history entry). Why: the design shows `aria-expanded` but no opened state; answering again is the pane's.
5. **"Started a brainstorm <topic> · N decisions to talk through · Open brainstorm"** (FirstQuestion) is drawn by the
   question card above question 1 while the file's history is empty. Why: in Claude Code a hook reveals the
   brainstorm, so the transcript has no entry to hang it on.
6. **Pane-action rows read "You <phrase>"** wherever the transcript draws them (Rendered, ended transcripts,
   Sessions): "You asked for the builder check", "You skipped the questions", "You chose to keep talking", "You
   approved the design", "Started run <short id> from the spec". The keep-talking line also draws the folded check
   row before it ("A builder read the design · N questions settled · Spec", KeepTalking). Why: the action may now
   come from either place, so "In the brainstorm pane, you" would be wrong half the time.
7. **The box's words.** Talk question open: placeholder "Answer question N in your own words, or push back"; once
   filled, an "Answers question N" label beside the model chip. Builder question open: "Answer the builder's
   question in your own words, or push back" / "Answers the builder's question". No question open and the pane's
   `lineBox` is open with no guess waiting to confirm: the normal placeholder plus the hint "No question open · your
   line reaches the brainstorm as pushback or a question back" (KeepTalking); with a guess waiting the design card's
   own status line says what is waited on (DesignReady shows no hint). Every routed line goes through
   `sendBrainstorm` with origin `"transcript"`, so waiting picks ride along, a running judge stops and the pane
   shows the agent writing, exactly as from the pane. Working, the box is the normal steer box. Why: the boards draw
   these two states; the builder wording mirrors the talk one, since no board draws the box over an open builder
   question alone.
8. **Compact.** The host measures the transcript column; under `COMPACT_CARD_PX` (600) cards take the timeline's
   compact sizes (its `compact` text sizes) and rows that sit side by side (option label and chip, the action
   buttons, Keep the change / Put mine back) stack. Why: the Rendered timeline never runs compact today, so the
   card needs its own trigger; 600 is where the option rows' chips start to squeeze the label in the boards.
9. **Per-board change times.** The canvas poller already HEADs every board; it keeps each board's last-modified
   time, and when each was last on screen, so a tab can carry "updated since you last looked" and "updated 40s ago"
   is the shown board's. The inline board counts as on screen for the poller, so it reloads when its file changes
   (CanvasUpdated). Why: the canvas-wide stamp cannot say which tab changed.
10. **Mark from the transcript returns to it.** Mark opens the pane's board with marking on; once the mark sends,
    the surface goes back to the Rendered view it came from. A mark started in the pane keeps today's behaviour.
    Why: the user marked from the conversation and reads the reply there (CanvasUpdated's bubble).
11. **Gone.** A removed brainstorm keeps its state so the transcript's gone card can draw; the header drops the
    Brainstorm segment for a removed brainstorm while Rendered shows. The pane's Removed view and its Back to
    terminal are unchanged. Closing the brainstorm from either place records the close (topic, canvas) in memory;
    a removed brainstorm with that record draws "You closed the brainstorm · its file and the <canvas> canvas were
    deleted" instead of the gone card. Why: the Gone board says the switch "goes with it"; deleting the file is
    otherwise indistinguishable from a worktree removal.
12. **Open at a place.** One store function opens the pane at a part (design opened, the part's row opened and
    scrolled to; in the check phase the review cursor set), at a board (the brainstorm's board view, marking on for
    Mark), or plain (Open brainstorm). Why: the pane's own `goTo` is component state the transcript cannot reach.
13. **Ownership.** New pure helpers go in each slice's own model file; `brainstormmodel.ts` is not edited by this
    plan, so the slices never collide on it. The close record (decision 11) is an atom and helper in
    `renderedbsrunmodel.ts`, written inside `closeBrainstorm` (`brainstormrun.tsx`), so the card and the pane both
    record it.
14. **Guess for me on question 1.** The card follows the FirstQuestion board and offers Guess for me on question 1;
    the pane keeps hiding it there. Why: the board is the spec for the card, and the guess line means the same to
    the agent on any question.
15. **Motion.** Each view maps its state changes onto `docs/reference/motion-system.md`'s moments, using the
    primitives the panes already use: a card trading what it shows fades through `ViewSwap` (keyed on the card
    kind and question number; the card it mounts with does not fade); disclosures (a folded row's expansion, a
    review row's was/now) open with `PaneReveal` (6b); counts roll with `TickNumber` (12); a refused send's error
    line nudges (13); the run's merge draws its check with `DrawCheck` (16); a board switch inside a card fades
    through `ViewSwap`; a new dot or label fades in with `microFade`. No new tokens. Each task names its changes and
    the scenario step that performs one.
16. **Compact is checked per card.** Every card scenario has a narrow-column step (the column under 600px) seeing the
    card's side-by-side rows stacked, so decision 8 is verified for each card, not only the question.

## Tasks

### Task 1: Rendered brainstorm host, card dispatch, answer origin and open-at-place
**Depends on:** none
**Files:** `frontend/app/view/agents/renderedbrainstormmodel.ts`, `frontend/app/view/agents/renderedbrainstormmodel.test.ts`, `frontend/app/view/agents/renderedbrainstorm.tsx`, `frontend/app/view/agents/renderedbsquestion.tsx`, `frontend/app/view/agents/renderedbsboards.tsx`, `frontend/app/view/agents/renderedbsrows.tsx`, `frontend/app/view/agents/renderedbsdesign.tsx`, `frontend/app/view/agents/renderedbscheck.tsx`, `frontend/app/view/agents/renderedbsreview.tsx`, `frontend/app/view/agents/renderedbsrun.tsx`, `frontend/app/view/agents/renderedview.tsx`, `frontend/app/view/agents/narrationtimeline.tsx`, `frontend/app/view/agents/brainstormsend.ts`, `frontend/app/view/agents/brainstormsend.test.ts`, `frontend/app/view/agents/brainstormstore.ts`, `frontend/app/view/agents/brainstormstore.test.ts`, `frontend/app/view/agents/brainstormpane.tsx`, `frontend/app/view/agents/brainstormcheck.tsx`, `scripts/cdp/scenarios-rendered-brainstorm.mjs`, `scripts/cdp/scenarios-rendered-bs-question.mjs`, `scripts/cdp/scenarios-rendered-bs-boards.mjs`, `scripts/cdp/scenarios-rendered-bs-mockup.mjs`, `scripts/cdp/scenarios-rendered-bs-rows.mjs`, `scripts/cdp/scenarios-rendered-bs-composer.mjs`, `scripts/cdp/scenarios-rendered-bs-design.mjs`, `scripts/cdp/scenarios-rendered-bs-check.mjs`, `scripts/cdp/scenarios-rendered-bs-review.mjs`, `scripts/cdp/scenarios-rendered-bs-run.mjs`, `scripts/cdp/scenarios.mjs`

**What to build:** the seam every slice plugs into, with each slice's component stubbed so the slices run side by
side.
- `renderedCard` (decision 2) and `cardStatus` (the head's right-hand words: "Talking it through · 3 of 5 yours",
  "Checking with a builder", from `progressView`/`brainstormPhase`) in the pure model, tested against a fixture per
  board state.
- `RenderedBrainstorm` mounted in `renderedview.tsx` after the timeline (decision 1): it reads the agent's
  brainstorm state and builder-check view, measures the column for `compact` (decision 8), renders the card
  `renderedCard` picks, or `MockupCard` when the agent has no brainstorm. `CardFrame` draws the shell every card
  uses: the "Needs your input" pill when the card asks, the bordered card, the head row ("Brainstorm · N → <part
  link>", status, "Open brainstorm ↗"), with the boards' data attributes on the wrapper.
- The answer-origin record (decision 3) in `brainstormstore.ts` and the `origin` parameter on `sendBrainstorm`.
- `openBrainstormAt` (decision 12) in `brainstormstore.ts`; the pane's `Design` (`brainstormpane.tsx`) and `Check`
  (`brainstormcheck.tsx`) consume the part target once (open the row or set the review cursor, scroll to it, then
  clear it).
- A row seam on `NarrationTimeline`: an `entryRow` prop consulted for user and Arc items; non-null replaces the row
  it would draw. `renderedview.tsx` passes the one `useRenderedEntryRow` returns (stubbed to return null).
- Stubs: each slice file below exports its interface returning null (or `{ block: null, chip: () => null }`).
- The scenario kit in `scenarios-rendered-brainstorm.mjs`: arrange a claude agent with a transcript fixture and a
  brainstorm file (and optionally a canvas project with boards) shown in Rendered mode, rewrite the file mid-
  scenario, narrow the column under 600px and restore it, read a card's flat text, record the lines sent
  (`agentprompt`), tear down. It aggregates the nine `scenarios-rendered-bs-*.mjs` modules (each a stub
  `export default (kit) => []` here), is registered in `scenarios.mjs`, and holds this task's own scenario,
  `rendered-bs-host`.

**State changes and motion:** the live card trading kinds (question → design → check ...) or questions fades the new
card in through `ViewSwap` keyed on kind and question number, never on mount; the card leaving while the agent
works exits with the same fade.

**Interfaces:**
```ts
// renderedbrainstormmodel.ts
export const COMPACT_CARD_PX = 600;
export type RenderedCard =
    | { kind: "none" }
    | { kind: "question"; judging: boolean }
    | { kind: "design" }
    | { kind: "check" }
    | { kind: "review" }
    | { kind: "run" }
    | { kind: "gone"; why: "unreadable" | "removed" };
export function renderedCard(s: BrainstormState | null, check: BuilderCheckView): RenderedCard;
export function cardStatus(f: BrainstormFile): string;
export type CardProps = { model: AgentsViewModel; agent: AgentVM; s: BrainstormState; f: BrainstormFile; compact: boolean };

// renderedbrainstorm.tsx
export function CardFrame(p: { agent: AgentVM; s: BrainstormState; f: BrainstormFile | null; asking: boolean;
    head: ReactNode; status?: string; compact: boolean; attr: string; children: ReactNode }): JSX.Element;

// brainstormstore.ts
export type AnswerOrigin = "transcript" | "pane";
export type AnswerRecord = { line: string; question: number | null; builder: string | null; answer: string;
    origin: AnswerOrigin; at: number };
export const brainstormAnswersAtom: PrimitiveAtom<Record<string, AnswerRecord[]>>; // keyed by brainstorm path
export function openBrainstormAt(agentId: string, at: { part?: string; board?: string; mark?: boolean }): void;

// brainstormsend.ts (existing callers keep the default)
export function sendBrainstorm(agent: AgentVM, action: BrainstormAction, io?: PromptIO, now?: number,
    origin?: AnswerOrigin): Promise<void>;

// stubs the slices implement
// renderedbsquestion.tsx  export function QuestionCard(p: CardProps & { judging: boolean }): JSX.Element | null
//                         export function OptionRows(p: { options: AnswerOption[]; onPick: (label: string) => void;
//                             locked: string | null; badge?: (i: number) => string | null;
//                             chip?: (i: number) => ReactNode | null; compact: boolean }): JSX.Element | null
// renderedbsboards.tsx    export function useQuestionBoards(agent: AgentVM, s: BrainstormState, f: BrainstormFile,
//                             judging: boolean, compact: boolean): { block: ReactNode | null; chip: (i: number) => ReactNode | null }
//                         export function MockupCard(p: { model: AgentsViewModel; agent: AgentVM; compact: boolean }): JSX.Element | null
// renderedbsrows.tsx      export function useRenderedEntryRow(model: AgentsViewModel, agent: AgentVM):
//                             (entry: AgentEntry, index: number) => ReactNode | null
// renderedbsdesign.tsx    export function DesignCard(p: CardProps): JSX.Element | null
// renderedbscheck.tsx     export function CheckCard(p: CardProps): JSX.Element | null
// renderedbsreview.tsx    export function ReviewCard(p: CardProps): JSX.Element | null
// renderedbsrun.tsx       export function RunCard(p: CardProps): JSX.Element | null
//                         export function GoneCard(p: { agent: AgentVM; s: BrainstormState; why: "unreadable" | "removed"; compact: boolean }): JSX.Element | null
```
`BrainstormState` gains only an optional field (the part target), so its existing literals stay valid.

**Acceptance:**
- `renderedCard` returns, for a file in each board's state: FirstQuestion/Main/Answered/JudgePick/JudgeFailed →
  question (judging false); Judging → question (judging true); Working → none; DesignReady and KeepTalking →
  design; BuilderCheck's reading and questions-back states and CheckStates → check; CheckReview → review; RunStep
  → run; Gone → gone with its why.
- An answer sent from the pane sends the same line as before and records origin `"pane"`; one sent with origin
  `"transcript"` records that origin, the open question's number (or the open builder question's text) and the
  exact line sent, carried picks included; a refused or failed send records nothing.
- `openBrainstormAt` with a part switches the agent to the Brainstorm pane with that part's row open (in the check
  phase, the review cursor on it); with a board, to the pane's board view on that board (marking on with `mark`);
  with neither, to the pane as it was.
- Scenario `rendered-bs-host`: the kit arranges a brainstorm agent in Rendered with its transcript drawn and the
  host present under the timeline; rewriting the file from a working state to a question makes the host's card
  slot swap (stub content is enough: the slot's kind attribute changes); `openBrainstormAt` with a part shows the
  pane with that part's row open and in view. Existing `brainstorm-mode` and `agent-rendered` still pass.

### Task 2: The question card (talk question, judge states, answering)
**Depends on:** Task 1
**Files:** `frontend/app/view/agents/renderedbsquestion.tsx`, `frontend/app/view/agents/renderedbsquestionmodel.ts`, `frontend/app/view/agents/renderedbsquestionmodel.test.ts`, `scripts/cdp/scenarios-rendered-bs-question.mjs`

**What to build:** `QuestionCard` and `OptionRows` per the FirstQuestion, Main (without its boards block),
Judging, JudgePick, JudgeFailed and Answered boards: question head and why, numbered option rows (label, detail, the
Judge's / Agent's pick badge from `judgeWork`, the judge's kept-option ranking and its dropped approaches struck
with their reasons and the "Judge's work: ..." line), Guess for me (question 1 included, decision 14; never while
judging), Skip the questions, and the picks hint ("1–3 picks · or type your own answer below"; "answer in the box
below" for a question with no options). While judging: the approaches as answerable rows, "The judge is weighing N
approaches <clock> · its pick shows here; you can pick first", and the "Waiting for the judge <clock>" line under
the card. The "Started a brainstorm ..." row above question 1 while history is empty (decision 5). The boards block
and option chips come from `useQuestionBoards` (Task 10), placed where Main draws them. Picking sends
`{ kind: "answer", text }` through `sendBrainstorm` with origin `"transcript"`; Guess and Skip send theirs; a
refusal shows in the card's error line. Compact per decision 8.

**State changes and motion:** the judge's result landing (judging → judged or failed) swaps the option list through
`ViewSwap`; a refused send's error line nudges (moment 13).

**Interfaces:** `OptionRows` as declared in Task 1; Task 7 renders the builder's question with it.

**Acceptance:**
- Clicking option 2 sends exactly the line the pane sends for option 2 (the `agentprompt` text recorded), with the
  record's origin `"transcript"`.
- Scenario `rendered-bs-question` steps: FirstQuestion (Started a brainstorm row, Q1 card with Guess for me and Skip
  the questions, "0 of 5 yours"); Judging (5 approaches answerable, no Guess for me, judge clock and waiting line);
  the file rewritten to JudgePick swaps the list (Judge's pick on option 1, 3 kept, the 2 dropped struck with
  reasons); JudgeFailed ("Agent's pick" and "the judge failed, so the read and pick are the agent's: <reason>");
  Answered's question 5 (no options, "answer in the box below"); a pick sends its line; the narrow column renders
  the card compact with the option rows stacked.

### Task 3: Per-board canvas times and the standalone Mockup card
**Depends on:** Task 1
**Files:** `frontend/app/view/agents/renderedbsboards.tsx`, `frontend/app/view/agents/renderedbsboardsmodel.ts`, `frontend/app/view/agents/renderedbsboardsmodel.test.ts`, `frontend/app/view/agents/canvasstore.ts`, `frontend/app/view/agents/canvasstore.test.ts`, `frontend/app/view/agents/canvaspoller.ts`, `frontend/app/view/agents/canvaspoller.test.ts`, `frontend/app/view/agents/canvasmodel.ts`, `frontend/app/view/agents/canvasmodel.test.ts`, `frontend/app/view/agents/canvassend.ts`, `frontend/app/view/agents/canvassend.test.ts`, `frontend/app/view/agents/transcriptlayout.ts`, `frontend/app/view/agents/transcriptlayout.test.ts`, `scripts/cdp/scenarios-rendered-bs-mockup.mjs`

**What to build:** the live-board block both card kinds share, in `renderedbsboards.tsx`: tabs for the given boards,
the live board scaled to the card's width (canvas.json size, the board's title and the scale under it), "<what> ·
<canvas> · updated <ago>", Mark and Open canvas, a click on the board opening it in the pane ("Open <board> in the
canvas"). Per-board change times, the unseen tab dot, and the inline board counting as on screen (decision 9).
Mark and the return to Rendered after send (decision 10). `MockupCard` per CanvasEdge for an agent with a canvas and
no brainstorm: "Mockup <topic> · N boards · Open canvas" over the block; "No boards yet. They show here as the agent
writes them." before any board file exists; "Arc could not serve this canvas" with the pane's explanation while
the server is down; once removed, an "Opened in Arc canvas:<topic>" row with "removed, usually because the feature
shipped". A finished turn's fold phrase names a canvas reveal "revealed a canvas". Open and Mark disabled with
`WORKING_TITLE` while the brainstorm's pane view is working.

**State changes and motion:** a tab switch fades the board in through `ViewSwap`; an unseen dot fades in with
`microFade`; the card trading states (no boards → boards, served → not served → removed row) fades through
`ViewSwap`.

**Interfaces:** `MockupCard` as declared in Task 1. The block, exported for Task 10:
`LiveBoards(p: { agent: AgentVM; canvas: string; cwd: string; boards: string[]; shown: string;
onShow: (board: string) => void; what: string; disabled: string | null; compact: boolean }): JSX.Element`.
New `CanvasState` fields are optional, so existing literals stay valid.

**Acceptance:**
- The poller's patch carries each served board's last-modified time; a tab whose board changed after it was last
  on screen reads unseen, and showing it clears that.
- A mark started from the transcript ends, after a successful send, with the agent back in Rendered; one started in
  the pane ends where it does today.
- A finished turn holding `wsh ui reveal canvas:x` folds with "revealed a canvas" in its phrase.
- Scenario `rendered-bs-mockup` steps: CanvasEdge's no-boards card, then a board file written swaps it to the live
  board; the not-served card; the removed row; a board file rewritten reloads the shown board and puts the unseen
  dot on the other tab; Mark opens the canvas pane with marking on; the narrow column stacks the card's head and
  actions.

### Task 4: Transcript rows: folded answers, "You ..." rows and the mark bubble
**Depends on:** Task 1
**Files:** `frontend/app/view/agents/renderedbsrows.tsx`, `frontend/app/view/agents/renderedbsrowsmodel.ts`, `frontend/app/view/agents/renderedbsrowsmodel.test.ts`, `frontend/app/view/agents/arcmessagerow.tsx`, `frontend/app/view/agents/arcmessagemodel.ts`, `frontend/app/view/agents/arcmessagemodel.test.ts`, `scripts/cdp/scenarios-transcript-arc.mjs`, `scripts/cdp/scenarios-rendered-bs-rows.mjs`

**What to build:** `useRenderedEntryRow` per Main, Working, Answered, CheckReview and CanvasUpdated: an answer
prompt matching an answer record draws the folded row ("Q4 <question> ✓ <answer> picked here" or "picked in the
brainstorm pane"; "Builder <question> ✓ <answer>" for a builder answer), expanding read-only (decision 4); an answer
the file's history knows but no record does draws "You answered question N: <answer>" (decision 3); a canvas mark
line (`canvasHandoffLine`'s shape) draws as a user bubble with the marked crop (served from the canvas folder),
the note, and "marked on <board> · <canvas>", the crop opening that board in the pane. Pane-action rows reworded
per decision 6, including the keep-talking line's folded check row and "Started run <short id> from the spec".

**State changes and motion:** a folded row's expansion opens with `PaneReveal` (6b) and its chevron turns with
`turnTransition`.

**Acceptance:**
- The row model classifies, from an entry, the records and the file: an answer with a record (origin kept), an
  answer known only to history, a mark line (board, note, crop path), and anything else as no row.
- `transcript-arc` asserts the new "You ..." wording where it asserted "In the brainstorm pane, you".
- Scenario `rendered-bs-rows` steps: Main's Q1 and Q2 rows ("picked here") and the Q3 fallback row; Answered's Q4 row
  with one answered from the pane reading "picked in the brainstorm pane"; a row expands to its options with the
  pick marked; CheckReview's "Builder ... Yes picked here"; CanvasUpdated's mark bubble; KeepTalking's folded check
  row ("A builder read the design · 3 questions settled · Spec") and "You chose to keep talking"; "You skipped the
  questions", "You asked for the builder check", "You approved the design" and "Started run <id> from the spec"
  rows; the narrow column draws the rows at the compact sizes.

### Task 5: The box answers the brainstorm, and the working state
**Depends on:** Task 1
**Files:** `frontend/app/view/agents/renderedcomposer.tsx`, `frontend/app/view/agents/renderedmode.ts`, `frontend/app/view/agents/renderedmode.test.ts`, `scripts/cdp/scenarios-rendered-bs-composer.mjs`

**What to build:** the Rendered box per decision 7, from the agent's brainstorm state: the route (talk question N,
builder question, a pushback line, or none), its placeholder, its filled label and hint, and the send through
`sendBrainstorm` with origin `"transcript"` for a routed line (attachments and `!` bash mode behave as today; a
routed line with attachments appends their paths as a normal prompt does). With the brainstorm working, or no
brainstorm, the box is unchanged.

**State changes and motion:** the "Answers question N" label fades in with `microFade` as the box fills; the hint
line reveals with `composerReveal` (moment 6).

**Interfaces:** `composerBox` gains an optional brainstorm route argument; its other callers are its test only.

**Acceptance:**
- The route and words follow decision 7 for: talk question open (empty and filled), builder question open, no
  question with the line box open and no guess waiting (hint), with a guess waiting (no hint), the pane working
  (steer), a run started (normal).
- A typed answer to question 5 sends the pane's answer line for that text and records origin `"transcript"`.
- Scenario `rendered-bs-composer` steps: Main's box placeholder; Answered (typing shows "Answers question 5", Send
  sends the line); KeepTalking's hint; Working (no brainstorm card under the timeline, "Steer the agent; it reads
  this before its next step", Stop shown, the turn's steps and working line drawn).

### Task 6: The design card (confirm guesses, keep talking, Check with a builder)
**Depends on:** Task 1
**Files:** `frontend/app/view/agents/renderedbsdesign.tsx`, `frontend/app/view/agents/renderedbsdesignmodel.ts`, `frontend/app/view/agents/renderedbsdesignmodel.test.ts`, `scripts/cdp/scenarios-rendered-bs-design.mjs`

**What to build:** `DesignCard` per DesignReady, KeepTalking and BuilderCheck's first line: "Confirm the design",
`reviewHead`'s line, "Confirm all N guesses" (`confirm-all`), each decision in one line with its part link and gist,
a board link where it has one, "That's right" (`pickPart` confirm, the pane's pick behaviour) and Edit (opens the
part in the pane, `openBrainstormAt`) on guesses and changed ones (with the "changed" mark), "What the agent found
· N" with "Read in the brainstorm", and "Waiting for you: confirm the design, then Check with a builder". With every
decision yours: "The design · N of N yours · you confirmed M guesses", Open brainstorm and "Check with a builder"
(`check`). Disabled with `WORKING_TITLE` while the pane's view is working.

**State changes and motion:** That's right pressed shows the pane's pressed pick; the guess count in "Confirm all N
guesses" rolls with `TickNumber`; a refused send's error line nudges.

**Acceptance:**
- That's right on the last waiting guess sends the pane's settle line; Confirm all sends `brainstorm: confirm every
  guess`; Check with a builder sends `brainstorm: check`; Edit opens the pane at that part.
- Scenario `rendered-bs-design` steps: DesignReady (2 guesses, Confirm all 2 guesses, each row's buttons, the
  waiting line); That's right on one guess presses it; KeepTalking (the reopened Banner line marked changed with
  That's right and Edit); the all-yours head with Check with a builder; the narrow column stacks each row's
  buttons under its line.

### Task 7: The builder check card (reading, its questions, the approve bar)
**Depends on:** Task 2 (its builder-question step needs `OptionRows` drawn, which is a null stub until Task 2 lands)
**Files:** `frontend/app/view/agents/renderedbscheck.tsx`, `frontend/app/view/agents/renderedbscheckmodel.ts`, `frontend/app/view/agents/renderedbscheckmodel.test.ts`, `scripts/cdp/scenarios-rendered-bs-check.mjs`

**What to build:** `CheckCard` per BuilderCheck and CheckStates: "Builder check · A builder is reading the design"
with `checkClock`'s usual/longest times, elapsed and note (past the usual time: "Taking longer than usual ..."),
"Taking in the builder's questions" with its note, the failed card "The builder check did not finish" with the
reason and Try again (`check`); "Builder check · N questions back · Spec" with the spec path and the three counts
(`handoffView`); the builder's open question ("Builder question · i of n → <part>", its options, "Let the agent
decide", picks hint) answered with `builder-answer` / `builder-decide` through `sendBrainstorm` origin
`"transcript"`; once settled, "A builder read the design · Its N questions are settled. Approving starts an
orchestrator run from the spec." with Keep talking and Approve and start run (`approveAndOpenRun`, gated by
`approveBlocker`).

**State changes and motion:** the clock's bar fills with `barFillClass` (11); reading → taking in → questions back
→ settled swap through `ViewSwap`; the counts roll with `TickNumber`.

**Acceptance:**
- The card's state follows `builderCheckView` and `checkMain` for reading, past usual, taking in, failed, a builder
  question open, and settled.
- Scenario `rendered-bs-check` steps: BuilderCheck (reading with clock; the file rewritten to questions back swaps
  the card, with the 1/1/1 counts; the builder question answered by an option sends the pane's builder-answer line;
  the approve bar's two buttons); CheckStates (past usual, taking in, failed with Try again sending
  `brainstorm: check`); the narrow column stacks the approve bar's buttons.

### Task 8: The check review card
**Depends on:** Task 1
**Files:** `frontend/app/view/agents/renderedbsreview.tsx`, `frontend/app/view/agents/renderedbsreviewmodel.ts`, `frontend/app/view/agents/renderedbsreviewmodel.test.ts`, `scripts/cdp/scenarios-rendered-bs-review.mjs`

**What to build:** `ReviewCard` per CheckReview from `checkReview(f)`: "Review what the check changed" and its
summary; "Changed since you confirmed · N · open one to see what it was" with Keep all N changes; each changed
decision with Keep the change / Put mine back (`pickPart` keep / restore, the pane's picks), what changed it, its
was/now sentence diff when opened, and the agent's call under it; "New since the check · N" with That's right and
Edit; "Yours, unchanged" and "What the agent found" links opening the pane at the part; the picks line ("1 choice
made, 2 still open ...") and Send N choices (`settle`). Picks persist in the brainstorm state as in the pane.

**State changes and motion:** a row's was/now opens with `PaneReveal` (6b); the picks line's counts and Keep all's
count roll with `TickNumber`; a pressed pick shows the pane's pressed state.

**Acceptance:**
- A pick made here shows as picked in the pane and the reverse; the last pick sends the settle line; Keep all sends
  `brainstorm: keep every change`.
- Scenario `rendered-bs-review` steps: CheckReview's sections and counts; Keep the change on Final queue updates the
  picks line to "1 choice made, 2 still open"; a changed row opens to its was/now; Send 1 choice sends the pane's
  settle line; the narrow column stacks Keep the change / Put mine back under the row.

### Task 9: The run card, the gone card and the closed row
**Depends on:** Task 1
**Files:** `frontend/app/view/agents/renderedbsrun.tsx`, `frontend/app/view/agents/renderedbsrunmodel.ts`, `frontend/app/view/agents/renderedbsrunmodel.test.ts`, `frontend/app/view/agents/brainstormrun.tsx`, `frontend/app/view/agents/agentheader.tsx`, `scripts/cdp/scenarios-rendered-bs-run.mjs`

**What to build:** `RunCard` per RunStep from `runStepView`: "Brainstorm · <topic> · Run <short id> · Open run",
the headline and detail for building, merged with the final check passed (the pane's close detail and Close the
brainstorm, the same `closeBrainstorm`, exported from `brainstormrun.tsx`), merged with a failed final check ("The
final check did not pass, so the brainstorm stays."). The close record (an atom and helper in
`renderedbsrunmodel.ts`, written inside `closeBrainstorm`, decision 13) and the "You closed the brainstorm · its file
and the <canvas> canvas were deleted" row (decision 11). `GoneCard` per Gone: "Arc could not read this brainstorm"
with the parse error and the path; "<topic>'s brainstorm file is gone" with `brainstormGoneText` and "The Brainstorm
switch in the header goes with it; the answers above stay in the transcript." The header hides the Brainstorm
segment for a removed brainstorm (decision 11).

**State changes and motion:** the run merging draws its check with `DrawCheck` (16); building → merged swaps through
`ViewSwap`; the closed row replacing the run card fades through `ViewSwap`.

**Acceptance:**
- Closing from either the card or the pane records the close; a removed brainstorm with a close record draws the
  closed row, one without draws the gone card.
- Scenario `rendered-bs-run` steps: RunStep's building, then the run merged with its final check passed draws the
  check; Close the brainstorm deletes and the closed row replaces the card; merged with a failed final check; Gone's
  unreadable card, and its removed card with the header's Brainstorm segment gone; the narrow column stacks the run
  card's Close button under its text. `brainstorm-run-landed` still passes.

### Task 10: Boards inside the question card
**Depends on:** Task 2 (draws in `QuestionCard`'s head and option rows), Task 3
**Files:** `frontend/app/view/agents/renderedbsboards.tsx`, `frontend/app/view/agents/renderedbsboardsmodel.ts`, `frontend/app/view/agents/renderedbsboardsmodel.test.ts`, `scripts/cdp/scenarios-rendered-bs-boards.mjs`

**What to build:** `useQuestionBoards` per Main and CanvasUpdated, on Task 3's `LiveBoards`: a tab per board the
question's options (and the question itself) name, from `questionBoardLayout`/`boardTabLabels`, labelled "the
agent's mockup"; each option's board chip (`aria-pressed`, "Show <board> above") switching the board shown; Mark
and Open canvas opening the brainstorm's board through `openBrainstormAt`. The canvas reveal for the question's
canvas draws no Mockup card (the question card holds it).

**State changes and motion:** a chip switching the board fades it through `LiveBoards`' `ViewSwap`; the pressed chip
moves with the selection.

**Acceptance:**
- The model gives, for a question, its tabs in order and each option's chip board, matching the pane's
  `questionBoardLayout`.
- Scenario `rendered-bs-boards` steps: Main (tabs Main | States, the live board, Mark, Open canvas, option 1's chip
  pressed; option 3's States chip switches the board and presses); CanvasUpdated (a board file rewritten: the States
  tab shows its unseen dot, "updated <n>s ago", the shown board reloads); Mark opens the brainstorm pane's board with
  marking on; the narrow column stacks each option's chip under its label.
