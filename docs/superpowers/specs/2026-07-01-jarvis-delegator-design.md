# Jarvis Delegator — design

Status: draft for review
Date: 2026-07-01

## Context

Jarvis is Wave's built-in fleet manager, surfaced in the Channels tab. It has an escalating
autonomy ladder, each tier adding exactly one verb:

- **Concierge** (shipped) — observe. `@jarvis` posts an observe-only fleet digest.
- **Gatekeeper** (shipped) — answer. Watches worker `AskUserQuestion`s on a gatekeeper-enabled
  channel; auto-answers routine ones, escalates real forks.
- **Delegator** (this spec) — act. Jarvis spawns and runs a worker toward a goal, not just
  observes/answers existing ones.

Delegator is the highest-leverage and highest-blast-radius tier, so autonomy is opt-in per channel.

## Key grounding finding: the spine already exists

There is **no new backend spawn to build**. The spawn / associate / isolate / steer verbs are all
shipped and proven by the existing manual channel-dispatch gesture:

- **Spawn + associate** — `launchAgent()` (`frontend/app/cockpit/cockpit-actions.ts`) does
  `WorkspaceService.CreateTab` → `SetMetaCommand(buildLaunchMeta(...))` and returns a `tabId`. The
  `dispatch` branch of `sendChannelMessage` (`frontend/app/view/agents/channelactions.ts`) already
  calls it and posts a `"dispatch"` channel message with `RefORef = "tab:<tabId>"`. That RefORef is
  exactly what `ResolveGatekeeperChannel` (`pkg/jarvis/resolve.go`) matches a worker to a channel by.
- **Isolate** — `launchAgent({branch})` routes through `CreateWorktreeCommand`, running the worker in
  an isolated worktree. This is the Fan-out per-worker workspace, for free.
- **Steer** — the `steer` branch injects into a live worker's PTY via `ControllerInputCommand` and
  records a `"directive"` message.
- **Auto-answer** — the Gatekeeper watcher (`pkg/jarvis/watcher.go`) already keys off the `"dispatch"`
  RefORef (with block→tab mapping via `channelOwnerORef`), so a Delegator-spawned worker's asks are
  auto-answered with zero new wiring when the channel has Gatekeeper on.

The block-controller-start risk is moot: manual dispatch is shipped and reliably starts the worker.

## The three modes (nested)

A single per-channel autonomy dial; each mode is a strict superset of the one below.

- **Report** — spawn ONE worker toward the goal in the channel's repo. Worker runs; human reviews and
  merges. Does not rely on Gatekeeper (though it is on at the delegator tier, harmlessly).
- **Manage** — Report + the worker self-runs to completion via Claude Code's `/goal`, and Gatekeeper
  auto-answers its routine questions as it goes. Reports when done or stuck. (Manage ⇒ Gatekeeper on.)
- **Fan-out** — Jarvis decomposes the goal into subtasks, spawns MULTIPLE workers each in its own
  worktree, tracks them, and aggregates. (Fan-out ⇒ Manage ⇒ Gatekeeper.)

The worker self-supervision is delegated to `/goal` — verified in the spike: `claude "/goal <cond>"`
runs the loop across turns until a fast evaluator confirms the condition, then self-terminates. This
removes the need for a Jarvis-side supervision loop.

## Mode selection

- **Per-channel default** — the channel's Jarvis tier (`concierge` | `gatekeeper` | `delegator`) and,
  within delegator, a default dispatch mode (`report` | `manage` | `fanout`). Mirrors the shipped
  Gatekeeper per-channel toggle.
- **Per-message override** — `@jarvis:manage <goal>` / `@jarvis:fanout <goal>` / `@jarvis:report <goal>`
  overrides the default for one dispatch.

## Data model

Channel state lives in `channel.meta` (no new waveobj type; no migration):

- `gatekeeper:enabled` (bool) — existing, unchanged; consumed by the shipped Gatekeeper resolver.
- `delegator:enabled` (bool) — new. Setting the tier to `delegator` writes BOTH
  `delegator:enabled=true` and `gatekeeper:enabled=true` (the nested-caps model). Setting to
  `gatekeeper` writes `gatekeeper:enabled=true`, `delegator:enabled=false`. Setting to `concierge`
  clears both. This keeps the shipped Gatekeeper resolution untouched and derives the UI's single dial
  from two booleans.
- `delegator:mode` (string, default `report`) — the channel's default dispatch mode.

No new `dispatch` message kind is needed — it already exists and carries the worker's tab oref.

## What is actually new

1. **Routing.** Today `@jarvis <anything>` unconditionally routes to the Concierge summary
   (`planMessage`, `frontend/app/view/agents/channelmessages.ts`). Delegator adds: in a
   delegator-enabled channel, `@jarvis <goal>` (non-empty body) routes to a *delegate* action. Because
   `planMessage` is pure `(text, roster)`, the tier check lands in `sendChannelMessage` (which has the
   channel context), and `planMessage` gains parsing for the `:mode` override suffix.

