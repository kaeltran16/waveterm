# Orchestrator R15, R16, F16 Implementation Plan

**Verify:** `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" node scripts/verify.mjs ./pkg/orchestrate/... ./pkg/wshrpc/... ./cmd/wsh/...`
**Setup:** `task worktree:prepare`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && go vet ./pkg/orchestrate/... ./pkg/wshrpc/... ./cmd/wsh/... && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /dev/null ./cmd/wsh/`
**Final:** `node scripts/cdp/final-verify.mjs surface-smoke`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the last three small orchestrator items: stop a terminal step with no status from reading as "done" (R15), close R16 as obsolete, and render how long a merge gate has sat, in `wsh jarvis dag status` and on the lead card (F16).

**Architecture:** The digest (`pkg/orchestrate/digest.go`) gains one per-task timestamp, `MergeGateTs`. It comes from the same retained task-done boundary the stale-gate check already uses, through one shared helper. The CLI and the lead card each format an age from that timestamp against their own clock. R15 is a frontend guard plus a Go test. R16 and the tracker updates are docs only.

**Tech Stack:** Go (digest, wsh CLI), `task generate` (Go → TS types), TypeScript + vitest (pure models).

**Spec:** `docs/superpowers/specs/2026-09-27-orchestrator-r15-r16-f16-design.md`

## Global Constraints

- Never hand-edit generated files (`frontend/types/gotypes.d.ts` and the others `task generate` writes). Edit the Go type, then run `task generate`.
- Frontend logic lives in a pure `.ts` with a `.test.ts` beside it. No jsdom render tests.
- Colors come from `@theme` tokens only. The new lead-card row uses the existing `wait` tone and adds no color.
- `gofmt`/`prettier --check` only the files you touched; never `--write` the tree.
- The typecheck is `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (`npx tsc` stack-overflows). Give it more than 2 minutes.
- Go tests touching sqlite need `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu"`. `pkg/orchestrate` digest tests are pure, but use the same env to be safe.
- A gate with no clock (`MergeGateTs == 0`) shows `merge waiting` with no age, never `0s` or an age measured from the epoch.
- Commit messages: `type(scope): description`, with no attribution trailers.

## Review Focus

- A gate whose done event was pruned: CLI and card both show `merge waiting` with no age (tests in Task 2 and Task 3).
- The cockpit clock is behind wavesrv's (`now < mergegatets`): the card shows `merge waiting` with no age, never a negative age (test in Task 3). The CLI gets this for free from `compactDur` returning `""` for ≤ 0 (test in Task 2).
- A done task that is merged, a DAG without MergeRequired, or a run whose digest has not loaded: the row still reads `landed` in the Done fold (test in Task 3).
- A non-tip task in a finished-but-unmerged lane carries no `MergeGateTs`: only the tip is the gate (test in Task 2).
- A terminal step from a `cancelled` DAG carries `cancelled`, and an empty one never renders as `done` (tests in Task 1).

---

### Task 1: R15 — a terminal step with no status is a contract error, not "done"
**Depends on:** none

**Files:**
- Modify: `frontend/app/view/orchestrate/dagdigest.ts` (the `case "terminal":` in `nextStepText`, ~line 140)
- Test: `frontend/app/view/orchestrate/dagdigest.test.ts` (the `describe("nextStepText"` block, ~line 66)
- Test: `pkg/orchestrate/digest_test.go` (beside `TestNextTerminal`, ~line 422)

**Interfaces:** none consumed or produced.

- [ ] **Step 1: Write the failing vitest.** Add inside `describe("nextStepText", ...)`:

```ts
    // buildNext always names the status it ended in; a terminal step without one broke the digest contract,
    // and reading it as "done" would tell the human a run finished cleanly when nothing said so
    it("reports a terminal step with no status as a contract error, never as done", () => {
        expect(nextStepText({ kind: "terminal" })).toBe("finished with no status (digest contract error)");
        expect(nextStepText({ kind: "terminal", terminalstatus: "" })).toBe(
            "finished with no status (digest contract error)"
        );
        expect(nextStepText({ kind: "terminal", terminalstatus: "cancelled" })).toBe("finished (cancelled)");
    });
```

