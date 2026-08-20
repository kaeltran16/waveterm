# Orchestrator Run Creation: Draft-First + Route Chain — Design

Date: 2026-08-20. Status: approved for implementation. Source: approved brainstorming session with
interactive mockups (`.superpowers/brainstorm/349-1787195026/content/`, screens 04–11). Supersedes the
surface-level parts of `2026-08-20-orchestrator-jarvis-ui-design.md`: the Cockpit DAG takeover is removed.

## Problem

Two related gaps make orchestrator launches hard to authorize and route correctly:

1. A new run currently goes directly from the composer to `CreateRunCommand`. That is appropriate for
   pipeline and quick work, but an orchestrator DAG is a plan: its tasks, dependencies, gates,
   parallelism, and task routes should be reviewed before any run or worker exists.
2. Runtime choice exists at several scopes, but there is no persisted runtime-and-tier route chain and
   no shared authority for which pairs are valid. `TaskNode.RunSpec` currently carries only a runtime,
   and both phase and DAG launch paths currently spawn from runtime alone.

## Product decisions

1. **Orchestrator creation is draft-first.** Submitting an orchestrator goal opens a Stage-owned modal,
   decomposes the goal, and keeps all plan edits client-side until Launch. Closing before Launch creates
   no run.
2. **Pipeline and quick creation stay direct.** Their composer submissions continue to call
   `CreateRunCommand` immediately.
3. **A route pin is `{runtime, tier}`.** `tier` is one of `cheap | mid | capable`; model identifiers are
   resolved by the backend and are not stored in a pin.
4. **Route inheritance has four persisted rungs:** Settings → Channel → Run → Task. The run route is
   fixed at creation. Task pins can be edited only in the draft.
5. **Go is the route authority.** The frontend renders backend-provided capabilities and never hardcodes
   model IDs or its own runtime/tier validity matrix.
6. **The DAG is a modal over the Jarvis Stage.** Cockpit remains fleet and needs-you only; it no longer
   hosts a DAG takeover.

## Route authority and capabilities

Add `pkg/runroute` as the shared backend route package. It owns the supported runtime+tier pairs,
resolved model labels, and model arguments, reusing the tier/model rules already owned by `pkg/consult`.
It validates pair support but does not probe executables or decide installation/availability; those
checks stay in the existing `probeHarnesses` and `validateHarness` seams. OpenRouter remains outside the
supported run-worker pairs because it is an API-only consult backend, not a run-worker harness.

The persisted pin stays in the object-model package, while the derived launch representation stays in
the authority package; this avoids making `waveobj` depend on `consult` (which already depends on
`waveobj`):

```go
// pkg/waveobj
type RoutePin struct {
    Runtime string `json:"runtime"`
    Tier    string `json:"tier"`
}

// pkg/runroute
type Capability struct {
    Runtime       string       `json:"runtime"`
    Tier          consult.Tier `json:"tier"`
    ResolvedModel string       `json:"resolvedmodel"`
    ModelArgs     []string     `json:"-"`
}
```

The pin's tier is validated against the values from `consult.Tier`. `ModelArgs` is backend-only launch
data; the RPC exposes only runtime, tier, and the resolved-model label. A capability with no `ModelArgs`
means "use the operator's configured default" and the display label is `operator default`.
`runroute` rejects empty, unknown, or unsupported pairs; it does not report whether a harness is
installed.

`ListHarnessesCommand` extends each `HarnessInfo` with `RouteCapabilities []runroute.Capability`. It
uses the existing `probeHarnesses` result as the installation authority and populates capabilities only
when that result is both installed and run-worker-capable. Existing identity, installation, version,
consult, and run-worker fields remain. The RoutePicker and all effective-route labels consume this
response. An unavailable harness can remain visible as unavailable, but its route-capability list is
empty and it cannot contribute a selectable route.

The valid v1 run-worker pairs are fixed:

| Runtime | Cheap | Mid | Capable |
|---|---|---|---|
| Pi | `deepseek-v4-flash` | `deepseek-v4-pro` | `deepseek-v4-pro` |
| Claude | `haiku` | `sonnet` | `operator default` |
| Codex | invalid | invalid | `operator default` |
| OpenCode | invalid | invalid | `operator default` |

Pi adds its explicit `--model` override for all three tiers. Claude adds `--model` only for cheap and
mid; capable preserves the operator default. Codex and OpenCode accept only capable and add no model
flag. The run-worker launch adapter receives a validated capability and adds model arguments only when
that capability supplies them. It must not infer flags from a runtime name or tier in a second matrix.

## Persistence and inheritance

### Settings rung

