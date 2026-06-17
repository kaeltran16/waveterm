# Agents Panel UI (Plan 1 of 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Agents view (a single-tab roster of all agents with inline answering) and its sidebar launcher, backed by a mock data source, matching the locked mockups.

**Architecture:** A new `agents` Wave view type is registered in `BlockRegistry` and rendered as one scrollable surface. The view reads a swappable `AgentsDataSource` — this plan ships a `MockAgentsDataSource`; Plans 2 and 3 replace it with the transcript projection and the `ask_human` channel. All ordering/grouping is pure logic (TDD with vitest); the React components and sidebar wiring are verified with `tsc`/`eslint` and live against the mockups (same approach as the loom-integration plan).

**Tech Stack:** TypeScript/React, Jotai, Tailwind v4, vitest.

**UI source of truth — open these before writing any component:**
- `docs/specs/assets/2026-06-17-agents-panel/01-locked-design-sidebar-and-view.html` (primary — sidebar launcher + view together)
- `docs/specs/assets/2026-06-17-agents-panel/02-agents-view-fullscreen.html` (the view at scale)
- Spec: `docs/specs/2026-06-17-agents-panel-design.md` (see "UI reference" + §4 layout, §5 data flow, §6 payload).

**Palette (from the mockups — reuse, do not reinvent):** canvas `#0b0e14`, borders `#1c2230`/`#20242b`, asking amber `#d29922`, working green `#3fb950`, idle `#4a5260`, primary text `#e6edf3`, muted `#6b7585`/`#7d8896`, "Yes" green `#238636`. Messages render as prose; actions render as a dim monospace strip with a left border.

**Scope note:** This is Plan 1 of 3 from the spec. In scope: the view, its pure view-model, the mock data source, registration, and the sidebar launcher + badge. Out of scope (later plans): transcript→previous-info projection (Plan 2), the `ask_human` pull channel (Plan 3). The mock source returns canned previous-info and logs answers, so the whole UI is buildable and visually verifiable now.

---

## File Structure

**Create:**
- `frontend/app/view/agents/agentsviewmodel.ts` — pure logic: types + `sortAgents`/`askingCount`/`groupAgents`/`formatAge`. No React, no Wave runtime imports (mirrors `sessionviewmodel.ts`).
- `frontend/app/view/agents/agentsviewmodel.test.ts` — vitest unit tests for the above.
- `frontend/app/view/agents/agentsdatasource.ts` — the `AgentsDataSource` interface (the seam Plans 2/3 implement).
- `frontend/app/view/agents/agentsmockdata.ts` — `MOCK_AGENTS` + `MockAgentsDataSource`.
- `frontend/app/view/agents/askcard.tsx` — `AskCard` (an asking agent: previous-info + question + answer control).
- `frontend/app/view/agents/agentrows.tsx` — `WorkingRow` + `IdleRow` (one-liners).
- `frontend/app/view/agents/agents.tsx` — `AgentsView` (header + the three sections) and `AgentsViewModel`.

**Modify:**
- `frontend/app/block/blockregistry.ts` — register `"agents"`.
- `frontend/app/tab/sessionsidebar/sessionsidebar.tsx` — pinned Agents launcher + `N asking` badge above `+ New Tab`.

---

### Task 1: Pure view-model — types + `sortAgents`

**Files:**
- Create: `frontend/app/view/agents/agentsviewmodel.ts`
- Test: `frontend/app/view/agents/agentsviewmodel.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// frontend/app/view/agents/agentsviewmodel.test.ts
import { describe, expect, it } from "vitest";
import { sortAgents, type AgentVM } from "./agentsviewmodel";

const mk = (id: string, state: AgentVM["state"], extra: Partial<AgentVM> = {}): AgentVM => ({
    id,
    name: id,
    task: "",
    state,
    ...extra,
});

describe("sortAgents", () => {
    it("orders asking before working before idle", () => {
        const out = sortAgents([mk("a", "idle"), mk("b", "working"), mk("c", "asking")]);
        expect(out.map((a) => a.id)).toEqual(["c", "b", "a"]);
    });
    it("within asking, longest-blocked first", () => {
        const out = sortAgents([mk("a", "asking", { blockedMs: 60_000 }), mk("b", "asking", { blockedMs: 240_000 })]);
        expect(out.map((a) => a.id)).toEqual(["b", "a"]);
    });
    it("does not mutate the input array", () => {
        const input = [mk("a", "idle"), mk("b", "asking")];
        sortAgents(input);
        expect(input.map((a) => a.id)).toEqual(["a", "b"]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts`
