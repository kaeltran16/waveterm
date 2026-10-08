# User notes in the palette: read, edit, write — Implementation Plan

**Effort:** effort:7020926b-2fe9-4d38-a54f-701d1a4bbba3
**Verify:** `node scripts/verify.mjs ./pkg/notestore/... ./pkg/agentsync/...`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && go vet ./pkg/notestore/ ./skills/`
**Final:** `node scripts/cdp/final-verify.mjs palette-notes notes-wsh`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\held-notes\project\Palette.dc.html

> **For agentic workers:** use superpowers:executing-plans to implement your task. Do not spawn subagents or
> forks. A task here carries its design decisions, files, shared interfaces and acceptance; the implementation
> is yours. Never write `Co-Authored-By` or any attribution trailer into a commit.

**Goal:** The user reads, copies, deletes, edits and writes notes from a Notes scope in the Ctrl+P palette, and
agents know `wsh note add`.

**Architecture:** The backend is done and on main (057b4382): `pkg/notestore` keeps a note as
`<vault>/notes/<day>-<slug>.md`; the RPCs `NoteAddCommand`, `NoteListCommand`, `NoteUpdateCommand` and
`NoteDeleteCommand` are generated in `frontend/app/store/wshclientapi.ts` (type `UserNote`: `id`, `title`,
`body?`, `day`); `wsh note add|list|show|delete` is `cmd/wsh/cmd/wshcmd-note.go`. Do not rebuild or regenerate
them. This plan adds a pure note model and a small store beside the other `palette-*.ts` modules, a split
list-and-preview view and an editor that `command-palette.tsx` renders for the Notes scope, one skill, and two
CDP scenarios. There is no new surface, no new chrome and no new overlay: the palette is the only place a note
shows.

**Tech Stack:** React 19, jotai, TypeScript (strict: false), vitest, Tailwind 4, Go, CDP scenarios
(`scripts/cdp/scenarios.mjs`).

**The mockup is the visual spec.** The Prototype folder (gitignored, so it exists only in the main checkout;
read it by its absolute path) holds two boards. `Palette.dc.html` is the Notes scope: scope row, the note list
on the left (370px), the rendered note on the right, and the footer's key lines. `EditorWide.dc.html` is the
editor. Layout, sizes and copy come from the boards, colours from the `@theme` tokens those hex values are (see
DESIGN.md's token table). The board's split list-and-preview is a new view, not the existing peek component.

## Settled decisions (approved by the user; do not reopen)

- This plan writes straight double quotes around `<title>` and `<query>` in UI strings because the engine's
  worker launcher cannot carry typographic ones. The UI draws typographic double quotes there (U+201C opening,
  U+201D closing), as the boards do, and scenario steps assert those characters.
- A note stands alone: title, markdown body, day added. No author, no session, no project.
- Palette only. The Notes scope sits after Records in the scope row, prefix `no:`, noun "notes".
- The list is newest first as the server returns it; search matches titles only.
- Notes are also found from All by title. Enter on one there jumps to the Notes scope with that note selected
  (All has no preview pane).
- Enter copies the note's markdown as its file reads (`# <title>`, blank line, body) and closes the palette.
- Ctrl+Enter on a note opens the editor. The last row of the Notes list, "New note", opens the same editor
  empty; text typed in the search field becomes its title.
- Delete asks once: the first Del turns its footer line to the error tone and reads `del again deletes
  "<title>"`; a second Del deletes; any other key cancels. Del acts only with the caret at the end of the
  query, so it still edits text mid-query.
- Esc in the editor with unsaved changes asks once the same way (`esc again discards your changes`);
  unchanged, it goes straight back to the list. It never closes the palette from the editor.
- A failed load, save, copy or delete shows in the palette's existing error line (`paletteError`) and keeps
  the user's text. Nothing is swallowed.
- A long note scrolls in the preview with the wheel and with PageUp/PageDown.
- The list is read each time the palette opens. No live push.
- The editor body is plain markdown text in a textarea: no live preview, no toolbar.
- Agents write a note only when the user asks for one.

