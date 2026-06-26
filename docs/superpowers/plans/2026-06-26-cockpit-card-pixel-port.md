# Cockpit Card Pixel-Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Cockpit live-agent card (`AgentRow`) to match the handoff's banded layout, controls, and feed exactly, keeping the burst-collapse feature and rendering the data-starved affordances (diff stats, task list) from clearly-marked placeholder data.

**Architecture:** The card becomes a `flex flex-col` of self-padded bands (header bar → asking band → scrolling feed → answer/composer → resize). The feed renderer (`NarrationTimeline`, card-only caller) is restyled to the handoff lane look. Composer-collapse state lifts to a model atom so the `R` keybinding can open+focus it. Diff/task data comes from deterministic pure placeholder helpers; real wiring is deferred.

**Tech Stack:** React 19, Tailwind v4 `@theme` tokens, jotai, motion/react. Frontend-only — no Go, no RPC, no generated types.

**Spec:** `docs/superpowers/specs/2026-06-26-cockpit-card-pixel-port-design.md`

**Plan deviation from spec:** Spec §"Composer" says the collapse state lives in `AgentRow` local state. Implementation lifts it to a model atom `openComposerIdAtom` because the `R` keybinding in `cockpitsurface.tsx:411` focuses the card textarea via `querySelector` and a collapsed composer has no textarea. Behavior is unchanged.

---

## Task 1: Theme tokens + keyframes

**Files:**
- Modify: `frontend/tailwindsetup.css` (color tokens in the `@theme` block after `--color-success`; keyframes near the existing `@keyframes float-up`)

- [ ] **Step 1: Add the new color tokens**

In `frontend/tailwindsetup.css`, find the line `--color-success: #54c79a;` and add immediately after it (still inside the `@theme {` block):

```css
    /* handoff card-body colors (Wave-cockpit-live.dc.html) */
    --color-ask-question: #eddcb8; /* asking-band question prose */
    --color-ask-label: #c79a3f; /* "waiting on you" label */
    --color-on-warning: #1a1306; /* text on the filled needs-you badge */
    --color-success-soft: #bfe6d6; /* working activity line */
    --color-feed-label: #777f89; /* tool-line uppercase tool name */
    --color-feed-summary: #9aa3ad; /* tool-line summary text */
    --color-feed-time: #4f565f; /* tool-line faint meta */
    --color-feed-glyph: #454c55; /* drag handle glyph */
```

- [ ] **Step 2: Add the keyframes**

Find `@keyframes float-up {` and add these three keyframes immediately before it (top-level, not inside `@theme`):

```css
@keyframes pulseDot {
    0%,
    100% {
        opacity: 1;
    }
    50% {
        opacity: 0.32;
    }
}
@keyframes caret {
    0%,
    100% {
        opacity: 1;
    }
    50% {
        opacity: 0;
    }
}
@keyframes fadeUp {
    from {
        opacity: 0;
        transform: translateY(7px);
    }
    to {
        opacity: 1;
        transform: none;
    }
}
```

- [ ] **Step 3: Verify the build still compiles**

Run: `npx vite build --config frontend/tauri/vite.config.ts`
Expected: build succeeds (no CSS parse errors). This proves the tokens generate utilities (`text-ask-question`, `bg-warning`, etc.) and the keyframes are valid.

- [ ] **Step 4: Commit**

```bash
git add frontend/tailwindsetup.css
git commit -m "feat(cockpit): add handoff card-body tokens + pulseDot/caret/fadeUp keyframes"
```

---

## Task 2: Placeholder data helpers (TDD)

**Files:**
- Modify: `frontend/app/view/agents/agentsviewmodel.ts` (append new types + pure functions)
- Test: `frontend/app/view/agents/agentsviewmodel.test.ts` (append a describe block)

- [ ] **Step 1: Write the failing tests**

Append to `frontend/app/view/agents/agentsviewmodel.test.ts`. First add these imports to the existing top-of-file import from `./agentsviewmodel` (add the four names to the existing import list): `placeholderDiffStats`, `placeholderTasks`, `taskProgress`, and the type `CardTask`. Then append:

```ts
describe("placeholder card data", () => {
    const vm = (id: string, state: AgentState = "working"): AgentVM => ({ id, name: "x", task: "", state });

    it("placeholderDiffStats is deterministic per id", () => {
        expect(placeholderDiffStats(vm("agent-7"))).toEqual(placeholderDiffStats(vm("agent-7")));
    });

    it("placeholderDiffStats is undefined for idle", () => {
        expect(placeholderDiffStats(vm("agent-7", "idle"))).toBeUndefined();
    });

    it("placeholderDiffStats varies across ids (some have changes, some do not)", () => {
        const out = Array.from({ length: 30 }, (_, i) => placeholderDiffStats(vm(`agent-${i}`)));
        expect(out.some((r) => r === undefined)).toBe(true);
        expect(out.some((r) => r !== undefined)).toBe(true);
    });

    it("placeholderTasks is deterministic and sized 3-5 when present", () => {
        const t1 = placeholderTasks(vm("agent-3"));
        const t2 = placeholderTasks(vm("agent-3"));
        expect(t1).toEqual(t2);
        if (t1) {
            expect(t1.length).toBeGreaterThanOrEqual(3);
            expect(t1.length).toBeLessThanOrEqual(5);
        }
    });

    it("placeholderTasks is undefined for idle", () => {
        expect(placeholderTasks(vm("agent-3", "idle"))).toBeUndefined();
    });

    it("taskProgress computes done/total/pct", () => {
        expect(taskProgress([])).toEqual({ done: 0, total: 0, pct: 0 });
        const all: CardTask[] = [
            { text: "a", done: true },
            { text: "b", done: true },
        ];
        expect(taskProgress(all)).toEqual({ done: 2, total: 2, pct: 100 });
        const some: CardTask[] = [
            { text: "a", done: true },
            { text: "b", done: false },
            { text: "c", done: false },
            { text: "d", done: false },
        ];
        expect(taskProgress(some)).toEqual({ done: 1, total: 4, pct: 25 });
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts`
Expected: FAIL — `placeholderDiffStats is not a function` / import errors.

- [ ] **Step 3: Implement the helpers**

Append to `frontend/app/view/agents/agentsviewmodel.ts`:

```ts
// --- PLACEHOLDER card data (docs/deferred.md) -------------------------------
// The live AgentVM carries no git diff stats and no TodoWrite task list yet.
// These deterministic helpers fabricate believable values (seeded from the id,
// stable across renders) so the handoff card bands render. Delete and replace
// with real data when the deferred wiring lands; this is the only seam.

export interface DiffStats {
    files: number;
    adds: number;
    dels: number;
}

export interface CardTask {
    text: string;
    done: boolean;
}

const PLACEHOLDER_TASK_POOL = [
    "Read the failing test",
    "Reproduce the bug",
    "Patch the handler",
    "Add a regression test",
    "Update the docs",
    "Run the suite",
];

function hashId(id: string): number {
    let h = 0;
    for (let i = 0; i < id.length; i++) {
        h = (h * 31 + id.charCodeAt(i)) | 0;
    }
    return Math.abs(h);
}

/** PLACEHOLDER: deterministic pseudo git stats; undefined for idle and ~1/3 of ids
 *  (so `hasChanges` varies). Replace with real git-diff data (deferred). */
export function placeholderDiffStats(agent: AgentVM): DiffStats | undefined {
    if (agent.state === "idle") {
        return undefined;
    }
    const h = hashId(agent.id);
    if (h % 3 === 0) {
        return undefined;
    }
    return { files: 1 + (h % 6), adds: 4 + (h % 180), dels: h % 60 };
}

/** PLACEHOLDER: deterministic pseudo task list; undefined for idle and ~1/4 of ids.
 *  Replace with the agent's real TodoWrite state from the transcript (deferred). */
export function placeholderTasks(agent: AgentVM): CardTask[] | undefined {
    if (agent.state === "idle") {
        return undefined;
    }
    const h = hashId(agent.id);
    if (h % 4 === 0) {
        return undefined;
    }
    const total = 3 + (h % 3); // 3..5
    const done = h % (total + 1); // 0..total
    return Array.from({ length: total }, (_, i) => ({
        text: PLACEHOLDER_TASK_POOL[(h + i) % PLACEHOLDER_TASK_POOL.length],
        done: i < done,
    }));
}

/** Pure: done/total/percent for a task list. Real once the task data is wired. */
export function taskProgress(tasks: CardTask[]): { done: number; total: number; pct: number } {
    const total = tasks.length;
    const done = tasks.filter((t) => t.done).length;
    return { done, total, pct: total === 0 ? 0 : Math.round((done / total) * 100) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts`
Expected: PASS (all new tests green; existing tests unchanged).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/agentsviewmodel.ts frontend/app/view/agents/agentsviewmodel.test.ts
git commit -m "feat(cockpit): deterministic placeholder diff-stats + task-list helpers"
```

---

## Task 3: StatusDot pulse prop

**Files:**
- Modify: `frontend/app/view/agents/statusdot.tsx`

- [ ] **Step 1: Add the `pulse` prop**

Replace the component in `frontend/app/view/agents/statusdot.tsx` (keep the `COLOR` map and header comment above it):

```tsx
export function StatusDot({
    state,
    quiet,
    pulse,
    className,
}: {
    state: AgentState;
    quiet?: boolean;
    pulse?: boolean;
    className?: string;
}) {
    const hollow = state === "working" && quiet;
    return (
        <span
            className={cn(
                "h-2 w-2 shrink-0 rounded-full",
                hollow ? "border border-muted bg-transparent" : "",
                pulse && !hollow ? "animate-[pulseDot_1.6s_infinite]" : "",
                className
            )}
            style={hollow ? undefined : { backgroundColor: COLOR[state] }}
        />
    );
}
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: only the 3 baseline `frontend/tauri/api.test.ts` errors (no new errors). Existing `StatusDot` callers in `agenttree.tsx`/`agenttranscript.tsx` don't pass `pulse`, so they're unaffected.

