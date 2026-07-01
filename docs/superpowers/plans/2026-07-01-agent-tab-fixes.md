# Agent Tab Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three Agent-tab bugs (status mislabel, TUI mangle on tab switch, single-usage panel) and add four keyboard/UX affordances (right-click toolbar, tool-group + surface + agent-cycle shortcuts, double-Ctrl+C close).

**Architecture:** All changes are frontend-only (React 19 + jotai + xterm). Pure view-model logic changes get vitest coverage; UI/mount/keyboard behavior is verified via CDP against the live dev app (`node scripts/cdp-shot.mjs`). No Go/Rust/wire-protocol changes, so `task generate` is not needed.

**Tech Stack:** TypeScript, React, jotai atoms (`globalStore`), xterm.js (`termwrap`), Tailwind v4, vitest.

**Git:** Per project convention, do NOT commit per task. Run tests/typecheck after each task; a single approval-gated commit is the final task.

**Typecheck command (repo gotcha — bare `tsc` stack-overflows):**
`node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Baseline has ~3 pre-existing errors in `frontend/tauri/api.test.ts` — ignore only those.

---

### Task 1: Status — "waiting" no longer means "asking" (#1)

**Files:**
- Modify: `frontend/app/view/agents/agentsviewmodel.ts:276-297`
- Test: `frontend/app/view/agents/agentsviewmodel.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `agentsviewmodel.test.ts` (import `agentVMFromInput` if not already imported):

```ts
describe("agentVMFromInput status mapping", () => {
    it("maps backend 'waiting' to working, not asking (asking comes only from agent:ask)", () => {
        const vm = agentVMFromInput({ id: "t1", name: "a", status: "waiting", ts: 1000 }, 5000);
        expect(vm.state).toBe("working");
        expect(vm.activeMs).toBe(4000);
        expect(vm.blockedMs).toBeUndefined();
    });
    it("maps 'working' to working and 'idle' to idle", () => {
        expect(agentVMFromInput({ id: "t", name: "a", status: "working", ts: 1000 }, 2000).state).toBe("working");
        expect(agentVMFromInput({ id: "t", name: "a", status: "idle", ts: 1000 }, 2000).state).toBe("idle");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts -t "waiting"`
Expected: FAIL — current code returns `state === "asking"` and sets `blockedMs`.

- [ ] **Step 3: Implement**

In `agentVMFromInput`, replace the status→state line (currently line 277) and the trailing age block (currently lines 290-296).

Replace line 277:
```ts
const state: AgentState = input.status === "working" || input.status === "waiting" ? "working" : "idle";
```

Replace the `if (state === "asking") { … } else if (state === "working") { … } else …` block (lines 290-296) with (the `asking` branch is now dead — `agentVMFromInput` never produces `asking`; that state is applied later by `withAsk`):
```ts
    if (state === "working") {
        vm.activeMs = age;
    } else if (input.ts != null) {
        vm.idleSince = input.ts;
    }
    return vm;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts`
Expected: PASS (all, including existing tests — a live `agent:ask` still forces `asking` via `withAsk`, unaffected here).

---

### Task 2: Usage panel — stop the single-usage dedup (#6)

**Files:**
- Modify: `frontend/app/view/agents/agentsviewmodel.ts:239-258` (`providerPlanUsage`)
- Modify: `frontend/app/view/agents/cockpitsurface.tsx:174,647-668` (consumer + render)
- Test: `frontend/app/view/agents/agentsviewmodel.test.ts`

Rationale: `providerPlanUsage` currently keeps only the first agent per provider (`if (!byProvider.has(provider))`), so multiple agents collapse to one row. Return one row per agent that carries rate data, labeled by agent name. (Account-level rate numbers may look identical across same-provider agents — accepted per design; rows are distinguished by agent name.)

- [ ] **Step 1: Write the failing test**

