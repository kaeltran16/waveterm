# Channels Runs — Escalation Guidance (Piece 4)

**Date:** 2026-07-05
**Status:** Design — awaiting user review
**Surface:** `pkg/jarvis/` (classifier, run engine, gatekeeper watcher) + one `wshserver` call site + regenerated bindings
**Parent:** `2026-07-04-channels-goal-driven-delegation-design.md` (Piece 4 of 5)
**Depends on:** Piece 1 — Run engine (`Run`/`RunPhase`, `CreateRun`/`AdvanceRun`/`CancelRun`, `BuildPhasePrompt`, `EnsureWorkers`); Piece 3 — Jarvis profile (`ResolveProfile`, `LoadGlobalProfile`, `OverrideFromMeta`, `JarvisProfile.Principles`).

## Problem

Piece 3 made principles *storable, editable, and resolvable* but deliberately **inert** — no model consumes them. Two consequences today:

1. **Phase workers ignore the principles.** `BuildPhasePrompt` (`run.go:185`) emits only skill + goal + prior artifacts. A run's workers do the work with no line of sight into how the user wants judgment calls made.
2. **The classifier ignores the principles.** `BuildClassifyPrompt` (`classify.go:31`) weighs a fork against generic rules ("escalate if irreversible / scope-changing / a judgment call"), not the project's own principles — so it can't recognize a *principle-significant* fork (e.g. band-aid vs. refactor) or prefer the principle-aligned option when it does auto-answer.

There is also a structural gap Piece 1 explicitly deferred here: **run-phase workers are invisible to the gatekeeper.** `ResolveGatekeeperChannel` (`resolve.go:37`) matches an asking worker to a channel only via a `dispatch`/`directive` *chat message* whose `RefORef` equals the worker oref. Run workers are recorded on `phase.WorkerOrefs`, never as chat messages — so a run worker's `AskUserQuestion` resolves to no channel and is dropped by Jarvis entirely. Without this, making the classifier principle-aware has no effect on runs, because the classifier never runs for them.

## Goals

- **Principle-aware phase prompts.** Each run phase worker's prompt carries the run's resolved principles.
- **Principle-aware classifier.** `Classify` weighs the resolved principles: escalate principle-significant forks; when it does auto-answer, prefer the principle-aligned option. Fail-safe contract unchanged.
- **Gatekeeper ↔ run-worker coupling.** A worker whose oref matches a run's phase `WorkerOrefs` resolves to that channel, so its asks are classified/auto-answered/escalated like any ad-hoc dispatch worker.

Backend-only. No new UI: the Runs view already surfaces a worker's live ask via the roster (Piece 2 `phaseThread.showAsk` + `AnswerBar`), and escalation cards already render in the Chat view.

## Non-goals (this piece)

- **No change to the deterministic pre-filter.** Only a single single-select question is auto-answerable (`watcher.go:91`); multi-question and multi-select asks stay human-only. Run workers inherit this unchanged. (The delivery constraint is keystroke injection into the CC TUI — `deliver.go` / `encode.go` — out of scope to change.)
- **No auto-answer trace threaded into the Runs rail.** When Jarvis auto-answers a run worker, the roster ask simply resolves and disappears; a "Jarvis answered X" card threaded under the phase is a possible follow-up, not built here.
- **No classifier model-tier change.** Running the classifier on a cheaper model (e.g. Haiku) to cut per-call priming cost is a real optimization but a separate follow-up; this piece keeps the existing `claude` invocation.
- **No recursive/descendant worker matching.** Piece 4 matches a run's *direct* phase workers. Matching a lead orchestrator's spawned *subagents* (descendants) is Piece 5, where subagents first exist. The resolver is shaped so that extension is additive (see Architecture).
- **No `@jarvis <goal>` repointing, no Pause/Edit-plan/Re-dispatch** — unrelated to escalation guidance.

## Decisions