- [ ] **Step 3: Commit**

```bash
git add frontend/app/view/agents/statusdot.tsx
git commit -m "feat(cockpit): StatusDot optional pulse prop"
```

---

## Task 4: Restyle NarrationTimeline to the handoff lane look

**Files:**
- Modify: `frontend/app/view/agents/narrationtimeline.tsx` (replace the whole file)

This component has a single caller (the card). Restyle the leaf renderers to the handoff lane; keep `groupTimeline`, the collapse-summary, `accentLatest`, and `active`-trailing-expand. Drop the dead `large` prop.

- [ ] **Step 1: Replace the file**

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { Fragment, useState } from "react";
import { groupTimeline, summarizeActions, type AgentActionEntry, type AgentEntry } from "./agentsviewmodel";
import { MarkdownMessage } from "./markdownmessage";

// Handoff lane feed (Wave-cockpit-live.dc.html:211-247). message -> narration row
// (accent avatar + prose); user -> right-aligned bubble; action -> tool line
// (outcome chip + tool + summary + note). Bursts of >= CollapseRunThreshold
// consecutive actions fold into one summary line (groupTimeline) that expands on
// click; while `active`, the trailing run stays expanded. tool_result content is
// never present. Per-tool timestamps are omitted (not in AgentEntry).

function ToolLine({ action }: { action: AgentActionEntry }) {
    const ok = action.outcome !== "fail";
    return (
        <div className="flex items-center gap-1.5 px-1 py-[3px] opacity-[0.68]">
            <span
                className={cn(
                    "flex h-[13px] w-[13px] shrink-0 items-center justify-center rounded-[3px] text-[8px]",
                    ok ? "bg-success/15 text-success" : "bg-error/15 text-error"
                )}
            >
                {ok ? "✓" : "✗"}
            </span>
            <span className="shrink-0 font-mono text-[8px] font-semibold uppercase tracking-[0.03em] text-feed-label">
                {action.verb}
            </span>
            <span className="shrink-0 whitespace-nowrap font-mono text-[10.5px] text-feed-summary">{action.target}</span>
            {action.note ? (
                <>
                    <span className="shrink-0 text-[9px] text-edge-strong">→</span>
                    <span
                        className={cn(
                            "min-w-0 truncate font-mono text-[10.5px] opacity-[0.85]",
                            ok ? "text-success" : "text-error"
                        )}
                    >
                        {action.note}
                    </span>
                </>
            ) : null}
        </div>
    );
}