Expected: FAIL — cannot resolve `./agentsviewmodel` / `sortAgents is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// frontend/app/view/agents/agentsviewmodel.ts
// Pure view-model logic for the Agents view. No React, no Wave runtime imports.

export type AgentState = "asking" | "working" | "idle";

// One item of "previous info": something the agent said, or something it did.
export type AgentEntry =
    | { kind: "message"; text: string }
    | { kind: "action"; verb: string; target: string; outcome?: "ok" | "fail"; note?: string };

export interface AgentAsk {
    question: string;
    options?: string[]; // answer pills; absent => default Yes/No
    recommendation?: string; // shown under the question
}

export interface AgentVM {
    id: string; // session/block oref — stable key + answer target
    name: string; // e.g. "loom"
    task: string; // e.g. "Fix duplicate-session race"
    state: AgentState;
    model?: string; // short family label (e.g. "opus")
    activity?: string; // working: live activity line; idle: reason
    blockedMs?: number; // asking: how long blocked (sort + age)
    activeMs?: number; // working: elapsed (sort)
    previousInfo?: AgentEntry[]; // asking: messages + actions leading to the question
    ask?: AgentAsk; // present iff state === "asking"
}

const STATE_RANK: Record<AgentState, number> = { asking: 0, working: 1, idle: 2 };

/** Pure: asking -> working -> idle; within asking, longest-blocked first;
 *  within working, longest-running first; idle keeps input order. Never mutates input. */
export function sortAgents(agents: AgentVM[]): AgentVM[] {
    return [...agents].sort((a, b) => {
        const rank = STATE_RANK[a.state] - STATE_RANK[b.state];
        if (rank !== 0) {
            return rank;
        }
        if (a.state === "asking") {
            return (b.blockedMs ?? 0) - (a.blockedMs ?? 0);
        }
        if (a.state === "working") {
            return (b.activeMs ?? 0) - (a.activeMs ?? 0);
        }
        return 0;
    });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/agentsviewmodel.ts frontend/app/view/agents/agentsviewmodel.test.ts
git commit -m "feat(agents): pure view-model types and sortAgents"
```

---

### Task 2: Pure view-model — `askingCount`, `groupAgents`, `formatAge`

**Files:**
- Modify: `frontend/app/view/agents/agentsviewmodel.ts`
- Test: `frontend/app/view/agents/agentsviewmodel.test.ts`

- [ ] **Step 1: Write the failing tests (append to the test file)**

```ts
// append to frontend/app/view/agents/agentsviewmodel.test.ts
import { askingCount, groupAgents, formatAge } from "./agentsviewmodel";

describe("askingCount", () => {
    it("counts only asking agents", () => {
        expect(askingCount([mk("a", "asking"), mk("b", "working"), mk("c", "asking")])).toBe(2);
    });
    it("is zero when none are asking", () => {
        expect(askingCount([mk("a", "idle"), mk("b", "working")])).toBe(0);
    });
});

describe("groupAgents", () => {
    it("splits into asking/working/idle, each sorted", () => {
        const s = groupAgents([mk("a", "idle"), mk("b", "asking", { blockedMs: 1_000 }), mk("c", "working"), mk("d", "asking", { blockedMs: 9_000 })]);
        expect(s.asking.map((a) => a.id)).toEqual(["d", "b"]);
        expect(s.working.map((a) => a.id)).toEqual(["c"]);
        expect(s.idle.map((a) => a.id)).toEqual(["a"]);
    });
});

describe("formatAge", () => {
    it("under a minute is 'just now'", () => {
        expect(formatAge(5_000)).toBe("just now");
        expect(formatAge(undefined)).toBe("just now");
    });
    it("minutes then hours", () => {
        expect(formatAge(240_000)).toBe("4m");
        expect(formatAge(7_200_000)).toBe("2h");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts`
Expected: FAIL — `askingCount`/`groupAgents`/`formatAge` not exported.

- [ ] **Step 3: Write minimal implementation (append to `agentsviewmodel.ts`)**

