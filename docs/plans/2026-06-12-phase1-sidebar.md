# Phase 1 — Session Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Wave's left `VTabBar` with a `SessionSidebar` that groups terminal tabs into a Pinned group + auto service groups, renders a live per-session status dot (sourced from the Phase 0 `wsh badge`), with active/blocked accents, collapsible groups, aggregate dots, and a hover pin toggle.

**Architecture:** All grouping/status logic lives in **pure functions** (`sessionviewmodel.ts`), unit-tested with vitest. A thin **derived Jotai atom** collects per-tab data (tab object, badge, terminal-block cwd, pinned/agent meta, active flag) via `get()` and feeds the pure builder. **Plain-props presentational components** (`SessionRow`, `SessionGroup` in `sessionrow.tsx`) render the view model and are tested via `renderToStaticMarkup` (Wave's actual test style — no testing-library). The **container** (`sessionsidebar.tsx`) wires the atom, local collapse state, `setActiveTab`, and the pin toggle. One-line mount swap in `workspace.tsx`.

**Tech Stack:** React + TypeScript, Jotai atoms, Tailwind v4 utility classes (+ `cn()`), Font Awesome icons via `makeIconClass`, vitest (`renderToStaticMarkup` for components), Wave's `wos`/`global`/`badge` stores.

**Conventions for this plan:**
- **No `git commit` steps.** Per the repo owner's strict no-auto-commit rule, each task ends with a **verification checkpoint** (tests + typecheck). Commits are batched and made only with explicit approval.
- TDD: write the failing test, run it red, implement minimally, run it green.
- Keep changes **additive** (new files under `frontend/app/tab/sessionsidebar/`) per spec §10 fork hygiene; the only edit to an existing file is the mount swap in `workspace.tsx`.

**Prerequisites (already satisfied / out of plan scope):**
- The fork exists at `C:\Users\kael02\IdeaProjects\waveterm` (owner set it up).
- Phase 0 is GO: the reporter sets a tab/block badge via `wsh badge` (green `#3fb950` = working, amber `#d29922` = waiting, cleared = idle/done). This plan **consumes** that badge; it does not modify the reporter.
- To *see* the sidebar at runtime the setting `app:tabbar` must be `"left"` (Task 8).

**Deferred to later phases (explicitly NOT in Phase 1):** the secondary/detail activity line, `wsh agentstatus` + `Event_AgentStatus`, the marker-walk-up `GetSessionGroup` RPC + version-dir label heuristic (Phase 2); persisted collapse state, keyboard quick-switch, typed `MetaType` keys, long-name hover tooltips (Phase 3).

---

## File Structure

| File | Responsibility |
|---|---|
| `frontend/app/tab/sessionsidebar/sessionviewmodel.ts` | **Pure**: types + `cwdToServiceLabel`, `badgeToStatus`, `aggregateStatus`, `buildSessionViewModel`. No React, no Wave runtime. |
| `frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts` | Table-driven vitest tests for every pure function. The bulk of the testing (spec §11). |
| `frontend/app/tab/sessionsidebar/sessionrow.tsx` | **Plain-props presentational** `SessionRow` + `SessionGroup`. Imports only React, `@/util/util`, and the view-model types. Importable in tests without dragging in the atom/runtime (mirrors Wave's `vtab.tsx` vs `vtabbar.tsx` split). |
| `frontend/app/tab/sessionsidebar/sessionrow.test.tsx` | `renderToStaticMarkup` checks: dot color per status, active/blocked accent classes, pin icon, group caret + aggregate dot. |
| `frontend/app/tab/sessionsidebar/sessionsidebar.tsx` | Derived `sessionSidebarViewModelAtom` + `SessionSidebar` container; wires `setActiveTab`, pin toggle (`SetMetaCommand`), local collapse state. Verified by running the app (Task 8), like `VTabBar` (which has no unit test). |
| `frontend/app/workspace/workspace.tsx` | **Modify** line 10 (import) + line 135 (mount): swap `<VTabBar>` → `<SessionSidebar>`. |

**Verified API facts this plan relies on (source-inspected 2026-06-12):**
- `atoms` is exported from `@/app/store/global-atoms` (`global-atoms.ts:166`); `atoms.workspace` → `Workspace { tabids: string[]; activetabid: string; ... }`. There is **no** `pinnedtabids` field (merged into `tabids` by DB migration).
- `WOS.getWaveObjectAtom<T>(oref)` returns an atom whose value **is the object** (e.g. `get(tabAtom)?.blockids`), confirmed in `badge.ts`. `WOS.makeORef("tab", id)` / `("block", id)`. Import: `import * as WOS from "@/app/store/wos";`.
- `getTabBadgeAtom(tabId)` → `Atom<Badge[]>` (sorted, highest-priority first), from `@/app/store/badge`. `Badge = { badgeid; icon; color?; priority; pidlinked? }` (ambient global type). The reporter's badge appears here because `getTabBadgeAtom` aggregates the tab's block badges.
- A terminal block has `block.meta.view === "term"` and cwd at `block.meta["cmd:cwd"]` (key confirmed in `MetaType`). `Tab.blockids` lists all blocks; filter by `view === "term"`.
- `session:pinned` / `session:agent` are **not** in `MetaType` → read via `tab.meta as Record<string, any>` and write with a cast (spec §6 allows `meta as any` for v1).
- `setActiveTab(tabId)` is exported from `@/app/store/global` (`global.ts:664`).
- `RpcApi.SetMetaCommand(TabRpcClient, { oref, meta })` — `RpcApi` from `@/app/store/wshclientapi`, `TabRpcClient` from `@/app/store/wshrpcutil`, `fireAndForget` from `@/util/util`. Pattern verified in `workspace-layout-model.ts`.
- `makeIconClass(icon, fw, opts?)` from `@/util/util`; `"circle-small"` → `"fa fa-solid fa-circle-small fa-fw"`. Color applied as inline `style={{ color }}`.
- Tests: vitest. Single file: `npx vitest run <path>`. Components tested with `renderToStaticMarkup` from `react-dom/server` (no `@testing-library`). Typecheck: `npx tsc --noEmit`.

---

### Task 1: `cwdToServiceLabel` — derive a service label from a terminal cwd

**Files:**
- Create: `frontend/app/tab/sessionsidebar/sessionviewmodel.ts`
- Test: `frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { cwdToServiceLabel, NO_CWD_LABEL } from "./sessionviewmodel";

describe("cwdToServiceLabel", () => {
    it("uses the last path segment (POSIX)", () => {
        expect(cwdToServiceLabel("/home/user/src/CorrelationEngine")).toBe("CorrelationEngine");
    });
    it("uses the last path segment (Windows)", () => {
        expect(cwdToServiceLabel("C:\\Users\\k\\src\\KafkaToSolr")).toBe("KafkaToSolr");
    });
    it("ignores a trailing separator", () => {
        expect(cwdToServiceLabel("/a/b/")).toBe("b");
        expect(cwdToServiceLabel("C:\\a\\b\\")).toBe("b");
    });
    it("falls back when cwd is missing or empty", () => {
        expect(cwdToServiceLabel(undefined)).toBe(NO_CWD_LABEL);
        expect(cwdToServiceLabel("")).toBe(NO_CWD_LABEL);
    });
    it("falls back for a root path", () => {
        expect(cwdToServiceLabel("/")).toBe(NO_CWD_LABEL);
        expect(cwdToServiceLabel("\\")).toBe(NO_CWD_LABEL);
    });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts`
Expected: FAIL — cannot resolve `./sessionviewmodel` (module does not exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `frontend/app/tab/sessionsidebar/sessionviewmodel.ts`:

```ts
// Pure view-model logic for the session sidebar. No React, no Wave runtime imports.

export const NO_CWD_LABEL = "ungrouped";

/** Phase 1 grouping: the last path segment of the terminal cwd (Phase 2 replaces this with the marker walk-up RPC). */
export function cwdToServiceLabel(cwd?: string): string {
    if (!cwd) {
        return NO_CWD_LABEL;
    }
    const trimmed = cwd.replace(/[\\/]+$/, "");
    const segments = trimmed.split(/[\\/]+/);
    const last = segments[segments.length - 1];
    return last && last.length > 0 ? last : NO_CWD_LABEL;
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts`
Expected: PASS — 5 tests for `cwdToServiceLabel`.

- [ ] **Step 5: Checkpoint**

`sessionviewmodel.ts` exists with `cwdToServiceLabel` + `NO_CWD_LABEL`; its tests are green. No commit.

---

### Task 2: `badgeToStatus` — map the Phase 0 badge color to a status

**Files:**
- Modify: `frontend/app/tab/sessionsidebar/sessionviewmodel.ts`
- Test: `frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts`

- [ ] **Step 1: Write the failing test (append to `sessionviewmodel.test.ts`)**

Add this import line to the existing import from `./sessionviewmodel`, then add the block before the end of the file:

```ts
import { badgeToStatus } from "./sessionviewmodel";

describe("badgeToStatus", () => {
    it("maps the working color to working", () => {
        expect(badgeToStatus({ color: "#3fb950" })).toBe("working");
    });
    it("is case-insensitive on the hex", () => {
        expect(badgeToStatus({ color: "#3FB950" })).toBe("working");
    });
    it("maps the waiting color to waiting", () => {
        expect(badgeToStatus({ color: "#d29922" })).toBe("waiting");
    });
    it("maps anything else to idle", () => {
        expect(badgeToStatus({ color: "#999999" })).toBe("idle");
        expect(badgeToStatus({})).toBe("idle");
    });
    it("maps missing badge to idle", () => {
        expect(badgeToStatus(undefined)).toBe("idle");
        expect(badgeToStatus(null)).toBe("idle");
    });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts`
Expected: FAIL — `badgeToStatus` is not exported.

- [ ] **Step 3: Write the minimal implementation (append to `sessionviewmodel.ts`)**

Add near the top (after `NO_CWD_LABEL`):

```ts
export type SessionStatus = "working" | "waiting" | "idle";

// Couples to the Phase 0 reporter's color constants. Phase 2 replaces this with an explicit
// `state` field carried by the `wsh agentstatus` event.
export const COLOR_WORKING = "#3fb950";
export const COLOR_WAITING = "#d29922";

/** Map a tab's primary badge (set by the Phase 0 reporter) to a status. */
export function badgeToStatus(badge?: { color?: string } | null): SessionStatus {
    const color = badge?.color?.toLowerCase();
    if (color === COLOR_WORKING) {
        return "working";
    }
    if (color === COLOR_WAITING) {
        return "waiting";
    }
    return "idle";
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts`
Expected: PASS — `cwdToServiceLabel` + `badgeToStatus` groups green.

- [ ] **Step 5: Checkpoint**

`SessionStatus` type + `badgeToStatus` exist; tests green. No commit.

---

### Task 3: `aggregateStatus` — highest-priority status for a collapsed group

**Files:**
- Modify: `frontend/app/tab/sessionsidebar/sessionviewmodel.ts`
- Test: `frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts`

- [ ] **Step 1: Write the failing test (append)**

Add to the import from `./sessionviewmodel` and append:

```ts
import { aggregateStatus } from "./sessionviewmodel";

describe("aggregateStatus", () => {
    it("prioritizes waiting over everything", () => {
        expect(aggregateStatus(["idle", "working", "waiting"])).toBe("waiting");
    });
    it("prioritizes working over idle", () => {
        expect(aggregateStatus(["idle", "working", "idle"])).toBe("working");
    });
    it("returns idle when all idle", () => {
        expect(aggregateStatus(["idle", "idle"])).toBe("idle");
    });
    it("returns idle for an empty list", () => {
        expect(aggregateStatus([])).toBe("idle");
    });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts`
Expected: FAIL — `aggregateStatus` is not exported.

- [ ] **Step 3: Write the minimal implementation (append to `sessionviewmodel.ts`)**

```ts
/** Priority for a collapsed group's aggregate dot: waiting > working > idle. */
export function aggregateStatus(statuses: SessionStatus[]): SessionStatus {
    if (statuses.includes("waiting")) {
        return "waiting";
    }
    if (statuses.includes("working")) {
        return "working";
    }
    return "idle";
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

`aggregateStatus` exists; tests green. No commit.

---

### Task 4: `buildSessionViewModel` — assemble pinned + service groups

**Files:**
- Modify: `frontend/app/tab/sessionsidebar/sessionviewmodel.ts`
- Test: `frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts`

- [ ] **Step 1: Write the failing test (append)**

Add to the import from `./sessionviewmodel` (`buildSessionViewModel`, `SessionInput`) and append:

```ts
import { buildSessionViewModel, type SessionInput } from "./sessionviewmodel";

function input(overrides: Partial<SessionInput>): SessionInput {
    return {
        tabId: "t1",
        name: "tab",
        agent: "claude",
        pinned: false,
        cwd: "/src/CorrelationEngine",
        status: "idle",
        active: false,
        ...overrides,
    };
}

describe("buildSessionViewModel", () => {
    it("routes pinned sessions into the pinned group with service in the label", () => {
        const vm = buildSessionViewModel([
            input({ tabId: "t1", agent: "claude", cwd: "/src/CorrelationEngine", pinned: true }),
        ]);
        expect(vm.pinned).toHaveLength(1);
        expect(vm.pinned[0].label).toBe("claude · CorrelationEngine");
        expect(vm.groups).toHaveLength(0);
    });

    it("groups non-pinned sessions by service label", () => {
        const vm = buildSessionViewModel([
            input({ tabId: "t1", cwd: "/src/CorrelationEngine" }),
            input({ tabId: "t2", cwd: "/src/CorrelationEngine" }),
            input({ tabId: "t3", cwd: "/src/KafkaToSolr" }),
        ]);
        expect(vm.groups.map((g) => g.label)).toEqual(["CorrelationEngine", "KafkaToSolr"]);
        expect(vm.groups[0].sessions).toHaveLength(2);
        expect(vm.groups[1].sessions).toHaveLength(1);
    });

    it("preserves first-appearance order for groups", () => {
        const vm = buildSessionViewModel([
            input({ tabId: "t1", cwd: "/src/Zeta" }),
            input({ tabId: "t2", cwd: "/src/Alpha" }),
        ]);
        expect(vm.groups.map((g) => g.label)).toEqual(["Zeta", "Alpha"]);
    });

    it("computes a group's aggregate status", () => {
        const vm = buildSessionViewModel([
            input({ tabId: "t1", cwd: "/src/X", status: "idle" }),
            input({ tabId: "t2", cwd: "/src/X", status: "waiting" }),
        ]);
        expect(vm.groups[0].aggregateStatus).toBe("waiting");
    });

    it("labels grouped rows by agent, falling back to tab name", () => {
        const vm = buildSessionViewModel([
            input({ tabId: "t1", agent: "codex", name: "ignored", cwd: "/src/X" }),
            input({ tabId: "t2", agent: undefined, name: "my-tab", cwd: "/src/X" }),
        ]);
        expect(vm.groups[0].sessions[0].label).toBe("codex");
        expect(vm.groups[0].sessions[1].label).toBe("my-tab");
    });

    it("marks waiting rows as blocked and carries active/pinned flags", () => {
        const vm = buildSessionViewModel([
            input({ tabId: "t1", cwd: "/src/X", status: "waiting", active: true }),
        ]);
        const row = vm.groups[0].sessions[0];
        expect(row.blocked).toBe(true);
        expect(row.active).toBe(true);
    });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts`
Expected: FAIL — `buildSessionViewModel` / `SessionInput` not exported.

- [ ] **Step 3: Write the minimal implementation (append to `sessionviewmodel.ts`)**

```ts
/** Per-tab data collected by the container atom and fed to the builder. */
export interface SessionInput {
    tabId: string;
    name: string;
    agent?: string;
    pinned: boolean;
    cwd?: string;
    status: SessionStatus;
    active: boolean;
}

export interface SessionRowVM {
    tabId: string;
    label: string;
    status: SessionStatus;
    active: boolean;
    blocked: boolean;
    pinned: boolean;
}

export interface SessionGroupVM {
    label: string;
    sessions: SessionRowVM[];
    aggregateStatus: SessionStatus;
}

export interface SidebarViewModel {
    pinned: SessionRowVM[];
    groups: SessionGroupVM[];
}

function rowLabel(s: SessionInput, includeService: boolean): string {
    const agent = s.agent && s.agent.length > 0 ? s.agent : s.name;
    const base = agent && agent.length > 0 ? agent : "session";
    return includeService ? `${base} · ${cwdToServiceLabel(s.cwd)}` : base;
}

function toRow(s: SessionInput, includeService: boolean): SessionRowVM {
    return {
        tabId: s.tabId,
        label: rowLabel(s, includeService),
        status: s.status,
        active: s.active,
        blocked: s.status === "waiting",
        pinned: s.pinned,
    };
}

/** Pure: ordered session inputs -> pinned group + service groups (first-appearance order). */
export function buildSessionViewModel(sessions: SessionInput[]): SidebarViewModel {
    const pinned: SessionRowVM[] = [];
    const groupOrder: string[] = [];
    const groupMap = new Map<string, SessionInput[]>();

    for (const s of sessions) {
        if (s.pinned) {
            pinned.push(toRow(s, true));
            continue;
        }
        const label = cwdToServiceLabel(s.cwd);
        if (!groupMap.has(label)) {
            groupMap.set(label, []);
            groupOrder.push(label);
        }
        groupMap.get(label)!.push(s);
    }

    const groups: SessionGroupVM[] = groupOrder.map((label) => {
        const rows = groupMap.get(label)!.map((s) => toRow(s, false));
        return { label, sessions: rows, aggregateStatus: aggregateStatus(rows.map((r) => r.status)) };
    });

    return { pinned, groups };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts`
Expected: PASS — all four pure-function groups green.

- [ ] **Step 5: Checkpoint**

The full pure view-model module is complete and green. No commit.

---

### Task 5: `SessionRow` — presentational row (dot + label + accents + pin icon)

**Files:**
- Create: `frontend/app/tab/sessionsidebar/sessionrow.tsx`
- Test: `frontend/app/tab/sessionsidebar/sessionrow.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/app/tab/sessionsidebar/sessionrow.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionRow, STATUS_COLOR } from "./sessionrow";

function render(props: Partial<Parameters<typeof SessionRow>[0]> = {}): string {
    return renderToStaticMarkup(
        <SessionRow
            label="claude"
            status="working"
            active={false}
            blocked={false}
            pinned={false}
            onSelect={() => null}
            onTogglePin={() => null}
            {...props}
        />
    );
}

describe("SessionRow", () => {
    it("renders the label", () => {
        expect(render({ label: "claude · CorrelationEngine" })).toContain("claude · CorrelationEngine");
    });
    it("colors the dot by status", () => {
        expect(render({ status: "working" })).toContain(STATUS_COLOR.working);
        expect(render({ status: "waiting" })).toContain(STATUS_COLOR.waiting);
        expect(render({ status: "idle" })).toContain(STATUS_COLOR.idle);
    });
    it("applies the active accent class when active", () => {
        expect(render({ active: true })).toContain("session-row--active");
    });
    it("applies the blocked accent class when blocked", () => {
        expect(render({ blocked: true })).toContain("session-row--blocked");
    });
    it("renders a pin affordance", () => {
        expect(render()).toContain("fa-thumbtack");
    });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run frontend/app/tab/sessionsidebar/sessionrow.test.tsx`
Expected: FAIL — cannot resolve `./sessionrow`.

- [ ] **Step 3: Write the minimal implementation**

Create `frontend/app/tab/sessionsidebar/sessionrow.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn, makeIconClass } from "@/util/util";
import type { ReactNode } from "react";
import type { SessionStatus } from "./sessionviewmodel";

// Dot colors mirror the Phase 0 reporter (working/waiting) plus a neutral idle grey.
export const STATUS_COLOR: Record<SessionStatus, string> = {
    working: "#3fb950",
    waiting: "#d29922",
    idle: "#7d8590",
};

interface SessionRowProps {
    label: string;
    status: SessionStatus;
    active: boolean;
    blocked: boolean;
    pinned: boolean;
    onSelect: () => void;
    onTogglePin: () => void;
}

export function SessionRow({ label, status, active, blocked, pinned, onSelect, onTogglePin }: SessionRowProps) {
    return (
        <div
            className={cn(
                "session-row group flex h-8 w-full cursor-pointer items-center gap-2 border-l-2 border-transparent pl-2 pr-1.5",
                active && "session-row--active border-l-[#429dff] bg-[rgba(66,157,255,0.08)]",
                blocked && "session-row--blocked border-l-[#d29922] bg-[rgba(210,153,34,0.08)]"
            )}
            onClick={onSelect}
        >
            <i
                className={makeIconClass("circle-small", true) + " text-[10px]"}
                style={{ color: STATUS_COLOR[status] }}
            />
            <span className="flex-1 truncate text-[13px]" title={label}>
                {label}
            </span>
            <i
                className={cn(
                    makeIconClass("thumbtack", true) + " text-[10px]",
                    pinned ? "opacity-90" : "opacity-0 group-hover:opacity-60 hover:!opacity-100"
                )}
                onClick={(e) => {
                    e.stopPropagation();
                    onTogglePin();
                }}
            />
        </div>
    );
}

export type { ReactNode };
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run frontend/app/tab/sessionsidebar/sessionrow.test.tsx`
Expected: PASS — 5 tests.

- [ ] **Step 5: Checkpoint**

`SessionRow` renders dot/label/accents/pin and is green. No commit.

---

### Task 6: `SessionGroup` — presentational group header + body

**Files:**
- Modify: `frontend/app/tab/sessionsidebar/sessionrow.tsx`
- Test: `frontend/app/tab/sessionsidebar/sessionrow.test.tsx`

- [ ] **Step 1: Write the failing test (append to `sessionrow.test.tsx`)**

Add to the import from `./sessionrow` (`SessionGroup`) and append:

```tsx
import { SessionGroup } from "./sessionrow";

function renderGroup(props: Partial<Parameters<typeof SessionGroup>[0]> = {}): string {
    return renderToStaticMarkup(
        <SessionGroup
            label="CorrelationEngine"
            count={2}
            collapsed={false}
            aggregateStatus="idle"
            onToggle={() => null}
            {...props}
        >
            <div>child-row</div>
        </SessionGroup>
    );
}

describe("SessionGroup", () => {
    it("shows the label and count", () => {
        const html = renderGroup();
        expect(html).toContain("CorrelationEngine");
        expect(html).toContain("2");
    });
    it("renders children when expanded", () => {
        expect(renderGroup({ collapsed: false })).toContain("child-row");
    });
    it("hides children when collapsed", () => {
        expect(renderGroup({ collapsed: true })).not.toContain("child-row");
    });
    it("shows a chevron-down when expanded and chevron-right when collapsed", () => {
        expect(renderGroup({ collapsed: false })).toContain("fa-chevron-down");
        expect(renderGroup({ collapsed: true })).toContain("fa-chevron-right");
    });
    it("shows the aggregate dot color when collapsed", () => {
        expect(renderGroup({ collapsed: true, aggregateStatus: "waiting" })).toContain(STATUS_COLOR.waiting);
    });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run frontend/app/tab/sessionsidebar/sessionrow.test.tsx`
Expected: FAIL — `SessionGroup` is not exported.

- [ ] **Step 3: Write the minimal implementation (append to `sessionrow.tsx`)**

```tsx
interface SessionGroupProps {
    label: string;
    count: number;
    collapsed: boolean;
    aggregateStatus: SessionStatus;
    onToggle: () => void;
    children?: ReactNode;
}

export function SessionGroup({ label, count, collapsed, aggregateStatus, onToggle, children }: SessionGroupProps) {
    return (
        <div className="flex flex-col">
            <div
                className="flex h-7 w-full cursor-pointer items-center gap-1.5 px-2 text-[11px] uppercase tracking-wide text-secondary"
                onClick={onToggle}
            >
                <i className={makeIconClass(collapsed ? "chevron-right" : "chevron-down", true) + " text-[9px]"} />
                <span className="flex-1 truncate" title={label}>
                    {label}
                </span>
                {collapsed && (
                    <i
                        className={makeIconClass("circle-small", true) + " text-[10px]"}
                        style={{ color: STATUS_COLOR[aggregateStatus] }}
                    />
                )}
                <span className="ml-1 tabular-nums opacity-70">{count}</span>
            </div>
            {!collapsed && <div className="flex flex-col">{children}</div>}
        </div>
    );
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run frontend/app/tab/sessionsidebar/sessionrow.test.tsx`
Expected: PASS — `SessionRow` + `SessionGroup` groups green.

- [ ] **Step 5: Checkpoint**

Both presentational components are complete and green. No commit.

---

### Task 7: `SessionSidebar` container + view-model atom + mount swap

**Files:**
- Create: `frontend/app/tab/sessionsidebar/sessionsidebar.tsx`
- Modify: `frontend/app/workspace/workspace.tsx` (line 10 import, line 135 mount)

> No unit test for this task: the container is thin glue over the (already-tested) pure functions and presentational components, and mirrors `VTabBar`, which Wave verifies by running the app, not by unit test. Behavioral verification is Task 8.

- [ ] **Step 1: Create the container + atom**

Create `frontend/app/tab/sessionsidebar/sessionsidebar.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { getTabBadgeAtom } from "@/app/store/badge";
import { setActiveTab } from "@/app/store/global";
import { atoms } from "@/app/store/global-atoms";
import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom, useAtomValue } from "jotai";
import { useState } from "react";
import { SessionGroup, SessionRow } from "./sessionrow";
import {
    aggregateStatus,
    badgeToStatus,
    buildSessionViewModel,
    type SessionInput,
    type SidebarViewModel,
} from "./sessionviewmodel";

const PINNED_LABEL = "Pinned";

/** Derived: collect per-tab data reactively and build the grouped view model. */
export const sessionSidebarViewModelAtom = atom<SidebarViewModel>((get) => {
    const ws = get(atoms.workspace);
    const tabIds = ws?.tabids ?? [];
    const activeId = ws?.activetabid;

    const sessions: SessionInput[] = tabIds.map((tabId) => {
        const tab = get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", tabId)));
        const badges = get(getTabBadgeAtom(tabId));
        const status = badgeToStatus(badges?.[0]);

        let cwd: string | undefined;
        for (const blockId of tab?.blockids ?? []) {
            const block = get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)));
            if (block?.meta?.view === "term" && block.meta["cmd:cwd"]) {
                cwd = block.meta["cmd:cwd"];
                break;
            }
        }

        const meta = (tab?.meta ?? {}) as Record<string, any>;
        return {
            tabId,
            name: tab?.name ?? "",
            agent: meta["session:agent"],
            pinned: meta["session:pinned"] === true,
            cwd,
            status,
            active: tabId === activeId,
        };
    });

    return buildSessionViewModel(sessions);
});

function togglePin(tabId: string, pinned: boolean) {
    fireAndForget(() =>
        RpcApi.SetMetaCommand(TabRpcClient, {
            oref: WOS.makeORef("tab", tabId),
            // session:pinned is not yet in MetaType (spec §6: meta-as-any for v1).
            meta: { "session:pinned": !pinned } as any,
        })
    );
}

export function SessionSidebar({ workspace }: { workspace: Workspace }) {
    void workspace; // tab list is read reactively from the atom; prop kept to match the mount seam
    const vm = useAtomValue(sessionSidebarViewModelAtom);
    const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

    const toggle = (label: string) =>
        setCollapsed((prev) => {
            const next = new Set(prev);
            if (next.has(label)) {
                next.delete(label);
            } else {
                next.add(label);
            }
            return next;
        });

    return (
        <div
            className="flex h-full flex-col overflow-y-auto"
            style={{ backdropFilter: "blur(20px)", background: "rgba(0, 0, 0, 0.35)" }}
        >
            {vm.pinned.length > 0 && (
                <SessionGroup
                    label={PINNED_LABEL}
                    count={vm.pinned.length}
                    collapsed={collapsed.has(PINNED_LABEL)}
                    aggregateStatus={aggregateStatus(vm.pinned.map((r) => r.status))}
                    onToggle={() => toggle(PINNED_LABEL)}
                >
                    {vm.pinned.map((r) => (
                        <SessionRow
                            key={r.tabId}
                            label={r.label}
                            status={r.status}
                            active={r.active}
                            blocked={r.blocked}
                            pinned={r.pinned}
                            onSelect={() => setActiveTab(r.tabId)}
                            onTogglePin={() => togglePin(r.tabId, r.pinned)}
                        />
                    ))}
                </SessionGroup>
            )}

            {vm.groups.map((g) => (
                <SessionGroup
                    key={g.label}
                    label={g.label}
                    count={g.sessions.length}
                    collapsed={collapsed.has(g.label)}
                    aggregateStatus={g.aggregateStatus}
                    onToggle={() => toggle(g.label)}
                >
                    {g.sessions.map((r) => (
                        <SessionRow
                            key={r.tabId}
                            label={r.label}
                            status={r.status}
                            active={r.active}
                            blocked={r.blocked}
                            pinned={r.pinned}
                            onSelect={() => setActiveTab(r.tabId)}
                            onTogglePin={() => togglePin(r.tabId, r.pinned)}
                        />
                    ))}
                </SessionGroup>
            ))}
        </div>
    );
}
```

> Note: `Tab`, `Block`, `Workspace` are ambient global types (from `frontend/types/gotypes.d.ts`) — no import needed. If `npx tsc --noEmit` reports any of them as missing in this file's context, add `import type { Tab, Block, Workspace } from "@/app/store/wos";` is NOT correct — instead confirm the ambient global is in scope (it is for all `frontend/**` files via `tsconfig.json` `include`).

- [ ] **Step 2: Verify the new files typecheck**

Run: `npx tsc --noEmit`
Expected: PASS with no errors referencing `frontend/app/tab/sessionsidebar/*`. (Pre-existing unrelated errors, if any, are out of scope — confirm none are introduced by the new files.)

- [ ] **Step 3: Swap the mount in `workspace.tsx`**

In `frontend/app/workspace/workspace.tsx`, change the import on line 10:

```tsx
// BEFORE
import { VTabBar } from "@/app/tab/vtabbar";
// AFTER
import { SessionSidebar } from "@/app/tab/sessionsidebar/sessionsidebar";
```

And change the mount on line 135:

```tsx
// BEFORE
{showLeftTabBar && <VTabBar workspace={ws} />}
// AFTER
{showLeftTabBar && <SessionSidebar workspace={ws} />}
```

(If `VTabBar` is referenced nowhere else in `workspace.tsx` after this change, removing its import as above is correct and avoids an unused-import lint error. Confirm with a search before saving.)

- [ ] **Step 4: Verify typecheck after the swap**

Run: `npx tsc --noEmit`
Expected: PASS — no new errors; no "VTabBar is declared but never used" in `workspace.tsx`.

- [ ] **Step 5: Checkpoint**

Container + atom created; mount swapped; typecheck clean. No commit.

---

### Task 8: Full-suite verification + live manual check

**Files:** none (verification only)

- [ ] **Step 1: Run the full frontend test suite**

Run: `npx vitest run frontend/app/tab/sessionsidebar`
Expected: PASS — all `sessionviewmodel` + `sessionrow` tests green.

- [ ] **Step 2: Typecheck the whole frontend**

Run: `npx tsc --noEmit` (or `task check:ts`)
Expected: no new errors introduced by Phase 1 files.

- [ ] **Step 3: Lint the new files**

Run: `npx eslint frontend/app/tab/sessionsidebar/**/*.{ts,tsx} frontend/app/workspace/workspace.tsx`
Expected: clean (no unused imports, no errors).

- [ ] **Step 4: Live manual verification**

1. Ensure the setting `app:tabbar` is `"left"` (Settings, or `wsh setconfig app:tabbar=left`, or edit the config). Without this the sidebar is not mounted.
2. Build + run the full app: `task dev` (this builds the Go backend then runs `electron-vite dev`). The frontend-only `task preview` will not show real workspace/tab data.
3. Open several terminal tabs, each `cd`'d into a different service dir (e.g. two under `.../src/CorrelationEngine`, one under `.../src/KafkaToSolr`).
4. Confirm: tabs group under their cwd's last path segment; the active tab shows the blue accent; collapsing a group hides its rows and shows the aggregate dot; the count is correct.
5. Start a Phase-0-hooked agent (`claude` or `codex`) in a tab and confirm the row's dot goes **green** while it works, **amber** on an approval prompt, and back to **grey** when the turn ends.
6. Hover a row and click the pin icon; confirm the session jumps to the **Pinned** group (label shows `agent · service`), and the change survives a tab switch (meta is durable).

- [ ] **Step 5: Record observations**

Note any gaps for Phase 2/3: missing detail line (expected — Phase 2), grouping by basename vs marker (expected — Phase 2), collapse not persisted across restart (expected — Phase 3).

- [ ] **Step 6: Checkpoint**

All automated checks green; live green→amber→grey + grouping + pin observed. No commit (await explicit approval to commit the Phase 1 diff).

---

## Self-Review

**1. Spec coverage (against §6 sidebar UI + §9 Phase 1 scope):**
- Pinned group + service groups, collapsible, with count → Tasks 4, 6, 7. ✅
- Informative row: status dot + primary line (agent / agent·service) → Tasks 4, 5. ✅
- Status dots reusing the badge mechanism → `getTabBadgeAtom` in Task 7 atom + `badgeToStatus` Task 2. ✅
- Grouping by `cmd:cwd` directly → `cwdToServiceLabel` Task 1 + atom cwd lookup Task 7. ✅
- Active (blue) + blocked (amber) accents → Task 5. ✅
- Collapse + aggregate dot (amber>green>grey) → `aggregateStatus` Task 3 + Task 6. ✅
- Pinned via `session:pinned` meta (hover pin icon) → Tasks 5, 7. ✅
- Mount swap at `workspace.tsx:135` → Task 7. ✅
- Detail line, marker-walk-up grouping, persisted collapse, typed meta → correctly **deferred** (Phase 2/3), stated in header.
- Testing = pure functions + render-level checks (spec §11) → Tasks 1–6; container verified live (Task 8), matching Wave's `VTabBar` (no unit test). ✅

**2. Placeholder scan:** No "TBD"/"handle errors later"/"similar to". Every code step shows complete code. The one judgement call (ambient global types in Task 7) is written as a concrete check, not a placeholder.

**3. Type consistency:** `SessionStatus` (Task 2) is consumed by `aggregateStatus` (3), `SessionInput`/`SessionRowVM` (4), `STATUS_COLOR`/`SessionRow` (5), `SessionGroup` (6), and the atom (7). `buildSessionViewModel(SessionInput[]) → SidebarViewModel` (4) is consumed verbatim by the atom (7). `badgeToStatus({color?})` (2) is fed `getTabBadgeAtom`'s `Badge[]` first element (7) — `Badge` has `color?: string`, structurally compatible. `STATUS_COLOR` keys exactly match the `SessionStatus` union. Consistent across all tasks.
