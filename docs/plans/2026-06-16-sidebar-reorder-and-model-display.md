# Session Reordering + Model Display — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add drag-to-reorder of sessions within a sidebar group, and a quiet model tag on each session row and (when it differs from the parent) each subagent row.

**Architecture:** Reorder rewrites `workspace.tabids` via the existing `UpdateWorkspaceTabIdsCommand` (single source of truth, shared with the tab bar), using a pure slot-preserving function. Model display rides the existing reporter → `wsh agentstatus` → `Event_AgentStatus` → atom path: a new `model` field flows through, sourced by the reporter reading the transcript JSONL (the only place the model exists — it is not in hook payloads).

**Tech Stack:** Go (`pkg/baseds`, `cmd/wsh`), TypeScript/React + Jotai (frontend), Vitest (frontend tests), Python + unittest (the reporter, in a **separate repo**: `C:\Users\kael02\IdeaProjects\agent-status-spike`).

**Spec:** `docs/specs/2026-06-16-sidebar-reorder-and-model-display-design.md`

---

## Conventions for this plan

- **Vitest, run from the project root** (`C:\Users\kael02\IdeaProjects\waveterm`):
  `npx vitest run frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts`
- **Go has no build/test step here.** Per project rules, do **not** run `go build`/`go run`; "compiles" = no errors in the editor's Problems panel. Go tasks end at "no editor errors."
- **`task generate`** regenerates `frontend/types/gotypes.d.ts` and `frontend/app/store/wshclientapi.ts` from Go types. Never hand-edit those files.
- **Commits (your git policy overrides the skill):** do NOT commit per-task. Each task ends at "tests green / no editor errors." There is ONE commit task at the very end, gated on your explicit approval. Before that commit, re-check `git status`/branch — the tree is edited from parallel sessions.
- **Part A (reorder) is fully independent** of Part B and ships on its own. Part B order matters: transport → reporter → frontend.

---

## Part A — Reorder within a group

### Task A1: Pure `reorderWithinGroup`

