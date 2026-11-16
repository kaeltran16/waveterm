# Rendered box: slash commands, @ mentions and ! bash mode

Chunks 9, 11 and 12 of initiative `effort:f283ad11-bcef-4053-b3f8-cda2e04998a2` (Rendered view: chat-renderer
parity). The typing box of the Claude Rendered view (`frontend/app/view/agents/renderedcomposer.tsx`, hosted by
`renderedview.tsx`, state rules in `renderedmode.ts`) gains the three inputs Claude Code's own box has: a `/`
command panel, an `@` file picker whose picks draw as pills, and a `!` bash mode whose output shows as a card in
the transcript.

Reference: the fork `ttqteo/arcterm` (clone at `C:/Users/kael02/scratch/arcterm`), files
`frontend/app/view/agents/{slashcommands.ts,slashmenu.tsx,filementiontokens.ts,filemention.tsx,chatbash.ts}`,
`pkg/claudecmds/live.go`, `claude/arc-mod/hooks/commands-core.ts`. Port behaviour, not look (chunk 7: the visual
direction stays ours per `DESIGN.md`). Not ported: the fork's In-Chat command group and local cards, bash ghost
text and Tab completion, `!` history, sleeping-agent bash runs, the Lexical editor, pills in the sent bubble.

## Facts this design rests on