Add to `agentsviewmodel.test.ts`:
```ts
describe("providerPlanUsage (no dedup)", () => {
    const mk = (id: string, agent: string, five: number): AgentVM => ({
        id, name: id, task: "", state: "working", agent, usage: { fivehourpct: five },
    });
    it("returns a row per agent with rate data (does not collapse same-provider agents)", () => {
        const rows = providerPlanUsage([mk("a", "claude", 10), mk("b", "claude", 20), mk("c", "codex", 30)]);
        expect(rows.map((r) => r.agentId)).toEqual(["a", "b", "c"]);
        expect(rows.map((r) => r.provider)).toEqual(["claude", "claude", "codex"]);
    });
    it("skips agents without rate data and sorts claude before codex", () => {
        const noRate: AgentVM = { id: "z", name: "z", task: "", state: "idle", agent: "claude" };
        const rows = providerPlanUsage([mk("c", "codex", 30), noRate, mk("a", "claude", 10)]);
        expect(rows.map((r) => r.agentId)).toEqual(["a", "c"]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts -t "providerPlanUsage"`
Expected: FAIL — return objects have no `agentId`, and same-provider agents collapse to one.

- [ ] **Step 3: Implement providerPlanUsage**

Replace the whole function body (lines 243-258) with:
```ts
export function providerPlanUsage(
    agents: AgentVM[]
): { agentId: string; name: string; provider: string; usage: AgentUsage }[] {
    const rows: { agentId: string; name: string; provider: string; usage: AgentUsage }[] = [];
    for (const a of agents) {
        const u = a.usage;
        if (!u || (u.fivehourpct == null && u.weekpct == null)) {
            continue;
        }
        rows.push({ agentId: a.id, name: a.name, provider: a.agent || "claude", usage: u });
    }
    // stable sort keeps active-first input order within a provider; claude before codex across providers
    return rows.sort((x, y) => (PROVIDER_RANK[x.provider] ?? 99) - (PROVIDER_RANK[y.provider] ?? 99));
}
```

Also update the doc comment above it (lines 239-242) to: `/** Pure: one plan-limit usage row per agent that carries rate data (no per-provider collapse), so multiple concurrent agents each show a row. Sorted claude-first, then codex, then others in first-seen order. */`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts -t "providerPlanUsage"`
Expected: PASS

- [ ] **Step 5: Update the consumer + render in cockpitsurface.tsx**

At line 174, rename the variable to reflect per-agent rows:
```ts
    const usageRows = providerPlanUsage([...asking, ...working, ...idle]);
```

Replace the render block (lines 647-668) with (key by `agentId`, label by agent `name`):
```tsx
                            {usageRows.map(({ agentId, name, provider, usage }) => (
                                <div key={agentId} className="flex flex-col gap-4">
                                    {usageRows.length > 1 ? (
                                        <div className="flex items-center gap-1.5 font-mono text-[11px] font-semibold text-primary">
                                            <span
                                                className={cn(
                                                    "h-[7px] w-[7px] rounded-full",
                                                    PROVIDER_DOT[provider] ?? "bg-muted"
                                                )}
                                            />
                                            {name}
                                        </div>
                                    ) : null}
                                    <UsageBar
                                        label="5-hour window"
                                        pct={usage.fivehourpct}
                                        reset={usage.fivehourreset}
                                        now={now}
                                    />
                                    <UsageBar label="Weekly" pct={usage.weekpct} reset={usage.weekreset} now={now} />
                                </div>
                            ))}
```

- [ ] **Step 6: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no NEW errors (baseline api.test.ts errors only). Confirms the `planByProvider`→`usageRows` rename has no stragglers.

---

### Task 3: Pure `cycleId` helper for agent cycling (#8, pure part)

**Files:**
- Modify: `frontend/app/view/agents/agentsviewmodel.ts` (add after `moveCursor`, line 366)
- Test: `frontend/app/view/agents/agentsviewmodel.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `agentsviewmodel.test.ts`:
```ts
describe("cycleId", () => {
    it("wraps forward past the end and starts at 0 when current is unknown", () => {
        expect(cycleId(["a", "b", "c"], "c", 1)).toBe("a");
        expect(cycleId(["a", "b", "c"], undefined, 1)).toBe("a");
        expect(cycleId(["a", "b", "c"], "a", 1)).toBe("b");
    });
    it("wraps backward and returns undefined for empty", () => {
        expect(cycleId(["a", "b", "c"], "a", -1)).toBe("c");
        expect(cycleId([], "a", 1)).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts -t "cycleId"`
Expected: FAIL — `cycleId is not defined`.

- [ ] **Step 3: Implement**

