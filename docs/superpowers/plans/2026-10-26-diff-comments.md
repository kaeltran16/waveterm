# Diff comments to the agent Implementation Plan

**Spec:** `docs/superpowers/specs/2026-10-26-diff-comments-design.md` — read it in full before your task, including
its "Builder decisions" section, which settles every point the spec left to the builder.
**Verify:** `node scripts/verify.mjs ./pkg/wshrpc`
**Check:** `task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs diff-comments diff-review-marks`
**Prototype:** C:/Users/kael02/IdeaProjects/waveterm/.superpowers/design/diff-comments/project/Main.dc.html

**Goal:** Mark lines of the Diff surface's diff with comments and send the batch to the agent that made the changes
(or to a new Claude Code agent) as one prompt.

**Architecture:** Frontend only. A persisted, per-source comment store (`diffcomments.ts`, after `reviewmarks.ts`)
is the shared interface. Two branches build on it at once: the prompt and send logic (pure, IO seam as in
`canvassend.ts`), and the Monaco layer in the diff pane (glyph +, draft and pending cards as view zones). The last
task wires the send bar, the file-list badges, the bindings and the docs.

**Tech Stack:** React 19, jotai, Monaco diff editor, vitest, the CDP scenario harness (`scripts/cdp/scenarios.mjs`).

## Global Constraints

- Only the Diff surface (key `files`); it stays read-only toward git. A comment only ever becomes a prompt.
- Pending comments live in module-level jotai atoms, never component state (the surface unmounts on switch).
- Colors from `@theme` tokens in `frontend/tailwindsetup.css` only; no new tokens, no raw hex/rgba in components.
- No jsdom/render tests: pure logic in a `.ts` with a `.test.ts` beside it; rendered UI is proven by CDP steps.
- Keys: `m` comments, Ctrl+Enter adds, Esc cancels, Shift+Enter sends. Copy as in the boards: "Comment on lines
  7–9", "pending", "3 comments in 2 files, to loom", "working, joins its turn", "a new agent in waveterm",
  "Sent 3 comments to loom", "Press m or click a line's + to comment for loom", "Send again".
- Never hand-edit generated files (none are needed here). Check only the files you touched with prettier/eslint.

## Review Focus

1. Typing a note that contains `m` (or any letter Monaco binds) in a card's textarea types the letter; it does not
   open another draft or move the editor (Task 3 scenario step 3).
2. The working-tree poll reloads the open pair every few seconds: re-finding must not write the store or
   localStorage when nothing moved (Task 1 test `relocateComments is a no-op when every comment is in place`).
3. A commented file that is later deleted, turned binary or emptied: its comments go `lost`, stay counted and are
   still sent with their original lines and quote (Task 1 test `relocate marks lost on empty text`, Task 2 test
   `prompt includes lost comments`).
4. Corrupt or foreign data under the storage key starts empty per bad entry, never throws (Task 1 parse tests).
5. Shift+Enter pressed twice while a send is in flight sends once (Task 2 test `sendBatch refuses a second send of
   the same batch while one is in flight`).

---

### Task 1: The comment store and the pair's refs
**Depends on:** none
**Files:** `frontend/app/view/agents/diffcomments.ts`, `frontend/app/view/agents/diffcomments.test.ts`, `frontend/app/view/agents/diffcontentstore.ts`, `frontend/app/view/agents/diffcontentstore.test.ts`, `frontend/app/view/agents/reviewmarks.test.ts`, `frontend/app/view/agents/filessurface.tsx`

Decisions: one localStorage key, `diff.comments.pending`, `Record<originKey, CommentBatch>`, parsed entry by entry
and pruned to `MAX_COMMENT_BATCHES = 50` by `at`, with the same warn-and-start-empty handling as `reviewmarks.ts`.
Quotes capped at `MAX_QUOTE_LINES = 40`. Ids from `crypto.randomUUID()`.

**Interfaces (produces; Tasks 2-4 rely on these exact names):**

