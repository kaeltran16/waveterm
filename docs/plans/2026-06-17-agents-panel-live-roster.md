# Agents Panel — Live Roster + Previous-Info Display (Plan 3a of 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Agents view's mock data with a live roster derived from the existing session-status pipeline; show real previous-info + a real task label on "needs you" cards (peek-to-answer); wire the live sidebar badge.

**Architecture:** Derive `AgentVM[]` reactively from `sessionSidebarViewModelAtom` — the same atom the session sidebar already renders, so the roster has a single source of truth. A pure mapping turns each row + its agent-status into an `AgentVM`, mapping the existing `waiting` status to the view's `asking` state. For `asking` agents only, a view effect fetches the transcript once (reusing Plan 2's `fetchPreviousInfo`) and fills previous-info + the `ai-title` task. The needs-you card renders previous-info + an **Open session to answer** button; the structured question + inline answer routing are deferred to Plan 3b (they come from `ask_human`, which 3b builds). The sidebar badge reads the live asking count.

**Tech Stack:** TypeScript/React, Jotai, vitest.

**Source of truth:** spec `docs/specs/2026-06-17-agents-panel-design.md` §5.1 (roster from `agentstatusstore`), §5.3/§10.1 (previous-info projection — shipped Plan 2), §5.5 (idle straggler / peek), §10.3 (live working line vs on-demand previous-info), §10.4 (asking as a status). Builds directly on Plan 2 (`docs/plans/2026-06-17-agents-panel-previous-info.md`).

**Scope note:** Plan 3a of 3. **In scope:** the live data source (replace `MockAgentsDataSource`), the pure row→`AgentVM` mapping, `ai-title` task extraction, on-demand previous-info fetch for needs-you agents, peek-to-answer on the needs-you card, the live sidebar badge, idle peek. **Out of scope (Plan 3b):** the `ask_human` MCP channel, the structured question payload (`AgentVM.ask`), and inline answer routing that unblocks the agent. Until 3b, a needs-you agent is answered by opening its session (peek).

**Decisions locked with the user (2026-06-17):**
- Needs-you answering in 3a = **peek-to-answer** (open the session; no dead inline pills).
- Task label = **`ai-title`, fetched for needs-you agents only** (near-free since we already fetch their transcript). Working/idle rows show activity only; a continuous task label for every agent is a noted fast-follow.

**Verified facts (this session):**
- Live roster source: `sessionSidebarViewModelAtom` → `SidebarViewModel { pinned, groups }`; `flattenVisualOrder(vm)` yields all `SessionRowVM` in visual order. `SessionRowVM` = `{ tabId, label, status: "working"|"waiting"|"idle", active, blocked, pinned, detail?, model?, subagents, subagentsExpanded, termBlockOref? }` (`frontend/app/tab/sessionsidebar/sessionviewmodel.ts:71-84`).
- Per-block agent status: `getAgentStatusAtom(oref)` → `PrimitiveAtom<AgentStatusData>` (`frontend/app/tab/sessionsidebar/agentstatusstore.ts:15`). `AgentStatusData` (generated) carries `state`, `detail`, `model`, `transcriptpath`, `ts` (`pkg/baseds/baseds.go`; `ts` is `UnixMilli`).
- `modelLabel(modelId?)` → short family label, pure (`frontend/app/tab/sessionsidebar/sessionviewmodel.ts:287`).
- `fetchPreviousInfo(transcriptPath, maxLines?)` → `Promise<AgentEntry[]>` (Plan 2, `frontend/app/view/agents/previousinfo.ts:14`); `projectTranscript(lines)` (`transcriptprojection.ts:54`).
- `ai-title` record shape (verified against a real transcript): `{"type":"ai-title","aiTitle":"Start plan 3","sessionId":"…"}` — field `aiTitle`, repeats through the session (take the last).
- `setActiveTab(tabId)` opens/focuses a session (`frontend/app/store/global`); so `AgentVM.id` must be the **tabId** for `onOpen` to work.
- Sidebar badge today: `const asking = askingCount(MOCK_AGENTS);` (`frontend/app/tab/sessionsidebar/sessionsidebar.tsx:140`).

---

## File Structure

**Create:**
- `frontend/app/view/agents/liveagents.ts` — the live data layer: the derived base-roster atom (sidebar VM + status → `AgentVM[]`), the per-id previous-info cache atom, the merged `liveAgentsAtom`, the live asking-count atom, and `ensurePreviousInfo(id, path)`. The only Wave-runtime module added this plan.

