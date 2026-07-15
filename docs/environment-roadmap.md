# Arc Environment — Roadmap

> Forward-looking product and architecture roadmap. Captured 2026-07-15 during the Environment
> brainstorm. This is not an implementation plan: it defines the capability, the contracts each
> delivery phase must preserve, and the evidence required before advancing. Each phase receives its
> own design spec and implementation plan when scheduled.

## Thesis

Arc should own the local development environment for a registered project, not merely the terminals
and agents operating inside it.

Today a project runtime is fragmented across shell tabs, Docker Compose, package scripts, task
runners, test watchers, ports, and AI agents. The user must remember which services are already
running, where their logs live, which process owns a port, which dependencies are healthy, and
whether an agent has launched a duplicate server. Arc already has the project registry, process
controllers, terminals, agent status, and cross-process RPC substrate needed to make that runtime a
coherent product capability.

The product promise is:

> Open a project, start its environment once, and always know which services are running, where their
> logs are, who depends on them, and what failed.

The differentiator is not another process manager. It is an **agent-aware environment**: humans and
agents share the same declared services, agents reuse healthy infrastructure instead of launching
duplicates, and Arc mediates disruptive actions against shared services.

## Product shape

Environment is a top-level Arc surface with a complete workflow:

1. **Discover** service candidates from deterministic project manifests.
2. **Review** the proposed environment before any command is adopted or executed.
3. **Launch** approved services in dependency order through Arc-managed controllers.
4. **Observe** status, health, logs, process trees, ports, dependencies, and consumers.
5. **Diagnose** concrete runtime failures and configuration drift.
6. **Coordinate** agents against the same environment with explicit permissions.
7. **Recover** failed or stale services through user-approved actions.

The service list and live logs are the primary interaction. A topology view is a secondary way to
understand relationships; it is not the feature by itself.

## Relationship to Arc Projects

The existing Projects registry is the ownership boundary and single source of truth. A registered
project currently maps a display name to a local path in `projects.json` through
`wconfig.ProjectKeywords`. Environment extends that project record rather than introducing a
parallel registry.

Conceptually:

```json
{
  "waveterm": {
    "path": "C:\\Users\\kael02\\IdeaProjects\\waveterm",
    "environment": {
      "version": 1,
      "services": []
    }
  }
}
```

This produces one consistent join:

- The project picker selects the environment.
- New Agent selects the project and receives its environment context.
- Radar scans the same project path.
- Sessions, Runs, Memory, Files, and Usage continue to resolve against the same project identity.
- Worktree agents attach to the base registered project's environment. A worktree isolates source;
  it does not create a second database, API, or frontend unless the user explicitly defines one.

Only registered projects receive managed environments. If Arc observes an agent working in an
unregistered directory, it may offer to register the project; it must not silently create a durable
environment definition.

Runtime state is not persisted in `projects.json`. The project record stores the approved
definition; controllers and process observation produce the ephemeral runtime projection.

## Core data contracts

### Environment definition

The durable, human-approved configuration:

```text
EnvironmentDefinition
├── version
└── services[]
    ├── id                    stable within the project
    ├── name                  display label
    ├── command               exact approved command
    ├── cwd                   project-relative working directory
    ├── source                manifest path and source identity
    ├── dependsOn[]           service ids
    ├── expectedPorts[]       optional
    ├── healthCheck           optional HTTP or TCP probe
    ├── restartPolicy         v1: never or on-failure with a bounded limit
    └── kind                  process, compose-service, or composite
```

The source reference preserves provenance. A rescan can explain exactly which manifest entry added,
changed, or removed a candidate.

### Runtime projection

The live, reconstructable state:

```text
EnvironmentRuntime
├── project identity
├── aggregate health
└── services[]
    ├── state                 stopped, starting, running, healthy, degraded,
    │                         failed, blocked, or stopping
    ├── controller identity
    ├── root pid and descendants
    ├── observed ports
    ├── start and exit metadata
    ├── bounded recent logs
    ├── health-check result
    ├── active dependents
    └── agent consumers
```

A process being alive means `running`. Only a successful configured probe means `healthy`. A service
whose required dependency is unavailable is `blocked`, not `failed`.

### Situation

A deterministic or model-assisted diagnosis derived from runtime state:

```text
EnvironmentSituation
├── kind
├── severity
├── affected service ids
├── factual evidence[]
├── explanation
├── safe actions[]
└── state key               suppresses duplicate notices until facts change
```

Situation history is not a second monitoring database in v1. Active situations derive from current
state; acknowledgement remains valid only while the underlying state key is unchanged.

## Detection contract

Detection is performed by deterministic Go code in `wavesrv`, not by a headless model.

### When detection runs

