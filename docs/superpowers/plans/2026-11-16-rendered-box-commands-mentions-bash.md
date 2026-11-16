# Rendered box: slash commands, @ mentions and ! bash mode

**Effort:** effort:f283ad11-bcef-4053-b3f8-cda2e04998a2
**Spec:** `docs/superpowers/specs/2026-11-16-rendered-box-commands-mentions-bash-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/... ./cmd/wsh/cmd`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && go vet ./pkg/wshrpc/... ./cmd/wsh/cmd`
**Final:** `node scripts/cdp/final-verify.mjs agent-rendered rendered-shell transcript-base narration-feed`

> **For agentic workers:** each task states its decisions, files, interfaces and acceptance; you write the
> implementation and pick the tests. The spec holds the facts and the why of every decision: read it first.

**Goal:** the Rendered view's typing box gets Claude Code's three inputs: a `/` command panel (chunk 9), an `@`
file picker whose picks draw as pills (chunk 11), and a `!` bash mode whose output shows as a card in the
transcript (chunk 12).

**Architecture:** the session's command list comes from the arc mod, published per block to an in-memory store
in wavesrv; files come from the Code surface's cached index; a `!` command is typed into the pty by a new RPC,
since the mod's prompt path sends text to the model. `/` and `@` share one suggestion panel. Bash records get
their own `shell` entry kind and card. Pure rules live in `*model.ts` files beside their tests; `.tsx` files stay
thin.

Rules for every task:
- Run d71b0df7 is editing `transcriptprojection.ts`, `transcriptlayout.ts`, `narrationtimeline.tsx`,
  `agentsviewmodel.ts`, `renderedview.tsx` and the two scenario files below. Touch those files only where your
  task says, add rather than restructure, and keep new code in new files where you can, so the land merges small.
- Colours from the `@theme` tokens in `frontend/tailwindsetup.css` only; no new tokens. UI follows `DESIGN.md`.
- Box-local keys stay in the composer component; nothing goes in `bindings.ts`.
- A task that writes scenario steps runs its scenario before it completes:
  `ARC_FINAL_OUT=<tmp dir> node scripts/cdp/final-verify.mjs agent-rendered` (never `task verify:ui`: a run tree
  has no dev app), and it passes. Append new steps after the existing composer steps; do not reorder others.
- Every line number in the spec and here is pre-edit.

### Task 1: Live command list and the bash RPC
**Depends on:** none
**Files:** `pkg/claudecmds/live.go`, `pkg/claudecmds/live_test.go`, `pkg/wshrpc/wshrpctypes_agents.go`, `pkg/wshrpc/wshserver/wshserver_claudecmds.go`, `pkg/wshrpc/wshserver/wshserver_agentmsg.go`, `pkg/wshrpc/wshserver/wshserver_agentmsg_test.go`, `cmd/wsh/cmd/wshcmd-claudecmds.go`, `claude/arc-mod/hooks/commands-core.ts`, `claude/arc-mod/hooks/commands-core.test.ts`, `claude/arc-mod/hooks/register.ts`, `cmd/wsh/cmd/claude-mod/hooks/commands-core.ts`, `cmd/wsh/cmd/claude-mod/hooks/register.ts`, `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`

**What to build:** the backend halves of chunks 9 and 12 (spec decisions 4 and 15).
- Port the fork's live store (`C:/Users/kael02/scratch/arcterm/pkg/claudecmds/live.go` and its test) as
  `pkg/claudecmds`: `SetLive(blockID, list)` / `GetLive(blockID)`, per block, in memory, the fork's limits.
- Two commands in `AgentCommands` (`wshrpctypes_agents.go`), served in a new `wshserver_claudecmds.go`.
- `wsh claudecmds set`: reads the JSON list on stdin and publishes it for `$WAVETERM_BLOCKID`; errors name the
  block and the cause.
- The arc mod publishes at `session.start` and once more 10 s later (`$.clock.after`, cancelled on a second
  `session.start`), only inside Arc (`active`), sending only when the payload changed, logging a failed call to
  debug without retrying on its own. Port the fork's `commands-core.ts` (`commandsPayload`, `claudecmdsArgs`)
  and the publish block of its `register.ts`. Read `docs/agents/claude-mods.md` first (mod traps, the
  validator), then `task sync:claudemod` and commit the copies.
- `AgentBashCommand`: validates (blank command refused; `snapshotRefusesPrompt`; the block must exist and have
  a running shell), then writes `!`, waits `agentask.KeystrokeDelay`, writes `ESC[200~<command>ESC[201~`, waits
  the same, writes `\r`, and returns after the writes. Route the writes through a package var (as
  `deliverAgentMessage` is) so a test can capture them.
- `task generate` for the bindings.

**Interfaces:**
```go
// pkg/wshrpc, in AgentCommands
SetClaudeLiveCommandsCommand(ctx context.Context, data CommandSetClaudeLiveCommandsData) error
GetClaudeLiveCommandsCommand(ctx context.Context, data CommandGetClaudeLiveCommandsData) ([]ClaudeCommandInfo, error)
AgentBashCommand(ctx context.Context, data CommandAgentBashData) error
type ClaudeCommandInfo struct { Name, Description, Source, Plugin string } // json: name, description, source ("builtin"|"user"|"plugin"|"mcp"), plugin,omitempty
type CommandSetClaudeLiveCommandsData struct { BlockId string; Commands []ClaudeCommandInfo } // json: blockid, commands
type CommandGetClaudeLiveCommandsData struct { BlockId string } // json: blockid
type CommandAgentBashData struct { BlockId string; Command string } // json: blockid, command
```
Wire names `setclaudelivecommands`, `getclaudelivecommands`, `agentbash`; frontend `RpcApi.GetClaudeLiveCommandsCommand`,
`RpcApi.SetClaudeLiveCommandsCommand`, `RpcApi.AgentBashCommand`. A block with no list answers an empty array.

**Acceptance:**
- Go: a set list reads back for its block and not another; a nameless entry is dropped; a long description is cut
  to 300 characters; a list over 2000 is refused; an empty block id is refused.
- Go: `AgentBashCommand` for `echo hi` writes exactly `!`, `\x1b[200~echo hi\x1b[201~`, `\r` in that order; a
  blank command and a block with no running shell are refused with an error and write nothing.
- vitest: `commandsPayload` is stable for the same list, keeps the given order and fixed field order, and keeps
  `plugin` only when non-empty.
- `task sync:claudemod` leaves no diff after the commit; `task generate` leaves no diff.

### Task 2: Shared suggestion panel
**Depends on:** none
**Files:** `frontend/app/view/agents/composersuggestmodel.ts`, `frontend/app/view/agents/composersuggestmodel.test.ts`, `frontend/app/view/agents/composersuggest.tsx`

**What to build:** the panel `/` and `@` both open above the Rendered box (spec decisions 1-3): rows with optional
group headers, a highlighted row kept scrolled into view, hover highlights, click picks without taking focus from
the textarea, a key line at the foot (`↑↓ move · Tab/Enter pick · Esc close`) with a right-aligned slot for a
count or note, and a note-only state (loading, empty, error) with no rows. It reveals with `PopoverReveal`
(origin bottom) on the branch-list popover surface of `newagentmodal.tsx`. The key rules are pure.

**Interfaces:**
```ts
// composersuggestmodel.ts
export type SuggestKeyResult = { move: number } | { pick: number } | { close: true } | null; // null: the box handles the key
export function suggestKey(key: { key: string; shiftKey: boolean; isComposing?: boolean }, at: number, count: number): SuggestKeyResult;
// a panel Esc closed stays closed while the word that opened it is still the one at the caret: `dismissedAt` is
// that word's start when Esc closed it, `wordAt` the start of the panel word at the caret now (null when none)
export function stillDismissed(dismissedAt: number | null, wordAt: number | null): boolean;
// composersuggest.tsx
export function ComposerSuggest<T>(props: {
    open: boolean; items: T[]; at: number; groups?: { title: string; start: number }[];
    itemKey: (t: T) => string; renderItem: (t: T, active: boolean) => ReactNode;
    onPick: (index: number) => void; onHover: (index: number) => void;
    note?: ReactNode; footer?: ReactNode; label: string; dataAttr: string; // e.g. "data-slash-panel"
}): JSX.Element;
```
The panel root carries `dataAttr`; each row carries `data-suggest-item` and `data-active` on the highlighted one.

**Acceptance:**
- `suggestKey`: ArrowDown/ArrowUp move and wrap at both ends; Tab and Enter pick the highlighted row; Shift+Enter,
  an IME composition and any key with zero rows return null; Escape closes.
- `stillDismissed`: true while `wordAt` equals `dismissedAt`; false once `wordAt` is null or another start, and
  when nothing was dismissed.
- No rendered caller yet; its look is shown by Task 4's scenario step.

### Task 3: Bash output card in the transcript
**Depends on:** none
**Files:** `frontend/app/view/agents/agentsviewmodel.ts`, `frontend/app/view/agents/transcriptprojection.ts`, `frontend/app/view/agents/transcriptprojection.test.ts`, `frontend/app/view/agents/transcriptlayout.ts`, `frontend/app/view/agents/transcriptlayout.test.ts`, `frontend/app/view/agents/narrationtimeline.tsx`, `frontend/app/view/agents/shellrunrow.tsx`, `pkg/remotemode/web/static/projectors.js`, `scripts/cdp/scenarios-agent-rendered.mjs`, `scripts/cdp/agent-page-fixtures.mjs`

**What to build:** spec decisions 17-19. A `!` command's records (`<bash-input>`, then
`<bash-stdout>…</bash-stdout><bash-stderr>…</bash-stderr>`, both user records with string content) project to one
`shell` entry and draw as a card in every NarrationTimeline, instead of two raw-tag user bubbles. The layout passes
it through as its own item (as it does `notification`). The card: `!` and the command in mono; stdout, then stderr
in the error colour, ANSI stripped (reuse an existing strip helper if one exists), clamped with a control to show
the rest; "running" until output lands; "no output" when both are empty. Reuse the Bash step's output styling
from `toolrenderers.tsx` where it fits. Regenerate the phone bundle with `node scripts/sync-remote-web.mjs`
(it is generated; on a merge conflict regenerate, never hand-merge).

**Interfaces:**
```ts
// AgentEntry, added
| { kind: "shell"; command: string; stdout?: string; stderr?: string; ts?: number }
// the layout item mirrors it with index
```
`stdout`/`stderr` undefined means no output record yet (running); empty strings mean it ran with no output.

**Acceptance:**
- Projection: input then output records give one `shell` entry with the trimmed command and both streams; an input
  with no output yet gives one entry with neither stream; two runs in a row each get their own output; output
  with no pending input adds nothing; neither record yields a `user` entry; a leading space in the input is
  trimmed.
- Layout: a `shell` entry between two steps of a turn stays its own item and is not folded into the stretch.
- Scenario step in `agent-rendered`, "rendered: bash card", on an agent whose fixture transcript holds a finished
  run with stdout and stderr and an unfinished one: the card draws the command, both streams with stderr in the
  error colour, and the unfinished one reads running; no user bubble holds `<bash-`.

### Task 4: @ file mention with pills
**Depends on:** Task 2 (the suggestion panel and `suggestKey`), Task 3 (shares the scenario and fixture files)
**Chunk:** @ file mention with pills
**Files:** `frontend/app/view/agents/filementionmodel.ts`, `frontend/app/view/agents/filementionmodel.test.ts`, `frontend/app/view/agents/filemention.tsx`, `frontend/app/view/agents/renderedcomposer.tsx`, `scripts/cdp/scenarios-agent-rendered.mjs`, `scripts/cdp/agent-page-fixtures.mjs`

**What to build:** spec decisions 9-12 in the Rendered box. `@` opens the panel over the agent's files
(`loadFileIndex` + `rankPaths`, cwd from `resolveCwd`), with the loading, no-folder, error and truncated notes; a
pick writes `@<path> ` (quoted when the path holds whitespace). A mirror layer behind the textarea draws every
mention token as a pill; Backspace at a pill's end (or right after its one trailing space) removes it whole.
Esc with the panel open closes it and does not interrupt: `renderedcomposer.tsx`'s keydown runs the panel's
handler first and returns when it handled the key, before the shared hook's `onKeyDown` (whose Escape calls
`onEscape`), so `agentcomposer.tsx` needs no change. A panel Esc closed stays closed while the caret is in the
same `@` word (`stillDismissed` from Task 2, the word's start from `mentionQueryAt`). The placeholder already
says "@ to mention".

**Interfaces:** `filementionmodel.ts` exports `mentionQueryAt(text, caret): { start: number; query: string } | null`,
`insertMention(text, start, caret, path): { text: string; caret: number }`,
`mentionTokens(text): { start: number; end: number; path: string }[]` and
`backspaceMention(text, caret): { text: string; caret: number } | null`. Task 6 turns the panel off in bash mode
through the hook's `off` flag: `useFileMention({ text, setText, taRef, cwd, off })` returns
`{ panel, open, onKeyDown, onCaret, backdrop }`.

**Acceptance:**
- Model: `@` at the start or after whitespace opens with the typed query; `a@b`, an email and a caret outside the
  word do not; a pick replaces exactly `@query` and puts the caret after the trailing space; a spaced path is
  quoted; tokens match the spec's rule (path-like, trailing punctuation dropped, quoted form); Backspace at a
  token's end or after its space removes token and space, elsewhere returns null.
- Scenario step "rendered: @ mention" on an agent whose cwd is the scenario's temp dir holding a few files:
  typing `@` and part of a name lists the file in the panel, Enter puts `@<path> ` in the box and a pill
  (`data-mention-pill`) draws over it, and Backspace removes the whole mention; then `@` and a letter open the
  panel, Esc closes it and types no ESC into the pty, one more letter leaves it closed, and a space then a new
  `@` opens it again.

### Task 5: Slash command panel
**Depends on:** Task 1 (`GetClaudeLiveCommandsCommand` and `setclaudelivecommands`), Task 4 (shares the composer and scenario files)
**Chunk:** Slash command panel in the Rendered box
**Files:** `frontend/app/view/agents/slashpanelmodel.ts`, `frontend/app/view/agents/slashpanelmodel.test.ts`, `frontend/app/view/agents/slashpanel.tsx`, `frontend/app/view/agents/renderedcomposer.tsx`, `scripts/cdp/scenarios-agent-rendered.mjs`, `scripts/cdp/agent-page-fixtures.mjs`

**What to build:** spec decisions 4-8 in the Rendered box. A leading `/` opens the panel on the agent's live list
(fetched each open, kept between opens), grouped Built-in, Skills, Plugins, MCP, filtered as you type; rows show
the plugin tag and "opens in Terminal" from `isPickerCommand`. With no live list it lists the fork's
`BUILTIN_COMMANDS` and the footer says these are built-ins only; with one, the footer counts the session's
commands. Pick inserts `/name `; Enter on an exactly typed name sends. Esc closes without interrupting (key
order as Task 4) and the panel stays closed while the caret is in the same command word (`stillDismissed`). Both
panels never open at once (the `/` rule needs a leading slash and no space, the `@` rule an `@` word).

**Interfaces:** `slashpanelmodel.ts` exports `slashQueryAt`, `slashMatches`, `slashGroups`, `insertSlash`,
`fromLive`, `BUILTIN_COMMANDS` (the fork's `slashcommands.ts` semantics, without `tui`, `opensPanel`, `opensTui`,
`mergeCommands` or the In Chat group). `useSlashPanel({ text, setText, taRef, blockId, off })` returns
`{ panel, open, onKeyDown, onCaret }`, `off` as Task 4's.

**Acceptance:**
- Model: `/` alone and `/co` open; `a/b`, ` /x` and `/x y` do not; prefix matches rank before substring
  matches; groups come in the spec's order without empty ones; a duplicate name keeps its first; `fromLive` maps an
  unknown source to Skills; a pick replaces the command word and keeps the rest of the text.
- Scenario step "rendered: slash panel" after publishing a live list for the agent's block over
  `setclaudelivecommands` (built-ins including `config` and `compact`, a skill, a plugin command with its plugin,
  an MCP prompt): `/` opens the panel with its group headers and key line; typing `/co` filters to the matching
  rows with `/compact` and `/config` first; `/config` carries "opens in Terminal" and `/compact` does not;
  ArrowDown moves the highlight; Tab puts `/config ` in the box; with `/co` typed again, Esc closes the panel and
  types no ESC into the pty, and one more letter leaves it closed; emptying the box and typing `/` opens it again.

### Task 6: ! bash mode
**Depends on:** Task 1 (`AgentBashCommand`), Task 5 (shares the composer and scenario files)
**Chunk:** ! bash mode with its output card
**Files:** `frontend/app/view/agents/bashmodemodel.ts`, `frontend/app/view/agents/bashmodemodel.test.ts`, `frontend/app/view/agents/renderedcomposer.tsx`, `frontend/app/view/agents/renderedmode.ts`, `frontend/app/view/agents/renderedmode.test.ts`, `frontend/app/view/agents/agentsend.ts`, `frontend/app/view/agents/agentcomposer.tsx`, `frontend/app/view/agents/agentcomposer.test.ts`, `scripts/cdp/scenarios-agent-rendered.mjs`, `scripts/cdp/agent-page-fixtures.mjs`

**What to build:** spec decisions 13-16. A `!` into an empty box turns bash mode on (the `!` not kept; a pasted
`!cmd` keeps `cmd`); Esc with no panel open, or Backspace on an empty box, turns it off; a send leaves it. The cue:
a `! Bash` label (`data-bash-mode` on the box), mono text, accent border, the bash placeholder from
`composerBox` (give it the mode), the `/` and `@` panels off and the attach button hidden; tray attachments stay
and are not sent. Send calls `sendAgentBash(blockId, command)` in `agentsend.ts` (the `AgentBashCommand` wrapper,
errors in `sendAgentText`'s shape); the text clears once the send lands. The seam: `useAgentComposer` takes an
optional `send?: (blockId: string, text: string) => Promise<void>` (default `sendAgentText`) that it passes to
`submitComposer`, so the double-send guard, the clear-if-unchanged and the failure toast stay one path. In bash
mode `renderedcomposer.tsx` passes `send: sendAgentBash`, no `compose` (no attachment paths) and no
`onSubmitText` (no picker flip), and its `onSent` leaves bash mode without clearing the tray. The other callers
(`AgentComposer`, used by the agent row and the lead card) pass nothing and behave as before. Held while `askBlocks`, allowed while working; Stop still interrupts. The pill mirror layer from
Task 4 draws the box's text, so it takes the mono face with the textarea (or draws no pills in bash mode), or
the caret drifts from the drawn text.

**Interfaces:** `bashmodemodel.ts` exports `bashOnInput(prevText, nextText): { bash: true; text: string } | null` and
`bashOffKey(key, text, panelOpen): boolean`.

**Acceptance:**
- Model: `""` to `"!"` turns on with `""`; `""` to `"!ls"` (a paste) turns on with `"ls"`; `"a"` to `"a!"` does not;
  Escape with no panel and Backspace on `""` turn off; Backspace on `"x"` and Escape with a panel open do not.
- `composerBox` in bash mode returns the bash placeholder; its other states are unchanged.
- `submitComposer` / `useAgentComposer`: a given `send` is the one called; with none, `sendAgentText` is, as before.
- In the scenario step below, a ready attachment in the tray before the bash send is still there after it, and the
  bytes typed into the pty hold no attachment path.
- Scenario step "rendered: bash mode" on the keyprobe agent: typing `!` shows the cue and an empty box, typing
  `echo hi` and Enter types `!`, the bracketed paste of `echo hi` and `\r` into the pty (in that order), the box
  empties and leaves bash mode; a second `!` then Backspace leaves the mode with no text; Esc in bash mode types
  no ESC into the pty.
