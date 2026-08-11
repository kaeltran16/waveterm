# Channels — data model and backend reference

A **channel** is a project-bound chat surface for driving a fleet of coding agents. Every channel is
bound to a project (a repo path) at creation, so every worker dispatched from it has a valid `cwd`.

Channels are no longer a nav destination of their own — the Jarvis consolidation merged Channels,
Graph and Tasks into one surface. **For how the UI behaves, read [`docs/jarvis-tab.md`](../jarvis-tab.md)**
(the composer, the autonomy control, the Subjects column, the Stage). This file covers only what that
document does not: the persisted message model, the backend map, and the gotchas that survive the UI.

The old five-verb composer described here previously (plain post / consult / dispatch / steer /
jarvis) no longer exists as a user-facing model; the composer now has two faces, Talk and Launch
(`jarvis-tab.md` §6). The message *kinds* below are the persisted wire format and are unchanged.

## Message kinds and RefORef

Recorded by `PostChannelMessageCommand(channelid, kind, author, text, reforef)`:

| kind | author | reforef | Meaning |
|---|---|---|---|
| `human` | `you` | `""` | Plain post |
| `consult` | `you` | `consult:<id>` | Consult question |
| `consult-reply` | runtime | `consult:<id>` | Consult reply (per runtime) |
| `dispatch` | runtime | `tab:<tabId>` | Worker spawned; couples to Gatekeeper |
| `directive` | `you` | `tab:<targetId>` | Follow-up turn to a running worker |
| `jarvis` | `you` | `jarvis:<reqId>` | Jarvis question |
| `jarvis-reply` | `jarvis` | `jarvis:<reqId>` | Jarvis summary/answer |

Gatekeeper answer and escalation cards are produced backend-side, keyed to the worker's ask
(`pkg/jarvis/cards.go`).

## Source map

Front-end (`frontend/app/view/agents/`) — the surface components moved into
`frontend/app/view/jarvis/`; these are the channel-specific modules that stayed:

- `channelmessages.ts` — `planMessage`, `parseMentions`, `planDelegate`, `tierFromMeta` (pure; unit-tested).
- `channelactions.ts` — `sendChannelMessage` (impure: RPC + record), worker follow-up.
- `channelsstore.ts` — `createChannel`, `selectChannel`, `loadChannels`, `SetChannelReadCommand`, atoms.
- `channelderive.ts` / `jarvisderive.ts` — fleet snapshot + Jarvis prompt building (pure).
- `channelsprimitives.tsx`, `channelcomposers.tsx`, `channelcontextpanel.tsx` — shared pieces.
- `attentionstore.ts` — the polled cockpit-wide "needs you" list + the nav-badge split. Replaced
  `channelneeds.ts`, which composed the same list on the frontend from a stale channel snapshot; the rule now
  lives in `pkg/jarvis/attention.go` (see `docs/jarvis-tab.md` §12).
- `launch.ts` — `buildLaunchMeta`, `RUNTIME_CMD`, runtime flag catalog.

Back-end:

- `pkg/consult` — headless one-shot consult per runtime.
- `pkg/jarvis` — `classify.go` (routine vs fork), `resolve.go` (`ResolveGatekeeperChannel`), `watcher.go`, `decompose.go` (fanout), `cards.go`.
- `pkg/agentask` — the ask protocol + `DeliverAnswer`. Note: multi-answer is gated **server-side** in `encode.go`.

wshrpc commands: `ConsultCommand`, `ConsultRuntimesCommand`, `CreateChannelCommand`,
`PostChannelMessageCommand`, `JarvisCommand`, `JarvisDecomposeCommand`, `SetChannelTierCommand`,
`SetChannelReadCommand`, `ControllerInputCommand`, `ListBranchesCommand`.

## Gotchas

- **Gatekeeper depends on an external hook.** Organic-ask interception lives outside this repo
  (`~/.claude` `PreToolUse` hook → `wsh ask`). If it isn't installed, a worker's `AskUserQuestion`
  renders only in its own terminal and never reaches the channel, so Gatekeeper can't act — see
  [`organic-ask-setup.md`](organic-ask-setup.md).
- **Two transports.** Consult and Jarvis ride the **websocket** (`TabRpcClient`); dispatch's
  `CreateTab` is an **HTTP** service call. A half-dead backend can serve consults but fail dispatch —
  a useful signal when triage disagrees.
- **`agy` positional quirk.** Antigravity dispatch must use `agy -i <task>`; a bare positional prompt
  is ignored by the `agy` CLI (handled in `buildLaunchMeta`).
- **OpenCode consult is JSONL.** `ask @opencode` runs `opencode run --format json`, whose stdout is
  one event per line; assistant text arrives as `text` events and everything else is skipped. The
  worker's shadow transcript lives at `~/.local/share/opencode/waveterm/<sessionID>.jsonl` (the
  filename stem is the resume id, `opencode -s <id>`). The status plugin is auto-installed by
  `wsh install-agent-hooks` into `~/.config/opencode/plugins/` — no `opencode.json` edit; the config
  `plugin` array is npm-only and is never touched.
- **Pi consult is native JSONL.** `ask @pi` runs `pi --mode json --no-session --no-extensions`, whose
  stdout is one native v3 event per line; assistant text arrives on `message_end` and `agent_settled`
  marks completion. Pi is discovered from `pi` on PATH. `wsh install-agent-hooks` installs the live
  status extension into `~/.pi/agent/extensions/waveterm-status.ts` (working/idle states, title,
  provider/model, context pct). Pi sessions remain authoritative under `~/.pi/agent/sessions`; Wave
  reads them directly and resumes with `pi --session` plus the exact native path as one argument.
  Launching Pi with `--no-extensions` disables live status reporting but not history, usage, or
  resume. Channel syntax mirrors the other runtimes: `@pi <prompt>` dispatches a persistent worker,
  `ask @pi <prompt>` runs the one-shot consult above and replies inline.
- **Worker auto-titles are paraphrases.** Roster rows are labeled by the ai-title reporter, which
  paraphrases the task (goal "reply with token DELEG8" → title "Provide delegation token"). Derived,
  not a stuck prompt — see [`tab-auto-naming.md`](tab-auto-naming.md).

## Testing over CDP

There is no render-test harness for the cockpit; flows are verified against the live dev app over the
Chrome DevTools Protocol on `:9222` (WebView2 speaks CDP; the flag is dev-gated in
`src-tauri/src/main.rs`). Two things that bite when scripting through `Runtime.evaluate`: locate
columns by **geometry** (a 180–300px-wide column) rather than bracket class-selectors like
`.w-[244px]`, and avoid backslash-regex — both break through the double-eval. Dispatching real workers
for Gatekeeper/Delegator tests uses harmless token-reply prompts under prompting (default) permissions
so nothing edits files unattended.
