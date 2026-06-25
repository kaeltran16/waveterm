# Cockpit Phase 1a — Shell + Cockpit Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the cockpit's single `AgentsView` component into a thin shell (an 8-item NavRail + a `surfaceAtom`-driven router) with a rebuilt Cockpit surface — a 2-col grid where every live agent card always shows its feed and answers in place — while lifting orchestration state onto `AgentsViewModel`.

**Architecture:** `CockpitBody` (in `cockpit-root.tsx`) renders a new `CockpitShell` instead of today's roster+terminal two-pane. `CockpitShell` = `NavRail` + the surface selected by `model.surfaceAtom`. In 1a only the **Cockpit** surface is built; **Agent** routes to the existing `FocusView` (interim, no regression); all other nav items route to a `PlaceholderSurface`. Orchestration state moves from `AgentsView`'s `useState`s onto `AgentsViewModel` as jotai atoms; lifecycle effects stay in the Cockpit surface component.

**Tech Stack:** React 19, jotai, motion/react, Tailwind v4 (`@theme` tokens), vitest (node env — pure-logic tests only; UI verified via tsc + CDP).

**Spec:** `docs/superpowers/specs/2026-06-25-cockpit-phase1a-shell-cockpit-design.md`

---

## Conventions for this plan

- **Typecheck command** (the repo's `tsc` stack-overflows under bare `npx tsc`):
  `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
  Baseline = exactly 3 pre-existing errors in `frontend/tauri/api.test.ts`. "tsc clean" below means *no new errors beyond those 3*.
- **Unit tests:** `npx vitest run` (and single-file `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts`).
- **CDP dev-app check:** `task dev` launches the Tauri dev app; inspect via Chrome DevTools Protocol on `:9222`. Used wherever a step changes rendered UI (no jsdom test harness exists).
- **Commits:** each task ends with a commit. The repo owner batches/approves commits — if executing inline, follow their git workflow (do not push; do not self-author).

---

### Task 1: Extract `toggleSelection` pure helper (answer-option toggle logic)

The answer-selection toggle currently lives as a closure (`toggleAnswer`) inside `AgentsView`. Lift its *logic* into a pure, tested function so the surface/model wiring stays thin.

**Files:**
- Modify: `frontend/app/view/agents/agentsviewmodel.ts` (add function near `buildAskAnswers`, ~line 371)
- Test: `frontend/app/view/agents/agentsviewmodel.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `agentsviewmodel.test.ts` (import `toggleSelection` in the top import block alongside `buildAskAnswers`):

```ts
describe("toggleSelection", () => {
    it("single-select replaces the prior choice for that question", () => {
        const out = toggleSelection({ 0: new Set([1]) }, 0, 2, false);
        expect([...out[0]]).toEqual([2]);
    });
    it("multi-select adds then removes on repeat", () => {
        const added = toggleSelection({}, 0, 1, true);
        expect([...added[0]]).toEqual([1]);
        const removed = toggleSelection(added, 0, 1, true);
        expect([...removed[0]]).toEqual([]);
    });
    it("does not mutate the previous selections", () => {
        const prev = { 0: new Set([1]) };
        toggleSelection(prev, 0, 2, false);
        expect([...prev[0]]).toEqual([1]);
    });
    it("keeps selections for other questions intact", () => {
        const out = toggleSelection({ 0: new Set([1]), 1: new Set([3]) }, 0, 2, false);
        expect([...out[1]]).toEqual([3]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts -t toggleSelection`
Expected: FAIL — `toggleSelection is not a function` (not exported yet).

- [ ] **Step 3: Write the implementation**

Add to `agentsviewmodel.ts`:

```ts
/** Pure: toggle option `oi` of question `qi` in a selection map. Single-select replaces the
 *  question's choice; multi-select toggles membership. Never mutates `prev` (clones the map and
 *  the affected set). Mirrors the AnswerBar's interaction. */
export function toggleSelection(
    prev: Record<number, Set<number>>,
    qi: number,
    oi: number,
    multiSelect: boolean
): Record<number, Set<number>> {
    const next = { ...prev };
    const set = new Set(next[qi] ?? []);
    if (multiSelect) {
        if (set.has(oi)) {
            set.delete(oi);
        } else {
            set.add(oi);
        }
    } else {
        set.clear();
        set.add(oi);
    }
    next[qi] = set;
    return next;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts -t toggleSelection`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/agentsviewmodel.ts frontend/app/view/agents/agentsviewmodel.test.ts
git commit -m "feat(agents): extract toggleSelection pure helper"
```

---

### Task 2: Add orchestration atoms + `SurfaceKey` to `AgentsViewModel`

Add the lifted state as atoms and the surface key type. No behavior change yet — `AgentsView` still uses its local `useState`s; this task only adds the fields the later tasks read.

**Files:**
- Modify: `frontend/app/view/agents/agents.tsx` (the `AgentsViewModel` class, ~lines 606–635; imports at top)

- [ ] **Step 1: Add the `SurfaceKey` type and atom imports**

At the top of `agents.tsx`, ensure `atom` and `PrimitiveAtom` are imported from jotai (already are). Add the surface key type above the class (near line 606):

```ts
export type SurfaceKey =
    | "cockpit"
    | "agent"
    | "activity"
    | "channels"
    | "sessions"
    | "files"
    | "memory"
    | "usage";

// Surfaces with a built implementation in this phase. Everything else routes to PlaceholderSurface.
export const BUILT_SURFACES: ReadonlySet<SurfaceKey> = new Set<SurfaceKey>(["cockpit", "agent"]);
```

- [ ] **Step 2: Add the atoms as model fields**

In the `AgentsViewModel` class body (after `terminalTargetAtom`, ~line 616), add:

```ts
    surfaceAtom = atom<SurfaceKey>("cockpit");
    nowAtom = atom(Date.now());
    cursorIdAtom = atom<string | undefined>(undefined) as PrimitiveAtom<string | undefined>;
    cockpitSelIdAtom = atom<string | undefined>(undefined) as PrimitiveAtom<string | undefined>;
    orderAtom = atom<string[]>([]) as PrimitiveAtom<string[]>;
    backgroundedIdsAtom = atom<Set<string>>(new Set<string>()) as PrimitiveAtom<Set<string>>;
    dismissedAtom = atom<Set<string>>(new Set<string>()) as PrimitiveAtom<Set<string>>;
    answerSelAtom = atom<Record<string, Record<number, Set<number>>>>({}) as PrimitiveAtom<
        Record<string, Record<number, Set<number>>>
    >;
    answerTabAtom = atom<Record<string, number>>({}) as PrimitiveAtom<Record<string, number>>;
    sentIdsAtom = atom<Set<string>>(new Set<string>()) as PrimitiveAtom<Set<string>>;
    focusIdAtom = atom<string | undefined>(undefined) as PrimitiveAtom<string | undefined>;
    focusReplyAtom = atom(false);
```

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: tsc clean (3 baseline errors only). `surfaceAtom`/atoms compile; nothing consumes them yet.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/view/agents/agents.tsx
git commit -m "feat(cockpit): add surface + orchestration atoms to AgentsViewModel"
```

---

### Task 3: `NavRail` component

A presentational rail of the eight handoff surfaces. Reads/writes `model.surfaceAtom`. Active item gets the periwinkle pill + left bar from the design.

**Files:**
- Create: `frontend/app/view/agents/navrail.tsx`

- [ ] **Step 1: Write the component**

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { useAtom } from "jotai";
import type { AgentsViewModel, SurfaceKey } from "./agents";

const ITEMS: { key: SurfaceKey; label: string }[] = [
    { key: "cockpit", label: "Cockpit" },
    { key: "agent", label: "Agent" },
    { key: "activity", label: "Activity" },
    { key: "channels", label: "Channels" },
    { key: "sessions", label: "Sessions" },
    { key: "files", label: "Files" },
    { key: "memory", label: "Memory" },
    { key: "usage", label: "Usage" },
];

export function NavRail({ model }: { model: AgentsViewModel }) {
    const [active, setActive] = useAtom(model.surfaceAtom);
    return (
        <nav className="flex w-[78px] shrink-0 flex-col gap-[3px] border-r border-border bg-surface py-2.5">
            {ITEMS.map(({ key, label }) => {
                const isActive = active === key;
                return (
                    <button
                        key={key}
                        type="button"
                        onClick={() => setActive(key)}
                        className={cn(
                            "relative mx-2 flex cursor-pointer flex-col items-center gap-[5px] rounded-[10px] border-0 bg-transparent py-[11px] text-muted transition-colors hover:text-muted-foreground",
                            isActive && "text-accent-soft"
                        )}
                    >
                        {isActive ? (
                            <>
                                <span className="absolute inset-0 rounded-[10px] bg-accent/10" />
                                <span className="absolute left-[-8px] top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-[3px] bg-accent" />
                            </>
                        ) : null}
                        <span className="relative z-[1] font-mono text-[10px] font-semibold">{label}</span>
                    </button>
                );
            })}
        </nav>
    );
}
```

> Note: the handoff uses per-item SVG glyphs above each label. They are cosmetic; ship the labels first and add glyphs in the ergonomics fast-follow. `bg-surface`, `text-accent-soft`, `bg-accent/10` are the tokens from the foundation theme (`ca1a6c45`).

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: tsc clean. (Component is unused so far — that's fine.)

- [ ] **Step 3: Commit**

```bash
git add frontend/app/view/agents/navrail.tsx
git commit -m "feat(cockpit): add NavRail surface switcher"
```

---

### Task 4: `PlaceholderSurface` component

A calm "coming soon" pane for not-yet-built surfaces (meta D6).

**Files:**
- Create: `frontend/app/view/agents/placeholdersurface.tsx`

- [ ] **Step 1: Write the component**

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

const TITLES: Record<string, string> = {
    activity: "Activity",
    channels: "Channels",
    sessions: "Sessions",
    files: "Files",
    memory: "Memory",
    usage: "Usage",
};

export function PlaceholderSurface({ surface }: { surface: string }) {
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-background text-center">
            <div className="text-[15px] font-semibold text-secondary">{TITLES[surface] ?? surface}</div>
            <div className="text-[12px] text-muted">Coming soon.</div>
        </div>
    );
}
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: tsc clean.

- [ ] **Step 3: Commit**

```bash
git add frontend/app/view/agents/placeholdersurface.tsx
git commit -m "feat(cockpit): add PlaceholderSurface for unbuilt surfaces"
```

---

### Task 5: `CockpitShell` + mount it in `CockpitBody`

Introduce the shell (NavRail + router) and wire `CockpitBody` to render it. At this point the **Cockpit** surface still renders the *existing* `AgentsView` body unchanged (Task 7 splits it out), so this task proves the rail + routing + interim Agent + placeholders without touching cockpit internals.

**Files:**
- Create: `frontend/app/view/agents/cockpitshell.tsx`
- Modify: `frontend/app/cockpit/cockpit-root.tsx` (`CockpitBody`, lines 55–91)

- [ ] **Step 1: Write `CockpitShell`**

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { useAtomValue } from "jotai";
import { AgentsViewModel, BUILT_SURFACES } from "./agents";
import { NavRail } from "./navrail";
import { PlaceholderSurface } from "./placeholdersurface";

export function CockpitShell({ model, tabId }: { model: AgentsViewModel; tabId: string }) {
    const surface = useAtomValue(model.surfaceAtom);
    return (
        <div className="flex h-full w-full">
            <NavRail model={model} />
            <div className="relative min-w-0 flex-1">
                {BUILT_SURFACES.has(surface) ? (
                    <model.SurfaceComponent surface={surface} model={model} tabId={tabId} />
                ) : (
                    <PlaceholderSurface surface={surface} />
                )}
            </div>
        </div>
    );
}
```

> `model.SurfaceComponent` (added below) renders the Cockpit surface or — for `surface === "agent"` — the interim `FocusView`. Keeping the built-surface render behind one model accessor lets Task 7 swap the Cockpit body in without touching the shell.

- [ ] **Step 2: Add `SurfaceComponent` to `AgentsViewModel`**

In `agents.tsx`, add this method to the class (it returns the current `AgentsView` for now; Task 7 changes the cockpit branch):

```ts
    SurfaceComponent = ({ surface, model }: { surface: SurfaceKey; model: AgentsViewModel; tabId: string }) => {
        if (surface === "agent") {
            return <FocusViewInterim model={model} />;
        }
        return <AgentsView model={model} />;
    };
```

Add the interim Agent adapter near the bottom of `agents.tsx`. It renders the existing `FocusView` for `focusIdAtom`, and falls back to the cockpit when nothing is focused. For Task 5, stub the handlers minimally so the app compiles and the rail is testable; **Task 7 fills in the real prop wiring** moved from the old focus branch (agents.tsx lines 454–477):

```tsx
function FocusViewInterim({ model }: { model: AgentsViewModel }) {
    const now = useAtomValue(model.nowAtom);
    const focusId = useAtomValue(model.focusIdAtom);
    const agents = useAtomValue(model.agentsAtom);
    const agent = focusId != null ? agents.find((a) => a.id === focusId) : undefined;
    if (!agent) {
        return <AgentsView model={model} />;
    }
    // FocusView is the existing single-agent transcript+composer; 1b replaces this with the 3-pane.
    return (
        <FocusView
            agent={agent}
            now={now}
            autofocusComposer={false}
            hasPrev={false}
            hasNext={false}
            selections={{}}
            sent={false}
            activeQuestion={0}
            onBack={() => globalStore.set(model.surfaceAtom, "cockpit")}
            onPrev={() => {}}
            onNext={() => {}}
            onOpenTerminal={() => model.openTerminal(agent.id)}
            onToggleAnswer={() => {}}
            onSubmitAnswer={() => {}}
            onSelectQuestion={() => {}}
        />
    );
}
```

Add imports at top of `agents.tsx` if missing: `useAtomValue` (present), `globalStore` (present), `FocusView` (present).

- [ ] **Step 3: Rewire `CockpitBody`**

Replace the `CockpitBody` return (cockpit-root.tsx lines 76–90) so it renders the shell. Keep the model construction (lines 56–70) and the `+ New Agent` toolbar:

```tsx
    return (
        <div className="cockpit-main">
            <div className="cockpit-roster-toolbar">
                <button className="cockpit-new-agent" onClick={() => fireAndForget(() => newAgentSession(model))}>
                    + New Agent
                </button>
            </div>
            <CockpitShell model={model} tabId={tabIdRef.current} />
        </div>
    );
```

Remove the now-unused pieces from `CockpitBody`: the `agentsContentRef`/`agentsBlockRef` refs, the `activeTabTermBlockAtom` usage, `targetBlockId`/`focusBlockId`, the `CockpitFocusPane` import/render, and the inline `AgentsVC` render. Add `import { CockpitShell } from "@/app/view/agents/cockpitshell";`.

> The terminal pane (`CockpitFocusPane`) is no longer mounted by `CockpitBody`; in 1a the interim Agent surface owns terminal opening (Task 7 wires `openTerminal` → Agent surface). `CockpitFocusPane` and `focus-pane.tsx` stay in the tree for 1b reuse.

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: tsc clean.

- [ ] **Step 5: CDP verify**

Run `task dev`; via CDP on :9222 confirm: the NavRail renders 8 items; clicking Cockpit shows the existing agents view; clicking Activity/Channels/Sessions/Files/Memory/Usage shows "Coming soon"; the `+ New Agent` button still works.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/view/agents/cockpitshell.tsx frontend/app/view/agents/agents.tsx frontend/app/cockpit/cockpit-root.tsx
git commit -m "feat(cockpit): mount NavRail + surface router shell"
```

---

### Task 6: Lift `AgentsView` orchestration state onto the model atoms

Refactor `AgentsView` so its `useState`s become reads/writes of the Task-2 atoms (via `useAtomValue` + `globalStore.set`), and route the answer-toggle through `toggleSelection`. **No visual change** — the vertical list, header, footer, and effects stay; only the state home moves. This isolates the (risky) state-lift from the (separate) layout change in Task 8.

**Files:**
- Modify: `frontend/app/view/agents/agents.tsx` (`AgentsView`, lines 163–604)

- [ ] **Step 1: Replace the `useState` declarations with atom reads**

In `AgentsView`, replace these locals (lines 185–258) with atom-backed equivalents. Pattern: read with `useAtomValue(model.xAtom)`; write with `globalStore.set(model.xAtom, next)`. Example for `cursorId`:

```tsx
    const cursorId = useAtomValue(model.cursorIdAtom);
    const setCursorId = (v: string | undefined | ((p: string | undefined) => string | undefined)) =>
        globalStore.set(model.cursorIdAtom, typeof v === "function" ? v(globalStore.get(model.cursorIdAtom)) : v);
```

Apply the same shape for: `order`/`setOrder` → `orderAtom`; `backgroundedIds` → `backgroundedIdsAtom`; `dismissed` → `dismissedAtom`; `answerSel` → `answerSelAtom`; `answerTab` → `answerTabAtom`; `sentIds` → `sentIdsAtom`; `focusId` → `focusIdAtom`; `focusReply` → `focusReplyAtom`; `now` → `nowAtom`. Keep `showHelp` and `pulseId` as local `useState` (ephemeral, surface-only — spec §4).

> Add a tiny local helper to cut boilerplate (place above `AgentsView`):
> ```tsx
> function useModelAtom<T>(model: AgentsViewModel, a: PrimitiveAtom<T>): [T, (v: T | ((p: T) => T)) => void] {
>     const value = useAtomValue(a);
>     const set = (v: T | ((p: T) => T)) =>
>         globalStore.set(a, typeof v === "function" ? (v as (p: T) => T)(globalStore.get(a)) : v);
>     return [value, set];
> }
> ```
> Then: `const [cursorId, setCursorId] = useModelAtom(model, model.cursorIdAtom);` etc. This keeps the existing call sites (`setCursorId(...)`) working unchanged.

- [ ] **Step 2: Drop `maxPanels` state**

Remove `const [maxPanels, setMaxPanels] = useState<MaxPanels>("auto");` and the `MaxPanelsControl` render in the header (lines 506). Replace the expansion calc (lines 263–265) with: asks always expanded, everything else expanded too (the grid in Task 8 makes this moot, but for Task 6 keep the list visually identical by expanding all):

```tsx
    const expandedSet = new Set<string>(orderedIds);
```

Leave `expandedWorkingIds`/`MaxPanels` imports until Task 8's cleanup (they're now unused — note for the cleanup task).

- [ ] **Step 3: Route the 1s tick through `nowAtom`**

Replace the `now` tick effect (lines 177–181) to write the atom:

```tsx
    useEffect(() => {
        const t = setInterval(() => globalStore.set(model.nowAtom, Date.now()), 1000);
        return () => clearInterval(t);
    }, []);
```

(`now` is now read via `useModelAtom`/`useAtomValue(model.nowAtom)`.)

- [ ] **Step 4: Route `toggleAnswer` through the pure helper**

Replace the body of `toggleAnswer` (lines 305–321) to use `toggleSelection`:

```tsx
    const toggleAnswer = (id: string, qi: number, oi: number) => {
        const a = agents.find((x) => x.id === id);
        const multi = a?.ask?.questions?.[qi]?.multiSelect ?? false;
        setAnswerSel((prev) => ({ ...prev, [id]: toggleSelection(prev[id] ?? {}, qi, oi, multi) }));
    };
```

Add `toggleSelection` to the import from `./agentsviewmodel`.

- [ ] **Step 5: Typecheck + tests**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → tsc clean.
Run: `npx vitest run` → green (pure-logic suite unaffected).

- [ ] **Step 6: CDP verify (no regression)**

`task dev` + CDP: the agents list behaves exactly as before this task — cursor moves, answers select (1–9), submit works, background/idle sections work, the plan strip shows. (The `panels` control is gone; everything expands — acceptable interim.)

- [ ] **Step 7: Commit**

```bash
git add frontend/app/view/agents/agents.tsx
git commit -m "refactor(cockpit): lift AgentsView orchestration state onto model atoms"
```

---

### Task 7: Split the Cockpit body into `CockpitSurface`; move the interim Agent wiring

Extract `AgentsView`'s **non-focus** render (header + plan strip + list + backgrounded/idle + footer + all the effects/handlers) into a new `CockpitSurface` component, and move the existing **focus** branch (lines 454–477) into `FocusViewInterim` (Task 5's adapter), wiring its props from the model atoms. After this task `AgentsView` is gone; `model.SurfaceComponent` renders `CockpitSurface` for `"cockpit"`.

**Files:**
- Create: `frontend/app/view/agents/cockpitsurface.tsx`
- Modify: `frontend/app/view/agents/agents.tsx` (remove `AgentsView`; keep the class + `SurfaceComponent`; finalize `FocusViewInterim`)

- [ ] **Step 1: Create `CockpitSurface`**

Move the entire body of the current `AgentsView` *except* the `if (focusAgent) {…}` focus branch into `cockpitsurface.tsx` as `export function CockpitSurface({ model }: { model: AgentsViewModel })`. This includes: the `groupAgents`/`providerPlanUsage` derivations, all the lifted-atom reads (via `useModelAtom`), every `useEffect` (tick, `ensurePreviousInfo`, transcript streams, order merge, cursor validity, asking-overrides-backgrounded), the handlers (`answer`, `toggleAnswer`, `submitAnswer`, `selectQuestion`, `toggleBackground`, `openFocus`, `scrollToPulse`, `focusRowComposer`, `onKeyDown`), and the non-focus JSX return (lines 479–602). Move the module-scope helpers it depends on (`useModelAtom`, `RollingCount`, `MiniGauge`, `ProviderPlan`, `HINTS`, `HelpOverlay`, the `PLAN_BAR`/`PLAN_TXT`/`PROVIDER_DOT` consts) into `cockpitsurface.tsx` too. Delete `MaxPanelsControl` and `MAX_PANEL_OPTIONS` entirely. `FocusViewInterim` and the `AgentsViewModel` class stay in `agents.tsx`.

`openFocus` now switches surfaces instead of setting a local branch:

```tsx
    const openFocus = (id: string, reply: boolean) => {
        globalStore.set(model.focusIdAtom, id);
        globalStore.set(model.focusReplyAtom, reply);
        globalStore.set(model.surfaceAtom, "agent");
    };
```

- [ ] **Step 2: Finalize `FocusViewInterim`**

Replace Task 5's stub `FocusViewInterim` with the real wiring moved from the old focus branch — supply `FocusView` its props from atoms (`answerSelAtom`, `sentIdsAtom`, `answerTabAtom`, `nowAtom`) and reuse the same handlers. Because the prev/next + answer handlers are now shared with `CockpitSurface`, factor the shared handler set into small functions or duplicate the few needed here (prev/next call `focusStep`, which sets `focusIdAtom` via `moveCursor` over the ordered ids). Concretely:

```tsx
function FocusViewInterim({ model }: { model: AgentsViewModel }) {
    const now = useAtomValue(model.nowAtom);
    const focusId = useAtomValue(model.focusIdAtom);
    const focusReply = useAtomValue(model.focusReplyAtom);
    const agents = useAtomValue(model.agentsAtom);
    const order = useAtomValue(model.orderAtom);
    const answerSel = useAtomValue(model.answerSelAtom);
    const answerTab = useAtomValue(model.answerTabAtom);
    const sentIds = useAtomValue(model.sentIdsAtom);
    const agent = focusId != null ? agents.find((a) => a.id === focusId) : undefined;
    if (!agent) {
        globalStore.set(model.surfaceAtom, "cockpit");
        return null;
    }
    const i = order.indexOf(agent.id);
    const step = (delta: number) => {
        globalStore.set(model.focusIdAtom, moveCursor(order, agent.id, delta) ?? agent.id);
        globalStore.set(model.focusReplyAtom, false);
    };
    return (
        <FocusView
            agent={agent}
            now={now}
            autofocusComposer={focusReply}
            hasPrev={i > 0}
            hasNext={i >= 0 && i < order.length - 1}
            selections={answerSel[agent.id] ?? {}}
            sent={sentIds.has(agent.id)}
            activeQuestion={answerTab[agent.id] ?? 0}
            onBack={() => globalStore.set(model.surfaceAtom, "cockpit")}
            onPrev={() => step(-1)}
            onNext={() => step(1)}
            onOpenTerminal={() => model.openTerminal(agent.id)}
            onToggleAnswer={(qi, oi) => {
                const multi = agent.ask?.questions?.[qi]?.multiSelect ?? false;
                globalStore.set(model.answerSelAtom, {
                    ...answerSel,
                    [agent.id]: toggleSelection(answerSel[agent.id] ?? {}, qi, oi, multi),
                });
            }}
            onSubmitAnswer={() => model.submitAnswer(agent.id)}
            onSelectQuestion={(qi) => globalStore.set(model.answerTabAtom, { ...answerTab, [agent.id]: qi })}
        />
    );
}
```

- [ ] **Step 3: Add `submitAnswer` to the model (shared by both surfaces)**

So the focus adapter and the cockpit share submit logic, add to `AgentsViewModel`:

```ts
    submitAnswer(agentId: string) {
        const agent = globalStore.get(this.agentsAtom).find((a) => a.id === agentId);
        const sent = globalStore.get(this.sentIdsAtom);
        if (!agent || sent.has(agentId)) {
            return;
        }
        const qs = agent.ask?.questions ?? [];
        const sel = globalStore.get(this.answerSelAtom)[agentId] ?? {};
        if (!canSubmitAsk(qs, sel) || !agent.ask?.oref) {
            return;
        }
        fireAndForget(() =>
            RpcApi.AnswerAgentCommand(TabRpcClient, { oref: agent.ask.oref, answers: buildAskAnswers(qs, sel) })
        );
        globalStore.set(this.sentIdsAtom, new Set(sent).add(agentId));
    }
```

Update `CockpitSurface`'s `submitAnswer` handler to call `model.submitAnswer(id)`. Add imports to `agents.tsx`: `canSubmitAsk`, `buildAskAnswers`, `RpcApi`, `TabRpcClient`, `fireAndForget` (some already imported).

- [ ] **Step 4: Update `SurfaceComponent`**

```ts
    SurfaceComponent = ({ surface, model }: { surface: SurfaceKey; model: AgentsViewModel; tabId: string }) => {
        if (surface === "agent") {
            return <FocusViewInterim model={model} />;
        }
        return <CockpitSurface model={model} />;
    };
```

Remove the now-dead `AgentsView` function and its unused imports from `agents.tsx`. Add `import { CockpitSurface } from "./cockpitsurface";`.

- [ ] **Step 5: Typecheck + tests**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → tsc clean.
Run: `npx vitest run` → green.

- [ ] **Step 6: CDP verify**

`task dev` + CDP: Cockpit surface renders as before; pressing `↵`/double-click on an agent switches to the **Agent** nav surface showing that agent's `FocusView`; `esc`/Back returns to Cockpit; `t` opens the terminal from the focus view.

- [ ] **Step 7: Commit**

```bash
git add frontend/app/view/agents/cockpitsurface.tsx frontend/app/view/agents/agents.tsx
git commit -m "refactor(cockpit): split CockpitSurface from AgentsView; surface-routed focus"
```

---

### Task 8: Rebuild the live region as a 2-col card grid with always-on feeds

Replace the vertical `Reorder.Group` list of full-width rows with a 2-col grid of cards that always show their feed and answer-in-place footer. Restyle `AgentRow` into a card. Drag-reorder stays (motion `Reorder`); widen/resize are deferred.

**Files:**
- Modify: `frontend/app/view/agents/agentrow.tsx`
- Modify: `frontend/app/view/agents/cockpitsurface.tsx` (the live region container)
- Modify: `frontend/app/view/agents/agentsviewmodel.ts` (remove `expandedWorkingIds`/`MaxPanels` + their tests)

- [ ] **Step 1: Convert the live container to a grid**

In `cockpitsurface.tsx`, change the `Reorder.Group` className from the vertical flex to a 2-col grid and drop the `expandedSet`/`fill` props threaded to `AgentRow`:

```tsx
                <Reorder.Group
                    as="div"
                    axis="y"
                    values={orderedIds}
                    onReorder={setOrder}
                    className="grid min-h-0 flex-1 auto-rows-min grid-cols-2 gap-3.5 overflow-y-auto p-5"
                >
```

Render each `AgentRow` without `expanded`/`fill`:

```tsx
                        <AgentRow
                            key={a.id}
                            agent={a}
                            now={now}
                            isCursor={cursorId === a.id}
                            pulse={pulseId === a.id}
                            selections={answerSel[a.id] ?? {}}
                            sent={sentIds.has(a.id)}
                            activeQuestion={answerTab[a.id] ?? 0}
                            onCursor={() => setCursorId(a.id)}
                            onOpen={() => openFocus(a.id, false)}
                            onOpenTerminal={() => model.openTerminal(a.id)}
                            onToggleAnswer={(qi, oi) => toggleAnswer(a.id, qi, oi)}
                            onSubmitAnswer={() => submitAnswer(a.id)}
                            onSelectQuestion={(qi) => selectQuestion(a.id, qi)}
                            onComposerEscape={() => containerRef.current?.focus()}
                            onBackground={a.state === "working" ? () => toggleBackground(a.id) : undefined}
                            onDismiss={a.state === "idle" ? () => setDismissed((prev) => new Set(prev).add(dismissKey(a))) : undefined}
                        />
```

- [ ] **Step 2: Restyle `AgentRow` into a card**

In `agentrow.tsx`: remove the `expanded` and `fill` props (and `MinExpandedRowPx`). The card always renders its feed and (for asks) the answer footer. Change the root `Reorder.Item` to a bordered rounded card and make the feed always-on:

- Root className becomes a card: `"group relative flex flex-col rounded-[13px] border bg-panel overflow-hidden"` plus the cursor/asking/pulse ring modifiers (keep the existing `bg-warning/*`, `shadow-[inset_3px_0_0_...]`, `ring-2 ring-warning` treatments). Remove the `style={{ flex … }}` line.
- The feed block (current lines 180–190): drop the `expanded &&` guard so it always renders when `entries.length > 0`; give it a fixed-ish height so cards stay uniform: `className="mt-2 ml-[26px] max-h-56 min-h-[64px] overflow-y-auto"`.
- The answer block (lines 192–204): drop the `expanded &&` guard — render whenever `asking && hasQuestions`.
- The composer block (lines 206–229): drop `expanded &&`; keep `isCursor && !hasQuestions` so the free-text reply shows on the focused card (the always-on per-card composer is a fast-follow; cursor-gating it now keeps the grid calm).

- [ ] **Step 3: Remove `expandedWorkingIds`/`MaxPanels` from the model + tests**

Delete `expandedWorkingIds`, `MaxPanels`, and `MaxPanels`-related code from `agentsviewmodel.ts`. Remove their tests from `agentsviewmodel.test.ts` (the `describe("expandedWorkingIds", …)` block and the `MaxPanels`/`expandedWorkingIds` names from the import line). Remove the now-dead `expandedSet` calc and `expandedWorkingIds` import from `cockpitsurface.tsx`.

- [ ] **Step 4: Typecheck + tests**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → tsc clean.
Run: `npx vitest run` → green (fewer tests; no failures).

- [ ] **Step 5: CDP verify**

`task dev` + CDP: live agents render as a 2-col grid; **every** card shows its narration feed (not just the cursor card); an asking card shows its question + answer options inline and `1–9`/Send work in place; idle + backgrounded sections render below; drag-to-reorder still works.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/view/agents/agentrow.tsx frontend/app/view/agents/cockpitsurface.tsx frontend/app/view/agents/agentsviewmodel.ts frontend/app/view/agents/agentsviewmodel.test.ts
git commit -m "feat(cockpit): 2-col live grid with always-on card feeds; drop maxPanels"
```

---

### Task 9: Relocate Usage into a collapsible right rail

Move the top plan-strip into a collapsible right rail beside the live region (handoff `isCockpit` layout). Add a `railOpenAtom`.

**Files:**
- Modify: `frontend/app/view/agents/agents.tsx` (add `railOpenAtom = atom(true)` to the model)
- Modify: `frontend/app/view/agents/cockpitsurface.tsx`

- [ ] **Step 1: Add the rail-open atom**

In `AgentsViewModel`: `railOpenAtom = atom(true);`

- [ ] **Step 2: Wrap the main region + rail**

In `cockpitsurface.tsx`, wrap the scrollable main column and a new rail in a flex row. Remove the old full-width plan strip (lines 514–524) and render the `ProviderPlan` gauges in the rail instead:

```tsx
    const railOpen = useAtomValue(model.railOpenAtom);
    // …inside the return, replace the single main column with:
    <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 flex-1 flex-col">{/* header + chips + grid + idle/bg + footer */}</div>
        {railOpen ? (
            <aside className="flex w-[300px] shrink-0 flex-col gap-6 overflow-y-auto border-l border-border bg-surface px-5 py-5">
                <div>
                    <div className="mb-3.5 flex items-center justify-between">
                        <h3 className="font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">Usage</h3>
                        <button
                            type="button"
                            onClick={() => globalStore.set(model.surfaceAtom, "usage")}
                            className="cursor-pointer border-0 bg-transparent text-[11.5px] text-accent"
                        >
                            Details →
                        </button>
                    </div>
                    <div className="flex flex-col gap-4">
                        {planByProvider.map(({ provider, usage }) => (
                            <ProviderPlan key={provider} provider={provider} usage={usage} now={now} />
                        ))}
                    </div>
                </div>
            </aside>
        ) : null}
    </div>
