# Jarvis (Concierge tier): an observe-only manager participant in Channels

Date: 2026-07-01
Scope: feature (a new Channels participant + a headless-CLI summarizer seam). Spec only — hands off to writing-plans.
Related: `docs/orchestrator-roadmap.md` (Jarvis is the manager; Concierge/Gatekeeper/Delegator are its capability
tiers), `docs/superpowers/specs/2026-06-30-channels-tab-design.md` (the substrate), `pkg/consult` (the headless-CLI
exec primitive Jarvis reuses).

## Naming

**Jarvis** is the manager agent — the user-facing name, the message author (`author:"jarvis"`), and the package
(`pkg/jarvis`). **Concierge / Gatekeeper / Delegator** are kept only as *internal shorthand* for what Jarvis is allowed
to do at each stage (observe → answer → act). This spec builds **Jarvis at the Concierge tier: read + post, observe-only**.

## Problem

The cockpit can dispatch and monitor a fleet (Channels talks, Cockpit watches), but reading the state of a channel's
workers is still manual: you scan the timeline and the roster and assemble "who's up, who's blocked, who's done" in your
head. The two real costs the orchestrator roadmap names are *"which task is this / what's it doing?"* and *"is the work
correct?"*. Jarvis's first tier attacks the first cost: **on request, it reads the channel's fleet state and posts a
triage summary** ("3 workers up; api-auth blocked on you; web-auth done — review ↗").

It is deliberately the lowest-blast-radius stage: **observe-only, never acts.** It reads and posts; it does not answer
asks (Gatekeeper) or dispatch/steer (Delegator). Shipping and living in the read-only tier is how the manager earns
trust before it is granted verbs that change things.

## Decisions (locked via brainstorming, 2026-07-01)

Settled interactively; recorded so the plan doesn't relitigate them.

- **Trigger: on-demand only in v1.** Jarvis runs when you `@mention` it. It never posts unprompted. Rationale: Jarvis is
  observe-only so auto-posting is *safe*, but every run is a headless `claude -p` call (latency + tokens) and an
  unprompted post that says nothing new is worse than silence. The high-value moment — returning to the fleet and asking
  "what's the state?" — is a pull. Auto-triggers also need a "what changed since my last summary" diff to avoid
  repeating themselves; that machinery is not worth committing to before the summary quality is proven.
- **v1.1 (deferred, not built): one auto-trigger on the fleet going all-idle** — the natural "here's where everything
  landed" wrap-up. Explicitly *not* auto-posting when a worker enters `asking`: that moment is already surfaced loudly
  (the inline ask row + the `liveAskingCountAtom` badge), so a Jarvis post there is redundant. All-idle is the one state
  with no existing signal.
- **Scope: per-channel.** A Jarvis summary covers only the workers *this channel* dispatched (its `dispatch`/`directive`
  message `RefORef`s resolved against the roster), not the whole fleet. A whole-fleet digest posted into one project
  channel is really a Cockpit-surface feature wearing a channel's clothes; it is out of scope. Consequence (accepted): a
  worker launched outside any channel (straight from the New Agent launcher) does not appear in a channel's Jarvis
  summary — correct, since Jarvis is a channel participant and sees what the channel did.
