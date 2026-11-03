# Brainstorm pane: mockups inside their answers Implementation Plan

> **For agentic workers:** each task below is one worker's. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An answer on a brainstorm question names its mockups, the pane draws them inside that answer's row (shared
ones once above the rows), and the full-size canvas's tabs say which answer each board belongs to.

**Architecture:** One optional `boards` list on an answer option (and on an approach) is the single source of the
pairing. The judge never writes it: it names each option's source approaches in `from`, and `judgeFileBytes` copies
those approaches' boards, so code, not a model, pairs a board with an answer. In the pane, two pure functions in
`brainstormmodel.ts` split the asked question's boards into per-answer rows and shared boards, and map each board to
its tab label; `brainstormui.tsx` draws the rows and `CanvasPane` takes the label map through a new optional prop.

**Tech Stack:** Go (`pkg/brainstormcheck`, wavesrv), React + jotai, vitest, CDP scenarios.

**Spec:** `C:\Users\kael02\AppData\Local\arc-wt\b27cb9f4\docs\superpowers\specs\2026-11-03-brainstorm-canvas-connection-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/brainstormcheck/... ./pkg/wshrpc/...`
**Check:** `go build ./... && go vet ./pkg/brainstormcheck/... ./pkg/wshrpc/... && task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs brainstorm-answer-boards brainstorm-mode brainstorm-question-reasons brainstorm-judged-question brainstorm-builder-check surface-smoke`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\brainstorm-canvas-connection\project\In-row.dc.html

## Decisions beyond the design (and why)

1. **Prototype line names `In-row.dc.html`, not `Today.dc.html`.** The run's goal text named `Today.dc.html`, but the
   approved spec names `In-row.dc.html` as the prototype; `Today.dc.html` is the before state this change replaces,
   so pointing the final verifier at it would grade the result against the layout being removed.
2. **Canvas boards with no scenario step:** `Today.dc.html` (the before state), `Gallery.dc.html`,
   `Long-B-cards.dc.html` and `Long-C-preview.dc.html` (alternatives the user did not pick) get no step, since the
   built UI must not look like them. `In-row`, `A-mismatch`, `Long-A-rows` and `Open-full-answer` (variant 2) each
   get one in `brainstorm-answer-boards`.
3. **The judge's approaches are read at decide time.** `judgeFileBytes` has only the report today. The session's
   `decide` gains the session, and the judge's reads `s.File` through `ReadJudgeInput` to get the approaches. The
   in-memory session is rebuilt from tab meta after a restart, so a launch-time snapshot would be lost. A read that
   fails is logged with the file path and the options deliver with no `boards`: the spec's anti-goal prefers a
   board shown unlettered to a lost question.
4. **`boards` the judge writes itself are discarded,** and `from` names match approach names exactly after trimming.
   The spec says code alone pairs boards; a near-match is a guess.
5. **The "option A of N" suffix leaves `Thumbnails` everywhere.** The part rows and the builder review show the
   plain board file name, per the spec's non-goal ("with plain names"); the index letter is the defect itself.
6. **"Missing on disk" filters answer-named boards only.** A board is on disk when it is in the brainstorm state's
   `boards` (read from `canvas.json`). Shared boards draw as today, so an old file keeps today's content.
7. **A question with no options** (open text) has no "For every answer" heading and no lettered tabs: that copy
   needs answers. Its part's boards still draw above the answer box.