```

> `ProviderPlan`/`MiniGauge` are reused as-is (they were moved into `cockpitsurface.tsx` in Task 7). Recent-activity is deferred (P2) — omit it.

- [ ] **Step 3: Add a Hide/Show panel toggle in the header**

In the Cockpit header actions, add: `<button onClick={() => globalStore.set(model.railOpenAtom, !railOpen)} …>{railOpen ? "Hide panel ›" : "‹ Usage"}</button>` styled with the existing `border-border`/`text-muted` button classes.

- [ ] **Step 4: Typecheck + verify**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → tsc clean.
`task dev` + CDP: the Usage gauges render in a right rail; Hide panel collapses it; "Details →" routes to the Usage placeholder.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/agents.tsx frontend/app/view/agents/cockpitsurface.tsx
git commit -m "feat(cockpit): relocate usage into collapsible right rail"
```

---

### Task 10: Cockpit header — status chips + summary

Add the `All / Asking / Working / Idle` chips and the `N agents · N need you` summary. Chips filter the grid. Project-filter / Live-only are deferred to the ergonomics fast-follow (see Out of scope).

**Files:**
- Modify: `frontend/app/view/agents/agents.tsx` (add `chipFilterAtom`)
- Modify: `frontend/app/view/agents/cockpitsurface.tsx`

