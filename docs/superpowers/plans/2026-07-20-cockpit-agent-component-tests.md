# Cockpit Agent Component Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a regression net for `radarsurface.tsx`, `cockpitsurface.tsx`, `agentrow.tsx`, and `cockpitrail.tsx` before their next edit, by extracting each component's untested inline glue into pure functions and unit-testing them.

**Architecture:** These four components are presentational — nearly all their logic already lives in tested companion modules (`agentsviewmodel`, `radarmodel`, `jarvisderive`, `ratelimitstore`, `radarstore`). The only untested surface is thin inline glue (predicates, fallbacks, clamps, conditional assembly). We extract that glue into pure `.ts` functions (single source of truth), repoint the component to call them (behavior-preserving), and pin them with `*.test.ts` files. This matches the repo's established "logic-extraction, no render harness" convention (CLAUDE.md: "There is no jsdom/render-test harness for the cockpit").

**Tech Stack:** TypeScript, React 19, vitest (node env — no jsdom/RTL), jotai. Tests are pure-function unit tests in the `jarvisderive.test.ts` style: import an exported function, assert its return against hand-built fixtures.

## Global Constraints

- **No render harness.** Do NOT add jsdom, happy-dom, or `@testing-library/react`. Do NOT set `environment: jsdom`. Tests import pure functions only. (CLAUDE.md, verbatim: "There is no jsdom/render-test harness for the cockpit — verify rendered UI by screenshotting the live dev app over CDP.")
- **Behavior-preserving extraction.** Each extracted function must reproduce the current inline expression EXACTLY. Do not "improve," reorder, or change semantics. The repoint is a pure refactor.
- **No new dependencies.** Standard library + existing imports only.
- **Test files are `.test.ts`** (never `.tsx`), co-located in `frontend/app/view/agents/`.
- **Model modules are pure `.ts`** — no JSX, no React imports, no DOM.
- **Comments:** lower case, only for "why," only when necessary (user global rule).
- **Typecheck:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (bare `npx tsc` stack-overflows). Baseline is clean — any error it reports is yours.
- **Run tests (from the worktree, which has no local node_modules):**
  `node C:/Users/kael02/IdeaProjects/waveterm/node_modules/vitest/vitest.mjs run frontend/app/view/agents/<file>.test.ts --reporter=basic`
  with the working directory set to the worktree root.

---

## File Structure

- `radarsurface.tsx` glue → extend existing `radarmodel.ts`; tests appended to existing `radarmodel.test.ts`.
- `cockpitrail.tsx` glue → new `cockpitrailmodel.ts` + new `cockpitrailmodel.test.ts`.
- `cockpitsurface.tsx` glue → new `cockpitsurfacemodel.ts` + new `cockpitsurfacemodel.test.ts`.
- `agentrow.tsx` glue → new `agentrowmodel.ts` + new `agentrowmodel.test.ts`.

The four tasks touch disjoint file sets and are fully parallelizable.

---

### Task 1: Radar surface glue → radarmodel.ts

**Files:**
- Modify: `frontend/app/view/agents/radarmodel.ts` (add 4 exports)
- Modify: `frontend/app/view/agents/radarsurface.tsx` (repoint 4 call sites)
- Test: `frontend/app/view/agents/radarmodel.test.ts` (append one describe block)

**Interfaces — Produces:**
- `projectsWithPath<T extends { path?: string }>(projects: Record<string, T> | null | undefined): [string, T][]`
- `isResultsState(state: RadarScanState): boolean`
- `rescanLabel(state: RadarScanState): string`
- `scanScopeLabel(scope: { name: string } | null): string`

`RadarScanState` is already exported from `radarmodel.ts`.

- [ ] **Step 1: Write failing tests.** Append to `radarmodel.test.ts`:

