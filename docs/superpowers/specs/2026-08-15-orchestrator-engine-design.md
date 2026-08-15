# Orchestrator Engine — DAG Scheduling, Managed Worktrees, Graph View

Design captured 2026-08-15 during the orchestrator redesign brainstorm (informed by the
waveterm-vs-orca comparison in `docs/orca-vs-waveterm-comparison.md`). Not a build plan —
sequencing lives in the rollout section and will be expanded by writing-plans.

## Context

The delegator fan-out shipped: an orchestrator lead (an agent in a PTY) dispatches child runs via
`wsh jarvis run`, receives one-line `[jarvis] child <id> ... -> done|cancelled` notifications, and
never reads child transcripts. Known structural gaps vs. what the comparison surfaced:

- **Dependencies and parallelism are prompt-enforced, not structural.** The lead prompt says "keep at
  most 2-3 in flight, only start a unit whose dependencies have reported done" — rules with no
  enforcement. If the lead dies, everything stalls.
- **No per-run worktree ownership by waveterm.** Workers land in the workspace (claude may create its
  own `.claude/worktrees/g*`); evidence is anchored to shared-branch commit ranges, the class of bug
  that produced the fan-out over-attribution issue (6a, resolved 2026-07-21 — structurally prevented
  here, not patched).
- **No engine->lead channel.** The lead is only woken by lines typed into its PTY.
- **No orchestration UI.** The cockpit shows runs as cards and jarvis records, but no structural view
  of a fan-out.

## Goals

1. **Deterministic orchestration engine** (Go, in wavesrv): a DAG of tasks with real dependencies,
   engine-enforced parallelism, decision gates, failure recovery, and lead-death resilience.
2. **Managed worktree isolation**: waveterm itself creates/merges per-run git worktrees for every
   harness, with per-run evidence captured before merge.
3. **Graph UI**: a per-run DAG view in the cockpit — opened from the run's cards, not a new nav
   surface.
4. **Pi-first lead**: v1 integration centers on pi as the lead (control-dir events, pi-tasks import);
   the engine API itself is harness-agnostic.

## Non-goals

- Remote/federated workers (no connection field on Run yet — open issue 5 stays blocked on its own
  prerequisite).
- Replacing `recomputeStatus` or the phase model; the DAG is a layer on top of runs, not a rewrite.
- Hand-rolling the graph interaction layer (zoom/pan/selection/edge routing) — rendering comes
  from `@xyflow/react` (MIT, controlled mode); only the layered layout is ours (pure function).
- Dense-list fallback view for large DAGs (YAGNI until evidence); v1 = zoom-to-fit + scroll.
- Engine writing to the pi-tasks store (pitasks stays read-only).

## Model

### New waveobj: `TaskGroup` (oref `dag:<id>`)

```go
type TaskNode struct {
    ID       string          `json:"id"`       // "t-1", stable, unique within the group
    Label    string          `json:"label"`
    Deps     []string        `json:"deps,omitempty"`
    Gate     bool            `json:"gate,omitempty"`     // halt the DAG at completion for review
    RunID    string          `json:"runid,omitempty"`    // child run once spawned
    RunSpec  RunSpec         `json:"runspec,omitempty"`  // runtime + mode + goal for the child
}

type TaskGroup struct {
    OID          string      `json:"oid"`
    Version      int         `json:"version"`
    ID           string      `json:"id"`          // == OID
    RunID        string      `json:"runid"`       // the orchestrator run this DAG belongs to
    Title        string      `json:"title,omitempty"`
    Parallelism  int         `json:"parallelism"` // >= 1, default 2
    Tasks        []TaskNode  `json:"tasks"`
    Status       string      `json:"status"`      // running | awaiting-review | blocked | done | cancelled (derived)
    Failures     int         `json:"failures"`    // consecutive task failures; circuit-break at 3
    CreatedTs    int64       `json:"createdts"`
    UpdatedTs    int64       `json:"updatedts"`
}
```

- `Run` gains exactly one field: `DagORef string` (optional), pointing at the group. Child runs are
  ordinary runs (`ParentLeadORef` as today) — all existing run machinery (evidence, gates, attention)
  works unchanged.
- New SQL migration `000017_taskgroup` (generic `db_dag(oid PK, version, data json)` following the
  existing waveobj table pattern), registered in `waveobj.AllWaveObjTypes`, TS types regenerated via
  `task generate`.

### Task state (derived, never hand-set)

`pending -> ready -> running -> done | failed | cancelled` plus `blocked-merge` (worktree merge
conflict). Derivation mirrors the recomputeStatus discipline:

