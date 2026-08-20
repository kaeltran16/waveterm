# Route Chain + Draft-First DAG Creation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make runtime+tier routing a backend-enforced four-rung chain, and make orchestrator creation a client-side DAG draft that creates no Run until the user launches it from a Stage-local modal.

**Architecture:** Go owns valid run-worker capabilities, legacy normalization, persistence validation, and launch arguments in `pkg/runroute`; every create, submit, phase, and DAG spawn boundary consumes that authority. The frontend derives labels and picker rows only from `HarnessInfo.routecapabilities`, keeps route and draft decisions in pure tested modules, and uses a discriminated Stage-local modal state. Pipeline and quick dispatch directly; orchestrator dispatch produces a `DagDraftRequest`, then an injected launch transaction performs deferred CreateRun → DagSubmit → cleanup-on-failure.

**Tech Stack:** Go (`waveobj`, `wconfig`, `wshrpc`, `jarvis`, `orchestrate`), React 19, TypeScript, jotai, Tailwind 4, `motion/react`, `@xyflow/react`, Vitest, Go tests, generated Go/TypeScript bindings, and the existing CDP UI harness.

## Global Constraints

- Treat commit `f61d0371` as landed. Do not reimplement `deferstart`; Task 1 only repairs its event placement and regression coverage.
- Read `docs/superpowers/specs/2026-08-20-route-chain-and-dag-modal-design.md` and `DESIGN.md` before changing code. Screens 04–11 from `.superpowers/brainstorm/349-1787195026/content/` are the approved UI reference; if that session artifact is unavailable, do not invent a replacement visual language—implement the approved spec and record the unavailable comparison in Task 12.
- One writer works these tasks serially in the shared worktree. No implementation tasks run in parallel.
- Follow TDD for every behavior change: add the failing assertion, run the exact targeted command and observe the intended failure, implement the minimum change, rerun the target, then run the task-level regression command.
- Commands are run from `C:/Users/kael02/IdeaProjects/waveterm/.worktrees/route-chain-dag-modal`. For Go packages that reach sqlite-vec, use the Windows-safe Git Bash form `CGO_CFLAGS="-IC:/Users/kael02/IdeaProjects/waveterm/.worktrees/route-chain-dag-modal/pkg/jarvisembed/csrc" go test ...`.
- Typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json`; plain `npx tsc` stack-overflows in this repository.
- After changing a `wshrpc`, `waveobj`, or `wconfig` type, run `task generate`, inspect the generated diff, and rerun the larger-stack typecheck. Never hand-edit `frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts`, `pkg/wshrpc/wshclient/wshclient.go`, or generated settings schema output.
- Do not add a dependency. Do not add SCSS. Component colors use Tailwind `@theme` utilities or existing token-backed CSS variables—no raw component hex/rgba. Tokenize only ReactFlow lines touched by this feature; do not sweep unrelated graph styling.
- The modal follows `DESIGN.md`: `motion/react` and shared motion tokens, reduced-motion support, one Escape owner, target-only backdrop dismissal, `role="dialog"`, `aria-modal="true"`, `aria-labelledby`, initial focus, Tab/Shift+Tab trap, and focus restoration. No jsdom render/snapshot tests; use pure utility tests plus CDP accessibility/visual assertions.
- Every task ends green and is independently reviewable. The commit messages below are pre-approved for plan execution; commit after the task checks pass, but never push. Do not add co-author lines.
- Use explicit `git add <paths>` only. The modified `docs/lead-authored-task-routing-roadmap.md` and untracked `docs/superpowers/specs/2026-08-20-orchestrator-jarvis-ui-design.md` are pre-existing user work: do not stage, overwrite, or reformat them.
- The repaired spec and this plan must ship with feature code, never as a docs-only commit. Task 1 safely folds temporary commit `b55bad81` into the first feature commit. Stop rather than rewriting history if the verified commit/file preconditions no longer match.

---

### Task 1: Repair the deferred lifecycle event contract

**Files:**
- Modify: `pkg/wshrpc/wshserver/wshserver_runs.go`
- Test: `pkg/wshrpc/wshserver/wshserver_run_test.go`
- Test: `pkg/wshrpc/wshserver/wshserver_dag_test.go`
- Include in feature commit: `docs/superpowers/specs/2026-08-20-route-chain-and-dag-modal-design.md`
- Include in feature commit: `docs/superpowers/plans/2026-08-20-route-chain-and-dag-modal.md`

**Interfaces:**
- Consumes: landed `CommandCreateRunData.DeferStart`, `appendRunEvent`, `DagSubmitCommand`'s planning → executing guard, and `mustSeq`'s oldest-first lifecycle projection.
- Produces: deferred CreateRun event sequence `[run-created]`; first planning → executing DagSubmit appends `phase-started@0`; repeated submit while already executing appends no second phase-started; non-deferred CreateRun remains `[run-created, phase-started@0]` and still spawns phase zero.

- [ ] **Step 1: Add the failing exact-event assertions.** Extend `TestCreateRunDeferStart` to assert `mustSeq(...)` equals only `[]string{waveobj.RunEventKindCreated}` immediately after create. Extend `TestDagSubmitDeferredRun` to assert the sequence becomes `run-created, phase-started@0`, submit a second valid group against the now-executing run, and assert `phase-started@0` still occurs exactly once. Add a non-deferred create assertion if no existing test pins its two-event sequence.

- [ ] **Step 2: Prove the regression.** Run:

  ```bash
  CGO_CFLAGS="-IC:/Users/kael02/IdeaProjects/waveterm/.worktrees/route-chain-dag-modal/pkg/jarvisembed/csrc" go test ./pkg/wshrpc/wshserver -run 'TestCreateRunDeferStart|TestDagSubmitDeferredRun|TestCreateRunNonDeferredLifecycle'
  ```

  Expected: the deferred create assertion fails because `CreateRunCommand` currently appends `phase-started` unconditionally. If the exact non-deferred test name differs, use the name added in Step 1.

- [ ] **Step 3: Move only the event append.** Keep `run-created` before the defer branch. Move `phaseZero := 0` and the `RunEventKindPhaseStarted` append into the existing `if !data.DeferStart` block immediately before `spawnRunWorkers`. Do not alter DagSubmit's existing `if run.Status == planning` event append; its transition guard is the exact-once authority.

- [ ] **Step 4: Verify target and package.** Rerun Step 2, then:

  ```bash
  CGO_CFLAGS="-IC:/Users/kael02/IdeaProjects/waveterm/.worktrees/route-chain-dag-modal/pkg/jarvisembed/csrc" go test ./pkg/wshrpc/wshserver
  ```

  Expected: both commands pass.

- [ ] **Step 5: Commit by safely folding the repaired spec commit into this feature commit.** First verify the history and file boundary:

  ```bash
  git status --short
  git rev-parse HEAD
  git diff-tree --no-commit-id --name-only -r b55bad81
  git show --stat --oneline b55bad81
  ```

  Preconditions: `HEAD` is `b55bad81`; that commit changes only `docs/superpowers/specs/2026-08-20-route-chain-and-dag-modal-design.md`; unrelated user files remain unstaged. Then run:

  ```bash
  git reset --soft f61d0371
  git add pkg/wshrpc/wshserver/wshserver_runs.go pkg/wshrpc/wshserver/wshserver_run_test.go pkg/wshrpc/wshserver/wshserver_dag_test.go docs/superpowers/specs/2026-08-20-route-chain-and-dag-modal-design.md docs/superpowers/plans/2026-08-20-route-chain-and-dag-modal.md
  git diff --cached --name-only
  git commit -m "fix(runs): enforce deferred lifecycle event contract"
  ```

  The staged-name review must not include the roadmap or orchestrator UI spec. This replaces temporary spec-only commit `b55bad81` with one feature commit rooted directly on `f61d0371`.

---

### Task 2: Add backend route types, authority, and capability RPC data

**Files:**
- Create: `pkg/runroute/runroute.go`
- Test: `pkg/runroute/runroute_test.go`
- Modify: `pkg/waveobj/wtype.go`
- Modify: `pkg/wconfig/settingsconfig.go`
- Modify: `pkg/wconfig/metaconsts.go`
- Modify: `pkg/wshrpc/wshrpctypes_jarvis.go`
- Modify: `pkg/wshrpc/wshserver/wshserver_jarvis.go`
- Test: `pkg/wshrpc/wshserver/wshserver_harness_test.go`
- Regenerate: `schema/settings.json`
- Regenerate: `frontend/types/gotypes.d.ts`
- Regenerate: `frontend/app/store/wshclientapi.ts`
- Regenerate: `pkg/wshrpc/wshclient/wshclient.go`

**Interfaces:**
- Consumes: `consult.Tier`, `consult.CheapModel`, `consult.MidModel`, `consult.PiCheapModel`, `consult.PiMidModel`, the `harness.ProbeResult` installation/capability flags, and existing `probeHarnesses` test seam.
- Produces:

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

  func Capabilities(runtime string) []Capability
  func Resolve(pin waveobj.RoutePin) (Capability, error)
  func NormalizeLegacy(runtime, tier string) waveobj.RoutePin
  ```

  `waveobj.Run.Tier`, `waveobj.RunSpec.Tier`, `waveobj.ProfileOverride.Route *RoutePin`, `wconfig.SettingsType.HarnessPreferredTier`, `ConfigKey_HarnessPreferredTier`, and `HarnessInfo.RouteCapabilities []runroute.Capability` are additive. Do not add Route to `JarvisProfile`.