- After project registration, producing a proposal only.
- When Environment opens for an unconfigured project.
- On explicit **Rescan**.
- When a known manifest changes, Arc marks the definition stale and offers a rescan. It does not
  rewrite the environment automatically.

Detection is a bounded manifest scan, not a continuous repository crawl.

### Supported sources

| Source | High-confidence facts |
|---|---|
| Docker Compose | Named services, declared ports, dependencies, and health checks |
| Root `package.json` | Exact long-running scripts such as `dev`, `start`, `serve`, and `watch` |
| Package workspaces | Per-package long-running scripts and their working directories |
| Taskfile | Candidate long-running tasks and explicit task dependencies |
| Makefile | Candidate long-running targets at lower confidence |
| Existing Arc terminals | Supporting evidence that a command is used; never an executable definition by itself |

Source-specific parsers emit normalized candidates with confidence, provenance, and warnings. A
model may suggest a friendly label or explain an opaque command, but it cannot invent or alter
commands, working directories, dependencies, ports, or probes.

For an unsupported build system, an explicit **Analyze setup with Claude** action may classify exact
commands already present in bounded source files. Code must validate every suggested command against
the cited source before showing it. The result remains a proposal requiring human confirmation.

### Review and rescan

The first setup screen lets the user:

- Enable or exclude candidates.
- Rename display labels.
- Correct dependencies.
- Confirm expected ports.
- Add a health check.
- Add a missing service manually.
- Choose between an opaque composite command and independently manageable child services.

No command executes until the definition is confirmed.

Later rescans produce a semantic diff: added candidates, changed commands, removed sources, and
changed declared dependencies or ports. The stored definition changes only after explicit approval.

## Multi-service behavior

### Explicit service graphs

Docker Compose and other declarative sources can yield an explicit dependency graph. Arc starts
services in topological order, starts independent branches concurrently, waits for required readiness,
and stops in reverse dependency order.

```text
database ──→ api ──→ frontend
          └→ worker
```

A failed database blocks API, worker, and frontend. A failed worker does not stop the independent
frontend path.

### Workspaces and independent scripts

Package workspaces may expose multiple `dev` scripts. Arc presents each exact script with its package
working directory. It does not infer dependencies merely from package dependency metadata; runtime
startup dependencies are a distinct concept and require a declarative source or user confirmation.

### Opaque composite commands

Commands such as `task dev` or `pnpm dev` may launch several processes internally. Unless Arc can
parse their structure confidently, the command remains one `composite` service. Arc can show its
descendant process tree and observed ports, but cannot independently restart a child it does not own
as a declared service.

The review UI warns when a composite candidate overlaps known child candidates. The user chooses the
composite or the individually manageable services. Arc never runs both silently.

### Process and port attribution

Every managed service has a controller-owned root process. Descendant processes inherit service
ownership for observation, so a shell-to-package-manager-to-runtime chain still maps its listeners
to one service.

```text
Arc controller
└── pwsh
    └── pnpm
        └── node / Vite  → listening on :5174
```

Expected ports are checked before launch. An unrelated process holding a port produces a conflict
with its PID and available metadata. Arc does not terminate external processes automatically.

## Environment surface

The runtime-first surface uses three regions:

1. **Service rail** — grouped services, state, uptime, and expected/observed ports; aggregate controls
   for Start all, Stop all, and Restart failed/changed.
2. **Service workspace** — selected service identity, exact command, status metrics, live bounded logs,
   search/filter, and Open terminal/Restart/Stop actions.
3. **Context rail** — dependencies, agent consumers, active situations, evidence, and safe actions.

The surface also includes:

- A setup/review state for unconfigured projects.
- A rescan-diff state when manifests change.
- An environment-level healthy/degraded/failed summary.
- A secondary topology mode for dependency and ownership exploration.
- Responsive degradation to service rail plus workspace when the context rail cannot fit.

The visual direction is calm and operational: service control and logs are primary; the graph and AI
explanations support the workflow rather than dominate it.

## Agent-aware contract

The Environment capability must be useful to agents without handing them unrestricted process
control.

### Launch context

When New Agent launches against a registered project, Arc attaches a bounded environment summary:

```text
Arc-managed environment:
- frontend: running at http://localhost:5174
- backend: healthy at http://localhost:8080
- redis: healthy at localhost:6379

Reuse these services. Do not launch duplicates.
Query status and logs through the Arc environment commands.
```

The summary is generated from the approved definition and live runtime, not from model inference.

### Agent command surface

The long-term `wsh` contract:

```text
wsh environment status
wsh environment logs <service> --tail <n>
wsh environment start <service>
wsh environment restart <service>
```

Agents may read status and logs from the first agent-aware release. They may request start or restart
for declared services once the action path is proven. Environment-definition mutation remains
human-only.