- `pending -> ready` when all deps are `done` or `skipped`.
- The engine spawns up to `Parallelism` ready tasks (oldest first, stable order by task ID).
- `running -> done|failed|cancelled` mirrors the child run's status.
- A `Gate` task halts the DAG at its completion: group status `awaiting-review`, surfaced to the
  attention feed and to the lead via a `gate_open` control event. `approve` releases the DAG to
  continue past the gated task; `sendback` reopens the task (re-spawn into a fresh worktree checked
  out from the project branch HEAD at re-spawn time).
- A failed child marks its task `failed`; the DAG blocks (no cascade). The lead or human chooses
  retry / skip / cancel. After 3 consecutive task failures the group enters `blocked` with a
  "stop and ask" flag (circuit-break).
- Group `Status` is derived by a pure `recomputeDagStatus` over tasks (single source of truth, pure-Go
  tested), mirroring `recomputeStatus`. The orchestrator run's own phase stays `running` until
  `wsh jarvis complete` — the DAG never fights the run's phase status.

### Scheduler invariants

- A task is never spawned twice concurrently; re-spawn (retry/sendback) requires the previous child
  run to be terminal.
- Cancelling the DAG = cancel running children (existing `CancelRun` + `StopRunWorkerCommand`),
  pending tasks skipped, worktrees cleaned (recovery patch dumped).
- Lead death does not stop the DAG: scheduling is engine-owned; gates and failures surface to the
  human directly (attention feed). A re-spawned lead on the same run resumes receiving control
  events; nothing else requires its presence.

## Verbs (wshrpc + `wsh`, roadmap "verbs-as-commands" contract)

| Verb | Effect |
| --- | --- |
| `wsh jarvis dag submit <json>` | create/validate TaskGroup (acyclic, parallelism >= 1, ids unique); links run.DagORef; engine starts scheduling |
| `wsh jarvis dag import-tasks [--dir .pi/tasks]` | map pi-tasks records (subject->label, Blocks/BlockedBy->deps, in_progress->pending) to DAG JSON, then submit; pitasks stays read-only |
| `wsh jarvis dag status` | engine-owned status snapshot (what the lead reads instead of babysitting) |
| `wsh jarvis dag approve\|sendback <task>` | gate actions (human in cockpit, or lead with authority) |
| `wsh jarvis dag retry\|skip <task>` | failure recovery |
| `wsh jarvis dag cancel` | cancel group + children |
| `wsh jarvis merge <run>` | explicit squash-merge of a finished child's worktree into the project branch; `--continue` after conflict resolution |

Server handlers in `pkg/wshrpc/wshserver/wshserver_dag.go`; CLI in `cmd/wsh/cmd/wshcmd-jarvisdag.go`;
engine package `pkg/orchestrate/` (imports `pkg/jarvis` for spawn/attention helpers, never the other
way).

## Managed worktrees (`pkg/orchestrate/worktree.go`, `merge.go`)

- On task readiness: `git worktree add <project>/.waveterm/worktrees/<runid> -b wave/<runid>` checked
  out at the run's `BaseCommit` (already captured at run creation). Each child gets its own branch —
  evidence is `BaseCommit..worktree-HEAD`, its own commit range, before any merge; the 6a class of
  over-attribution is structurally impossible.
- Worker spawn: `SpawnRunWorker` with `cwd` = worktree path (runtime-agnostic; all four harnesses).
  Claude's own nested worktrees for its subagents remain orthogonal.
- Merge is an explicit action (`wsh jarvis merge` or the graph's Merge button): seal evidence first,
  then squash-merge `wave/<runid>` onto the project branch (`run <id>: <goal>` message); on conflict
  the task enters `blocked-merge`, surfaced for manual resolution in the main tree, then
  `merge --continue`. Cleanup: `git worktree remove`, branch deleted.
- Safety rails: cancel mid-flight dumps `<project>/.waveterm/recovery/<runid>.patch` before removing
  the worktree; non-git projects (folder workspaces) skip worktrees entirely and fall back to
  in-place runs — the DAG still works.

## Pi-first lead integration

- `BuildOrchestratePrompt` becomes runtime-aware; the pi variant instructs: plan -> write pi-tasks
  records -> `wsh jarvis dag import-tasks` -> respond to events, never babysit. Prompt boundary:
  **engine DAG = isolated parallel units** (each a run in a worktree); **pi-subagents = in-context
  helpers** (shared context, no run). The engine never knows about subagents.
- Control-dir watcher (`pi/extensions/waveterm-tools.ts`) gains message kinds: `child_done`,
  `gate_open`, `dag_blocked`, `dag_complete` — the engine->lead mail channel, symmetric with the
  existing steer/follow_up/abort kinds. The cockpit mirrors the same events in the graph's events
  rail (single source: WOS dag events).
- Gates: consequential gates are the human's call (attention feed + cockpit approve); the lead sees
  `gate_open` and pauses; `wsh jarvis dag approve` exists for lead-authority cases.
- Nested orchestrators: a child's RunSpec may be any mode; no special machinery (each run is
  independent).

