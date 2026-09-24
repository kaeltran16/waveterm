# Surface Loading States Implementation Plan

**Verify:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && npx vitest run`
**Setup:** `task worktree:prepare`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement your task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop cockpit surfaces from claiming "empty / never scanned / no project / no agents" before their data
has loaded, and make every cockpit loading placeholder a content-shaped skeleton.

**Architecture:** The store convention is that `null` means not loaded yet, and failures go to their own error
atom. A small pure phase function per surface returns `LoadPhase`, and the component branches on it. Loading
renders a skeleton built from the existing `Skeleton`/`SkeletonLine` (`frontend/app/element/skeleton.tsx`). No
new framework, no new tokens.

**Tech Stack:** React 19, jotai, Tailwind 4, vitest.

**Spec:** `docs/superpowers/specs/2026-09-24-surface-loading-states-design.md`. Read it before starting. It is
the source of truth for any decision this plan leaves implicit.

## Global Constraints

- "Loading" means there is no data yet, on first load only. A refetch or revalidation must never bring a skeleton back.
- A load failure goes to an error atom, never to `[]`/`null` as if the thing were empty.
- The shared type is `export type LoadPhase = "loading" | "empty" | "ready" | "error";` in `frontend/app/view/agents/loadphase.ts` (created by Task 1).
- Skeletons use only `Skeleton` / `SkeletonLine` / `skeletonClass` from `@/app/element/skeleton`. No raw colors and no new design tokens (see `DESIGN.md`).
- No jsdom/render tests (repo convention). Test the pure functions and stores.
- Every new test must fail on the code before your change. Check that it does before you implement.
- Do not edit `frontend/app/view/agents/surfacescaffold.tsx`.
- Check formatting only on the files you touched (`npx prettier --check <files>`). Never `--write` the tree. `npx tsc` stack-overflows, so use the Check command.
- Comments explain why, never what. Lower-case is fine. Match the density of the surrounding code.
- Commit messages: `type(scope): description`, subject under 72 chars. No `Co-Authored-By` or any other attribution trailer.
- Do not run `task dev` / `task check:ts` in the worktree; they run a real `npm install` over the junctioned `node_modules`.

## Review Focus

1. **Zero terminals at boot.** A fresh install with no agents must show Cockpit's real "no agents" empty state, not a skeleton that never ends. Pinned by Task 1's `isRosterSeeded([], ...)` test.
2. **A seed read that fails or times out.** It must settle the gate, or Cockpit stays on its skeleton forever. Pinned by Task 1's rejected-read test.
3. **A terminal opened after first load.** It must not put Cockpit back behind a skeleton. Pinned by Task 1's latch test and Task 2's `rosterLoadPhase` test (agents present means ready, whatever the seed state).
4. **A persisted Radar project that was removed from the registry** (`pickInitialScope` gives `"wait"`). It must not produce an endless skeleton. Pinned by Task 3's `scopeBlocked` test.
5. **A Radar list read that fails after results were already on screen.** The results stay, with an error banner above them. Pinned by Task 3's "error only with nothing to show" test.

---

### Task 1: LoadPhase type and the roster seeded latch
**Depends on:** none

**Files:**
- Create: `frontend/app/view/agents/loadphase.ts`
- Create: `frontend/app/view/agents/rosterseed.ts`, `frontend/app/view/agents/rosterseed.test.ts`
- Create: `frontend/app/view/agents/session-models/agentstatusseed.test.ts`
- Modify: `frontend/app/view/agents/session-models/agentstatusstore.ts` (`readRetainedStatus`, around lines 71-86)
- Modify: `frontend/app/view/agents/liveagents.ts` (append after `liveTerminalsAtom`)

**Interfaces:**
- Produces: `LoadPhase` (loadphase.ts). `seededOrefsAtom: PrimitiveAtom<ReadonlySet<string>>` (agentstatusstore.ts). `isRosterSeeded(orefs: string[], hasStatus: (oref: string) => boolean, settled: ReadonlySet<string>): boolean` and `latchWhenTrue(store, check: Atom<boolean>, latch: PrimitiveAtom<boolean>): () => void` (rosterseed.ts). `rosterSeededAtom: PrimitiveAtom<boolean>` and `setupRosterSeededLatch(): () => void` (liveagents.ts). Task 2 consumes `rosterSeededAtom`, `setupRosterSeededLatch`, and `LoadPhase`. Task 3 consumes `LoadPhase`.

- [ ] **Step 1: Create the shared type**

`frontend/app/view/agents/loadphase.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// What a surface can say about its data. "loading" is first load only — a refetch keeps what it has on
// screen. See docs/superpowers/specs/2026-09-24-surface-loading-states-design.md.

export type LoadPhase = "loading" | "empty" | "ready" | "error";
```

- [ ] **Step 2: Write the failing pure tests**

`frontend/app/view/agents/rosterseed.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { atom, createStore } from "jotai";
import { describe, expect, it } from "vitest";
import { isRosterSeeded, latchWhenTrue } from "./rosterseed";

describe("isRosterSeeded", () => {
    it("is seeded with no terminals, so the real empty state shows", () => {
        expect(isRosterSeeded([], () => false, new Set())).toBe(true);
    });
    it("is not seeded while any terminal is still reading its retained status", () => {
        expect(isRosterSeeded(["block:a", "block:b"], (o) => o === "block:a", new Set())).toBe(false);
    });
    it("counts a settled read with no status as seeded (a plain shell, or a failed read)", () => {
        expect(isRosterSeeded(["block:a"], () => false, new Set(["block:a"]))).toBe(true);
    });
    it("counts a live status as seeded before its history read settles", () => {
        expect(isRosterSeeded(["block:a"], () => true, new Set())).toBe(true);
    });
});