export function NarrationTimeline({
    entries,
    accentLatest,
    active,
    className,
}: {
    entries: AgentEntry[];
    accentLatest?: boolean;
    active?: boolean;
    className?: string;
}) {
    const [expanded, setExpanded] = useState<Set<number>>(new Set());
    const items = groupTimeline(entries);

    let lastMessageIdx = -1;
    if (accentLatest) {
        for (let i = entries.length - 1; i >= 0; i--) {
            if (entries[i].kind === "message") {
                lastMessageIdx = i;
                break;
            }
        }
    }

    const expand = (startIndex: number) => setExpanded((prev) => new Set(prev).add(startIndex));

    return (
        <div className={cn("leading-relaxed", className)}>
            {items.map((item, idx) => {
                if (item.kind === "message") {
                    return (
                        <div key={item.index} className="mt-2 flex gap-2.5">
                            <span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] border border-accent/30 bg-accent/[0.13]">
                                <span className="h-[7px] w-[7px] rounded-full bg-accent-soft" />
                            </span>
                            <div
                                className={cn(
                                    "min-w-0 flex-1 text-[13px] leading-[1.55]",
                                    item.index === lastMessageIdx ? "text-primary" : "text-secondary"
                                )}
                            >
                                <MarkdownMessage text={item.text} />
                            </div>
                        </div>
                    );
                }
                if (item.kind === "user") {
                    return (
                        <div key={item.index} className="mt-2 flex justify-end pl-[30px]">
                            <div className="max-w-[90%] rounded-[11px_11px_4px_11px] border border-accent/25 bg-accent/10 px-2.5 py-1.5">
                                <div className="mb-0.5 font-mono text-[8px] font-bold uppercase tracking-[0.08em] text-accent-soft">
                                    You
                                </div>
                                <p className="text-[12.5px] leading-[1.5] text-primary">{item.text}</p>
                            </div>
                        </div>
                    );
                }
                if (item.kind === "action") {
                    return <ToolLine key={item.index} action={item.action} />;
                }
                const isTrailing = idx === items.length - 1;
                const isOpen = expanded.has(item.startIndex) || (active && isTrailing);
                if (isOpen) {
                    return (
                        <Fragment key={"g" + item.startIndex}>
                            {item.actions.map((action, k) => (
                                <ToolLine key={item.startIndex + k} action={action} />
                            ))}
                        </Fragment>
                    );
                }
                const summary = summarizeActions(item.actions);
                return (
                    <button
                        key={"g" + item.startIndex}
                        type="button"
                        onClick={() => expand(item.startIndex)}
                        className="my-1.5 flex w-full cursor-pointer items-center gap-1.5 rounded-r border-l-2 border-accent/50 bg-accent/[0.06] px-2.5 py-1 font-mono text-[12px] text-muted hover:bg-accent/10"
                    >
                        <span className="text-accent">▸</span>
                        <span className="text-secondary">{summary.total} tools</span>
                        {summary.byVerb.map((v) => (
                            <span key={v.verb}>
                                · {v.count} {v.verb}
                            </span>
                        ))}
                        <span className={cn("ml-0.5", summary.outcome === "ok" ? "text-accent" : "text-error")}>
                            {summary.outcome === "ok" ? "✓" : "✗"}
                        </span>
                    </button>
                );
            })}
        </div>
    );
}
```

- [ ] **Step 2: Typecheck (catches the dropped `large` prop)**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: only the 3 baseline `api.test.ts` errors. If a "Property 'large' does not exist" error appears, a caller still passes `large` — it will be removed in Task 6 (AgentRow). Proceed; the combined state is verified at Task 9.

- [ ] **Step 3: Commit**

```bash
git add frontend/app/view/agents/narrationtimeline.tsx
git commit -m "feat(cockpit): restyle NarrationTimeline to handoff lane feed"
```

---

## Task 5: Model atom for composer-open state

**Files:**
- Modify: `frontend/app/view/agents/agents.tsx:68` (add an atom next to `cardPrefsAtom`)

- [ ] **Step 1: Add the atom**

In `frontend/app/view/agents/agents.tsx`, find the line:

```ts
    cardPrefsAtom = atom<Record<string, CardPref>>({}) as PrimitiveAtom<Record<string, CardPref>>;