1. **Principles are snapshotted on the Run at creation, not re-resolved per phase.** A new `Run.Principles` field is populated once in `CreateRunCommand` from the resolved profile and reused for every phase worker. This is symmetric with the playbook, which is already snapshotted at creation (`CreateRunCommand` resolves `ResolvePlaybook` into `Run.Phases`); editing the profile mid-run does not reshape a running run. It also survives a reload (state lives on the channel object) and keeps `EnsureWorkers` from having to re-load the channel.
2. **The classifier uses the channel's *live* resolved principles, not a run snapshot.** Classification is a real-time judgment reacting to a live ask, and ad-hoc (non-run) workers have no run to snapshot from — so a single resolution path (`ResolveProfile(LoadGlobalProfile(), OverrideFromMeta(ch)).Principles`) serves both run and ad-hoc workers. The minor asymmetry with decision 1 is intentional: the *worker's own prompt* must be deterministic for the run's life; the *gatekeeper's* judgment should reflect the principles as they stand now.
3. **Brainstorm-phase asks are not special-cased.** They flow through the same principle-aware classifier as any phase. Scope/judgment questions escalate (as the rules already dictate); a genuinely trivial one may auto-answer. No hard "always escalate in brainstorm" rule.
4. **Run workers are gatekept regardless of the channel's `gatekeeper:enabled` toggle.** Starting a Run is itself opting into Jarvis management, so run-worker classification is intrinsic to runs and does not require the ad-hoc gatekeeper toggle. (The message-based ad-hoc path keeps its existing toggle gate.)
5. **Pure builders stay pure.** Principles enter `BuildPhasePrompt` and `BuildClassifyPrompt` as a plain string argument, so both remain unit-testable without a profile/DB. Resolution happens at the impure boundary (`CreateRunCommand`, `Classify`).

## Architecture

### Data model (`pkg/waveobj/wtype.go`)

Add to `Run` (after `ProjectPath`):

```go
Principles  string     `json:"principles,omitempty"` // resolved at CreateRun; fed to every phase worker prompt
```

### Run engine (`pkg/jarvis/run.go`, pure)

- `NewRun(goal, workspaceId, projectPath, principles string, playbook []waveobj.RunPhase, ts int64) waveobj.Run` — gains a `principles` param, stored on the run. (Callers: `CreateRunCommand`, `run_test.go`.)
- `BuildPhasePrompt(phase waveobj.RunPhase, goal string, priorArtifacts []string, principles string) string` — prepends a principles preamble when non-empty; omits it cleanly when empty (behaves exactly as today). Preamble frames the principles as the standing judgment to apply while working the phase.

### Orchestrator (`pkg/jarvis/runexec.go`, impure)

- `EnsureWorkers` passes `run.Principles` to `BuildPhasePrompt` (`runexec.go:85`). No signature change — it already holds the `*Run`.

### Classifier (`pkg/jarvis/classify.go`)

- `BuildClassifyPrompt(q, task, channel, principles string) string` — inserts a principles section between the escalate-rules and the question: *the team's principles to weigh; escalate principle-significant forks; when auto-answering, prefer the principle-aligned option.* Empty principles → section omitted (today's behavior). Stays pure.
- `Classify` resolves principles from the channel's live profile before building the prompt: `ResolveProfile(LoadGlobalProfile(), OverrideFromMeta(channel)).Principles`. Every existing fail-safe path (no CLI, timeout, unparseable, missing index) is untouched — a resolution that yields empty principles just reproduces today's prompt.

### Gatekeeper coupling (`pkg/jarvis/resolve.go` + `watcher.go`)

- New pure resolver `ResolveRunWorker(channels []*waveobj.Channel, askingORef string) *RunWorkerMatch` where `RunWorkerMatch = { Channel *waveobj.Channel; Run *waveobj.Run; PhaseIdx int }`. It scans every channel's `Runs[].Phases[].WorkerOrefs` for `askingORef`; returns the first match or nil. **Not** gated by `MetaKey_GatekeeperEnabled` (decision 4).
  - *Forward-compat (Piece 5):* matching is factored so a descendant check (is `askingORef` a subagent spawned under a run worker?) can be added as an additional predicate without changing callers. Not implemented here — no subagents exist in pipeline mode (YAGNI).