- [ ] **Step 2: Run it and watch it fail.**
Run: `npx vitest run frontend/app/view/orchestrate/dagdigest.test.ts -t "contract error"`
Expected: FAIL (`"finished (done)"` and `"finished ()"`, not the contract error).

- [ ] **Step 3: Implement.** In `nextStepText` in `dagdigest.ts`, replace

```ts
        case "terminal":
            return `finished (${next.terminalstatus ?? "done"})`;
```

with

```ts
        case "terminal":
            return next.terminalstatus ? `finished (${next.terminalstatus})` : "finished with no status (digest contract error)";
```

Then run `npx prettier --check frontend/app/view/orchestrate/dagdigest.ts`. If it is not clean, wrap the ternary the way prettier wants: run `npx prettier --write` on **this file only**, and revert any hunk outside this case.

- [ ] **Step 4: Add the Go test pinning the cancelled terminal status.** Below `TestNextTerminal` in `pkg/orchestrate/digest_test.go`:

```go
// buildNext's terminal step is the lead's stop signal and always names the status the dag ended in; a
// consumer that finds it empty reports a contract error rather than inventing one (R15).
func TestNextTerminalCancelledCarriesItsStatus(t *testing.T) {
	g := digestGroup(t, false, plainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_Cancelled, "t-1": TaskState_Cancelled, "t-2": TaskState_Cancelled})
	g.Status = DagStatus_Cancelled
	d := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow))
	if d.Next.Kind != "terminal" || d.Next.TerminalStatus != DagStatus_Cancelled {
		t.Fatalf("cancelled dag must be terminal next with its status, got %+v", d.Next)
	}
}
```

(`g.Status` is set after `setTaskStates` because `RecomputeDagStatus` does not derive `cancelled`; cancel is an explicit transition.)

- [ ] **Step 5: Run both suites and confirm they pass.**
Run: `npx vitest run frontend/app/view/orchestrate/dagdigest.test.ts` and `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go test ./pkg/orchestrate/ -run 'TestNextTerminal' -v`
Expected: PASS. The Go test passes on first run: it pins existing behavior, and that is its purpose.

- [ ] **Step 6: Commit.**

```bash
git add frontend/app/view/orchestrate/dagdigest.ts frontend/app/view/orchestrate/dagdigest.test.ts pkg/orchestrate/digest_test.go
git commit -m "fix(orchestrate): report a terminal step with no status as a contract error"
```

### Task 2: F16 — the digest carries the merge gate's clock; `dag status` shows its age
**Depends on:** none

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_dag.go` (`DagTaskDigest`, ~line 198)
- Modify: `pkg/orchestrate/digest.go` (`BuildDigest` ~line 43, `staleMergeGates` ~line 146, `buildTaskDigest` ~line 483)
- Modify: `cmd/wsh/cmd/wshcmd-jarvisdag.go` (`taskSignal`, ~line 255)
- Regenerated (do not hand-edit): `frontend/types/gotypes.d.ts` via `task generate`
- Test: `pkg/orchestrate/digest_test.go` (beside `TestStaleMergeGateNeedsYou`, ~line 744)
- Test: `cmd/wsh/cmd/wshcmd-jarvisdag_test.go` (beside `TestDagStatusShowsARunningVerifysAgeAndLatestLine`, ~line 417)

**Interfaces:**
- Produces: `wshrpc.DagTaskDigest.MergeGateTs int64` with JSON tag `mergegatets,omitempty`, which appears in TS as `mergegatets?: number` on `DagTaskDigest`. It is the UnixMilli of the retained task-done event of a merge-ready lane tip, and 0 otherwise. Task 3 reads it.
- Produces (package-private): `func mergeGateClock(g *waveobj.TaskGroup, retained []waveobj.RunEvent) map[string]int64`.

- [ ] **Step 1: Write the failing digest tests.** Add below `TestMergeGateWithoutDoneEventIsNotStale` in `pkg/orchestrate/digest_test.go`:

```go
// The gate's age is rendered by the CLI and the cockpit, so the digest carries the clock it is aged from:
// the same retained task-done boundary the stale check reads, and only on the lane tip that is the gate.
func TestMergeGateTsIsTheDoneBoundaryOfTheGate(t *testing.T) {
	g := digestGroup(t, true, []waveobj.TaskNode{{ID: "t-0", Label: "a"}, {ID: "t-1", Label: "b"}})
	setTaskStates(g, map[string]string{"t-0": TaskState_Done, "t-1": TaskState_Done})
	g.Tasks[1].Merged = true
	now := time.Now()
	doneTs := now.Add(-34 * time.Minute).UnixMilli()
	d := BuildDigest(DagDigestSnapshot{
		Group: g,
		Retained: []waveobj.RunEvent{
			retainedEvent(waveobj.RunEventKindTaskDone, "t-0", doneTs),
			retainedEvent(waveobj.RunEventKindTaskDone, "t-1", doneTs),
		},
		Now: now,
	})
	if d.Tasks[0].MergeGateTs != doneTs {
		t.Fatalf("an open gate carries its done boundary, got %d want %d", d.Tasks[0].MergeGateTs, doneTs)
	}
	if d.Tasks[1].MergeGateTs != 0 {
		t.Fatalf("a merged task has no open gate, got %d", d.Tasks[1].MergeGateTs)
	}
}