```

Add immediately after it:

```ts
    // which card's composer is expanded (one at a time); asking cards are always expanded regardless
    openComposerIdAtom = atom<string | undefined>(undefined) as PrimitiveAtom<string | undefined>;
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: only the 3 baseline errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/app/view/agents/agents.tsx
git commit -m "feat(cockpit): openComposerIdAtom for card composer collapse"
```

---

## Task 6: Rewrite AgentRow to the banded layout

**Files:**
- Modify: `frontend/app/view/agents/agentrow.tsx` (replace the whole file)

`composerOpen` becomes a controlled prop (driven by the parent's atom); `onOpenComposer` opens it. `model·age`, the two SVG buttons, and the indent layout are removed. Diff/task affordances render from the placeholder helpers.

- [ ] **Step 1: Replace the file**

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { Reorder, useDragControls } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { AgentComposer, type AgentComposerHandle } from "./agentcomposer";
import {
    cardSpanStyle,
    hasAnswerableAsk,
    isQuiet,
    placeholderDiffStats,
    placeholderTasks,
    projectOf,
    taskProgress,
    type AgentVM,
    type CardTask,
} from "./agentsviewmodel";
import { AnswerBar } from "./answerbar";
import { lastActivityByIdAtom, liveEntriesByIdAtom } from "./livetranscript";
import { NarrationTimeline } from "./narrationtimeline";
import { StatusDot } from "./statusdot";

// handoff cards always carry an explicit height (feed is flex-1); resizable from here
const DEFAULT_CARD_HEIGHT = 280;

// uniform 25x23 control box (handoff header buttons)
const CTL_BOX =
    "flex h-[23px] w-[25px] shrink-0 cursor-pointer items-center justify-center rounded-[6px] border border-edge-mid text-secondary hover:border-edge-strong hover:bg-white/[0.04]";

function TaskChip({ done, total, onClick }: { done: number; total: number; onClick: () => void }) {
    return (
        <button
            type="button"
            onClick={(e) => {
                e.stopPropagation();
                onClick();
            }}
            title="Show task list"
            className="flex shrink-0 cursor-pointer items-center gap-1 rounded-[5px] border border-edge-mid bg-surface-raised px-1.5 py-0.5 font-mono text-[9.5px] text-secondary hover:border-edge-strong"
        >
            {done}/{total}
        </button>
    );
}

function TaskPopover({
    tasks,
    done,
    total,
    pct,
    onClose,
}: {
    tasks: CardTask[];
    done: number;
    total: number;
    pct: number;
    onClose: () => void;
}) {
    return (
        <div
            onClick={(e) => e.stopPropagation()}
            className="absolute right-2.5 top-[46px] z-30 max-h-[calc(100%-116px)] w-[min(282px,calc(100%-20px))] animate-[fadeUp_.14s_both] overflow-y-auto rounded-[11px] border border-edge-strong bg-surface-raised p-3 shadow-[0_18px_44px_rgba(0,0,0,0.55)]"
        >
            <div className="mb-2.5 flex items-center gap-2">
                <span className="font-mono text-[8.5px] font-bold uppercase tracking-[0.1em] text-muted">Task list</span>
                <span className="rounded-[5px] border border-edge-mid bg-surface px-1.5 py-px font-mono text-[9.5px] text-secondary">
                    {done}/{total}
                </span>
                <div className="flex-1" />
                <button
                    type="button"
                    onClick={onClose}
                    title="Close"
                    className="cursor-pointer text-[12px] text-muted hover:text-secondary"
                >
                    ✕
                </button>
            </div>
            <div className="mb-3 h-[5px] overflow-hidden rounded-[3px] bg-edge-faint">
                <div className="h-full rounded-[3px] bg-success" style={{ width: `${pct}%` }} />
            </div>
            <div className="flex flex-col gap-px">
                {tasks.map((t, i) => (
                    <div key={i} className="flex items-start gap-2.5 py-1">
                        <span
                            className={cn(
                                "mt-px flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-[4px] border font-mono text-[8px]",
                                t.done ? "border-success/40 bg-success/15 text-success" : "border-edge-mid bg-surface text-muted"
                            )}
                        >
                            {t.done ? "✓" : ""}
                        </span>
                        <span
                            className={cn(
                                "font-mono text-[11.5px] leading-[1.5]",
                                t.done ? "text-muted line-through" : "text-secondary"
                            )}
                        >
                            {t.text}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
}

export function AgentRow({
    agent,
    now,
    isCursor,
    selections,
    sent,
    activeQuestion,
    composerOpen,
    onCursor,
    onOpen,
    onOpenTerminal,
    onOpenComposer,
    onToggleAnswer,
    onSubmitAnswer,
    onSelectQuestion,
    onComposerEscape,
    onBackground,
    onDismiss,
    pulse,
    wide,
    height,
    onToggleWide,
    onResize,
}: {
    agent: AgentVM;
    now: number;
    isCursor: boolean;
    selections: Record<number, Set<number>>;
    sent: boolean;
    activeQuestion?: number;
    composerOpen: boolean;
    onCursor: () => void;
    onOpen: () => void;
    onOpenTerminal: () => void;
    onOpenComposer: () => void;
    onToggleAnswer: (qi: number, oi: number) => void;
    onSubmitAnswer: () => void;
    onSelectQuestion?: (qi: number) => void;
    onComposerEscape?: () => void;
    onBackground?: () => void;
    onDismiss?: () => void;
    pulse?: boolean;
    wide?: boolean;
    height?: number;
    onToggleWide: () => void;
    onResize: (height: number) => void;
}) {
    const controls = useDragControls();
    const composerRef = useRef<AgentComposerHandle>(null);
    const cardRef = useRef<HTMLDivElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const stickRef = useRef(true);
    const [tasksOpen, setTasksOpen] = useState(false);

    const onResizeStart = (e: React.PointerEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const startY = e.clientY;
        const startH = height ?? cardRef.current?.offsetHeight ?? DEFAULT_CARD_HEIGHT;
        const move = (ev: PointerEvent) => onResize(Math.max(140, startH + (ev.clientY - startY)));
        const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
    };

    const liveEntries = useAtomValue(liveEntriesByIdAtom);
    const lastActivity = useAtomValue(lastActivityByIdAtom);
    const entries = liveEntries[agent.id] ?? agent.previousInfo ?? [];
    const quiet = isQuiet(lastActivity[agent.id], now);
    const project = projectOf(agent);
    const asking = agent.state === "asking";
    const working = agent.state === "working";
    const idle = agent.state === "idle";
    const hasQuestions = hasAnswerableAsk(agent);
    const question = agent.ask?.questions?.[0]?.question;
    const diff = placeholderDiffStats(agent);
    const tasks = placeholderTasks(agent);
    const prog = tasks ? taskProgress(tasks) : undefined;
    const showComposer = composerOpen || asking;
    const muteAction = idle ? onDismiss : onBackground;

    // in-row narration sticks to the latest line unless the user scrolls up to read history
    useEffect(() => {
        const el = scrollRef.current;
        if (el && stickRef.current) {
            el.scrollTop = el.scrollHeight;
        }
    }, [entries]);
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
            ref={cardRef}
            style={{ ...cardSpanStyle({ wide }), height: `${height ?? DEFAULT_CARD_HEIGHT}px` }}
            data-agent-id={agent.id}
            onClick={onCursor}
            onDoubleClick={onOpen}
            className={cn(
                "group relative flex cursor-pointer flex-col overflow-hidden rounded-[13px] border",
                asking ? "border-warning/40 bg-lane-asking" : "border-edge-mid bg-lane",
                isCursor &&
                    (asking ? "shadow-[0_0_0_1.5px_var(--color-warning)]" : "shadow-[0_0_0_1.5px_var(--color-accent)]"),
                pulse && "ring-2 ring-warning ring-inset"
            )}
        >
            {/* header bar */}
            <div className="flex shrink-0 items-center gap-2 border-b border-edge-mid bg-surface px-3 py-1.5">
                <span
                    onPointerDown={(e) => controls.start(e)}
                    onClick={(e) => e.stopPropagation()}
                    title="Drag to reorder"
                    className="shrink-0 cursor-grab select-none font-mono text-[12px] leading-none tracking-[-1px] text-feed-glyph active:cursor-grabbing"
                >
                    ∷∷
                </span>
                <StatusDot state={agent.state} quiet={quiet} pulse={!idle && !quiet} className="!h-2 !w-2" />
                <b className="min-w-[30px] flex-1 truncate font-mono text-[13.5px] font-semibold text-primary">
                    {agent.name}
                </b>
                {project ? (
                    <span className="shrink-0 rounded-[5px] border border-edge-mid bg-surface-raised px-1.5 py-px font-mono text-[10px] text-muted">
                        {project}
                    </span>
                ) : null}
                {diff ? (
                    <span
                        title="Pending changes (placeholder data)"
                        className="flex shrink-0 items-center gap-1 rounded-[5px] border border-edge-mid px-1.5 py-0.5 font-mono text-[9.5px] font-bold"
                    >
                        <span className="text-success">+{diff.adds}</span>
                        <span className="text-error">−{diff.dels}</span>
                    </span>
                ) : null}
                {asking ? (
                    <span className="shrink-0 rounded-[4px] bg-warning px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-[0.05em] text-on-warning">
                        needs you
                    </span>
                ) : null}
                <button
                    type="button"
                    onClick={(e) => {
                        e.stopPropagation();
                        onToggleWide();
                    }}
                    title={wide ? "Narrow" : "Widen"}
                    className={cn(CTL_BOX, "font-mono text-[10px]")}
                >
                    {wide ? "⤡" : "⤢"}
                </button>
                <button
                    type="button"
                    onClick={(e) => {
                        e.stopPropagation();
                        onOpenTerminal();
                    }}
                    title="Open terminal (T)"
                    className={cn(CTL_BOX, "font-mono text-[9px] font-bold")}
                >
                    {">_"}
                </button>
                {muteAction ? (
                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            muteAction();
                        }}
                        title={idle ? "Dismiss to Idle" : "Mute & background (M)"}
                        className={cn(CTL_BOX, "text-[11px]")}
                    >
                        ⤓
                    </button>
                ) : null}
            </div>

            {/* asking band */}
            {asking ? (
                <div className="shrink-0 border-b border-edge-mid px-3.5 py-2.5">
                    <div className="mb-1.5 flex items-center gap-2">
                        <span className="font-mono text-[8.5px] font-bold uppercase tracking-[0.1em] text-ask-label">
                            Waiting on you
                        </span>
                        <div className="flex-1" />
                        {prog ? <TaskChip done={prog.done} total={prog.total} onClick={() => setTasksOpen((v) => !v)} /> : null}
                    </div>
                    {question ? (
                        <p className="text-[13px] font-medium leading-[1.5] text-ask-question">{question}</p>
                    ) : null}
                </div>
            ) : null}

            {/* task popover (placeholder) */}
            {tasksOpen && tasks && prog ? (
                <TaskPopover
                    tasks={tasks}
                    done={prog.done}
                    total={prog.total}
                    pct={prog.pct}
                    onClose={() => setTasksOpen(false)}
                />
            ) : null}

            {/* feed */}
            <div
                ref={scrollRef}
                onScroll={onNarrationScroll}
                className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-1.5"
            >
                {working && agent.activity ? (
                    <div className="mb-1.5 flex items-center gap-2 border-b border-edge-mid pb-1.5">
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success animate-[pulseDot_1.4s_infinite]" />
                        <span
                            title={agent.activity}
                            className="min-w-0 flex-1 truncate font-mono text-[12px] leading-[1.4] text-success-soft"
                        >
                            {agent.activity}
                        </span>
                        {prog ? (
                            <TaskChip done={prog.done} total={prog.total} onClick={() => setTasksOpen((v) => !v)} />
                        ) : null}
                    </div>
                ) : null}
                {entries.length > 0 ? <NarrationTimeline entries={entries} accentLatest active={!idle} /> : null}
            </div>

            {/* structured answer band */}
            {asking && hasQuestions ? (
                <AnswerBar
                    agent={agent}
                    selections={selections}
                    sent={sent}
                    numbered
                    activeQuestion={activeQuestion}
                    onToggle={onToggleAnswer}
                    onSubmit={onSubmitAnswer}
                    onSelectQuestion={onSelectQuestion}
                    className="shrink-0 border-t border-edge-mid px-3 py-2"
                />
            ) : null}

            {/* composer */}
            {showComposer ? (
                <div
                    className="flex shrink-0 flex-col gap-1.5 border-t border-edge-mid px-3 py-2"
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                >
                    {asking && agent.ask?.replySuggestions?.length ? (
                        <div className="flex flex-wrap gap-1.5">
                            {agent.ask.replySuggestions.map((s, i) => (
                                <button
                                    key={i}
                                    type="button"
                                    onClick={() => composerRef.current?.fill(s)}
                                    className="cursor-pointer whitespace-nowrap rounded-[7px] border border-warning/30 bg-warning/10 px-2.5 py-1 text-[11px] text-warning hover:border-warning/55 hover:bg-warning/20"
                                >
                                    {s}
                                </button>
                            ))}
                        </div>
                    ) : null}
                    <AgentComposer
                        ref={composerRef}
                        blockId={agent.blockId}
                        placeholder={`message ${agent.name}…`}
                        onEscape={onComposerEscape}
                        className="border-t-0 px-0 py-0"
                    />
                </div>
            ) : (
                <div
                    onClick={(e) => {
                        e.stopPropagation();
                        onOpenComposer();
                    }}
                    className="flex shrink-0 cursor-text items-center gap-2 border-t border-edge-mid px-3 py-1.5 hover:bg-surface-hover"
                >
                    <span className="flex h-[13px] w-[13px] shrink-0 items-center justify-center rounded-[5px] border border-edge-mid text-[10px] leading-none text-muted">
                        +
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[12px] text-muted">{`message ${agent.name}…`}</span>
                    <span className="shrink-0 rounded-[5px] border border-edge-mid px-1.5 py-0.5 font-mono text-[9.5px] text-muted">
                        R
                    </span>
                </div>
            )}

            {/* resize */}
            <div
                onPointerDown={onResizeStart}
                title="Drag to resize"
                className="absolute inset-x-0 bottom-0 flex h-[9px] cursor-ns-resize items-center justify-center"
            >
                <div className="h-[3px] w-[34px] rounded-[3px] bg-edge-strong" />
            </div>
        </Reorder.Item>
    );
}
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: only the 3 baseline `api.test.ts` errors — **plus** expected errors in `cockpitsurface.tsx` because it doesn't yet pass `composerOpen`/`onOpenComposer` (fixed in Task 7). If the only new errors are those two missing props in `cockpitsurface.tsx`, proceed.

- [ ] **Step 3: Commit**

```bash
git add frontend/app/view/agents/agentrow.tsx
git commit -m "feat(cockpit): rebuild AgentRow to handoff banded layout"
```

---

## Task 7: Wire cockpitsurface (composer open/escape, R key, asking mute)

**Files:**
- Modify: `frontend/app/view/agents/cockpitsurface.tsx` (atom hookup near the other `useAtomValue`/`useSetAtom` calls; the `R` handler at ~411; the `onComposerEscape` + `onBackground` props at ~580)

- [ ] **Step 1: Read the existing setter/atom hookups**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` is not needed here; instead open the file and locate (a) where `cardPrefs` is read via `useAtomValue(model.cardPrefsAtom)` and the `useSetAtom` calls, (b) the `R` handler at line ~411, (c) the `<AgentRow .../>` props block at ~560-587.