- **`$.prompt.submit` sends text to the model.** The mod engine's own message for it (Claude Code 2.1.325
  binary): "submits a prompt to the model; a text beginning with / would run a command as the user". A `!cmd`
  sent through `AgentPromptCommand` (which hands it to the mod's stream when one is held) therefore reaches the
  model as a prompt, not the shell.
- **Typing `!`, then a bracketed paste of the command, then Enter into the pty runs Claude Code's bash mode.**
  Probed 2026-11-16 against Claude Code 2.1.325 through `@lydell/node-pty` (`C:/Users/kael02/scratch/bashprobe/probe.cjs`):
  the screen showed `! echo arcprobe-$((40+2))` then `⎿ arcprobe-42`, and the transcript got two user records,
  `"<bash-input>echo arcprobe-$((40+2))</bash-input>"` then
  `"<bash-stdout>arcprobe-42</bash-stdout><bash-stderr></bash-stderr>"` (both `message.content` strings).
  Real transcripts carry the same shape (4 sessions under `~/.claude/projects`, versions 2.1.304 and 2.1.311);
  the input may keep a leading space (`<bash-input> gh auth switch ...`).
- **Today the projection draws both bash records as user bubbles with their raw tags**
  (`transcriptprojection.ts`, the string-content branch of user records).
- **The session's command list is only known to the running session.** Claude Code's typeahead list
  (`$.command.list()` in the mod API: built-ins, bundled skills, a mod's commands, plugin commands, MCP prompts)
  is not on disk. The fork has the arc mod publish it per agent block (`wsh claudecmds set`, stdin JSON) at
  `session.start` and again 10 s later (MCP servers connect after start), and wavesrv keeps it in memory
  (`pkg/claudecmds/live.go`).
- **The file list already exists.** `loadFileIndex(path)` (`frontend/app/view/code/codestore.ts`) wraps
  `GitListFilesCommand` with `allowplain`, cached per path, and `rankPaths(query, paths, limit)`
  (`frontend/app/view/code/codefinder.ts`) ranks them. `git ls-files` run in a repo subfolder lists paths
  relative to that folder, which is what Claude Code's `@path` resolves against (its cwd).
- **The picker-flip list already exists.** `isPickerCommand(text)` in `renderedmode.ts` names the commands that
  open a full-screen picker in the TUI; sending one flips the agent to Terminal (`renderedview.tsx`
  `onSubmitText`).

## Decisions

### Shared suggestion panel

1. **One panel component serves `/` and `@`** (`composersuggest.tsx`, key rules in `composersuggestmodel.ts`):
   a list that opens above the box over the column, rows with optional group headers, the highlighted row kept in
   view, and a key line at its foot (`↑↓ move · Tab/Enter pick · Esc close`, then a right-aligned count or note).
   Two users justify the abstraction; the fork has the same split (`pickerlist.tsx`). It reveals with
   `PopoverReveal` (origin bottom) and takes the popover surface the new-agent modal's branch list uses
   (`bg-modalbg`, `border-edge-mid`, `shadow-popover`): no new tokens.
2. **Keys are box-local**, handled in the textarea's keydown before the box's own: ↑/↓ move and wrap, Tab or
   Enter picks (Shift+Enter stays a newline), Esc closes the panel and nothing else (no interrupt, no mode
   change). A closed-by-Esc panel stays closed until the caret leaves the word that opened it. A query with no
   match shows no panel, so Enter sends as before. None of these go in `bindings.ts`: they are not global.
3. Mouse: hover highlights, click picks; the textarea keeps focus.

### Chunk 9: slash command panel

4. **Source: the live list the arc mod publishes, with a built-in fallback.** Port the fork's live store
   (`pkg/claudecmds/live.go`: per-block, in memory, entries without a name dropped, description cut at 300
   characters, a list over 2000 entries refused), two wshrpc commands in `AgentCommands`
   (`SetClaudeLiveCommandsCommand`, `GetClaudeLiveCommandsCommand`), `wsh claudecmds set` reading the list as
   JSON on stdin (200 commands overrun Windows' 32 K command line), and the mod's publish at `session.start` plus
   one 10 s later, sending only when the list changed (`commands-core.ts` `commandsPayload`). The frontend asks
   for the list each time the panel opens, so a skill or MCP server added mid-session shows on the next `/`.
   With no live list (an agent whose mod predates this, or a wavesrv restart before the next publish) the panel
   shows the fork's copied built-ins (`BUILTIN_COMMANDS`, 2.1.319 names and descriptions) and its footer says so.
   **Not ported: the fork's disk scan** (`ListClaudeCommandsCommand`, 285 lines): every agent Arc starts loads
   the mod, so the fallback window is a wavesrv restart, and built-ins cover it. YAGNI until that window is seen
   to matter.
5. **Opens** when the text before the caret is a leading `/` and a command word with no space or `/`
   (`/^\/([^\s/]*)$/` on `text.slice(0, caret)`): a `/` anywhere else (`and/or`, a path) is text. Never in bash
   mode.
6. **Filter**: case-insensitive; name-prefix matches first, then names containing the query, each in the list's
   order. **Groups** in order Built-in, Skills (`user`), Plugins, MCP, empty ones dropped; a duplicate name keeps
   its first entry.
7. **Row**: `/name`, the description (truncated), the plugin's name as a small tag when it has one, and an
   **"opens in Terminal"** tag when `isPickerCommand("/" + name)` is true. That list is the single source of
   truth for both the tag and the flip; the fork's own `TUI_NAMES` list is not copied.
8. **Pick** replaces the leading `/word` with `/name ` and puts the caret after the space. **Enter** on a
   highlighted command whose name equals the typed query sends instead (the command is typed in full); Tab
   always completes.

### Chunk 11: @ file mention with pills

9. **Opens** when the caret sits in an `@word` that starts the text or follows whitespace, the word holding no
   whitespace and no second `@` (`@alice@x` and emails stay text). The query is the word after `@` up to the
   caret. Never in bash mode.
10. **Files**: `loadFileIndex(cwd)` with the agent's cwd from `resolveCwd(agent.transcriptPath, agent.blockId)`,
    ranked by `rankPaths(query, paths, 50)`, files only (Claude Code's own picker also offers folders; not needed
    for this chunk). While the index loads the panel shows "Loading files"; no cwd known shows "No working
    folder known for this agent"; a truncated index says so in the footer. A failed load shows the error in the
    panel note, not a toast (it is a picker state, not a lost action).
11. **Pick** replaces `@query` with `@<path>` and one space; a path holding whitespace is written quoted,
    `@"<path>"`, the form Claude Code reads. The text is the single source of truth: what is sent is the text as
    it stands, so no compose step is needed.
12. **Pills without a rich editor.** The box stays a `<textarea>` (no Lexical: a new dependency and a rewrite of
    the shared composer hook for one view). Behind it sits a mirror layer with the same font, padding, width and
    wrapping that draws the text, each mention token as a pill (accent tint background, accent text, rounded,
    padding faked with a same-colour box-shadow so the text metrics do not move); the textarea's text is
    transparent with a visible caret, and the mirror follows its scroll. A token is a mention when it is
    `@` + a quoted path, or `@` + a non-space word that looks like a path (holds `/` or `\`, or ends in
    `.ext`); trailing `.,;:!?)]}'"` is not part of it (the fork's `mentionTokens` rule). **Backspace** with the
    caret at a pill's end, or right after the single space that follows it, deletes the whole token (and that
    space).

