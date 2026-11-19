# Pi in the transcript renderer

**Spec:** `docs/superpowers/specs/2026-11-19-pi-rendered-view-design.md`
**Verify:** `node scripts/verify.mjs ./cmd/wsh/cmd ./pkg/claudecmds`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs rendered-pi transcript-census-projection agent-rendered agent-queued`

A live pi agent opens in the Rendered view and is driven from its box the way a Claude agent is, and pi
transcript rows read at Claude's level wherever the timeline draws them. `agent-rendered` and `agent-queued` run in
Final as the Claude regression guard: this plan changes `renderedmode.ts`, the `/` panel and the queued foot that
both harnesses share, and the spec's non-goal is any change to how Claude renders.

## Decisions beyond the design

Checked against the installed pi, `@earendil-works/pi-coding-agent` 1.5.2 (`dist/core/slash-commands.js`,
`dist/modes/interactive/interactive-mode.js`, `docs/extensions.md`).

1. **Pi's built-in list.** It is pi 1.5.2's `BUILTIN_SLASH_COMMANDS` with pi's own descriptions: settings, model,
   tree, thinking, scoped-models, export, import, share, bug, copy, name, session, changelog, hotkeys, fork, clone,
   trust, login, logout, new, compact, resume, reload, quit. The spec listed /mcp, which this pi does not have, and
   left out /bug, which it has. The anti-goal (no command pi lacks) wins, so the spec's list was corrected to match.
   Why: an extension's /mcp still shows, through the published list.
2. **Which built-ins open a picker** (read from each handler): always /settings, /scoped-models, /resume, /fork,
   /tree, /trust, /logout, /import (a confirm), /bug (a selector); bare only /model, /thinking, /login (with an
   argument they switch without one, as the spec says). The rest print or act in place.
3. **One list, one module.** `frontend/app/view/agents/picommands.ts` holds the built-ins as `SlashCommand`
   entries, each marked with whether it opens a picker (always, or bare only), and the pi picker check derives from
   that list. `isPickerCommand` takes the harness and picks Claude's set or pi's. Why: the spec's "one pi list feeds
   both", and Claude's set stays where it is.
4. **The publisher joins the pi status extension** (`pi/extensions/waveterm-status.ts`), not a new file. Why: that
   extension is already installed each launch, already gated on `WAVETERM_BLOCKID` and holds the wsh path; a new
   file would add a Taskfile copy, an installer and an embed for one handler.
5. **How it publishes.** At `session_start` (every startup, /reload, /new, /resume, /fork and /clone fires one),
   it sends `pi.getCommands()` as JSON on stdin to `wsh claudecmds set`, through `node:child_process` since
   `pi.exec` has no stdin, and the list does not fit Windows' command line. Each entry is `{name, description,
   source}` with pi's own `source` (`extension`, `prompt`, `skill`). A failed publish is dropped like the
   extension's status reports: pi's TUI owns the terminal, and the panel's footer already says it shows built-ins
   only.
6. **The panel's groups for pi.** Built-in, then Extensions (`extension`), Prompts (`prompt`), Skills (`skill`).
   Two new sources and group titles; Claude's mod publishes neither, so Claude's panel is unchanged.
7. **Session switches.** The status extension reports `--ended` only when pi quits (`session_shutdown` reason
   `quit`), not on a /new, /resume, /fork, /clone or /reload replacement, whose `session_start` then reports the
   new session file. The view follows it through the existing path-change restart in `usecardstreams.ts`, and the
   stream already waits for a file not yet written.
8. **Pi's prompt boundary for the picker flip.** Pi reports no hook names, and its reports must not borrow
   Claude's: `AgentStatusData.Hook` drives the engine's wakes and the status dedupe in `wshserver.go`. So the
   frontend reads the boundary off pi's own state reports: one landing after the flip that is idle (a turn
   settled, a picker's choice applied, a new session), or working after a state that was not (a new prompt).
   A working report mid-turn (a tool start, a message end) is no boundary, as Claude's tool hooks are not.
9. **Which agents render.** `canRender` accepts `agent === "pi"` beside Claude, except a booting row (a pending
   launch, `booting: true`), which has not reported its harness. Claude's rule is unchanged.
10. **Pi's queued foot.** Pi does not write its steer queue to the transcript, so a pi agent's foot is the box's
    own sends (`sentPromptsAtom`) not yet answered by a pi user row with that text at or after the send, shown
    while the agent works. Pi's user entries carry the record's `ts` for this.
11. **Stop and send now, for pi.** With a non-empty foot, the Rendered view's Stop (the button and the box's Esc)
    types Esc, waits for the block's next idle state report after it, then types Enter once, so pi submits the
    steers it moved back into its editor. With no idle report within `PI_STOP_SETTLE_MS` (10 000) it types nothing
    and a warning toast says the queued messages stayed in pi's editor. With an empty foot, and for Claude, Stop
    stays the bare Esc.
12. **Shell rows.** The `shell` entry gains optional `exit`, `cancelled`, `truncated` and `excluded`; pi's
    `bashExecution` messages project to it. Claude's shell rows set none of them, so they draw as before.
13. **Bash exit codes.** Pi's bash tool ends a failed result with `Command exited with code N`: that is the row's
    exit, and the line leaves the output. A failed bash without it never produced an exit code (`Command aborted`,
    a timeout, an extension's block reason): its exit is null and that last paragraph is the call's error.
14. **Shared cleaning.** The ANSI and carriage-return redraw cleaning moves out of `transcriptprojection.ts` into
    `tooldetail.ts`, used by both projectors; Claude keeps its harness-line filter on top. `readableVerb` is reused
    from `transcriptprojection.ts`.

## Tasks

### Task 1: The pi extension publishes its commands and keeps a session switch live
**Depends on:** none
**Files:** `pi/extensions/waveterm-status.ts`, `pi/extensions/waveterm-status.test.ts`, `cmd/wsh/cmd/pi-status-extension.ts`, `cmd/wsh/cmd/pi-status-extension.test.ts`

**What to build:** the pi status extension publishes the session's `pi.getCommands()` into the agent block's
command store at each `session_start` (decision 5), and stops reporting `--ended` on a session replacement
(decision 7). Edit the authored file, then `task sync:piartifacts` refreshes the embed copy; commit both.

**Interfaces:** the published list is the JSON array `wsh claudecmds set` reads on stdin, each entry
`{name, description, source}` with `source` one of `extension`, `prompt`, `skill` (pi's own). Task 3 reads it.

**Acceptance:**
- At `session_start` the extension runs `wsh claudecmds set` once with the list on stdin: every command
  `pi.getCommands()` returns, in its order, name without a slash, description (empty when pi has none), pi's
  source. Outside an Arc block (`WAVETERM_BLOCKID` unset) nothing runs.
- A failing wsh does not throw out of the handler and writes nothing to pi's terminal.
- `session_shutdown` with reason `new`, `resume`, `fork` or `reload` reports no `--ended`; reason `quit` (or none)
  still does.
- A `session_start` with reason `new`, `resume` or `fork` reports the new session file as `--transcript`.
- `cmd/wsh/cmd/piartifact_test.go` passes (the embed copy matches the authored file).

### Task 2: Pi rows at Claude's level, and its `!` commands as rows
**Depends on:** none
**Files:** `frontend/app/view/agents/pitranscriptprojection.ts`, `frontend/app/view/agents/pitranscriptprojection.test.ts`, `frontend/app/view/agents/tooldetail.ts`, `frontend/app/view/agents/transcriptprojection.ts`, `frontend/app/view/agents/agentsviewmodel.ts`, `frontend/app/view/agents/transcriptlayout.ts`, `frontend/app/view/agents/narrationtimeline.tsx`, `frontend/app/view/agents/shellrunrow.tsx`, `frontend/app/view/agents/shellrunmodel.ts`, `frontend/app/view/agents/shellrunmodel.test.ts`, `scripts/cdp/transcript-fixture.mjs`, `scripts/cdp/scenarios-transcript-census-projection.mjs`

**What to build:** the pi projector gets the census fixes its records can carry, and every `!` and `!!` command in
a pi transcript draws as a command row (decisions 12-14). The roster row, lead card, Sessions and ended workers
all draw through this projector, so they all change.

**Interfaces:**
- the `shell` AgentEntry (and its layout item) gains `exit?: number | null; cancelled?: boolean;
  truncated?: boolean; excluded?: boolean`; `ShellRunRow` takes the same as props.
- pi `user` entries carry `ts` (ms, from the record's `timestamp`). Task 4 relies on it.

**Acceptance:**
- An unmapped pi tool name (an extension tool, an MCP tool such as `mcp__docs__search_pages`) reads as
  `readableVerb`'s words; the mapped ones keep their verbs.
- A failed non-bash call's `error` is its message: a `Validation failed for tool` error stops before
  `Received arguments:`; an extension's block reason is the error as written, the outcome `fail`, never `blocked`
  or `declined`.
- Read, grep and bash results reach the row without ANSI escapes, each carriage-return-rewritten line at its last
  state.
- A failed edit or write has no diff detail.
- A bash call that exited non-zero shows that code (`Command exited with code 2` gives exit 2, and the status line
  is not in the output); one that succeeded shows 0; an aborted, timed-out or blocked one shows exit null with its
  last paragraph as the error.
- A `bashExecution` message projects to a `shell` entry with its command, output (ANSI-clean), exit code,
  `cancelled`, `truncated`, and `excluded` for `excludeFromContext`, at its place on the active branch; it never
  appears as a user bubble.
- The shell row draws a non-zero exit code, a cancelled mark and a truncated mark when set, and a `!!` row says it
  was kept out of the model's context. A Claude shell row (none of the fields set) draws as before.
- Scenario `transcript-census-projection` gains pi steps: raw pi records go through the tree's own
  `projectPiTranscript` in the page (a `projectPiInPage` beside `projectInPage`) and draw at both census hosts,
  showing an extension tool's readable verb, a bash row with exit 2, a failed edit with no +/- counts, a `!` row
  with exit code and a `!!` row with its out-of-context line.

### Task 3: Pi agents open in Rendered, with pi's `/` panel and picker flip
**Depends on:** none
**Files:** `frontend/app/view/agents/renderedmode.ts`, `frontend/app/view/agents/renderedmode.test.ts`, `frontend/app/view/agents/picommands.ts`, `frontend/app/view/agents/picommands.test.ts`, `frontend/app/view/agents/slashpanel.tsx`, `frontend/app/view/agents/slashpanelmodel.ts`, `frontend/app/view/agents/slashpanelmodel.test.ts`, `frontend/app/view/agents/renderedview.tsx`, `frontend/app/view/agents/renderedcomposer.tsx`, `frontend/app/view/agents/session-models/agentstatusstore.ts`, `frontend/app/view/agents/session-models/agentstatusstore.test.ts`, `docs/keyboard-shortcuts.md`, `scripts/cdp/scenarios-rendered-pi.mjs`, `scripts/cdp/scenarios.mjs`

**What to build:** every live pi agent with a terminal block follows the Settings default and the per-agent toggle
into Rendered (decision 9). Its box drives pi through the existing prompt, steer, Esc and `!` paths unchanged. Its
`/` panel lists pi's built-ins plus whatever the block published (decisions 1, 3, 6), and a pi picker command flips
it to the terminal until pi's next prompt boundary (decisions 2, 8). Claude-named copy in these views names the
agent's harness for a pi agent (the "Answer Claude's question first" notice, the panel's "opens in Terminal"
title, the `v` row in `docs/keyboard-shortcuts.md`). The ask card, brainstorm, context ring, Workspace pane and
changes row are harness-neutral already (the pi ask path, typed prompts, pi's `--usage` reports); this task makes
them reachable and the scenario shows the ask card and the ring.

**Interfaces:** `isPickerCommand(text: string, harness: string | undefined): boolean` (Claude's set for any harness
but `pi`); `PI_BUILTIN_COMMANDS: SlashCommand[]` in `picommands.ts`. Task 4 edits `renderedview.tsx` and
`scenarios-rendered-pi.mjs` after this task.

**Acceptance:**
- `canRender` is true for a live pi agent with a block, false for a booting pi row, an ended worker and the Final
  stage; codex and opencode stay false; Claude's results are unchanged.
- For a pi block the panel lists the built-ins of decision 1 with pi's descriptions plus the published commands,
  grouped Built-in, Extensions, Prompts, Skills; before any publish it lists the built-ins alone. A Claude block's
  panel is unchanged.
- The pi picker check is true for the always-picker commands with or without arguments and for bare /model,
  /thinking and /login, false for `/model anthropic/claude-opus-5-5` and the non-picker built-ins; Claude's
  check is unchanged.
- After a pi picker command the agent shows its terminal until a pi state report after the flip is idle, or
  working after a non-working state; a working report mid-turn keeps the terminal.
- Scenario `rendered-pi` (new, registered in `scripts/cdp/scenarios.mjs`): a pi agent backed by a real tab, its
  status reported with `agent: "pi"` and a pi v3 transcript, opens in Rendered with its transcript drawn and its
  context ring showing the reported percent; `/` opens the panel listing pi's built-ins with /settings marked as
  opening in Terminal and a published extension command under Extensions; sending `/settings` shows the terminal,
  and a pi idle report after it returns to Rendered; a bash-mode Run types `!`, the command and Enter into the
  block (read off the tab's key probe); an ask raised for the pi block docks as the card in its column.

### Task 4: Pi's queued foot, Stop and send now, and its `!` rows in Rendered
**Depends on:** Task 2 (uses pi user entries' `ts` and the `!` row), Task 3
**Files:** `frontend/app/view/agents/queuedprompts.ts`, `frontend/app/view/agents/queuedprompts.test.ts`, `frontend/app/view/agents/stopsend.ts`, `frontend/app/view/agents/stopsend.test.ts`, `frontend/app/view/agents/renderedview.tsx`, `scripts/cdp/scenarios-rendered-pi.mjs`

**What to build:** a pi agent's box sends wait in the queued foot until pi takes them (decision 10), and Stop with
a non-empty foot sends them at once, so the foot's "Esc to stop and send now" holds for pi (decision 11). The pure
rules (which sends wait; whether a stop presses Enter, when, and the timeout) live in `queuedprompts.ts` and
`stopsend.ts`; `renderedview.tsx` wires them.

**Acceptance:**
- A pi agent's box send made while it works shows in the foot until a pi user entry containing its text lands at
  or after the send; one the transcript never answers leaves the foot once the agent is idle. A Claude agent's foot
  is unchanged.
- Stop on a working pi agent with a non-empty foot types Esc, then Enter once after the block's next idle report;
  with no idle report within `PI_STOP_SETTLE_MS` it types nothing more and a warning toast says the queued messages
  stayed in pi's editor. Stop with an empty foot, and every Claude Stop, types the bare Esc.
- Scenario `rendered-pi` gains steps: a pi transcript's `!` command draws as a command row with its exit code in
  Rendered; a box send while the pi agent works shows in the foot with the "Esc to stop and send now" line; Stop
  types Esc into the block, and after a published idle report Enter (read off the tab's key probe), and the foot
  clears.