```ts
// diffcontentstore.ts: DiffPair gains `refs: DiffPairRefs`, set by loadDiffPair from pairRefsFor(sel)

// diffcomments.ts
export type CommentSide = "modified" | "original";
export interface BatchSource {
    key: string;              // originKey(scope.repo.origin)
    kind: "agent" | "run" | "project";
    label: string;            // scope.repo.label, e.g. "loom"
    cwd: string;              // filesStateAtom.cwd when published
    agentId?: string; runId?: string;   // runId: a run origin's id, or the source agent's AgentVM.runId
    project?: string;         // project name (project origin, or the agent's AgentVM.project)
    projectPath?: string;     // project origin's path
}
export interface PendingComment {
    id: string; path: string; side: CommentSide;
    start: number; end: number;       // 1-based, inclusive, in that side's text
    quote: string[];                  // the range's lines when made, at most MAX_QUOTE_LINES
    refs: DiffPairRefs; note: string; at: number; lost?: boolean;
}
export interface CommentBatch { source: BatchSource; at: number; comments: PendingComment[] }
export type CommentStore = Record<string, CommentBatch>;
export interface CommentDraft {
    path: string; side: CommentSide; start: number; end: number; quote: string[]; refs: DiffPairRefs;
    editingId?: string; note: string;
}
export const COMMENT_STORAGE_KEY = "diff.comments.pending";
export const MAX_COMMENT_BATCHES = 50;
export const MAX_QUOTE_LINES = 40;
export const commentStoreAtom: PrimitiveAtom<CommentStore>;
export const activeCommentSourceAtom: PrimitiveAtom<BatchSource | null>;   // published by the surface
export const commentDraftAtom: PrimitiveAtom<CommentDraft | null>;
export const sentNoteAtom: PrimitiveAtom<Record<string, { count: number; to: string; at: number }>>;
export function pairKey(refs: DiffPairRefs): string;
export function parseStoredComments(raw: string | null): CommentStore;
export function pruneBatches(store: CommentStore, max: number): CommentStore;
export function quoteLines(text: string, start: number, end: number): string[];
export function relocate(c: PendingComment, text: string): PendingComment;  // same object when unchanged
export function addComment(source: BatchSource, draft: CommentDraft): void;  // edits when draft.editingId; clears the source's sent note
export function deleteComment(key: string, id: string): void;
export function discardBatch(key: string): void;
export function relocateComments(key: string, path: string, refs: DiffPairRefs, texts: { original: string; modified: string }): void;
export function commentsOnPair(batch: CommentBatch | undefined, path: string, refs: DiffPairRefs): PendingComment[]; // lost excluded
export function countsByPath(batch: CommentBatch | undefined): Record<string, number>;  // lost included
export function batchSummary(batch: CommentBatch | undefined): { comments: number; files: number };
export function batchSourceFor(scope: DiffScope | null, cwd: string | null, agent: AgentVM | undefined): BatchSource | null; // null only with no scope; cwd "" when unresolved
```

- [ ] Write `diffcomments.test.ts` first: parse keeps good batches and drops malformed ones one by one (non-JSON,
  non-object, a comment missing `path`/`start`/`refs`, `start > end`); prune keeps the 50 newest by `at`;
  `quoteLines` caps at 40; `relocate` keeps a comment in place (same object), moves it to the nearest exact match of
  its quoted block when lines were inserted above it, marks `lost` when the block is gone or the text is empty
  (`relocate marks lost on empty text`), and clears `lost` when the block returns; `relocateComments is a no-op when
  every comment is in place` (store atom identity unchanged, `localStorage.setItem` not called); `addComment` with
  `editingId` replaces the note and keeps id/anchor; `addComment` clears `sentNoteAtom[key]`; `commentsOnPair` filters
  by path and `pairKey` and excludes lost; `countsByPath` and `batchSummary` count lost comments; `batchSourceFor`
  maps the three origins (agent copies `runId` and `project` from the AgentVM), returns null with no scope, and gives
  `cwd: ""` when unresolved; `addComment` from a source with `cwd: ""` keeps the batch's stored cwd, project and
  runId (an ended agent no longer resolves them).
- [ ] Run `npx vitest run frontend/app/view/agents/diffcomments.test.ts`: fails.
- [ ] Implement `diffcomments.ts`; add `refs` to `DiffPair` and set it in `loadDiffPair`; extend
  `diffcontentstore.test.ts` to assert the loaded pair carries `pairRefsFor(sel)`; fix the `reviewmarks.test.ts`
  `DiffPair` fixture for the new field.
- [ ] In `filessurface.tsx`, publish `batchSourceFor(scope, state?.cwd, agent)` into `activeCommentSourceAtom` in an
  effect (null on unmount), beside the `activeReviewAtom` effect.
- [ ] `npx vitest run frontend/app/view/agents/diffcomments.test.ts frontend/app/view/agents/diffcontentstore.test.ts frontend/app/view/agents/reviewmarks.test.ts` passes; `task check:ts` exits 0. Commit.

