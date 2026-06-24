# Agents Tab Auto-Fit (One Screen) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Agents tab auto-fit the live agent count onto one screen — asks render full (spotlight), working rows flex-share the leftover under a max-panels cap, and a manual "background" control + region divider give explicit density control.

**Architecture:** Pure view-model helpers decide *which* asks/working rows expand vs collapse; the layout is restructured into pinned regions (asks → divider → working scroller → backgrounded lane → idle lane) where flexbox (`flex:1 1 0`) distributes height among expanded working rows — no pixel measurement. `AgentRow` gains `expanded`/`fill` props (and a background button); a new `BackgroundedSection` mirrors `IdleSection`. All state is session-only.

**Tech Stack:** TypeScript, React 19, Jotai, motion/react (Reorder/AnimatePresence), Tailwind v4, Vitest. Frontend only — no Go/RPC/projection changes.

> **Repo git note:** this repo's owner requires **explicit approval before any commit** (see CLAUDE.md). Treat each `Commit` step as a checkpoint: show the diff + the suggested message and ask before committing, or batch per the owner's direction. `docs/superpowers/` is gitignored, so this plan and its spec are local-only and are never part of a commit.

**Run tests from the project root** (never `cd` into the package — see CLAUDE.md):
`npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts`

---

## File Structure

- **`frontend/app/view/agents/agentsviewmodel.ts`** (modify) — add three pure helpers: `partitionBackgrounded`, `expandedWorkingIds`, `focusedAskId`, plus the `MaxPanels` type. Single source of truth for the expand/collapse/partition decisions.
- **`frontend/app/view/agents/agentsviewmodel.test.ts`** (modify) — unit tests for the three helpers.
- **`frontend/app/view/agents/agentrow.tsx`** (modify) — add `expanded` / `fill` / `onBackground` props; gate the body on `expanded`; make the root a flex column so `fill` rows share height; remove the per-row resize grip + its constants/state; add the background button.
- **`frontend/app/view/agents/backgroundedsection.tsx`** (create) — collapsed, expandable lane listing still-running muted agents; click re-surfaces (un-backgrounds). A light variant of `idlesection.tsx`.
- **`frontend/app/view/agents/agents.tsx`** (modify) — region layout, `backgroundedIds` / `maxPanels` / `dividerRatio` state, partition + expand wiring, spotlight asks, max-panels control, `b` key, asking-overrides-backgrounded effect, the region divider.

---

## Phase 1 — Pure helpers (TDD)

### Task 1: `partitionBackgrounded`