## UI: per-run DAG graph (`frontend/app/view/orchestrate/`)

- **Home: no new nav surface.** The graph is a view of the orchestrator run, opened from: the lead's
  agent card in the cockpit grid ("Open DAG"), the run's record in the jarvis stage, and attention
  items (gate/failure deep-links with that node selected). It opens full-canvas within the current
  surface (back returns to the originating card), with the standard detail rail.
- **Rendering: `@xyflow/react` (v12, MIT, controlled mode).** Nodes are custom React components
  carrying our node anatomy; edges are library-rendered with arrowheads, computed from node
  geometry (no hand-placed SVG coordinates — the hand-rolled mockup's misaligned edges were
  exactly this failure mode); built-in zoom/pan/fitView; `fitView` on open; selection ring via the
  controlled `selected` state.
- **Layout is a pure function** (`daglayout.ts`, vitest-tested): layered (longest-path) columns,
  stable order by task id — it computes the `x/y` positions handed to React Flow; the library
  never decides layout.
- **Node anatomy**: status dot + state (running with progress bar, ready, gate, failed xN, done),
  task id (mono, accent), label, worktree/base meta, inline actions on actionable nodes only
  (gate: Approve/Send back; failed: Retry/Skip; done+unmerged: Merge). Selection ring drives the
  detail rail.
- **Keyboard**: j/k moves selection through the layer-ordered node list (listnav reuse — our own
  ordering; React Flow just focuses the selected node), Enter opens the node's actions, g-chords
  still work.
- **Right rail**: selected task detail, control events feed (child_done/gate_open/dag_blocked/
  dag_complete), merge queue. Attention footer unchanged (scoped to the DAG's open items).
- State: `dagstore.ts` atoms derived from the `dag:<id>` WOS subscription; no new design tokens.

## Error handling

- Validation failures (cycle, duplicate ids, parallelism < 1, task referencing a non-existent run)
  reject the submit verb with a concrete message — never a partial group.
- Worktree create failure = task `failed` (retryable); merge conflict = `blocked-merge`, never a
  silent skip.
- Control-dir write failure is non-fatal (engine logs; cockpit still shows via WOS).
- All engine entry points validate against the persisted group version (optimistic concurrency via
  the waveobj `Version` field), consistent with the rest of wstore.

## Testing

- `pkg/orchestrate/scheduler_test.go`: pure transitions — ready selection, parallelism cap, gate
  halt + approve/sendback, failure block, circuit-break at 3, cancellation semantics, lead-death
  continuation (no lead reference needed to advance).
- `pkg/orchestrate/worktree_test.go` + `merge_test.go`: temp git fixture repos — create at base,
  evidence range, squash merge, conflict -> blocked-merge -> continue, cleanup, recovery patch,
  non-git fallback.
- `pkg/pitasks` import-mapping tests; prompt golden tests for the pi lead variant.
- `frontend/app/view/orchestrate/daglayout.test.ts`: layered layout, stable ordering, edge paths;
  `dagstore` derivation tests (the React Flow layer stays thin and presentational — graph behavior
  is tested through the store + `verify:ui`).
- Visual: `task verify:ui -- orchestrate` scenario (open graph from a run card, gate node, approve).

## Rollout (each step shippable; final docs fold into the feature commit)

1. `TaskGroup` type + migration + `task generate`.
2. `pkg/orchestrate` engine: model ops, scheduler, gates + verbs (server + CLI) with pure tests.
3. Worktree manager + merge (git fixture tests).
4. Pi integration: control-dir kinds, prompt variant, import-tasks.
5. Graph UI: `@xyflow/react` dependency + layout pure fn + surface + deep-links + verify:ui.
6. Design + plan docs fold into the feature commit.

## Open questions

- Merge policy: auto-merge for non-gated done tasks vs. always explicit? v1 = explicit (blast-radius
  discipline; revisit on evidence).
- Where recovery patches surface in the UI (v1: file only, listed in the run record's evidence).
- `dag status` output shape for the lead (v1: compact table; pi tools may render it richer later).
