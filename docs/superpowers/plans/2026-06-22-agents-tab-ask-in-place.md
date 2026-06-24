# Agents Tab — Ask-in-Place + Anchored Ordering + Polish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the asking state non-invasive — an asking agent stays in its grid slot and answers in place, grid position is anchored to agent identity (no response-timing reshuffles), and a density/polish pass reserves amber strictly for "needs you."

**Architecture:** The Agents view is a pure projection of upstream atoms; all logic lives in import-free pure modules (`agentsviewmodel.ts`) with thin React components. This plan adds two pure helpers (`mergeOrder`, `nextAskId`), extracts the ask-answer UI into a panel-embedded `AnswerBar`, merges asking agents into the single working grid, and removes the standalone focused-ask card + queue. No backend, no RPC, no `task generate`.

**Tech Stack:** TypeScript, React 19, Jotai, Tailwind v4, motion/react, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-22-agents-tab-ask-in-place-design.md`

**Commit policy (user override):** Per the user's git rule, do **not** commit per-task. Each task ends with a **Verify** gate (tests pass / no TS errors). All changes are committed **once at the end** (Task 8) and only after explicit user approval.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `frontend/app/view/agents/agentsviewmodel.ts` | Pure view-model logic | Add `mergeOrder`, `nextAskId`; remove `resolveFocusedAskId` |
| `frontend/app/view/agents/agentsviewmodel.test.ts` | Unit tests | Add `mergeOrder` / `nextAskId` suites; remove `resolveFocusedAskId` suite |
| `frontend/app/view/agents/answerbar.tsx` | The question + option-chip answer UI, pinned in a panel | **Create** (extract from `askcard.tsx`) |
| `frontend/app/view/agents/outputpanel.tsx` | The universal per-agent panel (working/asking/idle) | Render asking state + `AnswerBar`; polish |
| `frontend/app/view/agents/agents.tsx` | The view: single anchored grid + header | Merge asking into grid; `mergeOrder`/`nextAskId`; header pill + jump; remove focused-card/queue |
| `frontend/app/view/agents/askcard.tsx` | (was) standalone focused ask card | **Delete** after `AnswerBar` is wired |
| `frontend/app/view/agents/narrationtimeline.tsx`, `idlesection.tsx` | Narration + idle rows | Type/radius sweep only |
| `frontend/app/view/agents/statusdot.tsx` | State dot | No change (already correct) |

---

## Task 1: `mergeOrder` pure helper (anchored ordering)

`mergeOrder(prev, ids)` is the heart of anchored ordering: it keeps every still-present id in its existing slot regardless of how `ids` is ordered, appends genuinely-new ids, and drops absent ones.

**Files:**
- Modify: `frontend/app/view/agents/agentsviewmodel.ts`
- Test: `frontend/app/view/agents/agentsviewmodel.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `agentsviewmodel.test.ts` (import `mergeOrder` — add it to the existing import line from `./agentsviewmodel`):

```ts
describe("mergeOrder", () => {
    it("seeds from ids when prev is empty", () => {
        expect(mergeOrder([], ["a", "b"])).toEqual(["a", "b"]);
    });
    it("keeps existing slots even when ids reorders them (the anchor)", () => {
        // 'a' jumped to the front of ids (e.g. it started asking) — it must NOT move slot
        expect(mergeOrder(["a", "b", "c"], ["b", "a", "c"])).toEqual(["a", "b", "c"]);
    });
    it("appends genuinely-new ids after the kept ones", () => {
        expect(mergeOrder(["a", "b"], ["a", "b", "c"])).toEqual(["a", "b", "c"]);
    });
    it("drops ids no longer present", () => {
        expect(mergeOrder(["a", "b", "c"], ["a", "c"])).toEqual(["a", "c"]);
    });
    it("is a no-op when the set is unchanged", () => {
        expect(mergeOrder(["a", "b"], ["a", "b"])).toEqual(["a", "b"]);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts -t "mergeOrder"`
Expected: FAIL — `mergeOrder is not exported` / not defined.

- [ ] **Step 3: Implement `mergeOrder`**

Add to `agentsviewmodel.ts` near `reorderList`:

