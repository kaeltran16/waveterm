# Jarvis orchestrator, end to end — executing a real implementation plan

**Captured live on 2026-09-04** against the `task dev` app over CDP (`:9222`), at 1600×950. Every
screenshot is a real app frame and every number below comes from a real `wshrpc` call or a real
transcript — nothing here is mocked or reconstructed.

- **Plan under execution:** `docs/superpowers/plans/2026-09-04-git-compare-viewer-parity.md` (13 numbered tasks)
- **Channel:** `#git-compare-parity-81920`
- **Project:** `.claude/worktrees/git-compare-viewer-parity` — the pre-existing feature worktree, so the
  main checkout is never touched
- **Run:** `e4a54512-88f9-4bef-9c8b-8487741feccf` · `mode=orchestrator` · `runtime=pi` ·
  `model=openai-codex/gpt-5.6-sol` · `basecommit=fcfca8da`
- **DAG:** `f2347178-59f4-4a1d-b119-99532ebe775a` · 8 tasks · `parallelism=2` · `mergeRequired=true`

The capture spans the run from creation to the merge gate: 4 of 8 tasks done, 4 worktrees awaiting
`resolve-merge`. The run was left executing.

> Screenshots live in `cdp-shots/orchestrator-plan-e2e/`, which is **gitignored** — the image links
> below resolve only on the machine that captured them. This matches the existing
> `docs/orchestrator-e2e.md` convention.

---

## Part 1 — What actually happened

### 0. Setup: one registered project

The channel picker only offers **registered** projects, and only `waveterm` (the main checkout) was
registered. The feature worktree was registered first so the whole run — lead and children — stays
inside it:

```js
createproject { name: "git-compare-parity",
                path: "C:/Users/kael02/IdeaProjects/waveterm/.claude/worktrees/git-compare-viewer-parity" }
```

### 1–4. Channel creation, driven as a user

`+ Channel` (`subjectscolumn.tsx:574`, `data-jarvis-new-channel`) toggles the picker; picking a project
opens the name field; `Create` persists the channel and auto-selects it.

![Jarvis landing](../cdp-shots/orchestrator-plan-e2e/01-landing.png)
![Project picker](../cdp-shots/orchestrator-plan-e2e/02-channel-picker.png)
![Channel name](../cdp-shots/orchestrator-plan-e2e/03-channel-name.png)
![Channel created](../cdp-shots/orchestrator-plan-e2e/04-channel-created.png)

> `projects offered: ["git-compare-parity", "waveterm"]`
> `#git-compare-parity-81920 oid=8f471559-… projectpath=…/git-compare-viewer-parity`

### 5–7. Composer: shape, route, goal

![Composer, orchestrator shape](../cdp-shots/orchestrator-plan-e2e/05-composer-orchestrator.png)
![Goal typed](../cdp-shots/orchestrator-plan-e2e/06-goal-typed.png)
![Submitted](../cdp-shots/orchestrator-plan-e2e/07-submitted.png)

**The route choice is the single most consequential decision in the whole flow**, and it is not
obvious from the UI. `BuildOrchestratePrompt` (`pkg/jarvis/run.go:353`) forks on runtime:

- `runtime == "pi"` → the lead is told to *"create pi-tasks records, and run `wsh jarvis dag
  import-tasks`; the engine validates and schedules ready children automatically"*. **This is the only
  path that produces a `TaskGroup`.**
- `claude` / `codex` → the lead is told to *"execute it adaptively by dispatching your own subagents"*.
  No `TaskGroup`, no engine, no managed worktrees. `pkg/orchestrate` never runs at all.

So "the orchestrator" means two completely different machines depending on a dropdown.

**A real false start happened here.** The first attempt took the picker's first option,
`openai-codex/gpt-5.3-codex-spark`, and the lead died on its first API call:

```
Codex error: The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account.
```

The transcript was 4 lines and then silence. Nothing in the cockpit distinguished that from a lead
still reading a 2,100-line plan — the run sat at `executing / orchestrate:running` and would have
stayed there until `StallThreshold` (15 min) elapsed. Two adjacent routes are also unusable on this
machine: the `pi` **tier** routes resolve to a bare `deepseek-v4-pro`, which pi rejects as *"ambiguous
across providers"*. The run was re-launched pinned to `openai-codex/gpt-5.6-sol`.

### 8–9. Run persisted, lead dispatched

![Run created](../cdp-shots/orchestrator-plan-e2e/08-run-created.png)
![Stage, lead working](../cdp-shots/orchestrator-plan-e2e/09-stage-run.png)
![Lead working](../cdp-shots/orchestrator-plan-e2e/09b-lead-working.png)

```
runid=e4a54512-88f9-4bef-9c8b-8487741feccf mode=orchestrator runtime=pi
model=openai-codex/gpt-5.6-sol status=executing basecommit=fcfca8da
phases=[orchestrate:running]
```

The lead is an ordinary headless `pi` process (PID 2528) in the project cwd. Its first ~10 minutes,
read straight off its transcript:

1. Loaded six skills — `executing-plans`, `subagent-driven-development`, `dispatching-parallel-agents`,
   `writing-plans`, `verification-before-completion`, `pi-subagents`.
2. Read the plan and the spec in full, then re-read the plan tail (`offset: 1327, limit: 900`).
3. Ran a **baseline verification** before touching anything — `go test ./pkg/gitinfo/`, the frontend
   suite, and the large-stack `tsc`. It reported all three clean ("94 agent test files / 1,337 tests");
   that count is the lead's own summary, not independently checked here. Nothing in the run prompt
   asked for a baseline — the `verification-before-completion` skill did.
4. Wrote `.superpowers/sdd/2026-09-04-git-compare-viewer-parity/progress.md`.
5. Created 13 pi-tasks records — one per numbered plan task — in **two passes**: 13 × `TaskCreate`
   with no dependencies, then 9 × `TaskUpdate` adding `blockedBy`. Mid-flight the store therefore
   looks dependency-free, which is a snapshot artefact, not the final shape.

The dependency structure it derived was exactly right: tasks 1–4 parallel, task 5 (the RPC surface)
gating on all four, then a linear 6→13 chain.

### 10. The engine rejected the import, and the lead escalated

```
$ wsh jarvis dag import-tasks
Error: no more than 8 tasks are allowed
Command exited with code 1
```

`orchestrate.MaxTasks = 8` (`pkg/orchestrate/dag.go:39`). The plan has 13 tasks. The lead invoked
`systematic-debugging`, probed the store/import boundary, and then — correctly — did **not** guess. It
raised an `AskUserQuestion`, which surfaced in the cockpit as a blocking escalation card:

> **DAG LIMIT** — This `wsh` build hard-limits one DAG to 8 tasks, but the approved plan has 13
> numbered tasks. Which execution shape should govern?
>
> 1. **Two DAG phases** *(recommended by the lead)* — run Tasks 1–8, then import Tasks 9–13 after the
>    first DAG is integrated.
> 2. **Compress to 8 nodes** — combine adjacent plan tasks, losing one-record-per-number traceability.

![Escalation answered](../cdp-shots/orchestrator-plan-e2e/10-escalation-answered.png)

**The lead's recommended option cannot work in this build.** `wstore.CreateDagForRun`
(`pkg/wstore/wstore_dag.go:88`) short-circuits and returns the *existing* dag whenever
`run.DagORef != ""`; `DagSubmitCommand` then compares proposals and fails a different one with
`dag conflict: run %s already linked to a different dag`. **One orchestrator run holds exactly one
`TaskGroup` for its entire lifetime.** Option 1 would have run the first eight tasks and then hard-
failed at the second import, stranding tasks 9–13.

Answered **option 2**. The lead resumed immediately:

```
User has answered your questions: "…Which execution shape should govern?"="Compress to 8 nodes"
```

It folded 13 → 8 while preserving order: plan tasks 1–5 kept 1:1, tasks 6+7 → node `t-6`
("Build the diff content data plane"), tasks 8–12 → node `t-7` ("Integrate Monaco compare parity UI"),
task 13 → node `t-8`.

### 11–14. `DagSubmit` lands and the engine takes over

![DAG submitted](../cdp-shots/orchestrator-plan-e2e/11-dag-submitted.png)
![Run body, Open DAG](../cdp-shots/orchestrator-plan-e2e/12-run-body-open-dag.png)
![Live Route DAG](../cdp-shots/orchestrator-plan-e2e/13-dag-modal-live.png)
![Node detail](../cdp-shots/orchestrator-plan-e2e/14-dag-node-detail.png)

```
DAG f2347178-59f4-4a1d-b119-99532ebe775a  status=running  parallelism=2  mergeRequired=true  tasks=8
  t-1 [pending]                              Implement FileAtRef backend reader
  t-2 [running] run=608bc899                 Add remote branch metadata and defaults
  t-3 [running] run=f8c725e9                 Implement read-only Git fetch
  t-4 [pending]                              Add tip-to-tip compare form backend
  t-5 [pending] deps=t-1/t-2/t-3/t-4         Expose Git compare readers through RPC
  t-6 [pending] deps=t-5                     Build the diff content data plane
  t-7 [pending] deps=t-6                     Integrate Monaco compare parity UI
  t-8 [pending] deps=t-7                     Verify the real app and prepare final commit
