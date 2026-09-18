# Orchestrator guide gaps: clear-bug batch

**Verify:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && npx vitest run && CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/...`
**Setup:** `task worktree:prepare`

**Goal:** fix the 19 clear-bug chunks of effort `5d11f853-41e2-44d4-8aa4-bf92cee88dca`, each proven by unit tests.

**Spec:** `docs/superpowers/specs/2026-09-18-orchestrator-guide-gaps-design.md`

**Shape:** nine independent code tasks, grouped so that no two tasks edit the same file, and one docs task
that waits for all of them. A worker sees only its own task, so every task restates the rules it needs.

**For the lead:** under load at parallelism 3, this Verify once ran past the 20-minute cap with every package
passing. If a Verify times out and its output tail shows only passes, re-run it with
`wsh jarvis dag merge <task> --continue` rather than changing code.

| Task | Chunks | Files |
|---|---|---|
| 1 | #1, #8, #11 | `frontend/app/view/agents/{runmodel,runcards,runbody}`, `frontend/app/view/jarvis/{runsheet,briefsheet,runsheetmodel}` |
| 2 | #2, #17 | `pkg/jarvis/runexec.go` |
| 3 | #4, #7, #10 | `pkg/orchestrate/{mergetask,leadclose,digest}.go` |
| 4 | #5, #13 | `pkg/jarvis/{evidence,attention}.go` |
| 5 | #6, #15 | `frontend/app/view/agents/{answerbar,agentsviewmodel}`, `pkg/agentask/deliver.go` |
| 6 | #3, #16 | `pkg/wshrpc/wshserver/wshserver_runs.go`, `frontend/app/view/agents/runactions.ts`, `frontend/app/view/jarvis/newruncontrol.tsx` |
| 7 | #12, #14 | `frontend/app/view/orchestrate/{daggraph.tsx,dagstore.ts}` |
| 8 | #9 | `frontend/app/view/agents/session-models/agentstatusstore.ts` |
| 9 | #18, #19 | `frontend/app/view/agents/channelsstore.ts`, `pkg/utilds/quickreorderqueue_test.go` |
| 10 | docs | `docs/orchestrator-guide.md` |

---

### Task 1: Run sheet: Cancel counts DAG workers, answer keys follow the card, Verify and lead-held rows
**Depends on:** none

This task closes three chunks of effort `5d11f853-41e2-44d4-8aa4-bf92cee88dca`:
- `liveWorkers ignores DAG child runs (Cancel confirm, 1-9 answers, 0-workers row)`
- `Verify has no task row or output once the lane worker is reaped`
- `Lead-held question mislabelled on the task row`

**Rules for this task** (you see only this task, so everything you need is here):
- Stay inside the files listed below. Never edit anything under `docs/`.
- Typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (about 2 minutes; it must exit 0). Never use `npx tsc` or `task check:ts`; both break in this repo.
- Frontend tests: `npx vitest run <file>`. Go tests (Git Bash): `CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/<package>/...`.
- Frontend logic goes in a pure `.ts` module with a `.test.ts` beside it. No jsdom, render or snapshot tests. Colors come from `@theme` token classes only (`text-error`, `text-muted`…), never raw hex or rgba.
- If you change any wshrpc, waveobj or wconfig type, run `task generate` and never hand-edit its outputs. This task needs none.
- Check formatting only on the files you touched (`npx prettier --check <file>`, `gofmt -l <file>`). Never `--write` the tree.
- Commit with a conventional message (`fix(runs): …`) and no trailers (no `Co-Authored-By`).
- Before completing, run the full Verify: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && npx vitest run && CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/...`
- The last steps, in order: close each chunk above with `wsh effort chunk status`, then `wsh jarvis complete --commit $(git rev-parse HEAD)`.

