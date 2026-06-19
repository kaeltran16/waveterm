# Agents Tab — Answering & Focus/Queue Layout Implementation Plan (Phase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Agents tab's asking card a faithful AskUserQuestion renderer (all questions + multi-select), rework the content into a focus/queue asks region over a responsive working-panel grid, stream the asking card's narration live, and add the quiet cue + new-output pill.

**Architecture:** Pure view-model helpers (`buildAskAnswers`, `canSubmitAsk`, `isQuiet`, `resolveFocusedAskId`) drive the components. `askcard.tsx` drops its single-question guard and submits one answer item per question. `agents.tsx` splits agents via the existing `groupAgents` into a focused ask + a queue + a working grid. The asking card subscribes to the same transcript stream working panels already use. **Frontend-only — no RPC, no Go types, no `task generate`.**

**Tech Stack:** TypeScript/React, Jotai, Tailwind v4, vitest. Spec: `docs/specs/2026-06-19-agents-tab-answering-layout-motion-design.md`.

**Phase 2 (motion) is a separate plan.** This plan covers spec §3–§6, §8, §9 (functional), §10 (pure tests). The spec's motion work (§7 — the `motion` dependency, the 7 content micro-animations, the 5 vertical-tab animations) is intentionally **not** here; it will be planned after Phase 1 lands, against the real component tree this phase produces.

