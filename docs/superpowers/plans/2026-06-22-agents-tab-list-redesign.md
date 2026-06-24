# Agents Tab Redesign (List + Focus + Keyboard Triage) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Agents tab's 2-column grid of full panels with a density-adaptive single-column list (full asks, load-clamped working rows with prose + tool steps), a full-bleed focus view for reading one agent, and a focus-aware keyboard-triage keymap — so the view holds up at 5+ agents without becoming a wall of streaming boxes.

**Architecture:** Frontend-only, under `frontend/app/view/agents/`. Pure view-model logic (testable) lives in `agentsviewmodel.ts` and is TDD'd with Vitest. React components follow the repo's existing patterns (Jotai atoms read via `useAtomValue` at the top of components, Tailwind v4, 4-space indent, named exports) and are verified by the existing test suite staying green + the running dev app, since this repo has no component/DOM test harness. No backend, RPC, projection, or data-layer changes.

**Tech Stack:** TypeScript, React 19, Jotai, Tailwind v4, motion/react, Vitest.

---

## ⚠️ Two policy notes for the executor (read first)

1. **Commits (user override).** The user's `CLAUDE.md` git workflow takes precedence over this skill's "frequent commits" default: **do NOT commit per task.** Each task ends with a *checkpoint* (stage with `git add`, run the verification, report status). At the very end (Task 12) prepare a **single** commit and present it for explicit approval — do not run `git commit` until the user says yes. Never add Claude as co-author.

2. **Ordering reconciliation (confirm before Task 8).** The spec §1 says "asks pinned at top." The currently-shipped behavior is *anchored ordering* (commit `69c6d99f`): rows keep their slot when state changes so panels never jump, and the user explicitly asked to keep manual reorder. This plan **preserves anchored ordering + manual reorder** and makes asks stand out via amber styling + the `n`/jump affordance, rather than force-floating asks to the top (which would reintroduce the jumping anchored-ordering removed). If the user actually wants hard top-pinning, that's a small change to the render order in Task 8 — flag it at plan review.

---

## File structure

**Created:**
- `frontend/app/view/agents/agentrow.tsx` — one list row. Working variant: header + clamped prose (left) + recent tool steps (right). Ask variant: header + full question + numbered answer chips. Recently-idle variant: working layout with idle styling + dismiss. No inline composer (reply happens in the focus view).
- `frontend/app/view/agents/focusview.tsx` — full single-agent reading view: header (back / identity / ↗ terminal / ‹ › nav), large scrollable narration with the "new" pill, answer bar (if asking), full-width composer.

**Modified:**
- `frontend/app/view/agents/agentsviewmodel.ts` — add pure helpers `latestMessageText`, `recentActions`, `moveCursor`; remove the grid-sizing exports `PanelPreset`, `PANEL_PRESETS`, `DEFAULT_PANEL_PRESET`, `resolveHeight`, `snapToPreset`.
- `frontend/app/view/agents/agentsviewmodel.test.ts` — add tests for the new helpers; remove the `snapToPreset` import + its tests.
- `frontend/app/view/agents/answerbar.tsx` — make selection *controlled* (state owned by the view), add 1–9 number badges, add a `className` prop, add a "✓ Answered" confirmation render, render options as **stacked rows when any has a description else compact chips**; drop the internal Enter handling.
- `frontend/app/view/agents/narrationtimeline.tsx` — add an optional `large` prop that bumps font sizes for the focus view.
- `frontend/app/view/agents/agents.tsx` — rewrite `AgentsView`: list of `AgentRow`s, cursor state, focus-aware keymap, key-hint bar, `?` cheatsheet overlay, focus-view routing; keep reorder; remove `DraggablePanel`, the grid, resize presets, and `fillPx` measurement.

**Removed:**
- `frontend/app/view/agents/outputpanel.tsx` — `WorkingPanel` is superseded by `AgentRow` (compact) + `FocusView` (full). Its scroll-stick + "↓ N new" pill logic moves into `FocusView`.

**Unchanged (do not touch):** `idlesection.tsx`, `statusdot.tsx`, `agentcomposer.tsx`, `markdownmessage.tsx`, `liveagents.ts`, `livetranscript.ts`, `previousinfo.ts`, `transcriptprojection.ts`, `transcriptregistry.ts`, `codextranscriptprojection.ts`, `projectname.ts`, `agentaskstore.ts`, `mockagents.ts`.

**Verification commands used throughout:**
- Pure tests: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts`
- All agents tests: `npx vitest run frontend/app/view/agents`
- TypeScript: rely on the VSCode Problems panel for the touched files (per repo convention — no standalone typecheck script). Vitest will also fail to run if imports break.

---

## Phase 1 — Pure view-model helpers (TDD)

### Task 1: `latestMessageText`

**Files:**
- Modify: `frontend/app/view/agents/agentsviewmodel.ts`
- Test: `frontend/app/view/agents/agentsviewmodel.test.ts`

- [ ] **Step 1: Write the failing test.** Append to `agentsviewmodel.test.ts`:

```ts
describe("latestMessageText", () => {
    it("returns the last message-kind entry's text", () => {
        const entries: AgentEntry[] = [
            { kind: "message", text: "first" },
            { kind: "action", verb: "read", target: "a.ts" },
            { kind: "message", text: "second" },
        ];
        expect(latestMessageText(entries)).toBe("second");
    });
    it("ignores trailing actions and user turns", () => {
        const entries: AgentEntry[] = [
            { kind: "message", text: "hello" },
            { kind: "user", text: "do x" },
            { kind: "action", verb: "ran", target: "go test" },
        ];
        expect(latestMessageText(entries)).toBe("hello");
    });
    it("is undefined when there are no messages", () => {
        expect(latestMessageText([{ kind: "action", verb: "read", target: "a" }])).toBeUndefined();
        expect(latestMessageText([])).toBeUndefined();
    });
});
```

Also add `latestMessageText`, `recentActions`, `moveCursor`, and `AgentEntry` to the existing top-of-file import from `./agentsviewmodel` (extend the single import statement — `AgentEntry` is a type, the rest are values).

- [ ] **Step 2: Run it; verify it fails.**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts -t latestMessageText`
Expected: FAIL — `latestMessageText is not a function` (or import error).

- [ ] **Step 3: Implement.** Add to `agentsviewmodel.ts` (just after `groupAgents`, near the other entry helpers):

```ts
/** Pure: the text of the most recent message-kind entry, or undefined. Drives the working row's
 *  current-activity line and the focus view's accented "now" message. */
export function latestMessageText(entries: AgentEntry[]): string | undefined {
    for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (e.kind === "message") {
            return e.text;
        }
    }
    return undefined;
}
```