```ts
// append to frontend/app/view/agents/agentsviewmodel.ts

/** Pure: number of agents currently asking (drives the sidebar badge). */
export function askingCount(agents: AgentVM[]): number {
    return agents.filter((a) => a.state === "asking").length;
}

export interface AgentSections {
    asking: AgentVM[];
    working: AgentVM[];
    idle: AgentVM[];
}

/** Pure: the three rendered sections, each already sorted by sortAgents. */
export function groupAgents(agents: AgentVM[]): AgentSections {
    const sorted = sortAgents(agents);
    return {
        asking: sorted.filter((a) => a.state === "asking"),
        working: sorted.filter((a) => a.state === "working"),
        idle: sorted.filter((a) => a.state === "idle"),
    };
}

/** Pure: a millisecond duration -> short age label ("just now" / "4m" / "2h"). */
export function formatAge(ms?: number): string {
    if (ms == null || ms < 60_000) {
        return "just now";
    }
    const mins = Math.floor(ms / 60_000);
    if (mins < 60) {
        return `${mins}m`;
    }
    return `${Math.floor(mins / 60)}h`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/agentsviewmodel.ts frontend/app/view/agents/agentsviewmodel.test.ts
git commit -m "feat(agents): askingCount, groupAgents, formatAge"
```

---

### Task 3: Data-source seam + mock data

**Files:**
- Create: `frontend/app/view/agents/agentsdatasource.ts`
- Create: `frontend/app/view/agents/agentsmockdata.ts`

- [ ] **Step 1: Write the data-source interface**

```ts
// frontend/app/view/agents/agentsdatasource.ts
import type { AgentVM } from "./agentsviewmodel";

// The seam between the Agents view and where agent data comes from.
// Plan 1 provides MockAgentsDataSource; Plan 2 supplies real previous-info
// (transcript projection) and Plan 3 supplies real asks + answer routing (ask_human).
export interface AgentsDataSource {
    getAgents(): AgentVM[];
    answer(agentId: string, answer: string): void;
}
```

- [ ] **Step 2: Write the mock data (matches `02-agents-view-fullscreen.html`)**

```ts
// frontend/app/view/agents/agentsmockdata.ts
import type { AgentsDataSource } from "./agentsdatasource";
import type { AgentVM } from "./agentsviewmodel";

export const MOCK_AGENTS: AgentVM[] = [
    {
        id: "block:loom",
        name: "loom",
        task: "Fix duplicate-session race",
        state: "asking",
        model: "opus",
        blockedMs: 240_000,
        previousInfo: [
            { kind: "message", text: "The clone re-reads the source block by id, so a stale id slips through. I added a nil-guard returning a clean failResult." },
            { kind: "action", verb: "edited", target: "sessionmodel.go" },
            { kind: "action", verb: "wrote", target: "duplicate-session_test.go", note: "+2 tests" },
            { kind: "action", verb: "ran", target: "go test ./...", outcome: "ok" },
            { kind: "message", text: "While testing I noticed the source block can also be removed between the lookup and the clone — a second race the guard doesn't cover." },
        ],
        ask: { question: "Should I guard that second case too?", recommendation: "yes — cheap insurance" },
    },
    {
        id: "block:waveterm",
        name: "waveterm",
        task: "Migrate badges to tailwind",
        state: "asking",
        model: "opus",
        blockedMs: 60_000,
        previousInfo: [
            { kind: "message", text: "Migrated Badge.tsx; tests green. Old badge.css still imported by Toast, Pill, StatusDot." },
            { kind: "action", verb: "edited", target: "Badge.tsx" },
            { kind: "action", verb: "grep", target: "badge.css", note: "3 importers" },
        ],
        ask: { question: "Old badge.css — keep, delete, or deprecate?", options: ["Keep", "Delete", "Deprecate"] },
    },
    { id: "block:waveterm-2", name: "waveterm-2", task: "Add settings search", state: "working", model: "sonnet", activeMs: 120_000, activity: "go test ./pkg/wconfig/…" },
    { id: "block:obsidian", name: "obsidian", task: "Daily note backlinks", state: "working", model: "sonnet", activeMs: 45_000, activity: "editing daily-note.ts" },
    { id: "block:obsidian-2", name: "obsidian-2", task: "Cleanup", state: "idle", model: "sonnet", activity: "stopped without asking · 12m" },
];

export class MockAgentsDataSource implements AgentsDataSource {
    getAgents(): AgentVM[] {
        return MOCK_AGENTS;
    }

    answer(agentId: string, answer: string): void {
        // Plan 3 routes this back through the ask_human elicitation result.
        console.log(`[agents] answer for ${agentId}: ${answer}`);
    }
}
```