### Task 2: The prompt, the recipient and the send
**Depends on:** Task 1 (uses the comment store's types, `discardBatch` and `sentNoteAtom`)
**Files:** `frontend/app/view/agents/commentprompt.ts`, `frontend/app/view/agents/commentprompt.test.ts`, `frontend/app/view/agents/commentsend.ts`, `frontend/app/view/agents/commentsend.test.ts`

Decisions are the spec's "Recipient", "The new agent", "The prompt" and "Send" bullets; copy their strings exactly.

**Interfaces (produces; Task 4 relies on these):**

```ts
// commentprompt.ts
export function pairLabel(refs: DiffPairRefs): string;  // "worktree against a1b2c3d" | "commit a1b2c3d" | "main..feature"
export function buildCommentPrompt(batch: CommentBatch, to: "live" | "new"): string;

// commentsend.ts
export type Recipient =
    | { kind: "live"; name: string; blockId: string; working: boolean }
    | { kind: "new"; cwd: string; project: string; folder: string; ended?: string }  // folder: "waveterm", "loom's folder"; ended: "loom"
    | { kind: "wait"; reason: string };
export interface RecipientFacts {
    agent?: Pick<AgentVM, "name" | "blockId" | "state" | "kind" | "runId">;  // the roster entry, absent when ended
    run?: Pick<Run, "status" | "landpath" | "land" | "projectpath">;
    projectPath?: string;          // the registered path for batch.source.project
    folderExists: boolean | null;  // for batch.source.cwd; null while unknown
}
export function resolveRecipient(batch: CommentBatch, facts: RecipientFacts): Recipient;
export function sendBarText(summary: { comments: number; files: number }, r: Recipient): { count: string; detail: string; action: string };
export interface CommentSendIO {
    prompt(blockId: string, text: string): Promise<void>;
    launch(cwd: string, project: string, task: string): Promise<void>;
    exists(path: string): Promise<boolean>;
}
export function tauriCommentSendIO(model: AgentsViewModel): CommentSendIO; // AgentPromptCommand; launchAgent(runtime "claude", runtimeStartupCommand("claude")); FileInfoCommand
export async function sendBatch(batch: CommentBatch, r: Recipient, io: CommentSendIO): Promise<void>;
```

- [ ] Write `commentprompt.test.ts`: the Prompt board's batch (policy.go 4, policy.go 7-9, legacy.go removed 1-3 on
  `worktree against a1b2c3d`) renders exactly the spec's wording, live and new headers; a two-pair batch drops the
  header's pair and suffixes each location "in <pair>"; a commit pair's removed range names `<sha7>^`; a 40-hex ref
  shortens to 7; the quote is the range's first non-blank line; `prompt includes lost comments` with their original
  lines and quote.
- [ ] Write `commentsend.test.ts`: one case per recipient rule in the spec (live; live but `working`; terminal kind
  is not live; agent with `runId` follows the run; run landed / no landpath and done / held with reason / cancelled
  with landpath / running; project registered path beats the stored one; ended agent with folder, folder gone with
  project, folder gone without project, `folderExists: null` waits with "checking the folder"); `sendBarText` for
  each kind ("Send 3 comments", "Start agent with 2 comments"; a live detail of "working, joins its turn" when
  working, else "at its prompt"); `sendBatch` with a fake IO: success clears the batch
  and, for live, sets `sentNoteAtom[key]`; a rejecting `prompt` throws `Couldn't send to loom: <message>` and keeps
  the batch; a rejecting `launch` throws `Couldn't start an agent in <folder>: <message>`; a `wait` recipient
  throws its reason; `sendBatch refuses a second send of the same batch while one is in flight`.
- [ ] Run both test files: they fail. Implement both modules. Run them: they pass. `task check:ts` exits 0. Commit.

### Task 3: Commenting in the diff pane
**Depends on:** Task 1 (uses the comment store, `DiffPair.refs` and `activeCommentSourceAtom`)
**Files:** `frontend/app/view/agents/diffpane.tsx`, `frontend/app/view/agents/diffcommentlayer.ts`, `frontend/app/view/agents/diffcommentcard.tsx`, `frontend/app/view/agents/diffcommentmodel.ts`, `frontend/app/view/agents/diffcommentmodel.test.ts`, `frontend/app/view/agents/diffoptions.ts`, `frontend/app/view/agents/diffoptions.test.ts`, `frontend/tailwindsetup.css`, `scripts/cdp/scenarios.mjs`