describe("latchWhenTrue", () => {
    it("flips when the check turns true and stays true after it turns false again", () => {
        const store = createStore();
        const check = atom(false);
        const latch = atom(false);
        latchWhenTrue(store, check, latch);
        expect(store.get(latch)).toBe(false);
        store.set(check, true);
        expect(store.get(latch)).toBe(true);
        // a terminal opened later makes the check false again; first load is over, so the latch holds
        store.set(check, false);
        expect(store.get(latch)).toBe(true);
    });
    it("flips at once when the check already holds", () => {
        const store = createStore();
        const latch = atom(false);
        latchWhenTrue(store, atom(true), latch);
        expect(store.get(latch)).toBe(true);
    });
    it("stops listening after the unsubscribe", () => {
        const store = createStore();
        const check = atom(false);
        const latch = atom(false);
        latchWhenTrue(store, check, latch)();
        store.set(check, true);
        expect(store.get(latch)).toBe(false);
    });
});
```

`frontend/app/view/agents/session-models/agentstatusseed.test.ts` (a separate file because it mocks the RPC
client for the whole module):

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { getAgentStatusAtom, seededOrefsAtom, setupAgentStatusSubscription } from "./agentstatusstore";

vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: vi.fn() }));
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { EventReadHistoryCommand: vi.fn() } }));

describe("retained status seeding", () => {
    beforeAll(() => setupAgentStatusSubscription());

    it("settles an oref whose read found a status", async () => {
        vi.mocked(RpcApi.EventReadHistoryCommand).mockResolvedValueOnce([
            { data: { oref: "block:a", state: "working", ts: 1 } },
        ] as any);
        getAgentStatusAtom("block:a");
        await vi.waitFor(() => expect(globalStore.get(seededOrefsAtom).has("block:a")).toBe(true));
        expect(globalStore.get(getAgentStatusAtom("block:a"))?.state).toBe("working");
    });

    it("settles an oref whose read failed, so the roster gate cannot hang on it", async () => {
        vi.mocked(RpcApi.EventReadHistoryCommand).mockRejectedValueOnce(new Error("EC-TIME"));
        getAgentStatusAtom("block:b");
        await vi.waitFor(() => expect(globalStore.get(seededOrefsAtom).has("block:b")).toBe(true));
        expect(globalStore.get(getAgentStatusAtom("block:b"))).toBeNull();
    });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run frontend/app/view/agents/rosterseed.test.ts frontend/app/view/agents/session-models/agentstatusseed.test.ts`
Expected: FAIL (`./rosterseed` does not exist; `seededOrefsAtom` is not exported).

- [ ] **Step 4: Implement `rosterseed.ts`**

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The roster's first-load gate, kept pure so it is testable without the sidebar model. After a reload every
// terminal's status is read back from event history asynchronously; until each read settles, an empty
// roster means "not read yet", not "no agents".

import type { Atom, createStore, PrimitiveAtom } from "jotai";

type Store = ReturnType<typeof createStore>;

export function isRosterSeeded(
    orefs: string[],
    hasStatus: (oref: string) => boolean,
    settled: ReadonlySet<string>
): boolean {
    return orefs.every((oref) => hasStatus(oref) || settled.has(oref));
}

// One-way: flips latch the first time check reads true, then stops listening. The returned unsubscribe is
// for a caller that goes away before that happens.
export function latchWhenTrue(store: Store, check: Atom<boolean>, latch: PrimitiveAtom<boolean>): () => void {
    if (store.get(latch)) {
        return () => {};
    }
    if (store.get(check)) {
        store.set(latch, true);
        return () => {};
    }
    const unsub = store.sub(check, () => {
        if (store.get(check)) {
            store.set(latch, true);
            unsub();
        }
    });
    return unsub;
}
```

- [ ] **Step 5: Settle every seed read in `agentstatusstore.ts`**

Add the atom above `readRetainedStatus`, and a `finally` to its body:

```ts
// Orefs whose retained-status read has finished — found a status, found none, or failed. The roster's
// first-load gate (liveagents.ts) waits on these, so a failed read has to settle too.
export const seededOrefsAtom = atom<ReadonlySet<string>>(new Set<string>()) as PrimitiveAtom<ReadonlySet<string>>;

function readRetainedStatus(oref: string, statusAtom: PrimitiveAtom<AgentStatusData>) {
    fireAndForget(async () => {
        try {
            const events = await RpcApi.EventReadHistoryCommand(TabRpcClient, {
                event: "agent:status",
                scope: oref,
                maxitems: 1,
            });
            const retained = events?.[events.length - 1]?.data as AgentStatusData | undefined;
            globalStore.set(statusAtom, (prev) => seedAgentStatus(prev, retained));
        } catch (err) {
            console.warn(`reading the retained agent:status of ${oref} failed`, err);
        } finally {
            globalStore.set(seededOrefsAtom, (prev) => new Set(prev).add(oref));
        }
    });
}
```

- [ ] **Step 6: Wire the latch in `liveagents.ts`**

Add imports: `seededOrefsAtom` from `@/app/view/agents/session-models/agentstatusstore` (extend the existing
import), and `isRosterSeeded, latchWhenTrue` from `./rosterseed`. Append after `liveTerminalsAtom`:

```ts
// Every terminal in the sidebar has either a status or a settled retained read.
const rosterSeedCheckAtom: Atom<boolean> = atom((get) => {
    const orefs = flattenVisualOrder(get(sessionSidebarViewModelAtom))
        .map((row) => row.termBlockOref)
        .filter((oref): oref is string => !!oref);
    const settled = get(seededOrefsAtom);
    return isRosterSeeded(orefs, (oref) => get(getAgentStatusAtom(oref)) != null, settled);
});

// First load only: a terminal opened later must not put the Cockpit back behind a skeleton.
export const rosterSeededAtom = atom(false) as PrimitiveAtom<boolean>;

