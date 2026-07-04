# Channels — Goal-Driven Delegation ("Runs")

**Date:** 2026-07-04
**Status:** Design — awaiting user review
**Surface:** `frontend/app/view/agents/` (channels* files) + `pkg/jarvis/` + `pkg/wstore`/`pkg/waveobj` + `pkg/wshrpc`

## Problem

The Channels tab is chat-first: you drive a fleet by typing verbs (`@claude`, `ask @claude`, `@jarvis`) into a composer, and the delegator tier's `fanout` mode already decomposes a goal into N subtasks (`JarvisDecomposeCommand`) launched in worktrees. But that decomposition is **fire-and-forget** — it evaporates into `dispatch` cards. There is no durable, supervisable *plan*, and no way to make Jarvis run work **the way you work** or decide **the way you'd decide**.

The goal of this feature is to make the **plan the object and chat the log**: hand Jarvis a goal, and it carries that goal through *your* process (an explicit playbook) applying *your* judgment (explicit principles), running hands-off except at deliberate checkpoints.

## Goals

- A durable, supervisable **Run** object: a goal executing through a playbook inside a channel, with visible phases and state.
- **Multiple concurrent Runs per channel** (a project channel becomes a workspace of goals) with a Run switcher.
- An explicit, editable **playbook** whose default encodes the superpowers pattern: brainstorm → plan → *review gate* → clear context → execute.
- A layered **Jarvis profile** (process + judgment): a global base file overlaid by a per-project, in-app-editable override.
- **Escalation guidance**: the profile's principles shape the gatekeeper classifier's escalate-vs-decide threshold *and* which option it auto-picks, and ride along in delegation prompts so the work itself follows the principles.
- **Autopilot with checkpoints**: Runs advance on their own, stopping only at a gate (plan review) or an escalation (a fork the principles say is yours).

