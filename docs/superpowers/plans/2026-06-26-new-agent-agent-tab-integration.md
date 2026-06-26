# New Agent → Agent tab integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a launched agent a first-class Agent-tab citizen — its own session tab, visible in the roster, focused on launch, showing its live terminal during boot and auto-swapping to the narrated transcript once the reporter registers it.

**Architecture:** Frontend-only. `launchAgent` creates a new session tab (`CreateTab` + `SetMeta`) instead of dumping a block into the active Agents tab, without `setActiveTab` (the cockpit stays put). A `pendingLaunchesAtom` overlays a "booting" `AgentVM` (keyed by the new tabId = the future real row id) onto the roster via the pure `mergePendingLaunches`. `AgentSurface` becomes always-3-pane (list + center + rail); the center renders the terminal while the agent is pending or explicitly `t`-opened, else the transcript. The handoff is derived from pending membership; a prune effect removes a pending entry once its real row arrives (or its tab is closed).

**Tech Stack:** React 19 + jotai, vitest (pure-logic tests; no jsdom for the cockpit — UI is verified live via CDP), wshrpc (`SetMetaCommand`), `WorkspaceService` HTTP service.

> **Git / commits (user rule overrides the skill's per-task commits):** Do **not** commit per task. Make changes task-by-task; at the end, Task 8 stages everything as **one** commit, shows the file list + message, and asks for explicit approval before committing. Nothing is pushed.

---

## File Structure

- `frontend/app/view/agents/agentsviewmodel.ts` — add `PendingLaunch`, `pendingToVM`, `mergePendingLaunches` (pure). *Single source for the overlay logic.*
- `frontend/app/view/agents/agentsviewmodel.test.ts` — unit tests for the three additions.
- `frontend/app/view/agents/agents.tsx` (`AgentsViewModel`) — add `baseRosterAtom` + `pendingLaunchesAtom`; make `agentsAtom` the derived merge; `openTerminal` keeps `focusId`.
- `frontend/app/cockpit/cockpit-actions.ts` — rewrite `launchAgent` (new-tab launch, register pending, focus, no `setActiveTab`); `LaunchAgentOpts` gains `projectName`.
- `frontend/app/view/agents/newagentmodal.tsx` — pass `projectName` to `launchAgent`.
- `frontend/app/view/agents/agentsurface.tsx` — always-3-pane; `centerIsTerminal` rule; focus + Esc refinements.
- `frontend/app/view/agents/cockpitshell.tsx` — mount the prune effect (`usePrunePendingLaunches`).
- `docs/deferred.md` — dev-mock handoff caveat.

---

## Task 1: Pure overlay helpers (`mergePendingLaunches`, `pendingToVM`)

**Files:**
- Modify: `frontend/app/view/agents/agentsviewmodel.ts` (add near the other pure helpers, after `cardSpanStyle`)
- Test: `frontend/app/view/agents/agentsviewmodel.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `frontend/app/view/agents/agentsviewmodel.test.ts` (import the new symbols in the existing top import from `"./agentsviewmodel"`):

```ts
import { mergePendingLaunches, pendingToVM, type PendingLaunch } from "./agentsviewmodel";

describe("pendingToVM", () => {
    it("maps a pending launch to a booting working VM with age from now-ts", () => {
        const p: PendingLaunch = { tabId: "t1", blockId: "b1", name: "payments-api", project: "payments-api", ts: 1000 };
        expect(pendingToVM(p, 5000)).toMatchObject({
            id: "t1",
            name: "payments-api",
            task: "",
            state: "working",
            project: "payments-api",
            blockId: "b1",
            activeMs: 4000,
        });
    });
});

describe("mergePendingLaunches", () => {
    const base: AgentVM[] = [{ id: "a", name: "loom", task: "", state: "working" }];

    it("appends a pending launch not present in the base roster", () => {
        const pending: PendingLaunch[] = [
            { tabId: "t1", blockId: "b1", name: "payments-api", project: "payments-api", ts: 0 },
        ];
        const out = mergePendingLaunches(base, pending, 1000);
        expect(out.map((a) => a.id)).toEqual(["a", "t1"]);
        expect(out[1].state).toBe("working");
    });

    it("drops a pending launch once its tabId exists in the base roster (supersede)", () => {
        const real: AgentVM[] = [{ id: "t1", name: "payments-api", task: "", state: "working" }];
        const pending: PendingLaunch[] = [
            { tabId: "t1", blockId: "b1", name: "payments-api", project: "payments-api", ts: 0 },
        ];
        const out = mergePendingLaunches(real, pending, 1000);
        expect(out).toHaveLength(1);
        expect(out[0].id).toBe("t1");
    });

    it("returns the base unchanged when there are no pending launches", () => {
        expect(mergePendingLaunches(base, [], 1000)).toHaveLength(1);
    });
});
```

`AgentVM` is already imported at the top of the test file (it imports from `"./agentsviewmodel"`); add `mergePendingLaunches`, `pendingToVM`, `PendingLaunch` to that import. If `describe`/`it`/`expect` are not already imported, vitest globals are enabled in this repo (other tests in this file use them bare) — match the existing file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts`
Expected: FAIL — `mergePendingLaunches`/`pendingToVM` not exported (TypeScript/import error or "is not a function").

- [ ] **Step 3: Implement the helpers**

Append to `frontend/app/view/agents/agentsviewmodel.ts`:

```ts
/** A just-launched agent that doesn't exist in the roster yet (the reporter hasn't emitted a status).
 *  `tabId` is the session tab we created — the SAME id the real roster row will use (`row.tabId`),
 *  so supersede needs no id migration. */
export interface PendingLaunch {
    tabId: string;
    blockId: string;
    name: string;
    project: string;
    ts: number; // launch time (UnixMilli) — drives the booting row's age
}

/** Pure: a pending launch -> a "booting" working AgentVM. No transcriptPath (none exists yet); the
 *  Agent surface shows its live terminal until the real row arrives. */
export function pendingToVM(p: PendingLaunch, now: number): AgentVM {
    return {
        id: p.tabId,
        name: p.name,
        task: "",
        state: "working",
        project: p.project,
        blockId: p.blockId,
        activeMs: Math.max(0, now - p.ts),
    };
}

/** Pure: overlay booting launches onto the base roster. A pending entry whose tabId already exists in
 *  base is dropped (the real row supersedes it). Never mutates input. */
export function mergePendingLaunches(base: AgentVM[], pending: PendingLaunch[], now: number): AgentVM[] {
    const baseIds = new Set(base.map((a) => a.id));
    const overlay = pending.filter((p) => !baseIds.has(p.tabId)).map((p) => pendingToVM(p, now));
    return [...base, ...overlay];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts`
Expected: PASS (all three new tests + the existing file green).

---

## Task 2: Roster atoms on the model (`baseRosterAtom`, `pendingLaunchesAtom`, derived `agentsAtom`)

**Files:**
- Modify: `frontend/app/view/agents/agents.tsx`

- [ ] **Step 1: Extend the imports**

In `frontend/app/view/agents/agents.tsx`, update the `agentsviewmodel` import to add the two new symbols (it already imports `buildAskAnswers, canSubmitAsk, type AgentVM, type CardPref`):

```ts
import {
    buildAskAnswers,
    canSubmitAsk,
    mergePendingLaunches,
    type AgentVM,
    type CardPref,
    type PendingLaunch,
} from "./agentsviewmodel";
```

- [ ] **Step 2: Declare the new fields**

Replace the existing field declaration:

```ts
    agentsAtom: Atom<AgentVM[]>;
```

with:

```ts
    agentsAtom: Atom<AgentVM[]>; // base roster overlaid with pending launches
    baseRosterAtom: Atom<AgentVM[]>; // un-overlaid roster (dev mock or live) — read by the prune effect
    pendingLaunchesAtom = atom<PendingLaunch[]>([]) as PrimitiveAtom<PendingLaunch[]>;
```

- [ ] **Step 3: Build the derived roster in the constructor**

Replace the constructor's roster block:

```ts
        if (import.meta.env.DEV) {
            void loadDevMockRoster();
            this.agentsAtom = devRosterAtom;
        } else {
            this.agentsAtom = liveAgentsAtom;
        }
```

with:

```ts
        if (import.meta.env.DEV) {
            void loadDevMockRoster();
            this.baseRosterAtom = devRosterAtom;
        } else {
            this.baseRosterAtom = liveAgentsAtom;
        }
        const base = this.baseRosterAtom;
        const pendingAtom = this.pendingLaunchesAtom;
        // Booting launches overlay the roster until the reporter registers them (supersede by tabId).
        this.agentsAtom = atom((get) => mergePendingLaunches(get(base), get(pendingAtom), Date.now()));
```

- [ ] **Step 4: Keep focus on the agent when opening its terminal**

Replace `openTerminal`:

```ts
    openTerminal(agentId: string) {
        const agent = globalStore.get(this.agentsAtom).find((a) => a.id === agentId);
        globalStore.set(this.terminalTargetAtom, agent?.blockId);
        globalStore.set(this.focusIdAtom, undefined);
        globalStore.set(this.surfaceAtom, "agent");
    }
```

with (set `focusId` to the agent so the list keeps it highlighted and the in-layout terminal knows which agent it is):

```ts
    openTerminal(agentId: string) {
        const agent = globalStore.get(this.agentsAtom).find((a) => a.id === agentId);
        globalStore.set(this.terminalTargetAtom, agent?.blockId);
        globalStore.set(this.focusIdAtom, agentId);
        globalStore.set(this.surfaceAtom, "agent");
    }
```

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: only the 3 pre-existing `frontend/tauri/api.test.ts` errors; no new errors from `agents.tsx`.

---

## Task 3: Rewrite `launchAgent` to create a session tab

**Files:**
- Modify: `frontend/app/cockpit/cockpit-actions.ts`
- Modify: `frontend/app/view/agents/newagentmodal.tsx` (pass `projectName`)

- [ ] **Step 1: Replace the file's imports**

In `frontend/app/cockpit/cockpit-actions.ts`, replace the import block:

```ts
import { globalStore } from "@/app/store/jotaiStore";
import { ObjectService } from "@/app/store/services";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { AgentsViewModel } from "@/app/view/agents/agents";
import { buildLaunchMeta, type Runtime } from "@/app/view/agents/launch";
```

with:

```ts
import { atoms } from "@/app/store/global-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import { WorkspaceService } from "@/app/store/services";
import { RpcApi } from "@/app/store/wshclientapi";
import * as WOS from "@/app/store/wos";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { AgentsViewModel } from "@/app/view/agents/agents";
import type { PendingLaunch } from "@/app/view/agents/agentsviewmodel";
import { buildLaunchMeta, type Runtime } from "@/app/view/agents/launch";
```

- [ ] **Step 2: Extend `LaunchAgentOpts` and rewrite `launchAgent`**

Replace the entire `LaunchAgentOpts` interface and `launchAgent` function with:

```ts
export interface LaunchAgentOpts {
    runtime: Runtime;
    startupCommand: string;
    task: string;
    projectPath: string;
    projectName: string; // labels the roster row + carries project scope
    branch?: string;
}

// Launch a runtime as its OWN session tab (so it's a first-class roster row), focus it in the Agent
// surface, and register it as a pending launch. We do NOT setActiveTab — the cockpit stays on the
// Agents tab; the agent's process starts when its terminal mounts in the focus pane. The new tab's
// default term block is reconfigured via SetMeta before it renders, so meta is honored at controller
// start (the backend starts controllers lazily on the first terminal-view resync).
export async function launchAgent(model: AgentsViewModel, opts: LaunchAgentOpts): Promise<void> {
    let cwd = opts.projectPath;
    if (opts.runtime !== "terminal" && opts.branch?.trim()) {
        const rtn = await RpcApi.CreateWorktreeCommand(TabRpcClient, {
            projectpath: opts.projectPath,
            branch: opts.branch.trim(),
        });
        cwd = rtn.worktreepath;
    }
    const ws = globalStore.get(atoms.workspace);
    if (ws?.oid == null) {
        throw new Error("no active workspace");
    }
    const tabId = await WorkspaceService.CreateTab(ws.oid, opts.projectName, false);
    const tab = globalStore.get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", tabId)));
    const blockId = tab?.blockids?.[0];
    if (blockId == null) {
        throw new Error("new tab has no block");
    }
    await RpcApi.SetMetaCommand(TabRpcClient, {
        oref: WOS.makeORef("block", blockId),
        meta: buildLaunchMeta({
            runtime: opts.runtime,
            startupCommand: opts.startupCommand,
            task: opts.task,
            cwd,
        }),
    });
    await RpcApi.SetMetaCommand(TabRpcClient, {
        oref: WOS.makeORef("tab", tabId),
        meta: { "session:agent": opts.runtime, "session:label": opts.projectName },
    });
    const pending: PendingLaunch = {
        tabId,
        blockId,
        name: opts.projectName,
        project: opts.projectName,
        ts: Date.now(),
    };
    globalStore.set(model.pendingLaunchesAtom, [...globalStore.get(model.pendingLaunchesAtom), pending]);
    globalStore.set(model.focusIdAtom, tabId);
    globalStore.set(model.surfaceAtom, "agent");
}
```

- [ ] **Step 3: Pass `projectName` from the modal**

In `frontend/app/view/agents/newagentmodal.tsx`, find the `launchAgent` call inside `launch()`:

```ts
            await launchAgent(model, {
                runtime,
                startupCommand: startup,
                task,
                projectPath: path,
                branch: branchArg,
            });
```

and add `projectName`:

```ts
            await launchAgent(model, {
                runtime,
                startupCommand: startup,
                task,
                projectPath: path,
                projectName: c.name,
                branch: branchArg,
            });
```

(`c` is the resolved `LaunchCandidate` already in scope at that point in `launch()`.)

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: only the 3 pre-existing `api.test.ts` errors. (`Tab` is an ambient global type — no import needed, matching `sessionsidebarmodel.ts`.)

---

## Task 4: Always-3-pane Agent surface with in-layout terminal

**Files:**
- Modify: `frontend/app/view/agents/agentsurface.tsx`

- [ ] **Step 1: Read the pending set and compute the center mode**

In `AgentSurface`, after the existing atom reads, add `pending` and replace `showFocus` with `centerIsTerminal`. The current block:

```ts
    const terminalTarget = useAtomValue(model.terminalTargetAtom);
    const focusId = useAtomValue(model.focusIdAtom);
    const agents = useAtomValue(model.agentsAtom);
    const order = useAtomValue(model.orderAtom);
    const wrapRef = useRef<HTMLDivElement>(null);
```

becomes:

```ts
    const terminalTarget = useAtomValue(model.terminalTargetAtom);
    const focusId = useAtomValue(model.focusIdAtom);
    const agents = useAtomValue(model.agentsAtom);
    const order = useAtomValue(model.orderAtom);
    const pending = useAtomValue(model.pendingLaunchesAtom);
    const wrapRef = useRef<HTMLDivElement>(null);
```

Then replace:

```ts
    const focused = focusId != null ? agents.find((a) => a.id === focusId) : undefined;
    const agent = focused ?? agents.find((a) => a.id === order[0]) ?? agents[0];
    const showFocus = !terminalTarget && agent != null;
```

with:

```ts
    const focused = focusId != null ? agents.find((a) => a.id === focusId) : undefined;
    const agent = focused ?? agents.find((a) => a.id === order[0]) ?? agents[0];
    // Center pane = terminal while the agent is booting (pending) or explicitly opened via `t`; else
    // the narrated transcript. The boot->transcript handoff is derived: when the reporter registers the
    // agent, the prune effect drops it from pending -> isPending flips false -> transcript shows.
    const isPending = agent != null && pending.some((p) => p.tabId === agent.id);
    const centerIsTerminal = agent != null && agent.blockId != null && (isPending || terminalTarget === agent.blockId);
```

- [ ] **Step 2: Update the focus effect**

Replace:

```ts
    // pull keyboard focus to the wrapper so esc/←→/t work without a click (mirrors the interim)
    useEffect(() => {
        if (showFocus) {
            wrapRef.current?.focus();
        }
    }, [showFocus, agent?.id]);
```

with (focus the wrapper for keyboard nav only when the center is the transcript — when it's the terminal, the term view owns focus):

```ts
    // pull keyboard focus to the wrapper so esc/←→/t work without a click; skip when the center is the
    // terminal (the term view owns focus then)
    useEffect(() => {
        if (agent != null && !centerIsTerminal) {
            wrapRef.current?.focus();
        }
    }, [agent?.id, centerIsTerminal]);
```

- [ ] **Step 3: Remove the full-pane early return and render 3-pane with a conditional center**

Replace:

```ts
    if (terminalTarget) {
        return <CockpitFocusPane blockId={terminalTarget} tabId={tabId} />;
    }
    if (!agent) {
        return (
            <div className="flex h-full w-full items-center justify-center text-[13px] text-muted">
                No active agents.
            </div>
        );
    }
```

with (drop the full-pane branch; keep the empty state):

```ts
    if (!agent) {
        return (
            <div className="flex h-full w-full items-center justify-center text-[13px] text-muted">
                No active agents.
            </div>
        );
    }
```

Then replace the final return's body:

```tsx
    return (
        <div ref={wrapRef} tabIndex={0} onKeyDown={onKeyDown} className="flex h-full w-full outline-none">
            <AgentTree model={model} />
            <AgentTranscript model={model} agent={agent} />
            <AgentDetailsRail model={model} agent={agent} />
        </div>
    );
```

with (the center is `.cockpit-focus-pane`, which is `flex:1; min-width:0` — it fills the column between the 248px tree and the rail):

```tsx
    return (
        <div ref={wrapRef} tabIndex={0} onKeyDown={onKeyDown} className="flex h-full w-full outline-none">
            <AgentTree model={model} />
            {centerIsTerminal ? (
                <CockpitFocusPane blockId={agent.blockId!} tabId={tabId} />
            ) : (
                <AgentTranscript model={model} agent={agent} />
            )}
            <AgentDetailsRail model={model} agent={agent} />
        </div>
    );
```

- [ ] **Step 4: Refine Escape (terminal → transcript, else → cockpit)**

In `onKeyDown`, replace the Escape branch:

```ts
        if (e.key === "Escape") {
            e.preventDefault();
            globalStore.set(model.surfaceAtom, "cockpit");
        } else if (e.key === "ArrowLeft") {
```

with:

```ts
        if (e.key === "Escape") {
            e.preventDefault();
            // an explicitly-opened terminal collapses back to the transcript first; otherwise leave the surface
            if (globalStore.get(model.terminalTargetAtom)) {
                globalStore.set(model.terminalTargetAtom, undefined);
            } else {
                globalStore.set(model.surfaceAtom, "cockpit");
            }
        } else if (e.key === "ArrowLeft") {
```

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: only the 3 pre-existing `api.test.ts` errors. (`CockpitFocusPane` is already imported in this file.)

---

## Task 5: Prune pending launches (supersede + tab-closed)

**Files:**
- Modify: `frontend/app/view/agents/cockpitshell.tsx`

- [ ] **Step 1: Add the prune hook and call it**

In `frontend/app/view/agents/cockpitshell.tsx`, extend the imports:

```ts
import { atoms } from "@/app/store/global-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";
```

(merge with the existing `import { useAtomValue } from "jotai";` — do not duplicate it.)

Add this hook above `CockpitShell`:

```ts
// Clears a pending launch once it's no longer "booting": its real roster row arrived (tabId in the
// base roster) OR its tab was closed (was present in the workspace, now gone). The seen-present ref
// avoids a creation race — a tab is only pruned-on-close after we've observed it present at least once.
function usePrunePendingLaunches(model: AgentsViewModel) {
    const ws = useAtomValue(atoms.workspace);
    const base = useAtomValue(model.baseRosterAtom);
    const pending = useAtomValue(model.pendingLaunchesAtom);
    const seenRef = useRef<Set<string>>(new Set());
    useEffect(() => {
        const tabIds = new Set(ws?.tabids ?? []);
        const baseIds = new Set(base.map((a) => a.id));
        for (const p of pending) {
            if (tabIds.has(p.tabId)) {
                seenRef.current.add(p.tabId);
            }
        }
        const next = pending.filter(
            (p) => !baseIds.has(p.tabId) && !(seenRef.current.has(p.tabId) && !tabIds.has(p.tabId))
        );
        if (next.length !== pending.length) {
            globalStore.set(model.pendingLaunchesAtom, next);
        }
    }, [ws?.tabids, base, pending, model]);
}
```

Call it as the first line inside `CockpitShell`:

```ts
export function CockpitShell({ model, tabId }: { model: AgentsViewModel; tabId: string }) {
    usePrunePendingLaunches(model);
    const surface = useAtomValue(model.surfaceAtom);
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: only the 3 pre-existing `api.test.ts` errors.

---

## Task 6: Document the dev-mock caveat

**Files:**
- Modify: `docs/deferred.md` (append; create the file if missing with a `# Deferred` heading)

- [ ] **Step 1: Append the note**

Add to `docs/deferred.md`:

```markdown
## New Agent → Agent tab: dev-mock handoff

When a cockpit fixture is loaded (`frontend/tauri/public/cockpit-fixtures/active.json`, dev only),
`agentsAtom`'s base is the static mock, so a launched agent's real roster row never appears there and
the pending "booting" overlay never supersedes to the live transcript. Without a fixture, dev falls
through to the live roster (`devRosterAtom` -> `liveAgentsAtom`) and the handoff works end-to-end.
Verify the launch → terminal → transcript handoff in dev with **no fixture active**, or in a packaged
build / via `scripts/inject-live-agents.mjs`.
```

---

## Task 7: Verify (tests, typecheck, live CDP)

**Files:** none (verification only)

- [ ] **Step 1: Full unit suite**

Run: `npx vitest run`
Expected: PASS (existing green count + the 3 new `agentsviewmodel` tests; no regressions).

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: only the 3 pre-existing `frontend/tauri/api.test.ts` errors.

- [ ] **Step 3: Live CDP check (dev app, no fixture)**

Ensure no cockpit fixture is active (so the live roster is used), run `task dev`, then drive/observe the dev app over CDP (`:9222`, `node scripts/cdp-shot.mjs`). Confirm:
1. Open the New Agent modal, pick a project + Claude runtime + a task, Launch.
2. The Agent surface shows the **list (AgentTree) still populated** with the other agents, plus a focused "booting" row for the new agent.
3. The center pane shows the **live terminal** and `claude` actually starts (banner / prompt) in the chosen cwd.
4. Within a few seconds the center **auto-swaps to the narrated transcript** (the reporter registered it; the pending overlay was pruned).
5. Pressing `t` reopens the terminal in the center; `Esc` returns to the transcript; the roster stays visible throughout.

Record the result (screenshots / notes). This is the only coverage for the surface/launch wiring (no jsdom harness exists for the cockpit).

---

## Task 8: Commit (after explicit approval)

**Files:** all changes from Tasks 1–6.

- [ ] **Step 1: Show the diff summary and request approval**

Per the user's git workflow, present: the changed files with M/A status + a one-line change summary each, and the proposed message:

```
feat(cockpit): land launched agents in the Agent tab (new-tab launch + pending overlay)
```

Then ask: "Awaiting approval. Proceed? (yes/no)"

- [ ] **Step 2: On approval, commit (no push)**

```bash
git add frontend/app/view/agents/agentsviewmodel.ts \
        frontend/app/view/agents/agentsviewmodel.test.ts \
        frontend/app/view/agents/agents.tsx \
        frontend/app/cockpit/cockpit-actions.ts \
        frontend/app/view/agents/newagentmodal.tsx \
        frontend/app/view/agents/agentsurface.tsx \
        frontend/app/view/agents/cockpitshell.tsx \
        docs/deferred.md \
        docs/superpowers/specs/2026-06-26-new-agent-agent-tab-integration-design.md \
        docs/superpowers/plans/2026-06-26-new-agent-agent-tab-integration.md
git commit -m "feat(cockpit): land launched agents in the Agent tab (new-tab launch + pending overlay)"
```

(The spec + plan fold into this feature commit per the user's docs-commit rule — no separate docs-only commit.)

---

## Self-Review

**Spec coverage:**
- §4.1 new-tab launch → Task 3. §4.2 pending overlay + merge → Tasks 1, 2. §4.2 self-heal (supersede + tab-gone prune, no timeout) → Task 5. §4.3 always-3-pane + center rule + unify + t/Esc → Task 4 (+ `openTerminal` focus in Task 2). §8 testing → Tasks 1, 7. §9 dev caveat → Task 6. §10 file inventory → all tasks. ✓ All sections mapped.
- §12 open question "CockpitFocusPane tabId": resolved — pass the existing `tabId` prop (the proven path the full-pane `t` terminal already used for agents whose blocks live in other tabs; the block is identified by `blockId`). Flagged in Task 7 step 3 to confirm live.
- §12 open question "label source": resolved — project name (`projectName`), used in Task 3.

**Placeholder scan:** No TBD/TODO; every code step shows complete code; commands have expected output. ✓

**Type consistency:** `PendingLaunch { tabId, blockId, name, project, ts }` defined in Task 1, used identically in Tasks 2–5. `mergePendingLaunches(base, pending, now)` / `pendingToVM(p, now)` signatures match across Tasks 1–2. `baseRosterAtom` / `pendingLaunchesAtom` declared in Task 2, read in Tasks 3 (pending), 4 (pending), 5 (base + pending). `LaunchAgentOpts.projectName` added in Task 3 and supplied in the same task's modal edit. ✓
