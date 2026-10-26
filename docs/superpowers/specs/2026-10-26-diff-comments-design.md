# Diff comments to the agent

Date: 2026-10-26. Status: design, from the brainstorm `.superpowers/brainstorm/diff-comments/` (answers 1-4).
Mockup: `.superpowers/design/diff-comments/project/` (Main, Composer, SendBar, Prompt).

## Problem

Reviewing an agent's changes on the Diff surface (surface key `files`) ends in its terminal: you switch to the
Agent surface and retype the file, the line and what is wrong with it. The Diff surface already shows exactly
which lines you mean; it has no way to hand them to the agent.

## Outcome

Mark lines or hunks with a comment while reviewing, and send the batch to the agent that made the changes, as one
prompt that names each file and line, quotes the code, and carries your note.

## Scope

- Only the Diff surface. It stays read-only toward git: no staging, commit or revert. A comment only ever becomes a
  prompt to an agent.
- The surface unmounts on switch, so pending comments live in a module-level, per-source jotai atom, not in
  component state.

## Adding a comment

Board: `Composer.dc.html`.

Hovering a line in the diff shows a + in its gutter. Clicking it, or selecting lines and pressing `m`, opens a draft
card under the last line ("Comment on lines 7-9"). Ctrl+Enter adds the comment, Esc cancels. A comment anchors to
one line or a range. Changed and context lines on the right side are commentable in both views. Removed lines are
commentable in split view only, on the left side (named against the left side's ref): in unified view Monaco draws
them as view zones with no gutter, selection or original editor (`renderSideBySide: false`, `diffoptions.ts`). There,
a hunk with only removed lines shows a hint to switch to split (Shift+D) to comment on them (builder question 2). A
hunk is commented by selecting its lines.

`m` is free on the Diff surface today (only the Agent canvas binds it).

## Pending comments

Board: `Main.dc.html`.

Each added comment stays as a card under its lines, marked pending, with edit and delete. The changed-file list shows
a comment count on each file that has some. A send bar under the diff pane counts them ("3 comments in 2 files, to
loom") with Discard and Send (Shift+Enter).

## Where pending comments live

One batch per source (agent, run or project), keyed like `originKey`: every range and commit you comment on adds to
the same batch, and the batch persists across restarts in localStorage, like review marks (`reviewmarks.ts`). Each
comment carries its own anchor: file, side, the refs of the pair it was made on, line range, and the quoted text. A
card shows only on the pair it was made on; the rest are counted in the send bar.

## Who receives them

- **Agent source, agent live (with an Arc terminal block, not started by a run):** the batch goes to that agent through `AgentPromptCommand` (its mod runs it, else it
  is pasted and submitted). A mid-turn agent takes it after its turn; the bar says "working, joins its turn".
- **Project source:** Send starts a new Claude Code agent through `launchAgent`, in the project's path, with the
  batch as its first prompt. `launchAgent` focuses it and switches to the Agent surface.
- **Run source (builder question 1):** once the run has landed, the same, in the project's path: the run merged
  there, and its landing tree is gone (`removeLandedTree` deletes it without clearing `landpath`, so `runTree` is not
  used). While the run is running or held before land, Send is disabled and the bar says the run hasn't landed; the
  batch is kept. A new agent editing the landing tree would make `landingTreeHold` refuse the land.
- **Agent source whose agent has ended:** the same as a run or project source: a fresh Claude Code agent in that
  agent's folder, the batch as its first prompt. No resume. (Agent's call) When that folder no longer exists (a
  removed worktree), the new agent starts in its project's registered path; with no registered project, Send is
  disabled and the bar says the folder is gone.
- (Agent's call) A live agent with no Arc terminal block (reported from a terminal outside Arc) cannot take
  `AgentPromptCommand`, so it is treated like an ended agent.
- (Agent's call) An agent a run started (`RunId` set) is treated as its run's source, since its tree belongs to the
  run and edits there can be lost or block the land.

## What the agent receives

Board: `Prompt.dc.html`.

One multi-line prompt. It opens with what was reviewed and how many comments, then per comment its file and line or
range (a removed line named against the left side's ref), the commented line quoted, and the note. It ends asking
the agent to address each comment and say which it changed. Quoting the line lets the agent re-find the spot after
its line numbers move.

Multi-line is safe on both paths: `SendToSession` delivers through the mod's stream or as one bracketed paste
(`pkg/orchestrate/wake.go`), and `launchAgent` passes the task as a single argv (`launch.ts`). The one-line rule in
`codehandoff.ts` is for `ControllerInputCommand` and does not apply.

## Sending

Board: `SendBar.dc.html`.

The send bar names who gets the batch: a live agent, or "a new agent" and its folder. For a run that has not
landed, Send is disabled with the reason. Send to a live agent clears the
batch from the diff and leaves a "Sent 3 comments to loom" note until the next comment. Send to a new agent launches
it and opens it on the Agent surface. As in `canvassend.ts`, every failure before the hand-off throws with what
failed, the batch stays, and the bar shows the error with Send again. `AgentPromptCommand` returns once the text is
handed over; a typing failure after that is only logged server-side, so "sent" means handed over. With no comments,
the bar is a one-line hint (`m`, or a line's +).

## What exists today

- Pane 3 is one Monaco diff editor (`diffpane.tsx`, `MonacoDiffViewer`); its pair comes from `diffPairAtom`
  (`diffcontentstore.ts`). Cards become Monaco view zones, the + a glyph-margin decoration.
- `AgentInfo` carries `RunId` and `ProjectPath`; the cockpit's agent list gives liveness.
- Runs open the Diff with a run source (run report, run sheet); agent cards and the details rail with an agent source.
- `.superpowers` is gitignored only in this repo, which is one reason the batch travels in the prompt and not as a
  file in the reviewed tree.

## Left to the builder

- Cards as Monaco view zones in the modified editor (the original editor for removed lines, split view only), the + as
  a glyph-margin decoration.
- The storage key per source and pruning of old sources, after `reviewmarks.ts` (`MAX_REVIEW_SUBJECTS`).
- When the file changes under a pending comment (the agent keeps working), re-find the line by its quoted text; a
  comment whose text is gone stays in the batch, counted in the send bar and sent with its original line and quote.
- The prompt's exact wording, and how a comment made on a commit or a comparison names its refs.
- The folder of an ended agent (its last known cwd), and how the surface learns a run has landed.
- A pure model with vitest beside each store (no render tests); the `m` and Shift+Enter bindings in
  `buildFilesBindings` and `docs/keyboard-shortcuts.md`; `docs/diff-tab.md` updated; a CDP scenario that adds a
  comment and shows the send bar.

## Builder decisions

Made by the run's lead (autonomous run, 2026-10-26), each with why.

- **Frontend only.** `AgentPromptCommand` and `launchAgent` already carry a multi-line prompt, and a run's land state
  is on the `run:<id>` WaveObj (`land.state`), so no RPC, Go type or migration changes. Why: every fact the feature
  needs is already on the wire.
- **Storage.** One localStorage key, `diff.comments.pending`, holding `Record<originKey, CommentBatch>`; parsed
  entry by entry and pruned to the 50 most recently touched batches (`MAX_COMMENT_BATCHES`), the same shape and
  failure handling as `reviewmarks.ts`. Why: one mechanism for the surface's persisted state; 50 because a batch is
  held until sent, and a source nobody sent to in its last 50 neighbours is abandoned.
- **What a batch remembers about its source.** Besides its comments, a batch stores the source as it was at the
  last comment: kind, label, the resolved working directory (`filesStateAtom.cwd`), and for an agent its id, name,
  project name and `runId`. Why: an ended agent is gone from the roster, and the batch must still name its folder,
  its project and whether a run started it after a restart. The agent's last known cwd is this stored directory.
  A source whose cwd no longer resolves (an ended agent) still publishes its key, and the send bar reads the stored
  batch; a comment added later keeps the stored cwd, project and run.
- **The anchor's pair.** `DiffPair` gains `refs: DiffPairRefs` (set by `loadDiffPair`), and a comment stores those
  refs; `pairKey(refs)` (their JSON) decides which comments draw as cards on the open pair. Why: the selection that
  produced the pair is surface state the pane does not see; the refs are exactly "the pair it was made on".
- **The quote.** A comment stores its range's lines (at most 40, `MAX_QUOTE_LINES`) from its side's text. The
  prompt quotes the range's first non-blank line (the Prompt board's form). Why: the full block is what re-finding
  matches against; one line is enough for the agent to find the spot.
- **Re-finding.** On every load of the open pair, each comment on that path and pair is checked against its side's
  text: if its quoted lines are no longer at its range, the nearest exact match of the quoted block moves it; with
  no match it is marked `lost`, is not drawn, stays counted, and is sent with its original lines and quote. A lost
  comment whose text comes back is found again. Nothing is written when nothing moved, since the working-tree poll
  reloads the pair every few seconds.
- **Monaco.** The + is a glyph-margin decoration on the hovered line (`glyphMargin: true` in `paneOptions`); a
  click on it, or `m` with a selection, opens the draft. Cards (draft and pending) are React portals into view
  zones under the range's last line, in the modified editor, or the original editor for removed lines in split
  view. The card root stops keydown and mousedown propagation so Monaco neither steals focus from its textarea nor
  runs editor commands on what is typed. Adding or cancelling returns focus to the surface, so `Shift+Enter` and
  the other surface keys work next. Why: the spec's own choice of view zones and glyph decorations, with the two
  known Monaco traps closed.
- **`m` has two routes.** With focus on the surface, `files:comment` in `buildFilesBindings` comments on the
  modified editor's current selection (its cursor line when the selection is empty). With focus in the diff editor
  (where the dispatcher lets every key through), a Monaco command on each editor, precondition `editorTextFocus`,
  does the same for that editor. Both call one function the pane registers, as `diffnav.ts` does for hunk keys.
- **Unified view, removed-only hunks.** A one-line view zone under the hunk reads "Removed lines: switch to split
  (⇧D) to comment on them". Hunks mixing removed and added lines get no hint: their added side is commentable.
- **Recipient.** A pure `resolveRecipient(batch, facts)`:
  - agent source, the agent in the roster with a `blockId`, not `kind: "terminal"` and no `runId`: **live**, and
    "working, joins its turn" when its state is `working`, else "at its prompt" (the Composer board's bar). A plain terminal is never live: a prompt pasted into a
    shell would run as commands.
  - agent with a `runId` (stored on the batch): the run's rule below.
  - run: `land.state === "landed"`, or no landing tree (`!landpath`) and status `done`: a **new agent** in
    `run.projectpath`. Otherwise **wait**, with the reason: held ("run 3f9a21c4 is held before land: <reason>"),
    cancelled with a landing tree ("run 3f9a21c4 ended without landing"), else "run 3f9a21c4 hasn't landed; send
    once it does". The run is read from `WOS.getWaveObjectAtom<Run>("run:<id>")`, which updates live.
  - project: a **new agent** in the registered path for the project's name, falling back to the stored path.
  - ended or non-live agent: a **new agent** in the stored folder when it exists (checked with `FileInfoCommand`),
    else in its project's registered path, else **wait** with "the folder is gone".
- **The new agent** is Claude Code, `runtimeStartupCommand("claude")` with no extra flags, named after the
  project (or the folder's base name), the prompt as its task. Why: the spec says Claude Code; the launcher's
  defaults are the user's, not this feature's.
- **The prompt.** Header "Review comments on your changes (<pair>), N comments:" to a live agent, "Review comments
  on the changes in <label> (<pair>), N comments:" to a new one; `<pair>` is "worktree against <sha7>", "commit
  <sha7>" or "<base>..<head>". When the batch spans more than one pair the header drops it and each comment's
  location line ends "in <pair>". A location is `path:7` or `path:7-9`; a removed range is `path: removed lines
  1-3 of <left ref>`. Then the quoted line as "> …" and the note. It ends "Line numbers are the file as shown in the
  diff. Address each comment, then say which you changed." Two departures from the Prompt board: its
  "(changed line)" tag is dropped (the quote already shows the line, and telling changed from context lines needs a
  second record per comment), and so is "since session start" in the header (a comment records its pair's refs, not
  the range that produced them, and the pair label already names the anchor commit).
- **Send.** One `sendBatch(batch, recipient, io)` with an IO seam (`prompt`, `launch`, `exists`), as in
  `canvassend.ts`: each failing step throws `Couldn't send to <name>: …` or `Couldn't start an agent in <folder>: …`
  and the batch stays. On success the batch is cleared; a live send leaves "Sent N comments to <name>" (with its
  age) until the next comment on that source, in a module atom (not persisted).
- **Draft and edit.** The open draft lives in a module atom (a surface switch keeps it until reload). Edit turns a
  pending card into the same editor with Save (Ctrl+Enter) and Cancel (Esc).
- **Counts.** The file list's badge counts the batch's comments on that path across every pair, lost ones
  included; the send bar counts the whole batch ("3 comments in 2 files, to loom").