**Modify:**
- `frontend/app/view/agents/agentsviewmodel.ts` — add `transcriptPath?` to `AgentVM`; add the pure `LiveAgentInput` type + `agentVMFromInput(input, now)` mapping. (Pure; unit-tested.)
- `frontend/app/view/agents/agentsviewmodel.test.ts` — tests for `agentVMFromInput`.
- `frontend/app/view/agents/transcriptprojection.ts` — add pure `extractAiTitle(lines)`.
- `frontend/app/view/agents/transcriptprojection.test.ts` — tests for `extractAiTitle`.
- `frontend/app/view/agents/previousinfo.ts` — `fetchPreviousInfo` returns `{ entries, title }` (single fetch, both projections).
- `frontend/app/view/agents/agents.tsx` — `AgentsViewModel` reads `liveAgentsAtom`; the view runs the needs-you previous-info effect.
- `frontend/app/view/agents/askcard.tsx` — render previous-info always; inline question/answer only when `agent.ask` exists, else an **Open session to answer** peek button.
- `frontend/app/tab/sessionsidebar/sessionsidebar.tsx` — badge reads `liveAskingCountAtom` instead of `askingCount(MOCK_AGENTS)`.

**Unchanged / retained:** `agentsmockdata.ts` and `agentsdatasource.ts` stay for the projection/unit tests and Storybook, but the live view no longer imports the mock. `transcriptprojection.ts`'s existing `projectTranscript` is unchanged.

---

### Task 1: `AgentVM.transcriptPath` + pure row→AgentVM mapping

**Files:**
- Modify: `frontend/app/view/agents/agentsviewmodel.ts`
- Test: `frontend/app/view/agents/agentsviewmodel.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `frontend/app/view/agents/agentsviewmodel.test.ts`:

```ts
import { agentVMFromInput, type LiveAgentInput } from "./agentsviewmodel";