## Global Constraints

- Follow AGENTS.md and DESIGN.md. Colours only from existing `@theme` tokens in `frontend/tailwindsetup.css`:
  no raw hex/rgba in components and no new tokens.
- Personal-use app: no extra empty states, onboarding, settings or off switches beyond what is written here.
- Logic goes in a pure `.ts` model with a vitest file beside it; `.tsx` stays thin. No jsdom render tests.
- Never hand-edit generated files (`wshclientapi.ts`, `gotypes.d.ts`, `wshclient.go`). No task here needs
  `task generate`.
- Comments say why, never what; lower case; only when needed.
- `npx tsc` overflows the stack here: typecheck with the Check command. Do not run `task dev` or
  `task check:ts` in a worktree (they replace the `node_modules` junction).
- A task that adds a CDP step proves it once before completing with
  `ARC_FINAL_OUT=$(mktemp -d) node scripts/cdp/final-verify.mjs <scenario>` (it starts its own isolated dev
  app; never kill a `wave-tauri` or `wavesrv` process by image name). If it exits 3, say so and why in your
  completion note.
- CDP steps scope every DOM query to the palette's own dialog (`PALETTE` in `scenarios.mjs`), pin the
  viewport (`MODELS_VIEWPORT`), and send keys the way the `palette-actions` scenario does (`paletteKey`).

## Review Focus

- A title the store refuses (empty, over 200 bytes, a pasted newline): the editor names the problem in the
  error line and keeps the text. Task 4 tests the rule; Task 6 shows it.
- A note deleted or renamed by an agent while the palette is open: saving or deleting it fails with the
  server's "not found", shown in the error line, and the list reloads: `saveNoteDraft` and
  `deletePaletteNote` both reload after a failure as after a success. Task 4 tests it; Task 5 and Task 6
  each show it.
- A note whose body is empty, or one hand-edited to have no heading: it lists, previews (an empty pane) and
  copies without error. Task 4 tests `noteMarkdown` on an empty body.
- Del or Esc pressed once and then anything else: nothing is deleted or discarded. Task 4 tests the arm
  model; Task 5 and Task 6 each have a step.
- Typing in the Notes search while a row is armed for delete, or with the caret mid-query: Del edits the
  text. Task 5.

---

### Task 1: Notes of one day list newest first
**Depends on:** none
**Files:** `pkg/notestore/notestore.go`, `pkg/notestore/notestore_test.go`

`notestore.List` sorts by id descending, so notes added on the same day order by slug, and the note an agent
just wrote is not on top. Fix it at the source so `wsh note list` and the palette agree.