// Pruned history leaves the gate with no clock: no timestamp, so nothing renders an age from the epoch.
func TestMergeGateTsIsZeroWithoutADoneEvent(t *testing.T) {
	g := digestGroup(t, true, []waveobj.TaskNode{{ID: "t-0", Label: "a"}})
	setTaskStates(g, map[string]string{"t-0": TaskState_Done})
	d := BuildDigest(DagDigestSnapshot{Group: g, Now: time.Now()})
	if d.Tasks[0].MergeState != "ready" || d.Tasks[0].MergeGateTs != 0 {
		t.Fatalf("a ready gate with no done event has no clock, got state %q ts %d", d.Tasks[0].MergeState, d.Tasks[0].MergeGateTs)
	}
}

// A lane merges as one at its tip; an earlier task in the lane is not a gate and carries no clock.
func TestMergeGateTsOnlyOnTheLaneTip(t *testing.T) {
	g := digestGroup(t, true, []waveobj.TaskNode{{ID: "t-0", Label: "a"}, {ID: "t-1", Label: "b", Deps: []string{"t-0"}}})
	setTaskStates(g, map[string]string{"t-0": TaskState_Done, "t-1": TaskState_Done})
	now := time.Now()
	d := BuildDigest(DagDigestSnapshot{
		Group: g,
		Retained: []waveobj.RunEvent{
			retainedEvent(waveobj.RunEventKindTaskDone, "t-0", now.Add(-40*time.Minute).UnixMilli()),
			retainedEvent(waveobj.RunEventKindTaskDone, "t-1", now.Add(-5*time.Minute).UnixMilli()),
		},
		Now: now,
	})
	if d.Tasks[0].MergeGateTs != 0 {
		t.Fatalf("a non-tip lane task is not the gate, got ts %d", d.Tasks[0].MergeGateTs)
	}
	if d.Tasks[1].MergeGateTs == 0 {
		t.Fatalf("the lane tip is the gate and carries its clock")
	}
}
```

Before relying on `TestMergeGateTsOnlyOnTheLaneTip`, confirm that `t-0 → t-1` forms one lane in `jarvis.Lanes` (a linear chain does). If the assertion on `d.Tasks[1]` fails because `MergeState` is not `ready`, print `d.Tasks` and fix the fixture, not the product code.

- [ ] **Step 2: Run them and watch them fail to compile** (`MergeGateTs` does not exist yet).
Run: `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go test ./pkg/orchestrate/ -run 'TestMergeGateTs' -v`
Expected: build failure, `d.Tasks[0].MergeGateTs undefined`.

- [ ] **Step 3: Add the field.** In `DagTaskDigest` (`pkg/wshrpc/wshrpctypes_dag.go`), directly after `VerifyLastLine`:

```go
	MergeGateTs      int64    `json:"mergegatets,omitempty"`     // UnixMilli an open merge gate's clock started (the lane tip's task-done); 0 with no gate or no clock