// Installed from CockpitShell, not from boot: the status subscription starts before the workspace loads,
// when the sidebar has no terminals yet and the check would pass vacuously.
export function setupRosterSeededLatch(): () => void {
    return latchWhenTrue(globalStore, rosterSeedCheckAtom, rosterSeededAtom);
}
```

- [ ] **Step 7: Run the tests and the Check**

Run: `npx vitest run frontend/app/view/agents/rosterseed.test.ts frontend/app/view/agents/session-models/`
Expected: PASS. Then run the Check command. Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add frontend/app/view/agents/loadphase.ts frontend/app/view/agents/rosterseed.ts frontend/app/view/agents/rosterseed.test.ts frontend/app/view/agents/session-models/agentstatusstore.ts frontend/app/view/agents/session-models/agentstatusseed.test.ts frontend/app/view/agents/liveagents.ts
git commit -m "feat(cockpit): know when the roster has finished its first read"
```

### Task 2: Cockpit and Agent show a skeleton until the roster is read
**Depends on:** Task 1

**Files:**
- Modify: `frontend/app/view/agents/cockpitsurfacemodel.ts` (replace `isCockpitEmpty`)
- Modify: `frontend/app/view/agents/cockpitsurfacemodel.test.ts` (replace the `isCockpitEmpty` describe; edit the file, do not overwrite it)
- Modify: `frontend/app/view/agents/cockpitsurface.tsx` (import line 41; `empty` at ~457, ~554, ~583)
- Modify: `frontend/app/view/agents/agentsurface.tsx` (the `if (!agent)` branch)
- Modify: `frontend/app/view/agents/cockpitshell.tsx` (`CockpitShell` effects)

**Interfaces:**
- Consumes: `rosterSeededAtom`, `setupRosterSeededLatch` from `./liveagents`; `LoadPhase` from `./loadphase`.
- Produces: `rosterLoadPhase(seeded: boolean, agentCount: number): LoadPhase`.

- [ ] **Step 1: Write the failing test**

In `cockpitsurfacemodel.test.ts`, change the import to drop `isCockpitEmpty` and add `rosterLoadPhase`, then
replace the `describe("isCockpitEmpty", ...)` block with:

```ts
describe("rosterLoadPhase", () => {
    it("is loading, never empty, while an empty roster has not been read yet", () => {
        expect(rosterLoadPhase(false, 0)).toBe("loading");
    });
    it("is empty once the roster has been read and holds no agents", () => {
        expect(rosterLoadPhase(true, 0)).toBe("empty");
    });
    it("is ready whenever there are agents to show, read or not", () => {
        expect(rosterLoadPhase(false, 2)).toBe("ready");
        expect(rosterLoadPhase(true, 1)).toBe("ready");
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run frontend/app/view/agents/cockpitsurfacemodel.test.ts`
Expected: FAIL (`rosterLoadPhase` is not exported).

- [ ] **Step 3: Replace `isCockpitEmpty` in `cockpitsurfacemodel.ts`**

`isCockpitEmpty` has one caller (cockpitsurface.tsx). Delete it and add:

```ts
import type { LoadPhase } from "./loadphase";

// An empty roster is only "no agents" once it has been read; before that it is still loading. Agents that
// are already there always show, whatever the seed state.
export function rosterLoadPhase(seeded: boolean, agentCount: number): LoadPhase {
    if (agentCount > 0) {
        return "ready";
    }
    return seeded ? "empty" : "loading";
}
```

Update the file's header comment: it lists "empty-state"; it now says "the roster load phase".

- [ ] **Step 4: Cockpit renders the phase**

In `cockpitsurface.tsx`:
- The import becomes `import { dismissKey, rosterLoadPhase, splitRecentlyIdle, toggleInSet } from "./cockpitsurfacemodel";`. Add `import { Skeleton } from "@/app/element/skeleton";` and `rosterSeededAtom` from `./liveagents`.
- Replace `const empty = isCockpitEmpty(asking, working, idle);` with:

```tsx
    const seeded = useAtomValue(rosterSeededAtom);
    const phase = rosterLoadPhase(seeded, asking.length + working.length + idle.length);
```

  Put the `useAtomValue` call with the other hooks at the top of the component, not after any early return.
- In the `AnimatePresence` at ~553, replace `{empty ? (<CockpitEmptyState key="empty" .../>) : null}` with:

```tsx
                        {phase === "empty" ? (
                            <CockpitEmptyState
                                key="empty"
                                onNewAgent={() => globalStore.set(model.newAgentOpenAtom, true)}
                            />
                        ) : phase === "loading" ? (
                            <CockpitGridSkeleton key="loading" />
                        ) : null}
```

- Line ~583: `{!empty ? <HintsBar .../> : null}` becomes `{phase === "ready" ? <HintsBar .../> : null}`.
- Add the skeleton at the bottom of the file. Card shape and radius match `agentrow.tsx`'s card (`rounded-[13px]`), and the padding matches the grid container (`px-5 pt-2.5`, `gap-3.5`):

```tsx
// Card-shaped placeholders in the grid's own gutters, so the first cards land where the skeleton was.
function CockpitGridSkeleton() {
    return (
        <div aria-hidden="true" className="absolute inset-0 z-[1] flex items-start gap-3.5 px-5 pt-2.5">
            {[0, 1, 2].map((col) => (
                <div key={col} className="flex min-w-0 flex-1 flex-col gap-3.5">
                    <Skeleton className="h-[148px] rounded-[13px]" />
                    {col < 2 ? <Skeleton className="h-[112px] rounded-[13px]" /> : null}
                </div>
            ))}
        </div>
    );
}
```

  `CockpitEmptyState` is a `motion` component inside `AnimatePresence`. The skeleton needs no exit animation, so
  a plain `div` is fine. `AnimatePresence` only animates motion children.

- [ ] **Step 5: Agent renders the phase**

In `agentsurface.tsx`, add imports `rosterSeededAtom` from `./liveagents`, `rosterLoadPhase` from
`./cockpitsurfacemodel`, and `Skeleton, SkeletonLine` from `@/app/element/skeleton`. Next to the other
`useAtomValue` calls (before any return), add `const seeded = useAtomValue(rosterSeededAtom);`. Replace:

```tsx
    if (!agent) {
        return <AgentLaunchHero model={model} />;
    }
```