8. **Thumbnail widths:** 200px for an answer's only board and for each shared board, 150px each for several boards
   side by side in one row (the prototype's sizes). A board named twice in one option draws once.
9. **Where rows draw boards.** Every `QuestionMain` draws them, including the one `brainstormcheck.tsx:108` renders
   for the agent's open question during the builder check: it is the brainstorm's open question, so its rows and
   its lettered tabs follow the same rule. Out of scope and unchanged: the builder's own asked questions
   (`BuilderAsk`, which calls `QuestionAnswers` at `brainstormcheck.tsx:182` with no board slot) and the approach rows
   drawn during the judge's wait. `brainstormcheck.tsx` itself needs no edit.
10. **Malformed `boards` never refuses the judge.** `ReadJudgeInput` unmarshals the question's options and
   approaches; a strict `[]string` would turn an agent's `"boards": "X.dc.html"` into "the brainstorm file is not
   readable" while the pane still shows the question. The Go side reads `boards` through a tolerant list type that
   keeps only non-blank strings, the same rule the pane's parser applies.
11. **The four unstepped canvas boards stay where they are** (Decision 2). The plan reviewer suggested moving them
   out of `project/`; that would rewrite the user's approved canvas, so the run accepts the finding instead.
12. **The poller reads `canvas.json` when an option names boards** even if no part lists any, so an answer-named
   board that is not on the part (spec section 3) can draw.

## Global Constraints

- `brainstorm.json` answer option: `{ "label", "detail", "pick"?, "pros"?, "cons"?, "boards"?: [file names],
  "from"?: [approach names] }`. Approach: `{ "name", "description", "facts", "boards"?: [file names] }`. Board names
  are file names under the canvas's `project/`, the same as a part's `boards`. The pane ignores `from`.
- Go: `Approach.Boards` and `JudgeOption.Boards` are a tolerant list type over `[]string` (json tag
  `boards,omitempty`) whose `UnmarshalJSON` accepts any JSON value and keeps only non-blank strings, so a malformed
  field reads as empty and never fails the unmarshal; `JudgeOption.From []string` (json tag `from,omitempty`).
- Copy: shared heading `For every answer`; link `Open full size`; tab labels `A · Left-rail`, `A, C · Left-rail`
  (letters in option order, joined `, `), `Every answer · Run-sheet-today`; `boardLabel` strips `.dc.html`.
- Nothing is paired by count, order or file name: only an option's own `boards` puts a board in its row.
- Edit `skills/`, then run `task sync:claudemod` for the tracked copy; never hand-edit the copy.
- Colors from `@theme` tokens, reuse the pane's existing classes; no new tokens.
- Typecheck with `task check:ts` (~2 min), never `npx tsc`. Check only the files you touched with prettier/gofmt.

## Review Focus

1. **The judge writes `boards` on an option itself** (with or without `from`): the user expects only the source
   approaches' boards. Test in Task 1.
2. **One board named by two answers:** it draws in both rows and its tab reads `A, C · name`. Tests in Task 3.
3. **`canvas.json` not loaded yet** (state `boards` empty while `base` is set): no crash, answer rows draw no
   thumbnail, shared boards still draw. Test in Task 3.
4. **Malformed option `boards`** (a string, numbers, blanks, duplicates): parse keeps the non-blank strings once,
   and the question still arrives, and the judge still reads the file (Decision 10). Tests in Task 3 and Task 1.
5. **A merged judge option whose approaches share a board:** the union holds it once, in `from` order. Test in Task 1.

---

### Task 1: The judge carries each option's boards from its approaches

**Depends on:** none
**Files:** `pkg/brainstormcheck/judge.go`, `pkg/brainstormcheck/judge_test.go`, `pkg/brainstormcheck/judge-prompt.md`, `pkg/wshrpc/wshserver/wshserver_brainstorm.go`, `pkg/wshrpc/wshserver/wshserver_brainstorm_test.go`

**Interfaces (produces):**
- `func DecideJudge(run *waveobj.Run, lostReason string, approaches []Approach) (Action, []byte)`
- `func judgeFileBytes(report string, approaches []Approach) ([]byte, error)`
- `sessionKind.decide` becomes `func(s brainstormSession, run *waveobj.Run, lostReason string) (brainstormcheck.Action, []byte)`; the builder check's closure ignores `s`.

- [ ] **Step 1: Write the failing tests** in `judge_test.go`:
  - `TestJudgeFileBoardsFromApproaches`, table-driven over a report and a list of approaches with boards, asserting
    each option's `boards` in the delivered judge.json:
    - an option with `from: ["Left rail"]` gets that approach's boards in order;
    - a merged option with `from: ["Left rail", "Top strip"]` gets the union in `from` order, a board both list kept
      once;
    - an option with no `from` gets none, and so does one whose `from` names no listed approach (`"Ask the hook"`,
      added by the judge); neither fails the result;
    - an option on which the judge wrote `boards: ["X.dc.html"]` and no `from` gets none;
    - `approaches == nil` leaves every option without `boards`;
    - `from` survives in judge.json.
  - Extend the prompt tests: with an approach that lists boards, `JudgePrompt` holds a line
    `   Boards: Left-rail.dc.html, Left-rail-failed.dc.html` under it, and no `Boards:` line for one that lists none;
    `TestJudgePromptSaysWhatTheJudgeMustDo` also asserts the prompt asks for `from` on every option.
  - `TestReadJudgeInputToleratesMalformedBoards`: a file whose approach has `"boards": "X.dc.html"` and whose
    option has `"boards": [1, " ", "A.dc.html"]` reads without error; the approach's boards are empty and the
    option's are `["A.dc.html"]`.
  - Update the existing `DecideJudge` callers in the tests to pass approaches.
- [ ] **Step 2: Run** `go test ./pkg/brainstormcheck -run 'TestJudgeFileBoardsFromApproaches|TestJudgePrompt|TestDecideJudge|TestReadJudgeInputToleratesMalformedBoards'`. Expected: FAIL (no `From`/`Boards` fields, old signature).
- [ ] **Step 3: Implement** the fields (Global Constraints), `approachesText` printing each approach's boards,
  `judgeFileBytes` setting each option's `Boards` from its `From` (overwriting anything the judge wrote), and
  `DecideJudge` passing the approaches through. In `judge-prompt.md`, add `from` to the JSON example and a bullet:
  every option lists in `from` the names, as listed, of the approaches it offers or combines, and `[]` for one you
  added; say nothing about boards beyond that.
- [ ] **Step 4: Wire the server.** In `wshserver_brainstorm.go`, change `decide`'s signature; the judge's closure reads
  `s.File`, takes `ReadJudgeInput(raw).Approaches`, and on a read or parse error logs `judge: reading approaches from
  <file>: <err>` and passes nil. Update `TestBrainstormJudgeDelivers` so the seeded file's approaches list boards and
  the report's option names one in `from`, and assert the written judge.json carries that approach's boards.
- [ ] **Step 5: Run** `go test ./pkg/brainstormcheck -run 'TestJudgeFileBoardsFromApproaches|TestJudgePrompt|TestDecideJudge|TestReadJudgeInputToleratesMalformedBoards'` and `go test ./pkg/wshrpc/wshserver -run 'TestBrainstormJudge'`. Expected: PASS.
- [ ] **Step 6: Commit** the five files: `feat(brainstorm): the judge's options carry boards from their approaches`.

### Task 2: The skill teaches answers to name their boards

**Depends on:** none
**Files:** `skills/brainstorm/SKILL.md`, `cmd/wsh/cmd/claude-mod/skills/brainstorm/SKILL.md`

- [ ] **Step 1: Edit `skills/brainstorm/SKILL.md`:**
  - the option shape (around "each `{ "label", "detail", "pros", "cons" }`") gains `boards`: the board file names
    that show this answer; the pane draws them inside the answer's row; leave it out for an answer with none; never
    pair by order;
  - the "Mockups" paragraph: name an answer's boards on the answer *and* keep listing every board on the part, which
    stays the full set; a board for every answer goes on the part only;
  - the approaches shape gains `boards`, and the judge section says Arc sets each judged option's `boards` from the
    approaches it names in `from`, so copy judge.json's `options` as they are, `from` and `boards` included;
  - the example file's question options and approaches show `boards` once each.
- [ ] **Step 2: Run** `task sync:claudemod`, then `git diff --stat` shows both SKILL.md files changed identically
  (`diff skills/brainstorm/SKILL.md cmd/wsh/cmd/claude-mod/skills/brainstorm/SKILL.md` is empty), and
  `claude plugin validate claude/arc-mod` passes.
- [ ] **Step 3: Commit** both files: `docs(brainstorm): answers name their mockups in the skill`.

### Task 3: Pairing boards to answers, in the model

**Depends on:** none
**Files:** `frontend/app/view/agents/brainstormmodel.ts`, `frontend/app/view/agents/brainstormmodel.test.ts`, `frontend/app/view/agents/brainstormpoller.ts`, `frontend/app/view/agents/brainstormpoller.test.ts`

**Interfaces (produces), in `brainstormmodel.ts`:**
- `AnswerOption` gains `boards?: string[]`.
- `export type QuestionBoardLayout = { rows: string[][]; shared: string[] }` — `rows[i]` is option `i`'s boards to
  draw, `shared` the asked part's boards no option names.
- `export function questionBoardLayout(f: BrainstormFile, base: string | null, onCanvas: string[]): QuestionBoardLayout | null`
  — null when there is no open question, no `canvas`, `base` is null, or nothing would draw. `onCanvas` is the
  state's board names (`s.boards.map((b) => b.name)`).
- `export function boardTabLabels(f: BrainstormFile): Record<string, string> | null` — null when `f.question` is
  null or has no options; otherwise every board an option names maps to `<letters> · <boardLabel>`, and every asked
  part board no option names to `Every answer · <boardLabel>`. A board absent from the map keeps its plain name.

- [ ] **Step 1: Write the failing tests** in `brainstormmodel.test.ts` (`describe("questionBoardLayout and boardTabLabels")`), one `it` each, with the expected `rows`, `shared` and labels written out:
  - one board for three answers (on the part, named by none): `rows` `[[], [], []]`, `shared` `["Page.dc.html"]`,
    label `Every answer · Page`;
  - two boards on one answer: both in its row, in its order;
  - an answer with none: `[]` for its row;
  - a named board missing on disk (not in `onCanvas`): left out of its row, the rest of the row kept;
  - an old file with no `boards` on its options: every part board in `shared`, rows empty;
  - one board named by two answers (A and C): in both rows, label `A, C · Left-rail`;
  - a board an answer names that is not on the part: in its row and labeled, not in `shared`;
  - `onCanvas` empty with `base` set: no throw, rows empty, `shared` still the part's boards;
  - no question, no canvas, `base` null, or nothing to draw → `null`; a question with no options → labels `null`.
  - parse: `boards: "A.dc.html"`, `[1, " ", "A.dc.html", "A.dc.html"]` parse to `["A.dc.html"]` or none, the option
    and question still arrive; `from` is not kept on the parsed option.
  - In `brainstormpoller.test.ts`: a file whose only boards are on a question option still reads `canvas.json`.
- [ ] **Step 2: Run** `npx vitest run frontend/app/view/agents/brainstormmodel.test.ts frontend/app/view/agents/brainstormpoller.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `boards` in `parseOptions` (non-blank strings, deduped, absent when empty), the two
  functions beside `questionBoards`, and `listsBoards` in `brainstormpoller.ts` counting the question's option
  boards. Keep `questionBoards` for now: Task 4 removes it with its last caller.
- [ ] **Step 4: Run** the Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** the four files: `feat(brainstorm): pair a question's boards with the answers that name them`.

### Task 4: Mockups inside their answer rows, and lettered tabs full size

**Depends on:** Task 3 (uses `questionBoardLayout`, `boardTabLabels`, `AnswerOption.boards`)
**Files:** `frontend/app/view/agents/brainstormui.tsx`, `frontend/app/view/agents/brainstormpane.tsx`, `frontend/app/view/agents/canvaspane.tsx`, `frontend/app/view/agents/brainstormmodel.ts`, `frontend/app/view/agents/brainstormmodel.test.ts`, `scripts/cdp/scenarios-brainstorm.mjs`, `scripts/cdp/scenarios.mjs`

**Interfaces:**
- `CanvasPane` gains optional `tabLabels?: Record<string, string>`; a tab reads `tabLabels?.[name] ?? boardLabel(name)`;
  `All` stays `All`; frame labels on the canvas stay plain (variant 2 changes the tabs only).
- `QuestionAnswers` and `Options` gain an optional per-row slot (e.g. `rowBoards?: (i: number) => ReactNode`);
  `brainstormcheck.tsx` keeps calling them without it.

- [ ] **Step 1: The rows.** In `QuestionMain`, replace the `data-brainstorm-question-boards` column with
  `questionBoardLayout(f, s.base, s.boards.map((b) => b.name))`: shared boards in a `data-brainstorm-shared-boards`
  block above the answers, headed `For every answer` when the question has options, each thumbnail with its file
  name and `Open full size`; each option's boards in a `data-brainstorm-row-boards` block on the right of its row,
  outside the row's `<button>` (clicking Open full size must not send the answer), a caption (`boardLabel`) under
  each only when the row has several. Widths per Decision 8. The row keeps its letter, label, detail, pick tag, pros
  and cons grid, letter-key focus and Enter; a row with no board has no empty slot. `Thumbnails` drops the
  `option X of N` suffix everywhere and takes its width from its caller. Remove `questionBoards` and its tests.
- [ ] **Step 2: The tabs.** `brainstormpane.tsx` passes `tabLabels={boardTabLabels(f) ?? undefined}` to `CanvasPane`
  (undefined when `f` is null); `canvaspane.tsx` applies it. Labels hold under All and while stepping `[`/`]`.
- [ ] **Step 3: Update `brainstorm-mode`** (`scenarios-brainstorm.mjs`): the `qBoards` read records whether each
  thumbnail sits above the answers instead of beside them; step 2d expects the plain label `Page.dc.html`; steps
  2l2/2l3 expect question 5's two boards (its options name none: the old-file case) once, above the answers, under
  `For every answer`, unlettered, each with Open full size.
- [ ] **Step 4: Add the scenario `brainstorm-answer-boards`** in `scenarios-brainstorm.mjs`, registered in
  `scenarios.mjs`. Its arrange writes a canvas (`project/canvas.json` with `order` exactly `Left-rail`,
  `Left-rail-failed`, `Top-strip`, `Run-sheet-today`, each `.dc.html`, plus a page for each; the tabs follow this
  order) as `brainstorm-mode`'s arrange does, registering the
  project if serving needs it, and a question mirroring `A-mismatch`: part boards `Run-sheet-today`, `Left-rail`,
  `Top-strip`; A names `Left-rail` and `Left-rail-failed` (not on the part) with long pros and cons (the
  `Long-A-rows` case); B names `Top-strip` and `Gone.dc.html` (not on disk); C names none. Steps, each a `rec`:
  1. (In-row) A's row holds the `Left-rail` thumbnail with Open full size, inside A's row and right of its label;
     B's row holds `Top-strip` only (Gone left out);
  2. (A-mismatch) A's row holds two thumbnails side by side, captioned `Left-rail` and `Left-rail-failed`; C's row has
     no thumbnail; `Run-sheet-today` shows once, above the rows, under `For every answer`;
  3. (Long-A-rows) A's thumbnails sit right of its pros and cons and inside the pane's width (no horizontal overflow);
  4. (Open-full-answer, variant 2) Open full size on A's `Left-rail` shows the board; the tabs read `All`,
     `A · Left-rail`, `A · Left-rail-failed`, `B · Top-strip`, `Every answer · Run-sheet-today` (canvas order);
     `]` steps to the next board and the labels hold; selecting All keeps them; Back returns to the question.
  Take a screenshot after steps 1, 2 and 4.
- [ ] **Step 5: Run** `npx vitest run frontend/app/view/agents/brainstormmodel.test.ts` and `task check:ts`.
  Expected: PASS. Start no dev app: Final runs `brainstorm-answer-boards` and the updated `brainstorm-mode` on the
  merged result, so step 4's and step 3's assertions are checked there.
- [ ] **Step 6: Commit** the seven files: `feat(brainstorm): mockups inside their answer rows`.
