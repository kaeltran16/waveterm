# Channels tab: a conversational agent-dispatch surface

Date: 2026-06-30
Scope: feature (new cockpit NavRail surface + a dispatch/consult backend seam). Spec only — hands off to writing-plans.
Related: `docs/orchestrator-roadmap.md` (the future manager layers onto this substrate), the Sessions tab
(`2026-06-30-sessions-tab-design.md`, shares the provider-registry / runtime-agnostic philosophy), and the existing
`pkg/agentask` ask/answer channel (reused here).

## Problem

Running a fleet of agents today means tabbing between N terminals to tell each one what to do. The cockpit has good
**monitoring** surfaces — Cockpit (live fleet status), Activity (cross-project event feed), Agent (one focused agent) —
but no **direction** surface: nowhere to say "go do X," summon a fresh worker, or get a second opinion, from one place.
The `channels` NavRail entry exists but renders `PlaceholderSurface` ("Coming soon").

This spec fills it with a **conversational dispatch surface**: a Slack-style channel where you direct your fleet and
summon new workers by `@mention`, and the conversational beats (dispatch, asks, handoffs, replies) flow into one
timeline. It is explicitly **not** another status view — Cockpit watches, Channels talks.

## Decisions (locked via brainstorming, 2026-06-30)

Settled interactively; recorded so the plan doesn't relitigate them.

- **Channels talks, Cockpit watches.** Channels carries the *dialogue* (your messages + dispatch / ask / handoff /
  consult-reply), not a live status mirror. Minute-to-minute progress stays on Cockpit/Agent; channel rows link out
  (`↗`). This is the key non-redundancy decision — it removes the expensive "multiplex N transcripts into a live feed"
  work.
- **`@mention` is the universal verb, with two target types.** `@<runtime>` (`@claude` / `@codex` / `@gemini`)
  dispatches a **brand-new** persistent worker via `launchAgent`; `@<name>` (an existing channel worker) **steers** the
  running one by injecting into its PTY (`ControllerInputCommand`). Same gesture; the target type decides.
- **Dispatched workers are persistent, not one-shot.** A dispatch spawns a real agent (in a worktree by default), which
  becomes a channel participant you can follow up with. This is the orchestrator-aligned lifecycle — the manual dispatch
  verb *is* the future manager's primary action. (1devtool's one-shot model is the inspiration for `@mention`/fan-out,
  but the wrong lifecycle for an orchestrator substrate.)
- **A channel is bound to a project.** Dispatches launch in that project's repo, in a worktree by default (the
  parallel-safe choice). Reuses the existing Projects registry + New Agent launcher. An unbound channel's first dispatch
  pops the New Agent launcher pre-filled (runtime + task) to bind it.
- **Two non-negotiables that make it manager-ready for free** (see `docs/orchestrator-roadmap.md`):
  1. **Verbs-as-commands.** Every human action — post, dispatch, answer-ask, steer — is backed by a backend command
     (wshrpc / `wsh` subcommand), not just a UI click handler. These become the manager's MCP tool surface later.
  2. **Channel-as-object.** A channel is a persisted, addressable object (id + message log), so a manager can be
     "attached to channel X" and read/write it.
- **One-shot "consult" is deferred** (fast-follow). `@gemini review this` → blocking cross-CLI reply is genuinely
  useful and is also a future-manager tool, but it is the one net-new external primitive; v1 ships without it.

## Architecture / data flow

```
                          ┌──────────────────────────── Channels surface (NavRail) ───────────────────────────┐
   you type a message ───▶│  composer (parse @mentions)                                                        │
                          │        │                                                                           │
                          │        ├── @<runtime>  ─▶ DispatchAgentCommand ─▶ launchAgent({runtime,task,        │
                          │        │                     (verb-as-command)        projectPath, worktree})       │
                          │        │                                                  │                         │
                          │        └── @<name>     ─▶ SteerAgentCommand ─▶ ControllerInputCommand(inject)       │
                          │                              (verb-as-command)            │                         │
                          │                                                           ▼                         │
                          │   channel message log  ◀──── dispatch record / ask / handoff·done / your message ──┤
                          │   (persisted, addressable: channelId + messages[])                                 │
                          └───────────────────────────────────────────────────────────────────────────────────┘
                                    ▲                         ▲                          │ row "↗"
   asks  ── pkg/agentask ───────────┘                         │                          ▼
   handoff/done ── status/activity signals (already captured)─┘            Cockpit / Agent tab (live status)
```