- [ ] **Step 3: Verify it typechecks**

Run: `npx tsc --noEmit`
Expected: no new errors referencing `frontend/app/view/agents/*`.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/view/agents/agentsdatasource.ts frontend/app/view/agents/agentsmockdata.ts
git commit -m "feat(agents): data-source seam and mock data"
```

---

### Task 4: `AskCard` component

**Files:**
- Create: `frontend/app/view/agents/askcard.tsx`

Open `01-locked-design-sidebar-and-view.html` and the `.ask` card in `02-agents-view-fullscreen.html` before writing — match the structure (header row, prose messages, dim monospace action strip with a left border, question, answer pills + reply input).

- [ ] **Step 1: Write the component**

```tsx
// frontend/app/view/agents/askcard.tsx
import { cn } from "@/util/util";
import { useState } from "react";
import { formatAge, type AgentEntry, type AgentVM } from "./agentsviewmodel";

function PreviousInfo({ entries }: { entries: AgentEntry[] }) {
    return (
        <div className="mt-2.5 max-w-[80ch] leading-relaxed">
            {entries.map((e, i) =>
                e.kind === "message" ? (
                    <div key={i} className="mt-2.5 text-[13px] text-[#dde3ea]">
                        {e.text}
                    </div>
                ) : (
                    <div key={i} className="my-2.5 border-l-2 border-[#2a2f3a] pl-3.5 font-mono text-[12px] leading-7 text-[#7d8896]">
                        <span className="inline-block w-14 text-[#9aa4b2]">{e.verb}</span>
                        {e.target}
                        {e.note ? <span className="text-[#6b7585]"> ({e.note})</span> : null}
                        {e.outcome === "ok" ? <span className="text-[#3fb950]"> ✓</span> : null}
                        {e.outcome === "fail" ? <span className="text-[#f85149]"> ✗</span> : null}
                    </div>
                )
            )}
        </div>
    );
}