```

Align the struct with `gofmt -w pkg/wshrpc/wshrpctypes_dag.go`, a file you touched.

- [ ] **Step 4: One clock, two readers.** In `pkg/orchestrate/digest.go`, replace `staleMergeGates` with:

```go
// mergeGateClock maps each merge-ready lane tip to the start of its gate: the retained task-done boundary. A
// task whose done event has been pruned has no clock and is left out. The stale check and the rendered age both
// read this map, so they cannot disagree on when a gate opened.
func mergeGateClock(g *waveobj.TaskGroup, retained []waveobj.RunEvent) map[string]int64 {
	clock := map[string]int64{}
	for _, id := range mergeReadyIDs(g) {
		if doneTs := firstTaskEventTs(retained, waveobj.RunEventKindTaskDone, id, true); doneTs > 0 {
			clock[id] = doneTs
		}
	}
	return clock
}

// staleMergeGates returns the gates open past MergeGateStaleAfter. A gate with no clock is left out: a missed
// escalation costs a timeout, a fabricated one raises a false alarm on live work.
func staleMergeGates(gateClock map[string]int64, now time.Time) map[string]bool {
	stale := map[string]bool{}
	for id, doneTs := range gateClock {
		if now.UnixMilli()-doneTs > MergeGateStaleAfter.Milliseconds() {
			stale[id] = true
		}
	}
	return stale
}
```

In `BuildDigest`, replace `staleGate := staleMergeGates(g, sn.Retained, sn.Now)` with:

```go
	gateClock := mergeGateClock(g, sn.Retained)
	staleGate := staleMergeGates(gateClock, sn.Now)
```

In the task loop of `BuildDigest`, after `td := buildTaskDigest(...)`, add:

```go
		td.MergeGateTs = gateClock[g.Tasks[i].ID]
```

Grep for any other `staleMergeGates(` caller (`grep -rn "staleMergeGates(" pkg`) and update it to the new signature.

- [ ] **Step 5: Run the digest tests, new and existing stale-gate ones.**
Run: `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go test ./pkg/orchestrate/ -run 'MergeGate|StaleMergeGate' -v`
Expected: PASS, including the unchanged `TestStaleMergeGateNeedsYou`, `TestFreshMergeGateStaysHealthy` and `TestMergeGateWithoutDoneEventIsNotStale`.

- [ ] **Step 6: Regenerate bindings.** Run `task generate`. Confirm with `git diff --stat` that `frontend/types/gotypes.d.ts` gained `mergegatets?: number;` on `DagTaskDigest`. Keep any other generated diff only if it comes from this change.

- [ ] **Step 7: Write the failing CLI test.** Add below `TestDagStatusShowsARunningVerifysAgeAndLatestLine` in `cmd/wsh/cmd/wshcmd-jarvisdag_test.go`:

```go
// a merge gate open past its threshold turns health to needs-you; this row is where the lead reads how long
// it has sat. A gate whose done event was pruned has no clock and shows no age, never one from the epoch.
func TestDagStatusShowsHowLongAMergeGateHasSat(t *testing.T) {
	g := &waveobj.TaskGroup{ID: "d-1", Status: "running", Parallelism: 2, Tasks: []waveobj.TaskNode{
		{ID: "t-0", Label: "first", State: "done"},
		{ID: "t-1", Label: "second", State: "done"},
		{ID: "t-2", Label: "third", State: "done"},
	}}
	now := int64(40 * 60_000)
	rtn := &wshrpc.CommandDagStatusRtnData{Group: g, Digest: wshrpc.DagStatusDigest{
		Tasks: []wshrpc.DagTaskDigest{
			{TaskId: "t-0", MergeState: "ready", MergeGateTs: now - 34*60_000},
			{TaskId: "t-1", MergeState: "ready"},
			{TaskId: "t-2", MergeState: "merged"},
		},
	}}
	lines := dagStatusLines(rtn, now)
	joined := strings.Join(lines, "\n")
	if !strings.Contains(joined, "t-0  done  merge waiting 34m") {
		t.Fatalf("an open gate shows its age, got:\n%s", joined)
	}
	for _, l := range lines {
		if strings.HasPrefix(l, "t-1 ") && !strings.Contains(l, "merge waiting") {
			t.Fatalf("a gate with no clock still shows it is waiting, got %q", l)
		}
		if strings.HasPrefix(l, "t-2 ") && strings.Contains(l, "merge waiting") {
			t.Fatalf("a merged task is not waiting, got %q", l)
		}
	}
}

// the signal alone, because tabwriter pads the column and a row cannot show where the signal text ends
func TestMergeGateSignalShowsNoAgeWithoutAClock(t *testing.T) {
	now := int64(40 * 60_000)
	for name, ts := range map[string]int64{"pruned": 0, "skewed ahead of this clock": now + 5_000} {
		if got := mergeGateSignal(wshrpc.DagTaskDigest{MergeState: "ready", MergeGateTs: ts}, now); got != "merge waiting" {
			t.Fatalf("%s gate must show no age, got %q", name, got)
		}
	}
}
```

The row assertion assumes tabwriter's padding (minwidth 0, padding 2) and all three states being `done`. Run the test once. If only the padding differs, match the assertion to the real row, which contains `merge waiting 34m`. Do not change the renderer to fit the string.

- [ ] **Step 8: Run it and watch it fail.**
Run: `go test ./cmd/wsh/cmd/ -run 'TestDagStatusShowsHowLongAMergeGateHasSat|TestMergeGateSignal' -v`
Expected: build failure, `undefined: mergeGateSignal`. After Step 9 both pass.

- [ ] **Step 9: Implement the CLI signal.** In `taskSignal` (`cmd/wsh/cmd/wshcmd-jarvisdag.go`), add a case before the closing `}` of the `switch`, after the `td.FreshnessTs > 0 && ...` case:

```go
	case td.MergeState == "ready":
		return mergeGateSignal(td, now)