Add after `moveCursor` (after line 366):
```ts
/** Pure: like moveCursor but wraps around the ends (for cycling shortcuts). Unknown current -> first. */
export function cycleId(ids: string[], current: string | undefined, delta: number): string | undefined {
    if (ids.length === 0) {
        return undefined;
    }
    const idx = current != null ? ids.indexOf(current) : -1;
    return ids[(idx + delta + ids.length) % ids.length];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts -t "cycleId"`
Expected: PASS

---

### Task 4: Terminal resize guard for hidden/detached container (#2, part 1)

**Files:**
- Modify: `frontend/app/view/term/termwrap.ts:569` (`handleResize`)

Rationale: Task 5 keeps the terminal mounted but `display:none` when off-surface. A `display:none` element has `offsetParent == null` and 0 client size; without a guard, the `ResizeObserver`/constructor `handleResize()` would `fit()` to a 0-size box and shrink the PTY, causing the exact mangle we're removing.

- [ ] **Step 1: Implement the guard**

At the very top of `handleResize()` (before `const oldRows = this.terminal.rows;`, line 570), add:
```ts
        // skip while hidden/detached (display:none -> offsetParent null, 0 size) so we don't fit to a
        // 0-size box and shrink the PTY; the ResizeObserver fires again with real dims on re-show.
        if (
            this.connectElem.offsetParent == null ||
            this.connectElem.clientWidth === 0 ||
            this.connectElem.clientHeight === 0
        ) {
            return;
        }
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no new errors.

- [ ] **Step 3: Sanity — run the term-related unit tests if any**

Run: `npx vitest run frontend/app/view/term`
Expected: PASS or "no test files" (there is no termwrap unit test; this guard is verified live in Task 5).

---

### Task 5: Keep the agent terminal mounted across surface switches (#2, part 2)

**Files:**
- Modify: `frontend/app/view/agents/cockpitshell.tsx:44-71`

Rationale: `CockpitShell` currently conditionally renders `AgentSurface` only when `surface === "agent"`, so leaving the surface unmounts and destroys the terminal (focus-pane.tsx:24 `model.dispose()`), and returning re-fits at a stale size. Keep `AgentSurface` always mounted and toggle `display:none` instead; render the other surfaces as an overlay only when active.

- [ ] **Step 1: Add the `cn` import**

At the top of `cockpitshell.tsx`, add to the imports:
```ts
import { cn } from "@/util/util";
```

- [ ] **Step 2: Replace the return block (lines 47-70)**

```tsx
    return (
        <div className="flex h-full w-full">
            <NavRail model={model} />
            <div className="relative min-w-0 flex-1 bg-background">
                {/* Agent surface stays mounted so its live terminal is never torn down on tab switch
                    (destroy+remount re-fits xterm at a stale size and mangles the TUI). Hidden via
                    display:none when off-surface; the termwrap resize guard skips the 0-size fit. */}
                <div className={cn("absolute inset-0", surface === "agent" ? "" : "hidden")}>
                    <AgentSurface model={model} tabId={tabId} />
                </div>
                {surface !== "agent" ? (
                    <div className="absolute inset-0">
                        {surface === "cockpit" ? (
                            <CockpitSurface model={model} />
                        ) : surface === "channels" ? (
                            <ChannelsSurface model={model} />
                        ) : surface === "activity" ? (
                            <ActivitySurface model={model} />
                        ) : surface === "files" ? (
                            <FilesSurface model={model} />
                        ) : surface === "sessions" ? (
                            <SessionsSurface model={model} />
                        ) : surface === "usage" ? (
                            <UsageSurface model={model} />
                        ) : (
                            <PlaceholderSurface surface={surface} />
                        )}
                    </div>
                ) : null}
            </div>
        </div>
    );
