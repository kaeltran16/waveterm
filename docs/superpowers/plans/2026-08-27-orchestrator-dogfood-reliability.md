# Orchestrator Dogfood Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the persistent-lead Jarvis orchestrator trustworthy for personal dogfooding by fixing lead launch ordering, merge-gated dependency visibility, cleanup durability, test isolation, and real end-to-end proof.

**Architecture:** Keep the existing split: the Pi lead makes planning decisions and publishes typed tasks; the persisted DAG engine owns deterministic scheduling and state. Git-backed successors wait for merged predecessors and start from the project HEAD visible at spawn time. Merge integration is persisted before idempotent worktree cleanup, whose debt survives restart and is retried at server startup.

**Tech Stack:** Go, SQLite JSON rows, wshrpc/waveobj code generation, React 19, TypeScript, jotai, Vitest, ReactFlow, Node CDP driver, Git worktrees, Pi task bridge.

## Global Constraints

- Follow `docs/superpowers/specs/2026-08-27-orchestrator-dogfood-reliability-design.md` as the source of truth.
- Do not restore `JarvisPlanDag`, draft DAG state, fallback drafts, or mandatory plan approval.
- Do not add automatic merging; a Pi lead or human invokes the existing merge action.
- For Git-backed DAGs, done-but-unmerged dependencies remain pending; non-Git DAGs retain done/skipped dependency semantics.
- Pi task imports inherit the exact run route; do not claim they author gates or exceptional routes.
- Do not add new dependencies or SCSS.
- Do not hand-edit generated files. Run `task generate` after changing `waveobj.TaskGroup` or `waveobj.TaskNode`.
- The live E2E scenario must use a temporary registered Git project, never the waveterm checkout.
- Before executing the live E2E run, obtain explicit user approval for engine-managed commits inside that temporary repository. Wave must not push.
- Do not delete pre-existing `.waveterm/worktrees` or `wave/*` branches without separately verifying recoverability and obtaining approval.
- Do not commit or push implementation work without explicit approval. Use diff checkpoints after each task; the spec and plan fold into the eventual feature commit.
- Typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json`.
- Run Go tests with `CGO_CFLAGS='-IC:/Users/kael02/IdeaProjects/waveterm/pkg/jarvisembed/csrc'`.

---

## File map

### Test isolation

- Modify `vitest.config.ts` — exclude runtime-managed Wave worktrees.
- Create `vitest.config.test.ts` — pin the exclusion in the active checkout.

### Atomic worker launch

- Modify `pkg/jarvis/runexec.go` — add `RunWorkerOptions`, persist final metadata before controller start, and remove the post-start keep-on-exit patch.
- Modify `pkg/jarvis/runexec_test.go` — prove option propagation and metadata-before-controller ordering.
- Modify `pkg/orchestrate/engine.go` and `pkg/orchestrate/engine_test.go` — pass zero-value options for DAG children.
- Modify worker-spawn stubs in:
  - `pkg/wshrpc/wshserver/wshserver_childrun_test.go`
  - `pkg/wshrpc/wshserver/wshserver_dagask_test.go`
  - `pkg/wshrpc/wshserver/wshserver_dag_test.go`
  - `pkg/wshrpc/wshserver/wshserver_run_test.go`
  - `pkg/wshrpc/wshserver/wshserver_spawn_test.go`

### DAG lifecycle model and storage

- Modify `pkg/waveobj/wtype.go` — persist `TaskGroup.MergeRequired`, `TaskNode.CleanupPending`, and `TaskNode.CleanupError`.
- Modify `pkg/orchestrate/dag.go` and `pkg/orchestrate/dag_test.go` — derive merge-aware terminal state and reject caller-supplied engine fields.
- Modify `pkg/wstore/wstore_dag.go` and `pkg/wstore/wstore_dag_test.go` — query DAGs with pending cleanup.
- Regenerate `frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts`, and `pkg/wshrpc/wshclient/wshclient.go` with `task generate`.

### Merge-gated dependencies and spawn bases

- Modify `pkg/orchestrate/scheduler.go` and `pkg/orchestrate/scheduler_test.go` — require merged predecessors for Git-backed DAGs.
- Modify `pkg/orchestrate/worktree.go` and `pkg/orchestrate/worktree_test.go` — expose the current project HEAD.
- Modify `pkg/orchestrate/engine.go` and `pkg/orchestrate/engine_test.go` — create ready sibling worktrees from one spawn-time HEAD and persist it on child runs.
- Modify `pkg/jarvis/run.go` and `pkg/jarvis/run_dagprompt_test.go` — tell the Pi lead to merge predecessors before dependents can start.
- Modify `pkg/wshrpc/wshserver/wshserver_dag.go` and tests — derive `MergeRequired` from the owner project when the DAG is submitted.

### Durable cleanup

- Create `pkg/orchestrate/cleanup.go` and `pkg/orchestrate/cleanup_test.go` — persist, execute, and retry task worktree cleanup.
- Modify `pkg/orchestrate/merge.go` and `pkg/orchestrate/merge_test.go` — make content integration independent of cleanup.
- Modify `pkg/orchestrate/worktree.go` and tests — remove unregistered physical directories or return a cleanup error.
- Modify `pkg/orchestrate/mutation.go` and `pkg/orchestrate/mutation_test.go` — persist cancellation cleanup debt without undoing cancellation.
- Modify `pkg/wshrpc/wshserver/wshserver_dag.go` and `pkg/wshrpc/wshserver/wshserver_dag_test.go` — atomically record merge identity, persist evidence, and run cleanup as a separate phase.
- Modify `cmd/server/main-server.go` — retry persisted cleanup debt once at startup.

### DAG UI and CLI visibility

- Modify `frontend/app/view/orchestrate/dagstore.ts` and `dagstore.test.ts` — project released gates and cleanup debt into view actions.
- Modify `frontend/app/view/orchestrate/daggraph.tsx` — render cleanup state and route `cleanup` to the idempotent merge RPC.
- Modify `cmd/wsh/cmd/wshcmd-jarvisdag.go` and its existing tests — expose approve/sendback, merge, and cleanup as mutually correct next actions.

### End-to-end evidence

- Rewrite `scripts/cdp/orchestrator-e2e.mjs` — use a temporary project and assert the current persistent-lead lifecycle.
- Regenerate `docs/orchestrator-e2e.md` and `cdp-shots/orchestrator-e2e/README.md` from one result model.
- Update `docs/orchestrator-e2e-review.md` after a passing run — mark old findings resolved or still open using observed evidence only.
- Modify `docs/jarvis-tour.md` and `docs/README.md` — link the canonical orchestrator E2E evidence.

---

### Task 1: Exclude runtime worktrees from Vitest

**Files:**
- Create: `vitest.config.test.ts`
- Modify: `vitest.config.ts:20-28`

**Interfaces:**
- Consumes: Vitest's `configDefaults.exclude`.
- Produces: exported `TEST_EXCLUDES: string[]` used by `defineConfig` and its test.

- [ ] **Step 1: Add a failing configuration test**

Create `vitest.config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { TEST_EXCLUDES } from "./vitest.config";