The channel is the **substrate**; the future orchestrator is a participant that reads the message log and emits the same
commands (`Dispatch` / `Steer` / answer-ask) a human does — no new substrate. See `docs/orchestrator-roadmap.md`.

## What flows into a channel (message types)

A channel message is a small tagged record. Five kinds, only one of which needs a net-new source:

1. **`human`** — text you typed. (new: the composer)
2. **`dispatch`** — "@codex → build the auth refactor → working ↗" emitted when `DispatchAgentCommand` launches a worker.
   Carries the new agent's oref so the row can link to Cockpit/Agent and later beats can attribute to it. (new: the
   dispatch command)
3. **`ask`** — a dispatched worker needs you; rendered with answer controls. **Reuses `pkg/agentask` + `Event_AgentAsk`**
   (the ask-in-place machinery already on the Agent tab). Answered inline via the existing answer routing.
4. **`handoff` / `done`** — "@codex done · +142 −38 · review ↗", derived from the **status/activity signals already
   captured** (the same source Activity uses). No new backend.
5. **`consult-reply`** — *deferred*. The blocking cross-CLI reply for a one-shot `@runtime` consult.

Only types 1 and 2 are genuinely new; 3 and 4 are projections of signals that already exist; 5 is deferred.

## Backend — verbs as commands (manager-ready seam)

New wshrpc commands (the manual UI calls them now; the future manager calls them later — same surface):

- **`DispatchAgentCommand{channelId, runtime, task, projectPath, worktree}` → `{agentOref}`** — resolves the channel's
  bound project, calls the existing `launchAgent` path (worktree by default), records a `dispatch` message on the
  channel, returns the new agent's oref. This *is* the Delegator's spawn tool.
- **`SteerAgentCommand{channelId, agentOref, text}`** — injects `text` into the target worker's PTY via the existing
  `ControllerInputCommand`, records the directive as a `human`/dispatch follow-up on the channel.
- **Channel CRUD** — `CreateChannel`, `GetChannels`, `GetChannelMessages`, `PostChannelMessage` (and an
  `Event_ChannelMessage` pub/sub so the surface live-updates). Backed by a persisted, addressable channel object
  (see below). Answering an ask continues to use the existing `AnswerAgentCommand`.

**Channel-as-object / persistence.** A channel is `{id, name, projectPath, createdTs}` with an append-only message log.
Persist via the existing `wstore`/SQLite object model (preferred — channels are first-class objects a manager addresses
by id) rather than an ad-hoc file. Decision deferred to writing-plans: ORef-addressed waveobj vs a small dedicated
table; either satisfies "addressable id + message log."

## Frontend

1. **`channelsstore.ts`** — channel list + per-channel message atoms; loader over `GetChannels` /
   `GetChannelMessages`; subscribes to `Event_ChannelMessage` for live append. Pure `parseMentions(text)` helper
   (returns `{runtimes[], names[], body}`), unit-testable.
2. **`channelssurface.tsx`** — the surface view: a channel switcher (left or header), the message timeline (one row
   component per message type), and a composer with `@mention` autocomplete (runtimes from the launch registry +
   live worker names from the roster). `@runtime` send → `DispatchAgentCommand`; `@name` send → `SteerAgentCommand`;
   plain send → `PostChannelMessage`. Ask rows reuse the existing answer control. Built with @theme tokens (no SCSS,
   no hardcoded colors).
3. **`cockpitshell.tsx`** — one branch: `surface === "channels"` renders `<ChannelsSurface>` instead of
   `<PlaceholderSurface>`. (Note: collides on this file + `placeholdersurface.tsx` with the in-flight Sessions tab —
   trivial 2-line merge, coordinate.)