- **Implementation: Approach A — a one-shot backend function reusing `pkg/consult` exec.** No worktree, no persistent
  process, no MCP tool surface. The roadmap prescribes exactly this for the Concierge tier ("build the deterministic
  fleet-query primitive first; model for judgment, code for plumbing"). The agent-as-participant-with-MCP-verbs pattern
  is the *Delegator's* substrate, built when there are real actions to gate.
- **Claude-only.** Jarvis always runs `claude` (per the agent-manager brainstorm). No runtime choice in the `@jarvis`
  gesture.
- **Model for judgment, code for determinism.** The FE builds the fleet snapshot deterministically; the model only
  phrases it. The model never computes who is blocked — it is handed the answer.

## Architecture / data flow

```
you type "@jarvis"  ─▶ planMessage → {kind:"jarvis", focus?}
   (or "@jarvis what's blocked?")        │
                                         ▼  jarvisactions.ts (FE, impure)
   buildFleetSnapshot(channel, agents) ──┤   deterministic: resolve the channel's
     → []WorkerState  (pure, vitest)     │   dispatch/directive RefORefs (tab:<id>)
                                         │   against liveAgentsAtom → state/task/ask
   buildJarvisPrompt(snapshot, timeline)─┤   pure → prompt string
                                         ▼
   JarvisCommand{channelId, prompt} ─────▶ pkg/jarvis (Go): runs headless `claude -p`
     stream chunks → ephemeral row        │   via consult's exec, streams reply,
     (reuse consultStreamsAtom pattern)   │   posts author:"jarvis" kind:"jarvis"
                                          ▼
   channel message log  ◀── persisted "jarvis" message (WOS live-append)
```

Jarvis is a **channel participant you `@mention`**, matching the roadmap's "the manager is just another participant."
The trigger is one more branch in the same `planMessage` grammar that already routes `@claude` (dispatch), `@<name>`
(steer), and `ask @codex` (consult).

## The deterministic fleet-query primitive

A pure function, the heart of the Concierge tier and (later) the read half of the manager's substrate:

```ts
interface WorkerState {
    name: string;          // roster label
    state: string;         // "working" | "asking" | "idle" | "done" | "gone"
    task?: string;         // ai-title / current task if known
    askText?: string;      // the pending question, when state === "asking"
    oref: string;          // tab:<id> — for the row's ↗ link
}
buildFleetSnapshot(channel: Channel, agents: AgentVM[]): WorkerState[]
```

Resolution: walk `channel.Messages`, collect `RefORef` of kind `dispatch`/`directive` (`tab:<id>`), de-duplicate by
oref (a channel steers the same worker repeatedly), resolve each against `agents` (`liveAgentsAtom`). A dispatched oref
with no matching live agent resolves to `state:"gone"` (its terminal exited). This is the same resolution the 2-pane
redesign's `channelHasAsk` attention-dot performs, one step richer (full state + task + ask, not just "any asking").

`buildJarvisPrompt(snapshot, recentTimeline)` composes the snapshot plus a capped slice of recent channel messages into
the prompt handed to `claude -p`. Capping mirrors consult's `maxContextMessages`/`maxContextChars`.

## Backend — `pkg/jarvis` + `JarvisCommand`

- **`JarvisCommand{channelId, prompt}` → streaming `JarvisChunk{text}`** (mirrors `ConsultCommand`). It runs `claude`
  headless through consult's exported headless-run/exec, streams reply chunks to the caller, and on completion posts a
  single `ChannelMessage{kind:"jarvis", author:"jarvis", text:<reply>, reforef:""}` to the channel (persisted via the
  existing `PostChannelMessage` path / wstore, live-appended via `Event_ChannelMessage`).
- **Reuse, don't fork.** `pkg/jarvis` imports consult's execution layer (the `runPipe`/`runPty`/wait machinery in
  `pkg/consult/exec.go`) rather than duplicating it. Orchestration differs (author/kind, prompt source); execution is
  shared. If consult's run entry is not yet exported in a reusable shape, the plan extracts a thin exported
  `consult.RunHeadless(ctx, runtime, prompt, emit) (string, error)` and has both callers use it — a refactor scoped to
  making the existing primitive reusable, not new behavior.
- **`pkg/jarvis` is the home for the future tiers.** Gatekeeper (auto-answer) and Delegator (dispatch/steer) grow here.
  v1 adds only the summarizer.
- **Timeout/error** reuse consult's fixed path (the `postConsultReply` error/timeout handling): on failure or the ~120s
  cap, Jarvis posts a jarvis message carrying the error instead of hanging.

## Frontend

1. **`channelmessages.ts`** — add a `jarvis` branch to `planMessage`: a leading `@jarvis` mention yields
   `{kind:"jarvis", focus: body}` (empty `focus` = "summarize this channel"). Add `"jarvis"` to the reserved handles so
   it is not mistaken for a runtime dispatch or a roster steer. Pure; vitest.
2. **`jarvismessages.ts`** (new) — `buildFleetSnapshot` + `buildJarvisPrompt`, both pure. vitest.
3. **`jarvisactions.ts`** (new) — the impure send path: build snapshot from `activeChannelAtom` + `liveAgentsAtom`; if
   empty, short-circuit and post a plain jarvis message with **no model call**; otherwise build the prompt, call
   `JarvisCommand` with the consult-style RPC timeout (`~130s`), stream chunks into an ephemeral row (reuse the
   `consultStreamsAtom` pattern, keyed by a jarvis request id), and let the backend persist the final jarvis message.
   Mirrors the consult branch already in `channelactions.ts`.
4. **`channelssurface.tsx`** — render `kind:"jarvis"` as a distinct row (jarvis avatar + color via the redesign's
   `avatarColor`, an assistant treatment); add `"jarvis"` to the composer's `@mention` autocomplete as a pinned
   participant. Content is rendered as markdown prose (same renderer as consult replies). @theme tokens only.

## Components (isolation)

1. `planMessage` jarvis branch (FE, pure) — routing.
2. `buildFleetSnapshot` + `buildJarvisPrompt` (FE, pure) — the deterministic fleet-query primitive.
3. `jarvisactions.ts` (FE, impure) — snapshot → prompt → `JarvisCommand` → stream → done.
4. `JarvisCommand` / `pkg/jarvis` (Go) — reuse consult exec; post `author:"jarvis"`.
5. jarvis message row + composer autocomplete entry (FE view).

## Error handling

- **Empty channel (no dispatched workers)** → FE short-circuits: post a plain jarvis message ("No workers dispatched in
  this channel yet"); no `claude` call.
- **`claude` not installed / headless failure / ~120s timeout** → reuse consult's error+timeout path; the jarvis row
  shows the error, never hangs, and the channel never breaks (mirror, don't pre-validate).
- **Unknown/malformed mention** → falls through to a plain post (existing `planMessage` behavior).
- **Snapshot resolves a dispatched oref to no live agent** → that worker appears as `state:"gone"` in the summary, not
  an error.

## Testing / verification

- **vitest:** `buildFleetSnapshot` — workers resolved from dispatch/directive refORefs, dedup by oref, state mapping
  (working/asking/idle/done/gone), empty channel; `buildJarvisPrompt` — snapshot + capped timeline composition;
  `planMessage` — `@jarvis` with and without a focus body, and that `jarvis` is not treated as a runtime/steer target;
  jarvis-row render.
- **Go:** `JarvisCommand` posts `author:"jarvis"`, reuses the consult exec layer, and its error/timeout path posts an
  error message rather than hanging.
- **Typecheck:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (baseline has 3 pre-existing
  `api.test.ts` errors).
- **CDP (live dev app):** in a channel with live workers, `@jarvis` streams a triage summary that persists as a jarvis
  row; `@jarvis what's blocked?` produces a scoped read; an empty channel short-circuits to a plain jarvis message with
  no model call.

## Deferred (noted, not built)

- **v1.1 all-idle auto-trigger** — the one proactive post, added after the summary quality is proven.
- **Structured / clickable `↗` links** in the summary — v1 is prose; turning named workers into jump links needs
  structured model output and is deferred.
- **Backend fleet-query as an MCP tool** — the manager-as-agent read primitive belongs to the acting tiers
  (Gatekeeper/Delegator), where an actual Jarvis agent calls it as a tool; v1 builds the snapshot on the FE from data it
  already has.
- **Any write/act verb** (answer-ask, dispatch, steer performed *by* Jarvis) — Gatekeeper and Delegator; explicitly not
  this tier.

## Implementation outline (writing-plans will expand)

1. `pkg/jarvis` + `JarvisCommand` (streaming) reusing consult's exec (extract `consult.RunHeadless` if needed); post
   `author:"jarvis" kind:"jarvis"`; Go tests; `task generate`.
2. `jarvismessages.ts`: `buildFleetSnapshot` + `buildJarvisPrompt` (pure) + vitest.
3. `planMessage` jarvis branch + reserved handle + vitest.
4. `jarvisactions.ts`: empty-channel short-circuit; snapshot → prompt → `JarvisCommand` streaming (consult-style
   timeout); ephemeral row via the `consultStreamsAtom` pattern.
5. `channelssurface.tsx`: jarvis row rendering + composer autocomplete entry; @theme tokens.
6. Tests + CDP verify the `@jarvis` → snapshot → summary → persisted-row loop, plus the empty-channel and error paths.