```

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no new errors.

- [ ] **Step 4: Live CDP verification (the core of this fix)**

Ensure a dev app is running with a live agent terminal (per CLAUDE.md: `tail -f /dev/null | task dev` so wavesrv keeps stdin; inject agents if needed via `node scripts/inject-live-agents.mjs <scenario>`).
1. Switch to the Agent surface, note the TUI renders cleanly.
2. Switch to Cockpit (or any other surface), then back to Agent.
3. Run `node scripts/cdp-shot.mjs agent-after-switch.png` and open it.
Expected: the TUI is NOT distorted/mangled after the round-trip; text/box-drawing aligns as before the switch.

---

### Task 6: Extract `confirmCloseAgent` (shared close action, used by #5)

**Files:**
- Create: `frontend/app/view/agents/agentactions.ts`
- Modify: `frontend/app/view/agents/agentheader.tsx:56-68` (use the helper)

Rationale: the double-Ctrl+C handler (Task 8) needs the same confirm-and-close flow as the header Close button. Extract it so both call one implementation.

- [ ] **Step 1: Create the helper**

`frontend/app/view/agents/agentactions.ts`:
```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { atoms } from "@/app/store/global-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import { modalsModel } from "@/app/store/modalmodel";
import { WorkspaceService } from "@/app/store/services";
import { fireAndForget } from "@/util/util";

// Close a whole agent session (agentId is the tabId). Shows the same confirm modal as the header
// Close button, then CloseTab -> wcore.DeleteTab tears down the block and reassigns the active tab.
export function confirmCloseAgent(agentId: string, agentName: string) {
    const ws = globalStore.get(atoms.workspace);
    if (ws?.oid == null) {
        return;
    }
    modalsModel.pushModal("ConfirmModal", {
        title: "Close terminal",
        message: `End the session for "${agentName}"? This stops the agent and can't be undone.`,
        confirmLabel: "Close terminal",
        destructive: true,
        onConfirm: () => fireAndForget(() => WorkspaceService.CloseTab(ws.oid, agentId, false)),
    });
}
```

- [ ] **Step 2: Use it in agentheader.tsx**

Add import near the other store imports:
```ts
import { confirmCloseAgent } from "./agentactions";
```

Replace the `closeTerminal` function (lines 56-68) with:
```ts
    const closeTerminal = () => confirmCloseAgent(agent.id, agent.name);
```

Remove now-unused imports from `agentheader.tsx` ONLY if nothing else uses them. Check first: `atoms` (was only in closeTerminal — likely removable), `modalsModel` (removable), `WorkspaceService` (removable). Keep `globalStore`, `RpcApi`, `TabRpcClient`, `stringToBase64`, `fireAndForget` (still used by `interrupt`). Verify by searching the file for each symbol before deleting its import.

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no new errors (a leftover unused import surfaces here — remove it).

---

### Task 7: Right-click toolbar + `f` fullscreen shortcut (#3, #4)

**Files:**
- Modify: `frontend/app/view/agents/agentheader.tsx` (context menu on the header)
- Modify: `frontend/app/view/agents/agentsurface.tsx:83-86` (add `f`)

- [ ] **Step 1: Add the context-menu handler in agentheader.tsx**

Add import:
```ts
import { ContextMenuModel } from "@/app/store/contextmenu";
```

Inside `AgentHeader`, after `closeTerminal` (around line 68), add (`ContextMenuItem` is an ambient global type from `frontend/types/custom.d.ts` — no import needed):
```ts
    const onContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const items: ContextMenuItem[] = [];
        if (blockId != null) {
            items.push({ label: "Interrupt turn", click: interrupt });
            items.push({
                label: fullscreen ? "Exit fullscreen" : "Fullscreen terminal",
                click: () => globalStore.set(terminalFullscreenAtom, !fullscreen),
            });
        }
        items.push({
            label: railVisible ? "Hide details" : "Show details",
            click: () => globalStore.set(railVisibleAtom, !railVisible),
        });
        if (blockId != null) {
            items.push({ type: "separator" });
            items.push({ label: "Close agent", click: closeTerminal });
        }
        ContextMenuModel.getInstance().showContextMenu(items, e);
    };
```

- [ ] **Step 2: Attach it to the header container**

On the header root `<div>` (line 71), add the handler:
```tsx
        <div
            onContextMenu={onContextMenu}
            className="flex shrink-0 items-center gap-[13px] border-b border-[#1a1f26] bg-background px-[22px] py-[14px]"
        >
```

- [ ] **Step 3: Add the `f` fullscreen shortcut in agentsurface.tsx**

In `AgentSurface`'s `onKeyDown`, after the `d` branch (lines 83-86), add:
```ts
        } else if (e.key === "f") {
            e.preventDefault();
            globalStore.set(terminalFullscreenAtom, !globalStore.get(terminalFullscreenAtom));
        }
