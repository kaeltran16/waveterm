# Cancel run — partial-failure warning surface — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a run is cancelled but an owned worker is still alive, surface a visible warning (header pill + a card listing each survivor with a per-worker Stop) instead of reporting a clean cancellation, and give the user a one-click stop per survivor.

**Architecture:** The roster is already the single source of truth for worker liveness (`liveWorkers`). The warning is a pure derivation (`cancelSurvivors`) over the mirrored roster — no persisted survivor state, no DB migration. The only new backend capability is a `StopRunWorkerCommand` RPC that reuses the existing kill path for one worker, guarded by a pure `jarvis.RunOwnsWorker`.

**Tech Stack:** Go (wshrpc / wshserver / jarvis / blockcontroller / wstore), TypeScript React 19 + jotai (frontend/app/view/agents), vitest, Task-orchestrated codegen (`task generate`).

**Design doc:** `docs/superpowers/specs/2026-07-15-cancel-run-partial-failure-surface-design.md`

## Global Constraints

- **Git:** NEVER commit or push without explicit user approval. Do NOT commit per task. Batch all changes (code + spec + plan + `docs/deferred.md` edit) into ONE commit at the very end, only after the user approves. Do not add a co-author.
- **Typecheck command:** bare `npx tsc` stack-overflows on this repo. Use `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`. Baseline is clean (exit 0) — any error it reports is yours.
- **Never hand-edit generated files.** `frontend/app/store/wshclientapi.ts` and `pkg/wshrpc/wshclient/wshclient.go` are produced by `task generate`. Edit the Go interface (`wshrpctypes.go`) + impl, then regenerate.
- **Colors:** no raw hex/rgba. Use existing `@theme` utility tokens (`text-error`, `border-error/40`, `bg-error/10`, `text-secondary`, `border-edge-mid`, `text-muted`) — the same set `BlockedCard` uses.
- **Run codegen after any wshrpc type change:** `task generate`.

---

### Task 1: Pure `RunOwnsWorker` guard (Go, jarvis)

A pure predicate that later gates `StopRunWorkerCommand` so it can only stop a worker the run actually owns. Lives with the other pure run-resolution logic (`ResolveRunWorker`).

**Files:**
- Modify: `pkg/jarvis/resolve.go` (add `RunOwnsWorker` after `ResolveRunWorker`, ~line 104)
- Test: `pkg/jarvis/resolve_test.go`

**Interfaces:**
- Produces: `func RunOwnsWorker(run *waveobj.Run, workerORef string) bool`

- [ ] **Step 1: Write the failing test**

Add to `pkg/jarvis/resolve_test.go`:

```go
func TestRunOwnsWorker(t *testing.T) {
	run := &waveobj.Run{ID: "r1", Phases: []waveobj.RunPhase{
		{Kind: PhaseKind_Plan, WorkerOrefs: []string{"tab:t1"}},
		{Kind: PhaseKind_Execute, WorkerOrefs: []string{"tab:t2", "tab:t3"}},
	}}
	if !RunOwnsWorker(run, "tab:t2") {
		t.Fatalf("expected run to own tab:t2")
	}
	if RunOwnsWorker(run, "tab:nope") {
		t.Fatalf("did not expect run to own tab:nope")
	}
	if RunOwnsWorker(nil, "tab:t1") {
		t.Fatalf("nil run owns nothing")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/jarvis/ -run TestRunOwnsWorker`
Expected: FAIL — `undefined: RunOwnsWorker`.

- [ ] **Step 3: Write minimal implementation**

Add to `pkg/jarvis/resolve.go` after `ResolveRunWorker`:

```go
// RunOwnsWorker reports whether workerORef ("tab:<id>") is a recorded worker of the run — it appears in
// some phase's WorkerOrefs. Guards per-worker stop actions so only a worker the run actually owns can be
// targeted (never an arbitrary tab).
func RunOwnsWorker(run *waveobj.Run, workerORef string) bool {
	if run == nil {
		return false
	}
	for pi := range run.Phases {
		for _, wo := range run.Phases[pi].WorkerOrefs {
			if wo == workerORef {
				return true
			}
		}
	}
	return false
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/jarvis/ -run TestRunOwnsWorker`
Expected: PASS.

- [ ] **Step 5: Verify (no commit)**

Run: `go test ./pkg/jarvis/`
Expected: PASS. Do NOT commit — batches into the final commit per Global Constraints.