```

and add below `verifySignal`:

```go
// mergeGateSignal is how long a finished lane has waited to land. The digest carries the gate's clock, so this
// row and the cockpit's agree; a gate whose done event was pruned has none and shows no age.
func mergeGateSignal(td wshrpc.DagTaskDigest, now int64) string {
	if td.MergeGateTs > 0 {
		if age := compactDur(now - td.MergeGateTs); age != "" {
			return "merge waiting " + age
		}
	}
	return "merge waiting"
}
```

- [ ] **Step 10: Run the CLI and digest suites.**
Run: `go test ./cmd/wsh/cmd/ -run 'DagStatus' -v` and `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go test ./pkg/orchestrate/ ./pkg/wshrpc/...`
Expected: PASS. Then `gofmt -l pkg/orchestrate/digest.go pkg/orchestrate/digest_test.go pkg/wshrpc/wshrpctypes_dag.go cmd/wsh/cmd/wshcmd-jarvisdag.go cmd/wsh/cmd/wshcmd-jarvisdag_test.go` prints nothing.

- [ ] **Step 11: Commit.**

```bash
git add pkg/wshrpc/wshrpctypes_dag.go pkg/orchestrate/digest.go pkg/orchestrate/digest_test.go cmd/wsh/cmd/wshcmd-jarvisdag.go cmd/wsh/cmd/wshcmd-jarvisdag_test.go frontend/types/gotypes.d.ts
git commit -m "feat(orchestrate): show how long a merge gate has sat in dag status"
```

### Task 3: F16 — the lead card shows a waiting merge gate and its age
**Depends on:** Task 2

**Files:**
- Modify: `frontend/app/view/agents/leadcardmodel.ts` (the `case "done":` in `taskRow`, plus a new exported helper)
- Test: `frontend/app/view/agents/leadcardmodel.test.ts`

**Interfaces:**
- Consumes: `DagTaskDigest.mergegatets?: number` and `DagTaskDigest.mergestate: string` (from Task 2's regenerated `frontend/types/gotypes.d.ts`).
- Produces: `export function mergeWaitTag(mergeGateTs: number | undefined, now: number): string`.

- [ ] **Step 1: Write the failing tests.** Add `mergeWaitTag` to the import list from `"./leadcardmodel"` in `leadcardmodel.test.ts`. Add inside `describe("buildLeadCard", ...)`:

```ts
    // a finished lane that has not landed is not "landed": it waits on the merge, visibly, with how long it has sat
    it("lifts a merge-ready task out of Done and tags it with the gate's age", () => {
        const run = runInfo([task("t1", "done"), task("t2", "done")], {
            tasks: [
                { taskid: "t1", mergestate: "ready", mergegatets: NOW - 34 * 60_000 } as DagTaskDigest,
                { taskid: "t2", mergestate: "merged" } as DagTaskDigest,
            ],
        });
        const vm = buildLeadCard(input(run));
        expect(vm.rows.map((r) => r.taskId)).toEqual(["t1"]);
        expect(vm.rows[0]).toMatchObject({ tag: "merge waiting 34m", tone: "wait", needsYou: false, actions: [] });
        expect(vm.rows[0].sub).toBe("t1 · merge ready");
        expect(vm.done.map((r) => r.taskId)).toEqual(["t2"]);
        expect(vm.done[0].sub).toBe("t2 · landed");
    });

    it("keeps a done task landed when the digest has not loaded or the dag needs no merge", () => {
        expect(buildLeadCard(input(runInfo([task("t1", "done")]))).done[0].sub).toBe("t1 · landed");
        const unmerged = runInfo([task("t1", "done")], {
            tasks: [{ taskid: "t1", mergestate: "not-required" } as DagTaskDigest],
        });
        expect(buildLeadCard(input(unmerged)).done[0].sub).toBe("t1 · landed");
    });