- A run-worker task string derived from its phase (kind + skill + goal) replaces the dispatch-message `workerTaskFor` for run workers, giving the classifier context. Add `runWorkerTask(run *waveobj.Run, phaseIdx int) string`.
- `handleAsk` (`watcher.go:80`) resolution order:
  1. `ResolveGatekeeperChannel` (ad-hoc dispatch/directive, toggle-gated) — existing path, unchanged.
  2. else `ResolveRunWorker` — run path: channel = match.Channel, task = `runWorkerTask(...)`.
  Both converge on the existing pre-filter → `Classify` → deliver-or-escalate flow. The `postAnswered`/`postEscalation` cards are posted to the channel as today (they render in the Chat view; the Runs view continues to surface the live ask via the roster).

### Command wiring (`pkg/wshrpc/wshserver/wshserver.go`)

`CreateRunCommand` (currently resolves only the playbook at `wshserver.go:1776`) resolves the full profile once and threads both:

```go
resolved := jarvis.ResolveProfile(jarvis.LoadGlobalProfile(), jarvis.OverrideFromMeta(ch))
playbook := resolved.Playbook
if len(playbook) == 0 { playbook = jarvis.DefaultPlaybook() } // preserve ResolvePlaybook's empty-fallback
run := jarvis.NewRun(data.Goal, data.WorkspaceId, ch.ProjectPath, resolved.Principles, playbook, time.Now().UnixMilli())
```

No new RPC, no new `Command…Data`. `Run.Principles` rides on the `Channel` already mirrored to the frontend; regenerate bindings (`task generate`) so `gotypes.d.ts`'s `Run` gains the field.

## Data flow

1. **CreateRun:** resolve profile once → snapshot `playbook` + `principles` onto the Run → `EnsureWorkers` spawns phase 1's worker with `BuildPhasePrompt(..., run.Principles)`.
2. **Advance:** each newly-running phase's worker is spawned with the same `run.Principles` + that phase's prior artifacts.
3. **A run worker asks:** `handleAsk` → `ResolveRunWorker` matches it to the channel/run/phase → pre-filter → `Classify` (with the channel's live principles) → auto-answer the principle-aligned option, or escalate a principle-significant fork. The human answers an escalation from the Runs phase ask row or the Chat escalation card.

## Error handling / edge cases

- **Empty principles** (no global file, empty profile): both builders omit the principles section; classifier and phase prompts behave exactly as pre-Piece-4.
- **Malformed `profile:override`:** `OverrideFromMeta` already degrades to pure-global (logged, never fatal) — unchanged.
- **Classifier failure** (no CLI, timeout, unparseable, missing index): unchanged fail-safe → escalate. Principles never introduce a fail-open path.
- **Run worker gone** mid-ask: `ResolveRunWorker` still matches by recorded oref (the ask carries the oref); if the worker died the ask itself won't arrive, so no special handling.
- **A worker matches both paths** (a run worker that somehow also has a dispatch message): the ad-hoc path wins by order; harmless (same channel, same classify flow).

## Testing

Go, behavior-level (no frontend logic changes; the regenerated `Run.Principles` field is compile-checked by `tsc`):

- `BuildPhasePrompt` — includes the principles preamble + goal + skill + prior artifacts when principles are present; omits the preamble (byte-identical to today) when empty.
- `BuildClassifyPrompt` — includes the principles section when present; absent when empty; question/options/timeline still present in both.
- `NewRun` — stores `principles`; does not alias the caller's playbook (existing invariant preserved).
- `ResolveRunWorker` — matches a phase-worker oref to its run/channel/phaseIdx; returns nil for an unknown oref; matches **regardless** of the `gatekeeper:enabled` toggle; ignores non-run channels.
- `runWorkerTask` — mentions the phase kind, skill, and goal.
- `CreateRunCommand` (if covered by an existing harness) — the created run's `Principles` round-trips the resolved profile.

Existing `classify_test.go` / `run_test.go` are updated for the new signatures; all existing fail-safe classifier tests must still pass.
