# Lead-Authored Task Routing — Design & Roadmap

Status: draft, awaiting review. Date: 2026-08-19.

## The problem in one line

The orchestrator engine (`pkg/orchestrate`) can run a DAG of tasks across multiple harnesses, but
the task's launch form (`RunSpec`) carries only `Runtime`, `Mode`, and `Goal` — no per-task model.
There is no way to route a task to the right harness + model, and no mechanism to recover when the
chosen route proves wrong. This doc decides who routes, when, and how to recover.

## The decision (result of the brainstorming thread)

**The orchestrator lead decides harness + model per task at DAG-authoring time, as free fields in
the DAG it already writes. The engine honors them deterministically. Same-tier retry + typed
`blocked` is the floor for author-time misses; a model hop is an explicit `escalate` verb
judged by the lead/human, not an automatic policy. No difficulty classifier. No difficulty
sniff. No runtime per-task routing. No automatic model-switch escalation (cache-miss sink).**

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
- An automatic `flash→pro` hop is a guaranteed prompt-cache miss (`taskPrompt` = goal +
  Description + HeadlessContract, 2–4k prefix). `deepseek-v4-flash` is flaky on tool shape
  but often recovers on a same-tier retry that keeps the cache (≈90% input discount). Auto-hop
  turns a 1¢ flake into a 10¢ miss every time, and a 10-task DAG into a token sink. So the
  engine retries same tier once for tool errors, otherwise blocks — the lead decides if the
  miss is worth paying.

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

Not every harness runs every model. A small table of valid `(harness, model)` pairs derived from
`harness.Lookup(RunWorkerCapable)` × `consult.SpecForTier` (Tier `cheap/mid/capable`) is the single
source of truth the spawn path validates against. Raw model ids are not the vocabulary — tier is;
`RunSpec.Model` stays a free string for extensibility but the matrix normalizes it through the tier
table. The lead's stamp must resolve to a valid pair; an invalid or empty stamp falls back (empty →
harness default tier; unknown harness → owner's harness).

### 3. Spawn passthrough

Thread the resolved `(harness, model)` through `childRunFromSpec -> jarvis.SpawnRunWorker`. Model
selection is currently a property of the harness/runtime config (e.g. the per-tier pi-headless pin,
`f00eafa4`); this decouples model from harness at the spawn axis without changing how either is
configured.

### 4. Authoring affordance

`wsh jarvis dag submit` already accepts the DAG JSON the lead writes; `Model`/`Harness` are just
new per-task fields. `import` passthrough maps them from pitasks if present. The lead stamps routes
while writing tasks — no new authoring tool.

### 5. Same-tier retry + typed `blocked`; explicit `escalate` verb (replaces auto-hop)

No automatic model switch. The engine's only automatic recovery is a **same-tier retry** for
transient tool errors (same `RunSpec`, same worktree, prefix-cache hit). Every other terminal
signal goes to `blocked` and wakes the lead (`DagEventBlocked` + control file + `run:event
 dag_blocked`). A model hop is an explicit `wsh jarvis dag escalate <task> [--tier mid|capable]`
verb — `RetryTask` + patch `TaskNode.RunSpec` before `MarkPending` — judged by the lead/human
who sees the DAG + failure kind + cost. Reuses the existing retry/sendback/blocked machinery; a
policy + one verb, not a new subsystem. Deterministic: Go observes the kind, the lead judges the
hop.

Typed handling (pure `escalate(kind, attempts) → action`, no model call):

| Kind | 1st failure | 2nd consecutive same kind | 3rd → |
|---|---|---|---|
| `tool_call_error` (common on `flash`) | retry same tier (cache hit) | `blocked` (lead may `escalate`) | `blocked` |
| `stalled` / `timeout` / `context-window` | `blocked` (same tier is provably stuck) | — | — |
| `gate sendback` ("too hard") | `blocked` | — | — |
| `test/verify failed` / `blocked-merge` | `blocked` (bigger model won't fix logic) | — | — |

Per-task `Attempts` + `LastFailureKind` on `TaskNode` persist the count in the `TaskGroup` blob
(survives lead death). Global `g.Failures >= MaxConsecutiveFailures(3)` remains the DAG-level
circuit-break and is not bypassed by per-task retries.

Why not auto-hop: a hop is always a full prefix miss (2–4k `taskPrompt`), while a same-tier retry
keeps the cache. Auto-hop on every `failed` turns flash flakiness into a token sink; a judged hop
pays the miss only when the lead has evidence it's worth it.

## What this is NOT

- Not a difficulty classifier (a model call rating tasks up front) — rejected, YAGNI.
- Not a deterministic difficulty sniff — dropped; the lead subsumes it.
- Not live per-spawn routing by the running lead — would reintroduce the single point of failure
  the engine exists to remove. Author-time only, plus the explicit `escalate` verb for the blocked
  case.
- Not an automatic model-switch escalation — rejected (cache-miss token sink on flash flakiness);
  same-tier retry is automatic, a hop is judged.
- Not a rewrite of `recomputeStatus`/phases or the engine core — a field, a passthrough, a retry
  policy + one verb.

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

### Phase 2 — Same-tier retry + typed `blocked`; explicit `escalate` verb

- Policy: `tool_call_error` → retry same tier once (cache hit), then `blocked`; `stalled`/
  `timeout`/`context-window`/`gate sendback`/`test failed` → `blocked` immediately. No automatic
  model hop.
- Verb: `wsh jarvis dag escalate <task> [--tier mid|capable]` — patches `TaskNode.RunSpec`,
  resets `RunID`/`Attempts`, `MarkPending`, reuses worktree. Lead/human judged; `blocked` already
  wakes the lead.
- Reuse existing retry/sendback/blocked machinery; `escalate` is `RetryTask` + `RunSpec` patch.
- Tests: tool error retries same tier then blocks; stall blocks without retry; `escalate` patches
  tier and re-queues; global `Failures` circuit-break still respected; typed decision is pure
  `kind × attempts → action`.
- Exit: a flaky cheap task recovers without a miss; a hard task blocks for a judged hop instead of
  silently sinking tokens.

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

1. Capability matrix shape: tier-derived table (`harness` × `consult.Tier`) vs raw hardcoded ids? (Lean
   tier-derived for v1 — ids drift, tiers are the stable pricing/bucketing vocabulary.)
2. `escalate` cap: how many judged hops before the task is terminal? (Default: one `flash→pro` hop
   per task, then `blocked` to human; the global `MaxConsecutiveFailures(3)` remains the DAG cap.)
3. Should `wsh jarvis merge`/evidence tag which model produced each commit (Phase 3 overlaps
   evidence)? Proposed yes, only because it makes Phase 4's gate (`cost/outcome per (stampTier,
   runTier, cached%)` via `usagestats`) possible.