- [ ] **Step 1: Write the authority tests first.** Table-test all eight valid v1 pairs: Pi cheap/mid/capable, Claude cheap/mid/capable, Codex capable, OpenCode capable. Assert exact `ResolvedModel` and `ModelArgs`: Pi always `--model <deepseek id>`; Claude cheap/mid have `--model haiku|sonnet`; Claude/Codex/OpenCode capable have no model args and label `operator default`. Assert OpenRouter, empty/unknown runtime, empty/unknown tier, and unsupported Codex/OpenCode cheap/mid all fail. Assert returned slices cannot mutate later calls.

- [ ] **Step 2: Extend the harness RPC test before implementation.** In the probe fixture make Pi installed+run-worker-capable, Claude unavailable, and one row non-run-worker-capable. Assert only Pi receives route capabilities, unavailable/non-worker rows receive an empty list, the capabilities match `runroute.Capabilities("pi")`, and OpenRouter is still absent.

- [ ] **Step 3: Observe the failures.** Run:

  ```bash
  go test ./pkg/runroute ./pkg/wshrpc/wshserver -run 'Test.*(Route|Capability|ListHarnesses)'
  ```

  Expected: `pkg/runroute` and new fields do not exist.

- [ ] **Step 4: Implement the single table.** Build one immutable package-level capability table in `pkg/runroute`; derive all lookups and model args from it. Reuse the exported consult constants rather than copying model IDs. `Resolve` trims nothing and silently substitutes nothing: it rejects incomplete/unknown/unsupported pins with errors naming runtime and tier. `NormalizeLegacy` only fills historical empties (`runtime == ""` → `claude`, `tier == ""` → `capable`); callers decide whether legacy normalization is allowed.

- [ ] **Step 5: Add additive model/config/RPC fields.** Use `omitempty` on persisted `Run.Tier`, `RunSpec.Tier`, and `ProfileOverride.Route` for migration-safe reads. Add `harness:preferredtier` to `SettingsType` and config constants. Populate `RouteCapabilities` in `ListHarnessesCommand` only when `Installed && RunWorkerCapable`; copy capability slices so callers cannot mutate package state.

- [ ] **Step 6: Verify and generate.** Run:

  ```bash
  go test ./pkg/runroute
  CGO_CFLAGS="-IC:/Users/kael02/IdeaProjects/waveterm/.worktrees/route-chain-dag-modal/pkg/jarvisembed/csrc" go test ./pkg/wshrpc/wshserver -run 'TestListHarnesses'
  task generate
  node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
  ```

  Inspect generated files to confirm `RoutePin`, optional persisted tier/route fields, preferred-tier config, and `HarnessInfo.routecapabilities`; do not edit them.

- [ ] **Step 7: Commit.**

  ```bash
  git add pkg/runroute pkg/waveobj/wtype.go pkg/wconfig/settingsconfig.go pkg/wconfig/metaconsts.go pkg/wshrpc/wshrpctypes_jarvis.go pkg/wshrpc/wshserver/wshserver_jarvis.go pkg/wshrpc/wshserver/wshserver_harness_test.go schema/settings.json frontend/types/gotypes.d.ts frontend/app/store/wshclientapi.ts pkg/wshrpc/wshclient/wshclient.go
  git commit -m "feat(route): add backend run-route capability authority"
  ```

---

### Task 3: Validate and persist Settings and Channel route pairs atomically

**Files:**
- Modify: `pkg/wshrpc/wshserver/wshserver.go`
- Modify: `pkg/wshrpc/wshserver/wshserver_channels.go`
- Test: `pkg/wshrpc/wshserver/wshserver_routeconfig_test.go`
- Test: `pkg/wshrpc/wshserver/wshserver_profile_test.go`
- Modify: `frontend/app/view/agents/harnessstore.ts`
- Test: `frontend/app/view/agents/harnessstore.test.ts`

**Interfaces:**
- Consumes: generic `SetConfigCommand`, `wconfig.SetBaseConfigValue`, `runroute.Resolve`, channel `ProfileOverride`, `jarvis.OverrideFromMeta`, and the existing profile-meta update transaction.
- Produces: a guarded SetConfig seam: if either `harness:preferredruntime` or `harness:preferredtier` is present, both must be present as non-empty strings, `runroute.Resolve` must accept the pair, and only then may `SetBaseConfigValue` write. Unrelated SetConfig patches remain unchanged. `SetChannelProfileCommand` validates non-nil `Override.Route` before `DBUpdateFn`; a route-only override is non-empty and nil route means inherit Settings. The transitional existing preference state keeps its current `runtime`/`persistedRuntime` fields and adds `tier`/`persistedTier`; its writer sends both keys and normalizes a missing loaded tier to `capable`, so current consumers continue compiling until Task 6's coordinated route-state refactor.

- [ ] **Step 1: Add settings boundary tests.** Point `wavebase.ConfigHome_VarCache` at `t.TempDir()`. Seed a valid pair, attempt an unsupported pair and a one-key patch, and assert each returns an error and the previously stored runtime+tier are both unchanged. Assert an unrelated config patch still writes. Use the real `SetConfigCommand`, not only a helper.

- [ ] **Step 2: Add channel tests.** Submit a valid route-only override and assert `jarvis.OverrideFromMeta(reloaded).Route` round-trips while `GetJarvisProfileCommand(...).Override.Route` exposes it and `Resolved` has no route field. Submit an invalid pair and assert profile meta is not created/changed. Submit nil route with no other sections and assert the override key is removed.

- [ ] **Step 3: Add preference transition tests.** Add `tier` and `persistedTier` beside the existing runtime fields. Assert initialization with runtime plus empty tier yields capable, save success persists both fields, and save failure restores both fields. Do not rename/remove `runtime` yet; current composer, picker, Pet, palette, and rail consumers keep reading it during this transitional task.

- [ ] **Step 4: Observe failures.** Run:

  ```bash
  CGO_CFLAGS="-IC:/Users/kael02/IdeaProjects/waveterm/.worktrees/route-chain-dag-modal/pkg/jarvisembed/csrc" go test ./pkg/wshrpc/wshserver -run 'Test(SetConfigPreferredRoute|SetChannelProfile.*Route|GetJarvisProfile.*Route)'
  npx vitest run frontend/app/view/agents/harnessstore.test.ts
  ```

- [ ] **Step 5: Implement the guarded generic seam.** Add a small `validatePreferredRoutePatch` helper beside `SetConfigCommand`; it reads both values from the incoming map, rejects partial/non-string data, calls `runroute.Resolve`, and returns before `SetBaseConfigValue` on error. This is smaller than a new RPC and preserves every existing generic settings caller.

- [ ] **Step 6: Implement channel validation and empty detection.** Validate route before principle normalization and before `DBUpdateFn`. Include `data.Override.Route == nil` in the empty-override predicate; do not copy route into `JarvisProfile` or `ResolveProfile`.

