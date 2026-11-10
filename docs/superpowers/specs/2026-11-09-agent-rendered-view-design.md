# Agent surface rendered mode — design

Date: 2026-11-09
Status: shipped 2026-11-10 (run e6887e42)
Scope: the Agent surface's center (`frontend/app/view/agents/`), the arc mod (`claude/arc-mod/`), the managed hook
list (`cmd/wsh/cmd/wshcmd-installhooks.go`)
Prototype: `.superpowers/design/agent-rendered-view/project/Main.dc.html`

## Intent

The Agent surface's center is the agent's live Claude Code terminal. A rendered mode opens it to ways of showing an
agent's work that a terminal cannot, a chart renderer for example. It is a second mode beside the terminal, not a
replacement: the terminal stays.

## Goals

- **Full drive.** Everything you do with an agent can be done from the rendered mode without the terminal, except
  the rare pickers listed under "Interactive screens", which flip to the terminal.
- **Rich renderers.** One registry of renderers, keyed by a fenced block's language (blocks the agent writes on
  purpose) or by tool name (tool output the agent already produces).
- **Switch in place.** A key and a header button flip the focused agent between Terminal and Rendered. No restart, no
  lost state.

## Non-goals

- No Settings default for the mode: every agent opens in the terminal (answer 5).
- No pi, Codex or opencode in the first build: the toggle shows on Claude Code agents only (answer 6). pi's timeline
  already renders, but pi has no control channel (`pi/extensions/` has ask and status, not agentctl).
- No headless runtime, Agent SDK sidecar or second claude process.
- No generic table renderer: real tables are under 1% of tool results (see "Evidence").

## Anti-goals

- The rendered mode must never drift from the terminal's session: both modes are views of one process.
- A renderer must never hide what the agent produced: every renderer falls back to the raw text when its parse
  fails, and a chart card shows its raw spec on demand.

## How it drives the agent: hooks over the live TUI

One claude process runs in the pty, as today, and both modes view it (answer 3, the judge's pick).

- **Reading:** the rendered mode reads the live transcript through `livetranscript.ts`
  (`StreamAgentTranscriptCommand`, projected by `transcriptregistry.ts`) into `NarrationTimeline`, the same path
  `EndedTranscript` and the Sessions detail use.
- **Sending:** prompts go through `AgentComposer` (`sendAgentText`) or the arc mod's control channel
  (`control-core.ts`: submit, steer, command, compact over `wsh agentctl`).
- **Answering:** structured asks keep using `AnswerBar`. Their hook (`wsh ask`, no `--wait`) does not block: it projects the
  ask into the cockpit, Claude's own picker stays open in the terminal, and `pkg/agentask/deliver.go` answers it by
  typing keys into the pty. Permission prompts work the same way (builder question 1).
- Switching modes is a view change only: the terminal block stays mounted, as it already does off-screen.

Known limit, accepted: the rendered view reads the transcript file, so it lags the terminal's screen slightly.

## Interactive screens

- **Native:** `/model` and the permission mode, as two controls in the agent header (answer 7).
- **Permission prompts:** docked as a band between the timeline and the composer until answered, showing the request,
  a diff or command preview, and Claude's own choices for that prompt (for an edit: yes, yes and allow edits this
  session, no and tell Claude what to do). The
  timeline keeps a row saying what was allowed (answer 9).
  - **Delivery (builder question 1):** a non-blocking hook projects the request; the band types the answer into
    Claude's own prompt in the pty, as `pkg/agentask/deliver.go` does for asks. Claude's prompt stays the source of
    truth, so Terminal mode works unchanged and Arc being down never stalls an agent. Accepted cost: keystroke encoding
    tracks Claude Code's prompt layout.
  - **Agent's call:** the band shows in the rendered mode only; Terminal mode keeps Claude's own prompt, and attention
    keeps today's waiting state (the `permission_prompt` Notification in `wshcmd-agenthook.go`).
  - Run workers and dag children launch with `--dangerously-skip-permissions` (`pkg/jarvis/runexec.go`), so they never
    raise permission prompts.
- **Any other picker** (`/config`, `/resume`, `/rewind`, ...): sending it flips the agent to the terminal until the
  picker closes, then back to Rendered.

## Renderers

One registry keyed by block language or tool name (answer 4). A renderer that cannot parse its input renders the raw
text the timeline shows today.