4. **`placeholdersurface.tsx`** — drop the now-unused `channels` title entry.
5. **Dispatch binding reuse** — the New Agent launcher (Projects registry + worktree support) is reused for the
   unbound-channel first-dispatch flow; no new launcher.

## Components (isolation)

1. Backend dispatch/steer/channel commands (Go) — verbs-as-commands; each one job, unit-testable, and the manager's
   future tool surface.
2. Channel object + message log (persistence) — addressable by id.
3. `channelsstore.ts` — fetch + live-append + pure `parseMentions`. No view.
4. `channelssurface.tsx` — the surface view; reads the store, calls the verb commands.
5. `cockpitshell.tsx` / `placeholdersurface.tsx` — small wiring edits.

## Error handling

- Dispatch into a moved/deleted project, or a runtime CLI that isn't installed → `launchAgent` surfaces the error in the
  PTY and the `dispatch` row shows a failed state; the channel never breaks (mirror, don't pre-validate — consistent
  with the live-TUI stance).
- Steering a worker whose terminal has exited → the command no-ops with a visible "worker no longer running" row, not a
  thrown error.
- Channel scan/load failure → empty state, never an error screen (same posture as the other surfaces).
- A malformed `@mention` (unknown runtime, unknown name) → treated as plain text in the message, with a hint; no
  dispatch.

## Deferred (noted, not built)

- **One-shot consult** (`@runtime` → blocking cross-CLI reply, fan-out). The net-new external primitive; v1 dispatches
  persistent workers only. Inspired by `1devtool-orchestrator`; ship our own native `claude -p` / `codex exec` provider
  rather than hard-coupling the external shim.
- **The orchestrator/manager itself.** v1 is manually driven. The manager is a participant that calls the same verbs;
  see `docs/orchestrator-roadmap.md` for the Concierge → Gatekeeper → Delegator progression.
- **Live progress in-channel.** Deliberately Cockpit's job; channel rows link out.
- **Cross-channel / DM / multi-human.** One project-bound channel model in v1; no per-agent DMs or multi-user.
- **Agent-initiated posting** (a worker spontaneously posting to the channel via a new bus). v1's agent-sourced rows
  (ask / handoff) are projections of existing signals; a general "agent posts a message" bus is a later layer.

## Testing / verification

- Go: dispatch resolves the channel's project + worktree and records a `dispatch` message; steer routes to
  `ControllerInput`; channel CRUD round-trips the message log; ask reuse routes through `AnswerAgentCommand`.
- vitest: `parseMentions` (runtime vs name vs plain, multiple mentions, unknown handles); message-row rendering per
  type; the composer's send-routing (`@runtime`→dispatch, `@name`→steer, plain→post).
- Typecheck: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (baseline has 3 pre-existing
  `api.test.ts` errors).
- CDP (live dev app): open Channels — bind a project; `@codex build X` spawns a new worktree worker that appears on
  Cockpit and posts a `dispatch` row with a working `↗`; the worker's ask posts inline and answering it routes through;
  `@<that worker> do Y` injects a follow-up into its PTY.

## Implementation outline (writing-plans will expand)

1. Channel object + persistence (id + message log) + CRUD commands + `Event_ChannelMessage`; `task generate`.
2. `DispatchAgentCommand` (reuse `launchAgent` + Projects/worktree) and `SteerAgentCommand` (reuse `ControllerInput`);
   record the `dispatch` message; Go tests.
3. `channelsstore.ts`: loader + live-append + pure `parseMentions` (+ vitest).
4. `channelssurface.tsx`: switcher + timeline (row-per-type, ask row reuses the answer control) + `@mention` composer
   with send-routing; @theme tokens.
5. Wire `cockpitshell.tsx`; clean up `placeholdersurface.tsx`; reuse the New Agent launcher for unbound-channel binding.
6. Project the existing **handoff/done** status signals into channel rows.
7. Tests + CDP verify the dispatch → work → ask → steer loop end-to-end.