with:

```tsx
    if (!agent) {
        return rosterLoadPhase(seeded, agents.length) === "loading" ? (
            <AgentSurfaceSkeleton />
        ) : (
            <AgentLaunchHero model={model} />
        );
    }
```

At the bottom of the file (the tree width matches `agenttree.tsx`'s `w-[248px]` column):

```tsx
// the tree column and the terminal pane, so the first agent lands where the skeleton was
function AgentSurfaceSkeleton() {
    return (
        <div aria-hidden="true" className="flex h-full w-full bg-background">
            <div className="flex w-[248px] shrink-0 flex-col gap-3 border-r border-border bg-surface px-4 pt-4">
                <SkeletonLine className="h-[12px] w-[90px]" />
                {[0, 1, 2, 3].map((i) => (
                    <SkeletonLine key={i} className="h-[30px] w-full rounded-[8px]" />
                ))}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-3 p-5">
                <SkeletonLine className="h-[18px] w-[220px]" />
                <Skeleton className="min-h-0 flex-1 rounded-[10px]" />
            </div>
        </div>
    );
}
```

- [ ] **Step 6: Install the latch in `CockpitShell`**

In `cockpitshell.tsx`, import `setupRosterSeededLatch` from `./liveagents` and add beside the `primeChannels` effect:

```tsx
    // the roster's first-load gate; here rather than at boot, because boot subscribes before the workspace loads
    useEffect(() => setupRosterSeededLatch(), []);
```

- [ ] **Step 7: Run the tests and the Check**

Run: `npx vitest run frontend/app/view/agents/`. Expected: PASS. Then run the Check command. Expected: exit 0.
Run: `npx prettier --check` on the five modified files.

- [ ] **Step 8: Commit**

```bash
git add frontend/app/view/agents/cockpitsurfacemodel.ts frontend/app/view/agents/cockpitsurfacemodel.test.ts frontend/app/view/agents/cockpitsurface.tsx frontend/app/view/agents/agentsurface.tsx frontend/app/view/agents/cockpitshell.tsx
git commit -m "fix(cockpit): show a skeleton, not 'no agents', before the roster loads"
```

### Task 3: Radar tells loading and failure apart from never scanned
**Depends on:** Task 1

**Files:**
- Modify: `frontend/app/view/agents/radarstore.ts` (`findNewestScannedProject`, `loadReports`, `initRadarScope`; new atom and functions)
- Create: `frontend/app/view/agents/radarstoreload.test.ts`
- Modify: `frontend/app/view/agents/radarmodel.ts` (add `radarLoadPhase` beside `classifyScanState`)
- Modify: `frontend/app/view/agents/radarmodel.test.ts` (append a describe; edit, do not overwrite)
- Modify: `frontend/app/view/agents/radarsurface.tsx` (`RadarSurface`)

**Interfaces:**
- Consumes: `LoadPhase` from `./loadphase`.
- Produces: `radarLoadErrorAtom: PrimitiveAtom<string | null>`, `initRadarScopeFromNewest(): Promise<void>`, `retryRadarLoad(): Promise<void>` (radarstore.ts); `radarLoadPhase(p: { reports: RadarReport[] | null; currentReportId: string | undefined; report: RadarReport | null; loadError: string | null; scopeBlocked: boolean }): LoadPhase` (radarmodel.ts).

- [ ] **Step 1: Write the failing phase test**

Append to `radarmodel.test.ts`. Add `radarLoadPhase` to its import from `./radarmodel`, and build reports the
way the existing tests in that file already do (reuse its report factory):

```ts
describe("radarLoadPhase", () => {
    const base = { reports: [], currentReportId: undefined, report: null, loadError: null, scopeBlocked: false };
    it("is loading while the report list has not been fetched, not never-scanned", () => {
        expect(radarLoadPhase({ ...base, reports: null })).toBe("loading");
    });
    it("is loading while the selected report's object has not arrived", () => {
        expect(radarLoadPhase({ ...base, reports: [REPORT], currentReportId: REPORT.oid, report: null })).toBe("loading");
    });
    it("is an error only when a failed load left nothing to show", () => {
        expect(radarLoadPhase({ ...base, reports: null, loadError: "boom" })).toBe("error");
        expect(radarLoadPhase({ ...base, reports: [REPORT], currentReportId: REPORT.oid, report: REPORT, loadError: "boom" })).toBe("ready");
    });
    it("never waits forever on a project the registry no longer has", () => {
        expect(radarLoadPhase({ ...base, reports: null, scopeBlocked: true })).toBe("ready");
    });
    it("is ready on a loaded empty list, which is what never-scanned means", () => {
        expect(radarLoadPhase(base)).toBe("ready");
    });
});
```

Define `REPORT` at the top of the describe with the file's existing factory: `const REPORT = report();`. That
factory, at ~line 98, returns a completed report with `oid: "r1"`.

- [ ] **Step 2: Write the failing store test**

`frontend/app/view/agents/radarstoreload.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    initRadarScope,
    initRadarScopeFromNewest,
    loadReports,
    radarLoadErrorAtom,
    radarReportsAtom,
    radarScopeAtom,
} from "./radarstore";

vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { ListRadarReportsCommand: vi.fn() } }));

describe("radar report loading", () => {
    beforeEach(() => {
        vi.mocked(RpcApi.ListRadarReportsCommand).mockReset();
        globalStore.set(radarScopeAtom, { name: "p", path: "/p" });
        globalStore.set(radarReportsAtom, null);
        globalStore.set(radarLoadErrorAtom, null);
    });

    it("a failed list read is an error, and the list stays not-fetched rather than empty", async () => {
        vi.mocked(RpcApi.ListRadarReportsCommand).mockRejectedValueOnce(new Error("boom"));
        await loadReports("/p");
        expect(globalStore.get(radarReportsAtom)).toBeNull();
        expect(globalStore.get(radarLoadErrorAtom)).toContain("boom");
    });

    it("a successful read clears an earlier error", async () => {
        globalStore.set(radarLoadErrorAtom, "old");
        vi.mocked(RpcApi.ListRadarReportsCommand).mockResolvedValueOnce({ reports: [] } as any);
        await loadReports("/p");
        expect(globalStore.get(radarReportsAtom)).toEqual([]);
        expect(globalStore.get(radarLoadErrorAtom)).toBeNull();
    });

    it("no scope at all is a loaded empty list, so never-scanned is honest", async () => {
        await initRadarScope(null);
        expect(globalStore.get(radarReportsAtom)).toEqual([]);
    });

    it("a failed newest-scanned lookup is an error, not a never-scanned landing", async () => {
        globalStore.set(radarScopeAtom, null);
        vi.mocked(RpcApi.ListRadarReportsCommand).mockRejectedValueOnce(new Error("down"));
        await initRadarScopeFromNewest();
        expect(globalStore.get(radarReportsAtom)).toBeNull();
        expect(globalStore.get(radarLoadErrorAtom)).toContain("down");
    });
});
```

- [ ] **Step 3: Run both to verify they fail**

Run: `npx vitest run frontend/app/view/agents/radarmodel.test.ts frontend/app/view/agents/radarstoreload.test.ts`
Expected: FAIL (missing exports).

- [ ] **Step 4: Implement `radarLoadPhase` in `radarmodel.ts`**

Add `import type { LoadPhase } from "./loadphase";` and, after `classifyScanState`:

```ts
// Whether the scan-state machine above may speak yet. classifyScanState(null) is "never-scanned", which is
// only true once the list has actually been read; before that it is loading. "ready" hands over to
// classifyScanState — Radar's empty is its never-scanned panel, so there is no "empty" here.
export function radarLoadPhase(p: {
    reports: RadarReport[] | null;
    currentReportId: string | undefined;
    report: RadarReport | null;
    loadError: string | null;
    scopeBlocked: boolean;
}): LoadPhase {
    if (p.loadError != null && p.reports == null) {
        return "error";
    }
    // a persisted project the registry no longer has never resolves; waiting on it would be a skeleton forever
    if (p.scopeBlocked) {
        return "ready";
    }
    if (p.reports == null || (p.currentReportId != null && p.report == null)) {
        return "loading";
    }
    return "ready";
}
```

- [ ] **Step 5: Implement the store changes in `radarstore.ts`**

1. Add after `radarReportsAtom`:

```ts
// A failed report read. Kept apart from radarReportsAtom so a failure never reads as "never scanned".
export const radarLoadErrorAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
```

2. `findNewestScannedProject` stops swallowing. Remove its `try/catch`, so a failure rejects. Update its doc
   comment: "Returns null when nothing has ever been scanned; a failed query rejects." Its only caller becomes the
   new function below.

3. Add:

```ts
// First landing with no persisted scope: the newest-scanned project, or none. A failed lookup is a load
// error, not a never-scanned landing.
export async function initRadarScopeFromNewest(): Promise<void> {
    let scope: RadarScope | null;
    try {
        scope = await findNewestScannedProject();
    } catch (err) {
        console.error("finding newest scanned project failed", err);
        globalStore.set(radarLoadErrorAtom, `Couldn't read Radar reports: ${String(err)}`);
        return;
    }
    await initRadarScope(scope);
}