---

### Task 2: Backend `stopWorkerORef` extraction + `StopRunWorkerCommand` RPC (Go + codegen)

Extract the per-worker kill so both the bulk cancel and the new single-worker command share it, then add the command and regenerate bindings. The kill path is impure (in-memory controller registry + process lifecycle) → verified by compile + generate, not a unit test (consistent with `stopRunWorkers`/`spawnRunWorkers`).

**Files:**
- Modify: `pkg/wshrpc/wshserver/wshserver.go` (refactor `stopRunWorkers` at ~1761; add `stopWorkerORef` + `StopRunWorkerCommand`)
- Modify: `pkg/wshrpc/wshrpctypes.go` (interface entry after line 129; `CommandStopRunWorkerData` after `CommandCancelRunData` ~line 774)
- Regenerated (do not hand-edit): `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`

**Interfaces:**
- Consumes: `jarvis.RunOwnsWorker(run, oref)` (Task 1); `wstore.GetRun(ctx, channelId, runId) (*waveobj.Run, error)`; `blockcontroller.DestroyBlockController(blockId)`; `wstore.UpdateObjectMeta`; `wcore.SendWaveObjUpdate`.
- Produces: `StopRunWorkerCommand(ctx, CommandStopRunWorkerData) error`; TS `RpcApi.StopRunWorkerCommand(client, {channelid, runid, workeroref})` (wire command `"stoprunworker"`).

- [ ] **Step 1: Add the command data type**

In `pkg/wshrpc/wshrpctypes.go`, after `CommandCancelRunData` (ends ~line 774), add:

```go
type CommandStopRunWorkerData struct {
	ChannelId  string `json:"channelid"`
	RunId      string `json:"runid"`
	WorkerORef string `json:"workeroref"` // the worker tab oref ("tab:<id>") to stop
}
```

- [ ] **Step 2: Add the interface method**

In `pkg/wshrpc/wshrpctypes.go`, immediately after the `CancelRunCommand` line (line 129), add:

```go
	StopRunWorkerCommand(ctx context.Context, data CommandStopRunWorkerData) error                                       // stop one surviving worker of a cancelled run
```

- [ ] **Step 3: Extract `stopWorkerORef` and rewrite `stopRunWorkers`**

In `pkg/wshrpc/wshserver/wshserver.go`, replace the existing `stopRunWorkers` (lines ~1754-1783) with:

```go
// stopWorkerORef terminates one worker the run owns: it parses the tab oref, and for each block in the
// tab flips cmd:runonstart off (so a later ResyncController can't relaunch the command) then destroys the
// block controller, killing the claude process (the idle-on-exit backstop in shellcontroller then flips
// the roster row working->idle). Returns an error only for the resolution boundary (bad oref / missing
// tab). A meta-write failure and an already-dead controller are logged no-ops, never fatal — a worker is
// spawned with cmd:runonstart defaulting true and no cmd:runonce, so the flip is what makes the kill
// durable: without it, opening the tab (or a reload) would resync the block and revive the worker.
func stopWorkerORef(ctx context.Context, workerORef string) error {
	oref, err := waveobj.ParseORef(workerORef)
	if err != nil || oref.OType != waveobj.OType_Tab {
		return fmt.Errorf("bad worker oref %q: %w", workerORef, err)
	}
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, oref.OID)
	if err != nil {
		return fmt.Errorf("loading tab %q: %w", workerORef, err)
	}
	for _, blockId := range tab.BlockIds {
		meta := waveobj.MetaMapType{waveobj.MetaKey_CmdRunOnStart: false}
		if merr := wstore.UpdateObjectMeta(ctx, waveobj.MakeORef(waveobj.OType_Block, blockId), meta, false); merr != nil {
			log.Printf("stopWorkerORef: clearing runonstart on block %s: %v", blockId, merr)
		}
		blockcontroller.DestroyBlockController(blockId)
	}
	return nil
}

// stopRunWorkers terminates every live worker the run owns (best-effort; each worker's failure is logged,
// never fatal — the run's cancelled state is already persisted).
func stopRunWorkers(ctx context.Context, run *waveobj.Run) {
	for i := range run.Phases {
		for _, workerORef := range run.Phases[i].WorkerOrefs {
			if err := stopWorkerORef(ctx, workerORef); err != nil {
				log.Printf("stopRunWorkers: %v", err)
			}
		}
	}
}
```