- [ ] **Step 1: Add the chip-filter atom + type**

In `agents.tsx`: `export type ChipFilter = "all" | "asking" | "working" | "idle";` and `chipFilterAtom = atom<ChipFilter>("all");`

- [ ] **Step 2: Render the header + chips and apply the filter**

In `cockpitsurface.tsx`, replace the current header (lines 486–512) with the title + summary + a chips row:

```tsx
    const chip = useAtomValue(model.chipFilterAtom);
    const setChip = (c: ChipFilter) => globalStore.set(model.chipFilterAtom, c);
    // …header:
    <div className="sticky top-0 z-[5] border-b border-border bg-background px-[30px] pb-3 pt-4">
        <div className="mb-3 flex items-baseline gap-3">
            <h1 className="text-[20px] font-bold tracking-[-0.02em] text-primary">Cockpit</h1>
            <p className="text-[12.5px] text-muted">
                {agents.length} agents · <span className="font-semibold text-warning">{asking.length} need you</span>
            </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
            {([["all", "All", agents.length], ["asking", "Asking", asking.length], ["working", "Working", working.length], ["idle", "Idle", idle.length]] as [ChipFilter, string, number][]).map(
                ([key, label, count]) => (
                    <button
                        key={key}
                        type="button"
                        onClick={() => setChip(key)}
                        className={cn(
                            "flex cursor-pointer items-center gap-2 rounded-[8px] border px-3 py-1.5 text-[12.5px]",
                            chip === key ? "border-edge-strong bg-surface-raised text-primary" : "border-border text-muted hover:border-edge-mid"
                        )}
                    >
                        {label}
                        <span className="font-mono text-[11px] font-semibold">{count}</span>
                    </button>
                )
            )}
        </div>
    </div>
```