```

Add a new top-level block:

```ts
describe("mergeWaitTag", () => {
    it("ages a gate from its clock", () => {
        expect(mergeWaitTag(NOW - 34 * 60_000, NOW)).toBe("merge waiting 34m");
        expect(mergeWaitTag(NOW - 65 * 60_000, NOW)).toBe("merge waiting 1h5m");
    });

    // pruned history leaves no clock; a gate stamped ahead of this clock (skew) must not read as a negative age
    it("shows no age without a clock or before it", () => {
        expect(mergeWaitTag(undefined, NOW)).toBe("merge waiting");
        expect(mergeWaitTag(0, NOW)).toBe("merge waiting");
        expect(mergeWaitTag(NOW + 5_000, NOW)).toBe("merge waiting");
    });
});
```

- [ ] **Step 2: Run them and watch them fail.**
Run: `npx vitest run frontend/app/view/agents/leadcardmodel.test.ts`
Expected: FAIL (`mergeWaitTag` is not exported, and t1 is in `done` reading `landed`).

- [ ] **Step 3: Implement.** In `leadcardmodel.ts`, add below `waitTag`:

```ts
/** Pure: how long a finished lane has waited to land. A gate with no clock (its done event was pruned), or one
 *  stamped ahead of this clock, shows no age rather than one from the epoch or a negative one. */