describe("agentVMFromInput", () => {
    const NOW = 1_000_000;

    it("maps a working row: status->working, model label, activeMs from ts", () => {
        const input: LiveAgentInput = {
            id: "tab-1",
            name: "waveterm",
            status: "working",
            detail: "go test ./pkg/wconfig/…",
            model: "claude-sonnet-4-6",
            ts: NOW - 120_000,
            transcriptPath: "/p/t.jsonl",
        };
        expect(agentVMFromInput(input, NOW)).toEqual({
            id: "tab-1",
            name: "waveterm",
            task: "",
            state: "working",
            model: "sonnet",
            activity: "go test ./pkg/wconfig/…",
            activeMs: 120_000,
            transcriptPath: "/p/t.jsonl",
        });
    });

    it("maps a waiting row to the asking state with blockedMs", () => {
        const input: LiveAgentInput = { id: "tab-2", name: "loom", status: "waiting", model: "claude-opus-4-8", ts: NOW - 240_000 };
        const vm = agentVMFromInput(input, NOW);
        expect(vm.state).toBe("asking");
        expect(vm.blockedMs).toBe(240_000);
        expect(vm.activeMs).toBeUndefined();
        expect(vm.model).toBe("opus");
    });

    it("maps anything else to idle, with no age field, and tolerates a missing ts", () => {
        const vm = agentVMFromInput({ id: "tab-3", name: "obsidian", status: "idle", detail: "stopped without asking" }, NOW);
        expect(vm.state).toBe("idle");
        expect(vm.activeMs).toBeUndefined();
        expect(vm.blockedMs).toBeUndefined();
        expect(vm.activity).toBe("stopped without asking");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts`
Expected: FAIL — `agentVMFromInput`/`LiveAgentInput` not exported.

- [ ] **Step 3: Implement the type field + mapping**

In `frontend/app/view/agents/agentsviewmodel.ts`, add `transcriptPath?` to the `AgentVM` interface (after `ask?`):

```ts
    ask?: AgentAsk; // present iff state === "asking"
    transcriptPath?: string; // source for on-demand previous-info (not rendered directly)
}
```

Add the import at the top (pure → pure; allowed):

```ts
import { modelLabel } from "@/app/tab/sessionsidebar/sessionviewmodel";
```

Append the mapping (keep the file's "no React, no Wave runtime imports" rule — `modelLabel` is a pure function):

```ts
/** Minimal per-agent inputs the live roster feeds the pure mapping. `status` is the sidebar's
 *  SessionStatus string ("working" | "waiting" | "idle"); `ts` is the status event's UnixMilli. */
export interface LiveAgentInput {
    id: string; // tabId — open target + stable key
    name: string;
    status: string;
    detail?: string;
    model?: string; // raw model id
    ts?: number; // last status change (UnixMilli)
    transcriptPath?: string;
}

/** Pure: one live row -> an AgentVM. `waiting` becomes `asking`; age is derived from `now - ts`
 *  (asking -> blockedMs, working -> activeMs). previousInfo/ask/task are filled later (async). */
export function agentVMFromInput(input: LiveAgentInput, now: number): AgentVM {
    const state: AgentState = input.status === "waiting" ? "asking" : input.status === "working" ? "working" : "idle";
    const age = input.ts != null ? Math.max(0, now - input.ts) : undefined;
    const vm: AgentVM = {
        id: input.id,
        name: input.name,
        task: "",
        state,
        model: modelLabel(input.model),
        activity: input.detail,
        transcriptPath: input.transcriptPath,
    };
    if (state === "asking") {
        vm.blockedMs = age;
    } else if (state === "working") {
        vm.activeMs = age;
    }
    return vm;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/agentsviewmodel.ts frontend/app/view/agents/agentsviewmodel.test.ts
git commit -m "feat(agents): pure live-row to AgentVM mapping"
```

---

### Task 2: `extractAiTitle` pure helper

**Files:**
- Modify: `frontend/app/view/agents/transcriptprojection.ts`
- Test: `frontend/app/view/agents/transcriptprojection.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `frontend/app/view/agents/transcriptprojection.test.ts`:

```ts
import { extractAiTitle } from "./transcriptprojection";

describe("extractAiTitle", () => {
    it("returns the LAST ai-title's aiTitle", () => {
        const lines = [
            JSON.stringify({ type: "mode", mode: "normal" }),
            JSON.stringify({ type: "ai-title", aiTitle: "First guess" }),
            JSON.stringify({ type: "last-prompt", lastPrompt: "do the thing" }),
            JSON.stringify({ type: "ai-title", aiTitle: "Fix duplicate-session race" }),
        ];
        expect(extractAiTitle(lines)).toBe("Fix duplicate-session race");
    });

    it("returns undefined when there is no ai-title, and skips unparseable lines", () => {
        expect(extractAiTitle([JSON.stringify({ type: "assistant", message: { content: [] } }), "{bad"])).toBeUndefined();
        expect(extractAiTitle([])).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/transcriptprojection.test.ts`
Expected: FAIL — `extractAiTitle` not exported.

- [ ] **Step 3: Implement the helper**

Append to `frontend/app/view/agents/transcriptprojection.ts`:

```ts
/** Pure: the most recent ai-title in the transcript, or undefined. Claude Code emits multiple
 *  `{type:"ai-title", aiTitle}` records as the title is refined; the last one is current. */
export function extractAiTitle(lines: string[]): string | undefined {
    let title: string | undefined;
    for (const line of lines) {
        let rec: any;
        try {
            rec = JSON.parse(line);
        } catch {
            continue;
        }
        if (rec?.type === "ai-title" && typeof rec.aiTitle === "string" && rec.aiTitle.trim() !== "") {
            title = rec.aiTitle;
        }
    }
    return title;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/transcriptprojection.test.ts`
Expected: PASS (existing `projectTranscript` tests + the 2 new ones).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/transcriptprojection.ts frontend/app/view/agents/transcriptprojection.test.ts
git commit -m "feat(agents): extract ai-title from transcript"
```

---

### Task 3: `fetchPreviousInfo` returns entries + title

**Files:**
- Modify: `frontend/app/view/agents/previousinfo.ts`

(No new test: this is RPC glue, verified by `tsc` and exercised live — consistent with Plan 2, which did not unit-test `previousinfo.ts`. It has no callers yet, so the signature change breaks nothing.)

- [ ] **Step 1: Update the helper to return both projections from one fetch**

Replace the body of `frontend/app/view/agents/previousinfo.ts` with:

```ts
// frontend/app/view/agents/previousinfo.ts
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import type { AgentEntry } from "./agentsviewmodel";
import { extractAiTitle, projectTranscript } from "./transcriptprojection";

const DEFAULT_TAIL_LINES = 300;

export interface PreviousInfoResult {
    entries: AgentEntry[];
    title?: string; // the agent's ai-title (used as the task label)
}

// Fetch an agent's recent transcript once and project both previous-info entries and the ai-title.
// On any read failure returns empty entries (spec §7: render the question alone). Called when a
// needs-you card mounts, passing AgentStatusData.transcriptpath (carried since Plan 2).
export async function fetchPreviousInfo(transcriptPath: string, maxLines = DEFAULT_TAIL_LINES): Promise<PreviousInfoResult> {
    if (!transcriptPath) {
        return { entries: [] };
    }
    try {
        const rtn = await RpcApi.GetAgentTranscriptCommand(TabRpcClient, { path: transcriptPath, maxlines: maxLines });
        const lines = rtn?.lines ?? [];
        return { entries: projectTranscript(lines), title: extractAiTitle(lines) };
    } catch {
        return { entries: [] };
    }
}
```

- [ ] **Step 2: Verify typecheck + lint**

Run: `npx tsc --noEmit && npx eslint frontend/app/view/agents/previousinfo.ts`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/app/view/agents/previousinfo.ts
git commit -m "feat(agents): fetchPreviousInfo returns entries + ai-title"
```

---

### Task 4: Live data layer (`liveagents.ts`)

**Files:**
- Create: `frontend/app/view/agents/liveagents.ts`

(Atom wiring + async glue; verified by `tsc`/`eslint` and exercised live in Task 7. The pure logic it composes — `agentVMFromInput`, `extractAiTitle`, `askingCount`, `sortAgents`/`groupAgents` — is already unit-tested.)

- [ ] **Step 1: Write the module**

```ts
// frontend/app/view/agents/liveagents.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The live Agents roster: derived from sessionSidebarViewModelAtom (single source of truth for
// running sessions) + per-block agent status. previous-info + task are fetched on demand for
// asking agents only (spec §10.3). No ask_human / answer routing here (Plan 3b).

import { globalStore } from "@/app/store/jotaiStore";
import { getAgentStatusAtom } from "@/app/tab/sessionsidebar/agentstatusstore";
import { sessionSidebarViewModelAtom } from "@/app/tab/sessionsidebar/sessionsidebarmodel";
import { flattenVisualOrder } from "@/app/tab/sessionsidebar/sessionviewmodel";
import { atom, type Atom, type PrimitiveAtom } from "jotai";
import { agentVMFromInput, askingCount, type AgentEntry, type AgentVM } from "./agentsviewmodel";
import { fetchPreviousInfo } from "./previousinfo";

interface PreviousInfoEntry {
    entries: AgentEntry[];
    title?: string;
}

// id (tabId) -> fetched previous-info + title; filled by ensurePreviousInfo for asking agents.
export const previousInfoByIdAtom = atom<Record<string, PreviousInfoEntry>>({}) as PrimitiveAtom<Record<string, PreviousInfoEntry>>;

// in-flight guard so the view effect doesn't double-fetch the same agent
const previousInfoLoading = new Set<string>();

// The roster without previous-info: every running session that has emitted an agent status,
// mapped to an AgentVM. Sessions with no agent status (plain shells, the Agents tab itself) are
// excluded. Recomputes on any sidebar/status change; age is computed at recompute time.
export const liveAgentBaseAtom: Atom<AgentVM[]> = atom((get) => {
    const vm = get(sessionSidebarViewModelAtom);
    const now = Date.now();
    const agents: AgentVM[] = [];
    for (const row of flattenVisualOrder(vm)) {
        if (!row.termBlockOref) {
            continue;
        }
        const status = get(getAgentStatusAtom(row.termBlockOref));
        if (!status?.state) {
            continue; // not an agent (no status emitted) — skip
        }
        agents.push(
            agentVMFromInput(
                {
                    id: row.tabId,
                    name: row.label,
                    status: row.status,
                    detail: row.detail,
                    model: row.model,
                    ts: status.ts,
                    transcriptPath: status.transcriptpath,
                },
                now
            )
        );
    }
    return agents;
});

// The rendered roster: base agents with fetched previous-info + task merged onto asking agents.
export const liveAgentsAtom: Atom<AgentVM[]> = atom((get) => {
    const base = get(liveAgentBaseAtom);
    const info = get(previousInfoByIdAtom);
    return base.map((a) => {
        if (a.state !== "asking") {
            return a;
        }
        const pi = info[a.id];
        if (!pi) {
            return a;
        }
        return { ...a, previousInfo: pi.entries, task: pi.title ?? a.task };
    });
});

// The sidebar badge count — derived from the base roster (no need to wait on previous-info).
export const liveAskingCountAtom: Atom<number> = atom((get) => askingCount(get(liveAgentBaseAtom)));

/** Fetch + cache previous-info (and the ai-title task) for one asking agent. Idempotent: skips if
 *  already loaded or in flight. Fetched once when the agent enters asking — the question moment;
 *  it is not refreshed while the agent stays asking (a noted 3a limitation). */
export async function ensurePreviousInfo(id: string, transcriptPath: string): Promise<void> {
    if (!transcriptPath || previousInfoLoading.has(id)) {
        return;
    }
    if (globalStore.get(previousInfoByIdAtom)[id]) {
        return;
    }
    previousInfoLoading.add(id);
    try {
        const result = await fetchPreviousInfo(transcriptPath);
        const current = globalStore.get(previousInfoByIdAtom);
        globalStore.set(previousInfoByIdAtom, { ...current, [id]: { entries: result.entries, title: result.title } });
    } finally {
        previousInfoLoading.delete(id);
    }
}
```

- [ ] **Step 2: Verify typecheck + lint**

Run: `npx tsc --noEmit && npx eslint frontend/app/view/agents/liveagents.ts`
Expected: no errors. (`sessionSidebarViewModelAtom` is exported from `sessionsidebarmodel.ts:34`; `flattenVisualOrder` from `sessionviewmodel.ts:167`; `getAgentStatusAtom` from `agentstatusstore.ts:15`.)

- [ ] **Step 3: Commit**

```bash
git add frontend/app/view/agents/liveagents.ts
git commit -m "feat(agents): live roster data layer"
```

---

### Task 5: Wire the view model + needs-you fetch effect

**Files:**
- Modify: `frontend/app/view/agents/agents.tsx`

- [ ] **Step 1: Point the view model at the live atom and run the fetch effect**

In `frontend/app/view/agents/agents.tsx`:

Update imports — drop the mock/data-source imports, add the live atom + the effect deps:

```ts
import type { BlockNodeModel } from "@/app/block/blocktypes";
import { setActiveTab } from "@/app/store/global";
import type { TabModel } from "@/app/store/tab-model";
import { useAtomValue, type Atom } from "jotai";
import { useEffect } from "react";
import { IdleRow, WorkingRow } from "./agentrows";
import { AskCard } from "./askcard";
import { askingCount, groupAgents, type AgentVM } from "./agentsviewmodel";
import { ensurePreviousInfo, liveAgentsAtom } from "./liveagents";
```

Replace the `AgentsView` function's data wiring. The `answer` handler is a no-op in 3a (peek-to-answer; 3b wires real routing), so the card uses `onOpen` to answer:

```tsx
function AgentsView({ model }: { model: AgentsViewModel }) {
    const agents = useAtomValue(model.agentsAtom);
    const sections = groupAgents(agents);
    const asking = askingCount(agents);
    const open = (id: string) => setActiveTab(id);

    // fetch previous-info + task for needs-you agents on demand (spec §10.3)
    useEffect(() => {
        for (const a of agents) {
            if (a.state === "asking" && a.transcriptPath) {
                void ensurePreviousInfo(a.id, a.transcriptPath);
            }
        }
    }, [agents]);

    return (
        <div className="flex h-full w-full flex-col bg-[#0b0e14] text-[#c9d1d9]">
            <div className="flex shrink-0 items-center justify-between border-b border-[#1c2230] px-[18px] py-3">
                <b className="text-[15px] text-[#e6edf3]">Agents</b>
                <span className="text-[12px] text-[#6b7585]">
                    <span className="text-[#d29922]">{asking} asking</span> · {sections.working.length} working · {sections.idle.length} idle
                </span>
            </div>
            <div className="flex-1 overflow-auto p-[18px]">
                <div className="w-full">
                    {sections.asking.length === 0 && sections.working.length === 0 && sections.idle.length === 0 && (
                        <div className="px-0.5 py-6 text-[13px] text-[#6b7585]">No agents running</div>
                    )}
                    {sections.asking.length > 0 && <SectionLabel>needs you</SectionLabel>}
                    {sections.asking.map((a) => (
                        <AskCard key={a.id} agent={a} onOpen={open} />
                    ))}
                    {sections.working.length > 0 && <SectionLabel>working</SectionLabel>}
                    {sections.working.map((a) => (
                        <WorkingRow key={a.id} agent={a} onOpen={open} />
                    ))}
                    {sections.idle.length > 0 && <SectionLabel>idle</SectionLabel>}
                    {sections.idle.map((a) => (
                        <IdleRow key={a.id} agent={a} onOpen={open} />
                    ))}
                </div>
            </div>
        </div>
    );
}
```

Update the `AgentsViewModel` class to read the live atom (drop `dataSource` and the seeded primitive atom):

```ts
export class AgentsViewModel implements ViewModel {
    viewType: string;
    blockId: string;
    nodeModel: BlockNodeModel;
    tabModel: TabModel;
    viewIcon = atom<string>("robot");
    viewName = atom<string>("Agents");
    noPadding = atom(true);
    agentsAtom: Atom<AgentVM[]> = liveAgentsAtom;

    constructor({ blockId, nodeModel, tabModel }: ViewModelInitType) {
        this.blockId = blockId;
        this.nodeModel = nodeModel;
        this.tabModel = tabModel;
        this.viewType = "agents";
    }

    get viewComponent(): ViewComponent {
        return AgentsView;
    }
}
```

> Note: `atom` is still imported (used by `viewIcon`/`viewName`/`noPadding`). Keep the existing `import { atom } from "jotai"` — merge it with the `useAtomValue, type Atom` import shown above into a single `import { atom, useAtomValue, type Atom } from "jotai";`.

- [ ] **Step 2: Verify typecheck + lint**

Run: `npx tsc --noEmit && npx eslint frontend/app/view/agents/agents.tsx`
Expected: no errors. (`AskCard`'s `onAnswer` prop becomes optional in Task 6, so dropping it here is valid only after Task 6 — implement Task 6 before re-running, or run the combined check at the end of Task 6.)

- [ ] **Step 3: Commit** (after Task 6 typechecks clean — these two files change together)

Deferred to Task 6's commit.

---

### Task 6: Needs-you card = previous-info + peek (no dead pills)

**Files:**
- Modify: `frontend/app/view/agents/askcard.tsx`

- [ ] **Step 1: Make the inline answer control conditional; add the peek button**

In `frontend/app/view/agents/askcard.tsx`, make `onAnswer` optional and render the inline question/answer block only when a structured `ask` is present (Plan 3b populates it). Otherwise render an **Open session to answer** button.

Update the component signature and the body below the previous-info line:

```tsx
export function AskCard({
    agent,
    onAnswer,
    onOpen,
}: {
    agent: AgentVM;
    onAnswer?: (id: string, answer: string) => void;
    onOpen: (id: string) => void;
}) {
    const [reply, setReply] = useState("");
    const options = agent.ask?.options ?? ["Yes", "No"];
    const submitReply = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key !== "Enter" || reply.trim().length === 0) {
            return;
        }
        onAnswer?.(agent.id, reply.trim());
        setReply("");
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

            {agent.ask ? (
                <div className="mt-3.5 border-t border-[#2a2f3a] pt-3.5">
                    <div className="text-[14px] font-semibold text-[#e6edf3]">{agent.ask.question}</div>
                    {agent.ask.recommendation ? (
                        <div className="mt-1 text-[11.5px] text-[#6b7585]">its take: {agent.ask.recommendation}</div>
                    ) : null}
                    <div className="mt-3 flex items-center gap-2.5">
                        {options.map((opt, i) => (
                            <button
                                key={opt}
                                type="button"
                                onClick={() => onAnswer?.(agent.id, opt)}
                                className={cn(
                                    "cursor-pointer rounded-[7px] px-[18px] py-1.5 text-[12.5px]",
                                    i === 0 && (options[0] === "Yes" || options.length > 2)
                                        ? "bg-[#238636] font-semibold text-white"
                                        : "border border-[#2c3340] text-[#c9d1d9]"
                                )}
                            >
                                {opt}
                            </button>
                        ))}
                        <input
                            value={reply}
                            onChange={(e) => setReply(e.target.value)}
                            onKeyDown={submitReply}
                            placeholder="or type a reply…"
                            className="flex-1 rounded-[7px] border border-[#1c2230] bg-[#0b0e14] px-3 py-1.5 text-[12px] text-[#8b949e]"
                        />
                    </div>
                </div>
            ) : (
                <div className="mt-3.5 border-t border-[#2a2f3a] pt-3.5">
                    <button
                        type="button"
                        onClick={() => onOpen(agent.id)}
                        className="cursor-pointer rounded-[7px] bg-[#238636] px-[18px] py-1.5 text-[12.5px] font-semibold text-white"
                    >
                        Open session to answer
                    </button>
                </div>
            )}
        </div>
    );
}
```

- [ ] **Step 2: Verify typecheck, lint, and all unit tests**

Run: `npx tsc --noEmit && npx eslint frontend/app/view/agents/ && npx vitest run frontend/app/view/agents/`
Expected: no errors; all agents-view unit tests pass.

- [ ] **Step 3: Commit (agents.tsx + askcard.tsx together)**

```bash
git add frontend/app/view/agents/agents.tsx frontend/app/view/agents/askcard.tsx
git commit -m "feat(agents): live roster in the view + peek-to-answer needs-you cards"
```

---

### Task 7: Live sidebar badge

**Files:**
- Modify: `frontend/app/tab/sessionsidebar/sessionsidebar.tsx`

- [ ] **Step 1: Read the live asking count instead of the mock**

In `frontend/app/tab/sessionsidebar/sessionsidebar.tsx`:

Replace the mock imports (lines 8-9):

```ts
import { liveAskingCountAtom } from "@/app/view/agents/liveagents";
```

(Remove `import { MOCK_AGENTS } from "@/app/view/agents/agentsmockdata";` and `import { askingCount } from "@/app/view/agents/agentsviewmodel";` — both are now unused here.)

Replace the badge derivation (line 140). It is a hook, so it goes at the top of the component with the other `useAtomValue` calls (not inline):

```ts
    const asking = useAtomValue(liveAskingCountAtom);
```

Delete the old line: `const asking = askingCount(MOCK_AGENTS); // Plan 3 swaps MOCK_AGENTS for the live asking count`. The JSX `{asking > 0 && (…)}` badge is unchanged.

- [ ] **Step 2: Verify typecheck + lint**

Run: `npx tsc --noEmit && npx eslint frontend/app/tab/sessionsidebar/sessionsidebar.tsx`
Expected: no errors. Confirm `useAtomValue` is already imported in this file (it is, line 11) and that `MOCK_AGENTS`/`askingCount` have no other references in the file.

- [ ] **Step 3: Commit**

```bash
git add frontend/app/tab/sessionsidebar/sessionsidebar.tsx
git commit -m "feat(agents): live asking-count badge in the sidebar"
```

---

### Task 8: Live verification (manual, no new code)

**Files:** none (verification only — mirrors the sidebar/loom live-verification convention; see the [[cdp-verify-dev-app]] note for driving the dev app over CDP).

> Prerequisite (out-of-repo, already done per the agent-status-reporter note, but re-confirm): the reporter must emit `wsh agentstatus --transcript <path>` and the installed `wsh` must be rebuilt from commit 3e4de04b — otherwise `transcriptpath` is empty, status updates stall, and previous-info stays blank (the graceful spec §7 path, but you won't see real data).

- [ ] **Step 1: Build + launch the dev app**

Run: `task dev` (or the project's dev launch). Open the **Agents** launcher in the session sidebar.

- [ ] **Step 2: Verify the live roster**

With ≥2 real agent sessions running: confirm the Agents view lists them under **working** / **idle** (no mock rows: no "loom · Fix duplicate-session race"), each showing the real session label, model tag, and activity line. Confirm a plain shell tab and the Agents tab itself do **not** appear.

- [ ] **Step 3: Verify needs-you + previous-info + task**

Drive a real agent to a `waiting` state (a Notification with no further work — e.g., let it ask a question in its terminal). Confirm: it moves to **needs you**; its card shows real **previous-info** (messages + action lines from its transcript) and a **task** label (its ai-title); and an **Open session to answer** button that focuses that agent's tab when clicked. Confirm the header count and the sidebar badge both show the live asking count (and the badge disappears when none are waiting).

- [ ] **Step 4: Verify idle peek + empty state**

Confirm an agent that stopped without asking appears under **idle** with its activity text and that clicking it opens its tab. With no agents running, confirm the "No agents running" empty state.

- [ ] **Step 5: Record the result**

No commit. Note any deviations in the plan's tracking; file follow-ups for anything that didn't match (do not silently pass).

---

## Out-of-repo dependency (flag to the user — not committed here)

Live data depends on the Python reporter (`agent-status-spike`, per the [[agent-status-reporter]] note) emitting `--transcript` and on the installed `wsh` being rebuilt from commit 3e4de04b. Both are tracked as the Plan 2 resume-point follow-up; this plan does not change them. If status updates appear stalled or previous-info is always blank, that rebuild is the cause, not this plan.

---

## Self-Review

**1. Spec coverage (Plan-3a scope):**
- §5.1 roster from the existing agent-status source → Task 4 (`liveAgentBaseAtom` derives from `sessionSidebarViewModelAtom` + `getAgentStatusAtom`, the same atoms the sidebar uses; single source of truth).
- §5.3 / §10.1 previous-info display (the deferred-from-Plan-2 consumption) → Task 3 + Task 4 (`ensurePreviousInfo`) + Task 5 (the effect) + Task 6 (render). Finally exercises Plan 2's `fetchPreviousInfo`.
- §10.3 live working line vs on-demand previous-info → working/idle rows use the live `detail`; previous-info is fetched only for asking agents (Task 5 effect), exactly as recommended.
- §10.4 asking as a status → the `waiting`→`asking` map in `agentVMFromInput` (Task 1) + the `needs you` section + the live badge (Task 7).
- §5.5 idle straggler + peek → idle rows render the activity ("stopped without asking …") and `onOpen` peeks (Task 5); needs-you peek is the **Open session to answer** button (Task 6).
- §7 empty / unreadable: "No agents running" empty state (Task 5); a needs-you agent with an unreadable transcript renders the card with no previous-info (Task 3 returns `{entries: []}`, Task 6 renders the header + peek alone).
- **Explicitly deferred to Plan 3b:** `ask_human` MCP channel, the structured `AgentVM.ask` payload (question/options/recommendation), and inline answer routing that unblocks the agent. In 3a a needs-you agent is answered by opening its session.

**2. Placeholder scan:** No "TBD / handle errors / similar to Task N". Every code step shows full code; every run step has an exact command + expected result. The out-of-repo reporter dependency is called out as non-committed, not a silent gap. Task 8 is verification-only and says so.

**3. Type consistency:** `AgentVM` gains `transcriptPath?` (Task 1) and is what `agentVMFromInput` returns (Task 1), `liveAgentBaseAtom`/`liveAgentsAtom` produce (Task 4), and `AskCard`/rows consume (Task 6). `LiveAgentInput` (Task 1) is built in `liveAgentBaseAtom` (Task 4). `fetchPreviousInfo` now returns `PreviousInfoResult {entries, title}` (Task 3), consumed by `ensurePreviousInfo` which writes `{entries, title}` into `previousInfoByIdAtom` (Task 4) and is merged onto `previousInfo`/`task` in `liveAgentsAtom` (Task 4). `AskCard.onAnswer` becomes optional (Task 6), so `agents.tsx` dropping it (Task 5) typechecks. `liveAskingCountAtom` (Task 4) is consumed by the sidebar (Task 7). `agentsAtom` changes from `PrimitiveAtom<AgentVM[]>` to `Atom<AgentVM[]>` (read-only) — the view only reads it via `useAtomValue` (Task 5), so the narrower type is safe.

**4. Verification honesty:** The substantive pure logic — `agentVMFromInput` (state map, age, model label) and `extractAiTitle` — is unit-tested (Tasks 1-2), alongside Plan 2's existing `projectTranscript` tests. The atom wiring and async fetch are integration glue, typed and lint-checked, then exercised by the Task 8 live walkthrough (roster renders, needs-you shows real previous-info + task, badge tracks, peek opens). No task claims live success without the Task 8 observations.

---

## Notes for Plan 3b
- 3b produces the structured ask: `AgentVM.ask = {question, options?, recommendation?}`. When present, `AskCard` already renders the inline question + pills + reply (Task 6) instead of the peek button — so 3b only needs to (a) populate `ask` and (b) make `onAnswer` route the answer back through the `ask_human` channel to unblock the agent.
- 3b must settle the ask-channel architecture first. **Unresolved:** two research passes disagreed on whether Claude Code 2.1.179 supports MCP elicitation + an `Elicitation` hook (which would let an external app auto-answer) vs. a blocking stdio `ask_human` MCP tool that long-polls Wave. Verify against the primary docs / the installed CLI before drafting 3b — do not trust either subagent's claim.
- The answer target: `AgentVM.id` is the **tabId** (chosen so `onOpen` works). 3b's answer routing likely keys on the session/block oref carried in the ask payload, not on `AgentVM.id` — reconcile when wiring the channel.
- Fast-follows noted in 3a: a continuous task label for working/idle rows (currently needs-you only); refreshing previous-info while an agent stays asking (currently fetched once); a ticking age (currently recomputed on status events).