Apply the filter to the live grid source. Where `orderedAgents` is mapped to cards, filter by chip first:

```tsx
    const shownAgents = chip === "all" ? orderedAgents : orderedAgents.filter((a) => a.state === chip);
```

…and map `shownAgents` instead of `orderedAgents` in the grid. (Cursor/order logic still operates over the full `orderedIds`; filtering only narrows what renders.)

- [ ] **Step 3: Typecheck + verify**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → tsc clean.
`task dev` + CDP: header shows the title + `N agents · N need you`; chips filter the grid (Asking shows only asking cards, etc.); counts update live.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/view/agents/agents.tsx frontend/app/view/agents/cockpitsurface.tsx
git commit -m "feat(cockpit): header summary + status-chip filter"
```

---

### Task 11: Surface-switch keybindings + footer hints + final verify

Add keyboard surface switching and reconcile the triage-bar hints, then run the full verification pass.

**Files:**
- Modify: `frontend/app/view/agents/cockpitsurface.tsx` (the `onKeyDown` handler + `HINTS`)

- [ ] **Step 1: Add surface-switch keys to `onKeyDown`**

In `CockpitSurface`'s `onKeyDown`, before the cursor-move branches, add a guarded switch (only when not typing — the existing `INPUT`/`TEXTAREA` guard already returns early). Map `g` then a surface key, or simpler: bracket keys to cycle. Use explicit keys that don't collide with existing ones (`1–9`, `j/k/h/l/n/r/t/b` are taken). Add:

```tsx
        // Surface switch: `[` previous surface, `]` next surface (rail order).
        // Direct number-to-surface jumps are intentionally omitted — 1–9 are the answer keys.
        if (e.key === "]" || e.key === "[") {
            e.preventDefault();
            const order: SurfaceKey[] = ["cockpit", "agent", "activity", "channels", "sessions", "files", "memory", "usage"];
            const cur = globalStore.get(model.surfaceAtom);
            const i = order.indexOf(cur);
            const next = order[(i + (e.key === "]" ? 1 : order.length - 1)) % order.length];
            globalStore.set(model.surfaceAtom, next);
            return;
        }