```

`parallelism=2` is **hardcoded** in `wshcmd-jarvisdag.go:82` — `import-tasks` always submits 2, with no
flag to change it. That is why only two of the four independent backend tasks run at once.

Two children were spawned into managed linked worktrees, and `git worktree list` confirms them:

```
…/git-compare-viewer-parity/.waveterm/worktrees/e4a54512-…-t-2   [wave/e4a54512-…-t-2]
…/git-compare-viewer-parity/.waveterm/worktrees/e4a54512-…-t-3   [wave/e4a54512-…-t-3]
```

Each child is its own `Run` — `mode=quick`, carrying `DagORef=f2347178` and a `ProjectPath` pointing at
its worktree, so evidence and continuity scope to the isolated checkout.

### 15. The digest

![Digest](../cdp-shots/orchestrator-plan-e2e/15-digest.png)

```json
{ "dagversion": 5, "health": "healthy",
  "counts": { "total": 8, "done": 0, "running": 2, "stalled": 0,
              "dependencywaiting": 4, "attention": 0, "recoveredretry": 0, "mergeready": 0 },
  "next":   { "kind": "parallelism-wait", "blockingtaskids": ["t-2", "t-3"] } }
```

`next.kind = parallelism-wait` is the engine correctly reporting that t-1 and t-4 are *ready* and
blocked only by the parallelism cap — not by dependencies. Every pending task reports
`mergestate: "waiting"`, because `MergeRequired` is true and no predecessor has merged yet.

### 16. The merge gate, reached for real

About 25 minutes in, all four independent backend tasks had finished. The engine had drained them two
at a time — t-2/t-3 first, then t-1/t-4 as slots freed — and each got its own worktree, four in total:

![DAG at the merge gate](../cdp-shots/orchestrator-plan-e2e/16-dag-merge-ready.png)

```json
{ "health": "healthy",
  "counts": { "total": 8, "done": 4, "running": 0, "dependencywaiting": 4, "mergeready": 4 },
  "next":   { "kind": "merge-ready",
              "taskids": ["t-2", "t-3", "t-4", "t-1"],
              "actions": ["resolve-merge"] } }