```
(`terminalFullscreenAtom` is already imported in `agentsurface.tsx:24`.)

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no new errors.

- [ ] **Step 5: Live CDP verification**

On the running dev app, Agent surface:
1. Right-click the header bar → a menu with Interrupt / Fullscreen / Show|Hide details / Close appears; click Fullscreen and confirm it toggles.
2. With the agent surface focused (click a tree row, not the terminal), press `f` → fullscreen toggles; `Esc` exits.
Expected: both work; `node scripts/cdp-shot.mjs menu.png` shows the menu.

---

### Task 8: Global shortcuts — double-Ctrl+C close, Ctrl+1..8 surface jump, Ctrl+Tab agent cycle (#5, #7, #8)

**Files:**
- Modify: `frontend/app/view/agents/agents.tsx` (add `SURFACE_ORDER` export + `cycleFocus` method)
- Modify: `frontend/app/cockpit/cockpit-root.tsx:49-58` (add capture-phase key handler)

Rationale: a `window` keydown listener registered with `capture: true` fires before xterm's textarea handler, so it can fully intercept Ctrl+Tab / Ctrl+1..8 (preventing PTY leakage) while leaving a single Ctrl+C untouched so the TUI still interrupts.

- [ ] **Step 1: Export `SURFACE_ORDER` and add `cycleFocus` in agents.tsx**

Find the `SurfaceKey` type (line 24) and add, right after the type definition, an exported ordered list matching the NavRail (`navrail.tsx:86-95`):
```ts
export const SURFACE_ORDER: SurfaceKey[] = [
    "cockpit",
    "agent",
    "activity",
    "channels",
    "sessions",
    "files",
    "memory",
    "usage",
];
```

Add a `cycleFocus` method to the `AgentsViewModel` class (near `openTerminal`, around line 102). Ensure `cycleId` is imported from `./agentsviewmodel` at the top of `agents.tsx` (add it to the existing import from that module):
```ts
    // Cycle the focused agent (Ctrl+Tab). askingOnly restricts to asking agents (Ctrl+Shift+Tab).
    cycleFocus(askingOnly: boolean) {
        const agents = globalStore.get(this.agentsAtom);
        const byId = new Map(agents.map((a) => [a.id, a]));
        const ordered = globalStore.get(this.orderAtom).filter((id) => byId.has(id));
        let ids = ordered.length ? ordered : agents.map((a) => a.id);
        if (askingOnly) {
            ids = ids.filter((id) => byId.get(id)?.state === "asking");
        }
        const next = cycleId(ids, globalStore.get(this.focusIdAtom), 1);
        if (next != null) {
            globalStore.set(this.focusIdAtom, next);
        }
    }
```

- [ ] **Step 2: Add the capture-phase key handler in cockpit-root.tsx**

Add imports at the top:
```ts
import { SURFACE_ORDER } from "@/app/view/agents/agents";
import { confirmCloseAgent } from "@/app/view/agents/agentactions";
```

In `CockpitBody`, add a ref for the last-Ctrl+C timestamp (near the other refs, ~line 37):
```ts
    const lastCtrlCRef = useRef<number | null>(null);
```

Add a NEW `useEffect` (leave the existing Ctrl+N effect at 49-58 intact) after it:
```ts
    useEffect(() => {
        const DOUBLE_CTRL_C_MS = 500;
        const onKeyCapture = (e: KeyboardEvent) => {
            if (!e.ctrlKey || e.altKey || e.metaKey) {
                return;
            }
            // Ctrl+1..8 -> jump directly to a surface (works on any surface, even in the terminal)
            if (!e.shiftKey && /^[1-8]$/.test(e.key)) {
                e.preventDefault();
                e.stopImmediatePropagation();
                globalStore.set(model.surfaceAtom, SURFACE_ORDER[parseInt(e.key, 10) - 1]);
                return;
            }
            const surface = globalStore.get(model.surfaceAtom);
            // Ctrl+Tab / Ctrl+Shift+Tab -> cycle agents (Agent surface only)
            if (e.key === "Tab" && surface === "agent") {
                e.preventDefault();
                e.stopImmediatePropagation();
                model.cycleFocus(e.shiftKey);
                return;
            }
            // Double Ctrl+C inside the focused terminal -> close the agent. Single Ctrl+C is left
            // untouched (not stopped) so it still reaches the PTY and interrupts the TUI.
            if ((e.key === "c" || e.key === "C") && !e.shiftKey && surface === "agent") {
                const inTerm =
                    (document.activeElement as HTMLElement | null)?.closest?.(".cockpit-focus-pane") != null;
                if (!inTerm) {
                    return;
                }
                const now = Date.now();
                if (lastCtrlCRef.current != null && now - lastCtrlCRef.current < DOUBLE_CTRL_C_MS) {
                    lastCtrlCRef.current = null;
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    const agents = globalStore.get(model.agentsAtom);
                    const fid = globalStore.get(model.focusIdAtom);
                    const a = agents.find((x) => x.id === fid) ?? agents[0];
                    if (a) {
                        confirmCloseAgent(a.id, a.name);
                    }
                } else {
                    lastCtrlCRef.current = now; // first press: fall through so the PTY receives ^C
                }
            }
        };
        window.addEventListener("keydown", onKeyCapture, true);
        return () => window.removeEventListener("keydown", onKeyCapture, true);
    }, [model]);