- [ ] **Step 7: Send atomic pairs from the existing preference action.** Extend the existing transition helpers to update runtime+tier together, make `setPreferredHarness` keep the current tier (capable for a legacy load), and have the RPC patch contain both config keys. Task 6 will replace run-facing UI with `setPreferredRoute`; this step prevents the guarded server from breaking current callers between commits.

- [ ] **Step 8: Verify.** Rerun Step 4, then:

  ```bash
  CGO_CFLAGS="-IC:/Users/kael02/IdeaProjects/waveterm/.worktrees/route-chain-dag-modal/pkg/jarvisembed/csrc" go test ./pkg/wshrpc/wshserver
  node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
  ```

- [ ] **Step 9: Commit.**

  ```bash
  git add pkg/wshrpc/wshserver/wshserver.go pkg/wshrpc/wshserver/wshserver_channels.go pkg/wshrpc/wshserver/wshserver_routeconfig_test.go pkg/wshrpc/wshserver/wshserver_profile_test.go frontend/app/view/agents/harnessstore.ts frontend/app/view/agents/harnessstore.test.ts
  git commit -m "feat(route): validate settings and channel route persistence"
  ```

---

### Task 4: Enforce Run routes at create and every phase-worker launch

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_runs.go`
- Modify: `pkg/wshrpc/wshserver/wshserver_runs.go`
- Modify: `pkg/jarvis/runexec.go`
- Test: `pkg/jarvis/runexec_test.go`
- Test: `pkg/wshrpc/wshserver/wshserver_run_test.go`
- Test: `pkg/wshrpc/wshserver/wshserver_spawn_test.go`
- Test: `pkg/wshrpc/wshserver/wshserver_childrun_test.go`
- Signature-only updates: `pkg/wshrpc/wshserver/wshserver_dag_test.go`
- Signature-only updates: `pkg/orchestrate/engine.go`
- Signature-only updates: `pkg/orchestrate/engine_test.go`
- Signature-only updates: `pkg/orchestrate/watchdog_test.go`
- Modify: `frontend/app/view/agents/runactions.ts`
- Update direct RPC fixtures: `scripts/cdp/scenarios.mjs`
- Update direct RPC fixtures: `scripts/cdp-e2e-runs-piece4.mjs`
- Update direct RPC fixtures: `scripts/cdp-profile-verify.mjs`
- Regenerate: `frontend/types/gotypes.d.ts`
- Regenerate: `frontend/app/store/wshclientapi.ts`
- Regenerate: `pkg/wshrpc/wshclient/wshclient.go`

**Interfaces:**
- Consumes: `runroute.Resolve`, `runroute.NormalizeLegacy`, `validateHarness(runtime, harness.OperationRunWorker)`, persisted `Run.Runtime + Run.Tier`, and existing unattended adapter bases.
- Produces:

  ```go
  type CommandCreateRunData struct {
      // existing fields...
      Runtime string `json:"runtime"`
      Tier    string `json:"tier"`
  }

  func RunWorkerSpecFor(cap runroute.Capability, prompt string) (RunWorkerSpec, bool)

  var SpawnRunWorker = func(
      ctx context.Context,
      cap runroute.Capability,
      workspaceId, projectName, cwd, prompt string,
  ) (string, error)

  func EnsureWorkers(
      ctx context.Context,
      run *waveobj.Run,
      cap runroute.Capability,
      projectName string,
  ) (map[int]string, error)
  ```

  CreateRun rejects missing/invalid/unavailable routes before `AppendRun`, persists both fields, and passes the validated capability to phase launch. Legacy persisted runs normalize empty runtime to Claude and empty tier to capable before validation/capability lookup. CreateChildRun inherits and persists that normalized parent pair.

- [ ] **Step 1: Expand adapter tests first.** Table-test exact args for all valid capabilities. Assert Pi model args precede its positional prompt; Claude cheap/mid include `--model` before the prompt; capable Claude/Codex/OpenCode add no model flag. Assert a capability/runtime mismatch or unsupported capability cannot produce a worker spec.

- [ ] **Step 2: Expand CreateRun and phase tests.** Add cases for missing tier, unsupported pair, and unavailable harness; each asserts zero persisted runs and zero spawn calls. Change the success case to assert both persisted fields and captured capability. Change `TestAdvanceRun_SpawnsPersistedRuntime` to assert runtime+tier/model args. Add a legacy persisted Run with empty Tier and assert phase launch receives capable and does not rewrite the historical Run merely to execute it.

- [ ] **Step 3: Expand child and race tests.** Child tests assert normalized parent runtime+tier are persisted on the child and used for spawn. The concurrent spawn test captures a `runroute.Capability` and still proves exactly one call.

- [ ] **Step 4: Observe the failures.** Run:

  ```bash
  go test ./pkg/jarvis -run 'TestRunWorkerSpecFor'
  CGO_CFLAGS="-IC:/Users/kael02/IdeaProjects/waveterm/.worktrees/route-chain-dag-modal/pkg/jarvisembed/csrc" go test ./pkg/wshrpc/wshserver -run 'Test(CreateRunCommand|AdvanceRun_Spawns|SpawnRunWorkers|CreateChildRunCommand)'
  ```

- [ ] **Step 5: Make the adapter capability-aware.** `RunWorkerSpecFor` switches only on `cap.Runtime` for the unattended base and inserts `cap.ModelArgs`; it must not inspect tier or recreate a model matrix. `SpawnRunWorker` and `EnsureWorkers` accept the already-resolved capability.

- [ ] **Step 6: Validate at both Run boundaries.** In CreateRun call `runroute.Resolve` and `validateHarness` before channel load/AppendRun, then persist runtime+tier and launch with the capability. In `spawnRunWorkers`, read the persisted Run, normalize legacy fields, resolve the capability, re-run `validateHarness`, and only then call `EnsureWorkers`. This recheck covers later phases and harness availability changes.

- [ ] **Step 7: Keep manual child creation consistent.** `CreateChildRunCommand` normalizes the parent route, validates pair+availability before `AppendRun`, persists both fields, and relies on `spawnRunWorkers` for the launch recheck. Preserve all existing parent-mode, principle, and notification behavior.

- [ ] **Step 8: Update every signature/caller mechanically.** Run and resolve every hit:

  ```bash
  git grep -n -E 'RunWorkerSpecFor\(|SpawnRunWorker[ (:=]|spawnWorker[ (:=]|CommandCreateRunData\{|"createrun"'
  ```

  Update test stubs to capture `runroute.Capability`. Until Task 6 supplies selected frontend tiers, `runactions.createRun` sends explicit `capable`, the defined legacy settings default. Add `tier: "capable"` to direct CDP RPC fixtures; do not change their goals/modes.

- [ ] **Step 9: Generate and verify.** Run:

  ```bash
  task generate
  go test ./pkg/jarvis
  go test ./pkg/orchestrate
  CGO_CFLAGS="-IC:/Users/kael02/IdeaProjects/waveterm/.worktrees/route-chain-dag-modal/pkg/jarvisembed/csrc" go test ./pkg/wshrpc/wshserver
  node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
  ```

- [ ] **Step 10: Commit.**

  ```bash
  git add pkg/wshrpc/wshrpctypes_runs.go pkg/wshrpc/wshserver/wshserver_runs.go pkg/jarvis/runexec.go pkg/jarvis/runexec_test.go pkg/wshrpc/wshserver/wshserver_run_test.go pkg/wshrpc/wshserver/wshserver_spawn_test.go pkg/wshrpc/wshserver/wshserver_childrun_test.go pkg/wshrpc/wshserver/wshserver_dag_test.go pkg/orchestrate/engine.go pkg/orchestrate/engine_test.go pkg/orchestrate/watchdog_test.go frontend/app/view/agents/runactions.ts scripts/cdp/scenarios.mjs scripts/cdp-e2e-runs-piece4.mjs scripts/cdp-profile-verify.mjs frontend/types/gotypes.d.ts frontend/app/store/wshclientapi.ts pkg/wshrpc/wshclient/wshclient.go
  git commit -m "feat(route): enforce persisted run routes at worker launch"
  ```

---

### Task 5: Validate DAG task routes and use one effective capability for spawn and child persistence

**Files:**
- Modify: `pkg/wshrpc/wshserver/wshserver_dag.go`
- Test: `pkg/wshrpc/wshserver/wshserver_dag_test.go`
- Modify: `pkg/orchestrate/engine.go`
- Test: `pkg/orchestrate/engine_test.go`
- Test: `pkg/orchestrate/watchdog_test.go`

**Interfaces:**
- Consumes: owning Run's normalized route, `TaskNode.RunSpec.Runtime + Tier`, `runroute.Resolve`, submit-side `validateHarness`, engine-side `harness.ValidateInstalled` behind a `validateWorkerHarness` test seam, and capability-aware `spawnWorker` from Task 4.
- Produces:

  ```go
  func effectiveTaskRoute(task *waveobj.TaskNode, owner *waveobj.Run) waveobj.RoutePin

  func childRunFromSpec(
      g *waveobj.TaskGroup,
      task *waveobj.TaskNode,
      owner *waveobj.Run,
      route waveobj.RoutePin,
      cwd, goal string,
  ) waveobj.Run
  ```

  New submit payloads accept both task pin fields or neither and validate every effective route before `AppendDag`. Runtime execution accepts a persisted legacy runtime-only task as runtime+capable. Spawn and child Run use the same resolved capability/pin; task pin wins over owner route.

- [ ] **Step 1: Add submit rejection tests.** Table cases: runtime-only, tier-only, unknown runtime, unknown tier, unsupported pair, and unavailable harness. For each, call `DagSubmitCommand`, assert error, unchanged `run.DagORef`, unchanged running-DAG count, and zero spawn calls. Add valid pinned and inherited cases.

- [ ] **Step 2: Add the scheduler regression that fails on current code.** Owner route Claude/mid; ready task pin Pi/cheap. Stub `spawnWorker` to capture capability. After `ScheduleOnce`, assert captured Pi/cheap with Pi flash model args, and load the child Run to assert `Runtime == "pi"` and `Tier == "cheap"`. This must fail against the current `spawnWorker(... owner.Runtime ...)` and missing child persistence.

- [ ] **Step 3: Add legacy execution coverage.** Persist a TaskGroup directly with runtime-only `RunSpec{Runtime:"claude"}` (bypassing new-submit validation), schedule it, and assert capability and child fields normalize to Claude/capable. Add an inherited task case proving the owning Run's normalized route is used.

- [ ] **Step 4: Observe failures.** Run:

  ```bash
  CGO_CFLAGS="-IC:/Users/kael02/IdeaProjects/waveterm/.worktrees/route-chain-dag-modal/pkg/jarvisembed/csrc" go test ./pkg/wshrpc/wshserver -run 'TestDagSubmit.*Route'
  go test ./pkg/orchestrate -run 'TestScheduleOnce.*Route'
  ```

- [ ] **Step 5: Validate all tasks before persistence.** In `DagSubmitCommand`, load the owner, then before `NewTaskGroup` iterate tasks: reject XOR presence of runtime/tier; choose explicit pair or normalized owner pair; call `runroute.Resolve`; call `validateHarness(...OperationRunWorker)`. Do not append/link/schedule until the entire list passes.

- [ ] **Step 6: Resolve once per task at runtime.** At the top of each `NextToSpawn` iteration, derive the legacy-aware effective pin, resolve it, and recheck installation through `validateWorkerHarness` before creating a worktree or spawning. On route/availability failure mark that task failed and do not call `spawnWorker`. Pass the capability to spawn and the same pin to `childRunFromSpec`.

- [ ] **Step 7: Persist the effective child route.** Set `run.Runtime` and `run.Tier` in `childRunFromSpec`; preserve mode, DAG oref, BaseCommit, worktree cwd, prompt, and existing scheduling semantics.

- [ ] **Step 8: Verify.** Rerun Step 4, then:

  ```bash
  go test ./pkg/orchestrate
  CGO_CFLAGS="-IC:/Users/kael02/IdeaProjects/waveterm/.worktrees/route-chain-dag-modal/pkg/jarvisembed/csrc" go test ./pkg/wshrpc/wshserver
  ```

- [ ] **Step 9: Commit.**

  ```bash
  git add pkg/wshrpc/wshserver/wshserver_dag.go pkg/wshrpc/wshserver/wshserver_dag_test.go pkg/orchestrate/engine.go pkg/orchestrate/engine_test.go pkg/orchestrate/watchdog_test.go
  git commit -m "feat(route): enforce effective routes for DAG children"
  ```

---

### Task 6: Build the frontend route resolver, store, picker, and persistence controls

**Files:**
- Create: `frontend/app/view/agents/route.ts`
- Test: `frontend/app/view/agents/route.test.ts`
- Create: `frontend/app/view/agents/routepicker.tsx`
- Modify: `frontend/app/view/agents/harnessstore.ts`
- Test: `frontend/app/view/agents/harnessstore.test.ts`
- Modify: `frontend/app/view/agents/cockpitshell.tsx`
- Modify: `frontend/app/view/agents/settingssurface.tsx`
- Modify: `frontend/app/view/agents/runactions.ts`
- Modify: `frontend/app/view/jarvis/profilemodel.ts`
- Test: `frontend/app/view/jarvis/profilemodel.test.ts`
- Modify: `frontend/app/view/jarvis/profilepanel.tsx`
- Modify: `frontend/app/view/jarvis/stage.tsx`
- Modify caller: `frontend/app/view/jarvis/stagecomposer.tsx`
- Modify caller: `frontend/app/view/jarvis/stagerail.tsx`
- Modify caller: `frontend/app/cockpit/command-palette.tsx`
- Modify compatibility consumer: `frontend/app/view/agents/channelcomposers.tsx`
- Modify compatibility consumer: `frontend/app/view/agents/harnesspicker.tsx`
- Modify compatibility consumer: `frontend/app/view/agents/newagentmodal.tsx`
- Modify compatibility consumer: `frontend/app/view/jarvis/peterrand.tsx`

**Interfaces:**
- Consumes: generated `RoutePin`, `HarnessInfo.routecapabilities`, generated `ProfileOverride.route`, both preferred settings keys, and `CommandGetJarvisProfileRtnData.Override.Route`.
- Produces:

  ```ts
  export type RouteSource = "task" | "run" | "channel" | "settings";
  export type RouteCapability = NonNullable<HarnessInfo["routecapabilities"]>[number];
  export type EffectiveRoute = {
      pin: RoutePin;
      source: RouteSource;
      capability?: RouteCapability;
  };

  export function normalizeLegacyRoute(runtime: string, tier?: string): RoutePin | null;
  export function capabilityFor(pin: RoutePin, harnesses: HarnessInfo[]): RouteCapability | undefined;
  export function resolveEffectiveRoute(input: {
      settings: RoutePin | null;
      channel?: RoutePin | null;
      run?: RoutePin | null;
      task?: RoutePin | null;
      harnesses: HarnessInfo[];
  }): EffectiveRoute | null;
  export function routePickerItems(harnesses: HarnessInfo[]): RoutePickerSection[];

  export function RoutePicker(props: {
      value: RoutePin | null;
      onChange: (route: RoutePin | null) => void;
      canInherit?: boolean;
      inheritedLabel?: string;
      placement?: Placement;
      openRequest?: number;
  }): JSX.Element;
  ```

  Route resolution is Task → Run → Channel → Settings. Capabilities/labels come only from the backend response; there is no TS pair/model matrix. Settings cannot inherit; channel route can clear to inherit. `runactions.createRun` accepts an explicit `RoutePin` instead of a runtime string. `resolveChannelLaunchRoute(channelId): Promise<RoutePin>` fetches/caches `GetJarvisProfileCommand` when needed, combines its `override.route` with the Settings state and capabilities, and rejects rather than guessing when the effective pair is unavailable.

- [ ] **Step 1: Write route tests first.** Cover all four precedence rungs, nil channel override, clearing a task pin, Settings/Run empty-tier capable normalization, runtime-only legacy task capable normalization, and missing capability returning unresolved display metadata without substituting a pair. For picker rows inject a synthetic backend capability and assert it renders/selects; omit a tier and assert it does not appear. This proves there is no frontend matrix.

- [ ] **Step 2: Expand store/profile tests.** Assert settings boot reads runtime+tier together and missing tier becomes capable. Assert `setPreferredRoute` transitions both values atomically. Extend `sectionSource`/dirty/empty normalization expectations so route is project-scoped, a route-only override is dirty/non-empty, and clearing route restores inheritance without affecting playbook/principles.

- [ ] **Step 3: Observe failures.** Run:

  ```bash
  npx vitest run frontend/app/view/agents/route.test.ts frontend/app/view/agents/harnessstore.test.ts frontend/app/view/jarvis/profilemodel.test.ts
  ```

- [ ] **Step 4: Implement pure route derivation.** `routePickerItems` iterates `h.routecapabilities ?? []` exactly as returned. `capabilityFor` compares runtime+tier only. The one frontend literal `capable` is confined to documented legacy normalization, not pair validation. Preserve `operator default` from the backend label.

- [ ] **Step 5: Implement the controlled RoutePicker.** Follow `HarnessPicker`'s Floating UI/`PopoverReveal` pattern. The face shows harness label, tier, and `resolvedmodel`; unavailable/no-capability routes show an invalid label and cannot dispatch. Each option has `aria-pressed`, a stable `data-testid="route-option-<runtime>-<tier>"`, and visible unavailable text. `canInherit` adds one explicit inherit row that calls `onChange(null)`.

- [ ] **Step 6: Finish the settings store.** Replace Task 3's transitional four scalar fields with `route: RoutePin | null` and `persistedRoute: RoutePin | null` in one coordinated edit of every consumer listed in Files. `cockpitshell.tsx` reads both config atoms. `setPreferredRoute` sends both keys in one SetConfig call and rolls both back on failure. `setPreferredHarness` remains only for consult compatibility: choose the same-tier backend capability when present, otherwise the runtime's backend-provided capable capability; if neither exists, surface an error rather than fabricating a route.

- [ ] **Step 7: Add persistence controls.** Add a `Run route` row/section in Settings using `RoutePicker` with `canInherit={false}`. In project scope of `ProfilePanel`, add `RoutePicker value={draft.route ?? null}` with inherit/reset; do not add it to `GlobalProfileEditor` or `JarvisProfile`. Update `overrideIsEmpty` and save/cache handling.

- [ ] **Step 8: Cache channel override separately from resolved profile.** Extend `runactions` with a channel-keyed override atom populated by the existing `GetJarvisProfileCommand` response; keep `resolvedProfileAtom` for `JarvisProfile`. `refreshResolvedProfile` updates both. `Stage` reads `override.route` directly and passes it to the composer in Task 7. Do not derive it from `Resolved`.

- [ ] **Step 9: Refactor createRun and callers to explicit pins.** Change `createRun(channelId, goal, route, opts)` to send `route.runtime` and `route.tier`. Add `resolveChannelLaunchRoute(channelId)` as specified above. Update StageComposer, StageRail, and command-palette callers to await that helper before direct creation while preserving existing mode/goal/origin behavior; a resolution error leaves their draft/action intact and surfaces through the existing error path. The composer-specific shape decision comes in Task 7.

- [ ] **Step 10: Verify.** Run:

  ```bash
  npx vitest run frontend/app/view/agents/route.test.ts frontend/app/view/agents/harnessstore.test.ts frontend/app/view/jarvis/profilemodel.test.ts frontend/app/view/agents/harnesspicker.test.ts
  node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
  npx eslint frontend/app/view/agents/route.ts frontend/app/view/agents/routepicker.tsx frontend/app/view/agents/harnessstore.ts frontend/app/view/agents/cockpitshell.tsx frontend/app/view/agents/settingssurface.tsx frontend/app/view/agents/runactions.ts frontend/app/view/agents/channelcomposers.tsx frontend/app/view/agents/harnesspicker.tsx frontend/app/view/agents/newagentmodal.tsx frontend/app/view/jarvis/profilemodel.ts frontend/app/view/jarvis/profilepanel.tsx frontend/app/view/jarvis/stage.tsx frontend/app/view/jarvis/stagecomposer.tsx frontend/app/view/jarvis/stagerail.tsx frontend/app/view/jarvis/peterrand.tsx frontend/app/cockpit/command-palette.tsx
  ```

- [ ] **Step 11: Commit.**

  ```bash
  git add frontend/app/view/agents/route.ts frontend/app/view/agents/route.test.ts frontend/app/view/agents/routepicker.tsx frontend/app/view/agents/harnessstore.ts frontend/app/view/agents/harnessstore.test.ts frontend/app/view/agents/cockpitshell.tsx frontend/app/view/agents/settingssurface.tsx frontend/app/view/agents/runactions.ts frontend/app/view/agents/channelcomposers.tsx frontend/app/view/agents/harnesspicker.tsx frontend/app/view/agents/newagentmodal.tsx frontend/app/view/jarvis/profilemodel.ts frontend/app/view/jarvis/profilemodel.test.ts frontend/app/view/jarvis/profilepanel.tsx frontend/app/view/jarvis/stage.tsx frontend/app/view/jarvis/stagecomposer.tsx frontend/app/view/jarvis/stagerail.tsx frontend/app/view/jarvis/peterrand.tsx frontend/app/cockpit/command-palette.tsx
  git commit -m "feat(route): add capability-driven route controls"
  ```

---

### Task 7: Make composer shape+route dispatch deterministic and draft-first

**Files:**
- Create: `frontend/app/view/orchestrate/dagmodalstate.ts`
- Modify: `frontend/app/view/agents/composercommand.ts`
- Test: `frontend/app/view/agents/composercommand.test.ts`
- Modify: `frontend/app/view/agents/channelcomposers.tsx`
- Modify: `frontend/app/view/jarvis/stagecomposer.tsx`

**Interfaces:**
- Consumes: effective Settings → Channel route from Task 6, profile default mode only as initial shape, existing `@quick/@run/@ask` parser, Radar pending-draft branch, and `createRun`.
- Produces:

  ```ts
  export type RunShape = "pipeline" | "orchestrator" | "quick";
  export type DagDraftRequest = {
      channelId: string;
      goal: string;
      route: RoutePin;
  };

  export type RunCreationDecision =
      | { kind: "create-run"; channelId: string; goal: string; mode: "pipeline" | "quick"; route: RoutePin }
      | { kind: "dag-draft"; request: DagDraftRequest }
      | { kind: "blocked"; focusRoute: boolean; reason: string };

  export function resolveRunCreationDecision(input: {
      channelId: string;
      goal: string;
      shape: RunShape;
      route: EffectiveRoute | null;
  }): RunCreationDecision;
  ```

  Task 7 introduces `dagModalStateAtom` as `DagDecomposingState | null`, where `DagDecomposingState = {kind:"decomposing"; request:DagDraftRequest; error:string}`; `openDagDraft(request)` installs that seed. Task 9 expands the atom to the full union after Task 8 defines `DagDraft`. Pipeline/quick decisions call CreateRun directly; orchestrator decisions only call `openDagDraft` and create no Run.

- [ ] **Step 1: Write decision tests.** Assert pipeline returns `create-run` with explicit pipeline mode and selected pin; quick and `@quick` return direct quick; orchestrator returns exactly the `DagDraftRequest`; invalid/unavailable route blocks. Keep all existing `@ask` one-off/default tests green and assert the Radar branch is not passed through shape resolution.

- [ ] **Step 2: Observe the failure.** Run:

  ```bash
  npx vitest run frontend/app/view/agents/composercommand.test.ts
  ```

- [ ] **Step 3: Implement the pure decision without side effects.** Keep consult parsing/dispatch unchanged. Replace run dispatch's runtime-only output with a route+shape decision. Do not call RPCs from `composercommand.ts`.

- [ ] **Step 4: Add controlled shape and route chips.** `LaunchComposer` receives `shape`, `onShapeChange`, `route`, and `onRouteChange`. For run mode render a Tailwind shape chip plus `RoutePicker`; `@quick` forces/disables quick. For `@ask`, retain the existing HarnessPicker and one-off wording. The behavior line names direct pipeline/quick versus “review DAG before launch” for orchestrator.

- [ ] **Step 5: Own run-pin state in StageComposer.** Initialize shape from the loaded profile default (`orchestrator`, otherwise pipeline) and route from Settings → `override.route`; reset both when channel identity changes. Keep per-channel `shapeTouched`/`routeTouched` refs: a late profile/capability load may seed an untouched control once, but must not overwrite a user selection. A user picker change is the Run rung for this proposed run and does not rewrite Settings/Channel.

- [ ] **Step 6: Map the decision thinly.** `create-run` calls `createRun` and selects the returned Run. `dag-draft` calls `openDagDraft(request)`, clears the composer only after the request is accepted into modal state, and never calls CreateRun. Keep `@ask` transport unchanged. Keep Radar's existing dedicated direct-create branch and `radarOrigin` behavior unchanged; it uses the resolved route but bypasses the shape decision. Preserve channel-picker behavior for non-channel `@run/@quick`.

- [ ] **Step 7: Verify.** Run:

  ```bash
  npx vitest run frontend/app/view/agents/composercommand.test.ts
  node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
  npx eslint frontend/app/view/orchestrate/dagmodalstate.ts frontend/app/view/agents/composercommand.ts frontend/app/view/agents/channelcomposers.tsx frontend/app/view/jarvis/stagecomposer.tsx
  ```

- [ ] **Step 8: Commit.**

  ```bash
  git add frontend/app/view/orchestrate/dagmodalstate.ts frontend/app/view/agents/composercommand.ts frontend/app/view/agents/composercommand.test.ts frontend/app/view/agents/channelcomposers.tsx frontend/app/view/jarvis/stagecomposer.tsx
  git commit -m "feat(composer): dispatch orchestrator goals to DAG drafts"
  ```

---

### Task 8: Add the pure immutable DAG draft model

**Files:**
- Create: `frontend/app/view/orchestrate/draftmodel.ts`
- Test: `frontend/app/view/orchestrate/draftmodel.test.ts`

**Interfaces:**
- Consumes: generated `RoutePin`, backend capability data through `capabilityFor`, and `computeLayeredLayout`'s `{id,deps}` input shape.
- Produces:

  ```ts
  export type DraftTask = {
      id: string;
      label: string;
      deps: string[];
      gate: boolean;
      route: RoutePin | null;
  };
  export type DagDraft = {
      title: string;
      parallelism: number;
      tasks: DraftTask[];
  };

  export function draftFromSubtasks(goal: string, subtasks: string[]): DagDraft;
  export function addDraftTask(draft: DagDraft, label?: string): DagDraft;
  export function renameDraftTask(draft: DagDraft, id: string, label: string): DagDraft;
  export function deleteDraftTask(draft: DagDraft, id: string): DagDraft;
  export function setDraftDependency(draft: DagDraft, id: string, dep: string, enabled: boolean): DagDraft;
  export function setDraftGate(draft: DagDraft, id: string, gate: boolean): DagDraft;
  export function setDraftRoute(draft: DagDraft, id: string, route: RoutePin | null): DagDraft;
  export function setDraftParallelism(draft: DagDraft, parallelism: number): DagDraft;
  export function validateDraft(draft: DagDraft, harnesses: HarnessInfo[]): string[];
  export function toDagSubmitPayload(draft: DagDraft): {
      title: string;
      parallelism: number;
      tasks: TaskNode[];
  };
  ```

  Payload tasks use `state:"pending"`; pinned `runspec` contains both runtime+tier; inherited tasks omit both. Draft functions never mutate input.

- [ ] **Step 1: Write reducer/payload tests.** Cover deterministic IDs, rename/add/delete, deletion cleaning all dependency references, duplicate/self dependency rejection, cycle rejection without mutation, gate toggle, bounded positive parallelism, route pin set/clear, empty/blank invalid drafts, backend-capability invalid pin, and exact payload including both route fields. Freeze fixtures or compare originals after every operation to prove immutability.

- [ ] **Step 2: Observe failure.** Run:

  ```bash
  npx vitest run frontend/app/view/orchestrate/draftmodel.test.ts
  ```

- [ ] **Step 3: Implement the minimum pure model.** Use reachability from the proposed dependency back to the task for cycle checks. Return the original object for rejected dependency mutations. Use `t-1`, `t-2`, … based on the first unused positive integer; do not use randomness in the model.

- [ ] **Step 4: Verify.** Run:

  ```bash
  npx vitest run frontend/app/view/orchestrate/draftmodel.test.ts frontend/app/view/orchestrate/daglayout.test.ts
  node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
  npx eslint frontend/app/view/orchestrate/draftmodel.ts
  ```

- [ ] **Step 5: Commit.**

  ```bash
  git add frontend/app/view/orchestrate/draftmodel.ts frontend/app/view/orchestrate/draftmodel.test.ts
  git commit -m "feat(dag): add immutable client-side draft model"
  ```

---

### Task 9: Relocate the live DAG into an accessible Stage-local modal

**Files:**
- Create: `frontend/app/view/orchestrate/dagmodal.tsx`
- Modify: `frontend/app/view/orchestrate/dagmodalstate.ts`
- Test: `frontend/app/view/orchestrate/dagmodalstate.test.ts`
- Modify: `frontend/app/view/orchestrate/dagstore.ts`
- Modify: `frontend/app/view/orchestrate/daggraph.tsx`
- Modify: `frontend/app/view/agents/runbody.tsx`
- Modify: `frontend/app/view/agents/runtimelineview.tsx`
- Modify: `frontend/app/view/agents/cockpitsurface.tsx`
- Modify: `frontend/app/view/jarvis/stage.tsx`
- Modify: `frontend/app/modals/modalfocus.ts`
- Test: `frontend/app/modals/modalfocus.test.ts`

**Interfaces:**
- Consumes: GraphPeek's Stage-local `absolute inset-0` layering, `modalBackdrop`/`modalPanel`, `takeModalFocus`, `DagGraphView`, Run/DAG identities, and existing selected-task atom.
- Produces:

  ```ts
  export type DagModalState =
      | { kind: "decomposing"; request: DagDraftRequest; error: string }
      | { kind: "draft"; request: DagDraftRequest; draft: DagDraft; error: string }
      | { kind: "launching"; request: DagDraftRequest; draft: DagDraft; error: string }
      | { kind: "live"; channelId: string; runId: string; dagOref: string; error: string };

  export type DagModalAction =
      | { type: "open-draft"; request: DagDraftRequest }
      | { type: "open-live"; channelId: string; runId: string; dagOref: string }
      | { type: "close" };
  export function reduceDagModalState(
      state: DagModalState | null,
      action: DagModalAction,
  ): DagModalState | null;
  export function openDagLive(channelId: string, runId: string, dagOref: string): void;
  export function canDismissDagModal(state: DagModalState): boolean;
  export function closeDagModal(): void;
  export function focusTrapTarget(
      focusables: HTMLElement[],
      active: Element | null,
      reverse: boolean,
  ): HTMLElement | null;
  ```

  Stage mounts one absolute modal overlay; RunBody/timeline open live state. Cockpit has no DAG branch. DagGraph retains j/k navigation but owns no Escape listener. The shell exposes `data-dag-modal-kind`, and a dev-only `window.__waveDagModalFixture.setState(state)` seam writes the same atom for deterministic CDP state capture; the branch is guarded by `import.meta.env.DEV`.

- [ ] **Step 1: Add state/focus tests first.** Test open-live identity, close allowed for decomposing/draft/live, close refused for launching, selected-task reset on open/close, forward/reverse focus wrap, initial focus, and focus restoration. The pure tests cover focus target math and dismissal guard; CDP in Task 12 covers actual role/aria attributes.

- [ ] **Step 2: Observe failures.** Run:

  ```bash
  npx vitest run frontend/app/view/orchestrate/dagmodalstate.test.ts frontend/app/modals/modalfocus.test.ts frontend/app/view/orchestrate/dagstore.test.ts
  ```

- [ ] **Step 3: Implement explicit modal actions.** Expand Task 7's decomposing seed into the full union and implement `reduceDagModalState`; atom actions delegate to that pure reducer. Replace `dagViewOrefAtom` as the open-state authority with `dagModalStateAtom`. Keep `selectedTaskIdAtom` in `dagstore`. `openDagLive` and `closeDagModal` reset selection; `closeDagModal` is a no-op while launching. Add the guarded dev-only fixture setter from the Interfaces block; production builds must tree-shake it.

- [ ] **Step 4: Build one semantic shell.** `DagModal` reads state and returns null when closed. Render an absolute Stage-local backdrop and motion panel with `role="dialog"`, `aria-modal="true"`, a stable heading id, panel `tabIndex={-1}`, and token-only Tailwind. Backdrop closes only when `event.target === event.currentTarget`. One window keydown handler owns Escape and Tab trapping; collect focusables with `button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])` and pass them to `focusTrapTarget`. Use `takeModalFocus` for initial/restore. Disable/hide close affordances while launching.

- [ ] **Step 5: Relocate live opening.** RunBody and timeline call `openDagLive(channel.oid, run.id, "dag:" + run.dagoref)`. Stage mounts `<DagModal />` as its final child so Stage content stays mounted behind it. Remove `DagGraphView`, DAG atom imports, and takeover return from Cockpit.

- [ ] **Step 6: Remove duplicate Escape.** Delete only DagGraph's Escape branch/import; retain j/k selection. The modal is the sole dismissal owner.

- [ ] **Step 7: Verify.** Run:

  ```bash
  npx vitest run frontend/app/view/orchestrate/dagmodalstate.test.ts frontend/app/modals/modalfocus.test.ts frontend/app/view/orchestrate/dagstore.test.ts
  node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
  npx eslint frontend/app/view/orchestrate/dagmodal.tsx frontend/app/view/orchestrate/dagmodalstate.ts frontend/app/view/orchestrate/dagstore.ts frontend/app/view/orchestrate/daggraph.tsx frontend/app/view/agents/runbody.tsx frontend/app/view/agents/runtimelineview.tsx frontend/app/view/agents/cockpitsurface.tsx frontend/app/view/jarvis/stage.tsx frontend/app/modals/modalfocus.ts
  ```

- [ ] **Step 8: Commit.**

  ```bash
  git add frontend/app/view/orchestrate/dagmodal.tsx frontend/app/view/orchestrate/dagmodalstate.ts frontend/app/view/orchestrate/dagmodalstate.test.ts frontend/app/view/orchestrate/dagstore.ts frontend/app/view/orchestrate/daggraph.tsx frontend/app/view/agents/runbody.tsx frontend/app/view/agents/runtimelineview.tsx frontend/app/view/agents/cockpitsurface.tsx frontend/app/view/jarvis/stage.tsx frontend/app/modals/modalfocus.ts frontend/app/modals/modalfocus.test.ts
  git commit -m "feat(dag): move live DAG into the Jarvis Stage modal"
  ```

---

### Task 10: Integrate decompose, draft editing, and the transactional launch flow

**Files:**
- Create: `frontend/app/view/orchestrate/daglaunch.ts`
- Test: `frontend/app/view/orchestrate/daglaunch.test.ts`
- Create: `frontend/app/view/orchestrate/dagdraftview.tsx`
- Modify: `frontend/app/view/orchestrate/dagmodal.tsx`
- Modify: `frontend/app/view/orchestrate/dagmodalstate.ts`
- Test: `frontend/app/view/orchestrate/dagmodalstate.test.ts`
- Modify: `frontend/app/view/agents/runactions.ts`

**Interfaces:**
- Consumes: `JarvisDecomposeCommand`, `draftFromSubtasks`, `toDagSubmitPayload`, explicit request route, `CreateRunCommand`, `DagSubmitCommand`, `CancelRunCommand`, and `setActiveRunId`.
- Produces:

  ```ts
  export type DagSubmitPayload = ReturnType<typeof toDagSubmitPayload>;
  export type DagLaunchDeps = {
      createDeferredRun(request: DagDraftRequest): Promise<Run>;
      submitDag(channelId: string, runId: string, payload: DagSubmitPayload): Promise<TaskGroup>;
      cancelRun(channelId: string, runId: string): Promise<void>;
  };

  export type DagLaunchResult =
      | { ok: true; channelId: string; runId: string; dagOref: string }
      | { ok: false; error: string };

  export async function launchDagDraft(
      request: DagDraftRequest,
      draft: DagDraft,
      deps: DagLaunchDeps,
  ): Promise<DagLaunchResult>;
  ```

  Extend `DagModalAction` with `{type:"decompose-succeeded"; draft}`, `{type:"decompose-failed"; error}`, `{type:"retry-decompose"}`, `{type:"begin-launch"}`, `{type:"launch-failed"; error}`, and `{type:"launch-succeeded"; channelId; runId; dagOref}`; the pure reducer implements every approved transition. Production call order is deferred orchestrator CreateRun with runtime+tier → DagSubmit → live state. Create failure keeps draft; submit failure best-effort cancels and keeps draft; cleanup failure includes run ID plus both errors. Decompose transport errors remain decomposing with Retry; server `[goal]` fallback is treated as success.

- [ ] **Step 1: Write launch orchestration tests first.** With spies assert exact call order and payload; Create failure calls neither submit nor cancel; submit failure calls cancel once; cleanup failure includes the created run ID and cleanup error; success returns `dag:<oid>`. Assert the input draft is unchanged in every branch.

- [ ] **Step 2: Expand modal reducer tests.** Cover decomposing success/failure/retry, draft → launching, launch failure returning to the same draft with error, success → live, close-before-launch clearing state, and launching dismissal refusal.

- [ ] **Step 3: Observe failures.** Run:

  ```bash
  npx vitest run frontend/app/view/orchestrate/daglaunch.test.ts frontend/app/view/orchestrate/dagmodalstate.test.ts frontend/app/view/orchestrate/draftmodel.test.ts
  ```

- [ ] **Step 4: Implement injected launch orchestration.** `launchDagDraft` contains no jotai/React imports. It calls `toDagSubmitPayload` once and passes that exact payload to `deps.submitDag`. On submit error, await best-effort cancel. Return contextual strings; never swallow cleanup failure. Do not cancel on Create failure because no run exists.

- [ ] **Step 5: Add production deferred CreateRun support.** Extend `createRun` options with `deferStart`; production launch deps pass `{mode:"orchestrator", deferStart:true}` and the request's explicit route. Submit exact draft payload. Do not expose deferstart on direct pipeline/quick callers.

- [ ] **Step 6: Render decomposing/draft/launching states.** On the first decomposing entry call `JarvisDecomposeCommand({channelid, goal})` once; guard the effect with an in-flight ref and ignore stale completion after close/request replacement. The Retry button invokes the same function explicitly after clearing the failed marker, so React StrictMode cannot duplicate a request and retry cannot be suppressed. Transport failure dispatches visible error with Retry. `DagDraftView` renders title, parallelism, task rename/add/delete, dependency toggles, gate toggles, task RoutePicker with inherit, backend-capability validation, pinned count, and `computeLayeredLayout` preview. Launch is disabled for validation errors or zero tasks.

- [ ] **Step 7: Wire launch state without races.** Launch first sets `launching`, then calls `launchDagDraft`. While launching disable close, Escape, backdrop, and mutable controls. On failure dispatch back to draft preserving the exact object and error. On success select the returned run and switch to live with returned DAG oref. Composer/decompose paths contain no CreateRun call; only the Launch button invokes this function.

- [ ] **Step 8: Verify.** Run:

  ```bash
  npx vitest run frontend/app/view/orchestrate/daglaunch.test.ts frontend/app/view/orchestrate/dagmodalstate.test.ts frontend/app/view/orchestrate/draftmodel.test.ts frontend/app/view/agents/composercommand.test.ts
  node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
  npx eslint frontend/app/view/orchestrate/daglaunch.ts frontend/app/view/orchestrate/dagdraftview.tsx frontend/app/view/orchestrate/dagmodal.tsx frontend/app/view/orchestrate/dagmodalstate.ts frontend/app/view/agents/runactions.ts
  ```

- [ ] **Step 9: Commit.**

  ```bash
  git add frontend/app/view/orchestrate/daglaunch.ts frontend/app/view/orchestrate/daglaunch.test.ts frontend/app/view/orchestrate/dagdraftview.tsx frontend/app/view/orchestrate/dagmodal.tsx frontend/app/view/orchestrate/dagmodalstate.ts frontend/app/view/orchestrate/dagmodalstate.test.ts frontend/app/view/agents/runactions.ts
  git commit -m "feat(dag): launch reviewed drafts with cleanup on failure"
  ```

---

### Task 11: Present effective live routes and tokenize touched ReactFlow colors

**Files:**
- Modify: `frontend/app/view/orchestrate/dagstore.ts`
- Test: `frontend/app/view/orchestrate/dagstore.test.ts`
- Modify: `frontend/app/view/orchestrate/daggraph.tsx`
- Modify: `frontend/app/view/orchestrate/dagmodal.tsx`

**Interfaces:**
- Consumes: owning `Run.Runtime + Tier`, task `RunSpec.Runtime + Tier`, legacy normalization, and backend capabilities in `harnessesAtom`.
- Produces:

  ```ts
  export type DagNodeRoute = {
      source: "pinned" | "inherited";
      runtime: string;
      tier: string;
      resolvedModel: string;
  };

  export function buildViewData(
      group: TaskGroup,
      owner: Run,
      harnesses: HarnessInfo[],
  ): { nodes: DagViewNode[]; edges: DagViewEdge[] };
  ```

  Every live node shows pinned runtime+tier+resolved model, or `inherits run route` plus the owning Run's normalized runtime+tier+model. Modal header shows the immutable run route. No live RoutePicker or pin mutation exists.

- [ ] **Step 1: Extend pure view tests.** Assert explicit task pin wins; no pin inherits owner; runtime-only legacy task becomes capable; owner empty tier becomes capable; matching backend `resolvedmodel` is displayed; missing/stale capability renders an honest unavailable label rather than a model guess.

- [ ] **Step 2: Observe failure.** Run:

  ```bash
  npx vitest run frontend/app/view/orchestrate/dagstore.test.ts frontend/app/view/agents/route.test.ts
  ```

- [ ] **Step 3: Pass the owning Run into the graph.** The live modal state already carries run ID; load its WOS Run in a live-only child component and pass it with harness capabilities into `DagGraphView`/`buildViewData`. Keep `DagGraphView` oref-driven for group updates.

- [ ] **Step 4: Render read-only route lines.** Node and detail rail show source text plus runtime, tier, resolved model. Header shows the owning Run route and never renders a picker in live state.

- [ ] **Step 5: Tokenize only touched ReactFlow colors.** Replace the raw edge marker/stroke values and Background rgba in `daggraph.tsx` with existing token-backed CSS variable strings such as `var(--color-edge-strong)`, `var(--color-warning)`, and `color-mix(...var(--color-ink-mid)...)`. Do not sweep unrelated raw styles elsewhere.

- [ ] **Step 6: Verify.** Run:

  ```bash
  npx vitest run frontend/app/view/orchestrate/dagstore.test.ts frontend/app/view/agents/route.test.ts
  node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
  npx eslint frontend/app/view/orchestrate/dagstore.ts frontend/app/view/orchestrate/daggraph.tsx frontend/app/view/orchestrate/dagmodal.tsx
  ```

- [ ] **Step 7: Commit.**

  ```bash
  git add frontend/app/view/orchestrate/dagstore.ts frontend/app/view/orchestrate/dagstore.test.ts frontend/app/view/orchestrate/daggraph.tsx frontend/app/view/orchestrate/dagmodal.tsx
  git commit -m "feat(dag): show effective routes in the live graph"
  ```

---

### Task 12: Add CDP coverage, regenerate, run full verification, and close the docs

**Files:**
- Modify: `scripts/cdp/scenarios.mjs`
- Modify: `docs/superpowers/specs/2026-08-20-route-chain-and-dag-modal-design.md`
- Modify: `docs/superpowers/plans/2026-08-20-route-chain-and-dag-modal.md`
- Regenerate if changed by source: `schema/settings.json`
- Regenerate if changed by source: `frontend/types/gotypes.d.ts`
- Regenerate if changed by source: `frontend/app/store/wshclientapi.ts`
- Regenerate if changed by source: `pkg/wshrpc/wshclient/wshclient.go`

**Interfaces:**
- Consumes: all prior tasks, existing `dag-lifecycle` scenario, dev-only fixture/global seams already used by the CDP harness, and approved mockup screens 04–11.
- Produces: repeatable CDP assertions for draft, launching, transport-error, live, keyboard focus/dismissal, resolved route labels, Stage-local layering, and Cockpit fleet-only behavior; final generated artifacts; implemented spec status.

- [ ] **Step 1: Update `dag-lifecycle` instead of adding a parallel scenario.** Use Task 9's dev-only `window.__waveDagModalFixture.setState` seam for deterministic draft, launching, and transport-error frames; use production composer/RPC paths for the no-Run-before-Launch and live-DAG assertions. Arrange a temporary channel, valid explicit routes, deferred orchestrator run, and DAG. Replace old Cockpit takeover assertions with:
  - orchestrator composer submit opens `role=dialog` in decomposing/draft and no Run count changes before Launch;
  - draft screenshot matches approved task editor/preview shape and route labels;
  - launching disables close/Escape/backdrop;
  - transport error remains open with Retry and preserves request/draft;
  - live modal renders three nodes and pinned/inherited route lines over the still-mounted Stage;
  - focus begins inside, Tab and Shift+Tab stay inside, Escape closes when allowed, and focus restores;
  - opening live from RunBody does not switch surfaces;
  - Cockpit contains fleet content and no ReactFlow takeover.

- [ ] **Step 2: Make each assertion capable of failing independently.** Use stable `data-*` hooks for modal kind, route option, launch button, and DAG node route. Keep temp channel/run/worker cleanup from the existing scenario. Capture draft, error, launching, live, and Cockpit screenshots into `cdp-shots/` and compare them by eye with screens 04–11.

- [ ] **Step 3: Run generation and inspect drift.** Run:

  ```bash
  task generate
  git diff -- schema/settings.json frontend/types/gotypes.d.ts frontend/app/store/wshclientapi.ts pkg/wshrpc/wshclient/wshclient.go
  ```

  Generated output must reflect only the planned Go types/commands.

- [ ] **Step 4: Run complete automated verification.** Run:

  ```bash
  go test ./pkg/runroute ./pkg/jarvis ./pkg/orchestrate
  CGO_CFLAGS="-IC:/Users/kael02/IdeaProjects/waveterm/.worktrees/route-chain-dag-modal/pkg/jarvisembed/csrc" go test ./pkg/wshrpc/wshserver
  node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
  npx vitest run
  npx eslint .
  ```

  Do not report a skipped/failing command as passing. If full eslint exposes unrelated baseline failures, record exact paths and still run eslint over every touched frontend/script file.

- [ ] **Step 5: Run UI verification against a rebuilt dev app.** In one terminal run `task build:backend`, then start the worktree app with its isolated profile/port:

  ```bash
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223" WEBVIEW2_USER_DATA_FOLDER="$TEMP/wave-route-chain-profile" task dev
  ```

  In another terminal:

  ```bash
  CDP_PORT=9223 task verify:ui -- dag-lifecycle harness-picker runs-lifecycle surface-smoke
  ```

  Expected: every row passes; inspect `cdp-shots/index.html` for Stage layering, all modal states, theme safety, focus indication, and no Cockpit takeover.

- [ ] **Step 6: Close documentation consistently.** Change the repaired spec status from approved-for-implementation to implemented and record verification/deviations only when grounded in command output. Keep this plan's checkboxes/results current. Do not edit `docs/lead-authored-task-routing-roadmap.md`: the repaired spec already states that this feature absorbs Phase 1. Do not edit the untracked orchestrator UI spec: the repaired spec already explicitly supersedes its Cockpit takeover, so another mutation would overwrite user work without adding authority.

- [ ] **Step 7: Self-review scope and diff.** Run:

  ```bash
  git status --short
  git diff --stat f61d0371..HEAD
  git diff --check
  git diff -- docs/lead-authored-task-routing-roadmap.md docs/superpowers/specs/2026-08-20-orchestrator-jarvis-ui-design.md
  git diff --cached --name-only
  ```

  Confirm no debug statements, placeholder comments, frontend capability matrix, raw touched graph colors, SCSS, dependency changes, staged user work, or live route-edit control.

- [ ] **Step 8: Commit final verification and docs with feature code.**

  ```bash
  git add scripts/cdp/scenarios.mjs docs/superpowers/specs/2026-08-20-route-chain-and-dag-modal-design.md docs/superpowers/plans/2026-08-20-route-chain-and-dag-modal.md schema/settings.json frontend/types/gotypes.d.ts frontend/app/store/wshclientapi.ts pkg/wshrpc/wshclient/wshclient.go
  git commit -m "test(dag): verify draft-first route-aware modal flow"
  ```

  Omit unchanged generated files from the commit. Do not push.