```

> Keep it minimal: `[`/`]` cycle surfaces. Direct number-to-surface jumps would collide with the `1–9` answer keys, so they're intentionally omitted.

- [ ] **Step 2: Reconcile the footer hints**

Update the `HINTS` array to the handoff triage bar (drop the `panels` notion; `b` and `m` both background-mute — keep `b`):

```tsx
const HINTS: [string, string][] = [
    ["↑↓ / j k", "move"],
    ["⏎", "open"],
    ["esc", "back"],
    ["1–9", "answer"],
    ["r", "reply"],
    ["t", "terminal"],
    ["b", "background"],
    ["n", "next ask"],
    ["[ ]", "switch surface"],
];
```

- [ ] **Step 3: Full typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: tsc clean (3 baseline errors only).

- [ ] **Step 4: Full unit suite**

Run: `npx vitest run`
Expected: green; `agentsviewmodel.test.ts` includes the new `toggleSelection` tests and no longer references `expandedWorkingIds`/`MaxPanels`.

- [ ] **Step 5: Dead-code sweep**

Grep for stragglers and remove any unused imports/exports flagged by tsc: `MaxPanelsControl`, `expandedWorkingIds`, `MaxPanels`, `MAX_PANEL_OPTIONS`, and the old `AgentsVC`/`CockpitFocusPane` wiring in `cockpit-root.tsx`.

Run: `grep -rn "MaxPanels\|expandedWorkingIds\|AgentsView\b" frontend/app/view/agents frontend/app/cockpit`
Expected: no live references (only `AgentSurfaceInterim`/`CockpitSurface`/`FocusViewInterim` remain).

- [ ] **Step 6: CDP acceptance pass**

`task dev` + CDP on :9222, confirm the spec's verification list:
- NavRail switches surfaces; `[`/`]` cycle them; unbuilt → "Coming soon".
- Cockpit: 2-col grid, every card shows its feed; asking card answers in place (chips/`1–9`/Send); idle + backgrounded sections; collapsible Usage rail; header summary + chip filter; triage footer.
- `↵`/double-click opens the Agent surface (interim `FocusView`); `esc` returns; `t` opens terminal.
- No console errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/app/view/agents/cockpitsurface.tsx
git commit -m "feat(cockpit): surface-switch keybindings + triage hint bar"
```

---

## Self-review notes (coverage map)

- Spec §3 shell (NavRail + router + state lift) → Tasks 2–7.
- Spec §4 state lift (atoms + effects-in-components) → Tasks 2, 6, 7.
- Spec §5 Cockpit surface (header/chips, grid+feeds, answer-in-place, idle/backgrounded, keyboard, usage rail) → Tasks 6–11.
- Spec §6 routing (Cockpit built, Agent interim, Usage→placeholder, rest→placeholder) → Tasks 4, 5, 7, 9.
- Spec §1 dropped `maxPanels` → Task 8. Deferred widen/resize/project-filter/Live-only → Out of scope below.
- Spec §8 verification → per-task tsc/vitest/CDP + Task 11.

## Out of scope (fast-follow after 1a; not this plan)

- Per-card **widen** (1↔2-col) and **resize** handles.
- Project-filter dropdown + **Live-only** toggle (header).
- NavRail per-item **glyphs**, the **Recent activity** rail peek (P2/Activity), always-on per-card composer.
- The **Agent 3-pane** surface → Phase **1b**.