```

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no new errors.

- [ ] **Step 4: Run the full agents test suite (regression)**

Run: `npx vitest run frontend/app/view/agents`
Expected: PASS (all green).

- [ ] **Step 5: Live CDP verification**

On the running dev app:
1. From any surface, press `Ctrl+1`..`Ctrl+8` → active surface jumps to Cockpit/Agent/Activity/Channels/Sessions/Files/Memory/Usage respectively (verify with `cdp-shot.mjs`).
2. On the Agent surface with the terminal focused, press `Ctrl+Tab` → focused agent advances (wraps); `Ctrl+Shift+Tab` → advances among asking agents only. Confirm the TUI receives NO stray Tab characters.
3. In the focused terminal, press `Ctrl+C` once → the TUI interrupts (no close). Press `Ctrl+C` twice quickly → the "Close terminal" confirm modal appears.
Expected: all behaviors as described.

---

### Task 9: Full verification + single commit (approval-gated)

- [ ] **Step 1: Full frontend test run**

Run: `npx vitest run`
Expected: green except any pre-existing unrelated failures (note them explicitly if present).

- [ ] **Step 2: Full typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: only the ~3 baseline `frontend/tauri/api.test.ts` errors.

- [ ] **Step 3: Self-review the diff**

Run: `git diff --stat` and `git status`.
Confirm only the intended files changed; no debug logs or commented-out code.

- [ ] **Step 4: Present for approval, then commit**

Show the file list (M/A) + a proposed message and ask for approval (per CLAUDE.md — do NOT commit before "yes"). The spec + plan docs fold into this feature commit (not a separate docs commit). Proposed message:
```
fix(agents): correct status, TUI reflow, usage panel + add tab/agent shortcuts

- status: backend "waiting" no longer renders as "asking" (asking now only from agent:ask)
- terminal: keep the agent terminal mounted across surface switches so the TUI no longer mangles
- usage: show one row per agent (stop first-per-provider dedup)
- add right-click toolbar on the agent header + `f` fullscreen shortcut
- add Ctrl+1..8 surface jump, Ctrl+Tab/Ctrl+Shift+Tab agent cycling, double-Ctrl+C close
```

---

## Self-Review

**Spec coverage:**
- #1 status → Task 1. #2 TUI mangle → Tasks 4+5. #3 right-click toolbar → Task 7. #4 tool-group shortcut → Task 7 (`f`; Interrupt=Esc/`d` exist). #5 Ctrl+C close → Tasks 6+8. #6 usage → Task 2. #7 Ctrl+1..8 → Task 8. #8 Ctrl+Tab cycle → Tasks 3+8. All covered.

**Placeholder scan:** none — every code step shows full code and exact commands.

**Type consistency:** `providerPlanUsage` returns `{agentId,name,provider,usage}[]` (Task 2) consumed as `usageRows` in cockpitsurface (Task 2 Step 5). `cycleId(ids,current,delta)` (Task 3) called by `cycleFocus` (Task 8). `confirmCloseAgent(agentId,agentName)` (Task 6) called by agentheader (Task 6) and cockpit-root (Task 8). `SURFACE_ORDER: SurfaceKey[]` (Task 8) indexed by Ctrl+1..8. Consistent throughout.
