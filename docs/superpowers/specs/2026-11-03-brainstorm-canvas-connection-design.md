# Brainstorm pane: mockups inside their answers

Status: approved design, 2026-11-03. Mockups: `.superpowers/design/brainstorm-canvas-connection/project/` (gitignored scratch; `In-row.dc.html` is the prototype, `A-mismatch.dc.html` and `Open-full-answer.dc.html` the edge cases).

## Intent and why

When a brainstorm question chooses between layouts, its mockups and its answers are two separate lists. The asked part's boards sit in a column of their own beside the answer rows. They are lettered by their order in the part's `boards` list, and nothing ties a board to an answer, so the board marked "option A" can show answer B. To compare, the user's eye goes back and forth between the two lists. The goal is to make a mockup and the answer it shows read as one thing.

## Goals

- Each answer row on a question shows the mockup or mockups that answer names, inside the row.
- The full-size canvas says which answer each board belongs to.
- Questions whose boards no answer names still show those boards (this is the common case today: see Context).

## Non-goals

- The full-size canvas layout itself: it stays today's full-pane swap with the same bar, controls and Back.
- Pairing boards to answers by count, order or file name.
- The design list's part rows and the builder check's review: their boards show as they do today, with plain names.

## Anti-goals

- A board shown against the wrong answer. When in doubt, a board shows unlettered rather than paired.
- An empty slot in an answer row that has no mockup.

## Context (what is there today)

- `questionBoards` (`frontend/app/view/agents/brainstormmodel.ts`) returns the asked part's boards; `QuestionMain` (`brainstormui.tsx`, `data-brainstorm-question-boards`) renders them in a column next to the `Options` rows, through `Thumbnails` in its compact (220px) mode, lettered `option A of N` by list index.
- `AnswerOption` is `{ label, detail, pick?, pros?, cons? }`: it has no board. The judge's option struct in `pkg/brainstormcheck/judge.go` has the same fields, and the judge rewrites a question's options, so anything on an option that the judge does not carry is lost on an approach question.
- The `arc:brainstorm` skill (`skills/brainstorm/SKILL.md`) tells agents to list boards on the part only.
- Open full size calls `attachCanvas` and `openBrainstormBoard`, and the pane swaps to `CanvasPane` (`brainstormpane.tsx`, view `board`), whose bar has the back button, the topic, a `Segmented` tab row (All plus one tab per board, labeled by `boardLabel`), Mark and Open in browser.
- A scan of every `.superpowers/brainstorm/*/brainstorm.json` in this repo: 103 questions offered answers, and 29 of them were for a part with boards. On those 29, an answer's pros and cons together ran a median of 80 characters (90th percentile 524, longest 1,130). In 17 of the 29, one board served 2 to 4 answers. In 9, there was about one board per answer, and the rest had more boards than answers.

## The design

### 1. An answer names its mockups