2. **Goal → task.** v1 is **pass-through**: dispatch `task = "/goal <goal text>"` and let `/goal`'s own
   evaluator interpret the natural-language goal as the completion condition. No model call for
   Report/Manage. (Deferred: a `claude -p` "sharpen the goal into a crisp verifiable condition" step,
   added only if completion detection proves fuzzy in practice.)

3. **Fan-out decompose** (the one genuinely new backend piece). A `JarvisDecomposeCommand({goal})`
   backend command — mirroring the Gatekeeper classifier's stateless `claude -p` pattern — returns an
   ordered list of subtask strings. It fails safe: on any parse/timeout/empty error, return a
   single-element list `[goal]` so Fan-out degrades to a Manage-style single dispatch rather than
   erroring.

4. **Tier/mode persistence.** A `SetChannelDelegatorCommand({channelid, tier, mode})` backend command
   mirroring the shipped `SetChannelGatekeeperCommand` — writes the derived `gatekeeper:enabled` /
   `delegator:enabled` / `delegator:mode` meta atomically and fires `SendWaveObjUpdate` so the dial
   reflects live. The UI's single tier dial and the composer's per-channel mode default both route
   through it.

5. **Mode wiring** in `sendChannelMessage`'s new delegate branch:
   - Report: `launchAgent({runtime:"claude", task:goal, projectPath})` — **plain task, no `/goal`**.
     The worker does one bounded agentic pass and stops for review; the human can continue it.
   - Manage: `launchAgent({runtime:"claude", task:"/goal "+goal, projectPath})` — **`/goal` wrapper**,
     so the worker loops across turns to completion; Gatekeeper (on at the delegator tier) auto-answers
     its routine questions. The presence/absence of the `/goal` wrapper is the sole Report↔Manage
     difference.
   - Fan-out: `JarvisDecomposeCommand` → for each subtask, `launchAgent({..., task:"/goal "+subtask,
     branch:<derived>})` (isolated worktree via `deriveBranch`) + a `dispatch` message per worker.

6. **Completion reporting.** The dispatch card reads live worker status from the roster (already
   wired). When a worker's `/goal` process exits, the cmd controller marks the block done and the
   status reporter fires — the roster shows idle/done and the card resolves. v1 relies on this existing
   signal (no new backend watcher). A "dispatch complete" Jarvis summary message is deferred.

## Architecture

FE orchestration + one backend model call, consistent with Concierge/Gatekeeper:

```
@jarvis[:mode] <goal>  (delegator channel)
  → sendChannelMessage detects delegate
      report/manage → launchAgent("/goal <goal>") + dispatch message
      fanout        → JarvisDecomposeCommand(goal) → N × launchAgent(branch) + N dispatch messages
  → worker(s) self-run via /goal
      routine asks → Gatekeeper auto-answers (existing)
  → roster reflects live status; card resolves on completion
```

Spawn stays FE-driven (proven); judgment (decompose) stays backend (pattern-consistent). Delegator is
Claude-only (`/goal` is Claude Code-specific), matching the roster's Claude-only manager assumption.

## Claude-only + runtime

The delegate branch always launches `runtime:"claude"` regardless of any mention, because `/goal` is a
Claude Code feature. A future non-Claude path is out of scope.

## Error handling / fail-safe

- Decompose failure → single dispatch of the whole goal (never blocks the user).
- `launchAgent` failure (no workspace, worktree collision) → surface the error as a channel post; do
  not post a `dispatch` message for a worker that did not start (else Gatekeeper would match a dead
  worker).
- Worktree trust gate (found in the spike): a worker in a fresh worktree hits Claude Code's first-run
  "trust this folder?" prompt. v1 accepts this as a one-time manual confirmation in the worker's
  terminal; an auto-trust affordance is deferred.

## Testing

- Pure FE: `planMessage` parses `@jarvis:mode` overrides and routes delegate vs. summary by tier
  (unit tests, vitest).
- Pure Go: `JarvisDecomposeCommand` prompt builder + `parseDecompose` (valid list, malformed →
  `[goal]`, empty → `[goal]`), mirroring `classify_test.go`.
- Live: CDP walkthrough of a real Report dispatch (`@jarvis <goal>` → worker spawned with `/goal` task,
  dispatch message present, roster shows it), and a Manage dispatch whose routine ask is auto-answered
  by Gatekeeper (reuses the proven Gatekeeper E2E path).

## Scope / phasing

- **v1**: Report + Manage (pure FE reuse, no new backend), tier dial writing the two meta booleans,
  `:mode` override parsing, Gatekeeper coupling.
- **v1.1**: Fan-out (`JarvisDecomposeCommand` + per-worker worktrees + aggregation card).
- **Deferred**: goal-sharpening model call, "dispatch complete" summary message, stall detection /
  active re-steer (beyond what `/goal` does internally), worktree auto-trust.

## Non-goals

- No new backend block-spawn (the FE path is the single source of truth).
- No new waveobj type or DB migration.
- No Jarvis auto-selecting the mode/blast-radius (autonomy level stays human-set per channel).
- No changes to the shipped Gatekeeper resolution or Concierge summary.