Decisions:
- Order: day descending (the id's date prefix), then the file's modified time descending, then id ascending
  as the tie-break. No change to the id or the file name, and no new field on `UserNote`.
- Modified time comes from the directory entry the loop already has. Editing a note therefore moves it to the
  top of its day; that is intended.
- Replace the `ponytail:` comment on the sort with one naming the remaining ceiling: a fresh clone gives
  every file of a day the checkout's time, so the order inside a day is then by id.

Acceptance:
- New test `TestListOrdersOneDayByModifiedTimeNewestFirst`: three notes on one day whose slug order
  disagrees with their modified times (set with `os.Chtimes`), plus one note on a later day; `List` returns
  the later day first, then the three by modified time, newest first.
- `TestListIsNewestDayFirstAndSkipsOtherFiles` still passes unchanged.
- Run: `go test ./pkg/notestore -run '^(TestListOrdersOneDayByModifiedTimeNewestFirst|TestListIsNewestDayFirstAndSkipsOtherFiles)$'`

### Task 2: A skill that teaches agents `wsh note add`
**Depends on:** none
**Chunk:** Build: teach agents the command
**Files:** `skills/notes/SKILL.md`, `skills/skills.go`, `AGENTS.md`

Arc's own skills live in `skills/` and are embedded into `wavesrv` by `skills/skills.go`; every agent launch
seeds them into the vault and from there into each harness. Add one skill, `notes`.

Decisions:
- A new skill, not a paragraph in `cockpit-ui`: a skill loads by its description, and this one must load on
  "save that as a note" and on nothing else.
- Frontmatter `name: notes`. The description starts with "Use when the user asks you to" and names the
  trigger phrases (write, save or keep a note; "note this down"; "save these steps for later") and the
  command, `wsh note add`. It says nothing that would make an agent load it on its own initiative.
- Body, short (about the length of `skills/cockpit-ui/SKILL.md`):
  - What a note is: markdown the user reads later from Ctrl+P → Notes. It stands alone, so it must make
    sense without this conversation: full commands, paths and the reason for each step.
  - `wsh note add "<title>" --body "<markdown>"`, and `--body -` to read the body from stdin for anything
    over a line (show a heredoc piped in). The title is one line of at most 200 bytes.
  - `wsh note list`, `wsh note show <id>`, `wsh note delete <id>`, and that there is no edit command: the
    user edits a note in the palette.
  - The rule, stated once and plainly: write a note only when the user asks for one. Never on your own, not
    even when handing over steps. Do not delete a note unless the user asks.
- Add `notes` to the `//go:embed` line in `skills/skills.go` and to the list of Arc's skills in AGENTS.md
  ("Arc's own skills live in `skills/` (…)").

Acceptance:
- `go build ./skills/ ./cmd/server/` succeeds, and `go vet ./skills/` is clean.
- Search `pkg/agentsync` and `skills/` for any test or list that enumerates the shipped skills by name; if
  one exists, add `notes` to it and run that test by name. Name what you found in your completion note.
- Every command line in the skill matches `cmd/wsh/cmd/wshcmd-note.go` (flags, argument order).

### Task 3: `wsh note` runs against a live wavesrv
**Depends on:** none
**Files:** `scripts/cdp/notes-wsh.mjs`, `scripts/cdp/scenarios.mjs`, `cmd/wsh/cmd/wshcmd-note.go` (only if a step finds a defect in it)

`wsh note` has only been unit-tested. Add a CDP scenario, `notes-wsh`, that runs the real `wsh` binary
against the dev app's wavesrv once: add, list, show, delete.

Decisions:
- The scenario lives in its own module, `scripts/cdp/notes-wsh.mjs` (as `narrationfeed.mjs` does), exported
  as `notesWsh` and registered in `SCENARIOS` in `scenarios.mjs` with one import and one array entry. Touch
  nothing else in `scenarios.mjs`.
- `wsh` needs a `WAVETERM_JWT` that only wavesrv mints, so node cannot run it directly. Run it inside the
  dev app: create a block whose controller runs a command (`controller: "cmd"`, see
  `pkg/blockcontroller/shellcontroller.go`, "for cmd type blocks") through `h.rpc`, running a small script
  the scenario writes to a temp dir. The script calls the `wsh` this tree built, by absolute path (look in
  `dist/bin`; do not trust PATH, which may hold the user's installed Arc's `wsh`), and writes each
  command's stdout and exit code to files in that temp dir, ending with a `done` file the scenario polls
  for. If a cmd block cannot do this, any other route that runs the real binary with a JWT from this
  wavesrv is fine; calling the RPCs through `h.rpc` alone is not, since that skips `wsh`.
- The script: `wsh note add "<stamp title>" --body -` with a two-line body on stdin, capturing the id from
  `added note <id>`; `wsh note list`; `wsh note show <id>`; `wsh note delete <id>`; `wsh note show <id>`
  again, expecting a nonzero exit.
- Titles carry a per-run stamp. Teardown deletes the block and, through `h.rpc`, any note whose title holds
  the stamp, so a failed run leaves nothing in the vault. Find out where this dev app's vault is
  (`wconfig.VaultRoot`) and say in your completion note whether it is the user's real vault.

Acceptance (the `notes-wsh` scenario's steps, each a real assertion, none skipped):
- `1. wsh note add prints the new note's id`: stdout matches `added note \d{4}-\d{2}-\d{2}-…`, exit 0.
- `2. wsh note list shows it, id then title`: a line `<id>\t<stamp title>`.
- `3. wsh note show prints the title heading and the body`: `# <stamp title>`, a blank line, both body lines.
- `4. the note the command wrote is the one the app lists`: `h.rpc` note list returns that id, title and body.
- `5. wsh note delete removes it`: exit 0, the RPC list no longer holds the id, and the second `show` exits
  nonzero with "not found".
- Prove it once: `ARC_FINAL_OUT=$(mktemp -d) node scripts/cdp/final-verify.mjs notes-wsh`.
- If a command misbehaves against the live server, fix the cause in `cmd/wsh/cmd/wshcmd-note.go` rather than
  loosening the step. Task 2 runs beside this task and copies that file's flags and argument order into
  `skills/notes/SKILL.md`: keep them as they are, and if a fix cannot, say so first in your completion note,
  naming the changed flag, so the skill is corrected.

### Task 4: The pure note models, the Notes scope and the note store
**Depends on:** none
**Files:** `frontend/app/cockpit/palette-notes.ts`, `frontend/app/cockpit/palette-notes.test.ts`, `frontend/app/cockpit/palette-notesstore.ts`, `frontend/app/cockpit/palette-notesstore.test.ts`, `frontend/app/cockpit/palette-scope.ts`, `frontend/app/cockpit/palette-scope.test.ts`, `frontend/app/cockpit/palette-groups.ts`, `frontend/app/cockpit/palette-groups.test.ts`

Everything the view tasks decide with, as pure functions, plus the scope and group kind they render under.
Tasks 5 and 6 rely on these names and signatures exactly.

`palette-scope.ts`:
- `ScopeId` gains `"notes"`. `SCOPES` gains, directly after Records,
  `{ id: "notes", label: "Notes", prefix: "no", noun: "notes", placeholder: "Search notes…" }`.
  `n:` still narrows to Needs you; `no:` narrows to Notes.

`palette-groups.ts`:
- `GroupKind` gains `"note"`; `KIND_LABELS.note = "Notes"`; `"note"` joins `ALL_KIND_ORDER` after `"effort"`.

`palette-notes.ts` (pure: no React, no runtime imports):

```ts
export const NEW_NOTE_KEY = "note:new";
export const NOTE_TITLE_MAX_BYTES = 200; // notestore.maxTitleLen
export function noteKey(id: string): string; // `note:${id}`
// "today", "yesterday", else the day itself; both arguments are YYYY-MM-DD
export function noteDayLabel(day: string, today: string): string;
// the note as its file reads: "# title\n" or "# title\n\nbody\n" (notestore.render)
export function noteMarkdown(note: UserNote): string;
// null when the server would take it; else the message for the error line (notestore.cleanTitle's rules)
export function noteTitleError(title: string): string | null;

export interface NoteDraft {
    id: string | null; // null: a new note
    title: string;
    body: string;
    saved: { title: string; body: string }; // what it was opened with
}
export function draftOf(note: UserNote): NoteDraft;
export function newDraft(query: string): NoteDraft; // the trimmed query is the title
export function draftDirty(d: NoteDraft): boolean;

// one armed confirmation at a time: a second press of the same key on the same target fires it,
// anything else disarms
export type ArmKey = "del" | "esc";
export interface Armed { key: ArmKey; target: string } // target: a note key, or "" for esc
export function pressArm(armed: Armed | null, key: ArmKey, target: string): { armed: Armed | null; fire: boolean };

// where the selection lands after the note at index i leaves a list of n notes
export function selectionAfterDelete(i: number, n: number): number;
```

`palette-notesstore.ts` (the only place the note RPCs are called from the frontend; follow
`palette-entities.ts` for the atom-plus-loader shape):

```ts
export const paletteNotesAtom: PrimitiveAtom<UserNote[] | null>; // null until the first load
export function loadPaletteNotes(): Promise<void>; // sets the atom; rejects on failure, never swallows
// add or update, then reload even when it failed; resolves the note's id, rejects with the save's error
export function saveNoteDraft(d: NoteDraft): Promise<string>;
// delete, then reload even when it failed; rejects with the delete's error
export function deletePaletteNote(id: string): Promise<void>;
```

A failed save or delete rejects with its own error, not the reload's: a reload that also fails is not allowed
to hide it.

Acceptance (`npx vitest run frontend/app/cockpit/palette-notes.test.ts frontend/app/cockpit/palette-notesstore.test.ts frontend/app/cockpit/palette-scope.test.ts frontend/app/cockpit/palette-groups.test.ts`):
- `noteDayLabel`: today, yesterday across a month boundary, and an older day returned as is.
- `noteMarkdown`: a note with a body, one with an empty body, one with no `body` field; no trailing blank
  line beyond the single newline.
- `noteTitleError`: empty and whitespace-only, 200 bytes passes and 201 fails, a multi-byte title counted in
  bytes, a title holding `\n`; a good title is null.
- `draftDirty`: unchanged is false; a changed title or body is true; changed and changed back is false; a
  new draft with a title from the query is dirty, an empty new draft is not.
- `pressArm`: first del arms without firing; second del on the same note fires and disarms; del on another
  note re-arms on that one without firing; esc while del is armed arms esc without firing.
- `selectionAfterDelete`: the middle keeps its index, the last moves up one, the only note gives 0.
- Store (`palette-notesstore.test.ts`, with `RpcApi` mocked as `palette-data.test.ts` mocks it):
  `loadPaletteNotes` sets the atom from the list call, and when that call rejects it rejects with the same
  error and leaves the atom as it was; `saveNoteDraft` calls add for a draft with no id and update for one
  with an id, reloads and resolves the id; when the update rejects, it still reloads (the list call is made
  and the atom holds its result) and rejects with the update's error; `deletePaletteNote` does the same on
  a rejected delete.
- Scope: `typeQuery` from an empty All turns `no:fix` into scope notes with query `fix`, and `n:` still
  into needs; `cycleScope` reaches notes after records; `ghostHint("no")` names Notes.
- Groups: an All result holding a note row groups it under "Notes".
- The Check command passes.

### Task 5: The Notes scope: list, preview, copy, delete
**Depends on:** Task 1, Task 3, Task 4
**Chunk:** Build: Notes scope in the palette with a preview
**Files:** `frontend/app/cockpit/palette-notesview.tsx`, `frontend/app/cockpit/palette-rows.tsx`, `frontend/app/cockpit/command-palette.tsx`, `scripts/cdp/scenarios.mjs`, `docs/keyboard-shortcuts.md`

Render the Notes scope as `Palette.dc.html` draws it, wired into the one palette. (Task 1 gives the
newest-first order step 1 asserts; Task 3 is a dependency only because it also edits `scenarios.mjs`.)
The dev app's vault may already hold notes, some of today: every step finds its rows by the run's stamp and
asserts order among the stamped rows, and arrange adds its notes last so the newest stamped one leads.

Decisions:
- `command-palette.tsx` loads the notes on each open (beside `loadPaletteEntities`), a failure going to
  `paletteError` as `Couldn’t load notes: <reason>` (the same error line step 12 shows for a failed
  delete; the rejection itself is tested in Task 4's `palette-notesstore.test.ts`, so no step forces a
  failed load). Note rows are ordinary `PaletteItem`s of kind `note`
  (key `noteKey(id)`, search = the title, meta = `noteDayLabel`, verb "Copy", echo `Copies "<title>"`), so
  selection, ↑↓, hover, ranking and the footer's echo line all come from the existing machinery. In the
  Notes scope an empty query keeps the server's order; a typed one ranks with `rankPaletteItems`.
- In All, note rows join the ranked pool and never the Recent list; their Enter does
  `pickScope(…, "notes")` and selects that note, with the echo `Shows the note in Notes`.
- When the scope is Notes (and no drill is open), the results area is the split view in the new
  `palette-notesview.tsx`: the list on the left at 370px with the board's 38px rows (boxed icon, title, day
  label, or `Copy ⏎` on the selected row), a border, and the selected note's body on the right rendered
  with `MarkdownMessage` (`frontend/app/view/agents/markdownmessage.tsx`: no raw HTML) in the markdown
  font. The view is presentational: it takes the rows, the selected index, the selected note and the
  hover/fire callbacks. `palette-rows.tsx` gains only what it must (the `note` kind's icon); reuse
  `Highlighted` and `VerbHint` by exporting them rather than copying them.
- No notes at all, or none matching: the scope's existing empty text from `narrowed([], ["note"])`, full
  width, no split. (Task 6 replaces this state with its "New note" row.)
- `docs/keyboard-shortcuts.md`, "Search" section: add Notes to the scope list and `no:` to the prefix row,
  both after Records, and two rows: `Enter` in Notes copies the note; `Del` twice in Notes, caret at the end
  of the query, deletes it.
- Enter: `navigator.clipboard.writeText(noteMarkdown(note))`, then close. A rejected write goes to
  `paletteError` as `Copy failed: <reason>` and the palette stays open.
- Del (bare, caret at the end of the query per `caretAtEnd`, a note row selected): `pressArm`. Armed, the
  footer shows a `del` line in the error tone reading `del again deletes "<title>"`; unarmed, the same line
  reads `Deletes it, after a second del` as on the board. Any other key, a selection change or a query
  change disarms. The firing press calls `deletePaletteNote`; success keeps the palette open on
  `selectionAfterDelete`; failure goes to `paletteError` as `Delete failed: <reason>`.
- PageUp/PageDown scroll the preview pane by most of its height; the wheel scrolls it natively.
- Give the scenario hooks: `data-palette-notes` on the split, `data-note-row="<id>"` on each row,
  `data-note-preview` on the preview pane, `data-palette-arm="del"` on the armed footer line.
- The footer's `ctrl ⏎` line and the "New note" row on the board belong to Task 6; leave them out.

Acceptance — a new scenario `palette-notes` in `scenarios.mjs` (model it on `palette-actions`, reuse
`openPalette`, `paletteKey`, `paletteStateWhen`; arrange adds four stamped notes through `h.rpc`: one whose
body has an ordered list and a fenced code block, one long enough to overflow the preview several times
over, and two short ones, then reloads; teardown deletes every note whose title holds the stamp), registered
in `SCENARIOS`, with these steps:
- `1. the Notes scope lists the notes beside a preview`: clicking `[data-palette-scope="notes"]` shows the
  token "Notes", `[data-palette-notes]`, the four stamped rows newest first, and the newest one selected.
  Shot `cdp-shots/palette-notes-list.png`.
- `2. the preview renders the selected note's markdown`: `[data-note-preview]` holds an `ol` with the
  note's steps and a code block with the fenced text, and no literal backtick fence.
- `3. ↓ moves the preview to the next note`: the preview's text changes to the second note's body.
- `4. typing filters by title`: a query unique to one stamped title leaves that row only; the highlighted
  title shows.
- `5. no: from All narrows to Notes`: typing `no:` in an empty All gives the token "Notes".
- `6. a note is found from All and Enter shows it in Notes`: in All, the stamped title lists under a
  "Notes" group; Enter leaves the palette open on the Notes scope with that note selected and previewed.
- `7. one del arms, another key disarms`: after Del, `[data-palette-arm="del"]` reads `del again deletes`
  and the note still exists by RPC; after ↓ the armed line is gone and the note still exists.
- `8. del twice deletes the note`: the row is gone, the RPC list lacks its id, the palette is still open
  with a neighbouring note selected. Shot `cdp-shots/palette-notes-deleted.png`.
- `9. PageDown and PageUp scroll a long note's preview`: with the long note selected,
  `[data-note-preview]`'s `scrollTop` is 0, grows after PageDown, and returns to 0 after PageUp; the
  selection does not move.
- `10. del with the caret mid-query edits the text and arms nothing`: with a typed query and the input's
  caret set to 0, the Del keydown is not default-prevented (`dispatchEvent` returns true), no
  `[data-palette-arm]` shows, and the note still exists by RPC.
- `11. a query matching no note says so across the full width`: the scope's empty text shows and
  `[data-palette-notes]` is absent.
- `12. deleting a note that is already gone says so and reloads the list`: one stamped note is deleted
  through `h.rpc` while the palette shows it; Del twice on its row shows the error line starting
  `Delete failed`, the palette stays open, and the row is gone from the reloaded list.
- `13. a copy the clipboard refuses says so and keeps the palette open`: the page's
  `navigator.clipboard.writeText` is replaced with a stub that rejects (`new Error("denied")`); after Enter
  on a stamped note the error line starts `Copy failed`, the palette is still open and the note still
  selected.
- `14. Enter copies the note and closes the palette`: the stub is replaced with one that records its
  argument and resolves; after Enter the recorded text equals the note's `# title`, blank line, body,
  exactly, and the palette is closed with no error line. The assertion is unconditional: no recorded call
  fails the step.
- Neither stub calls the real `writeText`: a CDP-driven WebView2 window without OS focus rejects a real
  write ("document is not focused"), and a real one would overwrite the user's clipboard mid-run. Teardown
  (and the end of step 14) restores the original function.
- Prove it once: `ARC_FINAL_OUT=$(mktemp -d) node scripts/cdp/final-verify.mjs palette-notes`.
- The Check command passes, and `npx vitest run frontend/app/cockpit` still passes.

### Task 6: Edit a note and write a new one
**Depends on:** Task 5
**Chunk:** Build: edit and write a note in the app
**Files:** `frontend/app/cockpit/palette-noteeditor.tsx`, `frontend/app/cockpit/palette-notesview.tsx`, `frontend/app/cockpit/palette-rows.tsx`, `frontend/app/cockpit/command-palette.tsx`, `scripts/cdp/scenarios.mjs`, `docs/keyboard-shortcuts.md`

The editor, as `EditorWide.dc.html` draws it: the whole palette becomes the editor.

Decisions:
- Entry: Ctrl+Enter on a note row opens it (`draftOf`); the footer gains the board's `ctrl ⏎` line,
  `Edits it` (the item's existing `alt` slot gives the key, the line and the firing). The Notes list gains a
  last row, "New note" (key `NEW_NOTE_KEY`, plus icon, verb "Write", echo `Writes a new note` or
  `Writes a new note titled "<query>"`), shown with an empty query and with a typed one, including when no
  note matches; it is never the default selection while a note is listed, and its Enter opens
  `newDraft(query)`. With it selected the preview pane is empty.
- Because the row is always there, the Notes scope always renders the split: Task 5's full-width empty text
  for the Notes scope is removed, with its scenario step (`a query matching no note says so…`), which the
  `New note takes the typed text as its title` step below replaces.
- `docs/keyboard-shortcuts.md`, "Search" section: add rows for `Ctrl`+`Enter` on a note (edit it), Enter on
  "New note" (write one; the query becomes its title), and the editor's keys (`Ctrl`+`Enter` saves, `Tab`
  moves between title and body, `Esc` goes back, twice when there are unsaved changes).
- While a draft is open the palette shows only the editor: the header's icon is a pencil, a chip button
  (the existing drill chip's classes; `data-palette-drill`) reads `Notes › Edit` or `Notes › New` and leads
  back, the header's field is the title (`aria-label="Title"`, placeholder `Title`; it is the same header
  input and keeps `data-palette-input`, which `PALETTE`, `PALETTE_STATE` and `openPalette` in
  `scenarios.mjs` find the dialog by: without it every editor step queries null and `openPalette`'s
  Ctrl+P closes the open editor), the scope row and the
  results list are not rendered, and a textarea (`data-note-body`, `aria-label` naming it the note's
  markdown body, mono, filling the body area, placeholder `Markdown…`) holds the body. The footer reads
  `ctrl ⏎` `Saves "<title>"` (or `Saves the note` with no title yet), with the keys `Tab title / body` and
  `esc back`. Editing opens with the caret in the body; a new note with an empty title opens in the title.
- The draft is editor state owned by `command-palette.tsx` (or a small hook beside it), not `NavState`: it
  is dropped when the palette closes. The editor component in `palette-noteeditor.tsx` is presentational.
- Keys inside the editor: Tab and Shift+Tab move between title and body and never cycle scopes; Enter in
  the title moves to the body; Ctrl+Enter saves from either field; the palette's list keys (↑↓, digits,
  Backspace-leaves-scope, →) do nothing here.
- Save: `noteTitleError` first, its message going to `paletteError`; then `saveNoteDraft`. Success returns
  to the Notes scope with an empty query and the saved note selected, showing its new body. Failure shows
  `Save failed: <reason>` in `paletteError` and keeps the editor and its text; `saveNoteDraft` has
  already reloaded the list behind it, so leaving the editor shows the list as the vault now has it.
- Leaving: Esc, the chip, or a backdrop click all route through one handler (`ModalShell`'s `onClose` while
  a draft is open). Not `draftDirty`: back to the Notes list at once. Dirty: `pressArm("esc")`: the footer
  shows a line in the error tone, `esc again discards your changes` (`data-palette-arm="esc"`); a second
  leave discards and goes back to the list; any typing disarms. Leaving never closes the palette.

Acceptance — steps added to the `palette-notes` scenario after Task 5's (renumber so Task 5's two copy
steps, the refused copy and then the copy that closes the palette, stay last). `paletteKey` sends no modifiers, so Ctrl+Enter on a list row cannot be sent with
it today: extend it with an optional modifiers argument (`{ ctrlKey: true }`, defaulting to none so every
existing caller is unchanged), and add a `noteKeyIn` helper beside it, taking the same modifiers, for keys
sent to the title or body:
- `the New note row sits last and is not the default`: with notes listed, the first note is selected and
  the last row reads "New note". (Extend step 1's shot so `palette-notes-list.png` shows the row and the
  `ctrl ⏎` footer line, matching `Palette.dc.html`.)