- [ ] **Step 4: Add `StopRunWorkerCommand`**

In `pkg/wshrpc/wshserver/wshserver.go`, immediately after `CancelRunCommand` (ends ~line 1959), add:

```go
// StopRunWorkerCommand stops one surviving worker of a cancelled run — the per-worker action of the
// partial-failure surface. Guarded by RunOwnsWorker so only a worker the run owns can be targeted. The
// kill's success is observed via the roster flipping to idle (the FE re-derives survivors); this returns
// an error only for validation / ownership failures.
func (ws *WshServer) StopRunWorkerCommand(ctx context.Context, data wshrpc.CommandStopRunWorkerData) error {
	if data.ChannelId == "" || data.RunId == "" || data.WorkerORef == "" {
		return fmt.Errorf("channelid, runid and workeroref are required")
	}
	run, err := wstore.GetRun(ctx, data.ChannelId, data.RunId)
	if err != nil {
		return fmt.Errorf("loading run: %w", err)
	}
	if !jarvis.RunOwnsWorker(run, data.WorkerORef) {
		return fmt.Errorf("run %s does not own worker %s", data.RunId, data.WorkerORef)
	}
	if serr := stopWorkerORef(ctx, data.WorkerORef); serr != nil {
		return fmt.Errorf("stopping worker: %w", serr)
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
	return nil
}
```

- [ ] **Step 5: Regenerate bindings**

Run: `task generate`
Expected: exits 0. Confirm it added, verbatim, to `pkg/wshrpc/wshclient/wshclient.go`:

```go
func StopRunWorkerCommand(w *wshutil.WshRpc, data wshrpc.CommandStopRunWorkerData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "stoprunworker", data, opts)
	return err
}
```

and to `frontend/app/store/wshclientapi.ts`:

```ts
    StopRunWorkerCommand(client: WshClient, data: CommandStopRunWorkerData, opts?: RpcOpts): Promise<void> {
        if (this.mockClient) return this.mockClient.mockWshRpcCall(client, "stoprunworker", data, opts);
        return client.wshRpcCall("stoprunworker", data, opts);
    }
```

(If `task generate` reports the pre-existing `pkg/tsgen TestGenerateWaveEventTypes` failure, that is a known clean-baseline failure — unrelated. Any other failure is yours.)

- [ ] **Step 6: Verify (no commit)**

Run: `go build ./...` then `go test ./pkg/jarvis/`
Expected: both PASS/exit 0. Do NOT commit.

---

### Task 3: Pure `cancelSurvivors` derivation (frontend)

The single place the warning keys off. Pure — TDD in vitest.

**Files:**
- Modify: `frontend/app/view/agents/runmodel.ts` (add after `liveWorkers`, ~line 157)
- Test: `frontend/app/view/agents/runmodel.test.ts`

**Interfaces:**
- Consumes: existing `liveWorkers(run, agents)`.
- Produces: `export function cancelSurvivors(run: Run, agents: AgentVM[]): AgentVM[]`

- [ ] **Step 1: Write the failing test**

In `frontend/app/view/agents/runmodel.test.ts`, add `cancelSurvivors` to the import block (lines 3-23), then add:

```ts
describe("cancelSurvivors", () => {
    it("returns live workers of a cancelled run, deduped across phases", () => {
        const r = run({
            status: "cancelled",
            phases: [
                { kind: "execute", state: "skipped", workerorefs: ["tab:a", "tab:b"] },
                { kind: "custom", state: "skipped", workerorefs: ["tab:b"] },
            ],
        });
        const agents = [agent({ id: "a", state: "working" }), agent({ id: "b", state: "asking" })];
        expect(cancelSurvivors(r, agents).map((w) => w.id)).toEqual(["a", "b"]);
    });
    it("excludes idle (already-exited) workers", () => {
        const r = run({ status: "cancelled", phases: [{ kind: "execute", state: "skipped", workerorefs: ["tab:a"] }] });
        expect(cancelSurvivors(r, [agent({ id: "a", state: "idle" })])).toEqual([]);
    });
    it("is empty for a non-cancelled run even with live workers", () => {
        const r = run({ status: "executing", phases: [{ kind: "execute", state: "running", workerorefs: ["tab:a"] }] });
        expect(cancelSurvivors(r, [agent({ id: "a", state: "working" })])).toEqual([]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/runmodel.test.ts -t cancelSurvivors`
Expected: FAIL — `cancelSurvivors is not a function` / import error.