First build (answer 10):

| Key | Source | Draws |
|---|---|---|
| `chart` block | the agent writes a ```` ```chart ```` fenced block | a chart card (below) |
| Bash `git diff` / `git show` output | tool output | the existing edit diff view (`narrationtimeline.tsx`'s edit detail) |
| Bash `go test` / `vitest` output | tool output | pass / fail / skip counts with each failure listed (package, test, message, file:line); passing lines folded |
| images | tool output (image content items) | the image inline |

### Chart

Arc's own JSON spec in a ```` ```chart ```` block, drawn with visx (answer 8, the judge's pick).

- Types: bar, line, area, scatter; series; axes.
- Drawn like `dailychart.tsx`: visx scales and axes, `motion` for marks, colors from the `@theme` tokens so runtime
  themes apply.
- The card has a title, and a `spec` toggle that shows the raw block.
- Agents learn the format from an arc skill (`skills/`).
- Lines and areas are straight-segment SVG paths built by hand: no shape helper is added (`@visx/shape` is only a
  transitive install, and declaring it would change `package.json` for a single use).

## What it looks like

See the prototype board `Main.dc.html`. `Inline.dc.html` in the same folder is the rejected inline placement of the
permission band (answer 9 chose docked); it is not built.

- The rendered mode takes the terminal's place in the Agent surface center.
- The agent header gains a Terminal / Rendered toggle and the model and permission-mode controls.
- The body is `NarrationTimeline` at a readable width (about 920px): your messages as bubbles, prose as markdown, tool
  calls as rows. Renderers sit inline: tool output renderers under their tool row, chart cards in the prose.
- `AgentComposer` sits at the bottom, with a hint line for Esc to interrupt and `/` for commands. The permission band
  docks above it.

## Evidence

A scan of 5,212 Claude Code transcripts from the 30 days to 2026-11-10 (173,179 tool results, 504M chars):

- Unified diffs: 2.8% of results, 9.4% of output chars; `git diff`/`git show` ran 11,990 times, p90 output about 15k
  chars.
- Test output: `go test` 5,019 runs, `vitest` 3,992; small output (median about 550 chars).
- Images: 2.1% of results.
- Tables: the heuristic flagged 4.0%, but only about 5 of 40 sampled hits were real tables.
- Plain text (source dumps, grep): 83% of results, 71% of chars.

## What exists to build on

- `agentsurface.tsx`: the center mounts the live terminal; `EndedTranscript` already shows a done worker as narration.
- `livetranscript.ts`, `transcriptregistry.ts`, `narrationtimeline.tsx`: the read path.
- `markdownmessage.tsx`: remark-gfm; every fenced block goes through one handler by its language, which is where the
  block-language side of the registry plugs in.
- `agentcomposer.tsx`, `agentsend.ts`: sending text into the live terminal block.
- `answerbar.tsx`, `askflow.ts`: the docked ask band and its keyboard flow.
- `claude/arc-mod/hooks/control-core.ts`, `register.ts`: the control channel.
- `cmd/wsh/cmd/wshcmd-installhooks.go`: the managed hooks, including the non-blocking `AskUserQuestion` projection.
- `pkg/agentask/deliver.go`: answers a Claude picker by keystrokes into the pty.
- `dailychart.tsx`: the house visx chart.

## Left to the builder

- The toggle key (`v` in the mockup) and its entry in `frontend/app/store/keybindings/bindings.ts`, and its row in
  `docs/keyboard-shortcuts.md`.
- The permission projection: which Claude Code hook event carries the request with its tool input, its wshrpc path
  (modelled on `wsh ask`), and the keystroke encoding of each choice (modelled on `pkg/agentask/deliver.go`).
- How the rendered mode knows a picker it flipped to has closed (the next hook event or prompt is the likely signal),
  and flips back.
- How `/model` and the permission mode are set natively (a slash command through the control channel, or a mod call).
- The chart spec schema and the arc skill that teaches it.
- Whether plan approval (`ExitPlanMode`) uses the permission dock (likely yes).
- Interrupt from the composer (Esc).
- The registry's shape and where it lives beside `markdownmessage.tsx` and `narrationtimeline.tsx`.
- A CDP scenario that shows the rendered mode, the permission band and each first-build renderer.