```ts
/** Pure: reconcile a stable order list against the current id set. Kept ids retain their existing
 *  slot regardless of `ids` order (anchored ordering); new ids append in `ids` order; absent ids
 *  drop. This is why a working->asking transition never moves a panel: the id stays in the set. */
export function mergeOrder(prev: string[], ids: string[]): string[] {
    const present = new Set(ids);
    const kept = prev.filter((id) => present.has(id));
    const keptSet = new Set(kept);
    const added = ids.filter((id) => !keptSet.has(id));
    return [...kept, ...added];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts -t "mergeOrder"`
Expected: PASS (5 passing).

- [ ] **Step 5: Verify** — no TypeScript errors reported in VSCode for `agentsviewmodel.ts` / `.test.ts`.

---

## Task 2: `nextAskId` pure helper (jump-to cycling)

`nextAskId(ids, current)` powers the header "jump →" control: cycle to the ask after `current`, wrapping, defaulting to the first.

**Files:**
- Modify: `frontend/app/view/agents/agentsviewmodel.ts`
- Test: `frontend/app/view/agents/agentsviewmodel.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `agentsviewmodel.test.ts` (add `nextAskId` to the import line):

```ts
describe("nextAskId", () => {
    it("returns the first when current is undefined", () => {
        expect(nextAskId(["x", "y", "z"], undefined)).toBe("x");
    });
    it("advances to the id after current", () => {
        expect(nextAskId(["x", "y", "z"], "x")).toBe("y");
    });
    it("wraps from the last back to the first", () => {
        expect(nextAskId(["x", "y", "z"], "z")).toBe("x");
    });
    it("returns the first when current is no longer present", () => {
        expect(nextAskId(["x", "y", "z"], "gone")).toBe("x");
    });
    it("returns undefined for an empty list", () => {
        expect(nextAskId([], "x")).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts -t "nextAskId"`
Expected: FAIL — `nextAskId is not defined`.

- [ ] **Step 3: Implement `nextAskId`**

Add to `agentsviewmodel.ts` near `mergeOrder`:

```ts
/** Pure: the ask to jump to after `current`, cycling with wrap. Defaults to the first ask when
 *  `current` is absent or no longer in the list. Undefined for an empty list. */
export function nextAskId(ids: string[], current?: string): string | undefined {
    if (ids.length === 0) {
        return undefined;
    }
    const idx = current != null ? ids.indexOf(current) : -1;
    return ids[(idx + 1) % ids.length];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts -t "nextAskId"`
Expected: PASS (5 passing).

- [ ] **Step 5: Verify** — no TypeScript errors in VSCode.

---

## Task 3: Create `AnswerBar` (extract from `askcard.tsx`)

Move the question + option-chip + submit logic out of `AskCard` into a standalone `AnswerBar` that can be pinned inside a panel. `askcard.tsx` is left untouched and still functional this task (it keeps its own copy); `AnswerBar` is created but not yet used. No behavior change yet → build stays green.

**Files:**
- Create: `frontend/app/view/agents/answerbar.tsx`

- [ ] **Step 1: Create `answerbar.tsx`**

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { useState } from "react";
import { buildAskAnswers, canSubmitAsk, type AgentAskQuestion, type AgentVM } from "./agentsviewmodel";

function QuestionGroup({
    question,
    qi,
    selections,
    onToggle,
}: {
    question: AgentAskQuestion;
    qi: number;
    selections: Set<number>;
    onToggle: (qi: number, oi: number) => void;
}) {
    const options = question.options ?? [];
    return (
        <div className={cn("mt-3", qi > 0 && "border-t border-border pt-3")}>
            {question.header ? (
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">{question.header}</div>
            ) : null}
            <div className="text-[13px] font-semibold text-primary">{question.question}</div>
            {options.length > 0 ? (
                <div className="mt-2.5 flex flex-wrap gap-2">
                    {options.map((opt, oi) => {
                        const isSelected = selections.has(oi);
                        // Claude Code's AskUserQuestion payload has no separate "recommended" flag — by convention it
                        // appends the literal "(Recommended)" marker to the option label, so this substring is the only signal.
                        const isRecommended = opt.label.toLowerCase().includes("(recommended)");
                        return (
                            <button
                                key={oi}
                                type="button"
                                onClick={() => onToggle(qi, oi)}
                                className={cn(
                                    "cursor-pointer rounded-[6px] px-3 py-1 text-[12px] transition-colors",
                                    isSelected
                                        ? "bg-accent/80 font-semibold text-primary hover:bg-accent"
                                        : isRecommended
                                          ? "border border-accent font-semibold text-accent hover:bg-accent/10"
                                          : "border border-border text-secondary hover:bg-white/[0.04]"
                                )}
                            >
                                {opt.label}
                                {opt.description ? (
                                    <span className={cn("ml-1.5 text-[11px] font-normal", isSelected ? "text-primary/75" : "text-muted")}>
                                        {opt.description}
                                    </span>
                                ) : null}
                            </button>
                        );
                    })}
                </div>
            ) : null}
            {question.multiSelect && selections.size > 0 ? (
                <div className="mt-2 text-[11px] text-muted">press Enter to submit</div>
            ) : null}
        </div>
    );
}

// Pinned amber answer surface for an asking agent. Single-select submits the moment every question is
// answered; multi-select submits on Enter (it can't know when you're done). The freeform reply lives in
// the panel's AgentComposer, not here.
export function AnswerBar({ agent, onAnswer }: { agent: AgentVM; onAnswer?: (oref: string, answers: AgentAnswerItem[]) => void }) {
    const [selections, setSelections] = useState<Record<number, Set<number>>>({});
    const [sent, setSent] = useState(false);
    const questions = agent.ask?.questions ?? [];
    const needsConfirm = questions.some((q) => q.multiSelect);

    const submit = (sel: Record<number, Set<number>>) => {
        if (sent || !canSubmitAsk(questions, sel)) return;
        setSent(true);
        onAnswer?.(agent.ask?.oref, buildAskAnswers(questions, sel));
    };

    const handleSelect = (qi: number, oi: number) => {
        if (sent) return;
        const q = questions[qi];
        const current = new Set(selections[qi] ?? []);
        if (q?.multiSelect) {
            if (current.has(oi)) current.delete(oi);
            else current.add(oi);
        } else {
            current.clear();
            current.add(oi);
        }
        const next = { ...selections, [qi]: current };
        setSelections(next);
        if (!needsConfirm) {
            submit(next);
        }
    };

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key !== "Enter" || !needsConfirm) return;
        const tag = (e.target as HTMLElement).tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        e.preventDefault();
        submit(selections);
    };

    if (questions.length === 0) {
        return null;
    }
    return (
        <div className="shrink-0 border-t border-warning bg-warning/5 px-[14px] py-2.5" tabIndex={-1} onKeyDown={onKeyDown}>
            {questions.map((q, qi) => (
                <QuestionGroup key={qi} question={q} qi={qi} selections={selections[qi] ?? new Set()} onToggle={handleSelect} />
            ))}
        </div>
    );
}
```

- [ ] **Step 2: Verify** — no TypeScript errors in VSCode for `answerbar.tsx`. (`AgentAnswerItem` is a global ambient type from `gotypes.d.ts`, used the same way in `agents.tsx` — no import needed.) `AskCard` is unchanged and still compiles.

---

## Task 4: Render the asking state in `WorkingPanel`

Teach the panel to render an asking agent: amber border + glow, a "needs you" header tag, dimmed narration, and `<AnswerBar>` pinned above the composer. Asking agents don't reach this panel until Task 5, so this branch is dormant-but-correct now — the build stays green and the working/idle rendering is unchanged.

**Files:**
- Modify: `frontend/app/view/agents/outputpanel.tsx`

- [ ] **Step 1: Add the `onAnswer` prop + import `AnswerBar`**

At the top of `outputpanel.tsx`, add the import:

```ts
import { AnswerBar } from "./answerbar";
```

Change the `WorkingPanel` signature + props type to add `onAnswer`:

```tsx
export function WorkingPanel({
    agent,
    now,
    onOpen,
    onDismiss,
    onAnswer,
}: {
    agent: AgentVM;
    now: number;
    onOpen: (id: string) => void;
    onDismiss?: () => void;
    onAnswer?: (oref: string, answers: AgentAnswerItem[]) => void;
}) {
```

- [ ] **Step 2: Add an `asking` flag and amber container styling**

Just below the existing `const idle = agent.state === "idle";` line, add:

```ts
    const asking = agent.state === "asking";
```

Change the panel container `div` (currently `className="relative flex h-full flex-col overflow-hidden rounded-[9px] border border-border bg-background"`) to:

```tsx
        <div
            className={cn(
                "relative flex h-full flex-col overflow-hidden rounded-[10px] bg-background",
                asking ? "border border-warning shadow-[0_0_0_1px_rgba(224,185,86,0.3),0_0_20px_rgba(224,185,86,0.12)]" : "border border-border"
            )}
        >
```

- [ ] **Step 3: Show a "needs you" tag for asking; keep model·age otherwise**

In the header, replace the right-side meta block (the `{idle ? (...) : (...)}` ternary that renders the idle/working meta) so asking wins first:

```tsx
                {asking ? (
                    <span className="ml-auto shrink-0 rounded-[4px] border border-warning px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-warning">
                        needs you
                    </span>
                ) : idle ? (
                    <span className="ml-auto flex shrink-0 items-center gap-1 tabular-nums text-[11px] text-muted">
                        {agent.model ? `${agent.model} · ` : ""}
                        {formatAge(idleMs)} idle
                    </span>
                ) : (
                    <span className="ml-auto flex shrink-0 items-center gap-1 tabular-nums text-[11px] text-muted">
                        {agent.model ? `${agent.model} · ` : ""}
                        {formatAge(agent.activeMs)}
                    </span>
                )}
```

This also drops the `⟳ {since}` / `quiet` text from the working meta (polish item #2) and makes the working meta plain `text-muted` (polish item #1). Because that orphans them, **in this same step** delete the `formatSince` function (top of `outputpanel.tsx`) and the `const since = ...` line so no unused locals remain. Keep `quiet` (feeds `<StatusDot quiet={quiet} />`) and `lastTs`/`lastActivity` (feed `isQuiet`).

- [ ] **Step 4: Dim narration when asking, and render `AnswerBar` above the composer**

Change the narration scroll container to dim when asking:

```tsx
            <div ref={scrollRef} onScroll={onScroll} className={cn("min-h-0 flex-1 overflow-y-auto px-[14px] py-[11px]", asking && "opacity-60")}>
                <NarrationTimeline entries={entries} accentLatest />
            </div>
```

Then, directly **above** the existing `<AgentComposer .../>` line at the end of the component, add:

```tsx
            {asking ? <AnswerBar agent={agent} onAnswer={onAnswer} /> : null}
```

- [ ] **Step 5: Verify** — no TypeScript errors in VSCode. Run the full agents test file to confirm nothing regressed:

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts`
Expected: PASS (all suites).

---

## Task 5: Switchover — unified anchored grid in `agents.tsx`

The functional switchover: asking agents join the grid (rendering in-place via Task 4), the standalone focused card + queue are removed, ordering uses `mergeOrder`, and the header gains the "N needs you" pill + jump.

**Files:**
- Modify: `frontend/app/view/agents/agents.tsx`

- [ ] **Step 1: Update imports**

Remove `AskCard` import (`import { AskCard } from "./askcard";`). In the `./agentsviewmodel` import, remove `resolveFocusedAskId`, add `mergeOrder` and `nextAskId`. Add `useRef` if not already imported (it is).

- [ ] **Step 2: Delete the `QueueRow` component**

Remove the entire `function QueueRow(...) { ... }` definition (≈ lines 40-57).

- [ ] **Step 3: Include asking agents in the grid set**

In `AgentsView`, remove the focused/queue derivation:

```ts
    // DELETE these lines:
    const [focusedAskId, setFocusedAskId] = useState<string>();
    const focusedId = resolveFocusedAskId(asking, focusedAskId);
    const focused = asking.find((a) => a.id === focusedId);
    const queue = asking.filter((a) => a.id !== focusedId);
```

Change the grid set to include asking agents (keep `recentlyIdle`/`parkedIdle` as-is):

```ts
    const gridAgents = [...asking, ...working, ...recentlyIdle];
```

- [ ] **Step 4: Use `mergeOrder` for the order reconciliation**

Replace the inline order effect body:

```ts
    useEffect(() => {
        const ids = gridAgents.map((w) => w.id);
        setOrder((prev) => mergeOrder(prev, ids));
    }, [gridAgents.map((w) => w.id).join(",")]);
```

- [ ] **Step 5: Add jump-to-ask state + handler**

Near the other `useState` declarations in `AgentsView`, add:

```ts
    const [pulseId, setPulseId] = useState<string>();
    const lastJumpRef = useRef<string>();
    const jumpToNextAsk = () => {
        const target = nextAskId(asking.map((a) => a.id), lastJumpRef.current);
        if (!target) {
            return;
        }
        lastJumpRef.current = target;
        document.querySelector(`[data-agent-id="${target}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
        setPulseId(target);
        setTimeout(() => setPulseId((p) => (p === target ? undefined : p)), 1200);
    };
```

- [ ] **Step 6: Replace the header right-side with the pill + working count**

Replace the header `<span className="flex items-center gap-1 ...">...</span>` block with:

```tsx
                <span className="flex items-center gap-2 text-[12px] text-muted">
                    {asking.length > 0 ? (
                        <button
                            type="button"
                            onClick={jumpToNextAsk}
                            className="flex cursor-pointer items-center gap-1.5 rounded-[6px] border border-warning bg-warning/10 px-2 py-0.5 text-[11px] font-semibold text-warning hover:bg-warning/15"
                        >
                            <span className="h-2 w-2 rounded-full bg-warning" />
                            <RollingCount value={asking.length} /> needs you
                            <span className="font-normal text-muted">· jump →</span>
                        </button>
                    ) : null}
                    <span className="flex items-center gap-1">
                        <RollingCount value={working.length} />
                        <span>working</span>
                    </span>
                </span>
```

- [ ] **Step 7: Remove the focused-ask + queue JSX**

Delete the `<AnimatePresence>` block that renders `{focused && (... <AskCard .../> ...)}` and the `{queue.length > 0 && (...)}` block. The empty state, the grid, and `<IdleSection>` remain.

- [ ] **Step 8: Pass `onAnswer` and `pulse` into the grid panels**

In the `orderedGrid.map(...)`, pass `pulse` to `DraggablePanel` and `onAnswer` to `WorkingPanel`:

```tsx
                                <DraggablePanel
                                    key={a.id}
                                    id={a.id}
                                    preset={presetById[a.id] ?? DEFAULT_PANEL_PRESET}
                                    fillPx={fillPx}
                                    pulse={pulseId === a.id}
                                    onResize={resizePanel}
                                    onDragStart={() => setDragId(a.id)}
                                    onDropOn={(targetId, before) => {
                                        if (dragId) {
                                            setOrder((o) => reorderList(o, dragId, targetId, before));
                                        }
                                        setDragId(undefined);
                                    }}
                                >
                                    <WorkingPanel
                                        agent={a}
                                        now={now}
                                        onOpen={open}
                                        onAnswer={answer}
                                        onDismiss={
                                            a.state === "idle"
                                                ? () => setDismissed((prev) => new Set(prev).add(dismissKey(a)))
                                                : undefined
                                        }
                                    />
                                </DraggablePanel>
```

- [ ] **Step 9: Add the `pulse` prop to `DraggablePanel`**

Add `pulse` to `DraggablePanel`'s props (signature + type), and apply a ring when set. In the props destructure add `pulse`, in the type add `pulse?: boolean;`, and on the `motion.div`'s `className` (currently `cn("relative min-w-0", cols === 2 ? "col-span-2" : "col-span-1")`) add the ring:

```tsx
            className={cn(
                "relative min-w-0",
                cols === 2 ? "col-span-2" : "col-span-1",
                pulse && "rounded-[10px] ring-2 ring-warning ring-offset-2 ring-offset-background transition-shadow"
            )}
```

- [ ] **Step 10: Verify**

- No TypeScript errors in VSCode (in particular: no remaining references to `AskCard`, `QueueRow`, `focused`, `queue`, `resolveFocusedAskId`).
- Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts` → PASS.

---

## Task 6: Delete `askcard.tsx` and retire `resolveFocusedAskId`

Now that nothing imports them, remove the dead code.

**Files:**
- Delete: `frontend/app/view/agents/askcard.tsx`
- Modify: `frontend/app/view/agents/agentsviewmodel.ts` (remove `resolveFocusedAskId`)
- Modify: `frontend/app/view/agents/agentsviewmodel.test.ts` (remove its suite)

- [ ] **Step 1: Confirm no importers remain**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts` then search the repo for `askcard` and `resolveFocusedAskId`.
Expected: the only matches are the files about to be edited/deleted.

- [ ] **Step 2: Delete the file**

Delete `frontend/app/view/agents/askcard.tsx`.

- [ ] **Step 3: Remove `resolveFocusedAskId` from `agentsviewmodel.ts`**

Delete the entire `export function resolveFocusedAskId(...) { ... }` and its doc comment (≈ lines 208-216).

- [ ] **Step 4: Remove its test suite**

In `agentsviewmodel.test.ts`, delete the `describe("resolveFocusedAskId", ...)` block, and remove `resolveFocusedAskId` from the import line.

- [ ] **Step 5: Verify**

- Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts` → PASS (no `resolveFocusedAskId` suite).
- No TypeScript errors in VSCode anywhere in `frontend/app/view/agents/`.

---

## Task 7: Density & polish pass

Five bounded changes. Each step is concrete; the type-ladder sweep replaces ad-hoc sizes with **14 / 13 / 12 / 11 / 10** and radii with **10px (panels) / 6px (controls)**.

**Files:** `outputpanel.tsx`, `agents.tsx`, `narrationtimeline.tsx`, `idlesection.tsx`.

- [ ] **Step 1: Confirm amber-reserved + ticker-drop (done in Task 4)**

Polish items #1 (working meta is plain `text-muted`) and #2 (no `⟳ {since}` / `quiet` text; `formatSince` + `since` removed) were applied in Task 4 Step 3. Here, just confirm there are no remaining references to `since` or `formatSince` in `outputpanel.tsx` and that amber now appears only on asking panels + the header pill.

- [ ] **Step 2: Hover-reveal icon actions (outputpanel.tsx)**

Add `group` to the panel container className (the `cn(...)` from Task 4 Step 2 → prefix with `"group "`). Replace the two text buttons (Dismiss / Open terminal) with hover-revealed icon buttons:

```tsx
                {onDismiss ? (
                    <button
                        type="button"
                        onClick={onDismiss}
                        title="Move to Idle"
                        className="shrink-0 cursor-pointer rounded-[6px] border border-border p-1 text-secondary opacity-0 transition-opacity hover:bg-white/[0.04] group-hover:opacity-100"
                    >
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M8 3v8M4 8l4 4 4-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    </button>
                ) : null}
                <button
                    type="button"
                    onClick={() => onOpen(agent.id)}
                    title="Open terminal"
                    className="shrink-0 cursor-pointer rounded-[6px] border border-border p-1 text-secondary opacity-0 transition-opacity hover:bg-white/[0.04] group-hover:opacity-100"
                >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M4 12L12 4M12 4H6M12 4v6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </button>
```

(Asking panels: the "needs you" tag sits where the meta is; the action icons still appear on hover — acceptable. No special-casing needed.)

- [ ] **Step 3: Type ladder + radii sweep (outputpanel.tsx)**

In `outputpanel.tsx` apply: panel name stays `text-[13px]`; the `project · task` subtitle `text-[11.5px]` → `text-[11px]`; header padding stays. The narration "↓ N new" pill: `rounded-full` stays, `text-[11px]` stays. No other size changes needed here.

- [ ] **Step 4: Header + empty-state polish (agents.tsx)**

- Header title: `<b className="text-[15px] text-primary">Agents</b>` → `text-[14px] font-semibold`.
- Empty state: soften — change the emoji line `<div className="text-[22px] opacity-50">🤖</div>` to `<div className="text-[18px] opacity-40">🤖</div>`, the heading `text-[13px]` → `text-[13px]` (keep), and the hint `text-[11.5px]` → `text-[11px]`.

- [ ] **Step 5: Type ladder sweep (narrationtimeline.tsx, idlesection.tsx)**

- `narrationtimeline.tsx`: the `user` entry `text-[12.5px]` → `text-[12px]`. (Message `text-[13px]` and action `text-[12px]` stay.)
- `idlesection.tsx`: row name `text-[12.5px]` → `text-[12px]`; `activity` `text-[12px]` → `text-[12px]` (keep); the `formatAge(...) idle` `text-[10.5px]` → `text-[10px]`. Section header `text-[11px]` stays. `rounded-[6px]` stays.

- [ ] **Step 6: Verify**

- No TypeScript errors in VSCode.
- Run the full agents test file: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts` → PASS.

---

## Task 8: Full verification + commit (gated on approval)

**Files:** none (verification + commit only).

- [ ] **Step 1: Run the full frontend test suite**

Run: `npx vitest run frontend/app/view/agents/`
Expected: all agents-view suites PASS, including `mergeOrder` (5), `nextAskId` (5), and the unchanged answer/sort/group suites; no `resolveFocusedAskId` suite.

- [ ] **Step 2: Confirm a clean TypeScript surface**

Confirm VSCode reports zero errors across `frontend/app/view/agents/`. Grep the repo to confirm no dangling references: `askcard`, `resolveFocusedAskId`, `QueueRow`, `formatSince` should have no live importers.

- [ ] **Step 3: Visual verification in the dev app (CDP)**

Drive the running dev Electron app over CDP (see the `cdp-verify-dev-app` memory; mock roster via `USE_MOCK_AGENTS` if no live agents). Confirm:
1. A working panel that transitions to asking turns amber **in place** — no layout shift, no slot change.
2. Multiple asks render as multiple amber panels; the header shows "N needs you"; clicking "jump →" scrolls to and pulses the next ask.
3. A "quiet" working panel is **muted grey**, not amber (amber appears only on asks + the pill).
4. Open/Dismiss icons appear only on panel hover.
5. Answering a single-select ask submits immediately; multi-select submits on Enter; the freeform composer still sends.

- [ ] **Step 4: Re-check git state, then request commit approval**

Run: `git status` and `git diff --stat` from the repo root (shared working tree — confirm only the intended agents files + the spec/plan docs changed).

Present to the user for approval (per the user's STRICT git rule), then commit as a single batch on a yes:

Files (expected):
- `A docs/superpowers/specs/2026-06-22-agents-tab-ask-in-place-design.md`
- `A docs/superpowers/plans/2026-06-22-agents-tab-ask-in-place.md`
- `A frontend/app/view/agents/answerbar.tsx`
- `M frontend/app/view/agents/agents.tsx`
- `M frontend/app/view/agents/outputpanel.tsx`
- `M frontend/app/view/agents/agentsviewmodel.ts`
- `M frontend/app/view/agents/agentsviewmodel.test.ts`
- `M frontend/app/view/agents/narrationtimeline.tsx`
- `M frontend/app/view/agents/idlesection.tsx`
- `D frontend/app/view/agents/askcard.tsx`

Proposed message: `feat(agents): answer-in-place + anchored ordering, amber reserved for asks`

---

## Self-Review (against the spec)

- **Part 1 (unified anchored grid):** Task 1 (`mergeOrder` + tests), Task 5 (grid includes asking, `mergeOrder` wired, focused-card/queue removed). ✅
- **Part 2 (answer in place):** Task 3 (`AnswerBar` extracted), Task 4 (panel renders asking + `AnswerBar`), Task 6 (`askcard.tsx` deleted after wiring). ✅
- **Part 3 (header pill + jump):** Task 2 (`nextAskId` + tests), Task 5 Steps 5–6 (pill + `jumpToNextAsk` + pulse). ✅
- **Part 4 (5 polish items):** amber-reserved (Task 4 Step 3 + Task 7 Step 1), dot-not-text liveness (Task 4 Step 3 + Task 7 Step 1), hover actions (Task 7 Step 2), type ladder + radii (Task 7 Steps 3–5), empty state (Task 7 Step 4). Model-label shortening confirmed already done — no task, per spec. ✅
- **Sequencing guards:** `askcard.tsx` deleted only in Task 6 (after Task 4 wires `AnswerBar` and Task 5 stops importing it); asking-state panel code (Task 4) lands before asking agents enter the grid (Task 5) so there's no broken intermediate. ✅
- **No backend / `task generate`:** confirmed — every file is view/pure layer. ✅
- **Placeholder scan:** no TBD/TODO; every code step shows the code. ✅
- **Type consistency:** `mergeOrder(prev, ids)`, `nextAskId(ids, current)`, `AnswerBar({ agent, onAnswer })`, `WorkingPanel({..., onAnswer})`, `DraggablePanel({..., pulse})` are used consistently across tasks. ✅