Keep `harness:preferredruntime` and add `harness:preferredtier`. A missing legacy tier reads as
`capable`. New settings writes send runtime and tier together; the backend validates pair support with
`runroute` before writing either key. Invalid legacy combinations are not silently launched: the UI asks
for a valid route, and every create boundary validates pair support and harness availability again.

### Channel rung

Add `Route *RoutePin` only to the channel's `ProfileOverride`; do not add a route to `JarvisProfile`,
because that type is also the persisted global profile and would create a hidden fifth rung.
`SetChannelProfileCommand` validates a non-nil override route with `runroute` before writing channel
metadata. `GetJarvisProfileCommand` already returns `Override`, so the frontend profile cache and panel
read `override.route` directly. A nil override route means inherit Settings; profile resolution does not
copy either the channel pin or Settings fallback into `JarvisProfile`.

### Run rung

Add `Tier` beside `Runtime` on `waveobj.Run`. New `CommandCreateRunData` requires both fields. Before
`AppendRun`, the server combines `validateHarness(runtime, OperationRunWorker)` with `runroute`
pair validation, persists both fields, and uses them for every phase worker. A run route is immutable
for the full run lifetime, including planning; there is no post-create route patch. Pipeline and quick
callers resolve Settings → `ProfileOverride.Route` in the frontend and submit that explicit route. The
orchestrator draft request does the same, and Launch submits the request's explicit route.

### Task rung

Add `Tier` beside `Runtime` on `TaskNode.RunSpec`. New submitted pins require runtime and tier to be
both present or both absent:

- both absent: inherit the owning run route;
- both present: validate and use the task pin;
- only one present: reject the new DAG before persistence.

For new submissions, `DagSubmitCommand` validates every task pin and its effective route before
`AppendDag`, combining `validateHarness(runtime, OperationRunWorker)` with `runroute` pair validation.
Unknown runtimes, unknown tiers, unsupported pairs, and unavailable harnesses fail without persisting a
TaskGroup or spawning a worker.

### Frontend resolution

A pure frontend resolver selects the first complete pin from Task → Run →
`ProfileOverride.Route` → Settings for presentation. Settings cannot be unset; its legacy missing tier
is normalized to capable. The resolver uses the matching capability returned by `ListHarnessesCommand`
to obtain `ResolvedModel`. It does not validate by comparing against hardcoded model or pair lists;
server validation remains authoritative at every persistence and launch boundary.

### Migration safety

The added tier fields are backward-compatible object fields, so no DB migration is needed:

- an existing persisted `Run` with an empty `Tier` executes and displays as
  `{runtime: Run.Runtime, tier: capable}`;
- an existing persisted `TaskNode.RunSpec` with a runtime and empty tier executes and displays as that
  runtime plus capable, preserving the historical runtime-only override;
- this normalization applies only when reading/executing persisted legacy objects. New CreateRun
  requests must include tier, and new DagSubmit payloads reject runtime-only or tier-only task pins.

Normalization happens before effective-route resolution, child Run persistence, capability lookup, and
live-node display. New writes persist the explicit capable tier rather than preserving an empty value.

## Execution enforcement

Route persistence is not display-only:

1. Phase-worker launch resolves the persisted `Run.Runtime + Run.Tier` (normalizing a legacy empty tier
   to capable), combines `validateHarness` with `runroute` validation, and passes the capability into the
   unattended worker adapter.
2. DAG scheduling chooses `TaskNode.RunSpec` when pinned, otherwise the owning run route, normalizes
   legacy persisted routes as described below, and combines harness availability with pair validation
   before spawn.
3. `childRunFromSpec` persists the effective runtime and tier on the child `Run`, not merely on the
   TaskGroup. Spawn and child persistence use the same already-validated effective route.
4. Any route failure occurs before its associated spawn. Submit-time task validation occurs before DAG
   persistence; create-time run validation occurs before run persistence.

This design absorbs the routing-roadmap Phase 1 work: the shared capability source, tier fields,
validation, child persistence, and launch enforcement ship as part of this feature. It does not assume
that runtime-only pins already enforce model selection.

## Composer and modal flow

### Direct shapes

Pipeline and quick submissions retain the existing `createRun` path. Their shape chip supplies `mode`,
and their RoutePicker supplies the resolved Settings → `ProfileOverride.Route` route to
`CreateRunCommand`.

### Orchestrator request

Orchestrator submit does **not** call `CreateRunCommand`. It creates an explicit modal request:

```ts
type DagDraftRequest = {
    channelId: string;
    goal: string;
    route: RoutePin;
};
```

The Stage owns modal state as a discriminated union. Every state includes an error string (empty when
there is no error), so errors survive the transition that produced them:

```ts
type DagModalState =
    | { kind: "decomposing"; request: DagDraftRequest; error: string }
    | { kind: "draft"; request: DagDraftRequest; draft: DagDraft; error: string }
    | { kind: "launching"; request: DagDraftRequest; draft: DagDraft; error: string }
    | { kind: "live"; channelId: string; runId: string; dagOref: string; error: string };
```

