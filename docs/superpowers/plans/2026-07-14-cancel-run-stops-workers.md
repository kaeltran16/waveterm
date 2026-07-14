# Cancel Run Stops Its Workers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "Cancel run" actually terminate the live Claude worker processes it spawned, durably, so a cancelled run is genuinely stopped rather than only relabelled.

**Architecture:** Add an impure `stopRunWorkers` helper (the mirror of the existing `spawnRunWorkers`) in `wshserver.go` that, for every phase's worker tab, flips `cmd:runonstart=false` on the block (so a later `ResyncController` can't revive it) and then calls `blockcontroller.DestroyBlockController` to kill the process. Wire it into `CancelRunCommand` after the existing state write. The pure state machine (`jarvis.CancelRun`) is unchanged.

**Tech Stack:** Go (`pkg/wshrpc/wshserver`, `pkg/blockcontroller`, `pkg/wstore`, `pkg/waveobj`); build via `task build:backend`; live verification via CDP against the dev app.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-14-cancel-run-stops-workers-design.md` — implement exactly the "kill the process, keep the tab" approach.
- Do **not** modify the pure `jarvis.CancelRun` — it stays state-only (phases→skipped, status→cancelled).
- No new wshrpc command, no `wshrpctypes.go`/schema change, no frontend change, no `task generate` run.
- No new imports in `wshserver.go` — `log`, `blockcontroller`, `wstore`, `wcore`, `waveobj` are already imported.
- `stopRunWorkers` is best-effort: every failure is logged with context and the loop continues; it never returns an error and never rolls back the already-persisted cancelled state.
- Commits require the human's explicit approval (per `CLAUDE.md`); batch into one commit at the end. The known-issues doc correction folds into that same feature commit — no standalone docs commit.
- Windows env: use PowerShell or the Bash tool per its own syntax; no PowerShell here-strings in the Bash tool for commit messages.

---

### Task 1: Terminate live workers on cancel

**Files:**
- Modify: `pkg/wshrpc/wshserver/wshserver.go` — add `stopRunWorkers`; call it from `CancelRunCommand` (currently lines ~1916–1929).
- Modify: `docs/agents/runs-pipeline-known-issues.md:~91` — correct the stale "CancelRun deletes the worker tab" claim.
- Test: no new Go unit test (see "Testing note" below); regression guard is the existing `pkg/jarvis` `TestCancelRunSkipsOpenPhases`, plus a backend build, plus live CDP verification.

**Interfaces:**
- Consumes (all already present in the codebase):
  - `wstore.GetRun(ctx, channelId, runId string) (*waveobj.Run, error)`
  - `wstore.DBMustGet[*waveobj.Tab](ctx, id string) (*waveobj.Tab, error)`
  - `wstore.UpdateObjectMeta(ctx, oref waveobj.ORef, meta waveobj.MetaMapType, mergeSpecial bool) error`
  - `blockcontroller.DestroyBlockController(blockId string)`
  - `waveobj.ParseORef`, `waveobj.MakeORef`, `waveobj.OType_Tab`, `waveobj.OType_Block`, `waveobj.MetaKey_CmdRunOnStart`
- Produces: `stopRunWorkers(ctx context.Context, run *waveobj.Run)` (package-private helper; only caller is `CancelRunCommand`).

**Testing note (read before starting):** The kill path is impure — it drives the in-memory block-controller registry and terminates OS processes — so it is not unit-tested in isolation, exactly like its sibling `spawnRunWorkers`/`SpawnClaudeWorker`, which have no unit tests for the same reason. Fabricating a test that pokes the controller registry would test internals, not behavior. The real acceptance test is Step 6 (drive the dev app and observe the process die and stay dead). Do not invent a Go unit test for `stopRunWorkers`.

- [ ] **Step 1: Confirm the state-contract regression guard passes before touching anything**

Run:
```
go test ./pkg/jarvis/ -run TestCancelRunSkipsOpenPhases -v
```
Expected: PASS. This is the guard that the pure `CancelRun` behavior must not change; you will re-run it in Step 5.

- [ ] **Step 2: Add the `stopRunWorkers` helper**

In `pkg/wshrpc/wshserver/wshserver.go`, immediately after `spawnRunWorkers` (ends ~line 1759), add:

```go
// stopRunWorkers terminates every live worker the run owns: for each phase WorkerOref (tab:<id>) it
// flips the block's cmd:runonstart off (so a later ResyncController can't relaunch the command) then
// destroys the block controller, which kills the claude process (the idle-on-exit backstop in
// shellcontroller then flips the roster row working->idle). Best-effort: an already-exited worker, a
// bad oref, or a meta-write failure is a logged no-op, never fatal — the run's cancelled state is
// already persisted. Workers spawn with cmd:runonstart defaulting true and no cmd:runonce, so the flip
// is required: without it, opening the tab (or a reload) would resync the block and revive the worker.
func stopRunWorkers(ctx context.Context, run *waveobj.Run) {
	for i := range run.Phases {
		for _, workerORef := range run.Phases[i].WorkerOrefs {
			oref, err := waveobj.ParseORef(workerORef)
			if err != nil || oref.OType != waveobj.OType_Tab {
				log.Printf("stopRunWorkers: bad worker oref %q: %v", workerORef, err)
				continue
			}
			tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, oref.OID)
			if err != nil {
				log.Printf("stopRunWorkers: loading tab %q: %v", workerORef, err)
				continue
			}
			for _, blockId := range tab.BlockIds {
				meta := waveobj.MetaMapType{waveobj.MetaKey_CmdRunOnStart: false}
				if merr := wstore.UpdateObjectMeta(ctx, waveobj.MakeORef(waveobj.OType_Block, blockId), meta, false); merr != nil {
					log.Printf("stopRunWorkers: clearing runonstart on block %s: %v", blockId, merr)
				}
				blockcontroller.DestroyBlockController(blockId)
			}
		}
	}
}
```

- [ ] **Step 3: Call it from `CancelRunCommand`**

Replace the existing `CancelRunCommand` body (~lines 1916–1929) with:

```go
func (ws *WshServer) CancelRunCommand(ctx context.Context, data wshrpc.CommandCancelRunData) error {
	if data.ChannelId == "" || data.RunId == "" {
		return fmt.Errorf("channelid and runid are required")
	}
	err := wstore.UpdateRun(ctx, data.ChannelId, data.RunId, func(r *waveobj.Run) error {
		*r = jarvis.CancelRun(*r)
		return nil
	})
	if err != nil {
		return fmt.Errorf("cancelling run: %w", err)
	}
	// stop the live workers the run spawned; state is already persisted, so this is best-effort.
	if run, gerr := wstore.GetRun(ctx, data.ChannelId, data.RunId); gerr == nil {
		stopRunWorkers(ctx, run)
	} else {
		log.Printf("CancelRun: reload for worker stop failed: %v", gerr)
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
	return nil
}
```

Rationale for re-reading the run (rather than capturing the update closure's `*r`): keeps the `WorkerOrefs` read outside the DB transaction, mirroring how `spawnRunWorkers` re-fetches after `AdvanceRunCommand`'s write.

- [ ] **Step 4: Vet + build the backend**

Run:
```
go vet ./pkg/wshrpc/wshserver/
task build:backend
```
Expected: `go vet` clean; `task build:backend` produces `dist/bin/wavesrv*` with no compile errors. (If the build reports an unused import or symbol, you added something the spec didn't call for — revert to exactly the code above.)

- [ ] **Step 5: Re-run the state-contract guard**

Run:
```
go test ./pkg/jarvis/ -run TestCancelRunSkipsOpenPhases -v
```
Expected: PASS (unchanged — you did not touch `jarvis.CancelRun`).

- [ ] **Step 6: Live verification (the real acceptance test) — drive the dev app over CDP**

This is the step that proves the goal; do not skip it. Prereqs: dev app running (`tail -f /dev/null | task dev` — headless `task dev` dies on stdin EOF), CDP on `:9222` (see `CLAUDE.md` "Visual verification"). `node scripts/cdp-shot.mjs` and `Runtime.evaluate` are the tools.

  1. Start a real run in a channel (pipeline or orchestrator) so a `claude` worker spawns. Confirm it is alive: roster row shows `working`, and a `claude` child process exists (PowerShell: `Get-CimInstance Win32_Process -Filter "Name='claude.exe' OR Name='node.exe'"` and match the worker's command line / cwd — the worker runs `claude --dangerously-skip-permissions <prompt>`).
  2. Click **Cancel run**.
  3. Assert **process gone:** the worker's `claude` process is no longer present, and the roster row flips `working → idle` (read the block's retained `agent:status` via the `eventreadhistory` RPC, as the run-worker hardening verification did).
  4. Assert **state correct:** the run renders `cancelled`; its open phases are `skipped` (read the run object via CDP or the channel atom).
  5. Assert **no revival (the whole reason for the `cmd:runonstart=false` flip):** open the cancelled worker's tab. `claude` must **not** relaunch — the terminal shows the finished/last transcript, no new process starts. Re-check the process list to confirm no new `claude` child appeared.

Record the results (before/after process list, roster status transition, the no-revival check) in the PR/commit description or `docs/agents/runs-pipeline-known-issues.md`. If any assertion fails, stop and debug — a failure here means the goal is not met regardless of a green build.

- [ ] **Step 7: Correct the stale known-issues note**

In `docs/agents/runs-pipeline-known-issues.md`, the parenthetical around line 91 currently reads (in effect) "`CancelRun` deletes the worker tab, in which case the roster row is removed." Replace it with the true behavior:

> `CancelRun` now stops each live worker's process (`stopRunWorkers`: `cmd:runonstart=false` + `DestroyBlockController`) and **keeps** the worker tab so its transcript stays inspectable; the idle-on-exit backstop flips the roster row `working → idle`.

Keep the surrounding sentence's meaning intact — only fix the incorrect tab-delete claim.

- [ ] **Step 8: Commit (only after the human approves)**

Do not commit without explicit approval (`CLAUDE.md`). When approved, one commit for the whole feature (code + doc correction + spec + this plan):

```
git add pkg/wshrpc/wshserver/wshserver.go docs/agents/runs-pipeline-known-issues.md docs/superpowers/specs/2026-07-14-cancel-run-stops-workers-design.md docs/superpowers/plans/2026-07-14-cancel-run-stops-workers.md
git commit -m "fix(runs): Cancel run terminates its live Claude workers" -m "CancelRunCommand now stops every worker the run spawned (cmd:runonstart=false + DestroyBlockController) so a cancelled run is genuinely stopped, not just relabelled. Keeps the worker tab (transcript inspectable); idle-on-exit backstop flips the roster row to idle. Pure jarvis.CancelRun unchanged."
```

---

### Task 2: Cancel confirmation + "Cancelling…" state (frontend)

Implements the spec Addendum items 1 & 2. Reuses the existing `ConfirmModal` and the `state !== "idle"`
liveness convention. No backend change. See the spec Addendum for rationale.

**Files:**
- Modify: `frontend/app/view/agents/runmodel.ts` — add pure `liveWorkers`.
- Test: `frontend/app/view/agents/runmodel.test.ts` — `liveWorkers` unit tests.
- Modify: `frontend/app/view/agents/runactions.ts` — `cancellingRunIdsAtom`, wrap `cancelRun`, add `confirmCancelRun`.
- Modify: `frontend/app/view/agents/runbody.tsx` — shared `CancelRunButton`; replace 3 inline buttons; thread `agents` into `BlockedCard`.
- Create: `docs/deferred.md` (append if it exists) — record the deferred partial-failure warning surface.

**Interfaces:**
- Consumes: `phaseWorkers(phase, agents)` and `isTerminal` (runmodel.ts, existing); `AgentVM` / `AgentState = "asking"|"working"|"idle"` (agentsviewmodel.ts); `modalsModel.pushModal("ConfirmModal", {title,message,confirmLabel,cancelLabel,destructive,onConfirm})` (established pattern, see `agentactions.ts:17`); `globalStore` (store/jotaiStore), `fireAndForget` (util/util); `useAtomValue` (jotai).
- Produces:
  - `liveWorkers(run: Run, agents: AgentVM[]): AgentVM[]`
  - `cancellingRunIdsAtom` (jotai `PrimitiveAtom<Set<string>>`)
  - `confirmCancelRun(channelId: string, runId: string, liveCount: number): void`
  - `CancelRunButton` (module-private component in runbody.tsx)

- [ ] **Step 1: Write the failing test for `liveWorkers`**

Add to `frontend/app/view/agents/runmodel.test.ts` (the file already has `run(...)`, `phase(...)`, `agent(...)` fixture helpers and imports from `./runmodel`). Add `liveWorkers` to the existing import block from `./runmodel`, then append:

```ts
describe("liveWorkers", () => {
    it("returns recorded workers whose roster row is not idle, deduped across phases", () => {
        const r = run({
            phases: [
                { kind: "plan", state: "done", workerorefs: ["tab:a"] },
                { kind: "execute", state: "running", workerorefs: ["tab:b", "tab:c"] },
            ],
        });
        const agents = [
            agent({ id: "a", state: "idle" }),
            agent({ id: "b", state: "working" }),
            agent({ id: "c", state: "asking" }),
        ];
        expect(liveWorkers(r, agents).map((w) => w.id)).toEqual(["b", "c"]);
    });
    it("is empty when every recorded worker is idle or gone (blocked · worker exited)", () => {
        const r = run({ phases: [{ kind: "execute", state: "running", workerorefs: ["tab:a", "tab:gone"] }] });
        expect(liveWorkers(r, [agent({ id: "a", state: "idle" })])).toEqual([]);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/runmodel.test.ts -t liveWorkers`
Expected: FAIL — `liveWorkers is not a function` (or import error).

- [ ] **Step 3: Implement `liveWorkers`**

In `frontend/app/view/agents/runmodel.ts`, add after `phaseWorkers` (ends ~line 142):

```ts
// Live workers a cancel would stop: recorded workers with a roster row whose state is not idle (an
// exited worker reports idle via the backend backstop; a torn-down one has no row at all). Deduped by
// id across phases. Gates the cancel confirmation (zero → cancel directly) and sizes its copy.
export function liveWorkers(run: Run, agents: AgentVM[]): AgentVM[] {
    const out: AgentVM[] = [];
    for (const phase of run.phases ?? []) {
        for (const w of phaseWorkers(phase, agents)) {
            if (w.state !== "idle" && !out.some((o) => o.id === w.id)) {
                out.push(w);
            }
        }
    }
    return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/runmodel.test.ts -t liveWorkers`
Expected: PASS (both cases).

- [ ] **Step 5: Add the cancelling-state atom, wrap `cancelRun`, add `confirmCancelRun`**

In `frontend/app/view/agents/runactions.ts`: add two imports near the existing imports:

```ts
import { modalsModel } from "@/app/store/modalmodel";
import { fireAndForget } from "@/util/util";
```

Add the atom after `pendingRunDraftAtom` (~line 17):

```ts
// Run ids whose Cancel RPC is in flight. CancelRunCommand is synchronous — it returns only after each
// worker's graceful stop completes — so this real interval drives the transient "Cancelling…" button
// label until the run flips to cancelled. Frontend-only (lost on reload, which lands on the already-
// cancelled run).
export const cancellingRunIdsAtom = atom<Set<string>>(new Set<string>());
```

Replace the existing `cancelRun` (~lines 54-56) with the tracked version, and add `confirmCancelRun` right after it:

```ts
export async function cancelRun(channelId: string, runId: string): Promise<void> {
    globalStore.set(cancellingRunIdsAtom, (prev) => new Set(prev).add(runId));
    try {
        await RpcApi.CancelRunCommand(TabRpcClient, { channelid: channelId, runid: runId });
    } finally {
        globalStore.set(cancellingRunIdsAtom, (prev) => {
            const next = new Set(prev);
            next.delete(runId);
            return next;
        });
    }
}

// Cancel a run, confirming first when it has live workers (goal: never silently stop running agents).
// liveCount 0 (e.g. the worker already exited — the "blocked · worker exited" card) cancels directly.
// Copy reassures that completed work is kept: the backend stops the processes but keeps worker tabs,
// transcripts, and completed phases.
export function confirmCancelRun(channelId: string, runId: string, liveCount: number): void {
    const doCancel = () => fireAndForget(() => cancelRun(channelId, runId));
    if (liveCount <= 0) {
        doCancel();
        return;
    }
    const n = liveCount === 1 ? "1 running worker" : `${liveCount} running workers`;
    modalsModel.pushModal("ConfirmModal", {
        title: "Cancel run",
        message: `Stop ${n} and cancel this run? Completed phases, transcripts, and artifacts are kept.`,
        confirmLabel: "Cancel run",
        cancelLabel: "Keep running",
        destructive: true,
        onConfirm: doCancel,
    });
}
```

Note: `atom`, `globalStore`, `RpcApi`, `TabRpcClient` are already imported in this file. `atom` is imported from `jotai` (existing import line).

- [ ] **Step 6: Add `CancelRunButton` and replace the three inline buttons in `runbody.tsx`**

In `frontend/app/view/agents/runbody.tsx`:

(a) Update imports:
- The runactions import (currently `import { approveGate, cancelRun, sendBackGate } from "./runactions";`) becomes:
  `import { approveGate, cancellingRunIdsAtom, confirmCancelRun, sendBackGate } from "./runactions";`
- Add `liveWorkers` to the existing `./runmodel` import block.
- Ensure `useAtomValue` is imported from `jotai` (add it to the existing jotai import; if there is no jotai import yet, add `import { useAtomValue } from "jotai";`).

(b) Add this module-private component (place it just above `BlockedCard`, ~line 269):

```tsx
// The run's Cancel control: confirms before stopping live workers, and shows a transient "Cancelling…"
// (disabled) while the synchronous CancelRunCommand waits out each worker. `className` carries each call
// site's own styling; the disabled affordance is shared.
function CancelRunButton({ channelId, run, agents, className }: { channelId: string; run: Run; agents: AgentVM[]; className: string }) {
    const cancelling = useAtomValue(cancellingRunIdsAtom).has(run.id);
    return (
        <button
            type="button"
            disabled={cancelling}
            onClick={() => confirmCancelRun(channelId, run.id, liveWorkers(run, agents).length)}
            className={`${className} disabled:opacity-60`}
        >
            {cancelling ? "Cancelling…" : "Cancel run"}
        </button>
    );
}
```

(c) `BlockedCard` — add `agents` to its props so it can render `CancelRunButton`. Change its signature to:
`function BlockedCard({ model, channelId, run, worker, agents }: { model: AgentsViewModel; channelId: string; run: Run; worker?: AgentVM; agents: AgentVM[] }) {`
and replace its inline "Cancel run" button (~lines 289-295) with:
```tsx
                <CancelRunButton
                    channelId={channelId}
                    run={run}
                    agents={agents}
                    className="rounded border border-edge-mid px-3 py-2 text-[12px] font-semibold text-muted hover:border-error hover:text-error"
                />
```
Update both `<BlockedCard .../>` call sites to pass `agents={agents}` (line ~565 in `OrchestratorBody`, line ~654 in `PhaseRail` — both scopes already have `agents` in scope).

(d) `OrchestratorBody` footer — replace the inline button (~lines 568-574) with:
```tsx
                <CancelRunButton
                    channelId={channel.oid}
                    run={run}
                    agents={agents}
                    className="mt-4 flex-none self-start rounded border border-edge-mid px-3 py-1.5 text-[11.5px] font-semibold text-muted hover:border-error hover:text-error"
                />
```
(keep the surrounding `{!isTerminal(run.status) ? (...) : null}` guard — a terminal run shows no cancel).

(e) `RunBody` (pipeline) footer — replace the inline button (~lines 758-764) with:
```tsx
                    <CancelRunButton
                        channelId={channel.oid}
                        run={run}
                        agents={agents}
                        className="mt-4 rounded border border-edge-mid px-3 py-1.5 text-[11.5px] font-semibold text-muted hover:border-error hover:text-error"
                    />
```
(keep the surrounding `{!isTerminal(run.status) ? (...) : null}` guard).

- [ ] **Step 7: Typecheck and run the frontend suite**

Run (the tsc gotcha — plain `npx tsc` stack-overflows on this repo):
```
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
npx vitest run frontend/app/view/agents/runmodel.test.ts
```
Expected: tsc exits 0 (clean baseline — any error it reports is yours); vitest passes including the two new `liveWorkers` cases. If tsc flags an unused `cancelRun` import in runbody.tsx, remove `cancelRun` from that file's import (it is now only used via `CancelRunButton` → `confirmCancelRun`); do not remove the `cancelRun` export from runactions.ts (confirmCancelRun calls it).

- [ ] **Step 8: Record the deferred item**

Append to `docs/deferred.md` (create it with a `# Deferred` heading if absent):
```markdown
## Cancel run — partial-failure warning surface (deferred 2026-07-14)
Spec: docs/superpowers/specs/2026-07-14-cancel-run-stops-workers-design.md (Addendum, "Deferred").
When a worker can't be stopped, the run should enter a visible warning state listing the survivors with
a per-worker stop action, and must not report a clean cancellation while owned workers are still active.
Requires reworking `stopRunWorkers`/`CancelRunCommand` from silent best-effort into failure-reporting
(a return value the FE can surface). Not built in the 2026-07-14 pass.
```

- [ ] **Step 9: Manual/live verification (deferred with Task 1 Step 6)**

The dialog interaction and "Cancelling…" transition are UI behaviors best confirmed live over CDP (start a run → click Cancel → confirm dialog copy + count → button reads "Cancelling…" during the RPC → run flips to "cancelled"). This is deferred to the same live-verification pass as Task 1 Step 6, per the user's instruction to defer live CDP. The pure `liveWorkers` logic is covered by Step 1–4 tests; tsc covers the wiring.

- [ ] **Step 10: Commit (only after the human approves)**

Fold into the single feature commit with Task 1 (see Task 1 Step 8 — add the Task 2 files to the same commit).

---

## Self-Review

**1. Spec coverage:**
- "Terminate every live worker on cancel, durably" → Task 1 Steps 2–3 (`stopRunWorkers` + wiring).
- "Kill the process, keep the tab" → `DestroyBlockController` (no `DeleteTab`); tab left in place. ✓
- "Revival trap: flip `cmd:runonstart=false`" → Step 2 sets the meta before destroy. ✓
- "Pure `jarvis.CancelRun` unchanged; kill lives in the command" → only `wshserver.go` changes; Steps 1 & 5 guard the pure test. ✓
- "Best-effort, never fatal, logged" → helper logs every branch, returns nothing, runs after the committed write. ✓
- "Roster row goes idle via idle-on-exit backstop" → verified in Step 6.3 (no code needed; backstop already exists). ✓
- "No UI/RPC/schema/codegen change" → Global Constraints + Task 1 scope. ✓
- "Correct the stale known-issues doc" → Step 7. ✓
- "Live CDP verification incl. no-revival" → Step 6. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code; the "no unit test" decision is stated explicitly with its rationale rather than hidden. ✓

**3. Type consistency:** `stopRunWorkers(ctx, run *waveobj.Run)` matches `wstore.GetRun`'s `*waveobj.Run` return (same type `spawnRunWorkers` feeds to `EnsureWorkers`). `waveobj.MetaMapType{...}` matches `UpdateObjectMeta`'s param. `DestroyBlockController(blockId string)` takes the raw block id (not an oref), as used elsewhere in the file. All symbols referenced exist and are already imported. ✓