```

Per-task: `t-1..t-4 → mergestate: ready, waitreason: terminal`; `t-5..t-8 → mergestate: waiting,
waitreason: dependency`.

This is the merge gate doing exactly what it is designed to do, and it is the most important state in
the whole flow. **t-5 does not start when its dependencies finish — it starts when they *merge*.**
Four children have committed work on four `wave/<runID>-t-N` branches; until those are squash-merged,
`spawnBase` (re-read from project HEAD each tick) still points at `fcfca8da`, so t-5 would start from a
tree missing everything t-1..t-4 built.

Nothing advances this automatically. `mergeReadyBlocking` (`digest.go:253`) surfaces the merge-ready
tasks that block pending successors, and the only offered action is `resolve-merge` — the lead is
expected to review each finished child and run `wsh jarvis dag merge t-1`, per the line in its own
prompt. **A DAG whose lead has died or drifted parks here indefinitely**: `health` still reads
`healthy`, no task is stalled, no failure counter moves — the run simply stops making progress with
four completed worktrees and nothing integrating them.

---

## Part 2 — The machinery, layer by layer

### Composer → `CreateRunCommand`

`channelcomposers.tsx:228` renders the three shapes (`pipeline | orchestrator | quick`) as
`aria-pressed` buttons. Choosing `orchestrator` swaps the single route picker for the Lead → Workers
tight row (`orchestratorpicker.ts:6`), whose worker picker defaults to `"Same as lead"` — a `null`
`WorkerRoute` meaning inherit.

`CreateRunCommand` (`pkg/wshrpc/wshserver/wshserver_runs.go:282`), in order:

1. Resolve the route **before persisting anything** — `runroute.Resolve` then
   `validateHarness(cap.Runtime, harness.OperationRunWorker)`.
2. Load the channel, resolve the Jarvis profile, `resolveRunPlan` the mode + playbook.
3. `jarvis.NewRun(goal, workspaceId, ch.ProjectPath, principles, mode, playbook, now)`.
4. Stamp `Runtime`/`Tier`/`Model` — *"immutable after Start; every phase and child inherits this."*
5. Capture `BaseCommit` from `gitinfo.HeadCommit` so the evidence diff survives the worker committing.
6. `AppendRun`, then seed `RunEventKindCreated` **before** the spawn, so a spawn failure still shows the
   run was created.
7. Unless `DeferStart`, `spawnRunWorkers` launches phase 0's worker.

`DeferStart: true` is the draft-first path (run parks in `planning`, composer submits the `TaskGroup`
itself). The live composer does not use it — the orchestrate phase starts immediately.

### `import-tasks` → `DagSubmitCommand`

`wsh jarvis dag import-tasks` (`cmd/wsh/cmd/wshcmd-jarvisdag.go:56`) reads `<cwd>/.pi/tasks/*.json` via
`pitasks.Read` and maps it with `orchestrate.ImportPitasks` (`pkg/orchestrate/import.go:12`):

- only `pending` / `in_progress` records are scheduled; completed work is dropped
- ids become `t-<pitasks id>`
- **`blockedBy` → `Deps` is the only source of DAG edges**
- `subject` → `Label`, `description` → `Description` (the decision pins the child receives)

`DagSubmitCommand` (`wshserver_dag.go:27`) re-validates every task's route + harness, derives
`MergeRequired = orchestrate.IsGitRepo(run.ProjectPath)`, and calls `NewTaskGroup`:

| Constraint | Value | Source |
|---|---|---|
| `MaxTasks` | **8** | `pkg/orchestrate/dag.go:39` |
| `MaxParallelism` | 8 | `pkg/orchestrate/dag.go:40` |
| `import-tasks` parallelism | **2, hardcoded** | `wshcmd-jarvisdag.go:82` |
| `MaxConsecutiveFailures` | 3 (circuit-break) | `pkg/orchestrate/dag.go:37` |
| `StallThreshold` | 15 min | `pkg/orchestrate/liveness.go:25` |
| `watchdogInterval` | 30 s | `pkg/orchestrate/watchdog.go:17` |
| `RunWorkerSpawnTimeout` | 60 s | `pkg/jarvis/runworker.go:17` |

`ValidateTasks` rejects duplicate/empty ids, unknown or self deps, and dependency cycles (Kahn's
algorithm, `dag.go:89`). Tasks arriving with non-default engine fields (`State`, `RunID`, `Released`,
`Merged`, `Attempts`, …) are rejected outright — the submitter proposes *structure*, never *state*.

### The engine owns execution, not the lead

From the header of `wshserver_dag.go`:

> DAG execution is engine-owned: persisted TaskGroups and waveobj updates drive supervision.
> `ScheduleOnce` and the watchdog advance tasks from persisted state without the lead worker. The lead
> receives notifications for visibility, but its phase worker is not an execution dependency.

`scheduleLocked` (`pkg/orchestrate/engine.go:181`) is one idempotent tick under a per-DAG mutation lock:

1. **Cleanup debt** — a merged task still owning its worktree is retried first.
2. **`DeriveTaskStates`** — child `Run.Status` maps onto task state (`done→done`, `cancelled→cancelled`,
   `blocked→failed`). Only tasks with a `RunID` are touched; state is derived, never hand-set.
3. **Liveness** — `lastActivityForRun` reads the child's pi transcript mtime (the only heartbeat a
   headless agent emits). Running + silent past `StallThreshold` → `stalled`.
4. **Notifications** — fresh `done` / `stalled` transitions queue `publishDagEvent` +
   `notifyLeadBestEffort` + a lifecycle row, all deferred to `afterCommit`.
5. **Failure streak** — `g.Failures` increments on fresh failures and resets only on a *fresh* success,
   so the circuit-break can still trip after an early win.
6. **Spawn** — `NextToSpawn` = ready minus busy, capped so `busy + new <= Parallelism`. Each spawn
   resolves the route (task `RunSpec` → group `WorkerRoute` → owner), ensures a worktree, builds the
   prompt, launches the worker, persists the child run, `MarkRunning`.
7. **`RecomputeDagStatus`** → `awaiting-review` / `blocked` / `done`, each waking the lead.
8. **Persist** (whole-object replace, sound only because every writer holds the lock), publish, then run
   the `afterCommit` closures.
9. **`MaybeCloseOrchestratorLead`** — the lead's tab is deleted only once both run and DAG are terminal.

The watchdog ticks `Schedule` every 30 s because a stalled child produces no events at all — nothing
else would notice.

### Worktree isolation and the merge gate

When the project is a git repo, each task gets its own linked worktree at
`<project>/.waveterm/worktrees/<runID>-<taskID>` on branch `wave/<runID>-<taskID>`.
`TaskWorktreeKey(ownerRunID, taskID)` is the single source of truth for the key, so spawn, merge and
cancel all derive it identically.

`spawnBase` is re-read from project HEAD on **every tick** when `MergeRequired` — so a task spawned
after a predecessor merged starts from the integrated tree, not the original base. That is the
mechanism behind the prompt line *"A Git-backed dependent task remains pending until each predecessor
is merged."*

`MergeRunWorktree` squash-merges `wave/<runID>` into the project branch and returns the merge sha.
Worktree removal is deliberately a separate caller step, so a cleanup failure can never obscure an
already-landed merge. On conflict the tree is left mid-merge (`ErrMergeConflict`) for
`DagMergeContinue`.

### Waking the lead: control envelopes

The lead is headless, so the engine reaches it by writing a control file its watcher polls.
`resolveLeadSessionID` (`control.go:144`) finds the lead's pi session id from the retained `agent:status`
broker events scoped to the lead's block, then writes `<sessionId>.json`.

`ControlEnvelope` exists so an acknowledgement can name the exact attempt it processed — without a
stable event id, a superseded control file and the one actually handled are indistinguishable.
`PiControlAckCommand` echoes all four fields straight back.

All outcomes are recorded — `acknowledged`, `unconfirmed`, `failed`, `unavailable` — because *"a lead
nobody could reach is a real gap in the timeline's story."* None of it gates the engine: the persisted
DAG, not the lead's awareness of it, is what execution runs on.

### Child asks travel up, not out

Every child's goal carries the `HeadlessContract` (`engine.go:459`). Children are unattended but not
mute: a genuinely consequential decision the plan did not pin goes **up** to the lead (`dag:child-ask`
+ a card on the parent run), who answers or escalates to the human; the child blocks rather than
guessing. What children must *not* do is the lead's job — no design gates, no plan rewriting, because
the plan was already approved.

Ask lifecycle rows (`askevents.go`) land on the **owning run**, not the child's, so the lead's timeline
carries the whole conversation in one place: `child-ask` on raise, `child-answered` on any delivery
path, `child-ask-cleared` when it goes away unanswered — one registry ask id spanning all three.

### Failure handling

`classifyFailure` (`retry.go:31`) buckets a child's exit summary into `tool_call_error`,
`context-window`, `timeout`, `gate-sendback`, `test-failed`, `unknown`. Dispatch faults that die before
a child run exists get their own kinds (`route-unresolved`, `harness-missing`, `worktree-failed`,
`spawn-failed`, `worker-exit-unreported`) recorded by `failDispatch` — otherwise they would exist
nowhere, having produced no transcript.

- **Retry**: only `tool_call_error`, only on the first attempt.
- **Auto-escalate**: only `context-window`, capped at one hop — retrying the identical route is
  guaranteed to hit the same wall, whereas a larger context is a property of the model, not the attempt.
- Everything else fails the task and waits for a human.

`HandleChildOutcome` also treats a `done` worker that never ran `wsh jarvis complete` as not-completed —
noticing at exit costs seconds, waiting for the transcript to go quiet costs the full 15-minute
`StallThreshold`.

### What the human and the CLI both read

`DagStatusCommand` returns `{ group, digest }`. `BuildDigest` is **pure** — the RPC layer gathers the
snapshot (group, bounded child runs, pending asks, retained lifecycle rows, now) and decides what is
fresh; the projection performs no storage or clock reads.

- `Health`: `needs-you | stalled | healthy | done | cancelled`, in that precedence.
- `Next.Kind`: `human-action | merge-ready | dispatch | parallelism-wait | dependency-wait | terminal`,
  carrying the **complete** valid `Actions` set — neither CLI nor UI reconstructs alternatives from
  task state.
- `Control`: the **latest** attempt only, acks matched by event id, so a superseded control file stays
  `unconfirmed` rather than inheriting the previous ack.
- `DagVersion` pins the source group version so consumers can reject stale answers.

The same digest drives `wsh jarvis dag status` and the cockpit's Route DAG modal
(`frontend/app/view/orchestrate/dagmodal.tsx`, graph in `daggraph.tsx` off `buildViewData`, timeline in
`timelinerail.tsx`).

---

## Part 3 — What this run exposed

Ordered by how much they cost.

1. **`MaxTasks = 8` has no path for a larger plan.** A 13-task plan is not unusual, and the engine's
   answer is a flat rejection at import time — after the lead has already spent ~10 minutes producing
   13 records. There is no "split into phases" affordance, and the obvious workaround (import the rest
   later) is structurally impossible because a run links exactly one DAG forever.
2. **The lead recommended an option the engine cannot execute.** It had no way to know: nothing in the
   prompt, the CLI help, or the error text says one run gets one DAG. A human who took the
   recommendation would have discovered it eight tasks later.
3. **A dead lead is indistinguishable from a working one for 15 minutes.** The `codex-spark` rejection
   produced a run stuck at `executing / orchestrate:running` with a 4-line transcript. Liveness is
   mtime-based, so a process that dies *before* writing anything substantial looks exactly like one
   that is thinking. A first-token deadline would have caught it in seconds.
4. **The route picker offers routes that cannot run.** `openai-codex/gpt-5.3-codex-spark` is listed and
   selectable but rejected by the provider on a ChatGPT account; the `pi` tier routes resolve to an
   ambiguous bare `deepseek-v4-pro`. `ListHarnessesCommand` reports capability, not entitlement.
5. **`parallelism: 2` is hardcoded in `import-tasks`.** Four independent backend tasks, two slots, no
   flag. `DagSubmitCommand` accepts up to 8; only the CLI path pins it.
6. **A parked merge gate reads as `healthy`.** With 4 tasks done and 4 worktrees awaiting
   `resolve-merge`, the digest reports `health: "healthy"`, zero stalled, zero attention — yet nothing
   will advance until the lead runs `wsh jarvis dag merge`. The engine deliberately does not merge on
   the human's behalf, but a lead that has died or drifted leaves the DAG indistinguishable from one
   that is simply between ticks. `StallThreshold` does not apply: no task is running, so there is
   nothing to time out.
7. **`runtime` silently selects between two different orchestrators.** Picking `claude` instead of `pi`
   means no DAG, no worktrees, no engine — the same UI, a completely different execution model, with
   nothing in the composer to say so.

Nothing here was fixed; the run was left executing at the merge gate. All seven are filed as
F11-F17 in `docs/orchestrator-redesign-flaws.md` (capture 2), with derived requirements R9-R13.

---

## Reproducing

Requires `task dev` running with the debug port (`:9222`, dev-only in `src-tauri/src/main.rs`).

- Driver used for this capture: `scripts/cdp/orchestrator-e2e.mjs` is the closest committed
  equivalent, but its "Where in code" section is stale (it cites `pkg/jarvis/plandag.go` and
  `pkg/orchestrate/schedule.go`, neither of which exists).
- Observation is all plain `wshrpc`: `getchannels`, `getchannelruns`, `dagstatus`, `getattention`,
  `listharnesses` — reachable from the page via `window.TabRpcClient.wshRpcCall`, which
  `scripts/cdp/attach.mjs` wraps as `h.rpc(command, data)`.
- `wsh jarvis dag status` prints the same digest from inside any worker's shell.