- [ ] **Step 2: Add the atom read + setter**

Near the other `useAtomValue(model.*)` / `useSetAtom(model.*)` hooks at the top of the component (next to where `cardPrefs` is read), add:

```ts
    const openComposerId = useAtomValue(model.openComposerIdAtom);
    const setOpenComposerId = useSetAtom(model.openComposerIdAtom);
```

(If `useSetAtom` is not yet imported from `jotai`, add it to the existing `jotai` import.)

- [ ] **Step 3: Update the `R` handler**

Replace the `else if (e.key === "r")` branch (~line 411-415):

```ts
        } else if (e.key === "r") {
            e.preventDefault();
            if (cur && !hasAnswerableAsk(cur)) {
                setOpenComposerId(cur.id);
                requestAnimationFrame(() => focusRowComposer(cur.id));
            }
        }
```

- [ ] **Step 4: Pass the new props to `AgentRow`**

In the `<AgentRow .../>` block, add `composerOpen` and `onOpenComposer`, extend `onBackground` to asking, and make `onComposerEscape` clear the atom. Change these props:

```tsx
                                composerOpen={openComposerId === a.id}
                                onOpenComposer={() => setOpenComposerId(a.id)}
                                onComposerEscape={() => {
                                    setOpenComposerId(undefined);
                                    containerRef.current?.focus();
                                }}
                                onBackground={
                                    a.state === "working" || a.state === "asking"
                                        ? () => toggleBackground(a.id)
                                        : undefined
                                }
```