**Files:**
- Modify: `frontend/app/tab/sessionsidebar/sessionviewmodel.ts`
- Test: `frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `sessionviewmodel.test.ts` — first add `reorderWithinGroup` to the existing import block at the top, then append this describe block:

```ts
describe("reorderWithinGroup", () => {
    it("moves a member up within a contiguous group", () => {
        expect(reorderWithinGroup(["a", "b", "c"], ["a", "b", "c"], "c", "a", true)).toEqual(["c", "a", "b"]);
    });
    it("moves a member down (placeBefore=false)", () => {
        expect(reorderWithinGroup(["a", "b", "c"], ["a", "b", "c"], "a", "b", false)).toEqual(["b", "a", "c"]);
    });
    it("leaves other groups' interleaved tabs byte-for-byte untouched", () => {
        // group = a,b,c at slots 0,2,4; x,y at 1,3 belong to other groups
        expect(reorderWithinGroup(["a", "x", "b", "y", "c"], ["a", "b", "c"], "c", "a", true)).toEqual([
            "c", "x", "a", "y", "b",
        ]);
    });
    it("works for the pinned group (members are the pinned ids)", () => {
        expect(reorderWithinGroup(["p1", "p2", "g1"], ["p1", "p2"], "p2", "p1", true)).toEqual(["p2", "p1", "g1"]);
    });
    it("returns the input unchanged when dragged === target", () => {
        const tabids = ["a", "b", "c"];
        expect(reorderWithinGroup(tabids, ["a", "b", "c"], "a", "a", true)).toBe(tabids);
    });
    it("returns the input unchanged when either id is not a member", () => {
        const tabids = ["a", "b", "c"];
        expect(reorderWithinGroup(tabids, ["a", "b"], "a", "c", true)).toBe(tabids);
        expect(reorderWithinGroup(tabids, ["a", "b"], "zzz", "a", true)).toBe(tabids);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts -t reorderWithinGroup`
Expected: FAIL — `reorderWithinGroup is not a function` (or import error).

- [ ] **Step 3: Implement `reorderWithinGroup`**

Add to `sessionviewmodel.ts` (place it right after `flattenVisualOrder`, before `cycleTarget`):

```ts
/** Pure: move draggedId before/after targetId within a single group, rewriting only the slots the
 *  group occupies in tabids — so group order (first-appearance) and every other group are left
 *  byte-for-byte identical. Returns the input array (same ref) on a no-op or when either id is not a
 *  member of the group. Reorders the Pinned group too (members = the pinned tabIds). */
export function reorderWithinGroup(
    tabids: string[],
    memberIds: string[],
    draggedId: string,
    targetId: string,
    placeBefore: boolean
): string[] {
    if (draggedId === targetId) {
        return tabids;
    }
    if (!memberIds.includes(draggedId) || !memberIds.includes(targetId)) {
        return tabids;
    }
    const without = memberIds.filter((id) => id !== draggedId);
    const targetIdx = without.indexOf(targetId);
    const insertAt = placeBefore ? targetIdx : targetIdx + 1;
    const newOrder = [...without.slice(0, insertAt), draggedId, ...without.slice(insertAt)];
    const slots = memberIds.map((id) => tabids.indexOf(id)).sort((a, b) => a - b);
    const result = [...tabids];
    slots.forEach((slot, i) => {
        result[slot] = newOrder[i];
    });
    return result;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts -t reorderWithinGroup`
Expected: PASS (6 passing).

---

### Task A2: `reorderSession` action

**Files:**
- Modify: `frontend/app/tab/sessionsidebar/sessionsidebarmodel.ts`

(No unit test: this is thin glue over an RPC; the reorder logic is covered by A1.)

- [ ] **Step 1: Add `reorderWithinGroup` to the existing import from `./sessionviewmodel`**

In `sessionsidebarmodel.ts`, find the import block `import { ... } from "./sessionviewmodel";` and add `reorderWithinGroup,` to it.

- [ ] **Step 2: Add the `reorderSession` function**

Append to `sessionsidebarmodel.ts`:

```ts
/** Reorder a session within its group by rewriting the workspace tab order (shared with the tab bar).
 *  No-op when the computed order is unchanged or the workspace is missing. */
export function reorderSession(memberIds: string[], draggedId: string, targetId: string, placeBefore: boolean) {
    const ws = globalStore.get(atoms.workspace);
    if (ws?.oid == null) {
        return;
    }
    const tabIds = ws.tabids ?? [];
    const next = reorderWithinGroup(tabIds, memberIds, draggedId, targetId, placeBefore);
    if (next.length === tabIds.length && next.every((id, i) => id === tabIds[i])) {
        return;
    }
    fireAndForget(() => RpcApi.UpdateWorkspaceTabIdsCommand(TabRpcClient, ws.oid, next));
}
```

- [ ] **Step 3: Verify no editor errors**

Confirm the Problems panel shows no TypeScript errors for `sessionsidebarmodel.ts` (`RpcApi.UpdateWorkspaceTabIdsCommand`, `atoms`, `globalStore`, `TabRpcClient`, `fireAndForget` are all already imported in this file).

---

### Task A3: Drag-and-drop UI

**Files:**
- Modify: `frontend/app/tab/sessionsidebar/sessionrow.tsx` (add drag props + drop indicator to `SessionRow`)
- Modify: `frontend/app/tab/sessionsidebar/sessionsidebar.tsx` (drag state + handlers, pass `memberIds`)

(No unit test: native DnD wiring; the reorder math is A1, persistence is A2. Manual verification at the end.)

- [ ] **Step 1: Extend the `SessionRow` props and root element**

In `sessionrow.tsx`, add these fields to `interface SessionRowProps` (after `onDuplicate?`):

```ts
    onDragStart?: (e: React.DragEvent) => void;
    onDragOver?: (e: React.DragEvent) => void;
    onDrop?: (e: React.DragEvent) => void;
    onDragEnd?: () => void;
    dropIndicator?: "top" | "bottom";
```

Add them to the destructured params of `SessionRow({ ... })` (after `onDuplicate,`):

```ts
    onDragStart,
    onDragOver,
    onDrop,
    onDragEnd,
    dropIndicator,
```

On the root `<div>` of `SessionRow`, add the `draggable` + handlers and two indicator classes. The div currently is:

```tsx
        <div
            className={cn(
                "session-row group flex min-h-8 w-full cursor-pointer items-center gap-2 border-l-2 border-transparent py-1 pl-2 pr-1.5 transition-colors",
                !active && !blocked && "hover:bg-[rgba(255,255,255,0.08)]",
                active && "session-row--active border-l-[#429dff] bg-[rgba(66,157,255,0.08)] hover:bg-[rgba(66,157,255,0.14)]",
                blocked && "session-row--blocked border-l-[#d29922] bg-[rgba(210,153,34,0.08)] hover:bg-[rgba(210,153,34,0.14)]"
            )}
            onClick={onSelect}
            onContextMenu={onContextMenu}
        >
```

Replace it with (adds `draggable={!editing}`, the four drag handlers, and two `shadow-[inset…]` indicator classes — box-shadow avoids any layout shift):

```tsx
        <div
            className={cn(
                "session-row group flex min-h-8 w-full cursor-pointer items-center gap-2 border-l-2 border-transparent py-1 pl-2 pr-1.5 transition-colors",
                !active && !blocked && "hover:bg-[rgba(255,255,255,0.08)]",
                active && "session-row--active border-l-[#429dff] bg-[rgba(66,157,255,0.08)] hover:bg-[rgba(66,157,255,0.14)]",
                blocked && "session-row--blocked border-l-[#d29922] bg-[rgba(210,153,34,0.08)] hover:bg-[rgba(210,153,34,0.14)]",
                dropIndicator === "top" && "shadow-[inset_0_2px_0_0_#429dff]",
                dropIndicator === "bottom" && "shadow-[inset_0_-2px_0_0_#429dff]"
            )}
            draggable={!editing}
            onClick={onSelect}
            onContextMenu={onContextMenu}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDrop={onDrop}
            onDragEnd={onDragEnd}
        >
```

- [ ] **Step 2: Add drag state to `SessionSidebar`**

In `sessionsidebar.tsx`, change the React import to include `useState`:

```tsx
import { useEffect, useRef, useState } from "react";
```

Add `reorderSession` to the existing import from `./sessionsidebarmodel` (add `reorderSession,` to that import list).

Inside `SessionSidebar`, after the existing `const collapsed = new Set(collapsedGroups);` line, add:

```tsx
    const [drag, setDrag] = useState<{ draggedId: string; overId: string; placeBefore: boolean }>(null);
```

(Atom rule: this is a plain React local state, not a Jotai atom — `null` initial is fine.)

- [ ] **Step 3: Thread `memberIds` + drag into `SessionRowTree`**

In `sessionsidebar.tsx`, change the `SessionRowTree` signature and add the drag handlers. Replace the whole `function SessionRowTree(...) { ... }` with:

```tsx
function SessionRowTree({
    row,
    memberIds,
    drag,
    setDrag,
}: {
    row: SessionRowVM;
    memberIds: string[];
    drag: { draggedId: string; overId: string; placeBefore: boolean };
    setDrag: (d: { draggedId: string; overId: string; placeBefore: boolean }) => void;
}) {
    const renameRef = useRef<(() => void) | null>(null);
    const onContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        ContextMenuModel.getInstance().showContextMenu(buildSessionRowMenu(row, renameRef), e);
    };
    const canDrop = drag != null && memberIds.includes(drag.draggedId);
    const isSource = drag?.draggedId === row.tabId;
    const dropIndicator = !isSource && drag?.overId === row.tabId ? (drag.placeBefore ? "top" : "bottom") : undefined;
    const onDragStart = () => setDrag({ draggedId: row.tabId, overId: row.tabId, placeBefore: true });
    const onDragOver = (e: React.DragEvent) => {
        if (!canDrop) {
            return;
        }
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        const placeBefore = e.clientY < rect.top + rect.height / 2;
        if (drag.overId !== row.tabId || drag.placeBefore !== placeBefore) {
            setDrag({ draggedId: drag.draggedId, overId: row.tabId, placeBefore });
        }
    };
    const onDrop = (e: React.DragEvent) => {
        if (!canDrop) {
            return;
        }
        e.preventDefault();
        reorderSession(memberIds, drag.draggedId, row.tabId, drag.placeBefore);
        setDrag(null);
    };
    return (
        <>
            <SessionRow
                label={row.label}
                status={row.status}
                active={row.active}
                blocked={row.blocked}
                pinned={row.pinned}
                detail={row.detail}
                subagentCount={row.subagents.length}
                expanded={row.subagentsExpanded}
                editValue={row.customLabel}
                renameRef={renameRef}
                onContextMenu={onContextMenu}
                onDuplicate={row.termBlockOref ? () => duplicateSession(row.tabId) : undefined}
                onToggleExpand={() => toggleSubagentExpand(row.termBlockOref, row.subagentsExpanded)}
                onRename={(name) => renameSession(row.tabId, name)}
                onSelect={() => setActiveTab(row.tabId)}
                onTogglePin={() => togglePin(row.tabId, row.pinned)}
                onDragStart={onDragStart}
                onDragOver={onDragOver}
                onDrop={onDrop}
                onDragEnd={() => setDrag(null)}
                dropIndicator={dropIndicator}
            />
            {row.subagentsExpanded &&
                row.subagents.map((sa, i) => (
                    <SubagentRow key={sa.id} type={sa.type} state={sa.state} last={i === row.subagents.length - 1} />
                ))}
        </>
    );
}
```

- [ ] **Step 4: Pass `memberIds` + drag from the two render sites**

In `sessionsidebar.tsx`, in the Pinned group, replace:

```tsx
                    {vm.pinned.map((r) => (
                        <SessionRowTree key={r.tabId} row={r} />
                    ))}
```

with:

```tsx
                    {vm.pinned.map((r) => (
                        <SessionRowTree
                            key={r.tabId}
                            row={r}
                            memberIds={vm.pinned.map((p) => p.tabId)}
                            drag={drag}
                            setDrag={setDrag}
                        />
                    ))}
```

And in the `vm.groups.map((g) => ...)` block, replace:

```tsx
                    {g.sessions.map((r) => (
                        <SessionRowTree key={r.tabId} row={r} />
                    ))}
```

with:

```tsx
                    {g.sessions.map((r) => (
                        <SessionRowTree
                            key={r.tabId}
                            row={r}
                            memberIds={g.sessions.map((s) => s.tabId)}
                            drag={drag}
                            setDrag={setDrag}
                        />
                    ))}
```

- [ ] **Step 5: Verify no editor errors + run the full sidebar test file**

Confirm no TypeScript errors in `sessionrow.tsx` and `sessionsidebar.tsx`.
Run: `npx vitest run frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts`
Expected: PASS (all existing + A1 tests).

---

## Part B — Model display

### Task B1: Go transport fields (`baseds`)

**Files:**
- Modify: `pkg/baseds/baseds.go`

- [ ] **Step 1: Add the `model` action constant**

In `baseds.go`, in the const block that has `SubagentAction_Start` / `SubagentAction_Stop`, add a `Model` action:

```go
const (
	SubagentAction_Start = "start"
	SubagentAction_Stop  = "stop"
	SubagentAction_Model = "model"

	SubagentStatus_Success = "success"
	SubagentStatus_Failure = "failure"
)
```

- [ ] **Step 2: Add the `Model` field to both payload structs**

In `AgentSubagentDelta`, add `Model` (after `Status`):

```go
type AgentSubagentDelta struct {
	Action string `json:"action"`           // SubagentAction_Start | SubagentAction_Stop | SubagentAction_Model
	Id     string `json:"id"`
	Type   string `json:"type,omitempty"`   // agent_type (e.g. Explore, Plan)
	Status string `json:"status,omitempty"` // SubagentStatus_* (stop only)
	Model  string `json:"model,omitempty"`  // resolved model id (e.g. claude-sonnet-4-6)
}
```

In `AgentStatusData`, add `Model` (after `Agent`):

```go
type AgentStatusData struct {
	ORef     string              `json:"oref"`
	State    string              `json:"state"`
	Detail   string              `json:"detail,omitempty"`
	Agent    string              `json:"agent,omitempty"`
	Model    string              `json:"model,omitempty"`
	Ts       int64               `json:"ts"`
	Subagent *AgentSubagentDelta `json:"subagent,omitempty"`
}
```

- [ ] **Step 3: Verify no editor errors**

Confirm the Problems panel shows no Go errors for `baseds.go`.

---

### Task B2: `wsh agentstatus` model flags

**Files:**
- Modify: `cmd/wsh/cmd/wshcmd-agentstatus.go`

- [ ] **Step 1: Declare the new flag vars**

In the `var ( ... )` block that holds `agentStatusAgent`, `agentSubagentStart`, etc., add:

```go
	agentStatusModel string

	agentSubagentModel bool
```

(Place `agentStatusModel` next to `agentStatusAgent`, and `agentSubagentModel` next to the other `agentSubagent*` bools.)

- [ ] **Step 2: Register the flags in `init()`**

Add to `init()` (after the existing `--agent` and subagent flag registrations):

```go
	agentStatusCmd.Flags().StringVar(&agentStatusModel, "model", "", "resolved model id (e.g. claude-sonnet-4-6)")
	agentStatusCmd.Flags().BoolVar(&agentSubagentModel, "subagent-model", false, "report a subagent's resolved model (requires --id, --model)")
```

- [ ] **Step 3: Route the model-update delta + set parent model**

In `agentStatusRun`, change the subagent branch to also catch `--subagent-model`:

```go
	if agentSubagentStart || agentSubagentStop || agentSubagentModel {
		return publishSubagentDelta(oref)
	}
```

And set the parent model on the state event — change the `eventData` literal to include `Model`:

```go
	eventData := baseds.AgentStatusData{
		ORef:   oref.String(),
		State:  agentStatusState,
		Detail: agentStatusDetail,
		Agent:  agentStatusAgent,
		Model:  agentStatusModel,
		Ts:     time.Now().UnixMilli(),
	}
```

- [ ] **Step 4: Handle the model action in `publishSubagentDelta`**

In `publishSubagentDelta`, after the `if agentSubagentStop { ... }` block that sets `action`/`status`, add the model action and require `--model`:

```go
	if agentSubagentModel {
		action = baseds.SubagentAction_Model
		if agentStatusModel == "" {
			return fmt.Errorf("--model is required with --subagent-model")
		}
	}
```

Then add `Model: agentStatusModel,` to the `AgentSubagentDelta` literal:

```go
		Subagent: &baseds.AgentSubagentDelta{
			Action: action,
			Id:     agentSubagentId,
			Type:   agentSubagentType,
			Status: status,
			Model:  agentStatusModel,
		},
```

(The existing `--id` requirement check already covers `--subagent-model` since it runs for all three actions.)

- [ ] **Step 5: Verify no editor errors**

Confirm no Go errors for `wshcmd-agentstatus.go`.

---

### Task B3: Regenerate TypeScript types

**Files:**
- Generated (do not hand-edit): `frontend/types/gotypes.d.ts`

- [ ] **Step 1: Run codegen**

Run: `task generate`
Expected: completes without error; `git diff frontend/types/gotypes.d.ts` shows `model?: string;` added to both `AgentStatusData` and `AgentSubagentDelta`.

- [ ] **Step 2: Confirm the generated change**

Run: `npx vitest run --version` is NOT needed; instead inspect: `git diff -- frontend/types/gotypes.d.ts`
Expected: the two `model?: string;` additions and nothing unrelated.

---

### Task B4: Pure `modelLabel`

**Files:**
- Modify: `frontend/app/tab/sessionsidebar/sessionviewmodel.ts`
- Test: `frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts`

- [ ] **Step 1: Write the failing tests**

Add `modelLabel` to the test file's import block, then append:

```ts
describe("modelLabel", () => {
    it("maps known families by substring", () => {
        expect(modelLabel("claude-opus-4-8")).toBe("opus");
        expect(modelLabel("claude-sonnet-4-6")).toBe("sonnet");
        expect(modelLabel("claude-haiku-4-5-20251001")).toBe("haiku");
        expect(modelLabel("claude-fable-5")).toBe("fable");
    });
    it("strips a leading claude- for unknown ids", () => {
        expect(modelLabel("claude-foo-9")).toBe("foo-9");
    });
    it("returns empty for missing input", () => {
        expect(modelLabel("")).toBe("");
        expect(modelLabel(undefined)).toBe("");
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts -t modelLabel`
Expected: FAIL — `modelLabel is not a function`.

- [ ] **Step 3: Implement**

Add to `sessionviewmodel.ts` (near the other small pure helpers, e.g. after `subagentExpanded`):

```ts
const MODEL_FAMILIES = ["opus", "sonnet", "haiku", "fable"];

/** Pure: a raw model id (e.g. "claude-opus-4-8") -> a short family label for the row tag.
 *  Unknown ids fall back to the id with a leading "claude-" stripped. Empty input -> "". */
export function modelLabel(modelId?: string): string {
    if (!modelId) {
        return "";
    }
    const lower = modelId.toLowerCase();
    for (const fam of MODEL_FAMILIES) {
        if (lower.includes(fam)) {
            return fam;
        }
    }
    return modelId.replace(/^claude-/i, "");
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts -t modelLabel`
Expected: PASS (3 passing).

---

### Task B5: Carry model through the reducer + view model

**Files:**
- Modify: `frontend/app/tab/sessionsidebar/sessionviewmodel.ts`
- Test: `frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `sessionviewmodel.test.ts`:

```ts
describe("reduceSubagents — model", () => {
    it("model action sets the model on an existing subagent without changing state", () => {
        const started = reduceSubagents([], { action: "start", id: "a", type: "Explore" });
        expect(reduceSubagents(started, { action: "model", id: "a", type: "Explore", model: "claude-sonnet-4-6" })).toEqual([
            { id: "a", type: "Explore", state: "working", model: "claude-sonnet-4-6" },
        ]);
    });
    it("model action before start appends a working entry carrying the model", () => {
        expect(reduceSubagents([], { action: "model", id: "a", type: "Explore", model: "claude-opus-4-8" })).toEqual([
            { id: "a", type: "Explore", state: "working", model: "claude-opus-4-8" },
        ]);
    });
    it("stop after model preserves the model", () => {
        let l = reduceSubagents([], { action: "start", id: "a", type: "E" });
        l = reduceSubagents(l, { action: "model", id: "a", type: "E", model: "claude-haiku-4-5" });
        l = reduceSubagents(l, { action: "stop", id: "a", type: "E", status: "success" });
        expect(l).toEqual([{ id: "a", type: "E", state: "success", model: "claude-haiku-4-5" }]);
    });
});

describe("buildSessionViewModel — model", () => {
    it("carries the session model onto the row", () => {
        const vm = buildSessionViewModel([input({ tabId: "t1", cwd: "/src/X", model: "claude-opus-4-8" })]);
        expect(vm.groups[0].sessions[0].model).toBe("claude-opus-4-8");
    });
});
```

Note: existing `reduceSubagents` tests assert objects without a `model` key; Vitest `toEqual` ignores `undefined` properties, so `start` adding `model: undefined` keeps them green.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts -t model`
Expected: FAIL — `model` is not a valid `SubagentDelta.action` / `row.model` undefined.

- [ ] **Step 3: Extend the types, reducer, and row mapping**

In `sessionviewmodel.ts`:

(a) `SubagentVM` — add `model`:

```ts
export interface SubagentVM {
    id: string;
    type: string;
    state: SubagentState;
    model?: string;
}
```

(b) `SubagentDelta` — add the `model` action and field:

```ts
export interface SubagentDelta {
    action: "start" | "stop" | "model";
    id: string;
    type: string;
    status?: "success" | "failure";
    model?: string;
}
```

(c) Replace `reduceSubagents` with the model-aware version:

```ts
export function reduceSubagents(list: SubagentVM[], delta: SubagentDelta): SubagentVM[] {
    if (delta.action === "start") {
        if (list.some((s) => s.id === delta.id)) {
            return list;
        }
        return [...list, { id: delta.id, type: delta.type, state: "working", model: delta.model }];
    }
    if (delta.action === "model") {
        if (!list.some((s) => s.id === delta.id)) {
            return [...list, { id: delta.id, type: delta.type, state: "working", model: delta.model }];
        }
        return list.map((s) => (s.id === delta.id ? { ...s, model: delta.model } : s));
    }
    const state: SubagentState = delta.status === "failure" ? "failure" : "success";
    if (!list.some((s) => s.id === delta.id)) {
        return [...list, { id: delta.id, type: delta.type, state, model: delta.model }];
    }
    return list.map((s) => (s.id === delta.id ? { ...s, state, model: delta.model ?? s.model } : s));
}
```

(d) `SessionInput` — add `model?: string;` (after `detail?`).

(e) `SessionRowVM` — add `model?: string;` (after `detail?`).

(f) `toRow` — carry it through; add `model: s.model,` to the returned object (next to `detail: s.detail,`).

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts`
Expected: PASS (all suites, including the pre-existing `reduceSubagents` block).

---

### Task B6: Map the model delta in the event store

**Files:**
- Modify: `frontend/app/tab/sessionsidebar/agentstatusstore.ts`

(No unit test: this is event-handler glue; reducer behavior is covered in B5.)

- [ ] **Step 1: Build a three-action delta carrying the model**

In `agentstatusstore.ts`, inside the `if (data.subagent != null) { ... }` block, replace the `const delta: SubagentDelta = { ... }` literal with:

```ts
                const sa = data.subagent;
                const action: SubagentDelta["action"] =
                    sa.action === "stop" ? "stop" : sa.action === "model" ? "model" : "start";
                const delta: SubagentDelta = {
                    action,
                    id: sa.id,
                    type: sa.type ?? "",
                    status: normalizeSubagentStatus(sa.status),
                    model: sa.model,
                };
```

(The line `const sa = data.subagent;` already exists just above — if so, do not duplicate it; only replace the `delta` literal and add `action`. `sa.model` resolves once `task generate` (B3) has added `model?` to the `AgentSubagentDelta` TS type.)

- [ ] **Step 2: Verify no editor errors**

Confirm no TypeScript errors in `agentstatusstore.ts`.

---

### Task B7: Surface the session model into the view model input

**Files:**
- Modify: `frontend/app/tab/sessionsidebar/sessionsidebarmodel.ts`

(No unit test: derived-atom wiring; covered indirectly by B5's `buildSessionViewModel — model` test.)

- [ ] **Step 1: Read the model from the agent status atom and pass it through**

In `sessionsidebarmodel.ts`, inside `sessionSidebarViewModelAtom`, in the `if (termBlockId) { ... }` block, add a `model` capture. The block currently reads:

```ts
            const agentStatus = get(getAgentStatusAtom(termBlockOref));
            if (agentStatus?.state) {
                status = agentStatus.state as SessionStatus;
                detail = agentStatus.detail;
            }
```

Add a declaration `let model: string | undefined;` next to the other `let` declarations above the block (next to `let detail: string | undefined;`), and set it inside:

```ts
            const agentStatus = get(getAgentStatusAtom(termBlockOref));
            if (agentStatus?.state) {
                status = agentStatus.state as SessionStatus;
                detail = agentStatus.detail;
            }
            model = agentStatus?.model;
```

Then add `model,` to the returned `SessionInput` object literal (next to `detail,`).

- [ ] **Step 2: Verify no editor errors**

Confirm no TypeScript errors in `sessionsidebarmodel.ts`.

---

### Task B8: Render the model tag

**Files:**
- Modify: `frontend/app/tab/sessionsidebar/sessionrow.tsx`
- Modify: `frontend/app/tab/sessionsidebar/sessionsidebar.tsx`

(No unit test: presentational. Verified manually at the end. Exact styling is to be tuned live per the spec — the classes below are the starting point.)

- [ ] **Step 1: Import `modelLabel` in `sessionrow.tsx`**

Change the type-only import at the top of `sessionrow.tsx`:

```ts
import type { SessionStatus, SubagentState } from "./sessionviewmodel";
```

to a combined import (value + types):

```ts
import { modelLabel, type SessionStatus, type SubagentState } from "./sessionviewmodel";
```

- [ ] **Step 2: Add a `model` prop to `SessionRow` and render the tag**

Add `model?: string;` to `interface SessionRowProps` (after `detail?`), and `model,` to the destructured params.

Render the tag between the label/detail `<div>` and the `subagentCount` badge. Find this block:

```tsx
            </div>
            {subagentCount > 0 && (
                <span className="rounded bg-[rgba(255,255,255,0.08)] px-1 text-[10px] tabular-nums text-secondary">
                    {subagentCount}
                </span>
            )}
```

Insert the tag right after the closing `</div>` (before the `subagentCount` span):

```tsx
            </div>
            {model && (
                <span
                    className="shrink-0 rounded bg-[rgba(255,255,255,0.06)] px-1 text-[10px] text-secondary opacity-80"
                    title={model}
                >
                    {modelLabel(model)}
                </span>
            )}
            {subagentCount > 0 && (
                <span className="rounded bg-[rgba(255,255,255,0.08)] px-1 text-[10px] tabular-nums text-secondary">
                    {subagentCount}
                </span>
            )}
```

- [ ] **Step 3: Add `model` + `parentModel` to `SubagentRow` (show only when it differs)**

Change `interface SubagentRowProps` to:

```ts
interface SubagentRowProps {
    type: string;
    state: SubagentState;
    last: boolean;
    model?: string;
    parentModel?: string;
}
```

Replace the `SubagentRow` body with (adds an `ml-auto` tag rendered only when the subagent model is known and differs from the parent):

```tsx
export function SubagentRow({ type, state, last, model, parentModel }: SubagentRowProps) {
    return (
        <div className="flex min-h-6 w-full items-center gap-1.5 py-0.5 pl-6 pr-1.5 text-[13px] text-secondary">
            <span className="select-none font-mono text-[11px] opacity-50">{last ? "└─" : "├─"}</span>
            <span className="font-mono text-[11px] leading-none" style={{ color: SUBAGENT_MARKER_COLOR[state] }}>
                {SUBAGENT_MARKER[state]}
            </span>
            <span className="min-w-0 flex-1 truncate" title={type}>
                {type}
            </span>
            {model && model !== parentModel && (
                <span
                    className="ml-auto shrink-0 rounded bg-[rgba(255,255,255,0.06)] px-1 text-[10px] opacity-80"
                    title={model}
                >
                    {modelLabel(model)}
                </span>
            )}
        </div>
    );
}
```

- [ ] **Step 4: Pass the model props from `SessionRowTree`**

In `sessionsidebar.tsx`, add `model={row.model}` to the `<SessionRow ... />` props (next to `detail={row.detail}`), and pass the subagent model + parent model in the `.map`:

```tsx
            {row.subagentsExpanded &&
                row.subagents.map((sa, i) => (
                    <SubagentRow
                        key={sa.id}
                        type={sa.type}
                        state={sa.state}
                        last={i === row.subagents.length - 1}
                        model={sa.model}
                        parentModel={row.model}
                    />
                ))}
```

- [ ] **Step 5: Verify no editor errors + run the suite**

Confirm no TypeScript errors in `sessionrow.tsx` / `sessionsidebar.tsx`.
Run: `npx vitest run frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts`
Expected: PASS.

---

### Task B9: Reporter — read & report the model  ⚠️ SEPARATE REPO (not a waveterm commit)

**Repo:** `C:\Users\kael02\IdeaProjects\agent-status-spike`
**Files:**
- Modify: `agent_status_reporter.py`
- Modify (refresh stale tests): `test_reporter.py`

**Run tests with:** `cd /c/Users/kael02/IdeaProjects/agent-status-spike && python -m pytest test_reporter.py -v`

> The existing `test_reporter.py` is stale — it asserts the old badge contract (`{"action": "set", ...}` and `["wsh", "badge", ...]`). The current `decide()` returns `agentstatus` argv tails. Step 1 brings the tests current AND adds the new pure-function tests. (Do not silently leave the stale tests failing.)

- [ ] **Step 1: Replace `test_reporter.py` with current-contract + model tests**

Overwrite `test_reporter.py` with:

```python
import os
import tempfile
import unittest

from agent_status_reporter import (
    AGENT,
    decide,
    build_argv,
    _last_model_in,
    _subagent_transcript_path,
    read_first_model,
)


class TestDecide(unittest.TestCase):
    def test_user_prompt_submit_is_working(self):
        self.assertEqual(decide({"hook_event_name": "UserPromptSubmit"}), ["--state", "working", "--agent", AGENT])

    def test_pre_tool_use_edit_carries_detail(self):
        self.assertEqual(
            decide({"hook_event_name": "PreToolUse", "tool_name": "Edit", "tool_input": {"file_path": "/x/foo.go"}}),
            ["--state", "working", "--agent", AGENT, "--detail", "editing foo.go"],
        )

    def test_notification_permission_prompt_is_waiting(self):
        self.assertEqual(
            decide({"hook_event_name": "Notification", "notification_type": "permission_prompt", "message": "approve?"}),
            ["--state", "waiting", "--detail", "approve?", "--agent", AGENT],
        )

    def test_stop_is_idle(self):
        self.assertEqual(decide({"hook_event_name": "Stop"}), ["--state", "idle", "--detail", "done · your move", "--agent", AGENT])

    def test_subagent_start(self):
        self.assertEqual(
            decide({"hook_event_name": "SubagentStart", "agent_id": "x", "agent_type": "Explore"}),
            ["--subagent-start", "--id", "x", "--type", "Explore", "--agent", AGENT],
        )

    def test_unmapped_event_is_ignored(self):
        self.assertIsNone(decide({"hook_event_name": "PreCompact"}))

    def test_missing_event_name_is_ignored(self):
        self.assertIsNone(decide({}))


class TestBuildArgv(unittest.TestCase):
    def test_prepends_wsh_agentstatus(self):
        self.assertEqual(
            build_argv(["--state", "working"], "wsh"),
            ["wsh", "agentstatus", "--state", "working"],
        )


class TestModelExtraction(unittest.TestCase):
    def test_last_model_in_returns_last_occurrence(self):
        text = '{"model":"claude-opus-4-8"}\n{"model":"claude-sonnet-4-6"}\n'
        self.assertEqual(_last_model_in(text), "claude-sonnet-4-6")

    def test_last_model_in_empty(self):
        self.assertEqual(_last_model_in("no model here"), "")

    def test_read_first_model_from_file(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "t.jsonl")
            with open(p, "w", encoding="utf-8") as f:
                f.write('{"type":"user"}\n{"type":"message","model":"claude-haiku-4-5"}\n')
            self.assertEqual(read_first_model(p), "claude-haiku-4-5")

    def test_read_first_model_missing_file(self):
        self.assertEqual(read_first_model("/no/such/file.jsonl"), "")


class TestSubagentTranscriptPath(unittest.TestCase):
    def test_derives_from_parent_transcript_and_agent_id(self):
        event = {"transcript_path": os.path.join("p", "sess.jsonl"), "agent_id": "a1"}
        self.assertEqual(
            _subagent_transcript_path(event),
            os.path.join("p", "sess", "subagents", "agent-a1.jsonl"),
        )

    def test_missing_fields_returns_empty(self):
        self.assertEqual(_subagent_transcript_path({"agent_id": "a1"}), "")
        self.assertEqual(_subagent_transcript_path({"transcript_path": "x.jsonl"}), "")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `cd /c/Users/kael02/IdeaProjects/agent-status-spike && python -m pytest test_reporter.py -v`
Expected: FAIL on import — `_last_model_in`, `_subagent_transcript_path`, `read_first_model`, `AGENT` not all importable yet (the model helpers don't exist).

- [ ] **Step 3: Add the model helpers to `agent_status_reporter.py`**

Add `import re` and `import time` to the imports at the top. Then add these functions (place them above `decide`):

```python
def _last_model_in(text):
    """Pure: last '"model":"..."' value in a chunk of transcript text, or ""."""
    matches = re.findall(r'"model"\s*:\s*"([^"]+)"', text)
    return matches[-1] if matches else ""


def read_last_model(path):
    """Current model: tail-read (~64KB) the parent transcript for the last assistant model."""
    if not path or not os.path.exists(path):
        return ""
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            chunk = min(size, 65536)
            f.seek(size - chunk)
            data = f.read().decode("utf-8", "replace")
    except OSError:
        return ""
    return _last_model_in(data)


def read_first_model(path):
    """Subagent model: head-read for the first assistant '"model"' (it appears on the first response)."""
    if not path or not os.path.exists(path):
        return ""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            head = f.read(65536)
    except OSError:
        return ""
    m = re.search(r'"model"\s*:\s*"([^"]+)"', head)
    return m.group(1) if m else ""


def _subagent_transcript_path(event):
    """Pure: derive .../<parent_session>/subagents/agent-<agent_id>.jsonl from a hook payload."""
    tp = event.get("transcript_path")
    agent_id = event.get("agent_id")
    if not tp or not agent_id:
        return ""
    base = os.path.splitext(tp)[0]
    return os.path.join(base, "subagents", f"agent-{agent_id}.jsonl")
```

- [ ] **Step 4: Run to verify the new pure-function tests pass**

Run: `cd /c/Users/kael02/IdeaProjects/agent-status-spike && python -m pytest test_reporter.py -v`
Expected: PASS (all tests, including `TestModelExtraction` and `TestSubagentTranscriptPath`).

- [ ] **Step 5: Wire model reporting into `main()`**

Replace the body of `main()` (the part after `tail = decide(event)` / `if tail is None: return` and after resolving `wsh_path`) so that: parent state events append `--model`; `SubagentStart` emits the start immediately then polls for the model; `SubagentStop` appends the model as a backstop. Replace the existing `try: subprocess.run(build_argv(tail, wsh_path), ...)` tail of `main()` with:

```python
    name = event.get("hook_event_name")

    if name == "SubagentStart":
        _run(build_argv(tail, wsh_path))
        _poll_and_report_subagent_model(event, wsh_path)
        return

    if name == "SubagentStop":
        sub_model = read_first_model(_subagent_transcript_path(event))
        if sub_model:
            tail = tail + ["--model", sub_model]
    elif name != "SubagentStart":
        parent_model = read_last_model(event.get("transcript_path"))
        if parent_model:
            tail = tail + ["--model", parent_model]

    _run(build_argv(tail, wsh_path))
```

Add these two helpers above `main()`:

```python
def _run(argv):
    """Fire a wsh call; never let a failure reach the agent."""
    try:
        subprocess.run(argv, timeout=5, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        pass


def _poll_and_report_subagent_model(event, wsh_path, timeout=5.0, interval=0.25):
    """After SubagentStart, watch the subagent transcript for its first model and report it once.
    Async hook (Claude does not wait); times out silently if the subagent never responds."""
    agent_id = event.get("agent_id")
    path = _subagent_transcript_path(event)
    if not agent_id or not path:
        return
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        model = read_first_model(path)
        if model:
            _run(build_argv(["--subagent-model", "--id", agent_id, "--model", model, "--agent", AGENT], wsh_path))
            return
        time.sleep(interval)
```

(`AGENT` and `build_argv` already exist in the module. Keep the existing `WAVETERM_BLOCKID` guard, the stdin JSON parse, and the `wsh = shutil.which("wsh")` lookup at the top of `main()` unchanged.)

- [ ] **Step 6: Re-run the tests (no regression)**

Run: `cd /c/Users/kael02/IdeaProjects/agent-status-spike && python -m pytest test_reporter.py -v`
Expected: PASS (the wiring change does not touch the pure functions under test).

---

## Final: verification + single commit (your approval required)

- [ ] **Step 1: Full frontend test run**

Run: `npx vitest run frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts`
Expected: PASS — all suites green.

- [ ] **Step 2: Manual smoke (real app)**

Use the `run` skill (or the CDP-on-:9222 dev workflow) to launch the dev app and confirm:
- Drag a session within a group reorders it; the order persists across reload; the tab bar reflects the same order; dragging onto another group does nothing.
- A session row shows its model tag; running a subagent on a different model shows that subagent's tag (and inherited subagents show none).

- [ ] **Step 3: Re-check the tree, then propose the commit**

The working tree is edited from parallel sessions — run `git status` and `git branch --show-current` first. Then present the file list + a `feat(sidebar): …` message and **await explicit approval before committing** (per your git policy: one batched commit, no auto-commit, no co-author).

---

## Self-review (done while writing)

- **Spec coverage:** §3 reorder → A1–A3; §4.4 transport → B1–B3; §4.3 reporter → B9; §4 reducer/label/threading → B4–B7; §4.5 UI (session tag + subagent-only-when-differs) → B8; §6 testing → tests in A1, B4, B5, B9. All covered.
- **Type consistency:** `reorderWithinGroup(tabids, memberIds, draggedId, targetId, placeBefore)` identical in A1/A2; `SubagentDelta.action` union `"start"|"stop"|"model"` + `model?` consistent across B5/B6; `modelLabel` signature consistent B4/B8; `Model`/`model` field names match Go (`json:"model"`) → generated `model?` → TS usage.
- **Placeholders:** none — every code step shows complete code; every run step shows the exact command + expected result.
