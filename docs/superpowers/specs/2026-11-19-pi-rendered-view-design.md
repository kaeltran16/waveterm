# Pi in the transcript renderer

## Intent

A pi agent, interactive or a run worker, should be shown and driven through the Rendered view the way a Claude
Code agent is, instead of always falling back to its terminal. Its transcript rows should read as well as
Claude's wherever transcripts show.

Why: the Rendered view and the transcript census fixes were built for Claude only. Pi agents keep a raw
terminal, and their rows in the read-only timelines (roster row, lead card, Sessions, ended workers) are
rougher than Claude's.

## Goals

- Live pi agents open in the Rendered view with the box, steer, stop, `!` bash mode and the `/` panel.
- Pi transcript rows match Claude's level of polish everywhere the timeline draws them.

## Non-goals

- Changing how Claude agents render or are driven.
- Running pi in RPC mode or hosting it in-process: pi keeps its TUI in a pty block like every Arc agent.
- A held control stream for Arc's own messages to pi; those stay typed.
- A `!!` option in the box.

## Anti-goals

- A pi box that looks like it sent something it did not: a refused send reports as it does for Claude.
- A `/` panel that offers commands pi does not have.

## Constraints

- Pi's TUI accepts Enter while it works as a steer, Escape as abort, and `!cmd` / `!!cmd` as user shell
  commands, which persist as `bashExecution` messages (command, output, exit code, cancelled, truncated,
  excludeFromContext).
- `pi.getCommands()` lists extension commands, prompt templates and skills, but not pi's built-ins.
- Pi has no permission prompt; an extension can block a tool call with a reason, recorded exactly like a
  tool that threw.
- Pi's Escape while it works aborts the turn and moves queued steers back into its own editor, unsent.

## Decisions

**Which agents open in Rendered.** Every live pi agent with a terminal block, interactive or a run worker,
follows the same Settings default and per-agent toggle as Claude. Ended workers and the Final stage stay
excluded, as for Claude. Why: parity was the ask; a separate pi default would be an unasked setting.

**How the box drives pi.** The box types into pi's editor through the paths Claude's box already uses: a
prompt; a steer while pi works (pi queues Enter mid-turn as a steer); Esc to stop; `!cmd` for bash mode. Why:
these paths already accept pi, and pi's editor handles each natively, so no new control channel is needed.

Stop on a pi agent with queued steers sends them at once, as Claude does: Esc aborts the turn, pi puts the
queued lines back in its editor, and Arc presses Enter once the abort settles, so the queued foot's "Esc to stop
and send now" stays true for pi. Why: pi and Claude agents behave the same in Rendered.

Esc from the box reaches pi whenever the box sends it, as for Claude. Why: pi follows Claude's current
behavior, with no pi-only rules.

A send pi refuses inside its own TUI (a `!` while another `!` still runs) is a known limit. Why: the backend
reports only the refusals it can see, as for Claude's non-empty-prompt `!` limit. A pi agent that has not
reported its first status stays in its terminal, since Rendered needs the reported harness.

**The `/` panel.** An Arc pi extension publishes `pi.getCommands()` into the per-block command store the
panel reads for Claude. For a pi agent the panel lists the published commands plus pi's built-ins with pi's
own descriptions: /settings, /model, /thinking, /scoped-models, /login, /logout, /new, /resume, /name,
/session, /tree, /fork, /clone, /compact, /import, /copy, /export, /share, /trust, /bug, /reload, /hotkeys,
/changelog, /quit (the `BUILTIN_SLASH_COMMANDS` of the installed pi 1.5.2, which has no /mcp; an extension's /mcp
arrives through the published list). Before anything is published it shows the built-ins alone. Why: the
runtime list catches extension commands that reading pi's folders would miss.

**Picker commands.** The pi commands that open a full-screen picker in pi's TUI flip the agent to its terminal
until its next prompt boundary, the same flip Claude has. /model, /thinking and /login with an argument switch
without a picker. One pi list feeds both the panel's built-ins and the picker check. Why: a picker only exists
in the TUI.

**`!` commands.** Bash mode types `!cmd` into pi, so the output joins pi's context. Every user-run `!` and `!!`
command in a pi transcript, from the box or typed in the terminal, draws as a command row with its command,
output, exit code, and a cancelled or truncated mark; a `!!` row says it was kept out of the model's context.
Why: without these rows a command run from the box leaves nothing in the transcript.

**Pi rows at Claude's level.** The pi projector gets every census fix its records can carry: unmapped tool
names (extension and MCP tools) as readable verbs; a tool error trimmed to its message; results cleaned of ANSI
escapes and progress redraws; a failed edit with no diff; a bash row with its real exit code instead of 1 for
any error. A call an extension blocked draws as a failed call whose error is the block's reason, with no
refused mark, because pi writes a block and a thrown error the same way. Claude-only fixes (its
permission-prompt refusal words, its harness lines, its compaction note) do not apply. Why: only the record
shapes pi writes need handling.

**The rest of the Rendered view.** A pi agent's ask docks as a card in its column through the existing pi ask
path. A brainstorm in a pi agent shows inline and its answer lines reach pi typed. The context ring reads pi's
reported usage. The Workspace pane and changes row behave as for Claude. When /new, /resume, /fork or /clone
moves pi to another session file, the view follows the new transcript. Why: these are the pieces a pi user
would notice missing.

## Left to the builder

- Which pi built-ins actually open a full-screen picker, checked against the installed pi's TUI.
- How the view learns of a session switch (the pi status extension already reports `session_info_changed`).
- Whether the command publisher joins the existing pi status extension or is its own extension file,
  installed by `wsh install-agent-hooks`.
- Where pi's built-in list lives so the `/` panel and the picker check share it.
- The UI scenario that shows a pi agent in Rendered, with a `!` row and the `/` panel.
- The signal that pi's abort has settled before Arc presses Enter after a Stop.
