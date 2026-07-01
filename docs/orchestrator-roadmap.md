# Agent Orchestrator — Roadmap

> Forward-looking decision doc. Captured 2026-06-30 during the Channels-tab brainstorm. Not a build plan — the
> sequencing and the substrate contract a future manager agent depends on. Revisit when starting orchestrator work.

## Thesis

A **manager agent** collapses N agent conversations into one and does the work the user does by hand today — the two
real costs being *"which task is this / what's it doing?"* and *"is the work correct?"*. The high-leverage endpoint is a
manager you hand goals to that spawns workers, routes between them, handles routine approvals, and surfaces only results
and genuine forks.

It has the **largest blast radius** of anything in the cockpit (it can approve wrong or irreversible actions), so it is
sequenced **last** — only after the substrate is proven and a read-only version has earned trust.

## The key architectural decision

**The manager is just another participant in the Channels surface.** It reads the same message log a human reads and
emits the same actions a human emits. If the channel's human verbs are built correctly, the manager needs **zero new
substrate** — it is an agent (in a worktree) whose MCP tools are the channel verbs.

This is why Channels is the substrate and the orchestrator is a layer on top, not a separate system. See
`docs/superpowers/specs/2026-06-30-channels-tab-design.md`.

### Substrate contract (must hold in the Channels build)

Two non-negotiables the Channels v1 must honor so the manager can attach later for free:

1. **Verbs-as-commands.** Every human channel action — post message, dispatch (`@runtime` → `launchAgent`), steer
   (`@name` → `ControllerInput`), answer-ask — is backed by a backend command (wshrpc / `wsh` subcommand), not just a
   UI click handler. These commands become the manager's MCP tool surface (same pattern as the existing `wsh
   ask-server`).
2. **Channel-as-object.** A channel is a persisted, addressable object (id + message log). A manager is "attached to
   channel X" and reads/writes it by id.

## Sequence (each stage = granting the manager-participant more of the human's verbs)

| Stage | Verbs granted | What it does | Blast radius |
|---|---|---|---|
| **Concierge** | read + post | Attached to a channel, reads the timeline + Cockpit status and posts triage/summaries ("3 workers up; api-auth blocked; web-auth done — review ↗"). Observe-only; never acts. | None (read-only) |
| **Gatekeeper** | + answer-ask | When a worker posts an **ask**, auto-answers routine ones via the existing `AnswerAgentCommand` (visible in-channel), and **escalates** genuine forks by addressing the human ("@you — your call: A or B?"). | Low (answers questions, not approvals) |
| **Delegator** | + dispatch + steer | Takes an un-`@mention`ed goal ("ship the auth refactor across api + web"), decomposes it, emits the same `@mention` dispatch actions a human would (→ `launchAgent` workers in worktrees), collects results, optionally fires a one-shot **consult** to a reviewer model, and posts the combined result. | High (spawns + manages workers) |

Each stage is additive on the *same* substrate — the progression is "widen the manager-participant's permissions," not
"build a new system."

## Build order / dependencies

1. **Channels v1** (substrate) — manually-driven dispatch surface honoring the substrate contract above.
   *Status: spec written 2026-06-30, not yet planned/built.*
2. **One-shot consult** (fast-follow on Channels) — `@runtime` → blocking cross-CLI reply + fan-out. Our own native
   `claude -p` / `codex exec` provider (inspired by `1devtool-orchestrator`, not hard-coupled to its external shim).
   Also a future-manager tool (the Delegator's "review the combined diff" step).
3. **Concierge** — first manager stage; read + post only. Build the deterministic fleet-query primitive first; keep the
   model for judgment (summarize / triage / recommend) and code for plumbing (who's waiting, fetch diff, jump).
4. **Gatekeeper** — add auto-answer / escalate over the ask channel. Needs a "make-a-rule" / routine-vs-fork classifier
   (model-judged, human-overridable).
5. **Delegator** — add dispatch + steer; the manager spawns and supervises workers end-to-end.

## Design principles (carry forward)

- **Model for judgment, code for determinism.** The model summarizes / triages / classifies / decomposes; deterministic
  code handles routing, spawning, status, and diff-fetching.
- **Earn trust before autonomy.** Read-only before answering; answering before dispatching. Each stage ships and is
  lived-in before the next.
- **One substrate.** Resist building a parallel orchestrator UI — the manager acts through the Channels surface so the
  human always sees (and can override) what it did.

## Related

- Channels spec: `docs/superpowers/specs/2026-06-30-channels-tab-design.md`
- Existing ask/answer channel (Gatekeeper reuses this): `pkg/agentask`, `docs/agents/organic-ask-setup.md`
- Feature triage (the @agent Orchestrator line item): `docs/feature-triage.md`
- Inspiration for cross-CLI `@mention` / fan-out: `~/.codex/skills/1devtool-orchestrator/SKILL.md`
