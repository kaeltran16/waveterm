# Lead-Authored Task Routing — Design & Roadmap

Status: draft, awaiting review. Date: 2026-08-19.

## The problem in one line

The orchestrator engine (`pkg/orchestrate`) can run a DAG of tasks across multiple harnesses, but
the task's launch form (`RunSpec`) carries only `Runtime`, `Mode`, and `Goal` — no per-task model.
There is no way to route a task to the right harness + model, and no mechanism to recover when the
chosen route proves wrong. This doc decides who routes, when, and how to recover.

## The decision (result of the brainstorming thread)

**The orchestrator lead decides harness + model per task at DAG-authoring time, as free fields in
the DAG it already writes. The engine honors them deterministically. Reactive escalation is the
floor for author-time misses and post-authoring surprises. No difficulty classifier. No difficulty
sniff. No runtime per-task routing.**

Why this shape:

- The lead is already authoring every task (label + goal) and holds the whole plan in context; it
  is the best and cheapest judge of a task's route. Stamping `RunSpec.Model`/`RunSpec.Harness` at
  authoring time costs no new infrastructure.
- A difficulty classifier is a per-task model call whose calibration is worst exactly where it
  matters (easy-rated-but-hard tasks), and misrouting hard-as-easy is *strictly worse* than not
  routing at all. YAGNI — rejected unless evidence shows cheap-first waste biting.
- A deterministic "sniff" was considered and dropped: the lead subsumes it (it sees more signal than
  a feature score) at zero extra cost.
- The live lead must NOT be in the per-task spawn loop: that is precisely the prompt-enforced,
  lead-dependent fan-out the deterministic engine was built to remove. Author-time stamping is
  durable — it survives lead death and lives in the persisted TaskGroup.

## Design

### 1. `RunSpec` gains a model axis

`RunSpec` today (in `pkg/waveobj/wtype.go`):

```go
type RunSpec struct {
    Runtime string `json:"runtime,omitempty"` // harness; empty = run default
    Mode    string `json:"mode,omitempty"`    // quick | pipeline | orchestrator
    Goal    string `json:"goal,omitempty"`    // per-task goal; empty = task label
}
```

Add `Model string` (empty = harness/default model). Optional, author-stamped. `Runtime` already
carries the harness; `Model` disambiguates which model within it.

### 2. Harness ↔ model capability matrix

Not every harness runs every model. A small, explicit table of valid `(harness, model)` pairs is
the single source of truth the spawn path validates against. The lead's stamp must resolve to a
valid pair; an invalid or empty stamp falls back (empty → harness default model; unknown harness →
owner's harness).

### 3. Spawn passthrough

Thread the resolved `(harness, model)` through `childRunFromSpec -> jarvis.SpawnRunWorker`. Model
selection is currently a property of the harness/runtime config (e.g. the per-tier pi-headless pin,
`f00eafa4`); this decouples model from harness at the spawn axis without changing how either is
configured.

### 4. Authoring affordance

`wsh jarvis dag submit` already accepts the DAG JSON the lead writes; `Model`/`Harness` are just
new per-task fields. `import` passthrough maps them from pitasks if present. The lead stamps routes
while writing tasks — no new authoring tool.

### 5. Reactive escalation floor

If a task's stamped route fails (run failed, watchdog stall, circuit-break, gate sendback), the
engine re-runs the same task on a more capable (harness, model) from the capability matrix. This is
the backstop for author-time miscalibration and post-authoring reality. It reuses the existing
retry/sendback/failure machinery — a policy on top, not a new subsystem. Deterministic: Go observes
failure/stall and reacts; no model judges difficulty.

## What this is NOT

- Not a difficulty classifier (a model call rating tasks up front) — rejected, YAGNI.
- Not a deterministic difficulty sniff — dropped; the lead subsumes it.
- Not live per-spawn routing by the running lead — would reintroduce the single point of failure
  the engine exists to remove. Author-time only.
- Not a rewrite of `recomputeStatus`/phases or the engine core — a field, a passthrough, a policy.

## Dependencies

- The orchestrator engine (DAG + worktrees + graph) is merged and green (`pkg/orchestrate`).
- The 2026-08-16 orchestrator-redesign plan (`docs/superpowers/plans/2026-08-16-orchestrator-redesign.md`,
  27 unchecked steps) is NOT done. It is not a hard prerequisite for this work — `RunSpec` +
  passthrough stand alone — but its headless-child contract + child-ask forwarding improve the
  lead↔worker relationship this routing piggybacks on. Sequence this roadmap to not collide with it.

## Roadmap (phases)

Each phase is independently shippable; TDD. `task generate` + tsc per AGENTS.md on any wshrpc/
waveobj change.

### Phase 1 — Foundation: `RunSpec.Model` + capability matrix + passthrough

- Add `Model` field to `RunSpec` (wtype.go); `task generate`.
- Add the harness↔model capability matrix (single source of truth, tested pure function).
- Resolve + validate `(harness, model)` in `childRunFromSpec`; pass through to `SpawnRunWorker`.
- Tests: matrix validity, resolution/fallback, invalid-stamp fallback.
- Authoring just works (submit/import already accept task JSON incl. `Model`/`Harness`).
- Exit: a task stamped `{runtime, model}` spawns the intended worker; unstamped tasks unchanged.

### Phase 2 — Reactive escalation floor

- Policy: on task failure/stall/circuit-break/sendback, re-run on the next more-capable
  `(harness, model)` from the matrix, up to a cap.
- Reuse existing retry/sendback machinery; wire into the failure path.
- Tests: failure triggers escalation; stall triggers escalation; cap respected; determinism (the
  escalation decision is a pure function of task state + matrix).
- Exit: a cheap-stamped hard task fails then resumes on a capable model before the group blocks.

### Phase 3 — Surface the route

- Cockpit DAG graph shows each task's stamped route and the model/harness actually run.
- Run evidence records the effective `(harness, model)` per task (for audit + the Phase 4 gate).
- Tests: layout/state mapping reflects route; evidence carries the route.
- Exit: a human or lead can see at a glance what ran where and on what model.

### Phase 4 — Measurement gate (evidence-gated, not built speculatively)

- Instrument cost + outcome per task keyed by (lead stamp, harness, model).
- Only on evidence that cheap-first waste actually bites (hard tasks common and cheap runs costly)
  revisit a classifier or sniff. Otherwise Phase 2's floor suffices.
- This phase may be skipped entirely; it exists only to make the "no classifier" decision falsifiable.

## Open questions for review

1. Capability matrix shape: hardcoded table vs config? (Lean hardcoded const for v1.)
2. Escalation cap: how many resumptions before the task gives up to a human? (Default proposal: one
   model-step up, then circuit-break to human.)
3. Should `wsh jarvis merge`/evidence tag which model produced each commit (Phase 3 overlaps
   evidence)? Proposed yes, only because it makes Phase 4's gate possible.
