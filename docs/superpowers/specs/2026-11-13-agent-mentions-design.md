# Tag other agents from the prompt (@@)

## Intent and why

Today, to have one agent talk to another, the user copies the other tab's name and tells the agent to talk
to it. That is too much work. Tagging replaces the copy-and-explain step: the user names another live agent
right in the Claude Code prompt, and the agent they are typing to does the talking.

## What it does

1. In a Claude Code session running in an Arc block, the user types `@@` (then optionally a few letters).
   The typeahead lists this project's live agent tabs, each with its tab id, state and task title.
2. Taking a row writes a tag into the prompt (for example `@@reviewer`).
3. On submit, the arc mod resolves each tag to its tab id and attaches context to the prompt (never shown to
   the user) telling this agent which tab the tag names and that it reaches it with
   `wsh agents send <tab>` / `wsh agents read <tab>` / `wsh agents wait <tab>`.
4. This agent writes and sends the message itself. The user's text is not delivered to the tagged agent
   directly.

## Decisions

- **Trigger: `@@`.** Bare `@` stays Claude Code's file mention, untouched. (Answer 3.)
- **Scope: this project only.** The list offers only live agents in the same project as this session, as
  `wsh agents list` shows by default. (Answer 2.)
- **Waiting for the answer: the agent judges from the prompt.** When the prompt asks the tagged agent for
  something back, this agent sends with `--wait` and continues with the answer; when the prompt only tells
  the tagged agent something, it sends and moves on. The context line states this rule. (Answer 4.)
- **Claude Code only, for now.** pi agents still appear in the list and can be messaged (`wsh agents send`
  reaches them), but pi's own prompt gets no `@@`. Adding it to pi is deferred. (Answer 5.)
- **Only the user's own typed prompts are resolved** (Agent's call). The `prompt.submit` hook acts only on
  `e.origin` `composer`, the person's Enter in the Claude Code prompt box. Prompts from the cockpit's input,
  the bridge, and messages other agents send through `wsh agents send` (all arriving via the arc mod's
  `wsh agentctl` loop, `register.ts` `listenToCockpit`) pass through untouched: an agent's message quoting
  `@@x` must never make the receiver message a third agent, which could chain or loop. The cockpit input has
  no `@@` typeahead, so tagging from it is out of scope. `mention-core.test.ts` covers a non-composer origin.
- **Built in the arc mod** (`claude/arc-mod/hooks/`), with a `prompt.autocomplete` hook matching the `@@`
  token and a `prompt.submit` hook that attaches the context. Pure logic (token parsing, row building,
  tag resolution, the context text) in a `hooks/mention-core.ts` with `mention-core.test.ts` beside it,
  consumed by `register.ts`. Outside an Arc block (no `WAVETERM_BLOCKID` / `WAVETERM_JWT`) both hooks pass
  straight through, as the rest of the arc mod does.

## Constraints and what exists

- `wsh agents list|send|read|wait|explain` (`cmd/wsh/cmd/wshcmd-agents.go`) already find live claude and pi
  tabs and move messages between them. `wsh agents list --json` returns `AgentInfo` rows
  (`pkg/wshrpc/wshrpctypes_agents.go`: `tabid`, `name`, `projectpath`, `project`, `runid`, `harness`,
  `state`, `cwd`, `title`), already filtered to the caller's project unless `--all`.
- Claude Code's `prompt.autocomplete` (mod API types: `~/.arc/claude-mod/.claude-plugin/types/claude-code/index.d.ts`, written by Claude Code)
  fires per keystroke for the token at the cursor; a hook's rows draw beneath the engine's own rows. A mod
  cannot remove the engine's rows, which is why bare `@` does not work: Claude Code's file rows fill the
  visible list and bury the agent rows.
- `prompt.submit` lets a hook append strings to `context`, which the model reads beside the prompt.
- After editing `claude/arc-mod/`, run `task sync:claudemod` and commit the `cmd/wsh/cmd/claude-mod` copies
  with it (`docs/agents/claude-mods.md`). Check the mod with `claude plugin validate claude/arc-mod`.

## Evidence: a live probe (2026-11-13, Claude Code 2.1.323)

A throwaway mod (`.superpowers/probes/claude-mods/compactprobe/arcm/`, driven by `mention-drive.cjs`
through a pty) with two fake agents showed:

- `@@`, `&` and `@agent:` match no file, so the typeahead showed only the agent rows, with description.
- Tab on a row wrote the row's `text` (`@agent:reviewer` in the probe) over the token.
- `prompt.submit` saw the tag and attached `"@agent:reviewer is live agent tab a1b2c3d4; reach it with wsh
  agents send a1b2c3d4"`. The model ran `wsh agents send a1b2c3d4` on its own.
- The model wrote its own, fairly long message for the tagged agent. The context should tell it to keep the
  message to what the user asked.

Considered and declined: overriding bare `@` through Claude Code's `fileSuggestion` setting. It works (the
probe showed agents on top of a bare `@`), but it replaces Claude Code's fuzzy file index in every session,
spawns a process per keystroke, and draws agent rows as file rows with no title.

## Non-goals

- Delivering the user's text straight to the tagged agent (this agent does the talking).
- Agents in other projects.
- `@@` in pi's prompt.
- Any change to Claude Code's bare `@` file mentions.

## Left to the builder

- What taking a row writes, e.g. `@@reviewer`; disambiguate duplicate tab names with the short tab id.
- Leave this session's own tab out of the list; show each row's state and title.
- Fetch the list without a `wsh` spawn per keystroke (e.g. fetch once when an `@@` token starts, reuse it
  while that token is typed).
- At submit, a tag naming an agent that is gone or unknown: say so in the context instead of failing the
  prompt.
- The exact context line: the tab id, `wsh agents send/read/wait`, the waiting rule above, and a nudge to
  keep the message to what the user asked.
- Tests: `mention-core.test.ts` (vitest) covers token matching, row building, tag resolution and the
  context text. Verify live with the pty probe harness (the probe mod must be renamed from `arc`, and
  `WAVETERM_BLOCKID` / `WAVETERM_JWT` stripped, so `wsh` calls need a stub or a real Arc block).
