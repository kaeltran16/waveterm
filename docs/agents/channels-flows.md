# Channels tab — flow reference

The **Channels** tab is a Slack-style, project-bound chat surface for driving and
supervising a fleet of coding agents. Every channel is bound to a project (a repo
path) at creation, so every worker dispatched from it has a valid `cwd`. A single
composer routes typed messages to one of five verbs, and a per-channel **Jarvis
autonomy tier** governs how much the fleet manager acts on its own.

This document catalogs every user-facing flow, the exact input syntax, what it
does under the hood, and the source of truth for each. It reflects the build as
verified end-to-end over CDP on 2026-07-03.

## Layout

```
┌──────────┬───────────────────────────────────────┬──────────────────┐
│  rail    │  header (channel name · project path)  │  fleet panel     │
│ channel  │         + tier selector (C/G/D)        │  (Jarvis)        │
│  list +  ├───────────────────────────────────────┤  autonomy card   │
│ autonomy │                                        │  + checklist     │
│  badges  │            transcript                  │  FLEET HERE       │
│  +New    │      (message cards, top→bottom)       │  worker roster    │
│          ├───────────────────────────────────────┤  project path     │
│          │  composer (tier-aware placeholder)     │                  │
│          │  [@ mention agent]            [Send]    │                  │
└──────────┴───────────────────────────────────────┴──────────────────┘
```

- **Rail** (`channelrail.tsx`): channel list with an `AUTONOMY` column showing a
  one-letter tier badge (`C`/`G`/`D`), an unread count badge, an attention dot when
  a worker is waiting, and a "+ New channel" action.
- **Header** (`channelssurface.tsx`): channel name, project path, and the
  three-segment tier dial (`concierge` / `gatekeeper` / `delegator`).
- **Fleet panel / Jarvis** (right aside): the current tier's autonomy contract, a
  three-item capability checklist, and the live worker roster ("FLEET HERE").