export function mergeWaitTag(mergeGateTs: number | undefined, now: number): string {
    const ms = mergeGateTs ? now - mergeGateTs : 0;
    return ms > 0 ? `merge waiting ${formatElapsed(ms)}` : "merge waiting";
}
```

In `taskRow`, at the top of `case "done": {`, before the `ranMs` line, add:

```ts
            // the lane tip waiting to land is the merge gate: live, not landed, and the engine's to merge
            const td = run.digest?.tasks?.find((t) => t.taskid === task.id);
            if (td?.mergestate === "ready") {
                return {
                    ...base,
                    tone: "wait",
                    tag: mergeWaitTag(td.mergegatets, now),
                    sub: join(task.id, laneText, "merge ready"),
                    openId: endedWorkerId(run.runId, task.id),
                };
            }
```

`base` already has `kind: "live"`, `needsYou: false` and `actions: []`. Keep `openId` so the row still opens the worker's ended transcript, as a landed row does.

- [ ] **Step 4: Run the tests and confirm they pass.**
Run: `npx vitest run frontend/app/view/agents/leadcardmodel.test.ts`
Expected: PASS, with every pre-existing test still passing.

- [ ] **Step 5: Check the renderer needs no change.** Read `frontend/app/view/agents/leadcard.tsx` where `vm.rows` is mapped (~line 332). Confirm that a live row with no `worker` and tone `wait` renders through the same row component: the tag goes in the end column via `row.tag ?? row.age`, and `TONE_DOT.wait` exists. If any live-row branch assumes `row.worker != null` for a `done` task (e.g. mounting a Tell box), guard it with the row's `actions`, which are empty here. Change nothing if nothing assumes it. Run `npx prettier --check frontend/app/view/agents/leadcardmodel.ts frontend/app/view/agents/leadcardmodel.test.ts`.

- [ ] **Step 6: Commit.**

```bash
git add frontend/app/view/agents/leadcardmodel.ts frontend/app/view/agents/leadcardmodel.test.ts
git commit -m "feat(cockpit): show a waiting merge gate and its age on the lead card"
```

### Task 4: Mark R15, R16 and F16 resolved in the trackers
**Depends on:** Task 1, Task 3

**Files:**
- Modify: `docs/orchestrator-redesign-flaws.md` (the F16 note ~line 149, the R15 note ~line 228, the R16 note ~line 238)
- Modify: `docs/open-issues.md` (the F16 row ~line 160, the F19 and F20 rows ~lines 198–199)

**Interfaces:** none.

- [ ] **Step 1: Flaws tracker, F16.** In `docs/orchestrator-redesign-flaws.md`, replace the heading phrase `**F16 (R10, half) — resolved as a signal, not as a renderer.**` with `**F16 (R10) — resolved.**`. Replace its closing sentence, "And the age is not *rendered* anywhere: the CLI and UI report that the gate needs you, not how long it has sat.", with: "**Renderer shipped 2026-09-27:** the digest carries the gate's clock as `DagTaskDigest.MergeGateTs`, from the same `mergeGateClock` the stale check reads. `wsh jarvis dag status` shows `merge waiting 34m` on the gate's row, and the lead card lifts the gate out of Done as a live `merge waiting 34m` row. A gate with no clock shows `merge waiting` with no age."

- [ ] **Step 2: Flaws tracker, R15.** Append to the R15 bullet: "**Closed 2026-09-27.** `waitDecision` itself was deleted with `wsh jarvis dag wait` in `2ce4161b4`, when the engine began waking the lead by typing into its terminal. The last consumer that invented a status, the cockpit's `nextStepText`, now renders an empty `terminalstatus` as a digest contract error instead of `done`. `TestNextTerminalCancelledCarriesItsStatus` pins that `buildNext` names the cancelled status too."

- [ ] **Step 3: Flaws tracker, R16.** Append to the R16 bullet: "**Closed as obsolete 2026-09-27.** `buildEngineOrchestratePrompt` was replaced by `OrchestrationRules` (`pkg/jarvis/leadprompt.go`) in `117b42724`. The current prompt never writes `merge-ready` or `resolve-merge`, because the engine merges by itself, and a wake names each conflict or failed Verify the lead fixes. `TestEngineLaunchPromptDropsTheOldPlanningProtocol` fails if `resolve-merge` returns. With no prompt reading the digest's words, a shared constant would have one reader, and `jarvis` cannot import `orchestrate`."

- [ ] **Step 4: Open issues.** In `docs/open-issues.md`, in the F16 row (~line 160), replace "**Not done:** the age is not *rendered* anywhere — the CLI and UI show that it needs you, not how long it has sat" with "**Age rendered 2026-09-27:** `wsh jarvis dag status` and the lead card show `merge waiting 34m`, from the digest's `MergeGateTs`; a gate with no clock shows no age". In the F19 row (~line 198), append to the fix cell: "; the `waitDecision` half is moot (deleted with `dag wait` in `2ce4161b4`), and the cockpit's `nextStepText` reports an empty terminal status as a contract error (2026-09-27)". In the F20 row (~line 199), append to the fix cell: "; the shared-constant half closed as obsolete 2026-09-27, since the current lead prompt never uses the digest's words".

- [ ] **Step 5: Check that the edits landed and nothing else moved.** Run `git diff --stat` (two docs files only). Run `grep -n "Not done:" docs/open-issues.md` and confirm the F16 row no longer has one. Run `grep -n "R15\|R16\|F16" docs/orchestrator-redesign-flaws.md` and confirm each note reads closed.

- [ ] **Step 6: Commit.**

```bash
git add docs/orchestrator-redesign-flaws.md docs/open-issues.md
git commit -m "docs(orchestrator): mark R15, R16 and F16 resolved"
```