- `ctrl ⏎ opens the note in the editor`: the chip reads `Notes › Edit`, the title field holds the note's
  title, `[data-note-body]` holds its markdown source (the fence characters, not rendered), the scope row
  is gone. Shot `cdp-shots/palette-notes-editor.png`.
- `Tab moves between title and body`: focus goes title → body → title, and the scope does not change.
- `ctrl ⏎ saves the edit`: after changing the body and the title, the RPC list returns both under the same
  id, and the palette is back on Notes with that note selected and the new text in the preview.
- `esc on a changed draft asks once`: after typing, one Esc leaves the editor open with
  `[data-palette-arm="esc"]` showing; a second Esc returns to the list; the RPC list still has the old text;
  the palette is still open.
- `esc on an unchanged draft goes straight back, and so does the chip`: one Esc, the list is back, the
  palette is open; reopened with Ctrl+Enter, a click on `[data-palette-drill]` does the same.
- `saving a note that is already gone says so and keeps the text`: with the editor open on a stamped note
  and its body changed, the note is deleted through `h.rpc`; Ctrl+Enter shows the error line starting
  `Save failed`, the editor stays open, and `[data-note-body]` still holds the typed text; then Esc twice
  (the draft is dirty) returns to the list, which no longer holds that note's row: the failed save reloaded
  it.
- `New note takes the typed text as its title`: with a query matching no note, the "New note" row is
  selected and Enter opens the editor with chip `Notes › New` and that title; typing a body and Ctrl+Enter
  creates a note the RPC list returns, selected in the list. Shot `cdp-shots/palette-notes-new.png`.
- `a title the store refuses is named and the text kept`: clearing the title and pressing Ctrl+Enter shows
  the error line with `noteTitleError`'s message, the editor stays open, and the body text is unchanged.
- Prove it once: `ARC_FINAL_OUT=$(mktemp -d) node scripts/cdp/final-verify.mjs palette-notes`.
- The Check command passes, and `npx vitest run frontend/app/cockpit` still passes.