A run card with a DAG opens the same modal directly in `live` state from its channel/run identity and
`dag` oref. No Cockpit surface switch is involved.

### Decompose and draft

`JarvisDecomposeCommand({goal})` supplies draft task labels. Its server fail-safe remains `[goal]` when
planning cannot produce useful subtasks. Transport/RPC failures are different: the modal stays open,
shows the error, and offers Retry. They are not converted client-side into apparent success.

Draft edits remain client-only: rename/add/delete tasks, clean dependencies when deleting, add
cycle-safe dependencies, toggle gates, set parallelism, and set or clear valid task route pins. The
structure preview preserves dependency edges. The header shows the immutable proposed run route and
pinned-task count. Launch is disabled for an empty or invalid draft.

### Launch transaction

Launch performs these steps in order:

1. `CreateRunCommand({channelId, goal, mode: "orchestrator", deferstart: true, runtime, tier})`.
2. `DagSubmitCommand({channelId, runId, title, parallelism, tasks})`.
3. On success, replace modal state with `live` using the returned DAG oref.

If CreateRun fails, the draft remains open with the create error. If DagSubmit fails after CreateRun,
the client calls `CancelRunCommand` best-effort for the deferred run and returns to `draft` with a
contextual submit error. If cleanup also fails, the error includes the run ID and cleanup failure rather
than hiding the possible planning run. Closing before Launch creates no run. The modal cannot be closed
while `launching`, preventing a hidden in-flight result.

## Deferred lifecycle contract

`deferstart` has one event contract:

- deferred `CreateRunCommand` persists a planning run and emits `run-created`, but does not spawn a phase
  worker and does not emit `phase-started`;
- successful `DagSubmitCommand` changes that run from `planning` to `executing` and emits
  `phase-started` for phase zero exactly once before scheduling ready tasks;
- non-deferred CreateRun continues to emit Created then PhaseStarted and spawn its first phase worker.

The implementation must place the current unconditional CreateRun `phase-started` append on the
non-deferred path. DagSubmit emits only when it performs the planning → executing transition, preserving
idempotent event semantics.

## Live DAG presentation

The live modal mounts the existing oref-driven `DagGraphView` and its task detail surface. Every task
node shows its effective route:

- pinned: runtime, tier, and backend-resolved model;
- inherited: `inherits run route` plus the owning run's runtime, tier, and resolved model.

The pin control is editable only in draft state. Live state exposes existing DAG actions, not route or
structural mutation. `DagGraphView` retains graph navigation but drops its own Escape-close listener;
the modal is the single owner of dismissal.

## Modal behavior and accessibility

The DAG modal is an absolute overlay inside the relative Jarvis Stage region, so the mounted Stage and
its streaming content remain behind it. It uses only Tailwind utilities and `@theme` color tokens; no
SCSS or raw component colors. Open/close transitions use `motion/react` and shared motion tokens and
honor reduced motion.

The panel has `role="dialog"`, `aria-modal="true"`, and labelled chrome via `aria-labelledby`. The modal
reuses and, where needed, extends `frontend/app/modals/modalfocus.ts` for initial focus, Tab/Shift+Tab
focus trapping, and focus restoration. It owns one Escape listener. Escape and backdrop close work in
decomposing, draft, and live states; backdrop clicks only close when the target is the backdrop.
Dismissal is disabled while launching. `DagGraphView` must not install a duplicate Escape handler. Raw
ReactFlow stroke/background colors in the graph touched by this work are replaced with token-backed CSS
variables so the full modal remains theme-safe.

## Code seams

| Concern | Existing seam | Required change |
|---|---|---|
| Capability authority | `pkg/consult/consult.go`, existing harness validation seams | add `pkg/runroute` pair/model capabilities; keep probing in `probeHarnesses`/`validateHarness` |
| Capability RPC | `ListHarnessesCommand`, `HarnessInfo` | return capabilities only for installed run-worker harnesses |
| Settings route | `harness:preferredruntime`, harness store | add preferred tier, capable legacy default, atomic pair validation |
| Channel route | `ProfileOverride`, profile commands/cache/panel | add only `ProfileOverride.Route`; read `override.route`, nil = Settings |
| Run route | `CommandCreateRunData`, `waveobj.Run` | require new tier, validate pair + availability, persist both; legacy empty tier = capable |
| Task route | `TaskNode.RunSpec`, `DagSubmitCommand` | new pins both-or-neither; legacy runtime-only = capable; validate before persistence |
| Phase launch | `pkg/jarvis/runexec.go` | capability-aware runtime+tier adapter and model arguments |
| DAG launch | `pkg/orchestrate/engine.go` | effective task/run route for spawn and child Run persistence |
| Draft request | Stage composer and Stage state | orchestrator opens modal request; pipeline/quick stay direct |
| Launch cleanup | run/DAG frontend actions | deferred create, submit, best-effort cancel on partial failure |
| Live open | Jarvis run card | open Stage modal in live state from DAG oref |
| Cockpit | `cockpitsurface.tsx`, DAG store | remove DAG takeover branch; fleet-only |
| Accessibility | modal focus utility, `DagGraphView` | trap/restore focus; modal-only Escape |