(Leave `onDismiss` as-is — idle only.)

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: only the 3 baseline `api.test.ts` errors. No errors in `agentrow.tsx` or `cockpitsurface.tsx`.

- [ ] **Step 6: Run the full unit suite**

Run: `npx vitest run`
Expected: PASS (the placeholder-data tests plus all pre-existing tests; count is the prior green total + the new cases).

- [ ] **Step 7: Commit**

```bash
git add frontend/app/view/agents/cockpitsurface.tsx
git commit -m "feat(cockpit): wire composer collapse + asking mute into cockpit surface"
```

---

## Task 8: Record the fabricated data in deferred.md

**Files:**
- Modify: `docs/deferred.md` (append two entries)

- [ ] **Step 1: Append the deferred entries**

Append to `docs/deferred.md` (match the file's existing heading/list style; adapt the heading level to the surrounding document):

```markdown
## Cockpit card — fabricated data (2026-06-26)

The Cockpit live-agent card renders two affordances from **deterministic placeholder
data**, because the live `AgentVM` carries no source for them yet. Live agents
currently show fabricated numbers. Both have a single replacement seam in
`frontend/app/view/agents/agentsviewmodel.ts`.

- **Card diff stats** (`+adds / −dels` button in the card header) — fabricated by
  `placeholderDiffStats(agent)`. Wire real `files/adds/dels` from the Files-surface
  `gitinfo` RPCs for the agent's worktree, then delete `placeholderDiffStats`.
- **Card task list** (the `done/total` chip + task popover) — fabricated by
  `placeholderTasks(agent)`. Project the agent's latest TodoWrite tool state from the
  transcript into `AgentVM`, then delete `placeholderTasks`. `taskProgress` is real and
  stays.
```

- [ ] **Step 2: Commit**

```bash
git add docs/deferred.md
git commit -m "docs(cockpit): note fabricated card diff-stats + task-list as deferred"
```

---

## Task 9: Final verification (gates + visual)

**Files:** none (verification only)

- [ ] **Step 1: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exactly the 3 baseline `frontend/tauri/api.test.ts` errors, nothing else.

- [ ] **Step 2: Unit tests**

Run: `npx vitest run`
Expected: all green.

- [ ] **Step 3: Production build (proves the import graph + Tailwind/keyframes)**

Run: `npx vite build --config frontend/tauri/vite.config.ts`
Expected: build succeeds.

- [ ] **Step 4: Visual check against the handoff (CDP)**

Restart the dev app so the new tokens/keyframes compile: `task dev` (Vite picks up TS via HMR, but the Tailwind `@theme` change needs a dev rebuild). Inject a populated roster if needed (`node scripts/inject-live-agents.mjs <scenario>`), then capture: `node scripts/cdp-shot.mjs scratchpad/card-pixelport.png`. Compare side-by-side with `wave-handoff/wave/project/Wave-cockpit-live.dc.html` (open in a browser). Confirm: banded header bar with own background + divider, mono fixed-size name, filled amber `needs you`, three uniform control boxes, `∷∷` glyph, pulsing dot, cream asking question, lane feed (avatar/bubble/tool lines), collapsed composer with `R` badge (and that pressing `R` on the cursor card opens + focuses it), diff button + task chip/popover from placeholder data, working resize handle.

- [ ] **Step 5: Confirm the `leftBg` shade (open question from the spec)**

In the CDP screenshot, check the header bar reads as a distinct title bar over the lane body. The plan uses `bg-surface` (#0e1116) over `bg-lane` (#12161b). If it looks too flat, switch the header to `bg-surface-raised` per state and re-capture. Record the final choice in a one-line note on the spec's open-questions section.

---

## Self-review notes

- **Spec coverage:** banded layout (T6), header bar + mono name + filled badge + control boxes + `∷∷` + pulsing dot (T1/T3/T6), asking band + question (T6), working line (T6), feed restyle + keep collapse (T4), composer collapse + reply chips + R wiring (T5/T6/T7), placeholder diff/tasks + deferred (T2/T8), tokens + keyframes (T1), residue deletes — `model·age`/SVG buttons/indent/`large` prop (T4/T6) — all covered.
- **Capability changes (accepted):** composer collapsed by default; `model` off the card; background+dismiss → one `⤓`. Implemented in T6/T7.
- **Type consistency:** `placeholderDiffStats`/`placeholderTasks`/`taskProgress`/`DiffStats`/`CardTask` defined in T2 and consumed in T6; `openComposerIdAtom` defined in T5, consumed in T7; `composerOpen`/`onOpenComposer` added to `AgentRow` props in T6 and passed in T7; `StatusDot` `pulse` added in T3 and used in T6.
- **Accepted risk (D3):** live agents show fabricated git/task numbers until wired — recorded in `docs/deferred.md` (T8) and surfaced to the user.