### Shared-service protection

Arc tracks live agent consumers of a service. A restart or stop that affects other agents must show
the dependents and require confirmation. A destructive request from an agent becomes a visible
human decision rather than an immediate process signal.

All agent-triggered environment actions are attributed in the Environment timeline and in the
requesting agent's context.

## Proactive intelligence

Code detects high-confidence situations:

- A managed service exits unexpectedly.
- A configured health check fails.
- An expected port is held by an unrelated process.
- Duplicate instances of a declared service are observed.
- A dependency is unavailable while dependents remain active.
- A service repeatedly crashes within the bounded restart policy.
- A manifest changed after the environment definition was approved.

A model may diagnose ambiguous failures from bounded inputs only: the service definition, recent log
lines, exit metadata, dependency health, and relevant recent file changes. Its response must separate
facts from inference and cite the supplied evidence. It can recommend an action; it cannot execute one.

No model runs continuously. Model assistance is triggered by a meaningful state transition or an
explicit user request, then deduplicated by the situation state key.

## Safety and correctness boundaries

- **No silent execution:** discovery and model analysis produce proposals, never launches.
- **No command invention:** executable values come from deterministic sources or direct user input.
- **No silent external-process adoption:** discovered external processes remain read-only evidence
  until explicitly associated.
- **No automatic external kill:** stopping an external PID always requires a human decision.
- **No dependency guessing:** uncertain relationships stay unset.
- **Bounded logs:** diagnostics receive a capped, redacted tail, not an entire terminal history.
- **Project containment:** default service working directories remain inside the registered project;
  exceptions require explicit confirmation.
- **Environment mutation is human-owned:** agents cannot add or rewrite service definitions.
- **Recoverable actions first:** inspect logs, reuse process, or restart a managed service precede
  destructive choices.

## Delivery roadmap

### Phase 0 — Feasibility and ownership spikes

Prove the risky runtime seams before committing to wire types or UI:

1. Select the existing Arc controller primitive that can own a long-running service without creating
   a third process-management subsystem.
2. Prove root-process and descendant attribution on Windows for representative chains: PowerShell →
   task/npm → Go/Node.
3. Correlate TCP listeners to descendant PIDs and distinguish an external port owner.
4. Stream and retain a bounded service log without mounting a visible terminal.
5. Validate that controller teardown kills only the managed service tree and does not touch unrelated
   Arc or packaged processes.
6. Parse this repository's Taskfile/package metadata into a read-only candidate report with exact
   provenance and no model call.

**Exit evidence:** a CLI or test harness starts two dependent sample services, attributes their child
processes and ports, streams logs, reports a conflict, and tears them down without an orphan.

### Phase 1 — Project definition and deterministic detection

- Extend the registered Project contract with a versioned environment definition.
- Add source-specific candidate parsers and a bounded project detector.
- Add candidate normalization, stable identities, confidence, provenance, and overlap warnings.
- Add semantic rescan diffing.
- Add a setup/review UI for one project.
- Persist only the approved definition through a validated environment-specific command.

No service launch is required in this phase. The deliverable is a trustworthy answer to: “What would
Arc run, from where did it learn that, and what changed since approval?”

**Exit evidence:** representative fixtures for package scripts, workspaces, Taskfile, Compose, opaque
composites, overlaps, removals, and malicious/invalid paths; live review against `waveterm` without
executing a command.

### Phase 2 — Managed multi-service runtime

- Materialize one runtime state machine per approved service.
- Start and stop dependency graphs with bounded parallelism.
- Stream logs and expose controller/process/exit metadata.
- Add HTTP and TCP health checks.
- Attribute descendant processes and observed ports.
- Detect external port conflicts.
- Implement bounded on-failure restart policy; default remains no automatic restart.
- Reconstruct runtime state safely after a frontend reload.

**Exit evidence:** independent-service failure isolation, dependency blocking, reverse-order stop,
health transitions, port conflicts, restart-limit enforcement, reload recovery, and clean teardown.

### Phase 3 — Full Environment surface

- Add Environment to the Arc surface model and navigation.
- Build the service rail, service workspace, live-log viewer, and context rail.
- Add aggregate and per-service controls.
- Render setup, runtime, degraded, stopped, configuration-changed, and unsupported-project states.
- Add dependency and consumer displays plus a secondary topology mode.
- Add keyboard navigation and contextual footer hints through the existing keybinding registry.

**Exit evidence:** unit coverage for pure derivation and state transitions, typecheck/build gates, and a
CDP walkthrough using a real registered multi-service project.

### Phase 4 — Agent-aware environment