// The load-error banner's retry: re-reads whichever load failed.
export async function retryRadarLoad(): Promise<void> {
    globalStore.set(radarLoadErrorAtom, null);
    const scope = globalStore.get(radarScopeAtom);
    if (scope != null) {
        await loadReports(scope.path);
        return;
    }
    await initRadarScopeFromNewest();
}
```

4. In `loadReports`: after the "scope moved" guard, and before setting the list, add `globalStore.set(radarLoadErrorAtom, null);`.
   Replace the catch body with:

```ts
        console.error("loading radar reports failed", err);
        if (globalStore.get(radarScopeAtom)?.path === path) {
            globalStore.set(radarLoadErrorAtom, `Couldn't read Radar reports: ${String(err)}`);
        }
```

   The catch no longer writes `[]`. `null` stays "not fetched".

5. In `initRadarScope`, the `!scope` branch sets `radarReportsAtom` to `[]` instead of `null`, because a missing
   scope has nothing to fetch. Update the function's comment: "Clearing scope (null) leaves a loaded, empty list."

- [ ] **Step 6: Wire the surface in `radarsurface.tsx`**

- Import `SurfaceError` from `./surfacescaffold`, `Skeleton, SkeletonLine` from `@/app/element/skeleton`, and
  `radarLoadPhase` from `./radarmodel`. From `./radarstore`, add `currentReportIdAtom`, `initRadarScopeFromNewest`,
  `radarLoadErrorAtom`, `radarReportsAtom`, and `retryRadarLoad`, and drop `findNewestScannedProject`.
- In the init effect, replace `fireAndForget(async () => initRadarScope(await findNewestScannedProject()));` with
  `fireAndForget(initRadarScopeFromNewest);`.
- After the existing `useAtomValue` calls, add:

```tsx
    const reports = useAtomValue(radarReportsAtom);
    const currentReportId = useAtomValue(currentReportIdAtom);
    const loadError = useAtomValue(radarLoadErrorAtom);
    const persisted = useAtomValue(lastRadarProjectAtom);
    const scopeBlocked = pickInitialScope(scope, persisted, filter, projects).action === "wait";
    const phase = radarLoadPhase({ reports, currentReportId, report, loadError, scopeBlocked });