- Every answer option in `brainstorm.json` gets an optional `boards` field. It is a list of board file names under the canvas's `project/` folder, the same names the part's `boards` holds.
- The part's `boards` stays the full set for that part. The design list and the builder check keep finding every board through it, unchanged.
- An approach the agent hands the judge can carry `boards` too. The judge never writes `boards` itself. Instead, each option it writes names the approaches it comes from, in a new `from` list of approach names, and code (`judgeFileBytes` in `judge.go`) sets the option's `boards` from those approaches. *Agent's call* (builder question 1): code, not the model, decides which board goes with which answer, so a board cannot land on the wrong option by a model slip, and the result can be tested.
  - An option built from several approaches gets the union of their `boards`, in the order the approaches are listed. *Agent's call* (builder question 1): every board it shows is one of its sources, so none is shown against the wrong answer.
  - An option with no `from`, or whose `from` names no listed approach (the judge added it), gets no `boards`. A `from` name that matches no approach is ignored, not an error, so the question still arrives.
  - This changes `JudgeOption` (adds `from`), `approachesText` (prints each approach's boards), `judge-prompt.md` (asks for `from` on every option), and `Approach` (adds `boards`). `from` stays on the option in the file; the pane ignores it.
- The `arc:brainstorm` skill tells agents to name an answer's boards on the answer, and to keep listing every board on the part as well. Add `boards` to the option shape, to the `approaches` shape, and to the example file. Edit `skills/brainstorm/SKILL.md`; `task sync:claudemod` copies it into the mod.
- A file written before this change has no `boards` on its options. Every board then shows as a shared board (section 3), which is today's content in the new layout.

### 2. Mockups inside their answer row (prototype: `In-row.dc.html`)

- On an open question, each answer row shows the boards it names on the right of the row. Each board is a live scaled thumbnail, as `Thumbnails` draws today, with **Open full size** under it.
- The separate board column beside the answers goes away.
- An answer row otherwise stays as today: the letter, label, detail, the pick tag, the pros and cons grid under it, letter-key focus and Enter to send.

### 3. When boards and answers don't match one to one (`A-mismatch.dc.html`)

- Nothing is paired by count or order: only an option's own `boards` puts a board in its row.
- **A board an answer names that is not on the asked part** still shows in that answer's row and is lettered on its tab, as long as it is a board of the canvas. *Agent's call* (builder question 2): the answer's naming is explicit, so it is trusted. The part is not a gate, and a slip in the part list does not hide a mockup the agent meant to show. The pure function therefore reads the part's boards, every option's boards and the canvas board list.
- **Shared boards.** Some boards on the asked part are named by no answer. They show once, above the answer rows, unlettered, labeled **For every answer**, each with Open full size.
- **Several boards on one answer** show side by side in its row, each with a short caption (its board label).
- **An answer with no board** is a plain row, with no empty slot.
- **A missing board.** A board an answer names but that is not on disk is left out of the row; the rest of the row draws as usual. Boards are known from the canvas state's board list.

### 4. Opening a board full size (`Open-full-answer.dc.html`, variant 2)

- Open full size keeps today's full-pane canvas: the bar, Back, Mark, Open in browser and the canvas all stay as they are.
- While a question is open, each board tab that an answer names starts with that answer's letter, for example `A · Left-rail`.
- A board on the asked part that no answer names reads `Every answer · <name>`.
- A board on the canvas that is not on the asked part keeps its plain name.
- If one board is named by more than one answer, its tab carries every letter, `A, C · <name>`. *Agent's call*, since the user picked lettered tabs without discussing this case.
- The letters hold under the All tab and while stepping with `[` and `]`.
- When no question is open (the builder check's review, or the design list once `done`), every tab keeps its plain name, as today. While a question is open, the tabs are lettered however the board was opened, from an answer row or from the design list opened over that question. *Agent's call* (builder question 3): the letters say what is true of the open question, and a single condition (a question is open) keeps the label map and the CDP scenario on one rule.

## Left to the builder

- **Where the pairing logic lives.** A pure function beside `questionBoards` in `brainstormmodel.ts` splits the asked part's boards into per-answer and shared, and gives each board its tab label. Cover it with vitest cases:
  - one board for three answers;
  - two boards on one answer;
  - an answer with none;
  - a named board that is missing on disk;
  - an old file with no `boards` on its options;
  - one board named by two answers;
  - a board an answer names that is not on the part.
- **Thumbnail size in a row.** `Thumbnails`' compact mode (220px) is the starting point. The row must still fit beside a long pros and cons grid.
- **How `CanvasPane` gets the tab labels.** It already takes `onBack`/`backLabel` from the brainstorm pane; a label map passed the same way is one option.
- **The judge.** How `judge-prompt.md` words the boards rule. Add `judge_test.go` cases: an option's `boards` come from its `from` approaches, a merged option gets the union, and an added or unmatched option gets none.
- **The skill edit**, as in section 1.
- **A CDP scenario** in the brainstorm area's `scripts/cdp/scenarios-*.mjs` that does each of these in turn:
  - opens a question whose answers name boards;
  - finds a board inside its answer row;
  - finds a shared board above the rows;
  - opens a board full size and reads its lettered tab.