- [ ] **Step 4: Run it; verify it passes.**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts -t latestMessageText`
Expected: PASS (3 tests).

- [ ] **Step 5: Checkpoint (no commit).** `git add frontend/app/view/agents/agentsviewmodel.ts frontend/app/view/agents/agentsviewmodel.test.ts`

---

### Task 2: `recentActions`

**Files:**
- Modify: `frontend/app/view/agents/agentsviewmodel.ts`
- Test: `frontend/app/view/agents/agentsviewmodel.test.ts`

- [ ] **Step 1: Write the failing test.** Append:

```ts
describe("recentActions", () => {
    const entries: AgentEntry[] = [
        { kind: "action", verb: "read", target: "a" },
        { kind: "message", text: "m" },
        { kind: "action", verb: "edited", target: "b" },
        { kind: "action", verb: "ran", target: "test", outcome: "ok" },
    ];
    it("returns only actions, oldest-first, capped to max", () => {
        expect(recentActions(entries, 2)).toEqual([
            { kind: "action", verb: "edited", target: "b" },
            { kind: "action", verb: "ran", target: "test", outcome: "ok" },
        ]);
    });
    it("returns all actions when max exceeds the count", () => {
        expect(recentActions(entries, 10)).toHaveLength(3);
    });
    it("returns an empty array when there are no actions", () => {
        expect(recentActions([{ kind: "message", text: "x" }], 3)).toEqual([]);
    });
});
```

- [ ] **Step 2: Run it; verify it fails.**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts -t recentActions`
Expected: FAIL — `recentActions is not a function`.

- [ ] **Step 3: Implement.** Add after `latestMessageText`:

```ts
export type AgentActionEntry = Extract<AgentEntry, { kind: "action" }>;

/** Pure: the last `max` action-kind entries, oldest-first. Drives the working row's steps column. */
export function recentActions(entries: AgentEntry[], max: number): AgentActionEntry[] {
    const actions = entries.filter((e): e is AgentActionEntry => e.kind === "action");
    return max > 0 ? actions.slice(-max) : actions;
}
```