Decisions are the spec's "Monaco", "`m` has two routes", "Unified view, removed-only hunks", "Re-finding" and
"Draft and edit" bullets. The board is `Composer.dc.html` (draft) and the cards in `Main.dc.html`.

**Interfaces (produces; Task 4 relies on these):**

```ts
// diffcommentlayer.ts, registration by identity as diffnav.ts does
export function commentOnSelection(): boolean;  // false: no editor mounted, or no source published
// diffcommentmodel.ts (pure)
export function rangeLabel(side: CommentSide, start: number, end: number): string;   // "Line 4", "Lines 7–9", "Removed lines 1–3"
export function draftTitle(side: CommentSide, start: number, end: number): string;   // "Comment on lines 7–9"
export function removedOnlyHunks(changes: { modifiedEndLineNumber: number; modifiedStartLineNumber: number }[]): number[]; // modified lines to hang the hint under
export function commentableSide(side: CommentSide, split: boolean): boolean;          // original only in split
```

DOM contract (Task 4's scenario steps use it): `[data-diff-comment-plus]` on the glyph decoration,
`[data-diff-comment-draft]` with its `textarea`, `[data-diff-comment-card="<id>"]` with `data-comment-state="pending"`,
`[data-diff-comment-edit]`, `[data-diff-comment-delete]`, `[data-diff-split-hint]`.

- [ ] Write `diffcommentmodel.test.ts` (labels with an en dash, single vs range, removed-only detection ignores mixed
  hunks, `commentableSide("original", false) === false`) and extend `diffoptions.test.ts` for `glyphMargin: true`.
  Run them: they fail; implement; they pass.
- [ ] Build the layer in `diffcommentlayer.ts` + `diffcommentcard.tsx` and mount it from `diffpane.tsx`'s `onMount`:
  hover decoration and click on the glyph margin; `m` as a Monaco command with precondition `editorTextFocus` on
  both editors; draft and pending cards as React portals in view zones (height kept in step with the card by a
  ResizeObserver); card root stops keydown/mousedown propagation; Ctrl+Enter adds (`addComment`), Esc cancels, both
  then blur focus back to the surface; edit and delete on pending cards; the split hint zone in unified view;
  `relocateComments` on every pair load (beside the `noteOpenPair` effect). The glyph class goes in
  `tailwindsetup.css` using existing tokens.
- [ ] Add scenario `diff-comments` to `scripts/cdp/scenarios.mjs` (`surface: "files"`), arranged like
  `diff-review-marks` (same temp repo, a registered project; clear and restore `COMMENT_STORAGE_KEY` around a
  reload). Steps, each with a screenshot under `cdp-shots/diff-comments-*.png`:
  1. hovering line 3 of `src/retry/policy.go` shows `[data-diff-comment-plus]`; clicking it opens a draft titled
     "Comment on line 3";
  2. selecting lines 7-9 in the modified editor and pressing `m` with focus in it opens "Comment on lines 7–9"
     (Composer board);
  3. typing a note containing "m" (`Input.insertText` plus one real `m` keyDown) keeps every character, and
     Ctrl+Enter adds a card with `data-comment-state="pending"` under line 9;
  4. edit changes the note; delete removes the card;
  5. in unified view the deleted `legacy.go` shows `[data-diff-split-hint]`; after Shift+D its left side takes a
     comment that reads "Removed lines 1–3";
  6. appending two lines above the commented range in the working tree moves the card down with them on the next
     poll (re-finding).
- [ ] `task check:ts` exits 0; run `npx vitest run frontend/app/view/agents/diffcommentmodel.test.ts frontend/app/view/agents/diffoptions.test.ts`. Commit.

### Task 4: Send bar, badges, bindings and docs
**Depends on:** Task 2 (uses `resolveRecipient`, `sendBarText`, `sendBatch`, `tauriCommentSendIO`, `buildCommentPrompt`), Task 3 (uses `commentOnSelection`, the DOM contract and the `diff-comments` scenario it adds)
**Files:** `frontend/app/view/agents/commentsendbar.tsx`, `frontend/app/view/agents/filessurface.tsx`, `frontend/app/view/agents/changedfilelist.tsx`, `frontend/app/store/keybindings/bindings.ts`, `frontend/app/store/keybindings/bindings.test.ts`, `docs/keyboard-shortcuts.md`, `docs/diff-tab.md`, `scripts/cdp/scenarios.mjs`

Decisions are the spec's "Recipient", "Send" and "Counts" bullets; the boards are `SendBar.dc.html` (every state)
and `Main.dc.html` (badges and bar in place).

- [ ] `commentsendbar.tsx`, rendered under `DiffPane` in the surface's third column whenever a source is published:
  reads the active batch, gathers `RecipientFacts` (roster entry from `model.agentsAtom`, the run from
  `WOS.getWaveObjectAtom<Run>`, the project path from `projectListAtom`, `folderExists` from `io.exists` in an
  effect keyed on the stored cwd), and draws with `sendBarText`: the hint when empty, the sent note while
  `sentNoteAtom` holds one, the error line with "Send again" after a failure, Discard (`discardBatch`) and Send.
  Send is disabled for `wait` and while sending. DOM: `[data-comment-send-bar]` with `data-recipient-kind`,
  `[data-comment-send]`, `[data-comment-discard]`, `[data-comment-sent-note]`, `[data-comment-error]`,
  `[data-comment-hint]`. The bar shows the stored batch for the published source's key even when the source has no
  cwd (an ended agent). The bar registers its send for Shift+Enter the way Task 3 registers `commentOnSelection`.
- [ ] `changedfilelist.tsx`: a count badge `[data-changed-file-comments]` from `countsByPath` on each row with
  comments (title "1 pending comment" / "N pending comments").
- [ ] `bindings.ts`: `files:comment` (`m`, `commentOnSelection`) and `files:send-comments` (`Shift:Enter`), both
  gated like the other `files:` keys, declining (false) when there is nothing to act on; tests in
  `bindings.test.ts` that each declines with no editor / no batch and fires through its registered handler.
  Document both in `docs/keyboard-shortcuts.md` (### Diff) and the feature in `docs/diff-tab.md` (a section on
  comments, plus the keyboard and "what it cannot do" sections).
- [ ] Extend scenario `diff-comments` with steps, each with a screenshot:
  7. before any comment the bar is the hint "Press m or click a line's + to comment for <source>";
  8. with comments on two files, the file list shows badges (title "2 pending comments" on `src/retry/policy.go`,
     "1 pending comment" on `src/retry/legacy.go`) and the bar reads "3 comments in 2 files, to a new agent in
     <project>" (project source; Main board);
  9. a live roster agent whose cwd is the temp repo (a shell tab made an agent by the status report
     `scripts/inject-live-agents.mjs` sends with `wsh agentstatus`; see `openCanvasTerminal` for the tab) is picked as
     the source, and the board's three comments are added on it: `src/retry/policy.go` line 4, lines 7-9, and
     `src/retry/legacy.go` removed lines 1-3 in split view.
     9a. with the agent reported `working`, the bar reads "3 comments in 2 files, to <name>" and "working, joins its
     turn" (SendBar board, first state; Main board's bar);
     9b. with it reported idle, the detail reads "at its prompt" (Composer board's bar);
     9c. with `wshRpcCall` wrapped to reject `agentprompt` once, Send shows `[data-comment-error]` reading "Couldn't
     send to <name>: …" with "Send again", and the cards and count stay;
     9d. with it wrapped to record and resolve (never forwarding, so nothing is typed into the shell), Shift+Enter
     sends exactly one `agentprompt`, the cards leave, and "Sent 3 comments to <name>" shows. The recorded text must
     equal, line for line, the Prompt board's string written out literally in the scenario (not built with
     `buildCommentPrompt`), with only the pair label and the notes taken from the arranged repo: "Review comments on
     your changes (<pair>), 3 comments:", "src/retry/policy.go:4", "> return 8" (trimmed), the note,
     "src/retry/policy.go:7-9", "> func Floor() int {", the note, "src/retry/legacy.go: removed lines 1-3 of <ref>",
     "> package retry", the note, and "Line numbers are the file as shown in the diff. Address each comment, then say
     which you changed." Write the recorded text to `cdp-shots/diff-comments-prompt.txt` and into the step's detail,
     since nothing in the app draws the agent's terminal.
  10. with a comment added on that agent and its tab then closed (the surface keeps the agent source, now with no
      resolvable cwd), the bar still shows the stored batch and reads "<name> has ended · to a new agent in
      <name>'s folder";
  11. a run source that has not landed (arranged like `diff-review-marks-run`) shows "run <id8> hasn't landed; send
      once it does" with Send disabled.
  Never press Send for a new-agent recipient in the scenario: it would launch Claude Code.
- [ ] `task check:ts` exits 0; `npx vitest run frontend/app/store/keybindings/bindings.test.ts` passes. Commit.