- Add the `wsh environment` read contract for status and bounded logs.
- Attach an environment summary to New Agent launches by registered project identity.
- Preserve the base-project association for worktree agents.
- Track agent consumers and attribute environment actions.
- Allow agent start/restart requests for declared services.
- Gate shared stop/restart actions on visible dependency and consumer confirmation.
- Surface environment state to Runs and Channels without duplicating ownership.

**Exit evidence:** two concurrent agents reuse one managed service, query its logs, avoid duplicate
startup, and cannot silently stop infrastructure used by the other agent.

### Phase 5 — Proactive diagnosis

- Add deterministic situation rules and evidence objects.
- Add active-situation deduplication keyed by factual state.
- Add bounded model-assisted diagnosis for ambiguous failures.
- Show evidence, inference, and safe actions separately.
- Record user disposition long enough to avoid repeated noise while facts are unchanged.
- Add “restart changed” only for services with an explicit, deterministic invalidation rule; do not
  infer restart requirements from arbitrary file edits.

**Exit evidence:** seeded failures produce one actionable situation each, unchanged failures do not
spam, model unavailability degrades to factual diagnostics, and no suggested action executes without
approval.

### Later extensions — explicitly outside the first roadmap

- Remote and SSH project environments.
- WSL-specific service ownership.
- Containers as first-class runtime objects beyond Compose command integration.
- Team-shared repository manifests.
- Historical metrics, alerting, and dashboards.
- Automatic repair policies.
- Multiple named environments per project.
- Per-worktree isolated infrastructure.
- Kubernetes or general workflow-DAG orchestration.

These require separate evidence and designs. They must not expand the initial local Windows scope.

## Testing and verification strategy

### Pure tests

- Manifest parsing and provenance.
- Candidate normalization and stable identity.
- Overlap and composite detection.
- Rescan diffs.
- Dependency validation, cycle rejection, and topological levels.
- Aggregate environment state.
- Situation derivation and deduplication.
- Agent permission decisions.

### Backend integration tests

- Project configuration validation and round-trip.
- Controller lifecycle and log retention.
- Process-tree attribution.
- Port conflict detection.
- Health checks and bounded retries.
- Dependency start/stop ordering.
- Crash recovery and frontend reconnect.

### Live Windows gates

- PowerShell/task/npm child-process attribution.
- TCP listener ownership.
- External-process conflict behavior.
- Stop/restart with multiple agent consumers.
- No surviving managed processes after environment stop or Arc exit.
- No impact on a separately installed production Arc instance during dev verification.

### UI gates

- Setup proposal and rescan diff.
- Healthy, degraded, failed, blocked, and stopped services.
- Large-log following, scroll-away, and jump-to-latest behavior.
- Narrow-window rail degradation.
- Keyboard-only service navigation and control.
- Agent consumer and confirmation surfaces.

## Success criteria

The first complete release succeeds when, for one registered local Windows project:

1. Arc deterministically discovers a useful multi-service proposal without a model call.
2. The user can verify provenance, correct it once, and save it.
3. Arc reliably starts, observes, and stops the approved dependency graph.
4. Logs, health, ports, process ownership, and failures are visible in one surface.
5. Two agents reuse the same environment and can read its status and logs.
6. An agent cannot silently disrupt a shared service.
7. A concrete failure produces a bounded, evidence-backed diagnosis without notification spam.
8. All destructive actions remain explicit and attributable.

## Architectural principles

- **Project is the ownership boundary.** No parallel environment registry.
- **Definition is durable; runtime is derived.** Do not persist stale process truth.
- **Code discovers and routes; models explain and judge.** Never reverse this boundary.
- **Reuse Arc controllers.** Do not create a third process lifecycle system.
- **Confidence is visible.** Preserve source provenance and uncertainty.
- **Multi-service is first-class.** A list of unrelated terminal commands is insufficient.
- **Agents share infrastructure.** Prevent duplicate servers by design.
- **Earn automation through evidence.** Observe, diagnose, request, then consider policy later.
- **Keep v1 local and bounded.** Remote, container-native, and team-sharing concerns come later.

## Related code and documents

- Projects registry: `pkg/wconfig/settingsconfig.go`, `frontend/app/view/agents/projectsstore.ts`
- Project commands: `pkg/wshrpc/wshserver/wshserver.go`
- New Agent project join: `frontend/app/view/agents/newagentmodal.tsx`
- Agent launch path: `frontend/app/cockpit/cockpit-actions.ts`
- Process/controller foundation: `pkg/blockcontroller`, `pkg/jobcontroller`, `pkg/shellexec`
- Typed RPC contract: `pkg/wshrpc/wshrpctypes.go`
- Cockpit surface router: `frontend/app/view/agents/cockpitshell.tsx`
- Agent orchestration roadmap: `docs/orchestrator-roadmap.md`
- App skeleton: `docs/redesign-meta-spec.md`