```

- Directly under `<DivergenceBanner .../>`, add
  `{loadError != null ? <SurfaceError message={loadError} onRetry={() => fireAndForget(retryRadarLoad)} /> : null}`.
- In the body's `AnimatePresence mode="wait"`, branch on `phase` before the existing `isResults && report` ternary.
  `"loading"` renders a keyed `motion.div` (`key="loading"`, the same fade props as the `"panel"` one) that
  contains `<RadarBodySkeleton />`. `"error"` renders nothing, because the banner already says it. Otherwise
  keep the existing results/panel ternary unchanged.
- Add at the bottom of the file:

```tsx
// the findings list beside the detail pane, so results land where the skeleton was
function RadarBodySkeleton() {
    return (
        <div aria-hidden="true" className="flex h-full border-t border-edge-faint">
            <div className="flex w-[360px] shrink-0 flex-col gap-2.5 border-r border-edge-faint p-3.5">
                {[0, 1, 2, 3, 4, 5].map((i) => (
                    <SkeletonLine key={i} className="h-[46px] w-full rounded-[9px]" />
                ))}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-3 p-6">
                <SkeletonLine className="h-[20px] w-[55%]" />
                <SkeletonLine className="h-[11px] w-[80%]" />
                <SkeletonLine className="h-[11px] w-[70%]" />
                <Skeleton className="mt-2 h-[120px] w-full rounded-[10px]" />
            </div>
        </div>
    );
}
```

- [ ] **Step 7: Run the tests and the Check**

Run: `npx vitest run frontend/app/view/agents/radarmodel.test.ts frontend/app/view/agents/radarstore.test.ts frontend/app/view/agents/radarstoreload.test.ts`
Expected: PASS. Then run the Check command. Expected: exit 0. `grep -rn findNewestScannedProject frontend/app`
should now list only radarstore.ts.

- [ ] **Step 8: Commit**

```bash
git add frontend/app/view/agents/radarstore.ts frontend/app/view/agents/radarstoreload.test.ts frontend/app/view/agents/radarmodel.ts frontend/app/view/agents/radarmodel.test.ts frontend/app/view/agents/radarsurface.tsx
git commit -m "fix(radar): stop saying never scanned while reports are loading or failed"
```

### Task 4: Code shows loading while a project restores or its files list
**Depends on:** none

**Files:**
- Modify: `frontend/app/view/code/codestore.ts` (add `codeBodyPhase` beside `canRestoreProject`, ~line 258)
- Modify: `frontend/app/view/code/codestore.test.ts` (append; edit, do not overwrite)
- Modify: `frontend/app/view/code/codesurface.tsx` (`CodeBody`, ~line 456)

**Interfaces:**
- Produces: `type CodeBodyPhase = "no-projects" | "no-project" | "error" | "loading" | "not-repo" | "ready"` and `codeBodyPhase(p: { registry: Record<string, ProjectKeywords> | undefined; project: CodeProject | null; stored: CodeProject | null; index: CodeIndex | null; indexError: string | null }): CodeBodyPhase`.

- [ ] **Step 1: Write the failing test**

Append to `codestore.test.ts`, and add `codeBodyPhase` to its import:

```ts
describe("codeBodyPhase", () => {
    const alpha = { name: "alpha", path: "C:\\repos\\alpha" };
    const idx = (isRepo: boolean) => ({ paths: [], isRepo, truncated: false });
    const base = { registry, project: alpha, stored: null, index: idx(true), indexError: null };

    it("is loading while a stored project is about to be restored, not no-project", () => {
        expect(codeBodyPhase({ ...base, project: null, stored: alpha })).toBe("loading");
    });
    it("is no-project when nothing restorable was stored", () => {
        expect(codeBodyPhase({ ...base, project: null })).toBe("no-project");
        expect(codeBodyPhase({ ...base, project: null, stored: { name: "gone", path: "/gone" } })).toBe("no-project");
    });
    it("is loading while the file list has not arrived", () => {
        expect(codeBodyPhase({ ...base, index: null })).toBe("loading");
    });
    it("keeps the existing branches", () => {
        expect(codeBodyPhase({ ...base, registry: {} })).toBe("no-projects");
        expect(codeBodyPhase({ ...base, index: null, indexError: "boom" })).toBe("error");
        expect(codeBodyPhase({ ...base, index: idx(false) })).toBe("not-repo");
        expect(codeBodyPhase(base)).toBe("ready");
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run frontend/app/view/code/codestore.test.ts`
Expected: FAIL (`codeBodyPhase` is not exported).

- [ ] **Step 3: Implement it in `codestore.ts`, after `canRestoreProject`**

```ts
export type CodeBodyPhase = "no-projects" | "no-project" | "error" | "loading" | "not-repo" | "ready";

// What CodeBody shows. A stored project the restore effect is about to reopen is "loading": that effect
// runs after the first paint, and "No project selected" there is a false claim. More states than LoadPhase
// has, so this is Code's own union.
export function codeBodyPhase(p: {
    registry: Record<string, ProjectKeywords> | undefined;
    project: CodeProject | null;
    stored: CodeProject | null;
    index: CodeIndex | null;
    indexError: string | null;
}): CodeBodyPhase {
    if (Object.keys(p.registry ?? {}).length === 0) {
        return "no-projects";
    }
    if (p.project == null) {
        return canRestoreProject(p.stored, p.registry ?? {}) ? "loading" : "no-project";
    }
    if (p.indexError != null) {
        return "error";
    }
    if (p.index == null) {
        return "loading";
    }
    return p.index.isRepo ? "ready" : "not-repo";
}
```

- [ ] **Step 4: `CodeBody` switches on it**

Import `codeBodyPhase` and `lastCodeProjectAtom` (if not already imported) from `./codestore`,
`CODE_SIDEBAR_DEFAULT_WIDTHS` from `./codesidebar` (extend the existing import), and `SkeletonLine` from
`@/app/element/skeleton`. Replace the body of `CodeBody` after its `useAtomValue` lines (add
`const stored = useAtomValue(lastCodeProjectAtom);`) with:

```tsx
    switch (codeBodyPhase({ registry, project, stored, index, indexError })) {
        case "no-projects":
            return (
                <SurfaceEmptyState
                    title="No registered projects"
                    body="Register a project in Settings to browse its source here."
                />
            );
        case "no-project":
            return (
                <SurfaceEmptyState
                    title="No project selected"
                    body="Pick a project to browse its files."
                    action={{ label: "Pick a project", onClick: onPickProject }}
                />
            );
        case "error":
            return null; // the banner above already says it, and a second message would double up
        case "loading":
            return <CodePanesSkeleton />;
        case "not-repo":
            return <SurfaceEmptyState title="Not a git repository" body={project.path} />;
        case "ready":
            return <CodePanes model={model} />;
    }
```

Add after `CodeBody`:

```tsx
// the file tree at its default width beside the editor, so the listing lands where the skeleton was
function CodePanesSkeleton() {
    return (
        <div aria-hidden="true" className="flex h-full">
            <div
                className="flex shrink-0 flex-col gap-2 border-r border-border px-3 pt-3"
                style={{ width: CODE_SIDEBAR_DEFAULT_WIDTHS.files }}
            >
                {["w-[70%]", "w-[55%]", "w-[80%]", "w-[45%]", "w-[65%]", "w-[50%]"].map((w, i) => (
                    <SkeletonLine key={i} className={cn("h-[11px]", w)} />
                ))}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-2.5 p-5">
                {["w-[60%]", "w-[85%]", "w-[75%]", "w-[40%]", "w-[90%]", "w-[70%]"].map((w, i) => (
                    <SkeletonLine key={i} className={cn("h-[11px]", w)} />
                ))}
            </div>
        </div>
    );
}
```

- [ ] **Step 5: Run the tests and the Check**

Run: `npx vitest run frontend/app/view/code/`. Expected: PASS. Then run the Check command. Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/view/code/codestore.ts frontend/app/view/code/codestore.test.ts frontend/app/view/code/codesurface.tsx
git commit -m "fix(code): show a skeleton while a project restores or lists files"
```

### Task 5: Transcript panes load behind one shared skeleton
**Depends on:** none

**Files:**
- Create: `frontend/app/view/agents/transcriptskeleton.tsx`
- Modify: `frontend/app/view/agents/endedtranscript.tsx` (~line 81-87)
- Modify: `frontend/app/view/agents/sessionssurface.tsx` (~line 453-454)
- Modify: `frontend/app/view/agents/subagentinterior.tsx` (~line 47-53)

**Interfaces:**
- Produces: `TranscriptSkeleton({ className }: { className?: string })`.

This task is presentational only: the loading condition in each pane is unchanged, so there is no new pure
logic to unit-test. Verification is the Check plus the full vitest run.

- [ ] **Step 1: Create the skeleton**

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Placeholder for a narration timeline that has not arrived yet: ragged message rows, the shape the
// timeline will take, instead of a "Loading transcript…" line.

import { SkeletonLine } from "@/app/element/skeleton";
import { cn } from "@/util/util";

const ROW_WIDTHS = ["w-[72%]", "w-[48%]", "w-[86%]", "w-[60%]", "w-[40%]"];

export function TranscriptSkeleton({ className }: { className?: string }) {
    return (
        <div aria-hidden="true" className={cn("flex flex-col gap-4", className)}>
            {ROW_WIDTHS.map((w, i) => (
                <div key={i} className="flex flex-col gap-1.5">
                    <SkeletonLine className="h-[9px] w-[64px]" />
                    <SkeletonLine className={cn("h-[11px]", w)} />
                </div>
            ))}
        </div>
    );
}
```

- [ ] **Step 2: Use it in the three panes**

- `endedtranscript.tsx`: the `entries.length > 0` else-branch keeps `missing` as a message. It becomes:

```tsx
                    {entries.length > 0 ? (
                        <NarrationTimeline entries={entries} active={false} />
                    ) : missing ? (
                        <div className="flex h-full items-center justify-center text-[12px] text-muted">
                            No transcript found for this session.
                        </div>
                    ) : (
                        <TranscriptSkeleton />
                    )}
```

- `sessionssurface.tsx`: `<div className="text-[13px] text-muted">Loading transcript…</div>` becomes `<TranscriptSkeleton />`.
- `subagentinterior.tsx`: the else-branch div containing "Loading subagent transcript…" becomes `<TranscriptSkeleton />`.

Import `{ TranscriptSkeleton } from "./transcriptskeleton"` in each.

- [ ] **Step 3: Check and test**

Run the Check command (expected exit 0), then `npx vitest run frontend/app/view/agents/` (expected PASS), then
`npx prettier --check` on the four files.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/view/agents/transcriptskeleton.tsx frontend/app/view/agents/endedtranscript.tsx frontend/app/view/agents/sessionssurface.tsx frontend/app/view/agents/subagentinterior.tsx
git commit -m "feat(agents): load transcripts behind a skeleton, not a text line"
```

### Task 6: Graph panes load behind one shared skeleton
**Depends on:** none

**Files:**
- Create: `frontend/app/view/jarvis/graphskeleton.tsx`
- Modify: `frontend/app/view/jarvis/jarvisgraph.tsx` (Suspense fallback, ~line 465)
- Modify: `frontend/app/view/jarvis/graphpeek.tsx` (`!loaded` branch, ~line 166-169)
- Modify: `frontend/app/view/orchestrate/daggraph.tsx` (`loading || !group`, ~line 371-373)
- Modify: `frontend/app/view/orchestrate/dagmodal.tsx` (`loading || owner == null`, ~line 136-138)

**Interfaces:**
- Produces: `GraphSkeleton()`, which fills its container. `orchestrate/` already imports from `jarvis/`, so this adds no new dependency direction.

This task is presentational only, with no new logic. Verification is the Check plus the full vitest run.

- [ ] **Step 1: Create the skeleton**

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Placeholder for a graph that has not laid out yet (vault graph, DAG): a few node-shaped blocks, not a
// "Loading graph…" line.

import { Skeleton } from "@/app/element/skeleton";

export function GraphSkeleton() {
    return (
        <div aria-hidden="true" className="flex h-full w-full items-center justify-center gap-10">
            <Skeleton className="h-[44px] w-[140px] rounded-[10px]" />
            <div className="flex flex-col gap-6">
                <Skeleton className="h-[44px] w-[140px] rounded-[10px]" />
                <Skeleton className="h-[44px] w-[140px] rounded-[10px]" />
            </div>
            <Skeleton className="h-[44px] w-[140px] rounded-[10px]" />
        </div>
    );
}
```

- [ ] **Step 2: Use it in the four panes**

- `jarvisgraph.tsx`: `fallback={<div className="p-[28px] text-[13px] text-ink-mid">Loading graph…</div>}` becomes `fallback={<GraphSkeleton />}`.
- `graphpeek.tsx`: the `!loaded` branch's div with "Loading graph…" becomes `<GraphSkeleton />`.
- `daggraph.tsx`: `return <div ...>loading dag…</div>;` becomes `return <GraphSkeleton />;`.
- `dagmodal.tsx`: `return <div ...>loading run route…</div>;` becomes `return <GraphSkeleton />;`.

Import it as `./graphskeleton` in jarvis/ and `@/app/view/jarvis/graphskeleton` in orchestrate/.

- [ ] **Step 3: Check and test**

Run the Check command (expected exit 0), then `npx vitest run frontend/app/view/jarvis/ frontend/app/view/orchestrate/`
(expected PASS), then `npx prettier --check` on the five files.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/view/jarvis/graphskeleton.tsx frontend/app/view/jarvis/jarvisgraph.tsx frontend/app/view/jarvis/graphpeek.tsx frontend/app/view/orchestrate/daggraph.tsx frontend/app/view/orchestrate/dagmodal.tsx
git commit -m "feat(jarvis): load graphs behind a skeleton, not a text line"
```

### Task 7: Small panes swap "Loading…" text for inline skeleton lines
**Depends on:** none

**Files:**
- Modify: `frontend/app/view/agents/agentdetailsrail.tsx` (~line 551)
- Modify: `frontend/app/view/agents/planpreview.tsx` (~line 127-128)
- Modify: `frontend/app/view/jarvis/briefpeekview.tsx` (~line 189-191)
- Modify: `frontend/app/view/jarvis/chunksidebar.tsx` (~line 30)
- Modify: `frontend/app/view/jarvis/recordpicker.tsx` (~line 35-36)
- Modify: `frontend/app/view/orchestrate/timelinerail.tsx` (history body, ~line 199-212)

Each site gets `import { SkeletonLine } from "@/app/element/skeleton";`. This task is presentational only, with
no new logic. Verification is the Check plus the full vitest run.

- [ ] **Step 1: Replace each site**

- `agentdetailsrail.tsx` Files-touched section: `<div className="text-[11.5px] text-muted">Loading…</div>` becomes:

```tsx
                                  <div aria-hidden="true" className="flex flex-col gap-2">
                                      {["w-[80%]", "w-[60%]", "w-[70%]"].map((w, i) => (
                                          <SkeletonLine key={i} className={cn("h-[10px]", w)} />
                                      ))}
                                  </div>
```

- `planpreview.tsx`: `<span className="text-[12px] text-muted">Loading plan…</span>` becomes:

```tsx
                        <div aria-hidden="true" className="flex flex-col gap-2 pt-1">
                            {["w-[45%]", "w-[85%]", "w-[75%]", "w-[60%]"].map((w, i) => (
                                <SkeletonLine key={i} className={cn("h-[11px]", w)} />
                            ))}
                        </div>
```

- `briefpeekview.tsx` title: `{peek?.title ?? "Loading…"}` becomes
  `{peek != null ? peek.title : <SkeletonLine className="h-[12px] w-[180px]" />}`.
  If `peek.title` can itself be undefined on a loaded peek, keep `peek.title ?? ""` so a loaded peek never shows a skeleton.
- `chunksidebar.tsx` `NoteRun`: `return <span className="text-[11.5px] text-muted">Loading the run…</span>;` becomes:

```tsx
        return (
            <div aria-hidden="true" className="flex flex-col gap-2">
                <SkeletonLine className="h-[10px] w-[85%]" />
                <SkeletonLine className="h-[10px] w-[60%]" />
            </div>
        );
```

- `recordpicker.tsx`: `<span className="font-mono text-[11px] text-muted">Loading records…</span>` becomes:

```tsx
                <div aria-hidden="true" className="flex flex-col gap-1.5">
                    {["w-[70%]", "w-[55%]", "w-[65%]"].map((w, i) => (
                        <SkeletonLine key={i} className={cn("h-[20px] rounded-[6px]", w)} />
                    ))}
                </div>
```

- `timelinerail.tsx` history body (the function holding `let text = "No lifecycle events yet";`): return a
  skeleton for `status === "loading"` before the text logic, and drop the `"Loading history…"` branch. The
  `StatusPill`'s `"loading…"` label is a status, not a placeholder, so leave it.

```tsx
    if (status === "loading") {
        return (
            <div aria-hidden="true" className="flex flex-col gap-2 px-1 py-3">
                {["w-[75%]", "w-[55%]", "w-[65%]"].map((w, i) => (
                    <SkeletonLine key={i} className={cn("h-[10px]", w)} />
                ))}
            </div>
        );
    }
```

Import `cn` from `@/util/util` where a site uses it and does not already import it.

- [ ] **Step 2: Check and test**

Run the Check command (expected exit 0), then `npx vitest run frontend/app/view/` (expected PASS), then
`npx prettier --check` on the six files. `grep -rn "Loading…\|loading dag\|Loading history" frontend/app/view`
should now list none of these six sites.

- [ ] **Step 3: Commit**

```bash
git add frontend/app/view/agents/agentdetailsrail.tsx frontend/app/view/agents/planpreview.tsx frontend/app/view/jarvis/briefpeekview.tsx frontend/app/view/jarvis/chunksidebar.tsx frontend/app/view/jarvis/recordpicker.tsx frontend/app/view/orchestrate/timelinerail.tsx
git commit -m "feat(cockpit): replace loading text in small panes with skeleton lines"
```