```ts
import {
    // ...existing imports plus:
    isResultsState,
    projectsWithPath,
    rescanLabel,
    scanScopeLabel,
} from "./radarmodel";

describe("radar surface glue", () => {
    it("projectsWithPath keeps only registered projects that have a path", () => {
        const projects = { a: { path: "/a" }, b: { path: "" }, c: {}, d: { path: "/d" } };
        expect(projectsWithPath(projects)).toEqual([
            ["a", { path: "/a" }],
            ["d", { path: "/d" }],
        ]);
    });
    it("projectsWithPath returns [] for null/undefined", () => {
        expect(projectsWithPath(null)).toEqual([]);
        expect(projectsWithPath(undefined)).toEqual([]);
    });
    it("isResultsState is true only for results and partial", () => {
        expect(isResultsState("results")).toBe(true);
        expect(isResultsState("partial")).toBe(true);
        expect(isResultsState("no-findings")).toBe(false);
        expect(isResultsState("never-scanned")).toBe(false);
        expect(isResultsState("failed")).toBe(false);
    });
    it("rescanLabel says re-run full scan only for a partial scan", () => {
        expect(rescanLabel("partial")).toBe("Re-run full scan");
        expect(rescanLabel("results")).toBe("Re-scan");
    });
    it("scanScopeLabel names the scoped project or prompts to select one", () => {
        expect(scanScopeLabel({ name: "payments-api" })).toBe("Scanning payments-api");
        expect(scanScopeLabel(null)).toBe("Select a registered project to scan");
    });
});
```

Confirm the `RadarScanState` union values used above (`"no-findings"`, `"never-scanned"`, `"failed"`) against the `RadarScanState` type in `radarmodel.ts:136`; use the actual member names if they differ.

- [ ] **Step 2: Run — expect FAIL** (functions not exported).

- [ ] **Step 3: Implement in `radarmodel.ts`** (add near the other presentation helpers):

```ts
// scan-scope selector entries: registered projects that actually have a path (radar surface).
export function projectsWithPath<T extends { path?: string }>(
    projects: Record<string, T> | null | undefined
): [string, T][] {
    return Object.entries(projects ?? {}).filter(([, v]) => v?.path) as [string, T][];
}

export function isResultsState(state: RadarScanState): boolean {
    return state === "results" || state === "partial";
}

export function rescanLabel(state: RadarScanState): string {
    return state === "partial" ? "Re-run full scan" : "Re-scan";
}

export function scanScopeLabel(scope: { name: string } | null): string {
    return scope ? `Scanning ${scope.name}` : "Select a registered project to scan";
}
```

- [ ] **Step 4: Repoint `radarsurface.tsx`.**
  - Add to the `./radarmodel` import: `isResultsState, projectsWithPath, rescanLabel, scanScopeLabel`.
  - `ScopeSelector`: replace `const entries = Object.entries(projects ?? {}).filter(([, v]) => v?.path);` with `const entries = projectsWithPath(projects);`
  - Body: replace `const isResults = state === "results" || state === "partial";` with `const isResults = isResultsState(state);`
  - Subtitle: replace `{scope ? \`Scanning ${scope.name}\` : "Select a registered project to scan"}` with `{scanScopeLabel(scope)}`
  - Re-scan button: replace `{state === "partial" ? "Re-run full scan" : "Re-scan"}` with `{rescanLabel(state)}`

- [ ] **Step 5: Run tests — expect PASS.** Then typecheck.

- [ ] **Step 6: Commit** (staged by the orchestrator at the end).

---

### Task 2: Cockpit rail glue → cockpitrailmodel.ts

**Files:**
- Create: `frontend/app/view/agents/cockpitrailmodel.ts`
- Modify: `frontend/app/view/agents/cockpitrail.tsx`
- Test: `frontend/app/view/agents/cockpitrailmodel.test.ts`

**Interfaces — Produces:**
- `providerLabel(provider: string): string`
- `providerDot(provider: string): string`
- `windowUsedTokens(provider: string, windowTokens: WindowTokens | null, window: "fivehour" | "week"): number | undefined`
- `usageBarVisible(pct: number | undefined): boolean`
- `usageBarShowsMeta(used: number | undefined, reset: number | undefined): boolean`

`WindowTokens` type is imported from `./windowtokenstore`.