**Files:**
- Modify: `frontend/app/view/agents/runmodel.ts`, `frontend/app/view/agents/runmodel.test.ts`
- Modify: `frontend/app/view/agents/runcards.tsx` (`CancelRunButton`), `frontend/app/view/agents/runbody.tsx` (its two `CancelRunButton` call sites)
- Modify: `frontend/app/view/jarvis/runsheet.tsx` (`RunSheetFrame`'s asker, its `CancelRunButton` call site), `frontend/app/view/jarvis/briefsheet.tsx` (the ask bindings)
- Modify: `frontend/app/view/jarvis/runsheetmodel.ts`, `frontend/app/view/jarvis/runsheetmodel.test.ts` (`liveTaskRow`)

**What is wrong (verified in code):**
- `liveWorkers(run, agents)` (`runmodel.ts`) walks only `run.phases`. An engine run's workers are DAG child
  runs, and its lead is `idle` between wakes, so `CancelRunButton` (`runcards.tsx`) passes 0 to
  `confirmCancelRun`, which then cancels without asking. That ended a real run with 10 of 13 tasks skipped.
- The Brief's 1–9/Enter answer bindings (`BriefSheet`, `briefsheet.tsx`) look up the asker on the
  channel-list snapshot of the run (`stageRunAtom`). The question card (`RunSheetFrame`, `runsheet.tsx`)
  reads the live `run:` object (`runAtom`). A `run:` update never refreshes the snapshot, so the keys can
  miss an asker the card shows. The effort note said a planning run "has no phases"; that is wrong, since
  the lead is in the orchestrate phase. This cause is unconfirmed and needs a live check.
- `liveTaskRow` (`runsheetmodel.ts`) shows "running Verify" only while the worker session is live. The engine
  reaps the lane's worker before Verify starts, so a `verifying` task reads "no session · … session closed,
  work continues".
- The digest reports `waitreason: "lead-ask"` for a question the lead holds, but `liveTaskRow` matches only
  `"ask"`, so the row falls through to the worker's own activity text.
- The "0 workers" lead row in the Agent tree is **not** `liveWorkers`: the tree counts through lineage. Other
  tasks fix it: engine workers missing from the workspace, and statuses lost on reload.

- [ ] **Step 1: Write the failing runmodel tests.** In `frontend/app/view/agents/runmodel.test.ts`, add
  `runLiveWorkers` and `leadAsker` to the `./runmodel` import, add
  `import type { Lineage } from "./runlineage";`, and append:

```ts
describe("runLiveWorkers", () => {
    const owner = () =>
        run({ id: "owner", oid: "owner", status: "executing", phases: [{ kind: "orchestrate", state: "running", workerorefs: ["tab:lead"] }] });
    const lineage: Lineage = {
        roles: {
            lead: { kind: "lead", runId: "owner" },
            w1: { kind: "worker", leadRunId: "owner", taskId: "t-1" },
            w2: { kind: "worker", leadRunId: "owner", taskId: "t-2" },
            w3: { kind: "worker", leadRunId: "owner", taskId: "t-3" },
            other: { kind: "worker", leadRunId: "another-run", taskId: "t-1" },
        },
        runs: {},
    };
    it("counts an engine run's DAG workers while its lead is idle between wakes", () => {
        const agents = [
            agent({ id: "lead", state: "idle" }),
            agent({ id: "w1", state: "working" }),
            agent({ id: "w2", state: "asking" }),
            agent({ id: "w3", state: "idle" }),
            agent({ id: "other", state: "working" }),
        ];
        expect(runLiveWorkers(owner(), agents, lineage).map((w) => w.id)).toEqual(["w1", "w2"]);
    });
    it("lists a live lead once, ahead of its workers", () => {
        const agents = [agent({ id: "lead", state: "working" }), agent({ id: "w1", state: "working" })];
        expect(runLiveWorkers(owner(), agents, lineage).map((w) => w.id)).toEqual(["lead", "w1"]);
    });
    it("is the phase workers alone for a run with no DAG", () => {
        const r = run({ phases: [{ kind: "execute", state: "running", workerorefs: ["tab:a"] }] });
        const agents = [agent({ id: "a", state: "working" })];
        expect(runLiveWorkers(r, agents, { roles: {}, runs: {} }).map((w) => w.id)).toEqual(["a"]);
    });
});

describe("leadAsker", () => {
    it("is the run's own asking worker; a DAG worker's question goes to its lead first", () => {
        const r = run({ phases: [{ kind: "orchestrate", state: "running", workerorefs: ["tab:lead"] }] });
        expect(leadAsker(r, [agent({ id: "lead", state: "asking" }), agent({ id: "w1", state: "asking" })])?.id).toBe("lead");
        expect(leadAsker(r, [agent({ id: "lead", state: "working" }), agent({ id: "w1", state: "asking" })])).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run the tests; they must fail.** `npx vitest run frontend/app/view/agents/runmodel.test.ts`
  Expected: FAIL (`runLiveWorkers` / `leadAsker` are not exported).

- [ ] **Step 3: Implement them in `runmodel.ts`**, right after `liveWorkers`. Add
  `import type { Lineage } from "./runlineage";` at the top. Then rewrite `liveWorkers`' comment: it is now
  phase workers only, and it still sizes `cancelSurvivors`, because the per-worker Stop
  (`StopRunWorkerCommand`) accepts only workers the run owns (`jarvis.RunOwnsWorker`). Remove the line
  that says it gates the cancel confirmation.

```ts
// Every live worker a cancel would stop: the run's own phase workers and, on an engine run, the workers of its
// DAG tasks. Those are child runs, which the phases never list, and a lead is idle between wakes, so a
// phase-only count read 0 mid-run and Cancel stopped everything without asking. Gates the cancel
// confirmation and sizes its copy.
export function runLiveWorkers(run: Run, agents: AgentVM[], lineage: Lineage): AgentVM[] {
    const out = liveWorkers(run, agents);
    for (const a of agents) {
        const role = lineage.roles[a.id];
        if (role?.kind === "worker" && role.leadRunId === run.id && a.state !== "idle" && !out.some((o) => o.id === a.id)) {
            out.push(a);
        }
    }
    return out;
}

// The run's own worker waiting on the human: the lead, or a quick run's one worker. A DAG task's question
// goes to the lead first (the child-ask card), never through the run's own ask card.
export function leadAsker(run: Run, agents: AgentVM[]): AgentVM | undefined {
    return liveWorkers(run, agents).find((w) => w.state === "asking");
}
```

- [ ] **Step 4: Run the runmodel tests; they must pass.** `npx vitest run frontend/app/view/agents/runmodel.test.ts`

- [ ] **Step 5: Wire Cancel to `runLiveWorkers`.** In `runcards.tsx`, give `CancelRunButton` a
  `model: AgentsViewModel` prop (the type is already imported for `CancelSurvivorsCard`), read
  `const lineage = useAtomValue(model.lineageAtom);`, and call
  `confirmCancelRun(channelId, run.id, runLiveWorkers(run, agents, lineage).length)`. Pass `model` at every
  call site: `runcards.tsx` (`BlockedCard`), the two in `runbody.tsx`, and the one in `runsheet.tsx`, using
  that component's own `model` or `ctx.model`. Find them with
  `grep -rn "<CancelRunButton" frontend`. Drop `liveWorkers` from `runcards.tsx`'s import if it is now unused.

- [ ] **Step 6: Point both askers at the live run.** In `runsheet.tsx` `RunSheetFrame`, replace
  `liveWorkers(run, agents).find((w) => w.state === "asking")` with `leadAsker(run, agents)`, and fix the
  `runmodel` import. In `briefsheet.tsx`, keep the bindings where they are, because `BriefSheet` also serves
  legacy runs through `RunBody`, but make them read the live run object the card reads:

```tsx
// module level, beside the other constants
const NO_RUN = atom<Run | null>(null);

// in BriefSheet, replacing the askAgentRef.current line:
// the keys read the live run object, as the question card does: the channel list's copy is a snapshot a
// run: update never refreshes, so a worker recorded after it was taken would be invisible to the keys
const liveRun = useAtomValue(run != null ? runAtom(run.id) : NO_RUN) ?? run;
askAgentRef.current = liveRun != null ? leadAsker(liveRun, agents) : undefined;
```

  Import `runAtom` from `@/app/view/agents/channelsstore` (the file already imports from it), `atom` from
  `jotai`, and `leadAsker` from `@/app/view/agents/runmodel`. Drop `liveWorkers` from the imports if it is
  unused.

- [ ] **Step 7: Write the failing task-row tests.** Append to the `describe("taskRow")` block in
  `frontend/app/view/jarvis/runsheetmodel.test.ts`:

```ts
    // the engine reaps the lane's worker before Verify starts, so a verifying task has no session by design
    it("reads a verifying task as running Verify once its worker is reaped", () => {
        const r = taskRow(rowInput({ state: "verifying", runid: "8a41ffff" }, { worker: { state: "unavailable", runId: "8a41ffff" } }));
        expect(r).toMatchObject({ meta: "running Verify", state: "verifying", stateTone: "success", action: "open-dag-task" });
    });

    it("reads a question the lead holds as asked the lead", () => {
        const td: DagTaskDigest = { taskid: "t-1", waitreason: "lead-ask", askts: NOW - 40_000, mergestate: "", cleanupstate: "" };
        expect(taskRow(rowInput({}, { td, askOwner: null })).meta).toBe("asked the lead · idle 40s");
    });
```

  Run `npx vitest run frontend/app/view/jarvis/runsheetmodel.test.ts`. Expected: both new tests FAIL.

- [ ] **Step 8: Fix `liveTaskRow`** in `runsheetmodel.ts`. The ask branch:

```ts
    if (td?.waitreason === "ask" || td?.waitreason === "lead-ask") {
        const age = td.askts ? ` · idle ${since(input.nowMs, td.askts)}` : "";
        // the digest says lead-ask for a question the lead holds; askOwner comes from the asks list, which can lag it
        const lead = td.waitreason === "lead-ask" || input.askOwner === "lead";
        return {
            ...base,
            meta: lead ? `asked the lead${age}` : `asked you${age}`,
            metaTone: "warning",
            state: "asking",
            stateTone: "warning",
            action: workerAction,
        };
    }
```

  In `case "running": case "verifying":`, add this between the `if (dispatched)` block and the
  `if (task.runid)` block:

```ts
            // Verify runs in the project checkout after the engine reaped the lane's worker: no session is expected
            if (task.state === "verifying") {
                return {
                    ...base,
                    meta: "running Verify",
                    metaTone: "success-soft",
                    state: "verifying",
                    stateTone: "success",
                    action: "open-dag-task",
                };
            }
```

- [ ] **Step 9: Run the tests and the typecheck.**
  `npx vitest run frontend/app/view/jarvis/runsheetmodel.test.ts frontend/app/view/agents/runmodel.test.ts`
  (PASS), then `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (exit 0).

- [ ] **Step 10: Commit.** `git add` the files above, then
  `git commit -m "fix(runs): count an engine run's DAG workers for Cancel, read asks from the live run, label Verify and lead-held rows"`.

- [ ] **Step 11: Run the full Verify** (the command in the rules). It must pass.

- [ ] **Step 12: Close the chunks.** Run each command below, with a note naming what changed, the files and
  the tests that prove it:

```
wsh effort chunk status 5d11f853-41e2-44d4-8aa4-bf92cee88dca "liveWorkers ignores DAG child runs (Cancel confirm, 1-9 answers, 0-workers row)" done --note "<runLiveWorkers counts DAG workers for Cancel; leadAsker; Brief keys read the live run; files; tests. Needs a live check: Cancel run mid engine run opens its confirm; pressing 1 answers a lead's question on the Brief (cause unconfirmed). The 0-workers lead row is fixed by the missing-worker and reload chunks, not here.>"
wsh effort chunk status 5d11f853-41e2-44d4-8aa4-bf92cee88dca "Verify has no task row or output once the lane worker is reaped" done --note "<…; streaming Verify output stays out of scope>"
wsh effort chunk status 5d11f853-41e2-44d4-8aa4-bf92cee88dca "Lead-held question mislabelled on the task row" done --note "<…>"
```

- [ ] **Step 13: Complete.** `wsh jarvis complete --commit $(git rev-parse HEAD)`

---

### Task 2: Worker tabs reach the app, and leads are named after their run
**Depends on:** none

This task closes two chunks of effort `5d11f853-41e2-44d4-8aa4-bf92cee88dca`:
- `Engine-dispatched workers missing from the Agent tree`
- `Plan run's first lead is named after its first wake`

**Rules for this task** (you see only this task, so everything you need is here):
- Stay inside the files listed below. Never edit anything under `docs/`.
- Typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (about 2 minutes; it must exit 0). Never use `npx tsc` or `task check:ts`; both break in this repo.
- Frontend tests: `npx vitest run <file>`. Go tests (Git Bash): `CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/<package>/...`.
- Frontend logic goes in a pure `.ts` module with a `.test.ts` beside it. No jsdom, render or snapshot tests. Colors come from `@theme` token classes only, never raw hex or rgba.
- If you change any wshrpc, waveobj or wconfig type, run `task generate` and never hand-edit its outputs. `RunWorkerOptions` is a plain jarvis struct, so this task needs none.
- Check formatting only on the files you touched (`gofmt -l <file>`). Never `--write` the tree.
- Commit with a conventional message and no trailers (no `Co-Authored-By`).
- Before completing, run the full Verify: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && npx vitest run && CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/...`
- The last steps, in order: close each chunk above with `wsh effort chunk status`, then `wsh jarvis complete --commit $(git rev-parse HEAD)`.

**Files:**
- Modify: `pkg/jarvis/runexec.go` (`SpawnRunWorker`, `RunWorkerOptions`, `EnsureWorkers`)
- Test: `pkg/jarvis/runexec_test.go`. The package's `TestMain` (`maintest_test.go`) gives the tests a real wstore DB.

**What is wrong (verified in code):**
- `SpawnRunWorker` creates the worker's tab with `wcore.CreateTab`, which queues the workspace update only on
  a ctx that collects updates (`waveobj.ContextWithUpdates`). Someone then has to broadcast it
  (`wps.Broker.SendUpdateEvents`). The run-start path, `spawnRunWorkersWithPrompt`
  (`pkg/wshrpc/wshserver/wshserver_runs.go`), does both. The engine's dispatch (`spawnWorker` in
  `pkg/orchestrate/engine.go`) calls `SpawnRunWorker` with neither. The app's workspace copy never gains the
  tab, and the Agent tree builds rows only from that copy. Fix it where the tab is made: `SpawnRunWorker`
  already publishes the worker's first `agent:status` so the roster sees it, and making its tab visible is
  the same job.
- A lead's row label is the tab's custom label (`session:label` tab meta), else Claude Code's ai-title, which
  it derives from the first prompt. For a plan run that first prompt is the first wake ("Merge conflict in …").
  Every lead is spawned through `EnsureWorkers`, which knows the run.

- [ ] **Step 1: Write the failing tests** in `pkg/jarvis/runexec_test.go`. Add imports as needed
  (`strings`, `github.com/google/uuid`, `github.com/wavetermdev/waveterm/pkg/wstore`).

```go
// stubWorkerSpawn swaps the spawn's side effects: the tab is a real row inserted through the spawn's own ctx
// (so its update lands in whatever collector that ctx carries), the controller never starts, and broadcasts
// are recorded instead of sent.
func stubWorkerSpawn(t *testing.T) *[]waveobj.UpdatesRtnType {
	t.Helper()
	oldCreate, oldSend, oldPersist, oldStart := createWorkerTab, sendWorkerTabUpdates, persistWorkerBlockMeta, startWorkerController
	t.Cleanup(func() {
		createWorkerTab, sendWorkerTabUpdates, persistWorkerBlockMeta, startWorkerController = oldCreate, oldSend, oldPersist, oldStart
	})
	createWorkerTab = func(ctx context.Context, _ string, name string, _ bool, _ bool) (string, error) {
		tab := &waveobj.Tab{OID: uuid.NewString(), Name: name, BlockIds: []string{uuid.NewString()}, Meta: waveobj.MetaMapType{}}
		return tab.OID, wstore.DBInsert(ctx, tab)
	}
	persistWorkerBlockMeta = func(context.Context, string, waveobj.MetaMapType) error { return nil }
	startWorkerController = func(context.Context, string, string) error { return nil }
	var sent []waveobj.UpdatesRtnType
	sendWorkerTabUpdates = func(u waveobj.UpdatesRtnType) { sent = append(sent, u) }
	return &sent
}

func piCap(t *testing.T) runroute.Capability {
	t.Helper()
	cap, err := runroute.Resolve(waveobj.RoutePin{Runtime: "pi"})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	return cap
}

// the engine's dispatch passes a ctx that collects nothing; the tab must still reach the app
func TestSpawnRunWorkerBroadcastsItsTab(t *testing.T) {
	sent := stubWorkerSpawn(t)
	oref, err := SpawnRunWorker(context.Background(), piCap(t), "ws-1", "proj", "", "do it", RunWorkerOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(*sent) != 1 {
		t.Fatalf("want one broadcast, got %d", len(*sent))
	}
	tabID := strings.TrimPrefix(oref, "tab:")
	for _, u := range (*sent)[0] {
		if u.OType == waveobj.OType_Tab && u.OID == tabID {
			return
		}
	}
	t.Fatalf("broadcast has no update for tab %s: %+v", tabID, (*sent)[0])
}

// spawnRunWorkersWithPrompt collects and flushes its own updates; the spawn must not flush them early
func TestSpawnRunWorkerLeavesACollectingCallerToFlush(t *testing.T) {
	sent := stubWorkerSpawn(t)
	ctx := waveobj.ContextWithUpdates(context.Background())
	oref, err := SpawnRunWorker(ctx, piCap(t), "ws-1", "proj", "", "do it", RunWorkerOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(*sent) != 0 {
		t.Fatalf("a collecting caller flushes its own updates, got %d broadcasts", len(*sent))
	}
	if waveobj.ContextGetUpdate(ctx, waveobj.ORef{OType: waveobj.OType_Tab, OID: strings.TrimPrefix(oref, "tab:")}) == nil {
		t.Fatal("the tab's update must be left in the caller's collector")
	}
}

func TestSpawnRunWorkerLabelsTheTab(t *testing.T) {
	stubWorkerSpawn(t)
	ctx := context.Background()
	oref, err := SpawnRunWorker(ctx, piCap(t), "ws-1", "proj", "", "do it", RunWorkerOptions{Label: "Ship the auth rework"})
	if err != nil {
		t.Fatal(err)
	}
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, strings.TrimPrefix(oref, "tab:"))
	if err != nil {
		t.Fatal(err)
	}
	if got := tab.Meta["session:label"]; got != "Ship the auth rework" {
		t.Fatalf("session:label = %v, want the run title", got)
	}
}

// a lead is named after its run: otherwise its label is the ai-title of its first prompt, a wake on a plan run
func TestEnsureWorkersLabelsOnlyALeadWithItsRunTitle(t *testing.T) {
	old := SpawnRunWorker
	defer func() { SpawnRunWorker = old }()
	var got []RunWorkerOptions
	SpawnRunWorker = func(_ context.Context, _ runroute.Capability, _, _, _, _ string, opts RunWorkerOptions) (string, error) {
		got = append(got, opts)
		return "tab:worker", nil
	}
	lead := NewRun("Ship the auth rework\nwith the details below", "ws", "/p", nil, RunMode_Orchestrator, DefaultOrchestratorPlaybook(), 1)
	if _, err := EnsureWorkers(context.Background(), &lead, piCap(t), "project", ""); err != nil {
		t.Fatal(err)
	}
	quick := NewRun("fix a typo", "ws", "/p", nil, RunMode_Quick, QuickPlaybook(), 1)
	if _, err := EnsureWorkers(context.Background(), &quick, piCap(t), "project", ""); err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Label != "Ship the auth rework" || got[1].Label != "" {
		t.Fatalf("labels = %+v", got)
	}
}
```

- [ ] **Step 2: Run them; they must fail to compile.**
  `CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/jarvis/ -run 'SpawnRunWorker|EnsureWorkersLabels'`
  Expected: FAIL (`createWorkerTab`, `sendWorkerTabUpdates` and `Label` are undefined).

- [ ] **Step 3: Implement in `runexec.go`.** Add a `Label` field to `RunWorkerOptions`:

```go
	// Label, when set, is the tab's session:label: the name every surface shows ahead of the agent's ai-title.
	Label string
```

  Add the seams beside `persistWorkerBlockMeta`, importing `github.com/wavetermdev/waveterm/pkg/wps` if it
  is not already imported:

```go
// createWorkerTab is the tab-creation seam, so tests make a tab without a layout or a live workspace.
var createWorkerTab = wcore.CreateTab

// sendWorkerTabUpdates broadcasts the object updates a spawn collected. A var so tests can record them.
var sendWorkerTabUpdates = func(updates waveobj.UpdatesRtnType) { wps.Broker.SendUpdateEvents(updates) }
```

  In `SpawnRunWorker`, just before the `wcore.CreateTab` call, which becomes `createWorkerTab(...)`:

```go
	// the new tab reaches the app only as a broadcast workspace update. A caller that collects updates
	// (spawnRunWorkersWithPrompt) flushes them itself; the engine's dispatch collects nothing, so the spawn
	// does, even when it fails part-way, because the tab may already exist.
	if waveobj.ContextGetUpdates(ctx) == nil {
		ctx = waveobj.ContextWithUpdates(ctx)
		defer func() { sendWorkerTabUpdates(waveobj.ContextGetUpdatesRtn(ctx)) }()
	}
```

  After `tabMeta` is built:

```go
	if opts.Label != "" {
		tabMeta["session:label"] = opts.Label
	}
```

  In `EnsureWorkers`, set the label for an orchestrator run's worker, which is its lead:

```go
		opts := RunWorkerOptions{KeepOnExit: run.Mode == RunMode_Orchestrator, SessionId: uuid.NewString()}
		if run.Mode == RunMode_Orchestrator {
			// named after its run: its ai-title would come from its first prompt, which on a plan run is a wake
			opts.Label = strings.TrimSpace(strings.SplitN(run.Goal, "\n", 2)[0])
		}
```

  Update `SpawnRunWorker`'s doc comment: it broadcasts its tab's workspace update when the caller collects
  none.

- [ ] **Step 4: Run the package tests; they must pass.**
  `CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/jarvis/` (PASS). Also run
  `go test ./pkg/wshrpc/wshserver/ ./pkg/orchestrate/` with the same `CGO_CFLAGS`: both call this code.

- [ ] **Step 5: Commit.** `git add pkg/jarvis/runexec.go pkg/jarvis/runexec_test.go`, then
  `git commit -m "fix(jarvis): broadcast a spawned worker's tab and name a lead after its run"`.

- [ ] **Step 6: Run the full Verify** (the command in the rules). It must pass.

- [ ] **Step 7: Close the chunks**, each with a note naming what changed, the files and the tests:

```
wsh effort chunk status 5d11f853-41e2-44d4-8aa4-bf92cee88dca "Engine-dispatched workers missing from the Agent tree" done --note "<SpawnRunWorker collects and broadcasts its tab's updates when the caller collects none; files; tests. Needs a live check: an engine-dispatched worker appears in the Agent tree without a reload.>"
wsh effort chunk status 5d11f853-41e2-44d4-8aa4-bf92cee88dca "Plan run's first lead is named after its first wake" done --note "<EnsureWorkers labels a lead tab with its run title (session:label); files; tests. Needs a live check: a new plan run's lead row reads the plan title.>"
```

- [ ] **Step 8: Complete.** `wsh jarvis complete --commit $(git rev-parse HEAD)`

---

### Task 3: Engine: a conflict holds other merges, the closed lead tab is broadcast, the next-step label is right
**Depends on:** none

This task closes three chunks of effort `5d11f853-41e2-44d4-8aa4-bf92cee88dca`:
- `Landed-commit credit after a resolved conflict can name another lane`
- `Closed lead tab stays in the app as a frozen working row`
- `parallelism-wait shown when slots are free`

**Rules for this task** (you see only this task, so everything you need is here):
- Stay inside the files listed below. Never edit anything under `docs/`.
- Typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (about 2 minutes; it must exit 0). Never use `npx tsc` or `task check:ts`; both break in this repo.
- Frontend tests: `npx vitest run <file>`. Go tests (Git Bash): `CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/<package>/...`.
- Frontend logic goes in a pure `.ts` module with a `.test.ts` beside it. No jsdom, render or snapshot tests. Colors come from `@theme` token classes only, never raw hex or rgba.
- If you change any wshrpc, waveobj or wconfig type, run `task generate` and never hand-edit its outputs. This task needs none.
- Check formatting only on the files you touched (`gofmt -l <file>`). Never `--write` the tree.
- Commit with a conventional message and no trailers (no `Co-Authored-By`).
- Before completing, run the full Verify: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && npx vitest run && CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/...`
- The last steps, in order: close each chunk above with `wsh effort chunk status`, then `wsh jarvis complete --commit $(git rev-parse HEAD)`.

**Files:**
- Modify: `pkg/orchestrate/mergetask.go` (`mergeTaskLocked`), test: `pkg/orchestrate/mergetask_test.go`
- Modify: `pkg/orchestrate/leadclose.go` (`deleteLeadTab`), test: create `pkg/orchestrate/leadclose_test.go`
- Modify: `pkg/orchestrate/digest.go` (`buildNext`), test: `pkg/orchestrate/digest_test.go`

**What is wrong (verified in code):**
- **Merge credit.** A conflicted squash merge leaves the project tree mid-merge, and `IndexClean` holds the
  automatic path while it stays that way. The lead then commits the resolution, the index is clean, and
  `AutoMergeReady` lands another lane. The lead's `dag merge <task> --continue` finds nothing to commit and
  credits `HEAD` (`finishMerge` with `resolved`), which is now the other lane's squash commit. The decision is
  to prevent this, not detect it: a conflict awaiting `--continue` owns the project, and every other merge,
  automatic or explicit, waits for it.
- **Lead tab.** `deleteLeadTab` calls `wcore.DeleteTab` on a ctx that collects no updates, and broadcasts
  nothing. The app keeps the dead lead as a frozen "working" row until a reload.
- **Next step.** In `buildNext`, step 4 returns `parallelism-wait` whenever any task is busy and nothing can
  dispatch, even with free slots. A serial tail then reads "waiting for a slot" with 1 running and 2 slots
  empty. `TestNextParallelismWaitBeatsDependency` asserts exactly this bug.

- [ ] **Step 1: Write the failing merge test** in `pkg/orchestrate/mergetask_test.go`. It uses the file's
  `newMergeFixture`, `finish`, `dag` and `stubMerge`; add `errors` to the imports.

```go
// a lane landing between the resolver's fix commit and its --continue becomes the HEAD --continue credits,
// so a conflict awaiting --continue holds every other merge, automatic or explicit
func TestConflictAwaitingContinueHoldsOtherMerges(t *testing.T) {
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-0", Label: "conflicts"}, {ID: "t-1", Label: "clean"}})
	f.finish(t, "t-0")
	childOfT1 := f.finish(t, "t-1")
	conflictKey := LaneWorktreeKey(f.dag(t), "t-0")
	var cleanMerges int
	stubMerge(t, func(_ context.Context, _, runID, _ string) (string, error) {
		if runID == conflictKey {
			return "", ErrMergeConflict
		}
		cleanMerges++
		return "sha-t1", nil
	})
	oldContinue := continueMerge
	continueMerge = func(context.Context, string, string, string, []string) (string, error) { return "sha-fix", nil }
	t.Cleanup(func() { continueMerge = oldContinue })

	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	if got := taskByID(f.dag(t), "t-0").State; got != TaskState_BlockedMerge {
		t.Fatalf("t-0 = %s, want blocked-merge", got)
	}
	if cleanMerges != 0 {
		t.Fatalf("t-1 must wait for t-0's --continue, merged %d times", cleanMerges)
	}
	err := MergeTask(f.ctx, f.channel, f.ownerID, "t-1")
	if !errors.Is(err, errProjectBusy) || !strings.Contains(err.Error(), "t-0") {
		t.Fatalf("an explicit merge must be refused naming t-0, got %v", err)
	}

	if err := ContinueMerge(f.ctx, f.channel, f.ownerID, "t-0"); err != nil {
		t.Fatal(err)
	}
	t0Child, err := wstore.GetRun(f.ctx, f.channel, taskByID(f.dag(t), "t-0").RunID)
	if err != nil {
		t.Fatal(err)
	}
	if t0Child.EndCommit != "sha-fix" {
		t.Fatalf("t-0 credited %q, want the resolver's commit", t0Child.EndCommit)
	}
	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	if !taskByID(f.dag(t), "t-1").Merged {
		t.Fatal("t-1 must land once t-0 is continued")
	}
	if c, _ := wstore.GetRun(f.ctx, f.channel, childOfT1); c.EndCommit != "sha-t1" {
		t.Fatalf("t-1 credited %q, want its own commit", c.EndCommit)
	}
}
```

  Run `CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/orchestrate/ -run TestConflictAwaitingContinueHoldsOtherMerges`.
  Expected: FAIL (t-1 merges while t-0 is blocked). If the fixture needs more to reach `ContinueMerge`, such as
  a worktree to clean up, follow `continue_test.go`, which drives the same path.

- [ ] **Step 2: Implement the hold in `mergetask.go`.** Add the helper:

```go
// conflictAwaitingContinue names a task other than except whose squash merge conflicted and has not been
// continued: blocked-merge with no MergeError. A refused merge records one, and its squash never touched
// the tree. Such a task owns the project: its resolver commits the fix and then continues, and a lane
// landing in between would be the HEAD that --continue credits.
func conflictAwaitingContinue(g *waveobj.TaskGroup, except string) string {
	for i := range g.Tasks {
		t := &g.Tasks[i]
		if t.ID != except && t.State == TaskState_BlockedMerge && t.MergeError == "" {
			return t.ID
		}
	}
	return ""
}
```

  In `mergeTaskLocked`, right after the `if task.RunID == ""` check and before `if requireCleanIndex`:

```go
	if held := conflictAwaitingContinue(g, task.ID); held != "" {
		return "", fmt.Errorf("%w: task %s's merge conflict is waiting for `wsh jarvis dag merge %s --continue`", errProjectBusy, held, held)
	}
```

  `AutoMergeReady` already stops on `errProjectBusy`. Run the test again. Expected: PASS.

- [ ] **Step 3: Write the failing lead-tab tests** in a new `pkg/orchestrate/leadclose_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"errors"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// stubLeadTabDelete makes DeleteTab queue the workspace and tab updates it would, then return err.
func stubLeadTabDelete(t *testing.T, err error) *[]waveobj.UpdatesRtnType {
	t.Helper()
	oldDelete, oldSend := deleteTab, sendLeadTabUpdates
	t.Cleanup(func() { deleteTab, sendLeadTabUpdates = oldDelete, oldSend })
	deleteTab = func(ctx context.Context, workspaceId, tabId string, _ bool) (string, error) {
		waveobj.ContextAddUpdate(ctx, waveobj.WaveObjUpdate{UpdateType: waveobj.UpdateType_Update, OType: waveobj.OType_Workspace, OID: workspaceId})
		waveobj.ContextAddUpdate(ctx, waveobj.WaveObjUpdate{UpdateType: waveobj.UpdateType_Delete, OType: waveobj.OType_Tab, OID: tabId})
		return "", err
	}
	var sent []waveobj.UpdatesRtnType
	sendLeadTabUpdates = func(u waveobj.UpdatesRtnType) { sent = append(sent, u) }
	return &sent
}

// the app drops a tab only on a broadcast workspace update; without one the closed lead stays a frozen row
func TestDeleteLeadTabBroadcastsTheWorkspaceChange(t *testing.T) {
	sent := stubLeadTabDelete(t, nil)
	if err := deleteLeadTab(context.Background(), "ws-1", "lead-tab"); err != nil {
		t.Fatal(err)
	}
	if len(*sent) != 1 || len((*sent)[0]) != 2 {
		t.Fatalf("want one broadcast of the workspace and tab updates, got %+v", *sent)
	}
}

// a DeleteTab that fails part-way may already have closed the blocks, so what it did is still broadcast
func TestDeleteLeadTabBroadcastsAfterAFailure(t *testing.T) {
	sent := stubLeadTabDelete(t, errors.New("boom"))
	if err := deleteLeadTab(context.Background(), "ws-1", "lead-tab"); err == nil {
		t.Fatal("the delete error must be returned")
	}
	if len(*sent) != 1 {
		t.Fatalf("want the partial updates broadcast, got %d broadcasts", len(*sent))
	}
}
```

  Run them. Expected: FAIL to compile (`deleteTab` and `sendLeadTabUpdates` are undefined).

- [ ] **Step 4: Implement in `leadclose.go`**, replacing the `deleteLeadTab` default and adding
  `github.com/wavetermdev/waveterm/pkg/wps` to the imports. `engine_test.go` stubs `deleteLeadTab` as a
  whole, so keep that name and signature.

```go
// deleteTab and sendLeadTabUpdates are deleteLeadTab's side effects, seams so a test needs no live workspace.
var deleteTab = wcore.DeleteTab
var sendLeadTabUpdates = func(updates waveobj.UpdatesRtnType) { wps.Broker.SendUpdateEvents(updates) }

// deleteLeadTab is the tab-deletion seam. Var so tests can stub it without a live workspace. The app drops the
// tab only on a broadcast workspace update, so the updates DeleteTab queues are collected and sent, including
// after a failure part-way, because the blocks it already closed are gone.
var deleteLeadTab = func(ctx context.Context, workspaceId, tabId string) error {
	if waveobj.ContextGetUpdates(ctx) == nil {
		ctx = waveobj.ContextWithUpdates(ctx)
		defer func() { sendLeadTabUpdates(waveobj.ContextGetUpdatesRtn(ctx)) }()
	}
	_, err := deleteTab(ctx, workspaceId, tabId, true)
	return err
}
```

  Run the two tests and `-run Lead` over the package. Expected: PASS.

- [ ] **Step 5: Write the failing next-step tests** in `pkg/orchestrate/digest_test.go`. Replace
  `TestNextParallelismWaitBeatsDependency` (it asserts the bug) with:

```go
// with a slot free, a pending task waits on its dependency, not on the parallelism limit
func TestNextDependencyWaitWhenASlotIsFree(t *testing.T) {
	g := digestGroup(t, false, chainTasks()) // parallelism 2
	setTaskStates(g, map[string]string{"t-0": TaskState_Running})
	d := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow))
	if d.Next.Kind != "dependency-wait" {
		t.Fatalf("1 of 2 slots busy with dependency holds must be dependency-wait, got %q", d.Next.Kind)
	}
	if !sameStrings(d.Next.TaskIds, []string{"t-1", "t-2"}) || !sameStrings(d.Next.BlockingTaskIds, []string{"t-0", "t-1"}) {
		t.Fatalf("dependency wait must name the waiting tasks and their blockers, got %+v", d.Next)
	}
}

// every slot busy: the parallelism limit is what holds the rest, whatever else they wait on
func TestNextParallelismWaitWhenEverySlotIsBusy(t *testing.T) {
	g := digestGroup(t, false, []waveobj.TaskNode{
		{ID: "t-0", Label: "a"},
		{ID: "t-1", Label: "b"},
		{ID: "t-2", Label: "c", Deps: []string{"t-0"}},
	})
	setTaskStates(g, map[string]string{"t-0": TaskState_Running, "t-1": TaskState_Running})
	d := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow))
	if d.Next.Kind != "parallelism-wait" || !sameStrings(d.Next.BlockingTaskIds, []string{"t-0", "t-1"}) {
		t.Fatalf("2 of 2 slots busy must be parallelism-wait on both, got %+v", d.Next)
	}
}
```

  Run `go test ./pkg/orchestrate/ -run TestNext` with the `CGO_CFLAGS` above. Expected: the free-slot test FAILS.

- [ ] **Step 6: Fix `buildNext` step 4** in `digest.go`:

```go
	// 4. parallelism wait: every slot is busy, so the engine's next move waits on one of them. With a slot
	// free, what holds pending work is its dependencies, which step 5 would name, so say that here.
	if busy := busyTaskIDs(g); len(busy) > 0 {
		if len(busy) < g.Parallelism {
			if depWait, blocking := dependencyWait(g); len(depWait) > 0 {
				return wshrpc.DagNextStep{Kind: "dependency-wait", TaskIds: depWait, BlockingTaskIds: blocking}
			}
		}
		return wshrpc.DagNextStep{Kind: "parallelism-wait", BlockingTaskIds: busy}
	}
```

  Run `go test ./pkg/orchestrate/` with the `CGO_CFLAGS` above. Any other test that now fails because it
  asserted `parallelism-wait` with a slot free encodes the same bug. Update only those, and name them in the
  chunk note. `grep -n "parallelism-wait" pkg/orchestrate/*_test.go` lists the candidates.

- [ ] **Step 7: Commit.** `git add` the six files above, then
  `git commit -m "fix(orchestrate): hold merges for a conflict's --continue, broadcast the closed lead tab, report dependency waits with free slots"`.

- [ ] **Step 8: Run the full Verify** (the command in the rules). It must pass.

- [ ] **Step 9: Close the chunks**, each with a note naming what changed, the files and the tests:

```
wsh effort chunk status 5d11f853-41e2-44d4-8aa4-bf92cee88dca "Landed-commit credit after a resolved conflict can name another lane" done --note "<a conflict awaiting --continue holds every other merge (errProjectBusy); files; TestConflictAwaitingContinueHoldsOtherMerges>"
wsh effort chunk status 5d11f853-41e2-44d4-8aa4-bf92cee88dca "Closed lead tab stays in the app as a frozen working row" done --note "<deleteLeadTab collects and broadcasts DeleteTab's updates; files; tests. Needs a live check: a completed run's lead row leaves the Agent tree and Sessions.>"
wsh effort chunk status 5d11f853-41e2-44d4-8aa4-bf92cee88dca "parallelism-wait shown when slots are free" done --note "<…>"
```

- [ ] **Step 10: Complete.** `wsh jarvis complete --commit $(git rev-parse HEAD)`

---

### Task 4: Sealed evidence records the DAG's Verify, and the Brief names what blocks a DAG
**Depends on:** none

This task closes two chunks of effort `5d11f853-41e2-44d4-8aa4-bf92cee88dca`:
- `Sealed evidence says verification none recorded after Verify passed`
- `Blocked merge reads as a failure on the Brief`

**Rules for this task** (you see only this task, so everything you need is here):
- Stay inside the files listed below. Never edit anything under `docs/`.
- Typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (about 2 minutes; it must exit 0). Never use `npx tsc` or `task check:ts`; both break in this repo.
- Frontend tests: `npx vitest run <file>`. Go tests (Git Bash): `CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/<package>/...`.
- Frontend logic goes in a pure `.ts` module with a `.test.ts` beside it. No jsdom, render or snapshot tests. Colors come from `@theme` token classes only, never raw hex or rgba.
- If you change any wshrpc, waveobj or wconfig type, run `task generate` and never hand-edit its outputs. This task needs none (`EvidenceVerif` already exists).
- Check formatting only on the files you touched (`gofmt -l <file>`). Never `--write` the tree.
- Commit with a conventional message and no trailers (no `Co-Authored-By`).
- Before completing, run the full Verify: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && npx vitest run && CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/...`
- The last steps, in order: close each chunk above with `wsh effort chunk status`, then `wsh jarvis complete --commit $(git rev-parse HEAD)`.

**Files:**
- Modify: `pkg/jarvis/evidence.go` (`SealEvidence`), test: `pkg/jarvis/evidence_test.go`. The package's `TestMain` gives tests a real wstore DB.
- Modify: `pkg/jarvis/attention.go` (the `case "blocked":` in `BuildAttention`), test: `pkg/jarvis/attention_dag_test.go`

**What is wrong (verified in code):**
- `SealEvidence` fills `Verifs` only from worker transcripts. The engine runs the plan's Verify itself, after
  each squash merge (`pkg/orchestrate/verify.go`). It records each result only as a `task-verify-passed` or
  `task-verify-failed` run event on the owner run, with detail `{"taskid", "reason"?, "detail"?}`. So a run
  whose Verify passed after every merge seals "verification: none recorded". Decision: record **one entry per
  task, carrying its newest result**, so a timed-out Verify whose re-run passed reads as passed. Child runs
  carry their owner's `DagORef` too, but they are sealed before their Verify runs, so only the dag's owner
  (`dag.RunID == run.ID`) gets these entries.
- `BuildAttention`'s `blocked` case always prints "`N` consecutive failures — decide retry/skip." A dag is
  also blocked by a `blocked-merge` or a `verify-failed` task (`RecomputeDagStatus`), and the row then reads
  "0 consecutive failures". `jarvis` cannot import `orchestrate`, so compare task states as the engine's
  strings (`"blocked-merge"`, `"verify-failed"`, `"failed"`), as this file already does.

- [ ] **Step 1: Write the failing evidence tests** in `pkg/jarvis/evidence_test.go`. Add `github.com/google/uuid`
  and `github.com/wavetermdev/waveterm/pkg/wstore` to the imports if needed.

```go
func appendVerifyEvent(t *testing.T, channelID, runID, kind string, detail map[string]any) {
	t.Helper()
	if _, err := wstore.AppendRunEvent(context.Background(), channelID, runID, kind, nil, detail); err != nil {
		t.Fatal(err)
	}
}

// the engine runs Verify, not a worker, so its results live only in the owner run's events
func TestSealEvidenceRecordsTheDagsVerify(t *testing.T) {
	ctx := context.Background()
	runID, channelID := uuid.NewString(), uuid.NewString()
	g := &waveobj.TaskGroup{OID: uuid.NewString(), RunID: runID, ChannelId: channelID, Verify: "go test ./...",
		Tasks: []waveobj.TaskNode{{ID: "t-1", State: "done"}, {ID: "t-2", State: "verify-failed"}, {ID: "t-3", State: "done"}}}
	g.ID = g.OID
	if err := wstore.AppendDag(ctx, g); err != nil {
		t.Fatal(err)
	}
	// t-1 timed out and its re-run passed; t-2 failed; t-3 never ran Verify
	appendVerifyEvent(t, channelID, runID, waveobj.RunEventKindTaskVerifyFailed, map[string]any{"taskid": "t-1", "reason": "timeout"})
	appendVerifyEvent(t, channelID, runID, waveobj.RunEventKindTaskVerifyPassed, map[string]any{"taskid": "t-1"})
	appendVerifyEvent(t, channelID, runID, waveobj.RunEventKindTaskVerifyFailed, map[string]any{"taskid": "t-2", "reason": "exit 1"})
	run := &waveobj.Run{ID: runID, OID: runID, ChannelOID: channelID, DagORef: g.OID, Status: RunStatus_Done, ProjectPath: t.TempDir(), CreatedTs: 1000}
	if err := SealEvidence(ctx, run); err != nil {
		t.Fatal(err)
	}
	want := []waveobj.EvidenceVerif{
		{Cmd: "go test ./...", Result: "pass", Detail: "after t-1"},
		{Cmd: "go test ./...", Result: "fail", Detail: "after t-2: exit 1"},
	}
	if !reflect.DeepEqual(run.Evidence.Verifs, want) {
		t.Fatalf("verifs = %+v, want %+v", run.Evidence.Verifs, want)
	}
}

// a child run shares its owner's dag but is sealed before its Verify runs; the dag's results are the owner's
func TestSealEvidenceGivesAChildRunNoDagVerify(t *testing.T) {
	ctx := context.Background()
	ownerID, childID, channelID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	g := &waveobj.TaskGroup{OID: uuid.NewString(), RunID: ownerID, ChannelId: channelID, Verify: "go test ./...",
		Tasks: []waveobj.TaskNode{{ID: "t-1", State: "done", RunID: childID}}}
	g.ID = g.OID
	if err := wstore.AppendDag(ctx, g); err != nil {
		t.Fatal(err)
	}
	appendVerifyEvent(t, channelID, ownerID, waveobj.RunEventKindTaskVerifyPassed, map[string]any{"taskid": "t-1"})
	child := &waveobj.Run{ID: childID, OID: childID, ChannelOID: channelID, DagORef: g.OID, Status: RunStatus_Done, ProjectPath: t.TempDir(), CreatedTs: 1000}
	if err := SealEvidence(ctx, child); err != nil {
		t.Fatal(err)
	}
	if len(child.Evidence.Verifs) != 0 {
		t.Fatalf("a child run must not carry its owner's Verify, got %+v", child.Evidence.Verifs)
	}
}
```

  Run `CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/jarvis/ -run SealEvidence`.
  Expected: the first test FAILS (`Verifs` is empty). If `AppendDag` insists on more fields, set them.

- [ ] **Step 2: Implement in `evidence.go`.** Add the helper, with `encoding/json` and `pkg/wstore` imported:

```go
// dagVerifs is the plan's Verify as the engine ran it, for a run that owns a dag: one entry per task it ran
// after, carrying that task's newest result (a timed-out Verify whose re-run passed reads as passed), in dag
// order. A child run shares its owner's DagORef but is sealed before its Verify runs, so it gets none. A
// read error fails the seal, so the backfill retries rather than freezing a snapshot missing its checks.
func dagVerifs(ctx context.Context, run *waveobj.Run) ([]waveobj.EvidenceVerif, error) {
	if run.DagORef == "" {
		return nil, nil
	}
	g, err := wstore.GetDag(ctx, run.DagORef)
	if err != nil {
		return nil, fmt.Errorf("evidence: loading dag %s: %w", run.DagORef, err)
	}
	if g.RunID != run.ID || g.Verify == "" {
		return nil, nil
	}
	kinds := []string{waveobj.RunEventKindTaskVerifyPassed, waveobj.RunEventKindTaskVerifyFailed}
	events, err := wstore.QueryRunEventsByKind(ctx, run.ChannelOID, run.ID, kinds, 0)
	if err != nil {
		return nil, fmt.Errorf("evidence: reading Verify results: %w", err)
	}
	type result struct {
		failed bool
		reason string
	}
	newest := map[string]result{}
	for _, ev := range events { // newest first
		var d struct {
			TaskId string `json:"taskid"`
			Reason string `json:"reason"`
		}
		if json.Unmarshal(ev.Detail, &d) != nil || d.TaskId == "" {
			continue
		}
		if _, seen := newest[d.TaskId]; !seen {
			newest[d.TaskId] = result{failed: ev.Kind == waveobj.RunEventKindTaskVerifyFailed, reason: d.Reason}
		}
	}
	var out []waveobj.EvidenceVerif
	for _, t := range g.Tasks {
		r, ok := newest[t.ID]
		if !ok {
			continue
		}
		v := waveobj.EvidenceVerif{Cmd: g.Verify, Result: "pass", Detail: "after " + t.ID}
		if r.failed {
			v.Result = "fail"
			if r.reason != "" {
				v.Detail += ": " + r.reason
			}
		}
		out = append(out, v)
	}
	return out, nil
}
```

  In `SealEvidence`, right after the transcript block that sets `verifs`:

```go
	dv, err := dagVerifs(ctx, run)
	if err != nil {
		return err
	}
	verifs = append(verifs, dv...)
```

  If an existing test seals a run with a `DagORef` that names no stored dag, check how `wstore.GetDag`
  reports not-found, and decide deliberately. Either make that test store its dag, or treat not-found as
  "no Verify recorded" and say so in a comment. Do not swallow other errors. Run the package tests. Expected:
  PASS.

- [ ] **Step 3: Write the failing attention tests** in `pkg/jarvis/attention_dag_test.go`:

```go
func blockedItem(t *testing.T, g *waveobj.TaskGroup) wshrpc.AttentionItem {
	t.Helper()
	for _, it := range BuildAttention(AttentionInput{Dags: []*waveobj.TaskGroup{g}}) {
		if it.Kind == AttentionDagBlocked {
			return it
		}
	}
	t.Fatalf("dag-blocked attention item missing")
	return wshrpc.AttentionItem{}
}

// a blocked merge is not a failure: the row must say what to resolve and how to continue
func TestBuildAttentionNamesABlockedMerge(t *testing.T) {
	g := dagWithStatus("blocked")
	g.Tasks = []waveobj.TaskNode{{ID: "t-0", Label: "a", State: "done"}, {ID: "t-3", Label: "store layer", State: "blocked-merge"}}
	it := blockedItem(t, g)
	if strings.Contains(it.Text, "consecutive failures") || !strings.Contains(it.Text, "store layer") || !strings.Contains(it.Text, "blocked") {
		t.Fatalf("text = %q", it.Text)
	}
	if !strings.Contains(it.Why, "dag merge t-3 --continue") {
		t.Fatalf("why = %q, want the continue command", it.Why)
	}
}

func TestBuildAttentionNamesARefusedMerge(t *testing.T) {
	g := dagWithStatus("blocked")
	g.Tasks = []waveobj.TaskNode{{ID: "t-3", Label: "store layer", State: "blocked-merge", MergeError: "untracked file would be overwritten\nmore"}}
	if it := blockedItem(t, g); !strings.Contains(it.Text, "untracked file would be overwritten") || strings.Contains(it.Text, "\n") {
		t.Fatalf("text = %q, want the refusal's first line", it.Text)
	}
}

func TestBuildAttentionNamesAFailedVerify(t *testing.T) {
	g := dagWithStatus("blocked")
	g.Tasks = []waveobj.TaskNode{{ID: "t-2", Label: "api", State: "verify-failed"}}
	if it := blockedItem(t, g); !strings.Contains(it.Text, "Verify failed") || !strings.Contains(it.Text, "api") {
		t.Fatalf("text = %q", it.Text)
	}
}

func TestBuildAttentionKeepsTheFailureCountForFailedTasks(t *testing.T) {
	g := dagWithStatus("blocked")
	g.Failures = 3
	g.Tasks = []waveobj.TaskNode{{ID: "t-1", Label: "b", State: "failed"}}
	if it := blockedItem(t, g); it.Text != "3 consecutive failures — decide retry/skip." {
		t.Fatalf("text = %q", it.Text)
	}
}
```

  Import `github.com/wavetermdev/waveterm/pkg/wshrpc` in the test if it is not imported. Run
  `go test ./pkg/jarvis/ -run BuildAttention` with the `CGO_CFLAGS` above. Expected: the three new-cause tests FAIL.

- [ ] **Step 4: Implement in `attention.go`.** Add the helper. Reuse an existing first-line helper in
  `pkg/jarvis` if one exists (grep `func firstLine`); otherwise add a small one here.

```go
// dagBlockedReason says what holds a blocked dag, in the order the engine's digest ranks the human's
// actions: a merge, then a failed Verify, then failed tasks. A blocked merge is not a failure, and reading
// it as one printed "0 consecutive failures".
func dagBlockedReason(g *waveobj.TaskGroup) (text, why string) {
	done := fmt.Sprintf("%d of %d tasks done.", doneTasks(g), len(g.Tasks))
	name := func(t waveobj.TaskNode) string {
		if t.Label != "" {
			return t.Label
		}
		return t.ID
	}
	for _, t := range g.Tasks {
		if t.State != "blocked-merge" {
			continue
		}
		if t.MergeError != "" {
			return fmt.Sprintf("Merge of %s was refused: %s", name(t), firstLine(t.MergeError)),
				fmt.Sprintf("%s Clear what git refused over, then retry with `wsh jarvis dag merge %s --continue`.", done, t.ID)
		}
		return fmt.Sprintf("Merge of %s is blocked by a conflict and needs resolving.", name(t)),
			fmt.Sprintf("%s Resolve the conflict in the project checkout, commit, then run `wsh jarvis dag merge %s --continue`.", done, t.ID)
	}
	for _, t := range g.Tasks {
		if t.State == "verify-failed" {
			return fmt.Sprintf("Verify failed after %s merged.", name(t)),
				fmt.Sprintf("%s Commit a fix, then re-run Verify with `wsh jarvis dag merge %s --continue`.", done, t.ID)
		}
	}
	return fmt.Sprintf("%d consecutive failures — decide retry/skip.", g.Failures),
		done + " The group stays stopped until you retry or skip."
}
```

  In the `case "blocked":` of `BuildAttention`, call `text, why := dagBlockedReason(g)` and use them for
  `Text` and `Why`. Keep every other field as it is. Run `go test ./pkg/jarvis/` with the `CGO_CFLAGS` above.
  Expected: PASS.

- [ ] **Step 5: Commit.** `git add` the four files, then
  `git commit -m "fix(jarvis): seal the dag's Verify results and name what blocks a dag on the Brief"`.

- [ ] **Step 6: Run the full Verify** (the command in the rules). It must pass.

- [ ] **Step 7: Close the chunks**, each with a note naming what changed, the files and the tests:

```
wsh effort chunk status 5d11f853-41e2-44d4-8aa4-bf92cee88dca "Sealed evidence says verification none recorded after Verify passed" done --note "<dagVerifs: one entry per task, newest result, owner run only; files; tests>"
wsh effort chunk status 5d11f853-41e2-44d4-8aa4-bf92cee88dca "Blocked merge reads as a failure on the Brief" done --note "<dagBlockedReason names a conflict, a refusal, a failed Verify, else the failure count; files; tests>"
```

- [ ] **Step 8: Complete.** `wsh jarvis complete --commit $(git rev-parse HEAD)`

---

### Task 5: Answers: Enter sends a typed answer, and answering nothing is an error
**Depends on:** none

This task closes two chunks of effort `5d11f853-41e2-44d4-8aa4-bf92cee88dca`:
- `Brief sheet cannot send a typed answer to a lead's question`
- `answeragent succeeds when nothing was answered`

**Rules for this task** (you see only this task, so everything you need is here):
- Stay inside the files listed below. Never edit anything under `docs/`.
- Typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (about 2 minutes; it must exit 0). Never use `npx tsc` or `task check:ts`; both break in this repo.
- Frontend tests: `npx vitest run <file>`. Go tests (Git Bash): `CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/<package>/...`.
- Frontend logic goes in a pure `.ts` module with a `.test.ts` beside it. No jsdom, render or snapshot tests. Colors come from `@theme` token classes only, never raw hex or rgba.
- If you change any wshrpc, waveobj or wconfig type, run `task generate` and never hand-edit its outputs. This task needs none (a new error value, no type change).
- Check formatting only on the files you touched (`npx prettier --check <file>`, `gofmt -l <file>`). Never `--write` the tree.
- Commit with a conventional message and no trailers (no `Co-Authored-By`).
- Before completing, run the full Verify: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && npx vitest run && CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/...`
- The last steps, in order: close each chunk above with `wsh effort chunk status`, then `wsh jarvis complete --commit $(git rev-parse HEAD)`.

**Files:**
- Modify: `frontend/app/view/agents/agentsviewmodel.ts` (`answerHint`, new `nextUnansweredQuestion`), test: `frontend/app/view/agents/agentsviewmodel.test.ts`. If `answerHint`'s tests live in another file, grep `answerHint` in `*.test.ts` and use that one.
- Modify: `frontend/app/view/agents/answerbar.tsx` (`QuestionGroup`'s input, `AnswerBar`)
- Modify: `pkg/agentask/deliver.go` (`DeliverAnswer`), test: `pkg/agentask/deliver_test.go`

**What is wrong (verified in code):**
- `AnswerBar`'s "or type your own answer…" input only updates the text. Only an option click ever calls
  `onSubmit`. Focusing the input also turns off every surface's Enter binding (`ctx.editable`), so a typed
  answer cannot be sent anywhere: not on the Brief, not on the Agent surface.
- `DeliverAnswer` (`pkg/agentask/deliver.go`) returns `false, nil` when the oref has no pending ask, so the
  `answeragent` RPC (`AnswerAgentCommand`) reports success for an answer that went nowhere. Every caller was
  checked, and none depends on the silent success. `DagAnswerCommand` confirms a pending ask before calling.
  The frontend's `submitAnswer` ignores the result, and `fireAndForget` logs a rejection.

- [ ] **Step 1: Write the failing Go test.** In `pkg/agentask/deliver_test.go`, change
  `TestDeliverAnswer_NoPending` to assert the error (add `errors` to the imports):

```go
	delivered, err := DeliverAnswer("tab:none", "", []baseds.AgentAnswerItem{{SelectedIndexes: []int{0}}})
	if delivered || !errors.Is(err, ErrNoPendingAsk) {
		t.Fatalf("an answer to nothing must fail with ErrNoPendingAsk, got delivered=%v err=%v", delivered, err)
	}
```

  Run `go test ./pkg/agentask/ -run NoPending` with the `CGO_CFLAGS` above. Expected: FAIL to compile.

- [ ] **Step 2: Implement in `deliver.go`:**

```go
// ErrNoPendingAsk is DeliverAnswer's refusal when the oref has no pending ask: it was never asked, was already
// answered, or was cleared. A caller must hear that its answer went nowhere.
var ErrNoPendingAsk = errors.New("no pending question")
```

  In `DeliverAnswer`, replace `return false, nil` with
  `return false, fmt.Errorf("%w for %s", ErrNoPendingAsk, oref)`, and update its doc comment to match. Run
  `go test ./pkg/agentask/ ./pkg/wshrpc/wshserver/ ./pkg/jarvis/` with the `CGO_CFLAGS` above. Any test that
  asserted the old silent success must now expect the error. Update it and name it in the chunk note.

- [ ] **Step 3: Write the failing frontend tests.** Add `nextUnansweredQuestion` to the test's
  `agentsviewmodel` import and append:

```ts
describe("nextUnansweredQuestion", () => {
    const qs = [{ question: "a", options: [{ label: "x" }] }, { question: "b", options: [{ label: "y" }] }] as AgentAskQuestion[];
    it("moves to the next question with neither a selection nor typed text", () => {
        expect(nextUnansweredQuestion(qs, {}, {}, 0)).toBe(1);
    });
    it("is -1 once every other question is answered, by a selection or by typed text", () => {
        expect(nextUnansweredQuestion(qs, { 1: new Set([0]) }, {}, 0)).toBe(-1);
        expect(nextUnansweredQuestion(qs, {}, { 1: "my own answer" }, 0)).toBe(-1);
        expect(nextUnansweredQuestion(qs, {}, { 1: "   " }, 0)).toBe(1);
    });
});

describe("answerHint with typed text", () => {
    const one = [{ question: "a", options: [{ label: "x" }] }] as AgentAskQuestion[];
    it("says Enter sends once an answer is typed", () => {
        expect(answerHint(one, {}, true, { 0: "my own answer" })).toBe("press Enter to send");
        expect(answerHint(one, {}, true, {})).toBe("Press 1–9 or click to answer");
    });
});
```

  Run `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts`. Expected: FAIL.

- [ ] **Step 4: Implement in `agentsviewmodel.ts`.** Add, beside `canSubmitAsk`:

```ts
/** Pure: the question to move to once question `qi` has an answer, or -1 when every other question has one (a
 *  selection or typed text) and the ask can go. Shared by an option click and Enter in the typed-answer field. */
export function nextUnansweredQuestion(
    questions: AgentAskQuestion[],
    selections: Record<number, Set<number>>,
    texts: Record<number, string>,
    qi: number
): number {
    return questions.findIndex((_, j) => j !== qi && (selections[j]?.size ?? 0) === 0 && (texts[j] ?? "").trim() === "");
}
```

  Give `answerHint` a fourth parameter, `texts: Record<number, string> = {}`. A typed answer counts as
  answered in the "N/M answered" count. When any question has typed text, the hint says
  "press Enter to send": for one single-select question it is the whole hint, and otherwise it replaces
  "press Enter to submit" in the parts. Update the doc comment's bullet list.

- [ ] **Step 5: Wire Enter in `answerbar.tsx`.** Give `QuestionGroup` an `onTextSubmit?: () => void` prop and
  put this on the input:

```tsx
                    onKeyDown={(e) => {
                        // the surface's Enter binding is off while this field has focus, so the field sends its own answer
                        if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || (text ?? "").trim() === "") {
                            return;
                        }
                        e.preventDefault();
                        e.stopPropagation();
                        onTextSubmit?.();
                    }}
```

  In `AnswerBar`, add one shared `advance`, and use it for both the single-select option click (replacing its
  inline `findIndex`) and `onTextSubmit`:

```tsx
    // after question qi is answered: go to the next unanswered question, or send once none is left
    const advance = (qi: number) => {
        const next = nextUnansweredQuestion(questions, selections, texts ?? {}, qi);
        if (next === -1) {
            onSubmit();
        } else {
            onSelectQuestion?.(next);
        }
    };
```

  Pass `texts ?? {}` as `answerHint`'s new fourth argument at both call sites.

- [ ] **Step 6: Run the tests and the typecheck.** `npx vitest run frontend/app/view/agents/` (PASS), then
  `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (exit 0).

- [ ] **Step 7: Commit.** `git add` the five files, then
  `git commit -m "fix(asks): send a typed answer on Enter and fail an answer to no pending question"`.

- [ ] **Step 8: Run the full Verify** (the command in the rules). It must pass.

- [ ] **Step 9: Close the chunks**, each with a note naming what changed, the files and the tests:

```
wsh effort chunk status 5d11f853-41e2-44d4-8aa4-bf92cee88dca "Brief sheet cannot send a typed answer to a lead's question" done --note "<Enter in the typed field advances or submits via nextUnansweredQuestion, on every surface; hint says Enter sends; files; tests. Needs a live check: type an answer on the Brief's Clarifying question card and press Enter.>"
wsh effort chunk status 5d11f853-41e2-44d4-8aa4-bf92cee88dca "answeragent succeeds when nothing was answered" done --note "<DeliverAnswer returns ErrNoPendingAsk; callers checked (DagAnswerCommand pre-checks, submitAnswer ignores the result); files; tests>"
```

- [ ] **Step 10: Complete.** `wsh jarvis complete --commit $(git rev-parse HEAD)`

---

### Task 6: Starting a run: report a failed read-back, and let the project list scroll
**Depends on:** none

This task closes two chunks of effort `5d11f853-41e2-44d4-8aa4-bf92cee88dca`:
- `Starting a run can throw TypeError reading null id`
- `+ Run project list squashes rows when projects overflow`

**Rules for this task** (you see only this task, so everything you need is here):
- Stay inside the files listed below. Never edit anything under `docs/`.
- Typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (about 2 minutes; it must exit 0). Never use `npx tsc` or `task check:ts`; both break in this repo.
- Frontend tests: `npx vitest run <file>`. Go tests (Git Bash): `CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/<package>/...`.
- Frontend logic goes in a pure `.ts` module with a `.test.ts` beside it. No jsdom, render or snapshot tests. Colors come from `@theme` token classes only, never raw hex or rgba.
- If you change any wshrpc, waveobj or wconfig type, run `task generate` and never hand-edit its outputs. This task needs none.
- Check formatting only on the files you touched (`npx prettier --check <file>`, `gofmt -l <file>`). Never `--write` the tree.
- Commit with a conventional message and no trailers (no `Co-Authored-By`).
- Before completing, run the full Verify: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && npx vitest run && CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/...`
- The last steps, in order: close each chunk above with `wsh effort chunk status`, then `wsh jarvis complete --commit $(git rev-parse HEAD)`.

**Files:**
- Modify: `pkg/wshrpc/wshserver/wshserver_runs.go` (the end of `CreateRunCommand`), test: create `pkg/wshrpc/wshserver/wshserver_createrun_test.go`
- Modify: `frontend/app/view/agents/runactions.ts` (`createRun`), test: `frontend/app/view/agents/runactions.test.ts`
- Modify: `frontend/app/view/jarvis/newruncontrol.tsx` (the project row buttons)

**What is wrong (verified in code):**
- `CreateRunCommand` ends with `out, _ := wstore.GetRun(ctx, data.ChannelId, run.ID)` and returns
  `{Run: out}`, so a failed read-back returns `{run: null}` with no error. `createRun` passes it on, and the
  launcher's `openChannelSheet(oid, run.id)` throws "TypeError: Cannot read properties of null (reading 'id')".
  The launcher already prints any thrown error (`setError(String(e))`), so it will show the real cause once
  there is one. The run is persisted by then, so the channel update must still go out. Diagnosing the read
  failure itself is out of scope.
- The + Run project list is a `flex max-h-[150px] flex-col … overflow-y-auto` column of buttons with no
  `shrink-0`. Flex children shrink before the column overflows, so once there are more projects than fit,
  every row is squashed and every name clipped.

- [ ] **Step 1: Write the failing Go test** in the new `pkg/wshrpc/wshserver/wshserver_createrun_test.go`.
  It follows `TestDagSubmitDeferredRun` in `wshserver_dag_test.go`: `stubRunServer` and a `DeferStart` run,
  so nothing spawns.

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// a run that was created but could not be read back must fail the RPC, not reply {run: null}
func TestCreateRunReportsAFailedReadBack(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "createrun-readback", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	stubRunServer(t, "pi", nil)
	var createdID string
	old := readCreatedRun
	readCreatedRun = func(_ context.Context, _ string, runID string) (*waveobj.Run, error) {
		createdID = runID
		return nil, errors.New("sql: transaction has already been committed or rolled back")
	}
	t.Cleanup(func() { readCreatedRun = old })

	rtn, err := (&WshServer{}).CreateRunCommand(ctx, wshrpc.CommandCreateRunData{
		ChannelId: ch.OID, WorkspaceId: "ws", Goal: "test", Runtime: "pi",
		Mode: jarvis.RunMode_Orchestrator, DeferStart: true,
	})
	if err == nil || rtn != nil {
		t.Fatalf("want an error and no reply, got rtn=%+v err=%v", rtn, err)
	}
	if !strings.Contains(err.Error(), createdID) || !strings.Contains(err.Error(), "transaction has already been committed") {
		t.Fatalf("error must name the run and the cause, got %v", err)
	}
	if _, gerr := wstore.GetRun(ctx, ch.OID, createdID); gerr != nil {
		t.Fatalf("the run itself must still exist: %v", gerr)
	}
}
```

  Run `go test ./pkg/wshrpc/wshserver/ -run TestCreateRunReportsAFailedReadBack` with the `CGO_CFLAGS`
  above. Expected: FAIL to compile (`readCreatedRun` is undefined).

- [ ] **Step 2: Implement in `wshserver_runs.go`.** Add the seam near `CreateRunCommand`:

```go
// readCreatedRun reads a just-created run back for the reply. A var so a test can fail the read.
var readCreatedRun = wstore.GetRun
```

  Replace the last three lines of `CreateRunCommand`:

```go
	out, err := readCreatedRun(ctx, data.ChannelId, run.ID)
	// the run exists either way, so its channel's run list must still refresh
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
	if err != nil {
		return nil, fmt.Errorf("run %s was created, but reading it back failed: %w", run.ID, err)
	}
	return &wshrpc.CommandCreateRunRtnData{Run: out}, nil
```

  Run the test and `go test ./pkg/wshrpc/wshserver/` with the `CGO_CFLAGS` above. Expected: PASS.

- [ ] **Step 3: Write the failing frontend test** in `runactions.test.ts`. The file already mocks
  `CreateRunCommand` through a `createRunCommand` mock function; follow the existing `createRun` tests for its
  shape.

```ts
    it("throws a clear error when the server returns no run", async () => {
        createRunCommand.mockResolvedValueOnce({ run: null });
        await expect(createRun("ch-1", "goal", { runtime: "claude" })).rejects.toThrow("returned no run");
    });
```

  Run `npx vitest run frontend/app/view/agents/runactions.test.ts`. Expected: FAIL (it returns `null`).

- [ ] **Step 4: Implement in `runactions.ts` `createRun`**, replacing `return rtn.run;`:

```ts
    if (rtn?.run == null) {
        // the launcher opens whatever comes back, and a null here surfaced as a TypeError about `id`
        throw new Error("creating the run returned no run");
    }
    return rtn.run;
```

  Run the test again. Expected: PASS.

- [ ] **Step 5: Let the project rows keep their height** in `newruncontrol.tsx`. In the project list (the
  `rows.map((project) => <button …>)` inside the `max-h-[150px]` column), add `shrink-0` to the button's
  class list. CSS alone cannot be unit-tested here, so this change has no test. It needs a live check,
  recorded in the chunk note.

- [ ] **Step 6: Typecheck:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (exit 0).

- [ ] **Step 7: Commit.** `git add` the five files, then
  `git commit -m "fix(runs): fail CreateRun on a failed read-back and keep + Run project rows from shrinking"`.

- [ ] **Step 8: Run the full Verify** (the command in the rules). It must pass.

- [ ] **Step 9: Close the chunks**, each with a note naming what changed, the files and the tests:

```
wsh effort chunk status 5d11f853-41e2-44d4-8aa4-bf92cee88dca "Starting a run can throw TypeError reading null id" done --note "<CreateRunCommand returns the read-back error (channel update still sent); createRun throws on a null run; files; tests. The underlying read failure is not diagnosed.>"
wsh effort chunk status 5d11f853-41e2-44d4-8aa4-bf92cee88dca "+ Run project list squashes rows when projects overflow" done --note "<rows are shrink-0 in newruncontrol.tsx; CSS only, no unit test. Needs a live check: with more projects than fit, the + Run list scrolls and names are not clipped.>"
```

- [ ] **Step 10: Complete.** `wsh jarvis complete --commit $(git rev-parse HEAD)`

---

### Task 7: DAG view: the node's escalate opens the route picker, failed actions show, and worker routes are right
**Depends on:** none

This task closes two chunks of effort `5d11f853-41e2-44d4-8aa4-bf92cee88dca`:
- `DAG node escalate button fails silently`
- `DAG view shows workers the lead's route`

**Rules for this task** (you see only this task, so everything you need is here):
- Stay inside the files listed below. Never edit anything under `docs/`.
- Typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (about 2 minutes; it must exit 0). Never use `npx tsc` or `task check:ts`; both break in this repo.
- Frontend tests: `npx vitest run <file>`. Go tests (Git Bash): `CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/<package>/...`.
- Frontend logic goes in a pure `.ts` module with a `.test.ts` beside it. No jsdom, render or snapshot tests. Colors come from `@theme` token classes only (`text-error`), never raw hex or rgba.
- If you change any wshrpc, waveobj or wconfig type, run `task generate` and never hand-edit its outputs. This task needs none.
- Check formatting only on the files you touched (`npx prettier --check <file>`). Never `--write` the tree.
- Commit with a conventional message and no trailers (no `Co-Authored-By`).
- Before completing, run the full Verify: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && npx vitest run && CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/...`
- The last steps, in order: close each chunk above with `wsh effort chunk status`, then `wsh jarvis complete --commit $(git rev-parse HEAD)`.

**Files:**
- Modify: `frontend/app/view/orchestrate/dagstore.ts` (`buildViewData`, new pure helpers), test: `frontend/app/view/orchestrate/dagstore.test.ts`
- Modify: `frontend/app/view/orchestrate/daggraph.tsx` (node actions, detail panel, route labels)

**What is wrong (verified in code):**
- The node's action buttons call `runAction(group, n, action)`. For `escalate`, that sends a
  `DagActionCommand` with no model, the server rejects it ("a target model is required"), and `runAction`
  and `runEscalate` drop the rejection (`void RpcApi…`). The detail panel's **escalate…** works because it
  opens a `RoutePicker` first. Decision: the node's `escalate` opens that same picker, and every DAG
  action's rejection is shown.
- `buildViewData` derives a task's route from the owner run's `runtime`/`model`, which is the lead's. The
  engine (`effectiveTaskRoute`, `pkg/orchestrate/engine.go`) uses the task's `runspec` first, then the
  **dag's** `workerroute` when it names a runtime or model (an empty runtime is the default runtime,
  `"claude"`), then the owner. So workers that ran on sonnet read "inherits run route · claude / opus".
  Mirror the engine exactly: read `group.workerroute`.

- [ ] **Step 1: Write the failing tests** in `dagstore.test.ts`. Add `dagActionRoute`, `dagActionError` and
  `routeSourceLabel` to the import. The file's `group`, `owner` and `harnesses` fixtures have owner
  `claude/sonnet`.

```ts
describe("worker routes", () => {
    const withWorkerRoute = { ...group, workerroute: { runtime: "claude", model: "haiku" } } as any;
    it("gives an unpinned task the dag's worker route, as the engine does", () => {
        const { nodes } = buildViewData(withWorkerRoute, owner, harnesses, new Set());
        expect(nodes[1].route).toMatchObject({ source: "workers", runtime: "claude", model: "haiku" });
    });
    it("keeps a task's own pin ahead of the worker route", () => {
        const pinned = { ...withWorkerRoute, tasks: [{ id: "t-0", label: "x", state: "pending", runspec: { runtime: "pi" } }] } as any;
        expect(buildViewData(pinned, owner, harnesses, new Set()).nodes[0].route.source).toBe("pinned");
    });
    it("falls back to the owner's route only when the dag has no worker route", () => {
        const { nodes } = buildViewData(group, owner, harnesses, new Set());
        expect(nodes[1].route).toMatchObject({ source: "inherited", model: "sonnet" });
    });
    it("names each source", () => {
        expect(routeSourceLabel("pinned")).toBe("pinned");
        expect(routeSourceLabel("workers")).toBe("run worker route");
        expect(routeSourceLabel("inherited")).toBe("inherits run route");
    });
});

describe("node actions", () => {
    it("opens the route picker for escalate: the server needs a model", () => {
        expect(dagActionRoute("escalate")).toBe("pick-route");
        expect(dagActionRoute("merge")).toBe("merge");
        expect(dagActionRoute("resolve")).toBe("continue");
        expect(dagActionRoute("retry")).toBe("action");
    });
    it("words a refused action with its task and the server's reason", () => {
        expect(dagActionError("retry", "t-3", new Error("task t-3 is running"))).toBe("retry t-3 failed: task t-3 is running");
    });
});
```

  Run `npx vitest run frontend/app/view/orchestrate/dagstore.test.ts`. Expected: FAIL.

- [ ] **Step 2: Implement in `dagstore.ts`.** Widen `DagNodeRoute.source` to
  `"pinned" | "workers" | "inherited"`, then add:

```ts
// routeSourceLabel is how a node names where its route came from.
export function routeSourceLabel(source: DagNodeRoute["source"]): string {
    switch (source) {
        case "pinned":
            return "pinned";
        case "workers":
            return "run worker route";
        default:
            return "inherits run route";
    }
}

export type DagActionRoute = "pick-route" | "merge" | "continue" | "action";

// dagActionRoute is where a node action goes. escalate needs a target model, which only the route picker
// supplies; sent bare, the server rejects it.
export function dagActionRoute(action: string): DagActionRoute {
    switch (action) {
        case "escalate":
            return "pick-route";
        case "merge":
            return "merge";
        case "resolve":
            return "continue";
        default:
            return "action";
    }
}

// dagActionError is the line the detail panel shows for a refused DAG action.
export function dagActionError(action: string, taskId: string, err: unknown): string {
    const reason = err instanceof Error ? err.message : String(err);
    return `${action} ${taskId} failed: ${reason}`;
}

// the engine's default runtime for a worker route that names only a model (runroute.DefaultRuntime)
const DEFAULT_RUNTIME = "claude";

// normalizeWorkerPin mirrors effectiveTaskRoute (pkg/orchestrate/engine.go): the dag's worker route applies
// when it names a runtime or a model.
function normalizeWorkerPin(pin: RoutePin | undefined): RoutePin | null {
    if (pin == null || (!pin.runtime && !pin.model)) return null;
    return { runtime: pin.runtime || DEFAULT_RUNTIME, ...(pin.model ? { model: pin.model } : {}) };
}
```

  In `buildViewData`, compute `const workerPin = normalizeWorkerPin(group.workerroute);` once, before the
  map. Use `const effective: RoutePin = taskPin ?? workerPin ?? ownerPin ?? { runtime: "" };` and
  `source: taskPin != null ? "pinned" : workerPin != null ? "workers" : "inherited"`. Before adding
  `DEFAULT_RUNTIME`, check whether `frontend/app/view/agents/route.ts` already exports a default-runtime
  constant (grep `claude"` there), and reuse it if so. Run the tests. Expected: PASS. Update any older test in
  the file that asserted `inherited` for a group that has a `workerroute`.

- [ ] **Step 3: Wire `daggraph.tsx`.**
  - Both route lines (the node's and the detail panel's) print `routeSourceLabel(x.route.source)` in place of
    the inline `=== "pinned" ? … : "inherits run route"`. The `data-dag-node-route` attribute stays as it
    is; CDP scripts only test that it exists.
  - `runAction` and `runEscalate` return their `Promise` (drop `void`), with `runAction` dispatching through
    `dagActionRoute(action)`.
  - Add state `const [actionError, setActionError] = useState<{ taskId: string; text: string } | null>(null);`
    and one handler that every action path uses: node buttons, detail buttons, and the picker's
    **Re-queue on model**:

```tsx
    // a node's escalate opens the detail panel's route picker; every other action is sent, and a refusal is
    // shown on that task instead of vanishing into an unhandled rejection
    const onTaskAction = (view: DagViewNode, action: string) => {
        if (dagActionRoute(action) === "pick-route") {
            globalStore.set(selectedTaskIdAtom, view.id);
            setEscalating(true);
            return;
        }
        setActionError(null);
        runAction(group, view, action).catch((e) => {
            globalStore.set(selectedTaskIdAtom, view.id);
            setActionError({ taskId: view.id, text: dagActionError(action, view.id, e) });
        });
    };
```

  The node data's `onAction` becomes `(action) => onTaskAction(n, action)`. It is built inside a `useMemo`,
  so read the handler through a ref, or declare the `escalating` state above that memo, whichever keeps the
  memo's dependencies honest. Use the same `.catch` for `runEscalate` with action `"escalate"`. Render the
  error in the detail panel, under its action buttons, only when `actionError?.taskId === selected.id`:
  `<div className="mt-1.5 text-[11px] text-error">{actionError.text}</div>`. If this file names the
  selection atom differently, use the name it already imports.

- [ ] **Step 4: Typecheck and test.** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
  (exit 0), then `npx vitest run frontend/app/view/orchestrate/` (PASS).

- [ ] **Step 5: Commit.** `git add` the three files, then
  `git commit -m "fix(dag): route the node's escalate to the picker, show refused actions, read the dag's worker route"`.

- [ ] **Step 6: Run the full Verify** (the command in the rules). It must pass.

- [ ] **Step 7: Close the chunks**, each with a note naming what changed, the files and the tests:

```
wsh effort chunk status 5d11f853-41e2-44d4-8aa4-bf92cee88dca "DAG node escalate button fails silently" done --note "<node escalate opens the detail panel's route picker (dagActionRoute); refused actions show on the task (dagActionError); files; tests>"
wsh effort chunk status 5d11f853-41e2-44d4-8aa4-bf92cee88dca "DAG view shows workers the lead's route" done --note "<buildViewData mirrors effectiveTaskRoute: runspec, then the dag's workerroute, then the owner; 'run worker route' label; files; tests>"
```

- [ ] **Step 8: Complete.** `wsh jarvis complete --commit $(git rev-parse HEAD)`

---

### Task 8: Agent statuses survive an app reload
**Depends on:** none

This task closes one chunk of effort `5d11f853-41e2-44d4-8aa4-bf92cee88dca`:
- `App reload empties the Agent tree of running workers`

**Rules for this task** (you see only this task, so everything you need is here):
- Stay inside the files listed below. Never edit anything under `docs/`.
- Typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (about 2 minutes; it must exit 0). Never use `npx tsc` or `task check:ts`; both break in this repo.
- Frontend tests: `npx vitest run <file>`. Go tests (Git Bash): `CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/<package>/...`.
- Frontend logic goes in a pure `.ts` module with a `.test.ts` beside it. No jsdom, render or snapshot tests. Colors come from `@theme` token classes only, never raw hex or rgba.
- If you change any wshrpc, waveobj or wconfig type, run `task generate` and never hand-edit its outputs. This task needs none (`EventReadHistoryCommand` exists).
- Check formatting only on the files you touched (`npx prettier --check <file>`). Never `--write` the tree.
- Commit with a conventional message and no trailers (no `Co-Authored-By`).
- Before completing, run the full Verify: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && npx vitest run && CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/...`
- The last steps, in order: close the chunk above with `wsh effort chunk status`, then `wsh jarvis complete --commit $(git rev-parse HEAD)`.

**Files:**
- Modify: `frontend/app/view/agents/session-models/agentstatusstore.ts`, test: `frontend/app/view/agents/session-models/agentstatusstore.test.ts`

**What is wrong (verified in code):** each block's status lives in an in-memory atom (`getAgentStatusAtom`)
that only new `agent:status` events fill (`setupAgentStatusSubscription`). The Agent tree shows a worker only
while its block has a status, so after a frontend reload every running worker vanishes until its next hook
event. wavesrv keeps each block's last state event: hooks and the backend publish it with `Persist: 1`, and
the broker keeps it per scope, `block:<id>`. It can be read with
`RpcApi.EventReadHistoryCommand(TabRpcClient, { event: "agent:status", scope: oref, maxitems: 1 })`. Nothing
reads it on load. (Usage-only events are `Persist: 0`, so the retained event is a state event.)

- [ ] **Step 1: Write the failing tests** in `agentstatusstore.test.ts`. Add `seedAgentStatus` to the import
  and use the file's `status()` fixture.

```ts
describe("seedAgentStatus", () => {
    it("fills an empty atom from the block's retained last event", () => {
        expect(seedAgentStatus(null, status({ state: "working", title: "t" }))).toEqual(status({ state: "working", title: "t" }));
    });
    it("never replaces a live event that arrived before the read returned", () => {
        const live = status({ state: "asking", ts: 9 });
        expect(seedAgentStatus(live, status({ state: "working", ts: 1 }))).toBe(live);
    });
    it("seeds nothing from a missing or stateless event", () => {
        expect(seedAgentStatus(null, undefined)).toBeNull();
        expect(seedAgentStatus(null, status({ state: "" }))).toBeNull();
    });
});
```

  Run `npx vitest run frontend/app/view/agents/session-models/agentstatusstore.test.ts`. Expected: FAIL.

- [ ] **Step 2: Implement in `agentstatusstore.ts`.** Import `RpcApi` from `@/app/store/wshclientapi` and
  `TabRpcClient` from `@/app/store/wshrpcutil`.

```ts
/** Pure: what a block's status atom holds once its retained last event arrives after a reload. A live event
 *  that beat the read wins, since it is newer by construction; an event without a state seeds nothing. */
export function seedAgentStatus(
    current: AgentStatusData | null,
    retained: AgentStatusData | null | undefined
): AgentStatusData | null {
    if (current != null || retained == null || !retained.state) {
        return current;
    }
    return retained;
}

// Set once the subscription is up: reads a block's retained agent:status the first time its atom is created, so
// a reload does not empty the roster until every agent's next hook event. Unset in tests and before boot, so
// creating an atom stays pure there.
let seedStatus: ((oref: string, statusAtom: PrimitiveAtom<AgentStatusData>) => void) | null = null;

function readRetainedStatus(oref: string, statusAtom: PrimitiveAtom<AgentStatusData>) {
    fireAndForget(async () => {
        try {
            const events = await RpcApi.EventReadHistoryCommand(TabRpcClient, { event: "agent:status", scope: oref, maxitems: 1 });
            const retained = events?.[events.length - 1]?.data as AgentStatusData | undefined;
            globalStore.set(statusAtom, (prev) => seedAgentStatus(prev, retained));
        } catch (err) {
            console.warn(`reading the retained agent:status of ${oref} failed`, err);
        }
    });
}
```

  In `getAgentStatusAtom`, after `agentStatusAtoms.set(oref, statusAtom);`, add `seedStatus?.(oref, statusAtom);`.
  In `setupAgentStatusSubscription`, right after `subscribed = true;`:

```ts
    seedStatus = readRetainedStatus;
    // atoms made before the subscription existed are seeded now
    for (const [oref, statusAtom] of agentStatusAtoms) {
        seedStatus(oref, statusAtom);
    }
```

  Import `fireAndForget` from `@/util/util`. Check the import does not pull the store into a cycle: this
  module already imports `@/app/store/jotaiStore` and `@/app/store/wps`, and `wshclientapi` is imported the
  same way across `frontend/app/view/agents`.

- [ ] **Step 3: Run the tests and the typecheck.**
  `npx vitest run frontend/app/view/agents/session-models/` (PASS), then
  `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (exit 0).

- [ ] **Step 4: Commit.** `git add` the two files, then
  `git commit -m "fix(agents): seed agent statuses from the retained last event after a reload"`.

- [ ] **Step 5: Run the full Verify** (the command in the rules). It must pass.

- [ ] **Step 6: Close the chunk:**

```
wsh effort chunk status 5d11f853-41e2-44d4-8aa4-bf92cee88dca "App reload empties the Agent tree of running workers" done --note "<first creation of a block's status atom reads its retained agent:status (EventReadHistoryCommand); seedAgentStatus never overrides a live event; files; tests. Needs a live check: reload the app mid-run and the running workers' rows stay.>"
```

- [ ] **Step 7: Complete.** `wsh jarvis complete --commit $(git rev-parse HEAD)`

---

### Task 9: Housekeeping: drop the orphaned deleteChannel wrapper, and deflake the reorder-queue test
**Depends on:** none

This task closes two chunks of effort `5d11f853-41e2-44d4-8aa4-bf92cee88dca`:
- `Delete the orphaned frontend deleteChannel wrapper`
- `TestQuickReorderQueue_RollingTimeout flakes under load`

**Rules for this task** (you see only this task, so everything you need is here):
- Stay inside the files listed below. Never edit anything under `docs/`.
- Typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (about 2 minutes; it must exit 0). Never use `npx tsc` or `task check:ts`; both break in this repo.
- Frontend tests: `npx vitest run <file>`. Go tests (Git Bash): `CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/<package>/...`.
- Frontend logic goes in a pure `.ts` module with a `.test.ts` beside it. No jsdom, render or snapshot tests. Colors come from `@theme` token classes only, never raw hex or rgba.
- If you change any wshrpc, waveobj or wconfig type, run `task generate` and never hand-edit its outputs. This task changes none, and must **not** touch the `deletechannel` RPC.
- Check formatting only on the files you touched (`npx prettier --check <file>`, `gofmt -l <file>`). Never `--write` the tree.
- Commit with a conventional message and no trailers (no `Co-Authored-By`).
- Before completing, run the full Verify: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && npx vitest run && CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/...`
- The last steps, in order: close each chunk above with `wsh effort chunk status`, then `wsh jarvis complete --commit $(git rev-parse HEAD)`.

**Files:**
- Modify: `frontend/app/view/agents/channelsstore.ts` (delete `deleteChannel` only)
- Modify: `pkg/utilds/quickreorderqueue_test.go` (`TestQuickReorderQueue_RollingTimeout` only; no production change)

**What is wrong (verified in code):**
- `deleteChannel` in `channelsstore.ts` has no caller. **Keep** `DeleteChannelCommand` and the `deletechannel`
  RPC: `scripts/cdp/scenarios.mjs`, `scripts/cdp-e2e-runs-piece4.mjs` and `scripts/cdp-profile-verify.mjs`
  use it as their teardown.
- `TestQuickReorderQueue_RollingTimeout` queues seven out-of-order items 10ms apart under a 50ms reorder
  timeout, and asserts they come out in order. Under load, a 10ms sleep can stretch past 50ms. The queue then
  correctly flushes a buffered item that has outlived the window, and the order check fails. The flake is in
  the test's timing assumption, not in the queue. Keep what the test asserts: the same seven items, spread
  over time, each well inside the window, come out in order. Make the window far wider than any stall a
  loaded scheduler causes, and let `collectItems`' deadline replace the fixed trailing sleep. A deadline
  shorter than the window still catches a queue that held an item until its timeout.

- [ ] **Step 1: Confirm there are no callers, then delete the wrapper.**
  `grep -rn "deleteChannel\b" frontend --include=*.ts --include=*.tsx | grep -v DeleteChannelCommand` must list
  only the definition. Delete the `export async function deleteChannel(...) { ... }` block from
  `channelsstore.ts`, and nothing else. Leave `loadChannels`, `activeChannelIdAtom` and the rest alone even
  if the wrapper was one of their users.

- [ ] **Step 2: Rewrite the flaky test.** In `pkg/utilds/quickreorderqueue_test.go`, change only
  `TestQuickReorderQueue_RollingTimeout`:

```go
func TestQuickReorderQueue_RollingTimeout(t *testing.T) {
	// out-of-order items spread over time, each well inside the reorder window, come out in order. The window
	// is far wider than any stall a loaded scheduler puts into a 10ms gap: at 50ms, load stretched a gap past
	// it and the queue (correctly) flushed an item early, so the test flaked while three suites ran at once.
	const window = 5 * time.Second
	q := MakeQuickReorderQueue[string](20, window)
	defer q.Close()

	q.QueueItem("session1", 1, "item1")
	time.Sleep(10 * time.Millisecond)

	q.QueueItem("session1", 5, "item5")
	time.Sleep(10 * time.Millisecond)

	q.QueueItem("session1", 3, "item3")
	time.Sleep(10 * time.Millisecond)

	q.QueueItem("session1", 2, "item2")
	time.Sleep(10 * time.Millisecond)

	q.QueueItem("session1", 4, "item4")
	time.Sleep(10 * time.Millisecond)

	q.QueueItem("session1", 7, "item7")
	time.Sleep(10 * time.Millisecond)

	q.QueueItem("session1", 6, "item6")

	// every item is deliverable in order by now; a deadline well short of the window catches a queue that
	// held one back until its timeout
	items := collectItems(q.C(), 7, time.Second)

	if len(items) != 7 {
		t.Fatalf("expected 7 items, got %d: %v", len(items), items)
	}

	expected := []string{"item1", "item2", "item3", "item4", "item5", "item6", "item7"}
	for i, exp := range expected {
		if items[i] != exp {
			t.Errorf("expected %s at position %d, got %s. Full output: %v", exp, i, items[i], items)
		}
	}
}
```

- [ ] **Step 3: Prove it holds.**
  `CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/utilds/ -run TestQuickReorderQueue -count=200`
  (PASS, all 200 runs). Then run it while loading the machine, for example beside a parallel
  `go test ./pkg/...` in another shell: `go test ./pkg/utilds/ -run RollingTimeout -count=50` (PASS).
  Record both in the chunk note.

- [ ] **Step 4: Typecheck:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (exit 0).

- [ ] **Step 5: Commit.** `git add` the two files, then
  `git commit -m "chore: drop the orphaned deleteChannel wrapper and widen the rolling-timeout test's window"`.

- [ ] **Step 6: Run the full Verify** (the command in the rules). It must pass.

- [ ] **Step 7: Close the chunks**, each with a note naming what changed, the files and the tests:

```
wsh effort chunk status 5d11f853-41e2-44d4-8aa4-bf92cee88dca "Delete the orphaned frontend deleteChannel wrapper" done --note "<deleted deleteChannel from channelsstore.ts; the deletechannel RPC and DeleteChannelCommand stay as the CDP scripts' teardown>"
wsh effort chunk status 5d11f853-41e2-44d4-8aa4-bf92cee88dca "TestQuickReorderQueue_RollingTimeout flakes under load" done --note "<test only: 5s window, 1s collect deadline, same items and order assertion; -count=200 and a loaded -count=50 both pass>"
```

- [ ] **Step 8: Complete.** `wsh jarvis complete --commit $(git rev-parse HEAD)`

---

### Task 10: Update the orchestrator guide for what landed
**Depends on:** Task 1, Task 2, Task 3, Task 4, Task 5, Task 6, Task 7, Task 8, Task 9

**Rules for this task** (you see only this task, so everything you need is here):
- Edit only `docs/orchestrator-guide.md`. Change no code.
- Every other task in this run has landed before this one starts. Read their state with
  `wsh effort show 5d11f853-41e2-44d4-8aa4-bf92cee88dca`.
- This task changes no code, so skip the local test suite; the engine's merge Verify covers the tree.
- Commit with a conventional message and no trailers (no `Co-Authored-By`).
- This task closes no chunk. Its last step is `wsh jarvis complete --commit $(git rev-parse HEAD)`.

**Files:**
- Modify: `docs/orchestrator-guide.md`, the sections "What the backlog run left open" and "Rough edges found while writing this"

- [ ] **Step 1: Read which chunks are done.** Run `wsh effort show 5d11f853-41e2-44d4-8aa4-bf92cee88dca`
  and note each `[done]` label.

- [ ] **Step 2: Edit "Rough edges found while writing this".** Each bullet starts with a bold phrase. For each
  row below whose chunk is `done`, apply the action. Leave a bullet whose chunk is not done exactly as it is.
  Leave every bullet not in this table, whose chunk is out of scope, exactly as it is: "Workers killed by a
  reboot", "A slow Verify reads as a failed one", "A timed-out Verify keeps running on Windows".

| Bullet (bold start) | Chunk label | Action when done |
|---|---|---|
| Typed answers on the Brief can't be sent | Brief sheet cannot send a typed answer to a lead's question | remove |
| Keyboard answers don't reach a lead's question | liveWorkers ignores DAG child runs (Cancel confirm, 1-9 answers, 0-workers row) | remove |
| Cancel run skips its confirmation on an engine run | liveWorkers ignores DAG child runs (Cancel confirm, 1-9 answers, 0-workers row) | remove |
| A worker the engine dispatches can be missing from the Agent tree | Engine-dispatched workers missing from the Agent tree | remove, including its screenshot line |
| Verify has no row of its own once the lane's worker is reaped | Verify has no task row or output once the lane worker is reaped | keep only its last two sentences, about Verify's output not being shown while it runs (streaming it is still open), reworded as a standalone bullet |
| Reloading the app empties the Agent tree of running workers | App reload empties the Agent tree of running workers | remove |
| Starting a run can fail with "TypeError… | Starting a run can throw TypeError reading null id | remove |
| A question the lead holds is mislabelled | Lead-held question mislabelled on the task row | remove |
| The DAG node's `escalate` button fails silently | DAG node escalate button fails silently | remove |
| A blocked merge reads as a failure on the Brief | Blocked merge reads as a failure on the Brief | remove |
| Landed-commit credit after a resolved conflict | Landed-commit credit after a resolved conflict can name another lane | remove |
| Sealed evidence says "verification: none recorded" | Sealed evidence says verification none recorded after Verify passed | remove |
| The sealed summary can be the lead's previous message | Closed lead tab stays in the app as a frozen working row | remove only the sentences from "`deleteLeadTab` calls `wcore.DeleteTab` directly…" through "Reloading the app clears the row."; the rest (the lost report) is still open |
| The DAG view shows a worker the lead's route | DAG view shows workers the lead's route | remove |
| `answeragent` succeeds when nothing was answered | answeragent succeeds when nothing was answered | remove |
| The + Run project list squashes its rows | + Run project list squashes rows when projects overflow | remove |
| A plan run's first lead is named after its first wake | Plan run's first lead is named after its first wake | remove |

- [ ] **Step 3: Edit "What the backlog run left open".**
  - Replace the bullet "**`deleteChannel` and `DeleteChannelCommand` are orphaned now.** …" with one that says
    the frontend `deleteChannel` wrapper was deleted. The `deletechannel` RPC and `DeleteChannelCommand` stay,
    because the CDP scripts (`scripts/cdp/scenarios.mjs`, `scripts/cdp-e2e-runs-piece4.mjs`,
    `scripts/cdp-profile-verify.mjs`) use it as their teardown.
  - If the chunk `TestQuickReorderQueue_RollingTimeout flakes under load` is done, remove the
    "**`TestQuickReorderQueue_RollingTimeout` (`pkg/utilds`) flakes under load.**" bullet. It would otherwise
    say something false.

- [ ] **Step 4: Fix dangling cross-references.** Search the guide for text that pointed at a removed bullet,
  such as "(below)", "the reload edge below", "The lead's tab closed at the end of a run doesn't (below)" and
  links to the removed image. Reword or drop each one so nothing points at a bullet that is gone. Keep the
  guide's voice: plain sentences, no emojis.

- [ ] **Step 5: Commit.** `git add docs/orchestrator-guide.md`, then
  `git commit -m "docs(orchestrate): drop the rough edges this batch fixed"`.

- [ ] **Step 6: Complete.** `wsh jarvis complete --commit $(git rev-parse HEAD)`