- [ ] **Step 3: Write minimal implementation**

In `frontend/app/view/agents/runmodel.ts`, after `liveWorkers` (ends ~line 157), add:

```ts
// Live workers still running under a *cancelled* run — the survivors the partial-failure surface warns
// about. Empty for any non-cancelled run (a running run's live workers are normal, not survivors).
// Derived from the roster via liveWorkers, so it tracks reality: a survivor that later exits drops out; a
// resync-revived one reappears. No persisted survivor state.
export function cancelSurvivors(run: Run, agents: AgentVM[]): AgentVM[] {
    return run.status === "cancelled" ? liveWorkers(run, agents) : [];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/runmodel.test.ts -t cancelSurvivors`
Expected: PASS (3 tests).

- [ ] **Step 5: Verify (no commit)**

Run: `npx vitest run frontend/app/view/agents/runmodel.test.ts`
Expected: whole file PASS. Do NOT commit.

---

### Task 4: Frontend action + warning surface (runactions.ts + runbody.tsx)

The impure action wrapper + in-flight atom, the `CancelSurvivorsCard`, and the header-pill annotation. No unit test (render/impure) — verified by typecheck + the existing vitest suite staying green.

**Files:**
- Modify: `frontend/app/view/agents/runactions.ts` (add `stoppingWorkerIdsAtom` + `stopRunWorker`)
- Modify: `frontend/app/view/agents/runbody.tsx` (imports; `StatusPill` survivor annotation; `CancelSurvivorsCard`; render it in `OrchestratorBody` and pipeline `RunBody`)

**Interfaces:**
- Consumes: `RpcApi.StopRunWorkerCommand` (Task 2); `cancelSurvivors` (Task 3); existing `jumpToAgent(model, agentId)`, `fireAndForget`, `useAtomValue`, `TONE_CLASS`.
- Produces: `stopRunWorker(channelId, runId, workerORef)`, `stoppingWorkerIdsAtom`, `CancelSurvivorsCard`.

- [ ] **Step 1: Add the action + atom**

In `frontend/app/view/agents/runactions.ts`, after `cancellingRunIdsAtom` (ends ~line 25), add:

```ts
// Worker tab ids whose per-worker Stop RPC is in flight (partial-failure surface). Mirrors
// cancellingRunIdsAtom: StopRunWorkerCommand is synchronous, so this drives a transient "Stopping…" label
// on the survivor's Stop button. Frontend-only.
export const stoppingWorkerIdsAtom = atom<Set<string>>(new Set<string>());

// Stop one surviving worker of a cancelled run (partial-failure surface). workerORef is the worker's tab
// oref ("tab:<id>"). Tracks the in-flight tab id so the button reads "Stopping…"; the roster flips the
// row to idle on success, which drops it from cancelSurvivors.
export async function stopRunWorker(channelId: string, runId: string, workerORef: string): Promise<void> {
    const tabId = workerORef.startsWith("tab:") ? workerORef.slice(4) : workerORef;
    globalStore.set(stoppingWorkerIdsAtom, (prev) => new Set(prev).add(tabId));
    try {
        await RpcApi.StopRunWorkerCommand(TabRpcClient, { channelid: channelId, runid: runId, workeroref: workerORef });
    } finally {
        globalStore.set(stoppingWorkerIdsAtom, (prev) => {
            const next = new Set(prev);
            next.delete(tabId);
            return next;
        });
    }
}
```

- [ ] **Step 2: Wire imports in runbody.tsx**

In `frontend/app/view/agents/runbody.tsx`:
- Change the runactions import (line 32) to:
  ```ts
  import { approveGate, cancellingRunIdsAtom, confirmCancelRun, sendBackGate, stopRunWorker, stoppingWorkerIdsAtom } from "./runactions";
  ```
- Add `cancelSurvivors` to the runmodel import block (lines 33-48), alphabetically near `currentPhaseIndex`:
  ```ts
      cancelSurvivors,
  ```

- [ ] **Step 3: Annotate the header status pill**

In `frontend/app/view/agents/runbody.tsx`, replace `StatusPill` (lines 75-83) with:

```tsx
function StatusPill({ status, survivorCount = 0 }: { status: string; survivorCount?: number }) {
    const base = runStatusView(status);
    const label = survivorCount > 0 ? `${base.label} · ${survivorCount} still running` : base.label;
    const toneClass = survivorCount > 0 ? TONE_CLASS.blocked : (TONE_CLASS[base.tone] ?? "text-muted");
    return (
        <span className={"inline-flex items-center gap-1.5 font-mono text-[9px] font-semibold uppercase tracking-[.08em] " + toneClass}>
            <span className="h-1.5 w-1.5 rounded-full bg-current" />
            {label}
        </span>
    );
}
```

Then in `RunHeader` (line 410), replace `<StatusPill status={run.status} />` with:

```tsx
                        <StatusPill status={run.status} survivorCount={cancelSurvivors(run, agents).length} />
```

- [ ] **Step 4: Add `CancelSurvivorsCard`**

In `frontend/app/view/agents/runbody.tsx`, immediately before `BlockedCard` (line 290), add:

```tsx
// Partial-failure surface: on a *cancelled* run whose owned workers are still alive (the bulk kill missed
// one, or a resync revived it), the run must not read as a clean cancel. Renders nothing unless there are
// survivors; otherwise an error-toned card listing each survivor with Take control + a per-worker Stop.
// Derived from the live roster (cancelSurvivors), so a survivor that exits or is stopped drops out.
function CancelSurvivorsCard({ model, channelId, run, agents }: { model: AgentsViewModel; channelId: string; run: Run; agents: AgentVM[] }) {
    const stopping = useAtomValue(stoppingWorkerIdsAtom);
    const survivors = cancelSurvivors(run, agents);
    if (survivors.length === 0) {
        return null;
    }
    const n = survivors.length === 1 ? "1 worker" : `${survivors.length} workers`;
    return (
        <div className="relative mt-3 max-w-[760px] overflow-hidden rounded-lg border border-error/40 bg-error/10 px-4 py-3">
            <div className="mb-2 flex items-center gap-2">
                <span className="font-mono text-[12px] font-bold text-error">!</span>
                <span className="font-mono text-[9px] font-semibold uppercase tracking-[.08em] text-error">Cancelled · {n} still running</span>
            </div>
            <p className="mb-3 text-[12.5px] leading-[1.5] text-secondary">
                These workers didn't stop when the run was cancelled. Stop each to finish cancelling, or take control to inspect it.
            </p>
            <div className="flex flex-col gap-2">
                {survivors.map((w) => {
                    const busy = stopping.has(w.id);
                    return (
                        <div key={w.id} className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-secondary">{w.name}</span>
                            <button
                                type="button"
                                onClick={() => jumpToAgent(model, w.id)}
                                className="flex-none rounded border border-edge-mid px-3 py-1.5 text-[11.5px] font-semibold text-secondary hover:border-edge-strong"
                            >
                                Take control
                            </button>
                            <button
                                type="button"
                                disabled={busy}
                                onClick={() => fireAndForget(() => stopRunWorker(channelId, run.id, `tab:${w.id}`))}
                                className="flex-none rounded border border-error/50 px-3 py-1.5 text-[11.5px] font-semibold text-error hover:bg-error/10 disabled:opacity-60"
                            >
                                {busy ? "Stopping…" : "Stop"}
                            </button>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
```

- [ ] **Step 5: Render the card in both bodies**

In `OrchestratorBody`, immediately after the `<RunHeader … />` block (closes ~line 591), add:

```tsx
            <CancelSurvivorsCard model={model} channelId={channel.oid} run={run} agents={agents} />
```

In the pipeline `RunBody`, immediately after its `<RunHeader … />` block (closes ~line 793), add the same line:

```tsx
                    <CancelSurvivorsCard model={model} channelId={channel.oid} run={run} agents={agents} />
```

- [ ] **Step 6: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (clean baseline). Fix any reported error.

- [ ] **Step 7: Verify the suite is green (no commit)**

Run: `npx vitest run frontend/app/view/agents/runmodel.test.ts`
Expected: PASS. Do NOT commit.

---

### Task 5: Remove deferred entry, final verification, and the single commit

**Files:**
- Modify: `docs/deferred.md` (remove the "Cancel run — partial-failure warning surface" entry, lines 6-11)

- [ ] **Step 1: Remove the deferred entry**

In `docs/deferred.md`, delete the whole block:

```
## Cancel run — partial-failure warning surface (deferred 2026-07-14)
Spec: docs/superpowers/specs/2026-07-14-cancel-run-stops-workers-design.md (Addendum, "Deferred").
When a worker can't be stopped, the run should enter a visible warning state listing the survivors with
a per-worker stop action, and must not report a clean cancellation while owned workers are still active.
Requires reworking `stopRunWorkers`/`CancelRunCommand` from silent best-effort into failure-reporting
(a return value the FE can surface). Not built in the 2026-07-14 pass.
```

(Leave the file's intro lines 1-4 intact; the next entry "## Channel notes …" becomes the first entry.)

- [ ] **Step 2: Full verification gate (hard)**

Run all and confirm each:
- `go build ./...` → exit 0
- `go test ./pkg/jarvis/` → PASS
- `npx vitest run frontend/app/view/agents/runmodel.test.ts` → PASS
- `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → exit 0

- [ ] **Step 3: Live verification (best-effort, per repo norm)**

A genuinely un-killable backend survivor is hard to force (the kill blocks on `DoneCh`), so drive the **FE surface** in the dev app over CDP: get a `cancelled` run whose worker roster row is still non-idle (inject/fixture), then confirm (a) the header pill reads "cancelled · N still running" in error tone, (b) the `CancelSurvivorsCard` lists each survivor, (c) clicking Stop shows "Stopping…" and issues `StopRunWorkerCommand`. If a survivor state cannot be produced in the dev instance, record the limitation (matching the CDP-deferred entries already in `docs/deferred.md`); the pure tests + typecheck in Step 2 are the hard gate.

- [ ] **Step 4: STOP — request commit approval**

Do NOT commit until the user approves. When approved, stage everything and make ONE commit:

```bash
git add pkg/jarvis/resolve.go pkg/jarvis/resolve_test.go \
  pkg/wshrpc/wshrpctypes.go pkg/wshrpc/wshserver/wshserver.go \
  pkg/wshrpc/wshclient/wshclient.go frontend/app/store/wshclientapi.ts \
  frontend/app/view/agents/runmodel.ts frontend/app/view/agents/runmodel.test.ts \
  frontend/app/view/agents/runactions.ts frontend/app/view/agents/runbody.tsx \
  docs/deferred.md \
  docs/superpowers/specs/2026-07-15-cancel-run-partial-failure-surface-design.md \
  docs/superpowers/plans/2026-07-15-cancel-run-partial-failure-surface.md
git commit -m "feat(runs): surface cancel partial-failure with per-worker stop" \
  -m "A cancelled run whose owned workers are still alive now shows a warning (header pill + survivor card with per-worker Stop) instead of a clean cancellation. Roster-derived (cancelSurvivors over liveWorkers) — no persisted survivor state. Adds StopRunWorkerCommand guarded by jarvis.RunOwnsWorker."
```

(Spec + plan fold into this feature commit per the repo git workflow — no separate docs commit.)

---

## Self-Review

**Spec coverage:**
- "Never report a clean cancellation while owned workers active" → Task 3 (`cancelSurvivors`) + Task 4 Step 3 (header pill annotation). ✓
- "Visible warning listing survivors" → Task 4 Step 4/5 (`CancelSurvivorsCard`). ✓
- "Per-worker stop action" → Task 2 (`StopRunWorkerCommand`) + Task 4 Steps 1/4 (`stopRunWorker`, Stop button). ✓
- "Ownership guard (no arbitrary tab)" → Task 1 (`RunOwnsWorker`) + Task 2 Step 4. ✓
- "No new Run field / migration" → confirmed: no `waveobj` change; no `db/migrations-wstore` file. ✓
- "Remove deferred entry" → Task 5 Step 1. ✓

**Placeholder scan:** none — every code step carries full code; commands have expected output.

**Type consistency:** `cancelSurvivors(run, agents)` used identically in Tasks 3/4. `stopRunWorker(channelId, runId, workerORef)` and `stoppingWorkerIdsAtom` defined in Task 4 Step 1, consumed Step 4. `StopRunWorkerCommand` wire name `"stoprunworker"` and data `{channelid, runid, workeroref}` consistent across Task 2 (Go type/gen) and Task 4 (TS call). `RunOwnsWorker` signature identical Task 1 ↔ Task 2. `TONE_CLASS.blocked` reused for the survivor pill (defined line 56-64 of runbody.tsx). ✓

**Parallelism note:** Task 1 and Task 3 are independent (Go vs FE, both pure/TDD) and can run in parallel. Task 2 depends on Task 1; Task 4 depends on Tasks 2 (generated binding) and 3. Task 5 is last.