**Files:**
- Modify: `frontend/app/view/agents/agentsviewmodel.ts`
- Test: `frontend/app/view/agents/agentsviewmodel.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `agentsviewmodel.test.ts` (the `mk` helper already exists at the top of the file). Also add `partitionBackgrounded` to the existing import from `./agentsviewmodel`.

```ts
describe("partitionBackgrounded", () => {
    it("splits working agents by the backgrounded id set, preserving order", () => {
        const working = [mk("a", "working"), mk("b", "working"), mk("c", "working")];
        const out = partitionBackgrounded(working, new Set(["b"]));
        expect(out.active.map((x) => x.id)).toEqual(["a", "c"]);
        expect(out.backgrounded.map((x) => x.id)).toEqual(["b"]);
    });
    it("returns all active when the set is empty", () => {
        const working = [mk("a", "working"), mk("b", "working")];
        const out = partitionBackgrounded(working, new Set());
        expect(out.active.map((x) => x.id)).toEqual(["a", "b"]);
        expect(out.backgrounded).toEqual([]);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts -t partitionBackgrounded`
Expected: FAIL — `partitionBackgrounded is not a function` / not exported.

- [ ] **Step 3: Implement the helper**

Add to `agentsviewmodel.ts` (near `mergeOrder`, in the pure-helpers area):

```ts
/** Pure: split working-state agents into the active set (rendered in the working region) and the
 *  backgrounded set (collapsed lane). An id in `backgroundedIds` goes to backgrounded; order within
 *  each is preserved. Asking agents are never passed here (they live in the asks region), so a
 *  backgrounded agent that starts asking naturally re-surfaces. */
export function partitionBackgrounded(
    working: AgentVM[],
    backgroundedIds: Set<string>
): { active: AgentVM[]; backgrounded: AgentVM[] } {
    const active: AgentVM[] = [];
    const backgrounded: AgentVM[] = [];
    for (const a of working) {
        (backgroundedIds.has(a.id) ? backgrounded : active).push(a);
    }
    return { active, backgrounded };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts -t partitionBackgrounded`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit** (per the repo git note above)

Suggested message: `feat(agents): partitionBackgrounded helper`

---

### Task 2: `expandedWorkingIds` + `MaxPanels` type

**Files:**
- Modify: `frontend/app/view/agents/agentsviewmodel.ts`
- Test: `frontend/app/view/agents/agentsviewmodel.test.ts`

- [ ] **Step 1: Write the failing test**

Add `expandedWorkingIds` to the import, then:

```ts
describe("expandedWorkingIds", () => {
    it("auto expands every row", () => {
        const ids = ["a", "b", "c"];
        expect([...expandedWorkingIds(ids, "a", "auto")]).toEqual(["a", "b", "c"]);
    });
    it("a numeric cap expands the first N by order", () => {
        const ids = ["a", "b", "c", "d"];
        expect([...expandedWorkingIds(ids, "a", 2)].sort()).toEqual(["a", "b"]);
    });
    it("forces the cursor row into the expanded set, dropping the last slot", () => {
        const ids = ["a", "b", "c", "d"];
        const out = expandedWorkingIds(ids, "d", 2);
        expect(out.has("d")).toBe(true);
        expect(out.has("a")).toBe(true);
        expect(out.has("b")).toBe(false);
        expect(out.size).toBe(2);
    });
    it("a cap >= length expands all", () => {
        const ids = ["a", "b"];
        expect([...expandedWorkingIds(ids, undefined, 5)]).toEqual(["a", "b"]);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts -t expandedWorkingIds`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement the helper and type**

Add to `agentsviewmodel.ts`:

```ts
export type MaxPanels = "auto" | number;

/** Pure: which working rows render expanded (narration) vs collapsed (header-only). "auto" expands
 *  every row — flexbox then shares the working region's height among them. A number N caps expansion
 *  to the first N by order, but the cursor row is always expanded (swapped into the last slot when it
 *  would otherwise fall outside the cap, so navigating never hides the row you're on). */
export function expandedWorkingIds(orderedActive: string[], cursorId: string | undefined, maxPanels: MaxPanels): Set<string> {
    if (maxPanels === "auto" || maxPanels >= orderedActive.length) {
        return new Set(orderedActive);
    }
    const cap = Math.max(1, maxPanels);
    const head = orderedActive.slice(0, cap);
    if (cursorId != null && orderedActive.includes(cursorId) && !head.includes(cursorId)) {
        head[head.length - 1] = cursorId;
    }
    return new Set(head);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts -t expandedWorkingIds`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit** — suggested: `feat(agents): expandedWorkingIds helper + MaxPanels type`

---

### Task 3: `focusedAskId`

**Files:**
- Modify: `frontend/app/view/agents/agentsviewmodel.ts`
- Test: `frontend/app/view/agents/agentsviewmodel.test.ts`

- [ ] **Step 1: Write the failing test**

Add `focusedAskId` to the import, then:

```ts
describe("focusedAskId", () => {
    it("is undefined when nothing is asking", () => {
        expect(focusedAskId([], "a")).toBeUndefined();
    });
    it("is the cursor when the cursor is on an ask", () => {
        expect(focusedAskId(["a", "b"], "b")).toBe("b");
    });
    it("falls back to the first ask when the cursor is not an ask", () => {
        expect(focusedAskId(["a", "b"], "z")).toBe("a");
        expect(focusedAskId(["a", "b"], undefined)).toBe("a");
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts -t focusedAskId`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement the helper**

```ts
/** Pure: the asking agent whose body is expanded in the spotlight. The cursor's ask wins when the
 *  cursor is on an ask; otherwise the first ask. Undefined when nothing is asking. */
export function focusedAskId(askingIds: string[], cursorId: string | undefined): string | undefined {
    if (askingIds.length === 0) {
        return undefined;
    }
    if (cursorId != null && askingIds.includes(cursorId)) {
        return cursorId;
    }
    return askingIds[0];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts -t focusedAskId`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full agents suite** — `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts` — Expected: all existing + new tests PASS.

- [ ] **Step 6: Commit** — suggested: `feat(agents): focusedAskId helper`

---

## Phase 2 — Backgrounded lane

### Task 4: `BackgroundedSection` component

**Files:**
- Create: `frontend/app/view/agents/backgroundedsection.tsx`

This mirrors `idlesection.tsx` but for *running* muted agents: a teal-ish dot, an age label, and clicking a row re-surfaces it (un-backgrounds) rather than opening a composer.

- [ ] **Step 1: Create the file**

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { formatAge, type AgentVM } from "./agentsviewmodel";

// Collapsed lane for still-running agents the user has muted with `b`. Distinct from Idle (finished):
// clicking a row un-backgrounds it (returns it to the working region) via onRestore.
export function BackgroundedSection({ agents, onRestore }: { agents: AgentVM[]; onRestore: (id: string) => void }) {
    const [open, setOpen] = useState(false);
    if (agents.length === 0) {
        return null;
    }
    return (
        <div className="shrink-0">
            <div
                className="flex cursor-pointer items-center gap-2 py-1.5 text-[11px] text-muted"
                onClick={() => setOpen((v) => !v)}
            >
                <span className="text-[9px]">{open ? "▾" : "▸"}</span>
                <span className="uppercase tracking-wide">Backgrounded</span>
                <span className="text-muted/60">· still running</span>
                <span className="ml-auto tabular-nums opacity-70">{agents.length}</span>
            </div>
            <AnimatePresence initial={false}>
                {open && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.18, ease: "easeOut" }}
                        className="flex flex-col gap-1 overflow-hidden"
                    >
                        {agents.map((a) => (
                            <div
                                key={a.id}
                                onClick={() => onRestore(a.id)}
                                title="Restore to working"
                                className="flex cursor-pointer items-center gap-2.5 rounded-[6px] px-2 py-1.5 hover:bg-white/[0.04]"
                            >
                                <span className="h-2 w-2 shrink-0 rounded-full bg-accent/50" />
                                <b className="shrink-0 text-[12px] text-secondary">{a.name}</b>
                                <span className="truncate text-[12px] text-muted">{a.task || a.activity || ""}</span>
                                <span className="ml-auto shrink-0 text-[10px] text-muted">{formatAge(a.activeMs)}</span>
                            </div>
                        ))}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
```

- [ ] **Step 2: Verify no type errors**

Confirm `backgroundedsection.tsx` shows no errors in the editor (VSCode Problems). It is not yet imported, so this is a standalone compile check.

- [ ] **Step 3: Commit** — suggested: `feat(agents): BackgroundedSection lane component`

---

## Phase 3 — AgentRow: expand/collapse + flex + background button

### Task 5: Rewrite `agentrow.tsx`

**Files:**
- Modify: `frontend/app/view/agents/agentrow.tsx`

Changes vs. current file:
- Add props `expanded: boolean`, `fill: boolean`, `onBackground?: () => void`.
- Make the root `Reorder.Item` a flex column; apply `flex:1 1 0` + a min height when `fill`, else `0 0 auto`.
- Gate the entire body (narration / answer bar / composer) behind `expanded`.
- For `fill` rows the narration area grows (`flex-1 min-h-0 overflow-y-auto`); for non-fill expanded rows (the spotlight ask) it renders at natural height.
- **Remove** the per-row resize grip block and the constants `RowNarrationMaxPx`, `RowNarrationMinPx`, `RowNarrationMaxFrac`, plus the `narrationMax` state and the `onResizeDown/Move/Up` handlers and `resizeRef`.
- Add a background button (only when `onBackground` is provided), placed left of the terminal button.

- [ ] **Step 1: Replace the file contents**

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { AnimatePresence, motion, Reorder, useDragControls } from "motion/react";
import { useEffect, useRef } from "react";
import { AgentComposer } from "./agentcomposer";
import { AnswerBar } from "./answerbar";
import { formatAge, hasAnswerableAsk, isQuiet, type AgentVM } from "./agentsviewmodel";
import { lastActivityByIdAtom, liveEntriesByIdAtom } from "./livetranscript";
import { NarrationTimeline } from "./narrationtimeline";
import { projectNameFromTranscriptPath } from "./projectname";
import { StatusDot } from "./statusdot";

const MinExpandedRowPx = 120; // a fill row never shrinks below this; past it the working region scrolls

export function AgentRow({
    agent,
    now,
    isCursor,
    expanded,
    fill,
    selections,
    sent,
    activeQuestion,
    onCursor,
    onOpen,
    onOpenTerminal,
    onToggleAnswer,
    onSubmitAnswer,
    onSelectQuestion,
    onComposerEscape,
    onBackground,
    onDismiss,
    pulse,
}: {
    agent: AgentVM;
    now: number;
    isCursor: boolean;
    expanded: boolean;
    fill: boolean;
    selections: Record<number, Set<number>>;
    sent: boolean;
    activeQuestion?: number;
    onCursor: () => void;
    onOpen: () => void;
    onOpenTerminal: () => void;
    onToggleAnswer: (qi: number, oi: number) => void;
    onSubmitAnswer: () => void;
    onSelectQuestion?: (qi: number) => void;
    onComposerEscape?: () => void;
    onBackground?: () => void;
    onDismiss?: () => void;
    pulse?: boolean;
}) {
    const controls = useDragControls();
    const liveEntries = useAtomValue(liveEntriesByIdAtom);
    const lastActivity = useAtomValue(lastActivityByIdAtom);
    const entries = liveEntries[agent.id] ?? agent.previousInfo ?? [];
    const quiet = isQuiet(lastActivity[agent.id], now);
    const project = projectNameFromTranscriptPath(agent.transcriptPath);
    const asking = agent.state === "asking";
    const idle = agent.state === "idle";
    const idleMs = agent.idleSince != null ? Math.max(0, now - agent.idleSince) : undefined;
    const hasQuestions = hasAnswerableAsk(agent);

    // in-row narration sticks to the latest line unless the user scrolls up to read history
    const scrollRef = useRef<HTMLDivElement>(null);
    const stickRef = useRef(true);
    useEffect(() => {
        const el = scrollRef.current;
        if (el && stickRef.current) {
            el.scrollTop = el.scrollHeight;
        }
    }, [entries, expanded]);
    const onNarrationScroll = () => {
        const el = scrollRef.current;
        if (!el) {
            return;
        }
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    };

    return (
        <Reorder.Item
            as="div"
            value={agent.id}
            dragListener={false}
            dragControls={controls}
            dragMomentum={false}
            dragTransition={{ bounceStiffness: 600, bounceDamping: 30 }}
            layout
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ layout: { type: "spring", stiffness: 650, damping: 32 }, opacity: { duration: 0.15 } }}
            data-agent-id={agent.id}
            onClick={onCursor}
            onDoubleClick={onOpen}
            style={{ flex: fill ? "1 1 0" : "0 0 auto", minHeight: fill ? MinExpandedRowPx : undefined }}
            className={cn(
                "group relative flex min-h-0 cursor-pointer flex-col border-b border-border px-[22px] py-3 transition-colors",
                asking ? "bg-warning/5" : "hover:bg-white/[0.02]",
                isCursor &&
                    (asking
                        ? "bg-warning/10 shadow-[inset_3px_0_0_var(--color-warning)]"
                        : "bg-accent/[0.06] shadow-[inset_3px_0_0_var(--color-accent)]"),
                pulse && "ring-2 ring-warning ring-inset"
            )}
        >
            <div className="flex shrink-0 items-center gap-2.5">
                <span
                    onPointerDown={(e) => controls.start(e)}
                    onClick={(e) => e.stopPropagation()}
                    title="Drag to reorder"
                    className="shrink-0 cursor-grab touch-none select-none text-[11px] text-muted opacity-0 transition-opacity group-hover:opacity-100 active:cursor-grabbing"
                >
                    ⠿
                </span>
                <StatusDot state={agent.state} quiet={quiet} />
                <b className={cn("shrink-0 text-primary", asking ? "text-[15px]" : "text-[14px]")}>{agent.name}</b>
                <span className="truncate text-[12px] text-muted">
                    {project ? `${project} · ` : ""}
                    {agent.task || agent.activity || ""}
                </span>
                {asking ? (
                    <span className="ml-auto shrink-0 rounded-[4px] border border-warning px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-warning">
                        needs you
                    </span>
                ) : (
                    <span className="ml-auto shrink-0 text-[12px] tabular-nums text-muted">
                        {agent.model ? `${agent.model} · ` : ""}
                        {idle ? `${formatAge(idleMs)} idle` : formatAge(agent.activeMs)}
                    </span>
                )}
                {onBackground ? (
                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            onBackground();
                        }}
                        title="Background (b) — collapse, keep running"
                        className="shrink-0 cursor-pointer rounded-[6px] border border-border p-1 text-secondary opacity-0 transition-opacity hover:bg-white/[0.04] group-hover:opacity-100"
                    >
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                            <path d="M3 8h10M3 11h10M3 5h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                        </svg>
                    </button>
                ) : null}
                {onDismiss ? (
                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            onDismiss();
                        }}
                        title="Move to Idle"
                        className="shrink-0 cursor-pointer rounded-[6px] border border-border p-1 text-secondary opacity-0 transition-opacity hover:bg-white/[0.04] group-hover:opacity-100"
                    >
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                            <path d="M8 3v8M4 8l4 4 4-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                    </button>
                ) : null}
                <button
                    type="button"
                    onClick={(e) => {
                        e.stopPropagation();
                        onOpenTerminal();
                    }}
                    title="Open terminal tab"
                    className="shrink-0 cursor-pointer rounded-[6px] border border-border px-2 py-0.5 text-[11px] text-secondary opacity-0 transition-opacity hover:bg-white/[0.04] group-hover:opacity-100"
                >
                    ↗ terminal
                </button>
            </div>

            {expanded && entries.length > 0 ? (
                <div
                    ref={scrollRef}
                    onScroll={onNarrationScroll}
                    className={cn("mt-2 ml-[26px] overflow-y-auto", fill && "min-h-0 flex-1")}
                >
                    <NarrationTimeline entries={entries} accentLatest active={agent.state === "working"} />
                </div>
            ) : expanded && agent.activity ? (
                <div className="mt-2 ml-[26px] whitespace-pre-wrap text-[13px] leading-[1.6] text-secondary">{agent.activity}</div>
            ) : null}

            {expanded && asking && hasQuestions ? (
                <AnswerBar
                    agent={agent}
                    selections={selections}
                    sent={sent}
                    numbered
                    activeQuestion={activeQuestion}
                    onToggle={onToggleAnswer}
                    onSubmit={onSubmitAnswer}
                    onSelectQuestion={onSelectQuestion}
                    className="mt-2 ml-[26px] shrink-0"
                />
            ) : null}

            <AnimatePresence>
                {expanded && isCursor && !hasQuestions ? (
                    <motion.div
                        key="composer"
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.18, ease: "easeOut" }}
                        style={{ overflow: "hidden" }}
                        className="shrink-0"
                        onClick={(e) => e.stopPropagation()}
                        onDoubleClick={(e) => e.stopPropagation()}
                    >
                        <div className="mt-2 ml-[26px]">
                            <AgentComposer
                                blockId={agent.blockId}
                                placeholder={`message ${agent.name}…`}
                                onEscape={onComposerEscape}
                                className="border-t-0 px-0 py-0"
                            />
                        </div>
                    </motion.div>
                ) : null}
            </AnimatePresence>
        </Reorder.Item>
    );
}
```

- [ ] **Step 2: Verify no type errors**

The editor will report `agents.tsx` errors (it doesn't yet pass `expanded`/`fill`) — that's expected and fixed in Task 6. `agentrow.tsx` itself must be error-free.

- [ ] **Step 3: Commit** — suggested: `refactor(agents): AgentRow expand/collapse + fill, drop per-row resize, add background button`

---

## Phase 4 — AgentsView wiring

### Task 6: State, partition, and the working region

**Files:**
- Modify: `frontend/app/view/agents/agents.tsx`

- [ ] **Step 1: Update imports**

Add the new helpers and component to the existing imports:

```ts
import {
    buildAskAnswers,
    canSubmitAsk,
    expandedWorkingIds,
    focusedAskId,
    formatReset,
    groupAgents,
    hasAnswerableAsk,
    isRecentlyIdle,
    mergeOrder,
    moveCursor,
    nextAskId,
    partitionBackgrounded,
    providerPlanUsage,
    usageLevel,
    type AgentVM,
    type MaxPanels,
} from "./agentsviewmodel";
```

```ts
import { BackgroundedSection } from "./backgroundedsection";
```

- [ ] **Step 2: Add session-only state**

Inside `AgentsView`, alongside the existing `useState` declarations (e.g. just after `const [dismissed, setDismissed] = useState...`):

```ts
const [backgroundedIds, setBackgroundedIds] = useState<Set<string>>(() => new Set());
const [maxPanels, setMaxPanels] = useState<MaxPanels>("auto");
const [dividerRatio, setDividerRatio] = useState<number>(undefined);
const regionsRef = useRef<HTMLDivElement>(null);
```

- [ ] **Step 3: Derive the active/backgrounded split and the working-region list**

Replace the current derivations:

```ts
const recentlyIdle = idle.filter((a) => isRecentlyIdle(a, now) && !dismissed.has(dismissKey(a)));
const recentIds = new Set(recentlyIdle.map((a) => a.id));
const parkedIdle = idle.filter((a) => !recentIds.has(a.id));
const listAgents = [...asking, ...working, ...recentlyIdle];
```

with:

```ts
const recentlyIdle = idle.filter((a) => isRecentlyIdle(a, now) && !dismissed.has(dismissKey(a)));
const recentIds = new Set(recentlyIdle.map((a) => a.id));
const parkedIdle = idle.filter((a) => !recentIds.has(a.id));
// the working region holds active working + just-finished (grace) rows, minus anything backgrounded
const { active: activeWorking, backgrounded } = partitionBackgrounded([...working, ...recentlyIdle], backgroundedIds);
```

- [ ] **Step 4: Reframe the anchored order over the working region only**

Replace the order block:

```ts
const [order, setOrder] = useState<string[]>([]);
useEffect(() => {
    const ids = listAgents.map((a) => a.id);
    setOrder((prev) => mergeOrder(prev, ids));
}, [listAgents.map((a) => a.id).join(",")]);
const orderedList = order.map((id) => listAgents.find((a) => a.id === id)).filter(Boolean) as AgentVM[];
const orderedIds = orderedList.map((a) => a.id);
```

with:

```ts
const [order, setOrder] = useState<string[]>([]);
useEffect(() => {
    const ids = activeWorking.map((a) => a.id);
    setOrder((prev) => mergeOrder(prev, ids));
}, [activeWorking.map((a) => a.id).join(",")]);
const orderedActive = order.map((id) => activeWorking.find((a) => a.id === id)).filter(Boolean) as AgentVM[];
const orderedActiveIds = orderedActive.map((a) => a.id);
// cursor traverses asks (spotlight order) then the working rows
const navigableIds = [...asking.map((a) => a.id), ...orderedActiveIds];
```

- [ ] **Step 5: Replace all remaining references to `orderedIds` / `orderedList`**

These are used by the cursor seed effect, `focusStep`, the key handler, and the focus-view block. Update them to the new names:
- cursor-seed effect dependency `orderedIds.join(",")` → `navigableIds.join(",")`; inside, `orderedIds` → `navigableIds`.
- `focusStep`: `moveCursor(orderedIds, ...)` → `moveCursor(navigableIds, ...)`.
- key handler `cur` lookup: `orderedList.find(...)` → search both groups: `const cur = asking.find((a) => a.id === cursorId) ?? orderedActive.find((a) => a.id === cursorId);`
- `ArrowDown/Up` and `n`: `moveCursor(orderedIds, ...)` → `moveCursor(navigableIds, ...)`.
- focus-view block: `orderedList.find((a) => a.id === focusId)` → `[...asking, ...orderedActive].find(...)`; `orderedIds.indexOf` / `orderedIds.length` → `navigableIds.indexOf` / `navigableIds.length`.

- [ ] **Step 6: Compute the expanded set**

After `navigableIds`:

```ts
const expandedSet = expandedWorkingIds(orderedActiveIds, cursorId, maxPanels);
const focusedAsk = focusedAskId(asking.map((a) => a.id), cursorId);
```

- [ ] **Step 7: Add the background toggle handler**

Near the other handlers (e.g. after `submitAnswer`):

```ts
const toggleBackground = (id: string) => {
    setBackgroundedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) {
            next.delete(id);
        } else {
            next.add(id);
        }
        return next;
    });
};
```

- [ ] **Step 8: Restructure the render body — working region**

This step rewrites the main list area. Replace the existing scroller block:

```tsx
<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
    <AnimatePresence>{empty && ( ... )}</AnimatePresence>
    <Reorder.Group as="div" axis="y" values={orderedIds} onReorder={setOrder}>
        <AnimatePresence mode="popLayout">
            {orderedList.map((a) => ( <AgentRow ... /> ))}
        </AnimatePresence>
    </Reorder.Group>
    <div className="px-[18px]">
        <IdleSection agents={parkedIdle} onOpen={(id) => setActiveTab(id)} />
    </div>
</div>
```

with the new region wrapper (asks region and divider come in Tasks 7 and 10 — leave the marked placeholders so this compiles now):

```tsx
<div ref={regionsRef} className="flex min-h-0 flex-1 flex-col">
    <AnimatePresence>
        {empty && (
            <motion.div
                key="empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.25 }}
                className="flex flex-1 flex-col items-center justify-center gap-1 p-[18px] text-center"
            >
                <div className="text-[18px] opacity-40">🤖</div>
                <div className="text-[13px] font-semibold text-secondary">No active agents</div>
                <div className="text-[11px] text-muted">Agents appear here the moment one starts working or asks a question.</div>
            </motion.div>
        )}
    </AnimatePresence>

    {/* ASKS REGION — added in Task 7 */}

    {/* DIVIDER — added in Task 10 */}

    <Reorder.Group
        as="div"
        axis="y"
        values={orderedActiveIds}
        onReorder={setOrder}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto"
    >
        <AnimatePresence mode="popLayout">
            {orderedActive.map((a) => {
                const isExpanded = expandedSet.has(a.id);
                return (
                    <AgentRow
                        key={a.id}
                        agent={a}
                        now={now}
                        isCursor={cursorId === a.id}
                        expanded={isExpanded}
                        fill={isExpanded}
                        pulse={pulseId === a.id}
                        selections={answerSel[a.id] ?? {}}
                        sent={sentIds.has(a.id)}
                        activeQuestion={answerTab[a.id] ?? 0}
                        onCursor={() => setCursorId(a.id)}
                        onOpen={() => openFocus(a.id, false)}
                        onOpenTerminal={() => setActiveTab(a.id)}
                        onToggleAnswer={(qi, oi) => toggleAnswer(a.id, qi, oi)}
                        onSubmitAnswer={() => submitAnswer(a.id)}
                        onSelectQuestion={(qi) => selectQuestion(a.id, qi)}
                        onComposerEscape={() => containerRef.current?.focus()}
                        onBackground={a.state === "working" ? () => toggleBackground(a.id) : undefined}
                        onDismiss={a.state === "idle" ? () => setDismissed((prev) => new Set(prev).add(dismissKey(a))) : undefined}
                    />
                );
            })}
        </AnimatePresence>
    </Reorder.Group>

    <div className="shrink-0 px-[18px]">
        <BackgroundedSection agents={backgrounded} onRestore={(id) => toggleBackground(id)} />
        <IdleSection agents={parkedIdle} onOpen={(id) => setActiveTab(id)} />
    </div>
</div>
```

- [ ] **Step 9: Verify build + behavior**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts` — Expected: PASS.
Confirm no type errors in `agents.tsx` / `agentrow.tsx`. Launch the dev app (see the `run` skill / CDP memory) and verify: working rows expand and flex-share; resizing the block reflows row heights; hovering a working row shows the new background button; clicking it moves the agent into a "Backgrounded" lane at the bottom; expanding the lane and clicking the row restores it.

- [ ] **Step 10: Commit** — suggested: `feat(agents): working region auto-fit + backgrounded lane`

---

### Task 7: Spotlight asks region

**Files:**
- Modify: `frontend/app/view/agents/agents.tsx`

- [ ] **Step 1: Render the asks region**

Replace the `{/* ASKS REGION — added in Task 7 */}` placeholder with:

```tsx
{asking.length > 0 ? (
    <div
        className="shrink-0 overflow-y-auto"
        style={{ flex: dividerRatio != null ? `0 0 ${dividerRatio * 100}%` : "0 0 auto", maxHeight: dividerRatio != null ? undefined : "60%" }}
    >
        <AnimatePresence mode="popLayout">
            {asking.map((a) => {
                const isFocused = focusedAsk === a.id;
                return (
                    <AgentRow
                        key={a.id}
                        agent={a}
                        now={now}
                        isCursor={cursorId === a.id}
                        expanded={isFocused}
                        fill={false}
                        pulse={pulseId === a.id}
                        selections={answerSel[a.id] ?? {}}
                        sent={sentIds.has(a.id)}
                        activeQuestion={answerTab[a.id] ?? 0}
                        onCursor={() => setCursorId(a.id)}
                        onOpen={() => openFocus(a.id, false)}
                        onOpenTerminal={() => setActiveTab(a.id)}
                        onToggleAnswer={(qi, oi) => toggleAnswer(a.id, qi, oi)}
                        onSubmitAnswer={() => submitAnswer(a.id)}
                        onSelectQuestion={(qi) => selectQuestion(a.id, qi)}
                        onComposerEscape={() => containerRef.current?.focus()}
                    />
                );
            })}
        </AnimatePresence>
    </div>
) : null}
```

Note: asks are not wrapped in `Reorder.Group` (asks aren't drag-reordered; the drag handle on these rows is inert, which is acceptable for v1). The focused ask renders expanded (full question + `AnswerBar`); the others render header-only with their amber "needs you" badge.

- [ ] **Step 2: Verify behavior**

Dev app: with 2+ agents asking, only one shows its question + options; the others are one-line amber headers. `↑↓` moves the cursor onto a collapsed ask and it expands (because `focusedAsk` follows the cursor). `n` cycles asks. `1–9` + `↵` still answer the focused ask.

- [ ] **Step 3: Commit** — suggested: `feat(agents): spotlight asks region`

---

### Task 8: Max-panels segmented control

**Files:**
- Modify: `frontend/app/view/agents/agents.tsx`

- [ ] **Step 1: Add a `MaxPanelsControl` component** (top-level in `agents.tsx`, near `RollingCount`)

```tsx
const MAX_PANEL_OPTIONS: MaxPanels[] = ["auto", 1, 2, 3, 4];

function MaxPanelsControl({ value, onChange }: { value: MaxPanels; onChange: (v: MaxPanels) => void }) {
    return (
        <span className="flex items-center gap-1" title="Max expanded panels">
            <span className="text-[10px] uppercase tracking-wide text-muted">panels</span>
            {MAX_PANEL_OPTIONS.map((opt) => (
                <button
                    key={String(opt)}
                    type="button"
                    onClick={() => onChange(opt)}
                    className={cn(
                        "cursor-pointer rounded-[4px] border px-1.5 py-0.5 text-[10px] transition-colors",
                        value === opt ? "border-accent bg-accent/15 text-primary" : "border-border text-muted hover:bg-white/[0.04]"
                    )}
                >
                    {opt === "auto" ? "Auto" : opt}
                </button>
            ))}
        </span>
    );
}
```

- [ ] **Step 2: Mount it in the header**

In the header row, add the control inside the right-hand `<span class="flex items-center gap-2 ...">`, before the `working` count:

```tsx
<MaxPanelsControl value={maxPanels} onChange={setMaxPanels} />
```

- [ ] **Step 3: Verify behavior**

Dev app with 5 working agents: `Auto` expands all (flex-shared). Clicking `2` expands two (the cursor row always among them); the rest collapse to one-line headers in place. Switching back to `Auto` re-expands all.

- [ ] **Step 4: Commit** — suggested: `feat(agents): max-panels density control`

---

### Task 9: `b` key, asking-overrides-backgrounded, hints + help

**Files:**
- Modify: `frontend/app/view/agents/agents.tsx`

- [ ] **Step 1: Drop a re-surfacing ask from the backgrounded set**

Add an effect (near the other effects):

```ts
// asking overrides backgrounded: a muted agent that starts asking re-surfaces (it's in `asking`,
// not `working`), so drop it from the set to avoid re-muting when it returns to working.
useEffect(() => {
    const askingSet = new Set(asking.map((a) => a.id));
    setBackgroundedIds((prev) => {
        let changed = false;
        const next = new Set(prev);
        for (const id of prev) {
            if (askingSet.has(id)) {
                next.delete(id);
                changed = true;
            }
        }
        return changed ? next : prev;
    });
}, [asking.map((a) => a.id).join(",")]);
```

- [ ] **Step 2: Handle the `b` key**

In `onKeyDown`, add a branch in the list-mode handler (not the focus-view branch), e.g. after the `t` branch:

```ts
} else if (e.key === "b") {
    e.preventDefault();
    if (cur && cur.state !== "asking") {
        toggleBackground(cur.id);
    }
}
```

- [ ] **Step 3: Add the hint + help entries**

In `HINTS`, add `["b", "background"]` before `["esc", "back"]`. In `HelpOverlay`'s `rows`, add `["b", "background the highlighted agent (keeps running)"]` before the `esc` row.

- [ ] **Step 4: Verify behavior**

Dev app: pressing `b` on a working cursor row moves it to the Backgrounded lane and the cursor advances to the next row; `b` on an asking row does nothing. Background an agent, then trigger an ask from it (or simulate) — it reappears in the asks region. The hint bar shows `b background` and the `?` overlay lists it.

- [ ] **Step 5: Commit** — suggested: `feat(agents): b-to-background key + ask re-surfacing + hints`

---

### Task 10: Region divider (asks ↔ working)

**Files:**
- Modify: `frontend/app/view/agents/agents.tsx`

- [ ] **Step 1: Add divider drag handlers**

Near the other handlers:

```ts
const dividerDragRef = useRef(false);
const onDividerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dividerDragRef.current = true;
};
const onDividerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dividerDragRef.current || !regionsRef.current) {
        return;
    }
    const rect = regionsRef.current.getBoundingClientRect();
    const ratio = (e.clientY - rect.top) / rect.height;
    setDividerRatio(Math.max(0.15, Math.min(0.85, ratio)));
};
const onDividerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    dividerDragRef.current = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
};
```

- [ ] **Step 2: Render the divider**

Replace the `{/* DIVIDER — added in Task 10 */}` placeholder (renders only when both regions are present):

```tsx
{asking.length > 0 && orderedActive.length > 0 ? (
    <div
        onPointerDown={onDividerDown}
        onPointerMove={onDividerMove}
        onPointerUp={onDividerUp}
        onDoubleClick={() => setDividerRatio(undefined)}
        title="Drag to bias asks vs working · double-click for auto"
        className="group/div flex h-2.5 shrink-0 cursor-ns-resize items-center justify-center"
    >
        <span className="h-[3px] w-10 rounded-full bg-border transition-colors group-hover/div:bg-accent" />
    </div>
) : null}
```

- [ ] **Step 3: Verify behavior**

Dev app with 1+ ask and 2+ working: dragging the handle down grows the asks region (and it scrolls internally) while the working rows tighten; dragging up does the reverse; double-click resets to auto (asks natural, capped at 60%). With no asks or no working rows, the handle is absent.

- [ ] **Step 4: Commit** — suggested: `feat(agents): asks↔working region divider`

---

## Phase 5 — Cleanup & verification

### Task 11: Final sweep

**Files:**
- Modify: `frontend/app/view/agents/agents.tsx`, `frontend/app/view/agents/agentrow.tsx`

- [ ] **Step 1: Remove dead code**

Confirm no remaining references to `listAgents`, `orderedList`, `orderedIds`, `Fragment` (if now unused in `agents.tsx`), and that `agentrow.tsx` no longer imports/uses `useState` for resize, `RowNarration*` constants, or the resize handlers. Remove any now-unused imports flagged by the editor.

- [ ] **Step 2: Full test run**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts`
Expected: PASS (all existing + the new `partitionBackgrounded` / `expandedWorkingIds` / `focusedAskId` suites).

- [ ] **Step 3: Manual verification checklist (dev app)**

- 1–2 agents: rows are tall/generous (flex-shared).
- 4–5 agents: rows tighten so the set fits without scrolling.
- Resize the block taller/shorter: rows reflow live.
- `panels` control: `Auto` vs `2`/`3` changes how many expand; cursor row always expanded.
- Multiple asks: one full, others one-line headers; `n` cycles; `1–9` + `↵` answers.
- `b`: backgrounds the cursor working row; lane shows it; click restores; an ask re-surfaces a muted agent.
- Divider: drags, double-click resets; absent when a region is empty.
- Focus view (`↵`) and the empty state are unchanged.

- [ ] **Step 4: Commit** — suggested: `chore(agents): remove dead resize code; finalize one-screen layout`

---

## Self-Review

**Spec coverage:**
- Auto-fit to live count → flexbox `flex:1 1 0` on expanded rows (Tasks 5–6). ✓
- Reflow on resize → flexbox + no measurement (Task 6 verify). ✓
- Asks first / never clamped + spotlight → asks region + `focusedAskId`, others header-only (Tasks 3, 7). ✓
- Manual demote / Backgrounded lane → `partitionBackgrounded`, `BackgroundedSection`, background button, `b` key (Tasks 1, 4, 5, 6, 9). ✓
- Asking overrides backgrounded → effect (Task 9). ✓
- Max-panels cap (mouse-only, Auto default) → `expandedWorkingIds`, `MaxPanelsControl` (Tasks 2, 8). ✓
- Region divider (ratio, session-only, double-click reset) → Task 10. ✓
- Remove per-row resize grip → Task 5; final sweep Task 11. ✓
- Keyboard `b` + hints/help → Task 9. ✓
- Edge cases (recently-idle in working region, cursor always expanded, scroll last resort via `MinExpandedRowPx`) → Tasks 5–6. ✓

**Placeholder scan:** the `{/* ASKS REGION */}` / `{/* DIVIDER */}` markers in Task 6 are intentional, filled by Tasks 7 and 10; no unresolved TODOs in shipped code.

**Type consistency:** `MaxPanels` (`"auto" | number`) is defined in Task 2 and consumed identically in `expandedWorkingIds` and `MaxPanelsControl`/state. `partitionBackgrounded` returns `{ active, backgrounded }` — consumed with those exact names in Task 6. `expanded`/`fill`/`onBackground` props defined in Task 5 match every `AgentRow` call site in Tasks 6–7. `toggleBackground(id)` is the single mutator used by the button, the `b` key, and `BackgroundedSection.onRestore`.
