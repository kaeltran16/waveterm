# Route DAG modal redesign: fix round 1

**Goal:** make the Final check `node scripts/cdp/final-verify.mjs dag-lifecycle` pass on the merged result.

**Why it fails:** the `dag-lifecycle` scenario in `scripts/cdp/scenarios.mjs` still drives the plan gate that
1e4bb179 (`refactor(orchestrate): delete the plan gate...`) removed. That problem is older than this run. Its
`createrun` still passes `plangate: true`, step 2 expects the group `status === "awaiting-plan"`, and step 4
calls `dagaction` with `action: "approve-plan"`. The server now rejects that action: `unknown dag action
"approve-plan"`. It throws inside `assert` before any `rec()` runs, so the report reads `0/0 steps passed`.
None of this run's steps (5a-5e) has run live yet.

What the server does now (`pkg/wshrpc/wshserver/wshserver_dag.go` `DagSubmitCommand`): a JSON dag (no
`planpath`) gets no plan review. It moves the run from `planning` to `executing` and calls
`orchestrate.Schedule`, which dispatches the first layer (t-0) before the RPC returns. There is no gate to
approve.

**Verify:** `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" node scripts/verify.mjs ./pkg/jarvis/...`

**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`

**Final:** `node scripts/cdp/final-verify.mjs dag-lifecycle`

### Task 1: Bring the dag-lifecycle scenario up to the gate-less engine

**Depends on:** none

**Files:**
- Modify: `scripts/cdp/scenarios.mjs`, the `dag-lifecycle` scenario only (it starts at `name: "dag-lifecycle"`).
  Hand-formatted, 4-space indent. Never run prettier on it.

- [ ] **Step 1: Drop the plan gate from the arrange/assert flow**
  - In the `createrun` call, delete `plangate: true` and the two comment lines above it that explain it.
  - Step 2: rename it to `"2. DagSubmit -> group with 3 tasks, no plan gate, t-1/t-2 pending"`. Assert
    `g.tasks.length === 3`, `g.status !== "awaiting-plan"`, `g.status !== "plan-review"`, and that
    t-1 and t-2 are `pending`. Do not assert t-0's state here, because it may already be running.
  - Keep step 3 and the "identical DagSubmit retry" step as they are.
  - Step 4: delete the `dagaction ... "approve-plan"` call and the comment above it ("approving the plan is
    what spawns the first worker..."). Keep the poll loop that waits for t-0 to leave `pending`. Rename
    the step to `"4. DagSubmit dispatches t-0 (running) or it already finished, t-1/t-2 pending"`.
    Make its assertion check t-1/t-2 as well as t-0, because the label claims them.
  - Grep the whole `dag-lifecycle` scenario for any other trace of the deleted gate (`approve-plan`,
    `sendback-plan`, `awaiting-plan`, `plangate`, `PlanGate`, `plan gate`) and bring it up to date the same way.

- [ ] **Step 2: Syntax check**

Run: `node --check scripts/cdp/scenarios.mjs`
Expected: no output, exit 0.

- [ ] **Step 3: Run the scenario live and fix what it exposes**

Run: `node scripts/cdp/final-verify.mjs dag-lifecycle` (it starts its own isolated dev app. Allow up to 10
minutes. It needs no running app of yours, and it does not touch the user's Arc.)
Expected: every step PASS, exit 0.

This is the first live run of steps 5 onward on this branch, so later steps may fail too. Sort each
failure into one of three cases:
- **The scenario is stale about pre-existing behaviour** (a selector or expectation that 1e4bb179 or other
  earlier work already made wrong): fix the scenario.
- **A 5a-5e step fails on the synthetic event, not the UI.** The earlier worker named the likely ones:
  5b depends on floating-ui `useHover` opening from a synthetic mouseenter, and 5d depends on xyflow
  `onNodeClick` firing on `element.click()` with no mousedown. Check first that the UI works with a real
  input event. Use `Input.dispatchMouseEvent` through `h.cdp(...)` (mouseMoved to the card centre, or
  mousePressed/mouseReleased), which is the same path a real pointer takes. Then change the step to use it.
  Do not weaken what the step asserts.
- **A real defect in this run's dag modal code** (`frontend/app/view/orchestrate/`), against spec
  `docs/superpowers/specs/2026-09-29-dag-modal-redesign-design.md`: fix it at the root in that code,
  keep `npx vitest run frontend/app/view/orchestrate` green, and name the fix in your report.

If a step still fails after that and the cause is outside `scripts/cdp/scenarios.mjs` and
`frontend/app/view/orchestrate/`, stop and report it. Do not work around it in the scenario.

Run the Check command before committing when you changed any `.ts`/`.tsx` file.

- [ ] **Step 4: Commit**

```bash
git add scripts/cdp/scenarios.mjs
git commit -m "test(cdp): dag-lifecycle drives the gate-less engine: no plangate, no approve-plan"
```

(Add any `frontend/app/view/orchestrate/` file you fixed to the same commit, and say so in the message body.)