export function AskCard({ agent, onAnswer }: { agent: AgentVM; onAnswer: (id: string, answer: string) => void }) {
    const [reply, setReply] = useState("");
    const options = agent.ask?.options ?? ["Yes", "No"];
    const submitReply = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key !== "Enter" || reply.trim().length === 0) {
            return;
        }
        onAnswer(agent.id, reply.trim());
        setReply("");
    };
    return (
        <div className="mb-3.5 rounded-[10px] border border-[#d29922] bg-[#d29922]/[0.05] px-[18px] py-4">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                    <span className="h-2 w-2 shrink-0 rounded-full bg-[#d29922]" />
                    <b className="text-[14px] text-[#e6edf3]">{agent.name}</b>
                    <span className="text-[12.5px] text-[#6b7585]">· {agent.task}</span>
                </div>
                <span className="text-[11.5px] text-[#d29922]">asking · {formatAge(agent.blockedMs)}</span>
            </div>

            {agent.previousInfo?.length ? <PreviousInfo entries={agent.previousInfo} /> : null}

            <div className="mt-3.5 border-t border-[#2a2f3a] pt-3.5">
                <div className="text-[14px] font-semibold text-[#e6edf3]">{agent.ask?.question}</div>
                {agent.ask?.recommendation ? (
                    <div className="mt-1 text-[11.5px] text-[#6b7585]">its take: {agent.ask.recommendation}</div>
                ) : null}
                <div className="mt-3 flex items-center gap-2.5">
                    {options.map((opt, i) => (
                        <button
                            key={opt}
                            type="button"
                            onClick={() => onAnswer(agent.id, opt)}
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
        </div>
    );
}
```

- [ ] **Step 2: Verify typecheck + lint**

Run: `npx tsc --noEmit && npx eslint frontend/app/view/agents/askcard.tsx`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/app/view/agents/askcard.tsx
git commit -m "feat(agents): AskCard component"
```

---

### Task 5: `WorkingRow` + `IdleRow` components

**Files:**
- Create: `frontend/app/view/agents/agentrows.tsx`

Match the one-liner rows in `02-agents-view-fullscreen.html` (`.wrow` / idle row).

- [ ] **Step 1: Write the components**

```tsx
// frontend/app/view/agents/agentrows.tsx
import type { AgentVM } from "./agentsviewmodel";

export function WorkingRow({ agent }: { agent: AgentVM }) {
    return (
        <div className="flex items-center gap-2.5 border-b border-[#14181f] px-1 py-2.5">
            <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-[#3fb950]" />
            <b className="text-[13px] text-[#e6edf3]">{agent.name}</b>
            <span className="text-[12.5px] text-[#6b7585]">{agent.task}</span>
            {agent.activity ? <span className="ml-auto font-mono text-[12px] text-[#7d8896]">⟳ {agent.activity}</span> : null}
        </div>
    );
}

export function IdleRow({ agent }: { agent: AgentVM }) {
    return (
        <div className="flex items-center gap-2.5 px-1 py-2.5 opacity-60">
            <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-[#4a5260]" />
            <b className="text-[13px] text-[#c9d1d9]">{agent.name}</b>
            <span className="text-[12.5px] text-[#6b7585]">{agent.activity ?? "idle"}</span>
        </div>
    );
}
```

- [ ] **Step 2: Verify typecheck + lint**

Run: `npx tsc --noEmit && npx eslint frontend/app/view/agents/agentrows.tsx`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/app/view/agents/agentrows.tsx
git commit -m "feat(agents): WorkingRow and IdleRow components"
```

---

### Task 6: `AgentsView` + `AgentsViewModel`

**Files:**
- Create: `frontend/app/view/agents/agents.tsx`

`AgentsView` composes the header + three sections (`needs you` / `working` / `idle`) from `groupAgents`. `AgentsViewModel` mirrors `QuickTipsViewModel` (constructor `({ blockId, nodeModel, tabModel }: ViewModelInitType)`, `get viewComponent()`).

- [ ] **Step 1: Write the view + model**

```tsx
// frontend/app/view/agents/agents.tsx
import type { BlockNodeModel } from "@/app/block/blocktypes";
import type { TabModel } from "@/app/store/tab-model";
import { atom, useAtomValue, type PrimitiveAtom } from "jotai";
import { AskCard } from "./askcard";
import { IdleRow, WorkingRow } from "./agentrows";
import { MockAgentsDataSource } from "./agentsmockdata";
import { askingCount, groupAgents, type AgentVM } from "./agentsviewmodel";
import type { AgentsDataSource } from "./agentsdatasource";

function SectionLabel({ children }: { children: React.ReactNode }) {
    return <div className="mb-3 mt-6 px-0.5 text-[11px] uppercase tracking-[0.06em] text-[#6b7585] first:mt-0">{children}</div>;
}

function AgentsView({ model }: { model: AgentsViewModel }) {
    const agents = useAtomValue(model.agentsAtom);
    const sections = groupAgents(agents);
    const asking = askingCount(agents);
    const answer = (id: string, ans: string) => model.dataSource.answer(id, ans);
    return (
        <div className="flex h-full flex-col bg-[#0b0e14] text-[#c9d1d9]">
            <div className="flex shrink-0 items-center justify-between border-b border-[#1c2230] px-[18px] py-3">
                <b className="text-[15px] text-[#e6edf3]">Agents</b>
                <span className="text-[12px] text-[#6b7585]">
                    <span className="text-[#d29922]">{asking} asking</span> · {sections.working.length} working · {sections.idle.length} idle
                </span>
            </div>
            <div className="flex-1 overflow-auto p-[18px]">
                <div className="max-w-[980px]">
                    {sections.asking.length > 0 && <SectionLabel>needs you</SectionLabel>}
                    {sections.asking.map((a) => (
                        <AskCard key={a.id} agent={a} onAnswer={answer} />
                    ))}
                    {sections.working.length > 0 && <SectionLabel>working</SectionLabel>}
                    {sections.working.map((a) => (
                        <WorkingRow key={a.id} agent={a} />
                    ))}
                    {sections.idle.length > 0 && <SectionLabel>idle</SectionLabel>}
                    {sections.idle.map((a) => (
                        <IdleRow key={a.id} agent={a} />
                    ))}
                </div>
            </div>
        </div>
    );
}

export class AgentsViewModel implements ViewModel {
    viewType: string;
    blockId: string;
    nodeModel: BlockNodeModel;
    tabModel: TabModel;
    viewIcon = atom<string>("robot");
    viewName = atom<string>("Agents");
    noPadding = atom(true);
    dataSource: AgentsDataSource = new MockAgentsDataSource();
    agentsAtom: PrimitiveAtom<AgentVM[]>;

    constructor({ blockId, nodeModel, tabModel }: ViewModelInitType) {
        this.blockId = blockId;
        this.nodeModel = nodeModel;
        this.tabModel = tabModel;
        this.viewType = "agents";
        this.agentsAtom = atom(this.dataSource.getAgents()) as PrimitiveAtom<AgentVM[]>;
    }

    get viewComponent(): ViewComponent {
        return AgentsView;
    }
}
```

- [ ] **Step 2: Verify typecheck + lint**

Run: `npx tsc --noEmit && npx eslint frontend/app/view/agents/agents.tsx`
Expected: no errors. (If `ViewModelInitType`/`ViewModel`/`ViewComponent` resolve as globals here — they do for `quicktipsview.tsx` — no import is needed.)

- [ ] **Step 3: Commit**

```bash
git add frontend/app/view/agents/agents.tsx
git commit -m "feat(agents): AgentsView and AgentsViewModel"
```

---

### Task 7: Register the `agents` view

**Files:**
- Modify: `frontend/app/block/blockregistry.ts:22` (imports) and `:37` (registrations)

- [ ] **Step 1: Add the import**

Add with the other `@/app/view/*` imports near the top of `frontend/app/block/blockregistry.ts`:

```ts
import { AgentsViewModel } from "@/app/view/agents/agents";
```

- [ ] **Step 2: Register the view type**

Add after the `processviewer` line in the `BlockRegistry` block (currently `blockregistry.ts:37`):

```ts
BlockRegistry.set("agents", AgentsViewModel);
```

- [ ] **Step 3: Verify typecheck + lint**

Run: `npx tsc --noEmit && npx eslint frontend/app/block/blockregistry.ts`
Expected: no errors.

- [ ] **Step 4: Live check — open the view**

Run the app, open any tab, and create the block from the wsh CLI in a terminal block:

Run: `wsh view agents`
Expected: a block opens showing the Agents view — `needs you` with the loom + waveterm asking cards (previous-info + answer pills), `working` rows for waveterm-2/obsidian, an `idle` obsidian-2 row. Compare side-by-side with `02-agents-view-fullscreen.html`; clicking an answer pill or pressing Enter in the reply prints `[agents] answer for block:<id>: …` to the devtools console.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/block/blockregistry.ts
git commit -m "feat(agents): register agents view type"
```

---

### Task 8: Sidebar Agents launcher + badge

**Files:**
- Modify: `frontend/app/tab/sessionsidebar/sessionsidebar.tsx:5` (imports) and `:144-152` (the New Tab button region)

Match the sidebar in `01-locked-design-sidebar-and-view.html`: an amber **Agents** launcher with an `N asking` badge pinned at the very top, a divider, then the existing `+ New Tab` button.

- [ ] **Step 1: Add imports**

Add to the imports at the top of `sessionsidebar.tsx`. Extend the existing `@/app/store/global` import to include `createBlock`:

```ts
import { createBlock, createTab, getApi, setActiveTab } from "@/app/store/global";
```

Add two new import lines:

```ts
import { MOCK_AGENTS } from "@/app/view/agents/agentsmockdata";
import { askingCount } from "@/app/view/agents/agentsviewmodel";
```

`fireAndForget` is **already imported** in this file (`:8`, `import { fireAndForget, makeIconClass } from "@/util/util";`) — do not add it again.

- [ ] **Step 2: Add the launcher above the New Tab button**

In `SessionSidebar`, immediately inside the root `<div …>` (before the existing `<button … onClick={() => createTab()}>` at `:144`), insert:

```tsx
{(() => {
    const asking = askingCount(MOCK_AGENTS); // Plan 3 swaps MOCK_AGENTS for the live asking count
    return (
        <button
            type="button"
            className="group flex w-full shrink-0 cursor-pointer items-center gap-2 px-2 py-2 text-[13.5px] text-[#e6edf3] transition-colors hover:bg-[#d29922]/10"
            onClick={() => fireAndForget(() => createBlock({ meta: { view: "agents" } }, true))}
            aria-label="Open Agents"
        >
            <span className="text-[#d29922]">⬤</span>
            <span className="font-semibold">Agents</span>
            {asking > 0 && (
                <span className="ml-auto rounded-[9px] bg-[#d29922] px-2 text-[10px] font-bold text-black">{asking} asking</span>
            )}
        </button>
    );
})()}
<div className="h-px shrink-0 bg-[#20242b]" />
```

- [ ] **Step 3: Verify typecheck + lint**

Run: `npx tsc --noEmit && npx eslint frontend/app/tab/sessionsidebar/sessionsidebar.tsx`
Expected: no errors.

- [ ] **Step 4: Run the sidebar's existing tests (guard against regression)**

Run: `npx vitest run frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts frontend/app/tab/sessionsidebar/sessionrow.test.tsx`
Expected: PASS (unchanged).

- [ ] **Step 5: Live check — launcher opens the view**

Run the app with the session sidebar visible (`app:tabbar=left`). Expected: the **Agents** entry sits pinned at the top with a `2 asking` badge, a divider below it, then `+ New Tab` and the session groups — matching `01-locked-design-sidebar-and-view.html`. Clicking **Agents** opens the magnified Agents view.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/tab/sessionsidebar/sessionsidebar.tsx
git commit -m "feat(agents): pinned Agents launcher and badge in the session sidebar"
```

---

## Self-Review

**1. Spec coverage (Plan-1 scope):**
- §4 single scrollable view, sections asking→working→idle → Tasks 6 (`AgentsView` + `groupAgents`).
- §4 AskCard (header, previous-info, question, answer control) → Task 4.
- §4 WorkingRow/IdleRow one-liners → Task 5.
- §4 sidebar pinned launcher + `N asking` badge above New Tab, divider → Task 8.
- §4 new `agents` view type registered → Tasks 6–7.
- §5 sort order & badge count (pure) → Tasks 1–2.
- §5.3 previous info = messages + actions (rendering of `AgentEntry`) → Task 4; the *real projection* is Plan 2 (mock supplies it here).
- §6 ask payload (question/options/recommendation) → `AgentAsk` (Task 1), rendered in Task 4.
- §3 data-source seam so Plans 2/3 slot in → Task 3.
- **Deferred to later plans (explicitly out of Plan-1 scope):** §5.2 `ask_human` channel + answer routing (Plan 3), §5.3 transcript projection (Plan 2), §5.5 idle-straggler hook + `peek` action (Plan 3 — Plan 1 renders the idle row text only), §7 error/edge cases that depend on live data (Plans 2/3).

**2. Placeholder scan:** No "TBD/handle errors/similar to Task N". Every code step shows full code; every run step has an exact command + expected result. The single `console.log` in `MockAgentsDataSource.answer` is intentional mock behavior, annotated as Plan-3 replacement.

**3. Type consistency:** `AgentVM`/`AgentEntry`/`AgentAsk`/`AgentState` defined in Task 1 are used unchanged in Tasks 3–8. `sortAgents`/`askingCount`/`groupAgents`/`formatAge` signatures match their call sites. `AgentsDataSource.answer(agentId, answer)` (Task 3) matches `model.dataSource.answer(id, ans)` (Task 6) and `onAnswer(agent.id, …)` (Task 4). Constructor shape `({ blockId, nodeModel, tabModel }: ViewModelInitType)` and `get viewComponent()` match the verified `QuickTipsViewModel` pattern.

---

## Notes for later plans
- **Plan 2 (previous-info):** implement an `AgentsDataSource` whose `getAgents()` fills `previousInfo` from the session transcript projection (spec §5.3, §10.1). The view needs no changes — `AgentEntry` is already the render contract.
- **Plan 3 (`ask_human` channel):** implement `getAgents()` asks + `answer()` routing through MCP elicitation (spec §5.2, §10.2), and replace `MOCK_AGENTS` in the sidebar badge (Task 8) with the live asking count; add the idle-straggler `peek` action (spec §5.5).