**Non-goals (this spec):**
- Adaptive/inferred learning of your pattern. Acquisition is explicit-and-editable only. ("Jarvis suggests edits to your profile" is a deliberate future extension, not v1.)
- Cross-channel / cross-project Runs. A Run is bound to one channel's project.
- Any DB migration. Runs and profiles are embedded JSON on existing objects (as `messages` and card `data` already are).
- Fine visual/pixel design — the information architecture is locked (see the Frontend section + `wave-handoff/wave/project/Wave-runs.dc.html`); pixel-level styling is a separate design pass.
- Cross-run / cross-channel escalation attention (routing a waiting fork to a global "needs you" counter/titlebar). Escalations render inside their Run; a run-tab / rail status dot is the only cross-context signal for now. Deferred (old backlog item #8).

## Decisions (from brainstorming)

1. **North star = goal-driven delegation.** The Run/plan is the primary object; chat is the log threaded under it.
2. **Control loop = autopilot + checkpoints.** The natural checkpoint is the user's own plan-review gate; Runs otherwise advance hands-off.
3. **Pattern is an explicit playbook, not inferred.** The default playbook is the superpowers pipeline. Structure and gates are deterministic **code**; skills and principles are **text** handed to the model.
4. **One "Jarvis profile" concept, two parts (playbook + principles), two layers (global file + per-project in-app override).** Resolved at runtime as `merge(global, channelOverride)`. Global principles seed from the user's CLAUDE.md architecture principles.
5. **Escalation is guided by principles**, injected into the existing `pkg/jarvis/classify.go` classifier — shifting the escalate threshold and the auto-answer choice — and into dispatch/goal prompts.
6. **Brainstorm phase is autopilot-with-an-exit.** Jarvis drafts a design doc non-interactively by default; you may open a dialogue to refine it; it **escalates a clarifying question** when the goal is too ambiguous to spec safely. Not a hard blocking gate every Run.
7. **Runs launch two ways:** delegator-tier `@jarvis <goal>` (evolves today's fanout) and an explicit **New Run** action (goal + playbook picker).
8. **No DB migration.** Runs are a JSON `runs` array on the channel object; the profile override is a JSON blob in channel meta.
9. **Locked IA = the "converged" layout** (`Wave-runs.dc.html`, Turn 2): channels rail + Chat⇄Runs toggle + run tabs + vertical phase rail with everything threaded inline + slide-in profile. See the Frontend section.
10. **Distinguish deliberate gate from reactive escalation.** The plan **review gate** (you planned to stop here) and the **fork escalation** (unplanned, needs your call) must not read as the same amber card — differ by accent/icon. Both differ from the neutral brainstorm clarifying-question.
11. **Blocked-card recovery actions are in scope.** "Re-dispatch" and "Take control" (jump into the worker PTY via `ControllerInputCommand`) are the blocked-state actions; "Re-dispatch with access" (a permission-scope concept) is **deferred** — a plain re-dispatch is v1.

## Architecture

### Data model (Go — `pkg/waveobj`)

Embedded JSON on the existing channel object (no migration; mirrors `ChannelMessage`):

```
Run {
  Id          string
  Goal        string
  PlaybookId  string
  Status      string   // planning | awaiting-review | executing | blocked | done | failed | cancelled
  Phases      []RunPhase
  CreatedTs   int64
}

RunPhase {
  Kind        string   // brainstorm | plan | execute | custom
  Skill       string   // e.g. "superpowers:writing-plans"
  State       string   // pending | running | blocked | done | failed | skipped
  Gate        bool     // pause for human review before leaving this phase
  FreshCtx    bool     // spawn a fresh worker for this phase (the "clear context" boundary)
  WorkerOrefs []string // tab:<id> workers this phase spawned
  Artifacts   []string // produced paths: spec doc, plan doc, ...
}
```

The channel gains `Runs []Run` and `meta["profile:override"]` (JSON). `RunPhase.WorkerOrefs` reuse the `tab:<id>` RefORef scheme, so `buildFleetSnapshot` and the gatekeeper's `ResolveGatekeeperChannel` couple Run workers with no new wiring. Regenerate TS (`task generate`).

### The playbook & profile (resolution)

- **Global base file:** a `jarvis-profile.md` in the config home (`WAVETERM_CONFIG_HOME`), alongside the other wconfig files — the default playbook (phase list) + principles text. Principles default-seed from the user's CLAUDE.md architecture principles. (Config-home keeps it dev/packaged-isolated and editable outside the app; the plan confirms the exact wconfig wiring.)
- **Per-project override:** `channel.meta["profile:override"]` — an in-app-edited JSON blob that can replace the playbook and add/override principles.
- **Resolver** (`pkg/jarvis`, pure + unit-tested): `ResolveProfile(global, channelOverride) -> Profile{ Playbook []RunPhase, Principles string }`.

The **default playbook** (superpowers pattern):

| # | Kind | Skill | Gate | FreshCtx |
|---|---|---|---|---|
| 1 | brainstorm | `superpowers:brainstorming` | no (escalates on ambiguity) | no |
| 2 | plan | `superpowers:writing-plans` | **yes** (plan review) | no |
| 3 | execute | `superpowers:executing-plans` | no | **yes** (clear context) |

### Run engine (Go — `pkg/jarvis`) — backend-owned execution

A Run advances as a deterministic state machine; the model does the phase *work*, code does the *routing* **and the spawning**. The engine owns the whole loop server-side (the Run survives a frontend reload); the frontend is a view + a reporter of approvals/completion. The spawn primitives all exist in Go: `wcore.CreateTab` (layout-aware), `wstore.UpdateObjectMeta` (block/tab meta), `blockcontroller.ResyncController(..., force=true)` (force-starts the CLI headlessly — controllers otherwise start lazily on frontend resync).

- **Create:** goal → new `Run{status: planning}` with phases from the resolved playbook → spawn phase 1's worker.
- **Run a phase:** spawn a **claude** worker (runs are claude-only) whose prompt = the phase skill + the resolved **principles** (piece 4) + the goal + prior-phase artifacts. `FreshCtx` phases spawn a brand-new worker (no carried context) — the "clear context" boundary is automatic since each phase is its own worker. The worker's `tab:<id>` is recorded on the phase's `WorkerOrefs`.
- **Phase completion is reported-in, not auto-detected** (v1 decision): a human action in the UI or the external `~/.claude` hook (the same hook chain the Gatekeeper uses) calls `AdvanceRun{action: complete}` with the produced artifact path. On completion the engine records the artifact and advances, unless the phase is a `Gate`. (Auto-detection off worker exit / artifact files is a deliberate later extension.)
- **Spawning stays out of the DB-update callback:** apply the pure state transition and persist it, read the run back, spawn workers for any newly-`running` phase that has no worker yet, then persist the attached orefs — a second write, never nesting tab-creation writes inside the channel update.
- **Gate:** on reaching a gated phase boundary, set `status: awaiting-review` and post a **review card** (see FE). The Run does not proceed until the user approves.
- **Escalation:** during any phase, a worker `AskUserQuestion` flows through the existing gatekeeper watcher; `Classify` now receives the **principles** so a principle-significant fork (e.g. band-aid vs. refactor) escalates instead of auto-resolving. The escalation card is keyed to the Run/phase.
- **Brainstorm ambiguity:** the brainstorm worker escalates a clarifying question (same escalation path) when it can't spec safely; otherwise it emits a draft spec and advances.
- **Controls:** pause / cancel / steer operate on the Run (cancel stops pending phases; steer injects into the current worker via the existing `ControllerInputCommand`).

### Escalation guidance (`pkg/jarvis/classify.go`)

`Classify` gains the resolved **principles** as prompt context. It already fails safe (escalates on error); with principles it also escalates principle-significant forks and, when it does auto-answer, prefers the option the principles favor (clean/long-term). The same principles are appended to every dispatch/goal prompt built for Run phases.

### wshrpc commands (`pkg/wshrpc` → `wshserver` → generated api)

Mirror the existing channel commands (`CreateChannelCommand`, `SetChannelTierCommand`):

- `CreateRunCommand { channelId, goal, playbookId? }` → creates + starts a Run.
- `AdvanceRunCommand { channelId, runId, phaseIdx, decision }` → approve / edit / send-back at a gate (`decision` carries edited-plan reference on edit).
- `CancelRunCommand { channelId, runId }`.
- `SetChannelProfileCommand { channelId, profileJson }` → writes `meta["profile:override"]`.

### Frontend (`frontend/app/view/agents/`)

Pure helpers (extend `channelmessages.ts` / new `runmodel.ts`, all unit-tested):
- `planMessage` extended: delegator `@jarvis <goal>` → a `create-run` plan (was: one-shot fanout).
- `resolveProfile(global, override)` mirror of the Go resolver (or FE reads the resolved profile from the backend — decided in plan).
- Run/phase derivations: current phase, gate-pending, per-phase worker states (reusing `buildFleetSnapshot`).

**Locked information architecture** — design reference: `wave-handoff/wave/project/Wave-runs.dc.html` (Turn 2 "converged"). Components in `channelssurface.tsx` (+ split files as they grow — the surface is already large):

- **Channels rail** (left, slim) — unchanged channel list; channel switching is preserved (the Run list does NOT replace it).
- **Chat ⇄ Runs toggle** (center header) — switches the center pane between the Runs view and the ad-hoc Chat view.
- **Runs view:**
  - **Run tabs** — horizontal, multiple Runs per channel, + a **New run** action.
  - **Run header** — goal + status pill + Steer / Pause.
  - **Compact stepper** — collapsible one-line phase summary.
  - **Vertical phase rail** (the body) — phases stacked top→bottom; each phase shows state, skill, artifact chip, and threaded *inline under its phase*: the **review-gate card** (approve / edit / send-back + artifact path — reuses the `OptionList`/escalation-card pattern in `jarviscards.ts`, `AdvanceRunCommand` on approve), the **brainstorm clarifying-question card** (pending + resolved), the **context-clear boundary** divider ("context cleared → fresh worker"), **execute worker rows**, the **mid-execute fork escalation** (clickable options; reuse `EscalationRow`), the **blocked card**, and the **ship** marker.
- **Chat view** — the existing composer + ad-hoc verbs (post / `ask @claude` consult / `@claude` dispatch / steer), explicitly "not a run"; asking for work spins up a Run.
- **Jarvis profile** — a **slide-in panel** (toggled from the header, NOT a fixed column — reuse the `CollapsibleRail` pattern / auto-hide): editable playbook phases (skill field, GATE/FRESH-CTX tags, add-phase), editable principles, Save / Reset-to-global, "merged: global + this project" framing + override badge. Persists via `SetChannelProfileCommand`.
- **Composer** — Run-aware: in the Runs view it starts/steers a Run (with a playbook picker); in the Chat view it drives the ad-hoc verbs.

## Data flow

1. `@jarvis <goal>` (delegator) or **New Run** → `CreateRunCommand` → Run created, phase 1 (brainstorm) worker dispatched with skill + principles + goal.
2. Brainstorm worker emits a draft spec (artifact) → advance to plan; or escalates a clarifying question → gatekeeper escalation card → user answers → worker resumes.
3. Plan worker emits a plan doc (artifact) → phase is gated → `status: awaiting-review` → review-gate card posted.
4. User approves → `AdvanceRunCommand` → execute phase spawns a **fresh** worker (clear context) with the plan artifact + principles; may fan out into parallel subtask workers in worktrees.
5. Any worker `AskUserQuestion` → gatekeeper `Classify` (now principle-aware) → auto-answer (principle-favored option) or escalate (principle-significant fork), keyed to the Run/phase.
6. Execute completes → `status: done`. Cancel/pause/steer available throughout.

## Error handling / edge cases

- **Legacy channels** (no `runs`): render exactly as today; Runs are additive.
- **Worker gone** mid-phase: phase → `failed` with a resumable note; Run → `blocked` (not silently "done").
- **Missing/empty profile:** fall back to the built-in default playbook and empty principles (classifier behaves as today).
- **Malformed `profile:override` JSON:** ignore the override, use global; surface a non-blocking warning (never crash the surface).
- **Classifier failure:** unchanged fail-safe — escalate, never silently auto-answer.
- **Gate abandoned:** an `awaiting-review` Run persists across reloads (state is on the channel object); it simply waits.
- **Artifact not produced** by a phase that should emit one: phase → `failed` (do not advance on a phantom artifact).

## Testing

Pure vitest (behavior, not internals):
- `planMessage` — delegator `@jarvis <goal>` → `create-run`; other verbs unchanged.
- `resolveProfile` — merge precedence (override wins), empty override → global, malformed → global + warning.
- Run derivations — current phase, gate-pending, phase→worker-state mapping.

Go:
- `ResolveProfile` — layer precedence, default-seed from principles.
- Run engine — phase advance, gate halt (`awaiting-review`), fresh-context spawn on `FreshCtx`, cancel stops pending phases, artifact-required phases don't advance without an artifact.
- `Classify` with principles — a principle-significant fork escalates; a routine ask auto-answers the principle-favored option; classifier error still escalates.

Final: CDP visual check against the live dev app (Run switcher, phase pipeline, review-gate approve/edit/send-back, escalation keyed to a phase, profile editor round-trip).

## Delivery / decomposition

This is too large for one implementation plan. Suggested build order, each its own plan → implementation cycle:

1. **Run model + engine backend** — `Run`/`RunPhase` types, playbook resolver, state machine, `CreateRun`/`AdvanceRun`/`CancelRun` commands. Prove with a linear default playbook and gate halt (no profile yet).
2. **Run UI** — Run switcher, phase pipeline, review-gate card, activity threading. `@jarvis <goal>` + New Run entry points.
3. **Jarvis profile** — global file + per-project override, resolver, in-app profile editor, `SetChannelProfileCommand`.
4. **Escalation guidance** — wire principles into `Classify` and dispatch/goal prompts; brainstorm-ambiguity escalation.

## Files touched (indicative)

- `pkg/waveobj/wtype.go` — `Run`, `RunPhase`, `Channel.Runs`.
- `pkg/wstore/wstore_channel.go` — Run CRUD, profile-override write.
- `pkg/jarvis/` — Run engine, `ResolveProfile`, `classify.go` principle injection, brainstorm-ambiguity escalation.
- `pkg/wshrpc/wshrpctypes.go`, `wshserver`, generated api — the four commands above.
- `frontend/types/gotypes.d.ts` — regenerated.
- `frontend/app/view/agents/channelmessages.ts` — `planMessage` create-run branch (+ tests).
- `frontend/app/view/agents/runmodel.ts` (new) — Run/phase derivations + profile resolve (+ tests).
- `frontend/app/view/agents/channelssurface.tsx` (+ split components) — Run switcher, phase pipeline, review-gate card, profile editor, activity threading.
- `frontend/app/view/agents/channelactions.ts`, `channelsstore.ts` — Run lifecycle calls, atoms.