- **Composer**: a plain-text draft with a scroll-synced backdrop that highlights
  `@mentions`. The placeholder is **tier-aware** (see [Jarvis tiers](#jarvis-autonomy-tiers)).

## Message routing

All routing is pure front-end in `planMessage(text, roster)`
(`frontend/app/view/agents/channelmessages.ts`). It is evaluated top-down; the
first match wins:

| # | Input pattern | Verb | Result |
|---|---|---|---|
| 1 | `@jarvis[:mode] <text>` | **jarvis** | Fleet-manager action (tier-dependent) |
| 2 | `ask @<runtime> <text>` | **consult** | One-shot headless review, fanned out per runtime |
| 3 | `@<runtime> <text>` | **dispatch** | Spawn a new worker with `<text>` as its task |
| 4 | `@<rosterName> <text>` | **steer** | Inject `<text>` into a live worker's PTY |
| 5 | anything else | **post** | Plain human message |

Valid `<runtime>` tokens: **`claude`**, **`codex`**, **`antigravity`**, **`terminal`**
(`RUNTIMES` in `channelmessages.ts`). Note `agy` is **not** a token — use
`@antigravity`. `@jarvis` is matched by a dedicated regex so a bare `@jarvis`
(no trailing space) is caught and always beats a roster worker literally named
"jarvis".

`parseMentions` consumes leading `@name ` tokens (a mention requires a trailing
space). The composer's `@ mention agent` button inserts a bare `@` at the caret
and opens a suggestion dropdown of candidates (installed runtimes + live roster:
`@claude / @codex / @antigravity / @jarvis`).

The impure side — turning a plan into RPC calls and recording a channel message —
is `sendChannelMessage(...)` in `channelactions.ts`. **Every branch records a
channel message**, so the transcript is the single source of truth (a manager can
replay it).

## Flow catalog

### 1. Plain post

- **Input:** any text with no leading verb (e.g. `deploying at 3pm`).
- **Effect:** `post(channelId, "human", "you", text, "")` — a human message card.
- No agent involvement.

### 2. Consult — `ask @<runtime> <prompt>`

- **Input:** `ask @claude summarize the auth flow` (multiple runtimes allowed:
  `ask @claude @codex ...` fans out to each).
- **Effect** (`channelactions.ts`, consult branch):
  1. Posts one `consult` question card (author `you`, `reforef: consult:<id>`).
  2. For each runtime, opens a **streaming** `ConsultCommand` RPC and accumulates
     chunks into the ephemeral `consultStreamsAtom`, keyed by `(consultId, runtime)`.
  3. Each reply lands as a `consult-reply` card grouped under the question.
- **Backend:** headless one-shot CLI per runtime (`pkg/consult`): claude/codex over
  pipes (JSONL); antigravity via `agy -p` on a PTY. No new worker/tab is created —
  a consult is stateless and disposable.
- **Timeout:** the RPC uses `CONSULT_RPC_TIMEOUT_MS = 130_000` to clear the backend's
  120s consult timeout (the default 5s handler timeout would kill the stream before
  codex emits its first chunk at ~6s).

### 3. Dispatch — `@<runtime> <task>`

- **Input:** `@claude fix the failing auth test`.
- **Effect** (`channelactions.ts`, dispatch branch):
  1. `launchAgent(...)` → `CreateTab` (HTTP) → `SetMetaCommand(buildLaunchMeta)` →
     the block controller runs the CLI with `<task>` as its initial prompt →
     returns the new `tabId`.
  2. `post(channelId, "dispatch", runtime, task, "tab:<tabId>")` — a DISPATCH card
     with an `open ↗` link to the worker's tab.
- The `tab:<id>` RefORef is what the Gatekeeper watcher matches to couple the worker
  (see [Gatekeeper](#gatekeeper--auto-answer-vs-escalate)).
- **Launch meta** (`launch.ts::buildLaunchMeta`): `view:term`, `controller:cmd`,
  `cmd`, `cmd:args`, `cmd:shell:false`, `cmd:jwt:true`, `cmd:cwd`. The task is passed
  as a positional arg — **except antigravity**, which needs `-i <task>` (the `agy`
  CLI ignores a bare positional prompt; see the note in `buildLaunchMeta`).

### 4. Steer — `@<rosterName> <directive>`

- **Input:** `@fix-auth-agent also update the snapshot` where `fix-auth-agent` is a
  live worker's roster name.
- **Effect** (`channelactions.ts`, steer branch):
  1. `ControllerInputCommand({blockid, inputdata64})` — writes `<directive>\r`
     straight into the live worker's PTY.
  2. `post(channelId, "directive", "you", text, "tab:<targetId>")`.
- No-ops if the worker is gone (no live `blockId`). The same primitive backs the
  "Override" action on an answered card (`steerWorker`).

### 5. Jarvis — `@jarvis[:mode] <text>`

Behavior depends on the channel's **tier**. See the next section.

## Jarvis autonomy tiers

A single per-channel dial (`concierge` / `gatekeeper` / `delegator`) sets how much
the fleet manager acts autonomously. Switch it via the header's three-segment
control → `SetChannelTierCommand`. Tier is derived from channel meta booleans by
`tierFromMeta(meta)` (`channelmessages.ts`): `delegator:enabled` ⇒ delegator,
else `gatekeeper:enabled` ⇒ gatekeeper, else concierge. Delegator implies
gatekeeper (`TierMeta` writes both booleans).

| Tier | Rail badge | `@jarvis <text>` does | Auto-answers asks? | Spawns workers? |
|---|---|---|---|---|
| **Concierge** | `C` | Observe-only fleet **summary** | No | No |
| **Gatekeeper** | `G` | Fleet summary | **Yes** (routine only; escalates forks) | No |
| **Delegator** | `D` | **Dispatches a worker** toward the goal | Yes (inherits gatekeeper) | **Yes** |

The composer placeholder reflects the tier:
- Concierge → "…@jarvis to summarize"
- Gatekeeper → "…Jarvis is handling routine questions"
- Delegator → "…@jarvis \<goal\> to dispatch workers"

The right-panel autonomy checklist fills in per tier: Observe the fleet ✓ (all) →
Answer routine questions ✓ (gatekeeper+) → Dispatch & steer workers ✓ (delegator).

### Concierge — observe-only summary

`@jarvis <question>` posts a `jarvis` question card, builds a fleet snapshot
(`buildFleetSnapshot`), and streams a `JarvisCommand` reply summarizing the fleet.
If nothing is dispatched in the channel, it short-circuits with "No workers
dispatched in this channel yet." — no model call. It **never** answers worker asks
or spawns anything.

### Gatekeeper — auto-answer vs escalate

Gatekeeper is a **background watcher** (`pkg/jarvis/watcher.go`), not a message
verb. When a worker dispatched into a gatekeeper channel calls its `AskUserQuestion`
tool, the ask is routed to the channel and Jarvis classifies it:

1. **The ask reaches the channel** via the external `~/.claude` hook chain: a
   Claude Code `PreToolUse` hook on `AskUserQuestion` calls `wsh ask`, which
   `publishAgentAsk`es the question. `ResolveGatekeeperChannel(channels, askingORef)`
   (`pkg/jarvis/resolve.go`) matches the asking worker's oref to the `tab:<id>` of a
   dispatch message to find the owning channel. **This depends on the external hook
   being installed** (see `docs/agents/organic-ask-setup.md`); without it the ask
   only renders in the worker's own terminal.
2. **Classify** (`pkg/jarvis/classify.go::Classify`): a stateless Claude classifier
   decides routine vs. real fork. **Fail-safe: on any error it escalates** (never
   silently auto-answers).
3a. **Routine → auto-answer.** Jarvis posts an `ANSWERED` card ("Jarvis chose \<opt\>"
    + reasoning), delivers the answer to the worker via `agentask.DeliverAnswer`, and
    the worker "resumed on its own." An **Override** button lets you countermand.
3b. **Fork → escalate.** Jarvis posts an `ESCALATION` card ("Why I'm not deciding
    this: …") with the question and **clickable options**. The worker stays in the
    `asking` state (counted as WORKING) until you click an option; the choice is
    then delivered and the worker resumes ("sent to \<worker\>, resuming").

Verified example: "ISO-8601 vs Unix epoch timestamps" → auto-answered ISO-8601;
"delete src-tauri and rewrite the shell" → escalated with both options.

### Delegator — spawn and run

On a delegator-tier channel, `planDelegate(...)` (`channelmessages.ts`) turns a
non-empty `@jarvis <goal>` into a real worker dispatch (on any other tier, or with
an empty goal, it falls back to the concierge summary). Three modes select via the
per-channel `delegator:mode` default or a per-message override (`@jarvis:report|manage|fanout <goal>`):

| Mode | Task launched | Behavior |
|---|---|---|
| **report** (default) | `<goal>` verbatim | One bounded pass; human reviews. |
| **manage** | `/goal <goal>` | `/goal` supervision loop runs to completion; Gatekeeper auto-answers its routine asks along the way. |
| **fanout** (v1.1) | `JarvisDecomposeCommand` → N × `/goal <subtask>` | Each subtask launched in its own git worktree (`deriveBranch` + `launchAgent({branch})`). |

Report ↔ Manage differ solely by the `/goal` wrapper. Every delegator dispatch is
hard-coded to the **claude** runtime and posts a `dispatch` card (author `claude`),
so the spawned worker auto-couples to Gatekeeper with zero extra wiring.

## Channel management

- **Create:** rail "+ New channel" toggles an **inline** project picker (not a
  modal); picking a project calls `createChannel(name, path)` →
  `CreateChannelCommand` → reload + select. A channel with no project shows a
  "No projects — add one from the Cockpit + New project" hint.
- **Select:** clicking a rail row → `selectChannel(id)`; also fires
  `SetChannelReadCommand` to clear that channel's unread cursor.
- **Tier:** header dial → `SetChannelTierCommand` (persists per-channel).
- **Autonomy / unread badges** in the rail come from a `channelsAtom` **snapshot**,
  not a live WOS subscription — see [Known limitations](#known-limitations--gotchas).

## Message kinds & RefORef reference

Recorded by `PostChannelMessageCommand(channelid, kind, author, text, reforef)`:

| kind | author | reforef | Meaning |
|---|---|---|---|
| `human` | `you` | `""` | Plain post |
| `consult` | `you` | `consult:<id>` | Consult question |
| `consult-reply` | runtime | `consult:<id>` | Consult reply (per runtime) |
| `dispatch` | runtime | `tab:<tabId>` | Worker spawned; couples to Gatekeeper |
| `directive` | `you` | `tab:<targetId>` | Steer directive |
| `jarvis` | `you` | `jarvis:<reqId>` | Jarvis question |
| `jarvis-reply` | `jarvis` | `jarvis:<reqId>` | Jarvis summary/answer |

Gatekeeper answer/escalation cards are produced backend-side keyed to the worker's
ask; see `pkg/jarvis/cards.go`.

## Source map

Front-end (`frontend/app/view/agents/`):
- `channelmessages.ts` — `planMessage`, `parseMentions`, `planDelegate`, `tierFromMeta` (pure; unit-tested).
- `channelactions.ts` — `sendChannelMessage` (impure: RPC + record), `steerWorker`.
- `channelssurface.tsx` — the surface: transcript, tier dial, composer, fleet panel, `pickProject`.
- `channelrail.tsx` — channel list, autonomy/unread badges, inline "+ New channel" picker.
- `channelsstore.ts` — `createChannel`, `selectChannel`, `loadChannels`, `SetChannelReadCommand`, atoms.
- `channelderive.ts` / `jarvisderive.ts` — fleet snapshot + Jarvis prompt building (pure).
- `launch.ts` — `buildLaunchMeta`, `RUNTIME_CMD`, runtime flag catalog.

Back-end:
- `pkg/consult` — headless one-shot consult per runtime.
- `pkg/jarvis` — `classify.go` (routine vs fork), `resolve.go` (`ResolveGatekeeperChannel`), `watcher.go`, `decompose.go` (fanout), `cards.go`.
- `pkg/agentask` — the ask protocol + `DeliverAnswer`. Note: multi-answer is gated **server-side** in `encode.go`.

wshrpc commands: `ConsultCommand`, `ConsultRuntimesCommand`, `CreateChannelCommand`,
`PostChannelMessageCommand`, `JarvisCommand`, `JarvisDecomposeCommand`,
`SetChannelTierCommand`, `SetChannelReadCommand`, `SetChannelGatekeeperCommand`
(legacy — no FE call-site, superseded by the tier command), `ControllerInputCommand`,
`ListBranchesCommand`.

## Known limitations & gotchas

- **Rail badges are snapshot-stale.** Tier and unread badges in the rail are derived
  from a cached `channelsAtom` snapshot, so they don't reflect a just-changed tier or
  a just-cleared unread until the channel list re-derives (e.g. a tab-cycle). The
  underlying `SetChannelTierCommand` / `SetChannelReadCommand` persist immediately —
  the header, right panel, and worker state are always live. Cosmetic latency only.
- **Worker auto-titles are paraphrases.** Roster rows are labeled by the ai-title
  reporter, which paraphrases the task (goal "reply with token DELEG8" → title
  "Provide delegation token"). It's a derived title, not a stuck prompt (see
  `docs/agents/tab-auto-naming.md`).
- **Gatekeeper depends on the external hook.** Organic-ask interception lives outside
  this repo (`~/.claude` `PreToolUse` hook → `wsh ask`). If it isn't installed, a
  worker's `AskUserQuestion` renders only in its own terminal and never reaches the
  channel, so Gatekeeper can't act (see `docs/agents/organic-ask-setup.md`).
- **Two transports.** Consult/Jarvis ride the **websocket** (`TabRpcClient`); dispatch's
  `CreateTab` is an **HTTP** service call. A half-dead backend can serve consults but
  fail dispatch — a useful signal when triage disagrees.
- **`agy` positional quirk.** Antigravity dispatch must use `agy -i <task>`; a bare
  positional prompt is ignored by the `agy` CLI (fixed in `buildLaunchMeta`).

## Testing over CDP

There is no render-test harness for the cockpit; flows are verified against the live
dev app over the Chrome DevTools Protocol on `:9222` (WebView2 speaks CDP; the flag is
dev-gated in `src-tauri/src/main.rs`). Practical notes when scripting the rail through
`Runtime.evaluate`: locate the rail by **geometry** (a 180–300px-wide column) rather
than bracket class-selectors like `.w-[244px]`, and avoid backslash-regex — both break
through the double-eval. Dispatching real workers for Gatekeeper/Delegator tests uses
harmless token-reply prompts under prompting (default) permissions so nothing edits
files unattended.