- [ ] **Step 1: Write failing test** `cockpitrailmodel.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    providerDot,
    providerLabel,
    usageBarShowsMeta,
    usageBarVisible,
    windowUsedTokens,
} from "./cockpitrailmodel";
import type { WindowTokens } from "./windowtokenstore";

describe("providerLabel", () => {
    it("maps known providers to display names", () => {
        expect(providerLabel("claude")).toBe("Claude");
        expect(providerLabel("codex")).toBe("Codex");
    });
    it("falls back to the raw provider id when unknown", () => {
        expect(providerLabel("gemini")).toBe("gemini");
    });
});

describe("providerDot", () => {
    it("maps known providers to their brand dot class", () => {
        expect(providerDot("claude")).toBe("bg-provider-claude");
        expect(providerDot("codex")).toBe("bg-provider-codex");
    });
    it("falls back to bg-muted when unknown", () => {
        expect(providerDot("gemini")).toBe("bg-muted");
    });
});

describe("windowUsedTokens", () => {
    const wt: WindowTokens = { fivehour: 1200, week: 34000 };
    it("returns the window's claude token sum for the claude provider", () => {
        expect(windowUsedTokens("claude", wt, "fivehour")).toBe(1200);
        expect(windowUsedTokens("claude", wt, "week")).toBe(34000);
    });
    it("is undefined for non-claude providers (token sums are claude-only)", () => {
        expect(windowUsedTokens("codex", wt, "fivehour")).toBeUndefined();
    });
    it("is undefined when windowTokens is null", () => {
        expect(windowUsedTokens("claude", null, "fivehour")).toBeUndefined();
    });
});

describe("usageBarVisible", () => {
    it("is false when pct is null/undefined (api-key auth or unreported)", () => {
        expect(usageBarVisible(undefined)).toBe(false);
        expect(usageBarVisible(null as unknown as undefined)).toBe(false);
    });
    it("is true for any numeric pct including 0", () => {
        expect(usageBarVisible(0)).toBe(true);
        expect(usageBarVisible(73)).toBe(true);
    });
});

describe("usageBarShowsMeta", () => {
    it("shows the meta line when there are used tokens or a reset", () => {
        expect(usageBarShowsMeta(1200, undefined)).toBe(true);
        expect(usageBarShowsMeta(undefined, 1699999999)).toBe(true);
        expect(usageBarShowsMeta(0, undefined)).toBe(true);
    });
    it("hides the meta line when there are neither", () => {
        expect(usageBarShowsMeta(undefined, undefined)).toBe(false);
        expect(usageBarShowsMeta(undefined, 0)).toBe(false);
    });
});
```

Confirm the `WindowTokens` shape (`fivehour`/`week`) against `windowtokenstore.ts`; adjust the fixture if the field names differ.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `cockpitrailmodel.ts`:**

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure glue for the cockpit right rail (CockpitRail / UsageBar). Extracted so the rail's
// provider gating + usage-bar visibility are unit-testable without rendering.

import type { WindowTokens } from "./windowtokenstore";

// provider identity for the plan strip. not theme tokens — brand colors, single source.
const PROVIDER_DOT: Record<string, string> = { claude: "bg-provider-claude", codex: "bg-provider-codex" };
const PROVIDER_LABEL: Record<string, string> = { claude: "Claude", codex: "Codex" };

export function providerLabel(provider: string): string {
    return PROVIDER_LABEL[provider] ?? provider;
}

export function providerDot(provider: string): string {
    return PROVIDER_DOT[provider] ?? "bg-muted";
}

// real used-token sum is claude-only (windowtokenstore); other providers report no token line.
export function windowUsedTokens(
    provider: string,
    windowTokens: WindowTokens | null,
    window: "fivehour" | "week"
): number | undefined {
    return provider === "claude" ? windowTokens?.[window] : undefined;
}

// a null pct (api-key auth or a window not yet reported) renders no bar.
export function usageBarVisible(pct: number | undefined): boolean {
    return pct != null;
}