## Errors and edge cases

- Empty/unknown runtime or tier, unsupported pair, or unavailable harness: reject before persistence or
  spawn and show the backend error at the initiating control.
- Legacy Settings or persisted Run with no tier: normalize to capable. A now-invalid
  runtime/capable combination must be corrected before launch rather than silently substituted.
- Legacy persisted task runtime with no tier: normalize to that runtime+capable. Runtime-only or
  tier-only pins in a new DagSubmit payload are rejected without persisting the DAG.
- Decompose server fail-safe: open a one-task `[goal]` draft. RPC failure: visible Retry.
- Cycle-creating dependency: reject client-side without mutation; server DAG validation remains the
  persistence boundary.
- Deleting a task: remove references to it from other tasks' dependency lists.
- Zero tasks: Launch disabled; server still rejects.
- DagSubmit failure after deferred create: best-effort cancel, keep the draft and report cleanup status.
- Close before Launch: no Run or TaskGroup exists. Close during Launch: disabled.
- Capability data changes while a draft is open: Launch still relies on server validation and returns a
  visible error instead of spawning from stale frontend data.

## Testing and verification

### Go

- `runroute` capability table covers every valid v1 pair, resolved model, model-argument presence,
  OpenRouter exclusion, invalid tier, invalid pair, and unknown runtime without probing installation.
- `ListHarnessesCommand` returns capability rows only for installed run-worker harnesses and an empty
  capability list for an unavailable or non-run-worker harness.
- Settings and channel writes reject invalid complete routes and do not partially persist a pair;
  legacy missing settings tier resolves to capable.
- New CreateRun requires and persists runtime+tier and combines pair validation with
  `validateHarness` before `AppendRun`/spawn; a persisted legacy Run with empty tier normalizes to
  capable on execution.
- New `TaskNode.RunSpec` pins accept both fields or neither; DagSubmit combines pair and harness
  validation before `AppendDag`. Deserialization/execution tests prove a persisted legacy runtime-only
  RunSpec normalizes to capable for display, spawn, and child Run persistence without a DB migration.
- Phase workers receive the run route. DAG children receive the task pin or owning run route; spawned
  arguments and child Run fields match the same effective capability.
- Launch adapters add model flags only for Pi all tiers and Claude cheap/mid.
- Deferred lifecycle test asserts Created without PhaseStarted at Create, then one PhaseStarted on the
  planning → executing DagSubmit transition. Non-deferred behavior remains covered.

### Frontend unit

- Route inheritance tables cover all four rungs, a nil `override.route`, clearing a task pin, and
  capable normalization for legacy Settings, Run, and runtime-only Task values.
- RoutePicker renders only backend-provided capabilities and displays resolved models.
- Composer dispatch tests prove pipeline/quick call CreateRun directly and orchestrator creates only a
  `DagDraftRequest`.
- Modal transitions cover decomposing → draft → launching → live, RPC Retry, close-before-launch, and
  submit-failure cancel cleanup while preserving the draft.
- Draft reducer covers dependency cleanup, cycle rejection, gate changes, parallelism, and task pins.
- Live-node presentation distinguishes pinned and inherited effective routes.
- Focus tests cover initial focus, Tab trapping, Escape ownership, launch dismissal guard, and restore.

### Build and visual

After Go type/RPC changes, run `task generate`; do not hand-edit generated bindings. Run targeted Go and
Vitest suites, then `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`. Use
`task verify:ui` for draft, launching, error, and live modal states over a streaming Stage, keyboard
focus/dismissal, resolved route labels, and a Cockpit with no DAG takeover.

## Non-goals

- No live route patch verb or mid-run route mutation.
- No post-launch task/dependency/gate editing.
- No automatic route escalation or silent fallback to another pair.
- No OpenRouter run-worker route.
- No Cockpit DAG takeover.
- No new dependency, SCSS, or frontend model/capability matrix.

## Dependencies

There is no external routing-roadmap dependency: this feature includes its required Phase 1 route
capability, persistence, validation, and launch enforcement. Existing DAG submit/status/action commands,
Jarvis decomposition, Tailwind tokens, `motion/react`, and the modal focus utility are reused.