12a. **One `@` panel for agents and files** (added after the run, when main landed b18bca1e9's live-agent tag
    picker in the same box). `@` opens a single suggestion panel: a group of this project's live agents (main's
    `mentionmodel.ts` rows, tags and send block, unchanged) above a group of files (decisions 10-11). Agent rows
    show only while the query is a tag query (main's `mentionToken` matches); a path query (`/`, `.`, quotes)
    shows files only. A picked agent writes its tag and travels as main's trailing block; a picked file writes
    `@<path> ` and draws as a pill. One Esc-dismiss rule (decision 2) covers both.

### Chunk 12: ! bash mode and its output card

13. **Mode state, not text.** A `!` typed or pasted into an **empty** box turns bash mode on and the `!` itself
    is not kept (Claude Code consumes it the same way); a pasted `!cmd` keeps `cmd`. **Esc** (no panel open) or
    **Backspace on an empty box** turns it off. In bash mode Esc no longer interrupts; the Stop button still
    does. Sending leaves bash mode, as the TUI returns to prompt mode after a run.
14. **Cue**: the box shows a `! Bash` label at its start, the text in the mono face, the border in the accent
    colour, and the placeholder "Run a shell command; its output joins the transcript". The `/` and `@` panels
    and the attach button are off; attachments already in the tray stay for the next message and are not sent
    with the command.
15. **Send** goes through a new wshrpc command `AgentBashCommand {blockid, command}` that types into the pty
    what a person would: `!`, a pause of `agentask.KeystrokeDelay`, the command as a bracketed paste
    (`ESC[200~ … ESC[201~`), the same pause, then `\r`. It validates like `AgentPromptCommand`
    (`snapshotRefusesPrompt`) but requires a running shell (a held mod stream alone is not enough: the stream
    has no shell path), refuses a blank command, and returns after the writes so a failure reaches the
    composer's error toast. Known limit, accepted: `!` switches mode only on an empty TUI prompt, so text left in
    the Terminal view's own input would turn the command into a prompt; the Rendered view leaves that input
    empty.
16. Send in bash mode is allowed while the agent works (the TUI accepts it then too) and held while Claude's
    question is shown (`askBlocks`), as for any send.
17. **Projection**: a new entry kind `shell` in `AgentEntry` (its own kind so the merge with run d71b0df7, which
    also edits the projection, stays small; `bash` is already a step-detail kind): a user string record
    `<bash-input>X</bash-input>` pushes `{ kind: "shell", command: X.trim(), ts }`; the next
    `<bash-stdout>…</bash-stdout><bash-stderr>…</bash-stderr>` record fills `stdout` and `stderr` on the newest
    `shell` entry that has no output yet. Neither record is a user bubble any more. ANSI escapes are stripped
    from the output.
18. **Card**: the layout passes `shell` through as its own item (like `notification`: never folded into a
    "Worked for N" stretch, never a turn start). The card shows `!` and the command in mono, then stdout and
    stderr (stderr in the error colour), clamped to a few lines with a control that shows the rest, "running"
    while no output has landed, and "no output" when both are empty. It reuses the Bash step's output styling
    where that fits rather than a second look.
19. The phone page's projector bundle (`pkg/remotemode/web/static/projectors.js`) is regenerated from the
    projection (`node scripts/sync-remote-web.mjs`); the phone's renderer needs no card for this chunk.

## Verification

Each feature gets a step in `scripts/cdp/scenarios-agent-rendered.mjs` (fixtures in
`scripts/cdp/agent-page-fixtures.mjs`): the slash panel open and then filtered (live list published over the
`setclaudelivecommands` RPC for the agent's block, an "opens in Terminal" tag on a picker command), an `@` pick
drawing a pill in the box, bash mode on with its cue and a send typing `!`, the paste and `\r` into the pty
probe, and a transcript with bash records drawing the output card. Pure rules live in `*model.ts` files with
vitest beside them; the Go store and RPC have Go tests; the mod's payload builder keeps its vitest.

Not verifiable in Final's isolated app: a real Claude session publishing its list and running a `!` command
(no live claude there). The pty sequence is pinned by a Go test of the bytes written, and was probed by hand
above.