export function usageBarShowsMeta(used: number | undefined, reset: number | undefined): boolean {
    return used != null || !!reset;
}
```

- [ ] **Step 4: Repoint `cockpitrail.tsx`.**
  - Remove the local `PROVIDER_DOT` / `PROVIDER_LABEL` consts (now sourced from the model).
  - Import: `import { providerDot, providerLabel, usageBarShowsMeta, usageBarVisible, windowUsedTokens } from "./cockpitrailmodel";`
  - `UsageBar`: replace `if (pct == null) { return null; }` with `if (!usageBarVisible(pct)) { return null; }`
  - `UsageBar` meta line: replace `{used != null || reset ? (` with `{usageBarShowsMeta(used, reset) ? (`
  - `UsageBar` used token cell: keep `{used != null ? \`${formatTokens(used)} tok\` : ""}` as-is (still uses `formatTokens`).
  - `CockpitRail` provider dot: replace `PROVIDER_DOT[d.provider] ?? "bg-muted"` with `providerDot(d.provider)`
  - `CockpitRail` provider label: replace `{PROVIDER_LABEL[d.provider] ?? d.provider}` with `{providerLabel(d.provider)}`
  - `CockpitRail` 5-hour `used`: replace `used={d.provider === "claude" ? windowTokens?.fivehour : undefined}` with `used={windowUsedTokens(d.provider, windowTokens, "fivehour")}`
  - `CockpitRail` weekly `used`: replace `used={d.provider === "claude" ? windowTokens?.week : undefined}` with `used={windowUsedTokens(d.provider, windowTokens, "week")}`
  - Leave `PLAN_BAR` / `PLAN_TXT` (usage-level class maps) in the component untouched.

- [ ] **Step 5: Run tests — expect PASS.** Then typecheck.

- [ ] **Step 6: Commit** (staged by the orchestrator at the end).

---

### Task 3: Cockpit surface glue → cockpitsurfacemodel.ts

**Files:**
- Create: `frontend/app/view/agents/cockpitsurfacemodel.ts`
- Modify: `frontend/app/view/agents/cockpitsurface.tsx`
- Test: `frontend/app/view/agents/cockpitsurfacemodel.test.ts`

**Interfaces — Produces:**
- `dismissKey(agent: Pick<AgentVM, "id" | "idleSince">): string`
- `isCockpitEmpty(asking: AgentVM[], working: AgentVM[], idle: AgentVM[]): boolean`
- `shownForChip(agents: AgentVM[], chip: ChipFilter): AgentVM[]`
- `splitRecentlyIdle(idle: AgentVM[], now: number, dismissed: Set<string>): { recently: AgentVM[]; parked: AgentVM[] }`
- `toggleInSet(set: Set<string>, id: string): Set<string>`

**Interfaces — Consumes:** `isRecentlyIdle` from `./agentsviewmodel`; `AgentVM` type from `./agentsviewmodel`; `ChipFilter` type from `./agents` (type-only import to avoid a runtime cycle).

- [ ] **Step 1: Write failing test** `cockpitsurfacemodel.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentVM } from "./agentsviewmodel";
import {
    dismissKey,
    isCockpitEmpty,
    shownForChip,
    splitRecentlyIdle,
    toggleInSet,
} from "./cockpitsurfacemodel";

function agent(over: Partial<AgentVM>): AgentVM {
    return { id: "t1", name: "claude", task: "", state: "working", ...over };
}

describe("dismissKey", () => {
    it("keys a dismissal by id and idle episode", () => {
        expect(dismissKey({ id: "t1", idleSince: 500 })).toBe("t1:500");
    });
    it("uses an empty episode suffix when idleSince is absent", () => {
        expect(dismissKey({ id: "t1", idleSince: undefined })).toBe("t1:");
    });
});

describe("isCockpitEmpty", () => {
    it("is true only when every section is empty", () => {
        expect(isCockpitEmpty([], [], [])).toBe(true);
        expect(isCockpitEmpty([agent({})], [], [])).toBe(false);
        expect(isCockpitEmpty([], [agent({})], [])).toBe(false);
        expect(isCockpitEmpty([], [], [agent({})])).toBe(false);
    });
});

describe("shownForChip", () => {
    const all = [
        agent({ id: "a", state: "asking" }),
        agent({ id: "w", state: "working" }),
        agent({ id: "i", state: "idle" }),
    ];
    it("returns everything for the all chip", () => {
        expect(shownForChip(all, "all").map((a) => a.id)).toEqual(["a", "w", "i"]);
    });
    it("filters to the matching state for a status chip", () => {
        expect(shownForChip(all, "working").map((a) => a.id)).toEqual(["w"]);
        expect(shownForChip(all, "asking").map((a) => a.id)).toEqual(["a"]);
    });
});

describe("splitRecentlyIdle", () => {
    const now = 100_000;
    it("routes within-grace, non-dismissed idle agents to recently and the rest to parked", () => {
        // isRecentlyIdle uses agentsviewmodel's IDLE_GRACE_MS; fresh idleSince = recent, old = parked.
        const fresh = agent({ id: "fresh", state: "idle", idleSince: now - 1000 });
        const old = agent({ id: "old", state: "idle", idleSince: now - 10 * 60_000 });
        const { recently, parked } = splitRecentlyIdle([fresh, old], now, new Set());
        expect(recently.map((a) => a.id)).toEqual(["fresh"]);
        expect(parked.map((a) => a.id)).toEqual(["old"]);
    });
    it("moves a dismissed-but-recent agent to parked (dismissal wins)", () => {
        const fresh = agent({ id: "fresh", state: "idle", idleSince: now - 1000 });
        const dismissed = new Set([dismissKey(fresh)]);
        const { recently, parked } = splitRecentlyIdle([fresh], now, dismissed);
        expect(recently).toEqual([]);
        expect(parked.map((a) => a.id)).toEqual(["fresh"]);
    });
});

describe("toggleInSet", () => {
    it("adds an absent id", () => {
        expect([...toggleInSet(new Set(["a"]), "b")].sort()).toEqual(["a", "b"]);
    });
    it("removes a present id", () => {
        expect([...toggleInSet(new Set(["a", "b"]), "a")]).toEqual(["b"]);
    });
    it("does not mutate the input set", () => {
        const input = new Set(["a"]);
        toggleInSet(input, "b");
        expect([...input]).toEqual(["a"]);
    });
});
```

Confirm `IDLE_GRACE_MS` (used by `isRecentlyIdle`, `agentsviewmodel.ts`) is on the order of minutes so the `fresh`/`old` fixtures land on the correct side; check the constant and adjust the offsets if needed. Confirm `AgentVM` has the fields used (`id`, `name`, `task`, `state`, `idleSince`).

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `cockpitsurfacemodel.ts`:**

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure glue for CockpitSurface: dismissal keying, empty-state + chip filtering, the recently-idle
// grace-window split, and a generic set toggle. Extracted so the surface's orchestration decisions
// are unit-testable without rendering the grid.

import type { ChipFilter } from "./agents";
import { isRecentlyIdle, type AgentVM } from "./agentsviewmodel";

// a just-finished agent's dismissal is keyed by idle episode (id:idleSince) so a later re-idle re-shows it.
export function dismissKey(agent: Pick<AgentVM, "id" | "idleSince">): string {
    return `${agent.id}:${agent.idleSince ?? ""}`;
}

export function isCockpitEmpty(asking: AgentVM[], working: AgentVM[], idle: AgentVM[]): boolean {
    return asking.length === 0 && working.length === 0 && idle.length === 0;
}

// the status chip narrows what the grid renders; "all" shows everything.
export function shownForChip(agents: AgentVM[], chip: ChipFilter): AgentVM[] {
    return chip === "all" ? agents : agents.filter((a) => a.state === chip);
}

// within-grace idle agents keep their full row (recently); dismissed or aged-out ones park in the idle list.
export function splitRecentlyIdle(
    idle: AgentVM[],
    now: number,
    dismissed: Set<string>
): { recently: AgentVM[]; parked: AgentVM[] } {
    const recently = idle.filter((a) => isRecentlyIdle(a, now) && !dismissed.has(dismissKey(a)));
    const recentIds = new Set(recently.map((a) => a.id));
    const parked = idle.filter((a) => !recentIds.has(a.id));
    return { recently, parked };
}

export function toggleInSet(set: Set<string>, id: string): Set<string> {
    const next = new Set(set);
    if (next.has(id)) {
        next.delete(id);
    } else {
        next.add(id);
    }
    return next;
}
```

- [ ] **Step 4: Repoint `cockpitsurface.tsx`.**
  - Import: `import { dismissKey, isCockpitEmpty, shownForChip, splitRecentlyIdle, toggleInSet } from "./cockpitsurfacemodel";`
  - Delete the local `const dismissKey = (a: AgentVM) => \`${a.id}:${a.idleSince ?? ""}\`;` (now imported). Call sites `dismissKey(a)` are unchanged.
  - Replace the `recentlyIdle` / `recentIds` / `parkedIdle` block:
    ```ts
    const recentlyIdle = idle.filter((a) => isRecentlyIdle(a, structuralNow) && !dismissed.has(dismissKey(a)));
    const recentIds = new Set(recentlyIdle.map((a) => a.id));
    const parkedIdle = idle.filter((a) => !recentIds.has(a.id));
    ```
    with:
    ```ts
    const { recently: recentlyIdle, parked: parkedIdle } = splitRecentlyIdle(idle, structuralNow, dismissed);
    ```
    (Keep `recentlyIdle` — it's reused by `partitionBackgrounded`, `useCardStreams`, and `recentIds` was only used to derive `parkedIdle`.)
  - Replace `const empty = asking.length === 0 && working.length === 0 && idle.length === 0;` with `const empty = isCockpitEmpty(asking, working, idle);`
  - Replace `const shownAgents = chip === "all" ? visibleOrdered : visibleOrdered.filter((a) => a.state === chip);` with `const shownAgents = shownForChip(visibleOrdered, chip);`
  - In `toggleBackground`, replace the inline updater body with `toggleInSet`:
    ```ts
    const toggleBackground = (id: string) => {
        setBackgroundedIds((prev) => toggleInSet(prev, id));
    };
    ```
  - If `isRecentlyIdle` becomes unused in `cockpitsurface.tsx` after this, remove it from the `./agentsviewmodel` import; if still used elsewhere, leave it. (Verify by search.)

- [ ] **Step 5: Run tests — expect PASS.** Then typecheck.

- [ ] **Step 6: Commit** (staged by the orchestrator at the end).

---

### Task 4: Agent row glue → agentrowmodel.ts

**Files:**
- Create: `frontend/app/view/agents/agentrowmodel.ts`
- Modify: `frontend/app/view/agents/agentrow.tsx`
- Test: `frontend/app/view/agents/agentrowmodel.test.ts`

**Interfaces — Produces:**
- `entriesToShow<T>(liveEntries: T[], previousInfo: T[] | undefined): T[]`
- `clampQuestionIndex(activeQuestion: number | undefined, questionCount: number): number`
- `muteMode(state: AgentState): "dismiss" | "background"`
- `isFinishTransition(prev: AgentState, next: AgentState): boolean`
- `type AgentRowMenuItem = { key: "open" | "terminal" | "diff" | "fullwidth" | "mute" | "copy" | "close"; label: string; danger?: boolean } | { separator: true }`
- `agentRowMenuItems(flags: { hasDiff: boolean; canToggleFullWidth: boolean; fullWidth: boolean; hasMute: boolean }): AgentRowMenuItem[]`

**Interfaces — Consumes:** `AgentState` type from `./agentsviewmodel`.

- [ ] **Step 1: Write failing test** `agentrowmodel.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    agentRowMenuItems,
    clampQuestionIndex,
    entriesToShow,
    isFinishTransition,
    muteMode,
} from "./agentrowmodel";

describe("entriesToShow", () => {
    it("prefers live entries when present", () => {
        expect(entriesToShow([1, 2], [9])).toEqual([1, 2]);
    });
    it("falls back to previousInfo when live is empty", () => {
        expect(entriesToShow([], [9])).toEqual([9]);
    });
    it("falls back to [] when live is empty and previousInfo is absent", () => {
        expect(entriesToShow([], undefined)).toEqual([]);
    });
});

describe("clampQuestionIndex", () => {
    it("defaults an absent index to 0", () => {
        expect(clampQuestionIndex(undefined, 3)).toBe(0);
    });
    it("clamps to the last question", () => {
        expect(clampQuestionIndex(5, 3)).toBe(2);
    });
    it("stays at 0 when there are no questions", () => {
        expect(clampQuestionIndex(2, 0)).toBe(0);
    });
    it("keeps an in-range index", () => {
        expect(clampQuestionIndex(1, 3)).toBe(1);
    });
});

describe("muteMode", () => {
    it("dismisses an idle agent and backgrounds an active one", () => {
        expect(muteMode("idle")).toBe("dismiss");
        expect(muteMode("working")).toBe("background");
        expect(muteMode("asking")).toBe("background");
    });
});

describe("isFinishTransition", () => {
    it("is true only on working -> idle", () => {
        expect(isFinishTransition("working", "idle")).toBe(true);
        expect(isFinishTransition("asking", "idle")).toBe(false);
        expect(isFinishTransition("working", "asking")).toBe(false);
        expect(isFinishTransition("idle", "idle")).toBe(false);
    });
});

describe("agentRowMenuItems", () => {
    it("always includes open, terminal, copy, a separator, and a danger close", () => {
        const items = agentRowMenuItems({ hasDiff: false, canToggleFullWidth: false, fullWidth: false, hasMute: false });
        expect(items).toEqual([
            { key: "open", label: "Open" },
            { key: "terminal", label: "Open terminal" },
            { key: "copy", label: "Copy name" },
            { separator: true },
            { key: "close", label: "Close agent", danger: true },
        ]);
    });
    it("adds Review changes when there is a diff", () => {
        const items = agentRowMenuItems({ hasDiff: true, canToggleFullWidth: false, fullWidth: false, hasMute: false });
        expect(items.some((i) => "key" in i && i.key === "diff" && i.label === "Review changes")).toBe(true);
    });
    it("labels the full-width toggle by current state", () => {
        const collapsed = agentRowMenuItems({ hasDiff: false, canToggleFullWidth: true, fullWidth: false, hasMute: false });
        const expanded = agentRowMenuItems({ hasDiff: false, canToggleFullWidth: true, fullWidth: true, hasMute: false });
        expect(collapsed.find((i) => "key" in i && i.key === "fullwidth")).toEqual({ key: "fullwidth", label: "Full width" });
        expect(expanded.find((i) => "key" in i && i.key === "fullwidth")).toEqual({ key: "fullwidth", label: "Exit full width" });
    });
    it("adds Move to background when a mute action exists", () => {
        const items = agentRowMenuItems({ hasDiff: false, canToggleFullWidth: false, fullWidth: false, hasMute: true });
        expect(items.some((i) => "key" in i && i.key === "mute" && i.label === "Move to background")).toBe(true);
    });
    it("orders optional items diff -> fullwidth -> mute between terminal and copy", () => {
        const items = agentRowMenuItems({ hasDiff: true, canToggleFullWidth: true, fullWidth: false, hasMute: true });
        const keys = items.map((i) => ("key" in i ? i.key : "sep"));
        expect(keys).toEqual(["open", "terminal", "diff", "fullwidth", "mute", "copy", "sep", "close"]);
    });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `agentrowmodel.ts`:**

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure glue for AgentRow: transcript-entry fallback, question-index clamp, mute-action mode,
// the finish (working -> idle) settle trigger, and the context-menu item assembly. Extracted so
// the card's branching is unit-testable without rendering. The component maps each menu item's
// `key` to its icon + click handler; this module owns which items appear, their labels, and order.

import type { AgentState } from "./agentsviewmodel";

export function entriesToShow<T>(liveEntries: T[], previousInfo: T[] | undefined): T[] {
    return liveEntries.length > 0 ? liveEntries : (previousInfo ?? []);
}

export function clampQuestionIndex(activeQuestion: number | undefined, questionCount: number): number {
    return Math.min(activeQuestion ?? 0, Math.max(0, questionCount - 1));
}

export function muteMode(state: AgentState): "dismiss" | "background" {
    return state === "idle" ? "dismiss" : "background";
}

// one-shot settle animation fires when an agent finishes (working -> idle).
export function isFinishTransition(prev: AgentState, next: AgentState): boolean {
    return prev === "working" && next === "idle";
}

export type AgentRowMenuItem =
    | { key: "open" | "terminal" | "diff" | "fullwidth" | "mute" | "copy" | "close"; label: string; danger?: boolean }
    | { separator: true };

export function agentRowMenuItems(flags: {
    hasDiff: boolean;
    canToggleFullWidth: boolean;
    fullWidth: boolean;
    hasMute: boolean;
}): AgentRowMenuItem[] {
    const items: AgentRowMenuItem[] = [
        { key: "open", label: "Open" },
        { key: "terminal", label: "Open terminal" },
    ];
    if (flags.hasDiff) {
        items.push({ key: "diff", label: "Review changes" });
    }
    if (flags.canToggleFullWidth) {
        items.push({ key: "fullwidth", label: flags.fullWidth ? "Exit full width" : "Full width" });
    }
    if (flags.hasMute) {
        items.push({ key: "mute", label: "Move to background" });
    }
    items.push({ key: "copy", label: "Copy name" });
    items.push({ separator: true });
    items.push({ key: "close", label: "Close agent", danger: true });
    return items;
}
```

- [ ] **Step 4: Repoint `agentrow.tsx`.**
  - Import: `import { agentRowMenuItems, clampQuestionIndex, entriesToShow, isFinishTransition, muteMode, type AgentRowMenuItem } from "./agentrowmodel";`
  - Replace `const entries = liveEntries.length > 0 ? liveEntries : (agent.previousInfo ?? []);` with `const entries = entriesToShow(liveEntries, agent.previousInfo);`
  - Replace `const qIdx = Math.min(activeQuestion ?? 0, Math.max(0, qs.length - 1));` with `const qIdx = clampQuestionIndex(activeQuestion, qs.length);`
  - Replace `const muteAction = idle ? onDismiss : onBackground;` with `const muteAction = muteMode(agent.state) === "dismiss" ? onDismiss : onBackground;`
  - In the `justFinished` effect, replace `if (prevStateRef.current === "working" && agent.state === "idle") {` with `if (isFinishTransition(prevStateRef.current, agent.state)) {`
  - Rebuild `onContextMenu` from the descriptor. Replace the body that pushes `items` with a mapping from `agentRowMenuItems(...)`:
    ```ts
    const onContextMenu = (e: React.MouseEvent) => {
        const icons: Record<string, React.ReactNode> = {
            open: <PanelRight size={15} />,
            terminal: <SquareTerminal size={15} />,
            diff: <GitCompare size={15} />,
            fullwidth: <Scaling size={15} />,
            mute: <Minimize2 size={15} />,
            copy: <Copy size={15} />,
            close: <X size={15} />,
        };
        const clicks: Record<string, () => void> = {
            open: onOpen,
            terminal: onOpenTerminal,
            diff: onOpenDiff,
            fullwidth: () => onToggleFullWidth?.(),
            mute: () => muteAction?.(),
            copy: () => void navigator.clipboard.writeText(agent.name),
            close: () => confirmCloseAgent(agent.id, agent.name),
        };
        const items: ContextMenuItem[] = agentRowMenuItems({
            hasDiff: !!diff,
            canToggleFullWidth: !!onToggleFullWidth,
            fullWidth: !!fullWidth,
            hasMute: !!muteAction,
        }).map((it) =>
            "separator" in it
                ? { type: "separator" }
                : { label: it.label, icon: icons[it.key], click: clicks[it.key], danger: it.danger }
        );
        ContextMenuModel.getInstance().showContextMenu(items, e);
    };
    ```
    This preserves the exact item set, order, labels, danger flag, icons, and click behavior of the original. Verify `ContextMenuItem` is the type currently used (it's referenced in the existing code as `ContextMenuItem[]`).

- [ ] **Step 5: Run tests — expect PASS.** Then typecheck.

- [ ] **Step 6: Commit** (staged by the orchestrator at the end).

---

## Verification (orchestrator, after all four tasks)

- [ ] Typecheck: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → exit 0.
- [ ] Run the four new/extended test files → all pass.
- [ ] Run the full `frontend/app/view/agents/` suite to catch any repoint regression → all pass.
- [ ] `npx eslint frontend/app/view/agents/{radarmodel,cockpitrailmodel,cockpitsurfacemodel,agentrowmodel}.ts frontend/app/view/agents/{radarsurface,cockpitrail,cockpitsurface,agentrow}.tsx` → clean.

## Self-Review notes

- Coverage: every named target file (radarsurface, cockpitsurface, agentrow, cockpitrail) has its inline glue extracted + pinned. Delegated logic is already covered by `radarmodel.test.ts` / `agentsviewmodel.test.ts` — not re-tested (DRY).
- Behavior-preserving: each extraction copies the exact inline expression; repoints are literal substitutions.
- No new deps, no render harness (Global Constraints).