**Commits (repo owner's git rules override the skill default):** Do **NOT** auto-commit per task. Each task ends with a **Checkpoint** step: run the task's tests, then `git add` the touched files. After all tasks pass, present **one batched commit** for explicit approval (final task).

---

## File structure

All under `frontend/app/view/agents/`:
- `agentsviewmodel.ts` + `agentsviewmodel.test.ts` — add the four pure helpers; remove the now-superseded `outputPanelOrder` (+ its test) (Tasks 2, 5).
- `askcard.tsx` — unified answering (Task 3) + live narration source (Task 6).
- `outputpanel.tsx` — quiet cue + new-output pill + grid-cell sizing (Task 4).
- `agents.tsx` — focus/queue + working grid + empty state (Task 5); stream asks (Task 6).

No other files change. The answer-delivery hook (Task 1) lives outside this repo and is verification-only.

---

### Task 1: Verify the answer-delivery hook handles multi-question / multi-index

**Files:** none in this repo (verification + de-risk). The multi-answer frontend is correct regardless; this confirms it works *end-to-end*.

**Why:** Today the panel only ever submits one answer with one index. The answer travels `AskCard → AnswerAgentCommand → the external answer-delivery hook → AskUserQuestion`. If that hook was written for the single-select MVP (reads only `answers[0].selectedindexes[0]`), a multi-question / multi-select submit will be silently dropped at the hook even though the RPC carries it.

- [ ] **Step 1: Locate the ask/answer hook**

Run: `cat ~/.claude/settings.json` (and `~/.claude/settings.local.json` if present). Find the hook wired to `AskUserQuestion` (a `PreToolUse` matcher) and note its `command` / script path.

- [ ] **Step 2: Inspect how it formats the answer**

Read that hook script. Find where it consumes the answer it gets back from the blocked ask (the value it returns to `AskUserQuestion`). Check whether it:
- iterates **all** entries of `answers[]` (one per question), and
- maps **each** entry's `selectedindexes[]` (potentially more than one index) to option labels.

- [ ] **Step 3: Record the verdict**

- **PASS** — it already handles multi-question + multi-index → proceed; the Phase-1 frontend will work end-to-end.
- **FAIL** — it only reads the first question / first index → note it in the session notes: the Phase-1 frontend is still correct and mergeable, but a **parallel hook update (outside this repo)** is required before multi-answer is usable end-to-end. Do not block the frontend tasks on it; flag it in the final summary.

---

### Task 2: Pure view-model helpers (TDD)

**Files:**
- Modify: `frontend/app/view/agents/agentsviewmodel.ts`
- Test: `frontend/app/view/agents/agentsviewmodel.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `frontend/app/view/agents/agentsviewmodel.test.ts` (import `buildAskAnswers, canSubmitAsk, isQuiet, resolveFocusedAskId` alongside the existing imports from `./agentsviewmodel`; `AgentVM` and `AgentAskQuestion` are already exported from there):

```ts
describe("buildAskAnswers", () => {
    const q = (multiSelect = false): AgentAskQuestion => ({
        question: "q",
        multiSelect,
        options: [{ label: "a" }, { label: "b" }, { label: "c" }],
    });

    it("emits one answer item per question, indexes sorted ascending", () => {
        const questions = [q(false), q(true)];
        const selections = { 0: new Set([1]), 1: new Set([2, 0]) };
        expect(buildAskAnswers(questions, selections)).toEqual([
            { selectedindexes: [1] },
            { selectedindexes: [0, 2] },
        ]);
    });

    it("emits empty indexes for an unanswered question", () => {
        expect(buildAskAnswers([q()], {})).toEqual([{ selectedindexes: [] }]);
    });
});

describe("canSubmitAsk", () => {
    const q = (): AgentAskQuestion => ({ question: "q", options: [{ label: "a" }] });

    it("true only when every question has at least one selection", () => {
        expect(canSubmitAsk([q(), q()], { 0: new Set([0]), 1: new Set([0]) })).toBe(true);
        expect(canSubmitAsk([q(), q()], { 0: new Set([0]) })).toBe(false);
        expect(canSubmitAsk([], {})).toBe(false);
    });
});

describe("isQuiet", () => {
    it("true past the threshold, false within it or when activity is unknown", () => {
        expect(isQuiet(1_000, 1_000 + 46_000)).toBe(true);
        expect(isQuiet(1_000, 1_000 + 10_000)).toBe(false);
        expect(isQuiet(undefined, 99_999)).toBe(false);
    });
});

describe("resolveFocusedAskId", () => {
    const a = (id: string): AgentVM => ({ id, name: id, task: "", state: "asking" }) as AgentVM;

    it("keeps the current focus if it's still asking", () => {
        expect(resolveFocusedAskId([a("x"), a("y")], "y")).toBe("y");
    });

    it("falls back to the first (oldest-blocked) asking agent otherwise", () => {
        expect(resolveFocusedAskId([a("x"), a("y")], "gone")).toBe("x");
        expect(resolveFocusedAskId([a("x")], undefined)).toBe("x");
        expect(resolveFocusedAskId([], "x")).toBe(undefined);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from project root): `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts`
Expected: FAIL — `buildAskAnswers`, `canSubmitAsk`, `isQuiet`, `resolveFocusedAskId` are not exported.

- [ ] **Step 3: Implement the helpers**

Append to `frontend/app/view/agents/agentsviewmodel.ts`:

```ts
/** Pure: one AgentAnswerItem per question, carrying that question's selected option indexes (ascending). */
export function buildAskAnswers(questions: AgentAskQuestion[], selections: Record<number, Set<number>>): AgentAnswerItem[] {
    return questions.map((_, qi) => ({ selectedindexes: Array.from(selections[qi] ?? []).sort((a, b) => a - b) }));
}

/** Pure: submittable only when every question has at least one selected option. */
export function canSubmitAsk(questions: AgentAskQuestion[], selections: Record<number, Set<number>>): boolean {
    return questions.length > 0 && questions.every((_, qi) => (selections[qi]?.size ?? 0) >= 1);
}

/** Pure: a working agent is "quiet" when no new narration has arrived for thresholdMs. */
export function isQuiet(lastActivityMs: number | undefined, now: number, thresholdMs = 45_000): boolean {
    return lastActivityMs != null && now - lastActivityMs > thresholdMs;
}

/** Pure: which asking agent owns the focus slot. Keep the current focus if it's still asking;
 *  otherwise fall back to the first (oldest-blocked) asking agent. groupAgents already sorts
 *  asking longest-blocked-first, so asking[0] is the oldest. */
export function resolveFocusedAskId(asking: AgentVM[], current?: string): string | undefined {
    if (current != null && asking.some((a) => a.id === current)) {
        return current;
    }
    return asking[0]?.id;
}
```

> `AgentAnswerItem` is a generated ambient type (`frontend/types/gotypes.d.ts`) — globally available, no import needed.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts`
Expected: PASS (existing tests + the four new describe blocks).

- [ ] **Step 5: Checkpoint**

Run the test above (PASS), then stage: `git add frontend/app/view/agents/agentsviewmodel.ts frontend/app/view/agents/agentsviewmodel.test.ts`

---

### Task 3: AskCard — faithful AskUserQuestion renderer

**Files:**
- Modify: `frontend/app/view/agents/askcard.tsx`

- [ ] **Step 1: Update imports**

In `frontend/app/view/agents/askcard.tsx`, change the `agentsviewmodel` import to add the two helpers:

```tsx
import { buildAskAnswers, canSubmitAsk, formatAge, type AgentAskQuestion, type AgentEntry, type AgentVM } from "./agentsviewmodel";
```

- [ ] **Step 2: Replace the answer logic and render**

Replace the body of `AskCard` (everything from `const [selections, ...` through the closing `);` of the return) with the version below. This removes the `panelAnswerable` guard, renders **every** question, builds one answer item per question, and gates Submit on all questions being answered:

```tsx
    const [selections, setSelections] = useState<Record<number, Set<number>>>({});

    const questions = agent.ask?.questions ?? [];
    const canSubmit = canSubmitAsk(questions, selections);

    const handleToggle = (qi: number, oi: number) => {
        setSelections((prev) => {
            const current = new Set(prev[qi] ?? []);
            const q = questions[qi];
            if (q?.multiSelect) {
                if (current.has(oi)) current.delete(oi);
                else current.add(oi);
            } else {
                current.clear();
                current.add(oi);
            }
            return { ...prev, [qi]: current };
        });
    };

    const handleSubmit = () => {
        if (!canSubmit) return;
        onAnswer?.(agent.ask?.oref, buildAskAnswers(questions, selections));
    };

    return (
        <div className="mb-3.5 rounded-[10px] border border-[#d29922] bg-[#d29922]/[0.05] px-[18px] py-4">
            <div className="flex items-center justify-between">
                <div className="flex cursor-pointer items-center gap-2.5 hover:[&_b]:underline" onClick={() => onOpen(agent.id)}>
                    <span className="h-2 w-2 shrink-0 rounded-full bg-[#d29922]" />
                    <b className="text-[14px] text-[#e6edf3]">{agent.name}</b>
                    {agent.task ? <span className="text-[12.5px] text-[#6b7585]">· {agent.task}</span> : null}
                </div>
                <span className="text-[11.5px] text-[#d29922]">asking · {formatAge(agent.blockedMs)}</span>
            </div>

            {agent.previousInfo?.length ? <PreviousInfo entries={agent.previousInfo} /> : null}

            {questions.map((q, qi) => (
                <QuestionGroup
                    key={qi}
                    question={q}
                    qi={qi}
                    selections={selections[qi] ?? new Set()}
                    onToggle={handleToggle}
                />
            ))}

            <div className="mt-3.5 flex items-center justify-end gap-2.5">
                <button
                    type="button"
                    onClick={() => onOpen(agent.id)}
                    className="cursor-pointer rounded-[7px] border border-[#2c3340] px-[14px] py-1.5 text-[12px] text-[#c9d1d9] hover:bg-white/[0.04]"
                >
                    Open terminal
                </button>
                <button
                    type="button"
                    disabled={!canSubmit}
                    onClick={handleSubmit}
                    className={cn(
                        "rounded-[7px] px-[18px] py-1.5 text-[12.5px] font-semibold",
                        canSubmit ? "cursor-pointer bg-[#238636] text-white" : "bg-[#238636]/40 text-white/50"
                    )}
                >
                    Submit
                </button>
            </div>
        </div>
    );
```

> `QuestionGroup`, `PreviousInfo`, `cn`, and `useState` are already defined/imported in this file and are unchanged. `QuestionGroup`'s `handleToggle` already supports multi-select via `question.multiSelect`, so multi-select "just works" once every question renders.

- [ ] **Step 3: Verify it compiles**

Run (from project root): `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors. Confirm VSCode shows no errors in `askcard.tsx` (no remaining reference to `panelAnswerable`).

- [ ] **Step 4: Checkpoint**

Stage: `git add frontend/app/view/agents/askcard.tsx`

---

### Task 4: WorkingPanel — quiet cue + new-output pill + grid-cell sizing

**Files:**
- Modify: `frontend/app/view/agents/outputpanel.tsx`

- [ ] **Step 1: Replace the file**

Replace `frontend/app/view/agents/outputpanel.tsx` with the version below. Changes: import `cn` + `isQuiet` + `useState`; compute `quiet`; hollow dot + amber `⟳ … · quiet` when quiet; track `newCount` and show a "↓ N new" pill when the user is scrolled up; the panel root is `relative h-full` (fills a grid cell) instead of `flex-1 min-h-[140px]`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import { formatAge, isQuiet, type AgentVM } from "./agentsviewmodel";
import { liveEntriesByIdAtom, lastActivityByIdAtom } from "./livetranscript";
import { NarrationTimeline } from "./narrationtimeline";
import { projectNameFromTranscriptPath } from "./projectname";

function formatSince(ms: number): string {
    if (ms < 60_000) {
        return `${Math.max(1, Math.floor(ms / 1000))}s`;
    }
    return `${Math.floor(ms / 60_000)}m`;
}

export function WorkingPanel({ agent, now, onOpen }: { agent: AgentVM; now: number; onOpen: (id: string) => void }) {
    const liveEntries = useAtomValue(liveEntriesByIdAtom);
    const lastActivity = useAtomValue(lastActivityByIdAtom);
    const entries = liveEntries[agent.id] ?? agent.previousInfo ?? [];
    const lastTs = lastActivity[agent.id];
    const since = lastTs != null ? formatSince(Math.max(0, now - lastTs)) : null;
    const quiet = isQuiet(lastTs, now);
    const project = projectNameFromTranscriptPath(agent.transcriptPath);

    const scrollRef = useRef<HTMLDivElement>(null);
    const stickRef = useRef(true);
    const prevLenRef = useRef(entries.length);
    const [newCount, setNewCount] = useState(0);

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
        <div className="relative flex h-full flex-col overflow-hidden rounded-[9px] border border-[#1c2230] bg-[#0b0e14]">
            <div className="flex shrink-0 items-center gap-2.5 border-b border-[#1c2230] px-[14px] py-2">
                <span
                    className={cn(
                        "h-2 w-2 shrink-0 rounded-full",
                        quiet ? "border border-[#4a5260] bg-transparent" : "bg-[#3fb950]"
                    )}
                />
                <b className="text-[13px] text-[#e6edf3]">{agent.name}</b>
                <span className="truncate text-[11.5px] text-[#6b7585]">
                    {project ? `${project} · ` : ""}
                    {agent.task}
                </span>
                <span className={cn("ml-auto shrink-0 text-[11px]", quiet ? "text-[#d29922]" : "text-[#7d8896]")}>
                    {agent.model ? `${agent.model} · ` : ""}
                    {formatAge(agent.activeMs)}
                    {since ? ` · ⟳ ${since}` : ""}
                    {quiet ? " · quiet" : ""}
                </span>
                <button
                    type="button"
                    onClick={() => onOpen(agent.id)}
                    className="shrink-0 cursor-pointer rounded-[5px] border border-[#2c3340] px-2.5 py-0.5 text-[10.5px] text-[#c9d1d9] hover:bg-white/[0.04]"
                >
                    Open terminal
                </button>
            </div>
            <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-[14px] py-[11px]">
                <NarrationTimeline entries={entries} accentLatest />
            </div>
            {newCount > 0 ? (
                <button
                    type="button"
                    onClick={jumpToLatest}
                    className="absolute bottom-3 left-1/2 -translate-x-1/2 cursor-pointer rounded-full bg-[#1f6feb] px-3 py-1 text-[11px] font-semibold text-white shadow-lg"
                >
                    ↓ {newCount} new
                </button>
            ) : null}
        </div>
    );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors. Confirm no VSCode errors in `outputpanel.tsx`.

- [ ] **Step 3: Checkpoint**

Stage: `git add frontend/app/view/agents/outputpanel.tsx`

---

### Task 5: AgentsView — focus/queue asks over a working grid

**Files:**
- Modify: `frontend/app/view/agents/agents.tsx`
- Modify: `frontend/app/view/agents/agentsviewmodel.ts` (remove the superseded `outputPanelOrder`)
- Modify: `frontend/app/view/agents/agentsviewmodel.test.ts` (remove its test)

- [ ] **Step 1: Remove the superseded `outputPanelOrder`**

In `frontend/app/view/agents/agentsviewmodel.ts`, delete the `outputPanelOrder` function (the block with the doc-comment "the agents to render as output panels … idle excluded"). In `frontend/app/view/agents/agentsviewmodel.test.ts`, delete the `describe("outputPanelOrder", …)` block. (It's replaced by `groupAgents` + `resolveFocusedAskId`.)

- [ ] **Step 2: Replace the imports and `AgentsView` in `agents.tsx`**

In `frontend/app/view/agents/agents.tsx`, replace the `agentsviewmodel` import line and the entire `AgentsView` function with the version below. Add a small `QueueRow` component above `AgentsView`. The stream lifecycle still streams **working** agents only here (asks get streamed in Task 6):

Import line — replace:
```tsx
import { askingCount, outputPanelOrder, type AgentVM } from "./agentsviewmodel";
```
with:
```tsx
import { formatAge, groupAgents, resolveFocusedAskId, type AgentVM } from "./agentsviewmodel";
```

Add `QueueRow` + new `AgentsView`:
```tsx
function QueueRow({ agent, onFocus }: { agent: AgentVM; onFocus: (id: string) => void }) {
    const question = agent.ask?.questions?.[0]?.question ?? "";
    return (
        <div
            onClick={() => onFocus(agent.id)}
            className="flex cursor-pointer items-center gap-2.5 rounded-[7px] border border-[#d29922]/60 bg-[#d29922]/[0.05] px-3 py-2 hover:bg-[#d29922]/10"
        >
            <span className="h-2 w-2 shrink-0 rounded-full bg-[#d29922]" />
            <b className="shrink-0 text-[12.5px] text-[#e6edf3]">{agent.name}</b>
            <span className="truncate text-[12px] text-[#8b949e]">{question}</span>
            <span className="ml-auto shrink-0 text-[10.5px] text-[#d29922]">{formatAge(agent.blockedMs)} · answer →</span>
        </div>
    );
}

function AgentsView({ model }: { model: AgentsViewModel }) {
    const agents = useAtomValue(model.agentsAtom);
    const { asking, working } = groupAgents(agents);
    const open = (id: string) => setActiveTab(id);
    const answer = (oref: string, answers: AgentAnswerItem[]) => {
        if (!oref) {
            return;
        }
        fireAndForget(() => RpcApi.AnswerAgentCommand(TabRpcClient, { oref, answers }));
    };

    const [focusedAskId, setFocusedAskId] = useState<string>();
    const focusedId = resolveFocusedAskId(asking, focusedAskId);
    const focused = asking.find((a) => a.id === focusedId);
    const queue = asking.filter((a) => a.id !== focusedId);

    // 1s tick so the liveness cue (⟳ since / quiet) stays current without a global ticker
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const t = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
    }, []);

    // one-shot previous-info for asking agents (first paint; the stream supersedes it in Task 6)
    useEffect(() => {
        for (const a of asking) {
            if (a.transcriptPath) {
                void ensurePreviousInfo(a.id, a.transcriptPath);
            }
        }
    }, [asking]);

    // open a live transcript stream per visible working agent; stop streams that left the set
    const streamedRef = useRef<Set<string>>(new Set());
    useEffect(() => {
        const wantedById = new Map<string, string>();
        for (const a of working) {
            if (a.transcriptPath) {
                wantedById.set(a.id, a.transcriptPath);
            }
        }
        for (const [id, path] of wantedById) {
            if (!streamedRef.current.has(id)) {
                startTranscriptStream(id, path);
                streamedRef.current.add(id);
            }
        }
        for (const id of [...streamedRef.current]) {
            if (!wantedById.has(id)) {
                stopTranscriptStream(id);
                streamedRef.current.delete(id);
            }
        }
    }, [working]);

    useEffect(() => {
        return () => {
            for (const id of streamedRef.current) {
                stopTranscriptStream(id);
            }
            streamedRef.current.clear();
        };
    }, []);

    const empty = asking.length === 0 && working.length === 0;

    return (
        <div className="flex h-full w-full flex-col bg-[#0b0e14] text-[#c9d1d9]">
            <div className="flex shrink-0 items-center justify-between border-b border-[#1c2230] px-[18px] py-3">
                <b className="text-[15px] text-[#e6edf3]">Agents</b>
                <span className="text-[12px] text-[#6b7585]">
                    <span className="text-[#d29922]">{asking.length} asking</span> · {working.length} working
                </span>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-hidden p-[18px]">
                {empty && (
                    <div className="flex flex-1 flex-col items-center justify-center gap-1 text-center">
                        <div className="text-[22px] opacity-50">🤖</div>
                        <div className="text-[13px] font-semibold text-[#c9d1d9]">No active agents</div>
                        <div className="text-[11.5px] text-[#6b7585]">
                            Agents appear here the moment one starts working or asks a question.
                        </div>
                    </div>
                )}
                {focused && (
                    <div className="shrink-0">
                        <AskCard key={focused.ask?.askId ?? focused.id} agent={focused} onAnswer={answer} onOpen={open} />
                    </div>
                )}
                {queue.length > 0 && (
                    <div className="flex shrink-0 flex-col gap-1.5">
                        <div className="text-[10.5px] uppercase tracking-wide text-[#9aa4b2]">
                            {queue.length} more waiting
                        </div>
                        <div className="flex max-h-[180px] flex-col gap-1.5 overflow-y-auto">
                            {queue.map((a) => (
                                <QueueRow key={a.id} agent={a} onFocus={setFocusedAskId} />
                            ))}
                        </div>
                    </div>
                )}
                {working.length > 0 && (
                    <div className="grid min-h-0 flex-1 auto-rows-[260px] grid-cols-[repeat(auto-fill,minmax(360px,1fr))] gap-2.5 overflow-y-auto">
                        {working.map((a) => (
                            <WorkingPanel key={a.id} agent={a} now={now} onOpen={open} />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
```

> `useState`, `useEffect`, `useRef` are already imported (`agents.tsx:11`). `AskCard`, `WorkingPanel`, `ensurePreviousInfo`, `startTranscriptStream`, `stopTranscriptStream`, `setActiveTab`, `RpcApi`, `TabRpcClient`, `fireAndForget`, `useAtomValue` are already imported and unchanged. `AgentAnswerItem` is ambient.

- [ ] **Step 3: Verify it compiles and pure tests pass**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors (no remaining reference to `outputPanelOrder` or `askingCount`).
Run: `npx vitest run frontend/app/view/agents/`
Expected: PASS.

- [ ] **Step 4: Checkpoint**

Stage: `git add frontend/app/view/agents/agents.tsx frontend/app/view/agents/agentsviewmodel.ts frontend/app/view/agents/agentsviewmodel.test.ts`

---

### Task 6: Live asking-card narration

**Files:**
- Modify: `frontend/app/view/agents/agents.tsx` (stream asks too)
- Modify: `frontend/app/view/agents/askcard.tsx` (read live entries)

- [ ] **Step 1: Stream asking agents as well**

In `frontend/app/view/agents/agents.tsx`, in the stream-lifecycle effect, change the loop that builds `wantedById` to include asking agents, and update the dependency array:

```tsx
    useEffect(() => {
        const wantedById = new Map<string, string>();
        for (const a of [...asking, ...working]) {
            if (a.transcriptPath) {
                wantedById.set(a.id, a.transcriptPath);
            }
        }
        for (const [id, path] of wantedById) {
            if (!streamedRef.current.has(id)) {
                startTranscriptStream(id, path);
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
```

- [ ] **Step 2: Have AskCard read live narration**

In `frontend/app/view/agents/askcard.tsx`, add the imports:

```tsx
import { useAtomValue } from "jotai";
import { liveEntriesByIdAtom } from "./livetranscript";
```

Inside `AskCard`, after `const [selections, ...]`, derive the narration entries (live, falling back to the one-shot snapshot):

```tsx
    const liveEntries = useAtomValue(liveEntriesByIdAtom);
    const entries = liveEntries[agent.id] ?? agent.previousInfo ?? [];
```

Then change the narration render line from:
```tsx
            {agent.previousInfo?.length ? <PreviousInfo entries={agent.previousInfo} /> : null}
```
to:
```tsx
            {entries.length ? <PreviousInfo entries={entries} /> : null}
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors.

- [ ] **Step 4: Checkpoint**

Stage: `git add frontend/app/view/agents/agents.tsx frontend/app/view/agents/askcard.tsx`

---

### Task 7: Live walkthrough verification + batched commit

**Files:** none (verification + commit). Uses the dev app + CDP per `memory/cdp-verify-dev-app.md`.

- [ ] **Step 1: Run the full frontend checks**

Run (from project root):
`npx tsc --noEmit -p tsconfig.json` → no errors.
`npx vitest run frontend/app/view/agents/` → PASS.

- [ ] **Step 2: Drive real agents and observe**

Rebuild/relaunch the dev app. Open the Agents tab and verify:
- A **multi-question / multi-select** ask renders all questions in the focused card; selecting options and Submit resolves it (and the terminal mirror still works). *(If Task 1 flagged the hook as single-select-only, confirm the panel submits correctly and note the hook still drops extra answers.)*
- With **multiple asks**: the oldest is focused (full card); the rest are one-line queue rows; clicking a queue row promotes it; answering the focused ask advances focus to the next.
- **Working panels** render in a responsive grid (multiple columns when wide, one when narrow); each scrolls internally pinned to latest.
- **Quiet cue**: an agent idle on a long tool call shows a hollow dot + amber `⟳ … · quiet`.
- **New-output pill**: scroll a panel up while it streams → `↓ N new` appears; clicking it jumps to latest.
- **Asking-card narration** updates from the live stream (not a frozen snapshot).
- **Empty state** shows when no agents are active.

- [ ] **Step 3: Record results**

Note PASS/FAIL per check (and the Task 1 hook verdict) in the session notes.

- [ ] **Step 4: Present the batched commit for approval**

Run: `git status` and `git diff --staged --stat`. Present the file list (M/A/D + one-line summary each) and the proposed message:

```
feat(agents): full AskUserQuestion answering + focus/queue layout, live ask narration, liveness cues
```

- [ ] **Step 5: Commit only on explicit approval**

Ask: "Awaiting approval. Proceed with the commit? (yes/no)". Only on explicit "yes":

```bash
git commit -m "feat(agents): full AskUserQuestion answering + focus/queue layout, live ask narration, liveness cues"
```

Do not push unless separately asked.

---

## Self-review

**Spec coverage (Phase 1 scope):** §3 answering → Task 3 (+ pure fns Task 2); §4 layout (focus/queue + grid + empty state) → Task 5; §5 live ask narration → Task 6; §6 polish (quiet cue, new-output pill) → Task 4; §8 hook dependency → Task 1; §10 pure tests → Task 2; live behavior → Task 7. **§7 motion is explicitly out of this plan** (Phase 2 follow-on) — stated in the header, not a silent gap.

**Placeholder scan:** none — every code step shows complete code; verification steps (Tasks 1, 7) give concrete commands.

**Type consistency:** `buildAskAnswers`, `canSubmitAsk`, `isQuiet`, `resolveFocusedAskId` are defined in Task 2 and consumed with identical signatures in Tasks 3–5; `groupAgents` returns `{ asking, working, idle }` (existing); `AgentAnswerItem` is ambient; `outputPanelOrder` is removed in the same task (5) that drops its only consumer.