describe("Vitest worktree isolation", () => {
    it("excludes Wave runtime worktrees", () => {
        expect(TEST_EXCLUDES).toContain("**/.waveterm/worktrees/**");
    });
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run:

```bash
npx vitest run vitest.config.test.ts
```

Expected: FAIL because `TEST_EXCLUDES` is not exported.

- [ ] **Step 3: Make the exclusion the single source of truth**

In `vitest.config.ts`, add above `defineConfig`:

```ts
export const TEST_EXCLUDES = [
    ...configDefaults.exclude,
    "**/.claude/**",
    "**/.worktrees/**",
    "**/.waveterm/worktrees/**",
];
```

Replace the inline exclusion with:

```ts
test: {
    exclude: TEST_EXCLUDES,
```

Update the comment to name all three worktree roots.

- [ ] **Step 4: Run the test and list selected files**

Run:

```bash
npx vitest run vitest.config.test.ts
npx vitest list > .tmp-vitest-list.txt
if rg -q '\.waveterm[/\\]worktrees' .tmp-vitest-list.txt; then rm .tmp-vitest-list.txt; exit 1; fi
rm .tmp-vitest-list.txt
```

Expected: the test passes and no selected path is below `.waveterm/worktrees`.

- [ ] **Step 5: Run the active-checkout orchestrator frontend tests**

Run:

```bash
npx vitest run vitest.config.test.ts frontend/app/view/agents/composercommand.test.ts frontend/app/view/orchestrate/dagstore.test.ts frontend/app/view/orchestrate/daglayout.test.ts frontend/app/view/orchestrate/dagmodalstate.test.ts frontend/app/view/orchestrate/escalate.test.ts
```

Expected: all listed active-checkout tests pass; output contains no `.waveterm/worktrees` path.

- [ ] **Step 6: Diff checkpoint**

Run:

```bash
git diff --check
git diff -- vitest.config.ts vitest.config.test.ts
```

Do not commit.

---

### Task 2: Persist orchestrator keep-on-exit before controller start

**Files:**
- Modify: `pkg/jarvis/runexec.go`
- Modify: `pkg/jarvis/runexec_test.go`
- Modify: `pkg/orchestrate/engine.go`
- Modify: `pkg/orchestrate/engine_test.go`
- Modify spawn stubs in the six `pkg/wshrpc/wshserver/*_test.go` files listed in the file map.

**Interfaces:**
- Produces:

```go
type RunWorkerOptions struct {
    KeepOnExit bool
}

var SpawnRunWorker func(
    context.Context,
    runroute.Capability,
    string, // workspaceId
    string, // projectName
    string, // cwd
    string, // prompt
    RunWorkerOptions,
) (string, error)
```

- Consumes: `Run.Mode`; DAG children pass `RunWorkerOptions{}`.

- [ ] **Step 1: Replace the post-start stamp test with option-propagation tests**

In `pkg/jarvis/runexec_test.go`, replace `TestEnsureWorkers_OrchestratorStampsKeepOnExit` with tests that capture the final argument:

```go
func TestEnsureWorkersPassesKeepOnExitOnlyForOrchestrator(t *testing.T) {
    old := SpawnRunWorker
    defer func() { SpawnRunWorker = old }()

    var got []RunWorkerOptions
    SpawnRunWorker = func(_ context.Context, _ runroute.Capability, _, _, _, _ string, opts RunWorkerOptions) (string, error) {
        got = append(got, opts)
        return "tab:worker", nil
    }
    cap, _ := runroute.Resolve(waveobj.RoutePin{Runtime: "pi", Tier: string(consult.TierMid)})

    orch := NewRun("orchestrate", "ws", "/p", nil, RunMode_Orchestrator, DefaultOrchestratorPlaybook(false), 1)
    if _, err := EnsureWorkers(context.Background(), &orch, cap, "project"); err != nil {
        t.Fatal(err)
    }
    pipe := NewRun("pipeline", "ws", "/p", nil, RunMode_Pipeline, DefaultPlaybook(), 1)
    if _, err := EnsureWorkers(context.Background(), &pipe, cap, "project"); err != nil {
        t.Fatal(err)
    }

    if len(got) != 2 || !got[0].KeepOnExit || got[1].KeepOnExit {
        t.Fatalf("worker options = %+v", got)
    }
}
```

Add a helper-ordering test using package seams:

```go
func TestConfigureWorkerPersistsMetaBeforeStart(t *testing.T) {
    oldPersist, oldStart := persistWorkerBlockMeta, startWorkerController
    defer func() { persistWorkerBlockMeta, startWorkerController = oldPersist, oldStart }()

    var calls []string
    persistWorkerBlockMeta = func(context.Context, string, waveobj.MetaMapType) error {
        calls = append(calls, "persist")
        return nil
    }
    startWorkerController = func(context.Context, string, string) error {
        calls = append(calls, "start")
        return nil
    }
    if err := configureAndStartWorker(context.Background(), "tab-1", "block-1", waveobj.MetaMapType{}); err != nil {
        t.Fatal(err)
    }
    if !reflect.DeepEqual(calls, []string{"persist", "start"}) {
        t.Fatalf("calls = %v", calls)
    }
}

func TestConfigureWorkerDoesNotStartAfterMetaFailure(t *testing.T) {
    oldPersist, oldStart := persistWorkerBlockMeta, startWorkerController
    defer func() { persistWorkerBlockMeta, startWorkerController = oldPersist, oldStart }()

    persistWorkerBlockMeta = func(context.Context, string, waveobj.MetaMapType) error { return errors.New("write failed") }
    started := false
    startWorkerController = func(context.Context, string, string) error { started = true; return nil }

    err := configureAndStartWorker(context.Background(), "tab-1", "block-1", waveobj.MetaMapType{})
    if err == nil || started {
        t.Fatalf("err=%v started=%v", err, started)
    }
}
```

Add `errors` to the test imports.

- [ ] **Step 2: Run the Jarvis test and confirm RED**

Run:

```bash
CGO_CFLAGS='-IC:/Users/kael02/IdeaProjects/waveterm/pkg/jarvisembed/csrc' go test ./pkg/jarvis -run 'TestEnsureWorkersPassesKeepOnExitOnlyForOrchestrator|TestConfigureWorker' -count=1
```

Expected: compile failure because the options type and seams do not exist.

- [ ] **Step 3: Add the options and ordered configuration boundary**

In `pkg/jarvis/runexec.go`, define:

```go
type RunWorkerOptions struct {
    KeepOnExit bool
}

var persistWorkerBlockMeta = func(ctx context.Context, blockID string, meta waveobj.MetaMapType) error {
    return wstore.UpdateObjectMeta(ctx, waveobj.MakeORef(waveobj.OType_Block, blockID), meta, false)
}

var startWorkerController = func(ctx context.Context, tabID, blockID string) error {
    return blockcontroller.ResyncController(ctx, tabID, blockID, &waveobj.RuntimeOpts{}, true)
}

func configureAndStartWorker(ctx context.Context, tabID, blockID string, meta waveobj.MetaMapType) error {
    if err := persistWorkerBlockMeta(ctx, blockID, meta); err != nil {
        return fmt.Errorf("setting worker block meta: %w", err)
    }
    if err := startWorkerController(ctx, tabID, blockID); err != nil {
        return fmt.Errorf("starting worker controller: %w", err)
    }
    return nil
}
```

Add `opts RunWorkerOptions` to `SpawnRunWorker`. Build metadata with:

```go
blockMeta := makeWorkerBlockMeta(spec, cwd, opts.KeepOnExit)
if err := configureAndStartWorker(ctx, tabId, blockId, blockMeta); err != nil {
    return "", err
}
```

Keep tab metadata persistence before `configureAndStartWorker`. Delete the later direct `ResyncController` call.

- [ ] **Step 4: Pass options from the two engine paths**

In `EnsureWorkers`:

```go
opts := RunWorkerOptions{KeepOnExit: run.Mode == RunMode_Orchestrator}
oref, err := SpawnRunWorker(ctx, cap, run.WorkspaceId, projectName, run.ProjectPath, prompt, opts)
```

Delete the entire post-spawn block that reloads the tab and writes `MetaKey_CmdKeepOnExit` best-effort.

In `pkg/orchestrate/engine.go`, extend `spawnWorker` with the options argument and call DAG children with:

```go
oref, err := spawnWorker(spawnCtx, capability, owner.WorkspaceId, "", cwd, prompt, jarvis.RunWorkerOptions{})
```

- [ ] **Step 5: Update test stubs mechanically and verify no old signature remains**

Add a final `jarvis.RunWorkerOptions` argument to every external stub and `RunWorkerOptions` inside `pkg/jarvis`. Use `_` when the test does not inspect it.

Run:

```bash
rg -n 'SpawnRunWorker = func\([^\n]*string\) \(string, error\)' pkg --glob '*_test.go'
```

Expected: no old six-argument stub remains.

- [ ] **Step 6: Run focused and package tests**

Run:

```bash
CGO_CFLAGS='-IC:/Users/kael02/IdeaProjects/waveterm/pkg/jarvisembed/csrc' go test ./pkg/jarvis ./pkg/orchestrate ./pkg/wshrpc/wshserver -count=1
```

Expected: all three packages pass.

- [ ] **Step 7: Diff checkpoint**

Run:

```bash
git diff --check
git diff --stat -- pkg/jarvis/runexec.go pkg/jarvis/runexec_test.go pkg/orchestrate/engine.go pkg/wshrpc/wshserver
```

Confirm there is one worker-spawn signature and no ignored keep-on-exit write. Do not commit.

---

### Task 3: Add merge and cleanup lifecycle fields

**Files:**
- Modify: `pkg/waveobj/wtype.go:299-350`
- Modify: `pkg/orchestrate/dag.go`
- Modify: `pkg/orchestrate/dag_test.go`
- Modify: `pkg/wstore/wstore_dag.go`
- Modify: `pkg/wstore/wstore_dag_test.go`
- Regenerate: `frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts`, `pkg/wshrpc/wshclient/wshclient.go`

**Interfaces:**
- Produces:

```go
type TaskNode struct {
    // existing fields
    CleanupPending bool   `json:"cleanuppending,omitempty"`
    CleanupError   string `json:"cleanuperror,omitempty"`
}

type TaskGroup struct {
    // existing fields
    MergeRequired bool `json:"mergerequired,omitempty"`
}

func GetDagsWithPendingCleanup(context.Context) ([]*waveobj.TaskGroup, error)
```

- [ ] **Step 1: Add failing domain tests**

In `pkg/orchestrate/dag_test.go`, add:

```go
func TestNewTaskGroupRejectsLifecycleFields(t *testing.T) {
    tasks := []waveobj.TaskNode{{
        ID: "t-1", Label: "one", Merged: true,
        CleanupPending: true, CleanupError: "locked",
    }}
    if _, err := NewTaskGroup("run", "channel", "title", 1, true, tasks, 1); err == nil {
        t.Fatal("caller-supplied merge and cleanup fields must be rejected")
    }
}

func TestNewTaskGroupPersistsMergeRequirement(t *testing.T) {
    g, err := NewTaskGroup("run", "channel", "title", 1, true, []waveobj.TaskNode{{ID: "t-1", Label: "one"}}, 1)
    if err != nil {
        t.Fatal(err)
    }
    if !g.MergeRequired {
        t.Fatal("git-backed dag must require merged tasks")
    }
}
```

In `pkg/wstore/wstore_dag_test.go`, add:

```go
func TestGetDagsWithPendingCleanup(t *testing.T) {
    ctx := context.Background()
    pendingID, clearID := uuid.NewString(), uuid.NewString()
    pending := &waveobj.TaskGroup{
        OID: pendingID, ID: pendingID, RunID: uuid.NewString(), ChannelId: uuid.NewString(),
        Parallelism: 1, Status: "done", Tasks: []waveobj.TaskNode{{ID: "t-1", State: "done", CleanupPending: true}},
    }
    clear := &waveobj.TaskGroup{
        OID: clearID, ID: clearID, RunID: uuid.NewString(), ChannelId: uuid.NewString(),
        Parallelism: 1, Status: "done", Tasks: []waveobj.TaskNode{{ID: "t-1", State: "done"}},
    }
    if err := AppendDag(ctx, pending); err != nil { t.Fatal(err) }
    if err := AppendDag(ctx, clear); err != nil { t.Fatal(err) }
    t.Cleanup(func() {
        _ = DBDelete(context.Background(), waveobj.OType_Dag, pendingID)
        _ = DBDelete(context.Background(), waveobj.OType_Dag, clearID)
    })

    got, err := GetDagsWithPendingCleanup(ctx)
    if err != nil { t.Fatal(err) }
    foundPending, foundClear := false, false
    for _, dag := range got {
        foundPending = foundPending || dag.OID == pendingID
        foundClear = foundClear || dag.OID == clearID
    }
    if !foundPending || foundClear {
        t.Fatalf("pending=%v clear=%v dags=%+v", foundPending, foundClear, got)
    }
}
```

- [ ] **Step 2: Run tests and confirm RED**

Run:

```bash
CGO_CFLAGS='-IC:/Users/kael02/IdeaProjects/waveterm/pkg/jarvisembed/csrc' go test ./pkg/orchestrate ./pkg/wstore -run 'TestNewTaskGroup|TestGetDagsWithPendingCleanup' -count=1
```

Expected: compile failure because the fields, signature, and query do not exist.

- [ ] **Step 3: Add the persisted fields and server-derived constructor input**

In `pkg/waveobj/wtype.go`, add the fields exactly as declared in Interfaces.

Change the constructor signature to:

```go
func NewTaskGroup(runID, channelId, title string, parallelism int, mergeRequired bool, tasks []waveobj.TaskNode, ts int64) (waveobj.TaskGroup, error)
```

Set `MergeRequired: mergeRequired` on the group. Include `MergeRequired` in `SameDagProposal`'s top-level comparison so idempotent resubmission cannot equate Git and non-Git lifecycle contracts. Reject non-default input fields alongside the existing state checks:

```go
if t.Merged {
    return waveobj.TaskGroup{}, fmt.Errorf("task %q merged must be false", t.ID)
}
if t.CleanupPending || t.CleanupError != "" {
    return waveobj.TaskGroup{}, fmt.Errorf("task %q cleanup fields must be empty", t.ID)
}
```

Update every `NewTaskGroup` call with an explicit boolean. Pure unit tests use the behavior they test; server submission derives the final value in Task 4.

- [ ] **Step 4: Add the pending-cleanup query**

In `pkg/wstore/wstore_dag.go`:

```go
func GetDagsWithPendingCleanup(ctx context.Context) ([]*waveobj.TaskGroup, error) {
    return WithReadTxRtn(ctx, func(tx *TxWrap) ([]*waveobj.TaskGroup, error) {
        query := `SELECT oid, version, data FROM db_dag
            WHERE EXISTS (
                SELECT 1 FROM json_each(data, '$.tasks') AS task
                WHERE json_extract(task.value, '$.cleanuppending') = 1
            )
            ORDER BY json_extract(data, '$.updatedts') ASC`
        var rows []idDataType
        tx.Select(&rows, query)
        out := make([]*waveobj.TaskGroup, 0, len(rows))
        for _, row := range rows {
            obj, err := waveobj.FromJson(row.Data)
            if err != nil {
                return nil, err
            }
            waveobj.SetVersion(obj, row.Version)
            out = append(out, obj.(*waveobj.TaskGroup))
        }
        return out, nil
    })
}
```

No SQL migration is required: the fields live inside the existing registered `db_dag` JSON object and are backward-compatible when omitted.

- [ ] **Step 5: Run generation**

Run:

```bash
task generate
```

Expected: generated Go/TypeScript clients compile and `TaskNode`/`TaskGroup` carry the new fields. Do not edit generated files by hand.

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```bash
CGO_CFLAGS='-IC:/Users/kael02/IdeaProjects/waveterm/pkg/jarvisembed/csrc' go test ./pkg/orchestrate ./pkg/wstore -count=1
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
```

Expected: both commands exit 0.

- [ ] **Step 7: Diff checkpoint**

Run:

```bash
git diff --check
git diff --stat -- pkg/waveobj/wtype.go pkg/orchestrate/dag.go pkg/wstore/wstore_dag.go frontend/types/gotypes.d.ts frontend/app/store/wshclientapi.ts pkg/wshrpc/wshclient/wshclient.go
```

Confirm generated changes correspond only to the new fields/signature-derived bindings. Do not commit.

---

### Task 4: Make Git dependencies merge-gated and record spawn-time bases

**Files:**
- Modify: `pkg/orchestrate/dag.go`, `dag_test.go`
- Modify: `pkg/orchestrate/scheduler.go`, `scheduler_test.go`
- Modify: `pkg/orchestrate/worktree.go`, `worktree_test.go`
- Modify: `pkg/orchestrate/engine.go`, `engine_test.go`
- Modify: `pkg/jarvis/run.go`, `run_dagprompt_test.go`
- Modify: `pkg/wshrpc/wshserver/wshserver_dag.go`, `wshserver_dag_test.go`

**Interfaces:**
- Produces:

```go
func ProjectHeadCommit(context.Context, string) (string, error)
func childRunFromSpec(*waveobj.TaskGroup, *waveobj.TaskNode, *waveobj.Run, waveobj.RoutePin, string, string, string) waveobj.Run
// final string arguments: cwd, baseCommit, goal
```

- Consumes: `TaskGroup.MergeRequired`, `TaskNode.Merged`, `TaskNode.Released`.

- [ ] **Step 1: Add failing scheduler and status tests**

In `pkg/orchestrate/scheduler_test.go`, add:

```go
func TestReadyTasksRequiresMergedGitDependency(t *testing.T) {
    g := waveobj.TaskGroup{MergeRequired: true, Tasks: []waveobj.TaskNode{
        {ID: "t-1", State: TaskState_Done},
        {ID: "t-2", State: TaskState_Pending, Deps: []string{"t-1"}},
    }}
    if got := ReadyTasks(&g); len(got) != 0 {
        t.Fatalf("done but unmerged dependency released successor: %v", got)
    }
    g.Tasks[0].Merged = true
    if got := ReadyTasks(&g); len(got) != 1 || got[0] != "t-2" {
        t.Fatalf("merged dependency did not release successor: %v", got)
    }
}

func TestReadyTasksNonGitUsesDoneDependency(t *testing.T) {
    g := waveobj.TaskGroup{MergeRequired: false, Tasks: []waveobj.TaskNode{
        {ID: "t-1", State: TaskState_Done},
        {ID: "t-2", State: TaskState_Pending, Deps: []string{"t-1"}},
    }}
    if got := ReadyTasks(&g); len(got) != 1 || got[0] != "t-2" {
        t.Fatalf("non-git dependency did not release successor: %v", got)
    }
}
```

In `pkg/orchestrate/dag_test.go`, add:

```go
func TestRecomputeDagStatusWaitsForMergeAndCleanup(t *testing.T) {
    g := waveobj.TaskGroup{MergeRequired: true, Status: DagStatus_Running, Tasks: []waveobj.TaskNode{{ID: "t-1", State: TaskState_Done}}}
    RecomputeDagStatus(&g)
    if g.Status != DagStatus_Running { t.Fatalf("unmerged status=%s", g.Status) }
    g.Tasks[0].Merged, g.Tasks[0].CleanupPending = true, true
    RecomputeDagStatus(&g)
    if g.Status != DagStatus_Running { t.Fatalf("cleanup-pending status=%s", g.Status) }
    g.Tasks[0].CleanupPending = false
    RecomputeDagStatus(&g)
    if g.Status != DagStatus_Done { t.Fatalf("clean merged status=%s", g.Status) }
}

func TestRecomputeDagStatusFinalGateAwaitsReview(t *testing.T) {
    g := waveobj.TaskGroup{Status: DagStatus_Running, Tasks: []waveobj.TaskNode{{ID: "gate", Gate: true, State: TaskState_Done}}}
    RecomputeDagStatus(&g)
    if g.Status != DagStatus_AwaitingReview { t.Fatalf("final gate status=%s", g.Status) }
}
```

- [ ] **Step 2: Run the tests and confirm RED**

Run:

```bash
CGO_CFLAGS='-IC:/Users/kael02/IdeaProjects/waveterm/pkg/jarvisembed/csrc' go test ./pkg/orchestrate -run 'TestReadyTasks|TestRecomputeDagStatus' -count=1
```

Expected: merge-required cases fail because done currently means dependency-terminal and DAG-terminal.

- [ ] **Step 3: Make dependency and terminal derivation merge-aware**

Replace `depTerminal` with:

```go
func depSatisfied(g *waveobj.TaskGroup, id string) bool {
    for i := range g.Tasks {
        t := &g.Tasks[i]
        if t.ID != id {
            continue
        }
        if t.State == TaskState_Skipped {
            return true
        }
        if t.State != TaskState_Done {
            return false
        }
        if !g.MergeRequired {
            return true
        }
        return t.Merged && (!t.Gate || t.Released)
    }
    return false
}
```

Use it from `ReadyTasks`.

In `RecomputeDagStatus`, make done tasks non-terminal when review or merge remains:

```go
case TaskState_Done:
    if t.Gate && !t.Released {
        gateDone = true
        allTerminal = false
        continue
    }
    if g.MergeRequired && (!t.Merged || t.CleanupPending) {
        allTerminal = false
        continue
    }
```

Leave skipped terminal. Existing cancelled/blocked precedence remains.

- [ ] **Step 4: Derive `MergeRequired` at DAG submission**

In `DagSubmitCommand`, after loading the owner run:

```go
mergeRequired := orchestrate.IsGitRepo(run.ProjectPath)
proposed, err := orchestrate.NewTaskGroup(
    data.RunId,
    data.ChannelId,
    data.Title,
    data.Parallelism,
    mergeRequired,
    data.Tasks,
    time.Now().UnixMilli(),
)
```

Add this table test to `wshserver_dag_test.go` (use `os/exec` to initialize the Git case):

```go
func TestDagSubmitDerivesMergeRequiredFromProject(t *testing.T) {
    cases := []struct {
        name string
        git  bool
    }{{name: "git", git: true}, {name: "plain", git: false}}
    for _, tc := range cases {
        t.Run(tc.name, func(t *testing.T) {
            ctx := context.Background()
            project := t.TempDir()
            if tc.git {
                runGit := func(args ...string) {
                    out, err := exec.Command("git", append([]string{"-C", project}, args...)...).CombinedOutput()
                    if err != nil { t.Fatalf("git %v: %v\n%s", args, err, out) }
                }
                runGit("init", "-b", "main")
                runGit("config", "user.email", "t@test")
                runGit("config", "user.name", "t")
                if err := os.WriteFile(filepath.Join(project, "base.txt"), []byte("base\n"), 0o644); err != nil { t.Fatal(err) }
                runGit("add", ".")
                runGit("commit", "-m", "base")
            }
            ch, err := wstore.CreateChannel(ctx, "merge-required-"+tc.name, project)
            if err != nil { t.Fatal(err) }
            run := jarvis.NewRun("owner", "ws-1", project, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
            run.Status = jarvis.RunStatus_Planning
            run.Runtime, run.Tier = "pi", "mid"
            if err := wstore.AppendRun(ctx, ch.OID, run); err != nil { t.Fatal(err) }
            oldSpawn := jarvis.SpawnRunWorker
            jarvis.SpawnRunWorker = func(context.Context, runroute.Capability, string, string, string, string, jarvis.RunWorkerOptions) (string, error) {
                return "tab:" + uuid.NewString(), nil
            }
            defer func() { jarvis.SpawnRunWorker = oldSpawn }()
            restoreHarness := orchestrate.SetValidateWorkerHarnessForTest(func(string) error { return nil })
            defer restoreHarness()
            g, err := (&WshServer{}).DagSubmitCommand(ctx, wshrpc.CommandDagSubmitData{
                ChannelId: ch.OID, RunId: run.ID, Title: "one", Parallelism: 1,
                Tasks: []waveobj.TaskNode{{ID: "t-1", Label: "one"}},
            })
            if err != nil { t.Fatal(err) }
            if g.MergeRequired != tc.git {
                t.Fatalf("MergeRequired=%v want %v", g.MergeRequired, tc.git)
            }
        })
    }
}
```

- [ ] **Step 5: Add project HEAD resolution and failing spawn-base tests**

In `worktree_test.go`:

```go
func TestProjectHeadCommitTracksCurrentProjectHead(t *testing.T) {
    dir := newGitRepo(t)
    first, err := ProjectHeadCommit(context.Background(), dir)
    if err != nil { t.Fatal(err) }
    os.WriteFile(filepath.Join(dir, "next.txt"), []byte("next\n"), 0o644)
    gitCmd(t, dir, "add", ".")
    gitCmd(t, dir, "commit", "-m", "next")
    second, err := ProjectHeadCommit(context.Background(), dir)
    if err != nil { t.Fatal(err) }
    if first == second { t.Fatal("project head did not advance") }
}
```

Add this engine test:

```go
func TestScheduleUsesPostMergeHeadAsDependentChildBase(t *testing.T) {
    allowWorkerHarnessForTest(t)
    ctx := context.Background()
    project := newGitRepo(t)
    ownerBase := gitCmd(t, project, "rev-parse", "HEAD")
    ch, err := wstore.CreateChannel(ctx, "dependent-base", project)
    if err != nil { t.Fatal(err) }
    owner := jarvis.NewRun("owner", "ws-1", project, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
    owner.Runtime, owner.Tier, owner.BaseCommit = "pi", "mid", ownerBase
    if err := wstore.AppendRun(ctx, ch.OID, owner); err != nil { t.Fatal(err) }

    os.WriteFile(filepath.Join(project, "merged.txt"), []byte("merged\n"), 0o644)
    gitCmd(t, project, "add", ".")
    gitCmd(t, project, "commit", "-m", "merge predecessor")
    mergedHead := gitCmd(t, project, "rev-parse", "HEAD")

    g, err := NewTaskGroup(owner.ID, ch.OID, "dependent", 1, true, []waveobj.TaskNode{
        {ID: "t-1", Label: "predecessor"},
        {ID: "t-2", Label: "successor", Deps: []string{"t-1"}},
    }, 1)
    if err != nil { t.Fatal(err) }
    g.Tasks[0].State, g.Tasks[0].Merged = TaskState_Done, true
    RecomputeDagStatus(&g)
    if err := wstore.AppendDag(ctx, &g); err != nil { t.Fatal(err) }

    oldSpawn := spawnWorker
    spawnWorker = func(context.Context, runroute.Capability, string, string, string, string, jarvis.RunWorkerOptions) (string, error) {
        return "tab:worker", nil
    }
    defer func() { spawnWorker = oldSpawn }()
    if err := ScheduleOnce(ctx, &g); err != nil { t.Fatal(err) }
    child, err := wstore.GetRun(ctx, ch.OID, g.Tasks[1].RunID)
    if err != nil { t.Fatal(err) }
    if child.BaseCommit != mergedHead || child.BaseCommit == ownerBase {
        t.Fatalf("child base=%q merged=%q owner=%q", child.BaseCommit, mergedHead, ownerBase)
    }
    t.Cleanup(func() { _ = RemoveRunWorktree(context.Background(), project, TaskWorktreeKey(owner.ID, "t-2")) })
}
```

- [ ] **Step 6: Use one current HEAD for each scheduler spawn batch**

In `worktree.go`:

```go
func ProjectHeadCommit(ctx context.Context, projectPath string) (string, error) {
    return git(ctx, projectPath, "rev-parse", "HEAD")
}
```

In `scheduleLocked`, resolve before `NextToSpawn`:

```go
spawnBase := owner.BaseCommit
if g.MergeRequired {
    spawnBase, err = ProjectHeadCommit(spawnCtx, owner.ProjectPath)
    if err != nil {
        return fmt.Errorf("resolving project head for dag %s: %w", g.ID, err)
    }
}
```

Pass `spawnBase` to `EnsureRunWorktree` and to `childRunFromSpec`. Change the child builder to assign:

```go
run.BaseCommit = baseCommit
```

All siblings spawned in that pass use the same value.

- [ ] **Step 7: Tell the Pi lead about the explicit merge boundary**

Add this sentence to `buildPiOrchestratePrompt`:

```go
b.WriteString("A Git-backed dependent task remains pending until each predecessor is merged; when `wsh jarvis dag status` shows `merge`, run the command with the reported id, for example `wsh jarvis dag merge t-1`, after reviewing the completed task so its successors start from the integrated project HEAD.\n")
```

In `run_dagprompt_test.go`, extend the Pi prompt assertion list:

```go
for _, want := range []string{
    "remains pending until each predecessor is merged",
    "wsh jarvis dag status",
    "wsh jarvis dag merge t-1",
} {
    if !strings.Contains(p, want) {
        t.Errorf("pi prompt missing %q", want)
    }
}
```

- [ ] **Step 8: Run focused and package tests**

Run:

```bash
CGO_CFLAGS='-IC:/Users/kael02/IdeaProjects/waveterm/pkg/jarvisembed/csrc' go test ./pkg/orchestrate ./pkg/jarvis ./pkg/wshrpc/wshserver -count=1
```

Expected: all packages pass, including Git and non-Git dependency cases.

- [ ] **Step 9: Diff checkpoint**

Run:

```bash
git diff --check
git diff -- pkg/orchestrate/scheduler.go pkg/orchestrate/engine.go pkg/orchestrate/worktree.go pkg/jarvis/run.go pkg/wshrpc/wshserver/wshserver_dag.go
```

Confirm successors cannot spawn from stale owner bases and no automatic merge path was added. Do not commit.

---

### Task 5: Persist merge success separately from cleanup

**Files:**
- Create: `pkg/orchestrate/cleanup.go`
- Create: `pkg/orchestrate/cleanup_test.go`
- Modify: `pkg/orchestrate/merge.go`, `merge_test.go`
- Modify: `pkg/orchestrate/worktree.go`, `worktree_test.go`
- Modify: `pkg/orchestrate/mutation.go`, `mutation_test.go`
- Modify: `pkg/wshrpc/wshserver/wshserver_dag.go`, `wshserver_dag_test.go`
- Modify: `cmd/server/main-server.go`

**Interfaces:**
- Produces:

```go
func CleanupTaskWorktree(ctx context.Context, dagID, taskID, projectPath, ownerRunID string) error
func RetryPendingCleanup(ctx context.Context) error
```

- `MergeRunWorktree` and `MergeContinue` perform content integration only and return the integration SHA.
- `DagMergeCommand` and `DagMergeContinueCommand` use one shared finalization helper.

- [ ] **Step 1: Add failing cleanup persistence tests**

Create `pkg/orchestrate/cleanup_test.go` with this seed helper and tests:

```go
func seedCleanupDag(t *testing.T, ctx context.Context, projectPath, taskID string) (*waveobj.Run, *waveobj.TaskGroup) {
    t.Helper()
    ch, err := wstore.CreateChannel(ctx, "cleanup-"+uuid.NewString(), projectPath)
    if err != nil { t.Fatal(err) }
    owner := jarvis.NewRun("cleanup owner", "ws-1", projectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
    owner.Status = jarvis.RunStatus_Done
    if err := wstore.AppendRun(ctx, ch.OID, owner); err != nil { t.Fatal(err) }
    dag, err := NewTaskGroup(owner.ID, ch.OID, "cleanup", 1, true, []waveobj.TaskNode{{ID: taskID, Label: "cleanup", State: ""}}, 1)
    if err != nil { t.Fatal(err) }
    dag.Tasks[0].State = TaskState_Done
    dag.Tasks[0].Merged = true
    dag.Tasks[0].CleanupPending = true
    RecomputeDagStatus(&dag)
    if err := wstore.AppendDag(ctx, &dag); err != nil { t.Fatal(err) }
    return &owner, &dag
}

func TestCleanupTaskWorktreePersistsFailureThenClearsOnRetry(t *testing.T) {
    ctx := context.Background()
    owner, dag := seedCleanupDag(t, ctx, t.TempDir(), "t-1")

    old := removeTaskWorktree
    defer func() { removeTaskWorktree = old }()
    removeTaskWorktree = func(context.Context, string, string) error { return errors.New("locked") }

    err := CleanupTaskWorktree(ctx, dag.OID, "t-1", owner.ProjectPath, owner.ID)
    if err == nil { t.Fatal("cleanup failure must be returned") }
    failed, _ := wstore.GetDag(ctx, dag.OID)
    if !failed.Tasks[0].CleanupPending || !strings.Contains(failed.Tasks[0].CleanupError, "locked") {
        t.Fatalf("cleanup debt not persisted: %+v", failed.Tasks[0])
    }

    removeTaskWorktree = func(context.Context, string, string) error { return nil }
    if err := CleanupTaskWorktree(ctx, dag.OID, "t-1", owner.ProjectPath, owner.ID); err != nil { t.Fatal(err) }
    cleared, _ := wstore.GetDag(ctx, dag.OID)
    if cleared.Tasks[0].CleanupPending || cleared.Tasks[0].CleanupError != "" {
        t.Fatalf("cleanup debt not cleared: %+v", cleared.Tasks[0])
    }
}

func TestRetryPendingCleanupClearsEveryPersistedTask(t *testing.T) {
    ctx := context.Background()
    _, first := seedCleanupDag(t, ctx, t.TempDir(), "t-1")
    _, second := seedCleanupDag(t, ctx, t.TempDir(), "t-2")
    old := removeTaskWorktree
    defer func() { removeTaskWorktree = old }()
    removeTaskWorktree = func(context.Context, string, string) error { return nil }

    if err := RetryPendingCleanup(ctx); err != nil { t.Fatal(err) }
    for _, id := range []string{first.OID, second.OID} {
        dag, err := wstore.GetDag(ctx, id)
        if err != nil { t.Fatal(err) }
        if dag.Tasks[0].CleanupPending || dag.Tasks[0].CleanupError != "" {
            t.Fatalf("dag %s retained cleanup debt: %+v", id, dag.Tasks[0])
        }
    }
}
```

Import `github.com/google/uuid`, `pkg/jarvis`, `pkg/waveobj`, and `pkg/wstore`.

- [ ] **Step 2: Add failing merge-handler tests**

In `wshserver_dag_test.go`, extend `TestDagMergeTargetsChildWorktree` with a cleanup seam:

```go
restoreCleanup := orchestrate.SetRemoveTaskWorktreeForTest(func(context.Context, string, string) error {
    return errors.New("locked after merge")
})
defer restoreCleanup()

beforeMerge := execGit("rev-parse", "HEAD")
err = ws.DagMergeCommand(ctx, wshrpc.CommandDagMergeData{ChannelId: ch.OID, RunId: run.ID, TaskId: "t-0"})
if err == nil || !strings.Contains(err.Error(), "locked after merge") {
    t.Fatalf("merge must return cleanup context, got %v", err)
}
afterMerge := execGit("rev-parse", "HEAD")
if beforeMerge == afterMerge { t.Fatal("content integration did not commit") }
child, _ := wstore.GetRun(ctx, ch.OID, g.Tasks[0].RunID)
mergedDag, _ := wstore.GetDag(ctx, g.OID)
if child.EndCommit != afterMerge || !mergedDag.Tasks[0].Merged || !mergedDag.Tasks[0].CleanupPending {
    t.Fatalf("merge identity was not persisted: child=%+v task=%+v", child, mergedDag.Tasks[0])
}

restoreCleanup()
restoreCleanup = orchestrate.SetRemoveTaskWorktreeForTest(orchestrate.RemoveRunWorktree)
if err := ws.DagMergeCommand(ctx, wshrpc.CommandDagMergeData{ChannelId: ch.OID, RunId: run.ID, TaskId: "t-0"}); err != nil {
    t.Fatal(err)
}
if got := execGit("rev-parse", "HEAD"); got != afterMerge {
    t.Fatalf("cleanup retry created another merge: %s != %s", got, afterMerge)
}
mergedDag, _ = wstore.GetDag(ctx, g.OID)
if mergedDag.Tasks[0].CleanupPending || mergedDag.Tasks[0].CleanupError != "" {
    t.Fatalf("cleanup debt remained: %+v", mergedDag.Tasks[0])
}
```

Apply the same seam around the final successful call in `TestDagMergeContinueFinishesBlockedMerge`: first expect persisted merge identity plus cleanup debt, then restore removal, invoke ordinary `DagMergeCommand` for the same task, and assert cleanup clears without advancing HEAD.

- [ ] **Step 3: Run focused tests and confirm RED**

Run:

```bash
CGO_CFLAGS='-IC:/Users/kael02/IdeaProjects/waveterm/pkg/jarvisembed/csrc' go test ./pkg/orchestrate ./pkg/wshrpc/wshserver -run 'TestCleanupTaskWorktree|TestRetryPendingCleanup|TestDagMerge.*Cleanup' -count=1
```

Expected: compile/test failure because cleanup is still coupled to merge.

- [ ] **Step 4: Make physical cleanup junction-safe**

Add the shared paths already used by `scripts/worktree-junctions.mjs`:

```go
var sharedWorktreeDirs = []string{
    "node_modules",
    filepath.Join("src-tauri", "target"),
    filepath.Join("dist", "bin"),
}

func removeSharedWorktreeLinks(wt string) error {
    var errs []error
    for _, rel := range sharedWorktreeDirs {
        path := filepath.Join(wt, rel)
        info, err := os.Lstat(path)
        if os.IsNotExist(err) { continue }
        if err != nil {
            errs = append(errs, fmt.Errorf("inspect %s: %w", rel, err))
            continue
        }
        if info.Mode()&os.ModeSymlink == 0 {
            continue // real directories belong to the worktree; never unlink them as shared targets
        }
        if err := os.Remove(path); err != nil {
            errs = append(errs, fmt.Errorf("remove shared link %s: %w", rel, err))
        }
    }
    return errors.Join(errs...)
}
```

Call `removeSharedWorktreeLinks(wt)` before `git worktree remove`; abort cleanup if a shared link could not be unlinked. After Git registration is gone, delete `wave/` + `runID` authoritatively: skip when `git rev-parse --verify` says the branch is absent, but return contextual failure when an existing branch cannot be deleted. Do not retain the current best-effort ignored branch-deletion calls.

Then always attempt physical removal when the directory still exists:

```go
if _, err := os.Stat(wt); err == nil {
    if err := os.RemoveAll(wt); err != nil {
        return fmt.Errorf("removing worktree directory: %w", err)
    }
}
if _, err := os.Stat(wt); err == nil {
    return fmt.Errorf("worktree directory still exists: %s", wt)
} else if !os.IsNotExist(err) {
    return fmt.Errorf("checking worktree directory: %w", err)
}
return nil
```

Add this worktree test:

```go
func TestRemoveRunWorktreeUnlinksSharedDirectoryLinks(t *testing.T) {
    dir := newGitRepo(t)
    base := gitCmd(t, dir, "rev-parse", "HEAD")
    wt, err := CreateRunWorktree(context.Background(), dir, "run-links", base)
    if err != nil { t.Fatal(err) }
    target := t.TempDir()
    sentinel := filepath.Join(target, "keep.txt")
    if err := os.WriteFile(sentinel, []byte("keep"), 0o644); err != nil { t.Fatal(err) }
    link := filepath.Join(wt, "node_modules")
    if err := os.Symlink(target, link); err != nil {
        t.Skipf("directory symlink unavailable: %v", err)
    }
    if err := RemoveRunWorktree(context.Background(), dir, "run-links"); err != nil { t.Fatal(err) }
    if data, err := os.ReadFile(sentinel); err != nil || string(data) != "keep" {
        t.Fatalf("shared target was altered: data=%q err=%v", data, err)
    }
}
```

A registered worktree removal error remains an error. An unregistered but locked directory becomes persisted cleanup debt instead of silent success.

- [ ] **Step 5: Remove cleanup calls from content integration**

In `merge.go`, remove every `RemoveRunWorktree` call from `MergeRunWorktree`, `MergeContinue`, and `finishMerge`. Preserve current idempotency for an already-landed squash commit and return the correct HEAD SHA.

In `TestMergeSquash`, delete the assertion that `wt` no longer exists and replace it with:

```go
if _, err := os.Stat(wt); err != nil {
    t.Fatalf("content integration must leave cleanup to its caller: %v", err)
}
if got := gitCmd(t, dir, "rev-parse", "HEAD"); got != sha {
    t.Fatalf("returned sha=%s head=%s", sha, got)
}
```

Keep `worktree_test.go` responsible for removal behavior.

- [ ] **Step 6: Implement persisted cleanup and startup retry**

Create `cleanup.go` with:

```go
const cleanupErrorLimit = 512

var removeTaskWorktree = RemoveRunWorktree

func SetRemoveTaskWorktreeForTest(fn func(context.Context, string, string) error) func() {
    old := removeTaskWorktree
    removeTaskWorktree = fn
    return func() { removeTaskWorktree = old }
}

func boundedCleanupError(err error) string {
    if err == nil { return "" }
    text := []rune(err.Error())
    if len(text) <= cleanupErrorLimit { return string(text) }
    return string(text[:cleanupErrorLimit])
}
```

`CleanupTaskWorktree` must:

1. mark the selected task `CleanupPending=true` before removal;
2. derive the key with `TaskWorktreeKey(ownerRunID, taskID)`;
3. call `removeTaskWorktree`;
4. update the same task with either cleared fields or bounded error and bump `UpdatedTs`;
5. call `RecomputeDagStatus` in that update so pending cleanup keeps a Git DAG non-terminal and successful cleanup can finish it;
6. send the DAG wave-object update;
7. return the cleanup error after persistence succeeds.

`RetryPendingCleanup` must load `wstore.GetDagsWithPendingCleanup`, load each owner run for project path, retry each pending task, and return `errors.Join` of contextual failures without stopping after the first DAG. After a DAG's cleanup clears, call `Schedule(ctx, dag.OID)` so terminal state, completion events, and lead closure are reconciled.

- [ ] **Step 7: Atomically record merge identity before cleanup**

In `wshserver_dag.go`, add an unexported helper:

```go
func recordDagTaskMerge(ctx context.Context, channelID, childRunID, dagID, taskID, sha string) error {
    return wstore.WithTx(ctx, func(tx *wstore.TxWrap) error {
        txCtx := tx.Context()
        if err := wstore.UpdateRun(txCtx, channelID, childRunID, func(r *waveobj.Run) error {
            r.EndCommit = sha
            return nil
        }); err != nil {
            return err
        }
        return wstore.UpdateDag(txCtx, dagID, func(g *waveobj.TaskGroup) error {
            for i := range g.Tasks {
                if g.Tasks[i].ID != taskID { continue }
                g.Tasks[i].Merged = true
                g.Tasks[i].CleanupPending = true
                g.Tasks[i].CleanupError = ""
                g.UpdatedTs = time.Now().UnixMilli()
                orchestrate.RecomputeDagStatus(g)
                return nil
            }
            return fmt.Errorf("no task %q", taskID)
        })
    })
}
```

Factor shared evidence persistence and cleanup into one helper used by ordinary and continue merges. A retry of an already merged task must seal missing evidence if needed and call `CleanupTaskWorktree`; it must not call Git merge again.

Persist newly derived evidence using the same idempotent pattern as `sealDoneRunEvidence`: only write `Evidence` and `CompletedTs` when the stored run still lacks evidence.

After the merge record exists, always call `orchestrate.Schedule(ctx, owner.DagORef)` even when cleanup returns an error. Join scheduling and cleanup errors so a merged predecessor immediately unblocks its successor, while cleanup debt remains independently visible. The already-merged retry path also schedules, covering a process interruption between persistence and the first schedule call.

- [ ] **Step 8: Persist cancellation cleanup debt**

In `cancelLocked`, preserve the existing recovery-patch call. Replace direct `RemoveRunWorktree` with `CleanupTaskWorktree` for every task. Cleanup errors join the return value but do not undo the already-persisted cancelled DAG/run states.

Add this mutation test:

```go
func TestCancelPersistsCleanupDebtWithoutRevertingCancellation(t *testing.T) {
    ctx, dag := seedPendingDag(t)
    ch, err := wstore.DBMustGet[*waveobj.Channel](ctx, dag.ChannelId)
    if err != nil { t.Fatal(err) }
    newGitRepoAt(t, ch.ProjectPath)

    oldRemove := removeTaskWorktree
    removeTaskWorktree = func(context.Context, string, string) error { return errors.New("locked") }
    defer func() { removeTaskWorktree = oldRemove }()
    oldStop := stopRunWorkers
    stopRunWorkers = func(context.Context, *waveobj.Run) error { return nil }
    defer func() { stopRunWorkers = oldStop }()

    err = Cancel(ctx, dag.OID)
    if err == nil || !strings.Contains(err.Error(), "locked") {
        t.Fatalf("cancel must return cleanup context, got %v", err)
    }
    got, err := wstore.GetDag(ctx, dag.OID)
    if err != nil { t.Fatal(err) }
    if got.Status != DagStatus_Cancelled || !got.Tasks[0].CleanupPending || !strings.Contains(got.Tasks[0].CleanupError, "locked") {
        t.Fatalf("cancel state/debt = %+v", got)
    }
}
```

- [ ] **Step 9: Wire the startup sweep**

In `cmd/server/main-server.go`, immediately before `StartWatchdog`:

```go
go func() {
    if err := orchestrate.RetryPendingCleanup(context.Background()); err != nil {
        log.Printf("orchestrator cleanup retry: %v", err)
    }
}()
orchestrate.StartWatchdog(context.Background())
```

The sweep runs once per server start; it is not another ticker.

- [ ] **Step 10: Run focused and package tests**

Run:

```bash
CGO_CFLAGS='-IC:/Users/kael02/IdeaProjects/waveterm/pkg/jarvisembed/csrc' go test ./pkg/orchestrate ./pkg/wstore ./pkg/wshrpc/wshserver -count=1
task build:backend
```

Expected: tests and backend build pass.

- [ ] **Step 11: Diff checkpoint**

Run:

```bash
git diff --check
git diff --stat -- pkg/orchestrate pkg/wstore pkg/wshrpc/wshserver/wshserver_dag.go cmd/server/main-server.go
```

Confirm a cleanup failure cannot erase merge identity or trigger a second merge. Do not commit.

---

### Task 6: Surface merge gates and cleanup debt in the graph and CLI

**Files:**
- Modify: `frontend/app/view/orchestrate/dagstore.ts`
- Modify: `frontend/app/view/orchestrate/dagstore.test.ts`
- Modify: `frontend/app/view/orchestrate/daggraph.tsx`
- Modify: `cmd/wsh/cmd/wshcmd-jarvisdag.go`
- Modify: `cmd/wsh/cmd/wshcmd-jarvisdag_test.go` — pin `dagTaskActions` output.

**Interfaces:**
- Extends `DagViewNode` with:

```ts
released: boolean;
merged: boolean;
cleanupPending: boolean;
cleanupError: string;
```

- The graph's `cleanup` action calls `DagMergeCommand`, whose merged-task path retries cleanup only.
- CLI status reports `merge` for cleanup debt because `wsh jarvis dag merge t-1` is the existing idempotent retry command.

- [ ] **Step 1: Add failing view-model tests**

In `dagstore.test.ts`, add:

```ts
it("moves a completed gate from review to merge", () => {
    const { nodes: review } = buildViewData({
        ...group,
        tasks: [{ id: "gate", label: "Gate", gate: true, released: false, state: "done" }],
    } as any, owner, harnesses);
    expect(review[0].actions).toEqual(["approve", "sendback"]);

    const { nodes: released } = buildViewData({
        ...group,
        tasks: [{ id: "gate", label: "Gate", gate: true, released: true, state: "done" }],
    } as any, owner, harnesses);
    expect(released[0].actions).toEqual(["merge"]);
});

it("offers cleanup without reoffering merge", () => {
    const { nodes } = buildViewData({
        ...group,
        tasks: [{ id: "t-1", label: "One", state: "done", merged: true, cleanuppending: true, cleanuperror: "locked" }],
    } as any, owner, harnesses);
    expect(nodes[0].actions).toEqual(["cleanup"]);
    expect(nodes[0].cleanupError).toBe("locked");
});
```

In `cmd/wsh/cmd/wshcmd-jarvisdag_test.go`, extend the existing `dagTaskActions` table with:

```go
{name: "unreleased gate", node: waveobj.TaskNode{State: orchestrate.TaskState_Done, Gate: true}, want: []string{"approve", "sendback"}},
{name: "released gate", node: waveobj.TaskNode{State: orchestrate.TaskState_Done, Gate: true, Released: true}, want: []string{"merge"}},
{name: "cleanup pending", node: waveobj.TaskNode{State: orchestrate.TaskState_Done, Merged: true, CleanupPending: true}, want: []string{"merge"}},
```

The CLI keeps `merge` as the retry verb; only the graph uses the friendlier `cleanup` label.

- [ ] **Step 2: Run tests and confirm RED**

Run:

```bash
npx vitest run frontend/app/view/orchestrate/dagstore.test.ts
CGO_CFLAGS='-IC:/Users/kael02/IdeaProjects/waveterm/pkg/jarvisembed/csrc' go test ./cmd/wsh/cmd -run TestDagTaskActions -count=1
```

Expected: action assertions fail.

- [ ] **Step 3: Derive mutually exclusive task actions**

In `buildViewData`, use this precedence for done tasks:

```ts
if (t.state === "done" && t.gate && !t.released) actions = ["approve", "sendback"];
else if (t.merged && t.cleanuppending) actions = ["cleanup"];
else if (t.state === "done" && !t.merged) actions = ["merge"];
```

Populate the new `DagViewNode` fields from generated task properties. Preserve retry/skip/escalate precedence for failed and stalled tasks.

Mirror the same state table in `dagTaskActions`.

- [ ] **Step 4: Render cleanup state and wire the action**

In `DagTaskNode`, add stable attributes:

```tsx
data-dag-task-id={view.id}
data-dag-task-state={view.state}
data-dag-task-merged={view.merged ? "true" : "false"}
data-dag-cleanup={view.cleanupPending ? "pending" : "clear"}
```

Render `cleanup pending` in warning tone and expose the bounded error in `title`. Repeat the status in the selected-task detail rail.

In `runAction`:

```ts
if (action === "merge" || action === "cleanup") {
    void RpcApi.DagMergeCommand(TabRpcClient, mergeData);
    return;
}
```

- [ ] **Step 5: Run frontend, CLI, and type checks**

Run:

```bash
npx vitest run frontend/app/view/orchestrate/dagstore.test.ts frontend/app/view/orchestrate/daglayout.test.ts frontend/app/view/orchestrate/dagmodalstate.test.ts frontend/app/view/orchestrate/escalate.test.ts
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
CGO_CFLAGS='-IC:/Users/kael02/IdeaProjects/waveterm/pkg/jarvisembed/csrc' go test ./cmd/wsh/cmd -count=1
```

Expected: all commands exit 0.

- [ ] **Step 6: Diff checkpoint**

Run:

```bash
git diff --check
git diff -- frontend/app/view/orchestrate/dagstore.ts frontend/app/view/orchestrate/daggraph.tsx cmd/wsh/cmd/wshcmd-jarvisdag.go
```

Confirm one action is offered for each lifecycle boundary and no new styling file exists. Do not commit.

---

### Task 7: Replace the planner-era E2E capture with a real persistent-lead run

**Files:**
- Rewrite: `scripts/cdp/orchestrator-e2e.mjs`
- Regenerate: `docs/orchestrator-e2e.md`
- Regenerate: `cdp-shots/orchestrator-e2e/README.md`
- Modify after observation: `docs/orchestrator-e2e-review.md`
- Modify: `docs/jarvis-tour.md`
- Modify: `docs/README.md`

**Interfaces:**
- Environment:
  - `CDP_PORT` defaults to `9222`.
  - `KEEP=1` preserves the temporary project/channel for diagnosis.
- Exit 0 only after a multi-task dependency, merge, successor-base, route, cleanup, lead-lifetime, and teardown pass.

- [ ] **Step 1: Replace the driver result model and cleanup envelope**

Use named budgets and one top-level `try/finally`:

```js
const PLANNING_TIMEOUT_MS = 120_000;
const CHILD_TIMEOUT_MS = 600_000;
const POLL_MS = 1_000;
const KEEP = process.env.KEEP === "1";

let h;
let tempProject = "";
let projectName = "";
let channelName = "";
let initialRootHead = "";
let failure;
try {
    // arrange, drive, assert, capture
} catch (error) {
    failure = error;
} finally {
    // UI teardown unless KEEP, clear viewport, close CDP, remove temp directory
}
if (failure) throw failure;
```

Every assertion appends `{id, title, ok, detail, screenshot}` to one `results` array. Both Markdown files and the contact sheet render from that array.

- [ ] **Step 2: Arrange an isolated temporary Git project**

Use Node standard library only:

```js
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
tempProject = mkdtempSync(join(tmpdir(), "wave-orchestrator-e2e-"));
projectName = `orchestrator-e2e-${Date.now()}`;
channelName = projectName;
git(tempProject, "init", "-b", "main");
git(tempProject, "config", "user.email", "orchestrator-e2e@local");
git(tempProject, "config", "user.name", "Orchestrator E2E");
writeFileSync(join(tempProject, "README.md"), "# Orchestrator E2E\n");
git(tempProject, "add", "README.md");
git(tempProject, "commit", "-m", "test: initialize orchestrator fixture");
initialRootHead = git(process.cwd(), "rev-parse", "HEAD");
```

Register the project through the UI using **New project**, fill `my-service` with `projectName`, fill `~/code/my-service` with `tempProject`, and click **Create project**. Then create a channel for that exact project through the Jarvis Subjects region.

Do not call project/channel/run RPCs directly.

- [ ] **Step 3: Select a deterministic Pi route and submit an explicit dependent goal**

Open the route picker and select the lexicographically first visible installed option whose test id starts with `route-option-pi-`. Record its displayed runtime/model text.

Submit exactly:

```text
Use the Pi task tools to publish a three-task DAG; do not execute this directly. Task 1 creates input.txt containing alpha. Task 2 depends on Task 1, reads input.txt, and creates output.txt containing alpha-beta. Task 3 depends on Task 2, verifies both files and writes VERIFY.md with the verification result. Include the file expectations and verification command in each task description, then run wsh jarvis dag import-tasks. Merge completed predecessors when dag status tells you to so dependent tasks can start. Do not push.
```

Assert the run appears immediately, its route text matches the selected route, and no `[data-dag-modal-kind="draft"]`, planner, fallback, or decomposing modal exists.

- [ ] **Step 4: Prove merge-gated dependency behavior**

Poll until at least three `[data-dag-task-id]` nodes exist. Assert every node's route attribute is inherited from the selected Pi route.

Wait until Task 1 is done. Before merge, assert Task 2 remains pending. Record project main HEAD, click Task 1's `merge` action, and wait for:

- Task 1 `data-dag-task-merged="true"`;
- Task 1 `data-dag-cleanup="clear"`;
- project main HEAD to advance;
- Task 2 to enter running or done.

Find the newly registered `wave/*-t-2` branch and assert:

```js
const successorBaseContainsMerge = git(tempProject, "merge-base", successorBranch, mergedHead) === mergedHead;
if (!successorBaseContainsMerge) throw new Error("successor base does not contain predecessor merge");
```

Also assert the Task 1 worktree registration and physical `.waveterm/worktrees/*-t-1` directory are gone.

- [ ] **Step 5: Observe lead lifetime and terminal state**

While Task 2 or Task 3 is active, assert the owner lead remains represented in the run/fleet UI. Continue merging predecessors as the graph requests.

Wait until all three tasks are merged and cleanup is clear. Trigger or wait for another watchdog interval, then assert the DAG remains terminal and no task regresses. Finally assert the lead tab closes only after both run and DAG are terminal.

If the real model fails or asks a consequential question, capture the state and exit non-zero; do not convert it into a pass.

- [ ] **Step 6: Implement deterministic teardown**

Unless `KEEP=1`:

1. delete the demo channel through its menu;
2. remove the registered temporary project through the project switcher;
3. verify `git worktree list --porcelain` in the temporary project contains only the main tree;
4. restore the viewport in `finally`;
5. close CDP;
6. remove `tempProject` with `rmSync(tempProject, {recursive: true, force: true})`;
7. assert the waveterm checkout HEAD still equals `initialRootHead`.

A teardown failure changes the process exit code to non-zero.

- [ ] **Step 7: Generate one honest evidence document and contact sheet**

Generate `cdp-shots/orchestrator-e2e/README.md`, `docs/orchestrator-e2e.md`, and `cdp-shots/orchestrator-e2e/index.html` from `results`. The architecture section must name only:

- direct `CreateRun` with a persistent Pi lead;
- `wsh jarvis dag import-tasks`;
- persisted `TaskGroup` scheduling;
- merge-gated Git dependencies;
- spawn-time child bases;
- separate cleanup debt.

Run:

```bash
rg -n 'JarvisPlanDag|DagPlanDraft|fallback draft|deferStart: true|review DAG before launch|pkg/jarvis/plandag.go|dagplanning.ts' scripts/cdp/orchestrator-e2e.mjs docs/orchestrator-e2e.md cdp-shots/orchestrator-e2e/README.md
```

Expected: no matches.

- [ ] **Step 8: Update discoverability and the review record**

Add a single link in `docs/jarvis-tour.md` from the orchestrator workflow section and add `orchestrator-e2e.md` to `docs/README.md`.

After the live run, update `docs/orchestrator-e2e-review.md` with a dated resolution table. Mark an item resolved only when the new result evidence proves it; retain any failed item as open.

- [ ] **Step 9: Static driver checkpoint**

Before launching real agents, run:

```bash
node --check scripts/cdp/orchestrator-e2e.mjs
git diff --check
git diff -- scripts/cdp/orchestrator-e2e.mjs docs/orchestrator-e2e.md docs/orchestrator-e2e-review.md docs/jarvis-tour.md docs/README.md
```

Do not launch the live run or commit yet.

---

### Task 8: Verify and run the personal-dogfood acceptance gate

**Files:**
- Modify only when a verification failure exposes a defect within Tasks 1–7.
- Preserve the approved spec and this plan for the eventual feature commit.

**Interfaces:**
- Consumes: all implementation tasks and a running dev app on CDP.
- Produces: test output, backend build, screenshot/contact-sheet evidence, and an explicit residual-risk report.

- [ ] **Step 1: Run the complete static verification set**

Run:

```bash
npx vitest list > .tmp-vitest-list.txt
if rg -q '\.waveterm[/\\]worktrees' .tmp-vitest-list.txt; then rm .tmp-vitest-list.txt; exit 1; fi
rm .tmp-vitest-list.txt
npx vitest run vitest.config.test.ts frontend/app/view/agents/composercommand.test.ts frontend/app/view/orchestrate/dagstore.test.ts frontend/app/view/orchestrate/daglayout.test.ts frontend/app/view/orchestrate/dagmodalstate.test.ts frontend/app/view/orchestrate/escalate.test.ts
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
CGO_CFLAGS='-IC:/Users/kael02/IdeaProjects/waveterm/pkg/jarvisembed/csrc' go test ./pkg/jarvis ./pkg/orchestrate ./pkg/wstore ./pkg/wshrpc/wshserver ./cmd/wsh/cmd -count=1
task build:backend
node --check scripts/cdp/orchestrator-e2e.mjs
git diff --check
```

Expected: every command exits 0 and no stale runtime-worktree test appears.

- [ ] **Step 2: Perform the simplify-style review**

Review the full diff and check specifically:

- one worker-spawn options boundary;
- no post-start keep-on-exit write;
- Git and non-Git dependency semantics are explicit;
- child `BaseCommit` comes from the spawn-time project HEAD;
- merge identity is persisted before cleanup;
- retries never create another merge commit;
- cleanup errors are bounded and persisted;
- generated files were produced by `task generate`;
- no planner/draft code or claims returned;
- no debug statements or commented-out implementation remain.

Run:

```bash
git status --short
git diff --stat
git diff -- vitest.config.ts pkg/jarvis/runexec.go pkg/orchestrate pkg/waveobj/wtype.go pkg/wstore/wstore_dag.go pkg/wshrpc/wshserver/wshserver_dag.go frontend/app/view/orchestrate scripts/cdp/orchestrator-e2e.mjs
```

- [ ] **Step 3: Obtain explicit approval for temporary-repository agent commits**

Before starting the CDP scenario, ask:

```text
The acceptance run creates engine-managed commits only inside a temporary Git repository and never pushes. The waveterm checkout will not be committed or used as the task project. May I launch it?
```

If approval is not explicit, stop here and report static verification only.

- [ ] **Step 4: Start or confirm the dev app, then run the E2E gate**

Do not kill an existing user-owned dev process. After the user confirms the rebuilt backend is running, execute:

```bash
node scripts/cdp/orchestrator-e2e.mjs
```

Expected: exit 0, a multi-task DAG capture, one merge-gated successor, exact route inheritance, cleanup clear, terminal stability, lead lifetime proof, and successful teardown.

- [ ] **Step 5: Verify artifacts and repository isolation**

Run:

```bash
node -e "const fs=require('fs'); for (const p of ['docs/orchestrator-e2e.md','cdp-shots/orchestrator-e2e/README.md','cdp-shots/orchestrator-e2e/index.html']) { if (!fs.existsSync(p)) throw new Error('missing '+p) }"
rg -n 'JarvisPlanDag|DagPlanDraft|fallback draft|deferStart: true|review DAG before launch|pkg/jarvis/plandag.go|dagplanning.ts' scripts/cdp/orchestrator-e2e.mjs docs/orchestrator-e2e.md cdp-shots/orchestrator-e2e/README.md
git status --short
git log -1 --oneline
```

Expected: all artifacts exist, the stale-symbol search has no matches, and the waveterm HEAD is unchanged by the acceptance run.

- [ ] **Step 6: Inspect pre-existing worktrees without deleting them**

Run:

```bash
git worktree list --porcelain
git branch --list 'wave/*' --format='%(refname:short) %(objectname:short)'
```

Record each branch's unmerged count without substituting names manually:

```bash
for branch in $(git for-each-ref --format='%(refname:short)' 'refs/heads/wave/*'); do
    printf '%s ' "$branch"
    git rev-list --count "main..$branch"
done
git status --short
```

Do not remove any pre-existing worktree or branch in this task. Report which are fully merged, which retain commits, and which directories are locked/prunable. Cleanup requires separate approval.

- [ ] **Step 7: Final status and commit gate**

Report:

- exact files modified/added/deleted;
- static commands and results;
- live E2E result and evidence paths;
- whether cleanup debt remained;
- pre-existing worktree findings;
- residual risks, including Pi-first authoring and unacknowledged lead control events.

Before any commit, show the status list and propose:

```text
fix(orchestrator): harden persistent DAG lifecycle
```

Explain that the commit includes the approved spec and plan because repository policy folds feature documentation into the feature commit. Ask: `Awaiting approval. Proceed? (yes/no)`.

Do not commit or push without an explicit `yes`.