- [ ] **Step 4: Run it; verify it passes.**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts -t recentActions`
Expected: PASS (3 tests).

- [ ] **Step 5: Checkpoint (no commit).** `git add frontend/app/view/agents/agentsviewmodel.ts frontend/app/view/agents/agentsviewmodel.test.ts`

---

### Task 3: `moveCursor`

**Files:**
- Modify: `frontend/app/view/agents/agentsviewmodel.ts`
- Test: `frontend/app/view/agents/agentsviewmodel.test.ts`

- [ ] **Step 1: Write the failing test.** Append:

```ts
describe("moveCursor", () => {
    const ids = ["a", "b", "c"];
    it("moves by one and clamps at both ends (no wrap)", () => {
        expect(moveCursor(ids, "a", 1)).toBe("b");
        expect(moveCursor(ids, "b", -1)).toBe("a");
        expect(moveCursor(ids, "c", 1)).toBe("c");
        expect(moveCursor(ids, "a", -1)).toBe("a");
    });
    it("starts at the first id when current is absent or unknown", () => {
        expect(moveCursor(ids, undefined, 1)).toBe("a");
        expect(moveCursor(ids, "zzz", -1)).toBe("a");
    });
    it("is undefined for an empty list", () => {
        expect(moveCursor([], "a", 1)).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run it; verify it fails.**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts -t moveCursor`
Expected: FAIL — `moveCursor is not a function`.

- [ ] **Step 3: Implement.** Add next to `nextAskId`:

```ts
/** Pure: the id `delta` steps from `current` in `ids`, clamped at both ends (no wrap). Falls back to
 *  the first id when `current` is absent/unknown. Undefined for an empty list. Drives j/k cursor moves. */
export function moveCursor(ids: string[], current: string | undefined, delta: number): string | undefined {
    if (ids.length === 0) {
        return undefined;
    }
    const idx = current != null ? ids.indexOf(current) : -1;
    if (idx === -1) {
        return ids[0];
    }
    return ids[Math.max(0, Math.min(ids.length - 1, idx + delta))];
}
```

- [ ] **Step 4: Run it; verify it passes.**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts -t moveCursor`
Expected: PASS (3 tests).

- [ ] **Step 5: Checkpoint (no commit).** `git add frontend/app/view/agents/agentsviewmodel.ts frontend/app/view/agents/agentsviewmodel.test.ts`

---

### Task 4: Remove grid-sizing exports

**Files:**
- Modify: `frontend/app/view/agents/agentsviewmodel.ts:176-207`
- Modify: `frontend/app/view/agents/agentsviewmodel.test.ts`

These exports (`PanelPreset`, `PANEL_PRESETS`, `DEFAULT_PANEL_PRESET`, `resolveHeight`, `snapToPreset`) only served the grid's resize/drag, which is being removed. `reorderList`, `mergeOrder`, `nextAskId` stay.

- [ ] **Step 1: Delete the block.** In `agentsviewmodel.ts`, delete the contiguous block from `export type PanelPreset = "s" | "m" | "l" | "full";` through the end of the `snapToPreset` function (the block documented "Pre-determined working-panel sizes…" / "Resolve a preset's height…" / "map a freely-dragged width/height…"). Leave `reorderList` and everything after it intact.

- [ ] **Step 2: Update the test import.** In `agentsviewmodel.test.ts`, remove `snapToPreset` from the top import statement (line 2). Then delete the entire `describe("snapToPreset", … )` block in that file.

- [ ] **Step 3: Run the full agents suite; verify green.**

Run: `npx vitest run frontend/app/view/agents`
Expected: PASS, no reference to `snapToPreset`/`PANEL_PRESETS`. (Compile errors here would mean a leftover reference — `agents.tsx` still imports these but is rewritten in Task 8; if Vitest fails to load `agents.tsx`, ignore — Vitest only loads `*.test.ts`. If it does surface, proceed; Task 8 fixes the importer.)

- [ ] **Step 4: Checkpoint (no commit).** `git add frontend/app/view/agents/agentsviewmodel.ts frontend/app/view/agents/agentsviewmodel.test.ts`

---

## Phase 2 — Components

### Task 5: Controlled, numbered `AnswerBar` with confirmation

**Files:**
- Modify: `frontend/app/view/agents/answerbar.tsx` (full rewrite of the file)

The view will own answer selection state (so the keymap and mouse clicks write the same place). `AnswerBar` becomes presentational: it renders selections from props, reports option clicks via `onToggle`, and submits via `onSubmit`. Mouse rule preserved: single-select submits on click; multi-select waits. Keyboard (driven by the view in Task 9) calls `onToggle` for digits and `onSubmit` for Enter. Number badges (1–9) render on the **first** question's options only (keyboard limitation, documented).

**Adaptive option layout:** when **any** option in a question has a `description`, render the options as **stacked rows** (number badge + bold label + description on its own line) — like the native AskUserQuestion UI, readable top-to-bottom. When **no** option has a description, render compact **wrapping chips** (label only). This keeps short asks (`Yes/No`) tight while making rich, descriptive asks scannable. The ask is never clamped either way.

- [ ] **Step 1: Replace the file contents** with:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { type AgentAskQuestion, type AgentVM } from "./agentsviewmodel";

function QuestionGroup({
    question,
    qi,
    numbered,
    selections,
    onClickOption,
}: {
    question: AgentAskQuestion;
    qi: number;
    numbered?: boolean;
    selections: Set<number>;
    onClickOption: (oi: number) => void;
}) {
    const options = question.options ?? [];
    // rich asks (any option has a description) read better as stacked rows; bare label-only asks
    // stay as compact wrapping chips. Keyboard number badges (1-9) only on the first question.
    const stacked = options.some((o) => o.description);
    // Claude Code's AskUserQuestion payload has no separate "recommended" flag — by convention it
    // appends the literal "(Recommended)" marker to the option label, so this substring is the only signal.
    const isRec = (label: string) => label.toLowerCase().includes("(recommended)");
    return (
        <div className={cn("mt-3", qi > 0 && "border-t border-border pt-3")}>
            {question.header ? (
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">{question.header}</div>
            ) : null}
            <div className="text-[14px] font-semibold text-primary">{question.question}</div>
            {options.length === 0 ? null : stacked ? (
                <div className="mt-2.5 flex flex-col gap-1.5">
                    {options.map((opt, oi) => {
                        const isSelected = selections.has(oi);
                        const isRecommended = isRec(opt.label);
                        const showNum = numbered && qi === 0 && oi < 9;
                        return (
                            <button
                                key={oi}
                                type="button"
                                onClick={() => onClickOption(oi)}
                                className={cn(
                                    "flex w-full cursor-pointer items-start gap-2.5 rounded-[8px] border px-3 py-2 text-left transition-colors",
                                    isSelected
                                        ? "border-accent bg-accent/15"
                                        : isRecommended
                                          ? "border-accent/60 hover:bg-accent/10"
                                          : "border-border hover:bg-white/[0.04]"
                                )}
                            >
                                {showNum ? (
                                    <span className="mt-px inline-flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded-[4px] bg-black/30 font-mono text-[10px] text-secondary">
                                        {oi + 1}
                                    </span>
                                ) : null}
                                <span className="min-w-0">
                                    <span
                                        className={cn(
                                            "text-[13px] font-semibold",
                                            isSelected ? "text-primary" : isRecommended ? "text-accent" : "text-secondary"
                                        )}
                                    >
                                        {opt.label}
                                    </span>
                                    {opt.description ? (
                                        <span className={cn("mt-0.5 block text-[12px] leading-[1.5]", isSelected ? "text-primary/75" : "text-muted")}>
                                            {opt.description}
                                        </span>
                                    ) : null}
                                </span>
                            </button>
                        );
                    })}
                </div>
            ) : (
                <div className="mt-2.5 flex flex-wrap gap-2">
                    {options.map((opt, oi) => {
                        const isSelected = selections.has(oi);
                        const isRecommended = isRec(opt.label);
                        const showNum = numbered && qi === 0 && oi < 9;
                        return (
                            <button
                                key={oi}
                                type="button"
                                onClick={() => onClickOption(oi)}
                                className={cn(
                                    "flex cursor-pointer items-center gap-2 rounded-[6px] px-3 py-1 text-[12px] transition-colors",
                                    isSelected
                                        ? "bg-accent/80 font-semibold text-primary hover:bg-accent"
                                        : isRecommended
                                          ? "border border-accent font-semibold text-accent hover:bg-accent/10"
                                          : "border border-border text-secondary hover:bg-white/[0.04]"
                                )}
                            >
                                {showNum ? (
                                    <span className="inline-flex h-[16px] w-[16px] items-center justify-center rounded-[4px] bg-black/30 font-mono text-[10px] text-secondary">
                                        {oi + 1}
                                    </span>
                                ) : null}
                                <span>{opt.label}</span>
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

// Amber answer surface for an asking agent. Selection state is owned by the parent (so the keyboard
// triage keymap and mouse clicks write the same place). Mouse: single-select submits on click,
// multi-select waits for the parent's submit (Enter). When `sent`, shows a confirmation in place.
export function AnswerBar({
    agent,
    selections,
    sent,
    numbered,
    onToggle,
    onSubmit,
    className,
}: {
    agent: AgentVM;
    selections: Record<number, Set<number>>;
    sent?: boolean;
    numbered?: boolean;
    onToggle: (qi: number, oi: number) => void;
    onSubmit: () => void;
    className?: string;
}) {
    const questions = agent.ask?.questions ?? [];
    if (questions.length === 0) {
        return null;
    }
    if (sent) {
        const chosen = questions
            .flatMap((q, qi) => Array.from(selections[qi] ?? []).map((oi) => q.options?.[oi]?.label ?? ""))
            .filter(Boolean);
        return (
            <div className={cn("text-[12px] text-secondary", className)}>
                <span className="text-accent">✓</span> Answered{chosen.length ? `: ${chosen.join(", ")}` : ""}
            </div>
        );
    }
    const needsConfirm = questions.some((q) => q.multiSelect);
    return (
        <div className={className}>
            {questions.map((q, qi) => (
                <QuestionGroup
                    key={qi}
                    question={q}
                    qi={qi}
                    numbered={numbered}
                    selections={selections[qi] ?? new Set()}
                    onClickOption={(oi) => {
                        onToggle(qi, oi);
                        if (!q.multiSelect) {
                            onSubmit();
                        }
                    }}
                />
            ))}
            {needsConfirm ? <div className="mt-2 text-[11px] text-muted">press Enter to submit</div> : null}
        </div>
    );
}
```

- [ ] **Step 2: Verify the suite still loads/green.**

Run: `npx vitest run frontend/app/view/agents`
Expected: PASS (no test imports `AnswerBar`; this confirms `agentsviewmodel.ts` types still resolve).

- [ ] **Step 3: Verify no TypeScript errors** for `answerbar.tsx` in the VSCode Problems panel. (`outputpanel.tsx` and `agents.tsx` will still show errors here — they're handled in Tasks 7–8.)

- [ ] **Step 4: Checkpoint (no commit).** `git add frontend/app/view/agents/answerbar.tsx`

---

### Task 6: `narrationtimeline.tsx` — add a `large` prop

**Files:**
- Modify: `frontend/app/view/agents/narrationtimeline.tsx`

The focus view needs bigger narration text. Add a `large` prop that bumps message/action font sizes; default (rows/elsewhere) is unchanged.

- [ ] **Step 1: Add the prop to the signature.** Change the destructured props and type to include `large`:

```tsx
export function NarrationTimeline({
    entries,
    accentLatest,
    large,
    className,
}: {
    entries: AgentEntry[];
    accentLatest?: boolean;
    large?: boolean;
    className?: string;
}) {
```

- [ ] **Step 2: Apply `large` to the three entry sizes.** In the `message` branch, change `"mt-2.5 text-[13px]"` to `cn("mt-2.5", large ? "text-[15px]" : "text-[13px]")`. In the `user` branch, change `"... text-[12px] text-muted"` to include `large ? "text-[13px]" : "text-[12px]"`. In the `action` branch, change `font-mono text-[12px]` to `cn("... font-mono", large ? "text-[13px]" : "text-[12px]")`. (Keep all other classes identical; `cn` is already imported.)

- [ ] **Step 3: Verify** no TypeScript errors for `narrationtimeline.tsx` in the Problems panel, and the suite still loads: `npx vitest run frontend/app/view/agents` → PASS.

- [ ] **Step 4: Checkpoint (no commit).** `git add frontend/app/view/agents/narrationtimeline.tsx`

---

### Task 7: Create `agentrow.tsx`

**Files:**
- Create: `frontend/app/view/agents/agentrow.tsx`

One list row. Reads live entries/activity atoms at the top (hooks rule). Working/idle: header + clamped prose (left) + steps (right), two-column collapsing to one under ~820px. Ask: header + `AnswerBar` (full width, amber tint from the row). Cursor highlight via an inset box-shadow (teal working / amber ask). Lightweight HTML5 drag handle for reorder. No inline composer.

- [ ] **Step 1: Create the file** with:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useLayoutEffect, useRef, useState } from "react";
import { AnswerBar } from "./answerbar";
import { formatAge, isQuiet, latestMessageText, recentActions, type AgentVM } from "./agentsviewmodel";
import { lastActivityByIdAtom, liveEntriesByIdAtom } from "./livetranscript";
import { projectNameFromTranscriptPath } from "./projectname";
import { StatusDot } from "./statusdot";

const StepCount = 3;
const WorkingClampPx = 66; // ~3 lines at 13px / 1.6 line-height

export function AgentRow({
    agent,
    now,
    isCursor,
    selections,
    sent,
    onCursor,
    onOpen,
    onToggleAnswer,
    onSubmitAnswer,
    onDismiss,
    onDragStart,
    onDropOn,
}: {
    agent: AgentVM;
    now: number;
    isCursor: boolean;
    selections: Record<number, Set<number>>;
    sent: boolean;
    onCursor: () => void;
    onOpen: () => void;
    onToggleAnswer: (qi: number, oi: number) => void;
    onSubmitAnswer: () => void;
    onDismiss?: () => void;
    onDragStart: () => void;
    onDropOn: (before: boolean) => void;
}) {
    const liveEntries = useAtomValue(liveEntriesByIdAtom);
    const lastActivity = useAtomValue(lastActivityByIdAtom);
    const entries = liveEntries[agent.id] ?? agent.previousInfo ?? [];
    const quiet = isQuiet(lastActivity[agent.id], now);
    const project = projectNameFromTranscriptPath(agent.transcriptPath);
    const asking = agent.state === "asking";
    const idle = agent.state === "idle";
    const idleMs = agent.idleSince != null ? Math.max(0, now - agent.idleSince) : undefined;
    const msg = latestMessageText(entries) ?? agent.activity ?? "";
    const steps = recentActions(entries, StepCount);

    const proseRef = useRef<HTMLDivElement>(null);
    const [clamped, setClamped] = useState(false);
    useLayoutEffect(() => {
        const el = proseRef.current;
        if (el) {
            setClamped(el.scrollHeight - el.clientHeight > 2);
        }
    }, [msg]);

    return (
        <div
            data-agent-id={agent.id}
            onClick={onCursor}
            onDoubleClick={onOpen}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                onDropOn(e.clientY < r.top + r.height / 2);
            }}
            className={cn(
                "group relative cursor-pointer border-b border-border px-[22px] py-3 transition-colors",
                asking ? "bg-warning/5" : "hover:bg-white/[0.02]",
                isCursor &&
                    (asking
                        ? "bg-warning/10 shadow-[inset_3px_0_0_var(--color-warning)]"
                        : "bg-accent/[0.06] shadow-[inset_3px_0_0_var(--color-accent)]")
            )}
        >
            <div className="flex items-center gap-2.5">
                <span
                    draggable
                    onDragStart={(e) => {
                        e.stopPropagation();
                        onDragStart();
                    }}
                    onClick={(e) => e.stopPropagation()}
                    title="Drag to reorder"
                    className="shrink-0 cursor-grab select-none text-[11px] text-muted opacity-0 transition-opacity group-hover:opacity-100 active:cursor-grabbing"
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
            </div>

            {asking ? (
                <AnswerBar
                    agent={agent}
                    selections={selections}
                    sent={sent}
                    numbered
                    onToggle={onToggleAnswer}
                    onSubmit={onSubmitAnswer}
                    className="ml-[26px]"
                />
            ) : (
                <div className="mt-2 ml-[26px] grid grid-cols-[minmax(0,1.7fr)_minmax(180px,0.85fr)] gap-6 max-[820px]:grid-cols-1 max-[820px]:gap-2">
                    <div className="relative" style={{ maxHeight: WorkingClampPx, overflow: "hidden" }}>
                        <div ref={proseRef} className="whitespace-pre-wrap text-[13px] leading-[1.6] text-secondary">
                            {msg}
                        </div>
                        {clamped ? (
                            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-5 bg-gradient-to-t from-background to-transparent" />
                        ) : null}
                    </div>
                    {steps.length > 0 ? (
                        <div className="border-l border-border pl-3.5 font-mono text-[12px] leading-[1.95] text-muted">
                            {steps.map((s, i) => (
                                <div key={i}>
                                    <span className="inline-block w-11 text-secondary/70">{s.verb}</span>
                                    {s.target}
                                    {s.outcome ? (
                                        <span className={cn("ml-1", s.outcome === "ok" ? "text-accent" : "text-error")}>
                                            {s.outcome === "ok" ? "✓" : "✗"}
                                        </span>
                                    ) : null}
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div />
                    )}
                </div>
            )}
        </div>
    );
}
```

- [ ] **Step 2: Verify** no TypeScript errors for `agentrow.tsx` in the Problems panel; suite still loads (`npx vitest run frontend/app/view/agents` → PASS).

- [ ] **Step 3: Checkpoint (no commit).** `git add frontend/app/view/agents/agentrow.tsx`

---

### Task 8: Create `focusview.tsx`

**Files:**
- Create: `frontend/app/view/agents/focusview.tsx`

Full-bleed single agent. Carries over the scroll-stick + "↓ N new" pill from `outputpanel.tsx`. Header with back/identity/terminal/prev-next. Large narration. Answer bar + composer at the bottom. Autofocuses the composer when opened via reply.

- [ ] **Step 1: Create the file** with:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { AgentComposer } from "./agentcomposer";
import { AnswerBar } from "./answerbar";
import { formatAge, type AgentVM } from "./agentsviewmodel";
import { liveEntriesByIdAtom } from "./livetranscript";
import { NarrationTimeline } from "./narrationtimeline";
import { projectNameFromTranscriptPath } from "./projectname";
import { StatusDot } from "./statusdot";

export function FocusView({
    agent,
    now,
    autofocusComposer,
    hasPrev,
    hasNext,
    selections,
    sent,
    onBack,
    onPrev,
    onNext,
    onOpenTerminal,
    onToggleAnswer,
    onSubmitAnswer,
}: {
    agent: AgentVM;
    now: number;
    autofocusComposer: boolean;
    hasPrev: boolean;
    hasNext: boolean;
    selections: Record<number, Set<number>>;
    sent: boolean;
    onBack: () => void;
    onPrev: () => void;
    onNext: () => void;
    onOpenTerminal: () => void;
    onToggleAnswer: (qi: number, oi: number) => void;
    onSubmitAnswer: () => void;
}) {
    const liveEntries = useAtomValue(liveEntriesByIdAtom);
    const entries = liveEntries[agent.id] ?? agent.previousInfo ?? [];
    const project = projectNameFromTranscriptPath(agent.transcriptPath);
    const asking = agent.state === "asking";
    const idle = agent.state === "idle";
    const idleMs = agent.idleSince != null ? Math.max(0, now - agent.idleSince) : undefined;

    const scrollRef = useRef<HTMLDivElement>(null);
    const stickRef = useRef(true);
    const prevLenRef = useRef(entries.length);
    const [newCount, setNewCount] = useState(0);
    const composerWrapRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const added = entries.length - prevLenRef.current;
        prevLenRef.current = entries.length;
        const el = scrollRef.current;
        if (el && stickRef.current) {
            el.scrollTop = el.scrollHeight;
            setNewCount(0);
        } else if (added > 0) {
            setNewCount((n) => n + added);
        }
    }, [entries]);

    useEffect(() => {
        if (autofocusComposer) {
            composerWrapRef.current?.querySelector("textarea")?.focus();
        }
    }, [autofocusComposer, agent.id]);

    const onScroll = () => {
        const el = scrollRef.current;
        if (!el) {
            return;
        }
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        if (stickRef.current) {
            setNewCount(0);
        }
    };

    const jumpToLatest = () => {
        const el = scrollRef.current;
        if (!el) {
            return;
        }
        el.scrollTop = el.scrollHeight;
        stickRef.current = true;
        setNewCount(0);
    };

    return (
        <div className="flex h-full w-full flex-col bg-background">
            <div className="flex shrink-0 items-center gap-3 border-b border-border px-[18px] py-3">
                <button type="button" onClick={onBack} title="Back (Esc)" className="cursor-pointer text-[18px] leading-none text-muted hover:text-secondary">
                    ←
                </button>
                <StatusDot state={agent.state} />
                <b className="text-[17px] text-primary">{agent.name}</b>
                <span className="truncate text-[13px] text-muted">
                    {project ? `${project} · ` : ""}
                    {agent.task}
                </span>
                <span className="ml-auto shrink-0 text-[12px] tabular-nums text-muted">
                    {agent.model ? `${agent.model} · ` : ""}
                    {idle ? `${formatAge(idleMs)} idle` : formatAge(agent.activeMs)}
                </span>
                <button
                    type="button"
                    onClick={onOpenTerminal}
                    title="Open terminal"
                    className="shrink-0 cursor-pointer rounded-[6px] border border-border px-2 py-1 text-[12px] text-secondary hover:bg-white/[0.04]"
                >
                    ↗ terminal
                </button>
                <span className="flex shrink-0 items-center text-[15px] text-muted">
                    <button type="button" disabled={!hasPrev} onClick={onPrev} title="Previous agent" className="cursor-pointer px-1 hover:text-secondary disabled:opacity-30">
                        ‹
                    </button>
                    <button type="button" disabled={!hasNext} onClick={onNext} title="Next agent" className="cursor-pointer px-1 hover:text-secondary disabled:opacity-30">
                        ›
                    </button>
                </span>
            </div>

            <div ref={scrollRef} onScroll={onScroll} className={cn("relative min-h-0 flex-1 overflow-y-auto px-[22px] py-[16px]", asking && "opacity-90")}>
                <NarrationTimeline entries={entries} accentLatest large />
                <AnimatePresence>
                    {newCount > 0 ? (
                        <motion.button
                            key="newpill"
                            type="button"
                            onClick={jumpToLatest}
                            initial={{ opacity: 0, y: 8, scale: 0.9 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, y: 8, scale: 0.9 }}
                            transition={{ type: "spring", stiffness: 500, damping: 26 }}
                            className="sticky bottom-3 left-1/2 ml-[-40px] cursor-pointer rounded-full bg-accent px-3 py-1 text-[11px] font-semibold text-white shadow-lg"
                        >
                            ↓ {newCount} new
                        </motion.button>
                    ) : null}
                </AnimatePresence>
            </div>

            {asking ? (
                <AnswerBar
                    agent={agent}
                    selections={selections}
                    sent={sent}
                    numbered
                    onToggle={onToggleAnswer}
                    onSubmit={onSubmitAnswer}
                    className="shrink-0 border-t border-warning bg-warning/5 px-[18px] py-3"
                />
            ) : null}
            <div ref={composerWrapRef}>
                <AgentComposer blockId={agent.blockId} placeholder={`message ${agent.name}…`} />
            </div>
        </div>
    );
}
```

- [ ] **Step 2: Verify** no TypeScript errors for `focusview.tsx`; suite still loads.

- [ ] **Step 3: Checkpoint (no commit).** `git add frontend/app/view/agents/focusview.tsx`

---

## Phase 3 — Assemble the view

### Task 9: Rewrite `AgentsView` in `agents.tsx`

**Files:**
- Modify: `frontend/app/view/agents/agents.tsx` (replace everything above the `AgentsViewModel` class; keep the class unchanged)
- Delete: `frontend/app/view/agents/outputpanel.tsx`

This is the core task. It wires the list, cursor, keymap, focus routing, hint bar, `?` overlay, and retains reorder. The `AgentsViewModel` class at the bottom of the file is unchanged.

- [ ] **Step 1: Delete `outputpanel.tsx`.**

Run: `git rm frontend/app/view/agents/outputpanel.tsx`

- [ ] **Step 2: Replace the top of `agents.tsx`.** Replace everything from the top of the file through the end of the `AgentsView` function (i.e. up to but not including `export class AgentsViewModel`) with:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { BlockNodeModel } from "@/app/block/blocktypes";
import { getApi, setActiveTab } from "@/app/store/global";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import type { TabModel } from "@/app/store/tab-model";
import { atom, useAtomValue, type Atom } from "jotai";
import { cn, fireAndForget } from "@/util/util";
import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
    buildAskAnswers,
    canSubmitAsk,
    groupAgents,
    isRecentlyIdle,
    mergeOrder,
    moveCursor,
    nextAskId,
    reorderList,
    type AgentVM,
} from "./agentsviewmodel";
import { ensurePreviousInfo, liveAgentsAtom } from "./liveagents";
import { mockAgentsAtom, USE_MOCK_AGENTS } from "./mockagents";
import { startTranscriptStream, stopTranscriptStream } from "./livetranscript";
import { AgentRow } from "./agentrow";
import { FocusView } from "./focusview";
import { IdleSection } from "./idlesection";

// Rolls a changing integer: the old value slides up and out while the new one slides in.
function RollingCount({ value, className }: { value: number; className?: string }) {
    return (
        <span className={cn("relative inline-flex overflow-hidden align-baseline", className)}>
            <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                    key={value}
                    initial={{ y: "-100%", opacity: 0 }}
                    animate={{ y: "0%", opacity: 1 }}
                    exit={{ y: "100%", opacity: 0 }}
                    transition={{ duration: 0.2, ease: "easeOut" }}
                    className="tabular-nums"
                >
                    {value}
                </motion.span>
            </AnimatePresence>
        </span>
    );
}

const HINTS: [string, string][] = [
    ["↑↓ / j k", "move"],
    ["n", "next ask"],
    ["1–9", "answer"],
    ["↵", "open / confirm"],
    ["r", "reply"],
    ["esc", "back"],
];

function HelpOverlay({ onClose }: { onClose: () => void }) {
    const rows: [string, string][] = [
        ["↑ / k", "move cursor up"],
        ["↓ / j", "move cursor down"],
        ["n", "jump to next ask"],
        ["1–9", "select an answer option"],
        ["↵ (Enter)", "confirm selected answer, else open focus view"],
        ["r", "open focus view and reply"],
        ["esc", "leave focus view / close this"],
        ["?", "toggle this help"],
    ];
    return (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
            <div className="min-w-[320px] rounded-[10px] border border-border bg-background p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
                <div className="mb-2 text-[13px] font-semibold text-primary">Keyboard</div>
                {rows.map(([k, d]) => (
                    <div key={k} className="flex items-center justify-between gap-6 py-1 text-[12px]">
                        <span className="font-mono text-secondary">{k}</span>
                        <span className="text-muted">{d}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}

function AgentsView({ model }: { model: AgentsViewModel }) {
    const agents = useAtomValue(model.agentsAtom);
    const { asking, working, idle } = groupAgents(agents);
    const answer = (oref: string, answers: AgentAnswerItem[]) => {
        if (!oref) {
            return;
        }
        fireAndForget(() => RpcApi.AnswerAgentCommand(TabRpcClient, { oref, answers }));
    };

    // 1s tick so the liveness cue (age / quiet) stays current without a global ticker
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const t = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
    }, []);

    // A just-finished agent keeps its full row (so you can reply) for the grace window, then collapses
    // into the Idle list. Dismissals are keyed by idle episode (id:idleSince).
    const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
    const dismissKey = (a: AgentVM) => `${a.id}:${a.idleSince ?? ""}`;
    const recentlyIdle = idle.filter((a) => isRecentlyIdle(a, now) && !dismissed.has(dismissKey(a)));
    const recentIds = new Set(recentlyIdle.map((a) => a.id));
    const parkedIdle = idle.filter((a) => !recentIds.has(a.id));
    const listAgents = [...asking, ...working, ...recentlyIdle];

    // one-shot previous-info for asking agents (seeds first paint; the live stream supersedes it)
    useEffect(() => {
        for (const a of asking) {
            if (a.transcriptPath) {
                void ensurePreviousInfo(a.id, a.transcriptPath, a.agent);
            }
        }
    }, [asking]);

    // open a live transcript stream per visible asking/working agent; stop streams that left the set
    const streamedRef = useRef<Set<string>>(new Set());
    useEffect(() => {
        const wantedById = new Map<string, { path: string; agent?: string }>();
        for (const a of [...asking, ...working]) {
            if (a.transcriptPath) {
                wantedById.set(a.id, { path: a.transcriptPath, agent: a.agent });
            }
        }
        for (const [id, { path, agent }] of wantedById) {
            if (!streamedRef.current.has(id)) {
                startTranscriptStream(id, path, agent);
                streamedRef.current.add(id);
            }
        }
        for (const id of [...streamedRef.current]) {
            if (!wantedById.has(id)) {
                stopTranscriptStream(id);
                streamedRef.current.delete(id);
            }
        }
    }, [asking, working]);

    useEffect(() => {
        return () => {
            for (const id of streamedRef.current) {
                stopTranscriptStream(id);
            }
            streamedRef.current.clear();
        };
    }, []);

    // anchored order (kept ids hold their slot; new ids append) + manual drag reorder
    const [order, setOrder] = useState<string[]>([]);
    const [dragId, setDragId] = useState<string>();
    useEffect(() => {
        const ids = listAgents.map((a) => a.id);
        setOrder((prev) => mergeOrder(prev, ids));
    }, [listAgents.map((a) => a.id).join(",")]);
    const orderedList = order.map((id) => listAgents.find((a) => a.id === id)).filter(Boolean) as AgentVM[];
    const orderedIds = orderedList.map((a) => a.id);

    // cursor + answer selection + focus + help
    const [cursorId, setCursorId] = useState<string>();
    const [answerSel, setAnswerSel] = useState<Record<string, Record<number, Set<number>>>>({});
    const [sentIds, setSentIds] = useState<Set<string>>(() => new Set());
    const [focusId, setFocusId] = useState<string>();
    const [focusReply, setFocusReply] = useState(false);
    const [showHelp, setShowHelp] = useState(false);
    const [pulseId, setPulseId] = useState<string>();
    const lastJumpRef = useRef<string>();
    const containerRef = useRef<HTMLDivElement>(null);

    // keep the cursor valid as the set changes; seed it to the first row
    useEffect(() => {
        if (orderedIds.length === 0) {
            if (cursorId != null) setCursorId(undefined);
            return;
        }
        if (cursorId == null || !orderedIds.includes(cursorId)) {
            setCursorId(orderedIds[0]);
        }
    }, [orderedIds.join(",")]);

    const scrollToPulse = (id: string) => {
        document.querySelector(`[data-agent-id="${id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
        setPulseId(id);
        setTimeout(() => setPulseId((p) => (p === id ? undefined : p)), 1200);
    };

    const toggleAnswer = (id: string, qi: number, oi: number) => {
        setAnswerSel((prev) => {
            const a = agents.find((x) => x.id === id);
            const q = a?.ask?.questions?.[qi];
            const forAgent = { ...(prev[id] ?? {}) };
            const set = new Set(forAgent[qi] ?? []);
            if (q?.multiSelect) {
                if (set.has(oi)) set.delete(oi);
                else set.add(oi);
            } else {
                set.clear();
                set.add(oi);
            }
            forAgent[qi] = set;
            return { ...prev, [id]: forAgent };
        });
    };

    const submitAnswer = (id: string) => {
        const a = agents.find((x) => x.id === id);
        if (!a || sentIds.has(id)) {
            return;
        }
        const qs = a.ask?.questions ?? [];
        const sel = answerSel[id] ?? {};
        if (!canSubmitAsk(qs, sel)) {
            return;
        }
        answer(a.ask?.oref, buildAskAnswers(qs, sel));
        setSentIds((s) => new Set(s).add(id));
    };

    const openFocus = (id: string, reply: boolean) => {
        setFocusId(id);
        setFocusReply(reply);
    };

    const focusStep = (delta: number) => {
        setFocusId((cur) => moveCursor(orderedIds, cur, delta) ?? cur);
        setFocusReply(false);
    };

    const onKeyDown = (e: React.KeyboardEvent) => {
        const t = e.target as HTMLElement;
        if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) {
            return; // typing — let the input own its keys
        }
        // focus view: only back/prev/next
        if (focusId != null) {
            if (e.key === "Escape") {
                e.preventDefault();
                setFocusId(undefined);
            } else if (e.key === "ArrowLeft") {
                e.preventDefault();
                focusStep(-1);
            } else if (e.key === "ArrowRight") {
                e.preventDefault();
                focusStep(1);
            }
            return;
        }
        const cur = orderedList.find((a) => a.id === cursorId);
        if (e.key === "ArrowDown" || e.key === "j") {
            e.preventDefault();
            setCursorId((c) => moveCursor(orderedIds, c, 1));
        } else if (e.key === "ArrowUp" || e.key === "k") {
            e.preventDefault();
            setCursorId((c) => moveCursor(orderedIds, c, -1));
        } else if (e.key === "n") {
            e.preventDefault();
            const target = nextAskId(asking.map((a) => a.id), lastJumpRef.current);
            if (target) {
                lastJumpRef.current = target;
                setCursorId(target);
                scrollToPulse(target);
            }
        } else if (e.key === "Enter") {
            e.preventDefault();
            if (!cur) return;
            if (cur.state === "asking" && canSubmitAsk(cur.ask?.questions ?? [], answerSel[cur.id] ?? {})) {
                submitAnswer(cur.id);
            } else {
                openFocus(cur.id, false);
            }
        } else if (e.key === "r") {
            e.preventDefault();
            if (cursorId) openFocus(cursorId, true);
        } else if (e.key === "Escape") {
            if (showHelp) {
                e.preventDefault();
                setShowHelp(false);
            }
        } else if (e.key === "?") {
            e.preventDefault();
            setShowHelp((v) => !v);
        } else if (/^[1-9]$/.test(e.key)) {
            if (cur?.state === "asking") {
                const oi = parseInt(e.key, 10) - 1;
                const opts = cur.ask?.questions?.[0]?.options ?? [];
                if (oi < opts.length) {
                    e.preventDefault();
                    toggleAnswer(cur.id, 0, oi);
                }
            }
        }
    };

    const empty = asking.length === 0 && working.length === 0 && idle.length === 0;
    const focusAgent = focusId != null ? orderedList.find((a) => a.id === focusId) : undefined;

    if (focusAgent) {
        const i = orderedIds.indexOf(focusAgent.id);
        return (
            <div ref={containerRef} tabIndex={0} onKeyDown={onKeyDown} className="h-full w-full outline-none">
                <FocusView
                    agent={focusAgent}
                    now={now}
                    autofocusComposer={focusReply}
                    hasPrev={i > 0}
                    hasNext={i < orderedIds.length - 1}
                    selections={answerSel[focusAgent.id] ?? {}}
                    sent={sentIds.has(focusAgent.id)}
                    onBack={() => setFocusId(undefined)}
                    onPrev={() => focusStep(-1)}
                    onNext={() => focusStep(1)}
                    onOpenTerminal={() => setActiveTab(focusAgent.id)}
                    onToggleAnswer={(qi, oi) => toggleAnswer(focusAgent.id, qi, oi)}
                    onSubmitAnswer={() => submitAnswer(focusAgent.id)}
                />
            </div>
        );
    }

    return (
        <div
            ref={containerRef}
            tabIndex={0}
            onKeyDown={onKeyDown}
            className="relative flex h-full w-full flex-col text-secondary outline-none"
        >
            <div className="flex shrink-0 items-center justify-between border-b border-border px-[18px] py-3">
                <b className="text-[14px] font-semibold text-primary">Agents</b>
                <span className="flex items-center gap-2 text-[12px] text-muted">
                    {asking.length > 0 ? (
                        <button
                            type="button"
                            onClick={() => {
                                const target = nextAskId(asking.map((a) => a.id), lastJumpRef.current);
                                if (!target) return;
                                lastJumpRef.current = target;
                                setCursorId(target);
                                scrollToPulse(target);
                            }}
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
            </div>

            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
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

                <AnimatePresence mode="popLayout">
                    {orderedList.map((a) => (
                        <motion.div
                            key={a.id}
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.18 }}
                            className={cn(pulseId === a.id && "ring-2 ring-warning ring-inset")}
                        >
                            <AgentRow
                                agent={a}
                                now={now}
                                isCursor={cursorId === a.id}
                                selections={answerSel[a.id] ?? {}}
                                sent={sentIds.has(a.id)}
                                onCursor={() => setCursorId(a.id)}
                                onOpen={() => openFocus(a.id, false)}
                                onToggleAnswer={(qi, oi) => toggleAnswer(a.id, qi, oi)}
                                onSubmitAnswer={() => submitAnswer(a.id)}
                                onDismiss={a.state === "idle" ? () => setDismissed((prev) => new Set(prev).add(dismissKey(a))) : undefined}
                                onDragStart={() => setDragId(a.id)}
                                onDropOn={(before) => {
                                    if (dragId) {
                                        setOrder((o) => reorderList(o, dragId, a.id, before));
                                    }
                                    setDragId(undefined);
                                }}
                            />
                        </motion.div>
                    ))}
                </AnimatePresence>

                <div className="px-[18px]">
                    <IdleSection agents={parkedIdle} onOpen={(id) => setActiveTab(id)} />
                </div>
            </div>

            {!empty ? (
                <div className="flex shrink-0 items-center gap-4 border-t border-border bg-background px-[18px] py-1.5 text-[11px] text-muted">
                    {HINTS.map(([k, d]) => (
                        <span key={k} className="flex items-center gap-1">
                            <span className="rounded-[4px] bg-white/[0.06] px-1.5 py-0.5 font-mono text-secondary">{k}</span>
                            {d}
                        </span>
                    ))}
                    <button type="button" onClick={() => setShowHelp(true)} className="ml-auto cursor-pointer font-mono hover:text-secondary">
                        ?
                    </button>
                </div>
            ) : null}

            {showHelp ? <HelpOverlay onClose={() => setShowHelp(false)} /> : null}
        </div>
    );
}
```

- [ ] **Step 3: Confirm the `AgentsViewModel` class below is untouched** and still reads `USE_MOCK_AGENTS && getApi().getIsDev() ? mockAgentsAtom : liveAgentsAtom`. (`getApi` import is retained above.)

- [ ] **Step 4: Verify the suite still loads and is green.**

Run: `npx vitest run frontend/app/view/agents`
Expected: PASS.

- [ ] **Step 5: Verify no TypeScript errors** across the agents folder in the Problems panel — specifically `agents.tsx`, `agentrow.tsx`, `focusview.tsx`, `answerbar.tsx`, `narrationtimeline.tsx`. Fix any (common ones: unused imports left over from the old grid such as `useDimensionsWithCallbackRef`, `createPortal`, `PANEL_PRESETS`, `DraggablePanel`, `resolveHeight`, `snapToPreset`, `DEFAULT_PANEL_PRESET`, `PanelPreset` — all must be gone).

- [ ] **Step 6: Checkpoint (no commit).** `git add -A frontend/app/view/agents/`

---

## Phase 4 — Verify in the running app

### Task 10: Visual + interaction verification in the dev app

**Files:** none (verification only)

Use the running dev Electron app over CDP (port 9222 — see the project's "CDP verify dev app" note) or by hand. If the app isn't running, start it with `task dev` (or `npm run dev`) and open the Agents view with several agents (the dev mock roster: `mockagents.ts` is active when `USE_MOCK_AGENTS && getIsDev()`).

- [ ] **Step 1: Overview at scale.** With 5+ agents, confirm: single-column list; working rows show clamped prose (left) + tool steps (right) with a fade when long; asks show full question + numbered chips and stand out (amber); Idle collapses at the bottom; the key-hint bar is pinned at the bottom.
- [ ] **Step 2: Keyboard triage.** Click into the view, then: `j`/`k` (and arrows) move the cursor with a visible highlight, clamped at ends; `n` cycles to the next ask, scrolls + pulses; `1`–`9` selects an answer option (highlight only, no send); `↵` confirms and the row shows "✓ Answered…" and stays put; `↵` on a non-asking row opens the focus view; `r` opens focus + composer focused; `Esc` returns; `?` toggles the cheatsheet.
- [ ] **Step 2b: Ask layouts.** Confirm a label-only ask (e.g. `Yes/No`) renders as compact chips, and an ask whose options carry descriptions renders as stacked rows (number + label + description per row). Number keys select the right option in both.
- [ ] **Step 3: Focus arbitration.** With a composer focused (in focus view), confirm single-letter keys (`j`, `n`, `r`) type into the textarea and do NOT trigger shortcuts. Confirm shortcuts do nothing when another block/terminal holds focus (the handler is scoped to the view).
- [ ] **Step 4: Reorder.** Drag a row by its `⠿` handle onto another; confirm the order changes and persists across state changes (anchored ordering).
- [ ] **Step 5: Regression run.** `npx vitest run frontend/app/view/agents` → all PASS.

---

### Task 11: Final review & single commit (requires approval)

**Files:** none (git only)

- [ ] **Step 1: Self-review the diff.** `git --no-pager diff --staged` — confirm no leftover grid code, no commented-out blocks, no debug logs; `outputpanel.tsx` is deleted.
- [ ] **Step 2: Show the user the staged file list + summary and the proposed message, then ask for explicit approval** (per the user's git workflow). Proposed message:

```
feat(agents): list + focus view + keyboard triage redesign

Replace the 2-column panel grid with a density-adaptive single-column list:
full ask rows, working rows clamped to ~3 lines with a tool-steps column, and
a full-bleed focus view for reading one agent. Add a focus-aware keyboard
keymap (j/k move, n next ask, 1-9 select, Enter confirm/open, r reply, ? help).
Keep manual reorder and anchored ordering; drop per-panel resize presets.
```

- [ ] **Step 3: On approval only,** commit the single staged changeset. Do not push unless asked.

---

## Self-Review (performed against the spec)

**1. Spec coverage**
- §1 Layout (list, sections, header, nav-width survival) → Task 9 (list render, `max-[820px]` collapse in Task 7). *Deviation:* asks are not hard-pinned to top (anchored ordering kept) — called out in the policy note for user confirmation.
- §2 Ask rows full/never clamped; working rows two-column clamped + steps; idle unchanged → Tasks 7 (row), 5 (answer), 9 (IdleSection retained).
- §3 Focus view (header, big narration, composer, answer, ‹ ›, ←/Esc) → Tasks 6 (large narration), 8 (focus view), 9 (routing + nav).
- §4 Keyboard triage (focus arbitration, cursor, keymap, select-then-confirm, stay-put, hint bar, `?`) → Task 9 (keymap + guards + hint bar + overlay), Task 5 (numbered chips + confirmation), Task 10 step 3 (arbitration verification).
- §5 Reorder kept → Task 9 (drag handlers + `reorderList`/`mergeOrder`), Task 7 (handle).
- §6 Removal (grid, resize presets, fillPx) → Task 4 (model exports), Task 9 (component), Task 9 step 1 (`outputpanel.tsx` deleted).
- §7 Components affected → matches the File Structure section.
- §8 Testing → Tasks 1–4 (pure helpers TDD), Task 10 (interaction), regression runs throughout.

**2. Placeholder scan:** none — every code step contains complete code; no "TBD"/"add error handling"/"similar to".

**3. Type consistency:** `latestMessageText`, `recentActions` (returns `AgentActionEntry[]`), `moveCursor` signatures match across Tasks 1–3 and their uses in Tasks 7–9. `AnswerBar` props (`agent`, `selections`, `sent`, `numbered`, `onToggle`, `onSubmit`, `className`) match between Task 5 (definition) and Tasks 7/8 (callers). `AgentRow` and `FocusView` prop shapes match their call sites in Task 9. View-owned state types (`answerSel: Record<string, Record<number, Set<number>>>`) are consistent with `toggleAnswer`/`submitAnswer`/`buildAskAnswers`/`canSubmitAsk` usage.
