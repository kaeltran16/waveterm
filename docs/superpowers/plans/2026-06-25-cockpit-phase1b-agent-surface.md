# Cockpit Phase 1b — Agent 3-Pane Focus Surface — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the interim Agent surface (`AgentSurfaceInterim` + `FocusView`) with the real 3-pane focus — `AgentTree` | `AgentTranscript` | `AgentDetailsRail` — faithfully reproducing the handoff `isFocus` design, as pure frontend over existing data (no new RPC/Go).

**Architecture:** A new `AgentSurface` (rendered by `CockpitShell` for `surfaceAtom === "agent"`) lays out three panes plus the existing "Open terminal" swap. The center pane absorbs `FocusView`'s transcript logic; the left tree groups the live roster by project with an expandable subagent branch (from the existing `getSubagentsAtom`); the right rail shows live details + derived tools-used + marked placeholders. Surface routing stays shell-side so `agents.tsx` never imports `CockpitFocusPane` (preserves the 1a TDZ-cycle fix).

**Tech Stack:** React 19 + jotai + Tailwind v4 (`@theme` tokens). Vitest (node-env, pure-logic only — UI verified via tsc + `vite build` + the user's `task dev` CDP check, matching the 1a convention). Motion (`motion/react`).

> **Correction (during execution):** the pure helper was renamed `agenttree.ts` → **`agenttreemodel.ts`** (and its test → `agenttreemodel.test.ts`). The original plan gave the helper (`agenttree.ts`) and the component (`agenttree.tsx`) the same basename — `import … from "./agenttree"` resolves `.ts` before `.tsx`, so the component would be unreachable. The `model` suffix also matches the repo's pure-view-model convention (`agentsviewmodel.ts`, `sessionviewmodel.ts`). The component file stays `agenttree.tsx` (file ↔ export `AgentTree` match). All references below to the helper file should read `agenttreemodel`.

---

## Styling fidelity (READ FIRST — applies to every component task)

1a drifted from the handoff. 1b must not. While writing JSX:

- **Reproduce the `isFocus` markup faithfully** (source of truth: `wave-handoff/wave/project/Wave-cockpit-live.dc.html` lines **356–542**). Match pane widths (`248px` / `296px`), paddings, gaps, and the **mono uppercase section labels** (`font-mono text-[11px] font-semibold uppercase tracking-[.1em]`).
- **Palette via `@theme` tokens where they map** (they *are* the handoff palette): `bg-surface`=`#0e1116`, `bg-surface-raised`=`#13171d`, `bg-surface-hover`=`#171c22`, `bg-background`=`#0c0e11`, `text-primary`=`#e6e9ed`, `text-secondary`=`#cfd5db`, `text-muted`=`#6b7178`, `text-accent`/`bg-accent`=`#7c95ff`, `text-accent-soft`=`#aebfff`, `bg-accentbg`=`rgba(124,149,255,.1)`, `text-warning`=`#e6b450`, `text-success`=`#54c79a`, `text-error`=`#f0625a`, `border-border`=`#1c2128`, `border-edge-mid`=`#20262e`, `border-edge-strong`=`#2a313a`.
- **Handoff shades with NO token → exact Tailwind arbitrary values** (do NOT snap to nearest token — that is the drift to avoid): `#1a1f26` (pane dividers), `#0d1014` (center header/footer bg), `#0f1217` (nested cards / tool groups / toggle pills), `#181d23` (tree header divider, tool tag bg), `#161a20`/`#14181d`/`#161b21`/`#242b33`/`#252b33` (inner dividers/edges), `#0a0c0f` (cmd preview bg), `#8aa0ff` (subagent accent), `#dfe4ea`/`#cdd3da`/`#bdc4cc`/`#aeb6bf`/`#9aa3ad`/`#8b939d`/`#5f666f`/`#5b626b`/`#4d545d`/`#3c4450`/`#3f464e` (intermediate ink shades).
- **No new SCSS. Do not expand the `@theme` token set** (foundation work, out of scope).

Each task's JSX below already follows these rules — copy it as written.

---

## File structure

| File | Responsibility | Task |
|---|---|---|
| `frontend/app/view/agents/agenttreemodel.ts` | Pure `buildAgentTree(agents, order)` → grouped tree rows | 1 |
| `frontend/app/view/agents/agenttreemodel.test.ts` | Unit tests for the pure helper | 1 |
| `frontend/app/view/agents/agenttree.tsx` | Left pane: project-grouped roster + per-parent subagent branch | 2 |
| `frontend/app/view/agents/agentdetailsrail.tsx` | Right pane: Details / ctx gauge / subagents / tools-used / files (placeholder) / actions | 3 |
| `frontend/app/view/agents/agenttranscript.tsx` | Center pane: header + transcript + amber answer + footer composer | 4 |
| `frontend/app/view/agents/agentsurface.tsx` | 3-pane container + terminal swap + keyboard + no-focus fallback | 5 |
| `frontend/app/view/agents/cockpitshell.tsx` | MODIFY: route `agent` → `<AgentSurface/>`; drop interim + focus-pane import | 5 |
| `frontend/app/view/agents/focusview.tsx` | DELETE (absorbed by `agenttranscript.tsx`) | 5 |

Reused unchanged: `narrationtimeline.tsx`, `answerbar.tsx`, `agentcomposer.tsx`, `statusdot.tsx`, `agentsviewmodel.ts`, `liveagents.ts`, `livetranscript.ts`, `projectname.ts`, `session-models/agentstatusstore.ts`, `session-models/sessionviewmodel.ts`.

---

## Task 1: `buildAgentTree` pure helper (TDD)

**Files:**
- Create: `frontend/app/view/agents/agenttree.ts`
- Test: `frontend/app/view/agents/agenttree.test.ts`

Pure logic that turns the live roster + anchored order into the left-pane rows: one **group** header per project (in first-seen order, following `order`), then its **parent** rows. Subagent children are NOT produced here — they're read from per-block atoms inside the row component (Task 2), keeping this helper free of Wave runtime imports.

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/agents/agenttree.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildAgentTree, UNGROUPED_PROJECT } from "./agenttree";
import type { AgentVM } from "./agentsviewmodel";

function vm(id: string, state: AgentVM["state"], path?: string): AgentVM {
    return { id, name: id, task: "", state, transcriptPath: path };
}

// transcript paths whose project segment (after "projects/") is the repo dir
const WAVE = "/home/u/.claude/projects/home-u-waveterm/abc.jsonl"; // -> "waveterm"
const LOOM = "/home/u/.claude/projects/home-u-loom/def.jsonl"; // -> "loom"

describe("buildAgentTree", () => {
    it("returns [] for no agents", () => {
        expect(buildAgentTree([], [])).toEqual([]);
    });

    it("emits one group header then its parents", () => {
        const agents = [vm("a", "working", WAVE), vm("b", "idle", WAVE)];
        const rows = buildAgentTree(agents, ["a", "b"]);
        expect(rows.map((r) => r.kind)).toEqual(["group", "parent", "parent"]);
        expect(rows[0]).toMatchObject({ kind: "group", project: "waveterm", count: 2, attn: 0 });
    });

    it("counts asking agents in the group's attn", () => {
        const agents = [vm("a", "asking", WAVE), vm("b", "working", WAVE)];
        const rows = buildAgentTree(agents, ["a", "b"]);
        expect(rows[0]).toMatchObject({ kind: "group", attn: 1 });
    });

    it("groups by project in first-seen order of `order`", () => {
        const agents = [vm("w", "working", WAVE), vm("l", "working", LOOM)];
        const rows = buildAgentTree(agents, ["l", "w"]); // loom first by order
        const groups = rows.filter((r) => r.kind === "group");
        expect(groups.map((g: any) => g.project)).toEqual(["loom", "waveterm"]);
    });

    it("orders parents within a group by `order`; ids absent from order sort last", () => {
        const agents = [vm("a", "working", WAVE), vm("b", "working", WAVE), vm("c", "working", WAVE)];
        const rows = buildAgentTree(agents, ["b", "a"]); // c missing
        const parents = rows.filter((r) => r.kind === "parent") as any[];
        expect(parents.map((p) => p.agent.id)).toEqual(["b", "a", "c"]);
    });

    it("falls back to UNGROUPED_PROJECT when no transcript path", () => {
        const rows = buildAgentTree([vm("a", "idle")], ["a"]);
        expect(rows[0]).toMatchObject({ kind: "group", project: UNGROUPED_PROJECT });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/agenttree.test.ts`
Expected: FAIL — `Failed to resolve import "./agenttree"` / `buildAgentTree is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Create `frontend/app/view/agents/agenttree.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure view-model logic for the Agent surface's left tree. No React, no Wave runtime imports.
// Produces group headers + parent rows; subagent children are read from per-block atoms in the
// component (they're ephemeral and keyed by block ORef), so they stay out of this pure helper.

import type { AgentVM } from "./agentsviewmodel";
import { projectNameFromTranscriptPath } from "./projectname";

export const UNGROUPED_PROJECT = "ungrouped";

export type AgentTreeRow =
    | { kind: "group"; project: string; count: number; attn: number }
    | { kind: "parent"; agent: AgentVM; project: string };

/** Pure: roster + anchored order -> [group, ...parents] per project. Projects appear in the
 *  first-seen order of `order`; parents within a group follow `order` (ids absent from `order`
 *  sort last). `attn` is the count of asking agents in the group. */
export function buildAgentTree(agents: AgentVM[], order: string[]): AgentTreeRow[] {
    const rank = new Map(order.map((id, i) => [id, i] as const));
    const sorted = [...agents].sort(
        (a, b) => (rank.get(a.id) ?? Number.POSITIVE_INFINITY) - (rank.get(b.id) ?? Number.POSITIVE_INFINITY)
    );
    const groups: { project: string; agents: AgentVM[] }[] = [];
    const byProject = new Map<string, AgentVM[]>();
    for (const a of sorted) {
        const project = projectNameFromTranscriptPath(a.transcriptPath ?? "") || UNGROUPED_PROJECT;
        let bucket = byProject.get(project);
        if (!bucket) {
            bucket = [];
            byProject.set(project, bucket);
            groups.push({ project, agents: bucket });
        }
        bucket.push(a);
    }
    const rows: AgentTreeRow[] = [];
    for (const g of groups) {
        rows.push({
            kind: "group",
            project: g.project,
            count: g.agents.length,
            attn: g.agents.filter((a) => a.state === "asking").length,
        });
        for (const a of g.agents) {
            rows.push({ kind: "parent", agent: a, project: g.project });
        }
    }
    return rows;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/agenttree.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: only the 3 baseline `frontend/tauri/api.test.ts` errors; nothing in `agenttree.ts`.

No commit yet (commit at the juncture in Task 5 per the project's juncture-commit rule).

---

## Task 2: `AgentTree` left pane

**Files:**
- Create: `frontend/app/view/agents/agenttree.tsx`

Renders `buildAgentTree` rows. Each parent is a `ParentRow` that reads its own subagents/expand atoms (keyed by `block:${agent.blockId}`) so the expand pill + children come straight from the live store. Faithful to handoff lines **358–398**.

- [ ] **Step 1: Write the component**

Create `frontend/app/view/agents/agenttree.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import type { AgentsViewModel } from "./agents";
import { buildAgentTree } from "./agenttree";
import type { AgentVM } from "./agentsviewmodel";
import {
    getSubagentExpandAtom,
    getSubagentsAtom,
    toggleSubagentExpand,
} from "./session-models/agentstatusstore";
import { subagentExpanded, type SubagentState } from "./session-models/sessionviewmodel";
import { StatusDot } from "./statusdot";

const STATE_COLOR: Record<AgentVM["state"], string> = {
    asking: "var(--color-warning)",
    working: "var(--color-accent)",
    idle: "var(--color-muted)",
};
const STATE_LABEL: Record<AgentVM["state"], string> = { asking: "asking", working: "working", idle: "idle" };
const SUB_COLOR: Record<SubagentState, string> = {
    working: "var(--color-accent)",
    success: "var(--color-success)",
    failure: "var(--color-error)",
};

function ParentRow({ model, agent }: { model: AgentsViewModel; agent: AgentVM }) {
    const focusId = useAtomValue(model.focusIdAtom);
    const oref = `block:${agent.blockId}`;
    const subs = useAtomValue(getSubagentsAtom(oref));
    const expandOverride = useAtomValue(getSubagentExpandAtom(oref));
    const expanded = subagentExpanded(subs, expandOverride);
    const selected = focusId === agent.id;

    const select = () => {
        globalStore.set(model.focusIdAtom, agent.id);
        globalStore.set(model.focusReplyAtom, false);
    };

    return (
        <>
            <div
                onClick={select}
                className={cn(
                    "relative flex cursor-pointer items-center gap-[9px] rounded-[9px] px-[11px] py-[10px] hover:bg-surface-hover",
                    selected && "bg-accentbg"
                )}
            >
                <StatusDot state={agent.state} className="!h-[7px] !w-[7px]" />
                <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-[12px] font-semibold text-[#dfe4ea]">{agent.name}</div>
                    {/* PLACEHOLDER (1b): git branch has no data source — see spec §8 */}
                    <div className="truncate text-[10.5px] text-muted">main</div>
                </div>
                {subs.length > 0 ? (
                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            toggleSubagentExpand(oref, expanded);
                        }}
                        title="Toggle subagents"
                        className="flex items-center gap-[3px] rounded-[6px] border border-edge-mid bg-[#161b21] px-[6px] py-[2px] font-mono text-[9.5px] font-semibold text-muted hover:border-accent hover:text-accent-soft"
                    >
                        <span className="text-[8px] leading-none">{expanded ? "▾" : "▸"}</span>
                        {subs.length}
                    </button>
                ) : null}
                <span className="font-mono text-[10px] font-medium" style={{ color: STATE_COLOR[agent.state] }}>
                    {STATE_LABEL[agent.state]}
                </span>
            </div>
            {expanded
                ? subs.map((s) => (
                      <div
                          key={s.id}
                          className="relative flex items-center gap-[8px] rounded-[9px] py-[7px] pl-[28px] pr-[10px] hover:bg-surface-hover"
                      >
                          <span className="absolute left-[13px] top-1/2 -translate-y-1/2 font-mono text-[11px] font-semibold text-[#3c4450]">
                              ↳
                          </span>
                          <span
                              className="h-[5px] w-[5px] shrink-0 rounded-full"
                              style={{ background: SUB_COLOR[s.state] }}
                          />
                          <div className="min-w-0 flex-1">
                              <div className="truncate font-mono text-[11px] font-semibold text-[#bdc4cc]">
                                  {s.type || "subagent"}
                              </div>
                              <div className="truncate text-[9.5px] text-[#5f666f]">{s.model ?? ""}</div>
                          </div>
                          <span
                              className="whitespace-nowrap font-mono text-[9.5px] font-medium"
                              style={{ color: SUB_COLOR[s.state] }}
                          >
                              {s.state}
                          </span>
                      </div>
                  ))
                : null}
        </>
    );
}

export function AgentTree({ model }: { model: AgentsViewModel }) {
    const agents = useAtomValue(model.agentsAtom);
    const order = useAtomValue(model.orderAtom);
    const rows = buildAgentTree(agents, order);
    return (
        <div className="flex w-[248px] shrink-0 flex-col border-r border-[#1a1f26] bg-surface">
            <div className="border-b border-[#181d23] px-[16px] pb-[12px] pt-[16px]">
                <div className="flex items-center justify-between">
                    <h3 className="font-mono text-[11px] font-semibold uppercase tracking-[.1em] text-[#8b939d]">Agents</h3>
                    <span className="font-mono text-[11px] font-semibold text-muted">{agents.length}</span>
                </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-[8px]">
                {rows.map((r, i) =>
                    r.kind === "group" ? (
                        <div key={`g-${r.project}-${i}`} className="flex items-center gap-[8px] px-[11px] pb-[6px] pt-[14px]">
                            <span className="truncate font-mono text-[10px] font-semibold uppercase tracking-[.1em] text-muted">
                                {r.project}
                            </span>
                            <div className="h-px flex-1 bg-[#181d23]" />
                            {r.attn > 0 ? (
                                <span className="rounded-[5px] bg-warning/10 px-[6px] py-[1px] font-mono text-[9.5px] font-semibold text-warning">
                                    {r.attn}
                                </span>
                            ) : null}
                            <span className="font-mono text-[10px] font-semibold text-[#4d545d]">{r.count}</span>
                        </div>
                    ) : (
                        <ParentRow key={r.agent.id} model={model} agent={r.agent} />
                    )
                )}
            </div>
        </div>
    );
}
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: only the 3 baseline `api.test.ts` errors. If `SubagentState` is not exported from `sessionviewmodel.ts`, confirm it is (`export type SubagentState`) — it is defined there; import it as shown.

No commit yet.

---

## Task 3: `AgentDetailsRail` right pane

**Files:**
- Create: `frontend/app/view/agents/agentdetailsrail.tsx`

Live Details + context gauge + subagents + **derived** tools-used (`summarizeActions`) + **placeholder** files-touched + **disabled** Resume/Stop. Faithful to handoff lines **488–540**.

- [ ] **Step 1: Write the component**

Create `frontend/app/view/agents/agentdetailsrail.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import type { AgentsViewModel } from "./agents";
import {
    formatAge,
    formatTokens,
    recentActions,
    summarizeActions,
    usageLevel,
    type AgentVM,
} from "./agentsviewmodel";
import { liveEntriesByIdAtom } from "./livetranscript";
import { projectNameFromTranscriptPath } from "./projectname";
import { getSubagentsAtom } from "./session-models/agentstatusstore";

const DefaultContextMax = 200000; // fallback when the reporter omits contextmax (mirrors focusview)
const GAUGE_FILL: Record<"ok" | "warn" | "hot", string> = {
    ok: "bg-accent",
    warn: "bg-warning",
    hot: "bg-error",
};

// PLACEHOLDER (1b): no git status source — see spec §8. Static sample matching the handoff.
const PLACEHOLDER_FILES: { status: string; path: string; color: string }[] = [
    { status: "M", path: "src/auth.ts", color: "text-success" },
    { status: "M", path: "src/session.ts", color: "text-success" },
    { status: "+", path: "middleware/store.ts", color: "text-accent" },
];

function DetailRow({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex items-baseline justify-between border-b border-[#161a20] py-[8px] last:border-b-0">
            <span className="text-[12.5px] text-muted">{label}</span>
            <span className="font-mono text-[12px] font-medium text-secondary">{value}</span>
        </div>
    );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
    return (
        <h3 className="font-mono text-[11px] font-semibold uppercase tracking-[.1em] text-[#8b939d]">{children}</h3>
    );
}

export function AgentDetailsRail({ model, agent }: { model: AgentsViewModel; agent: AgentVM }) {
    const liveEntries = useAtomValue(liveEntriesByIdAtom);
    const subs = useAtomValue(getSubagentsAtom(`block:${agent.blockId}`));
    const entries = liveEntries[agent.id] ?? agent.previousInfo ?? [];
    const project = projectNameFromTranscriptPath(agent.transcriptPath ?? "");
    const usage = agent.usage;
    const ctxPct = usage?.contextpct;
    const tools = summarizeActions(recentActions(entries, 0)).byVerb;

    const running = agent.state === "idle" ? `${formatAge(undefined)} idle` : formatAge(agent.activeMs);
    const tokens =
        ctxPct != null ? formatTokens(Math.round((ctxPct / 100) * (usage?.contextmax || DefaultContextMax))) : "—";
    const cost = usage?.costusd ? `$${usage.costusd.toFixed(2)}` : "—";

    return (
        <aside className="flex w-[296px] shrink-0 flex-col gap-[24px] overflow-y-auto border-l border-[#1a1f26] bg-surface px-[18px] pb-[40px] pt-[20px]">
            <div>
                <div className="mb-[13px]">
                    <SectionLabel>Details</SectionLabel>
                </div>
                <div className="flex flex-col">
                    <DetailRow label="Project" value={project || "—"} />
                    {/* PLACEHOLDER (1b): git branch has no data source — see spec §8 */}
                    <DetailRow label="Branch" value="main" />
                    <DetailRow label="Model" value={agent.model ?? "—"} />
                    <DetailRow label="Running" value={running} />
                    <DetailRow label="Tokens" value={tokens} />
                    <DetailRow label="Cost" value={cost} />
                </div>
            </div>

            {ctxPct != null ? (
                <div>
                    <div className="mb-[8px] flex items-baseline justify-between">
                        <SectionLabel>Context window</SectionLabel>
                        <span className="font-mono text-[12px] font-semibold text-accent">{Math.round(ctxPct)}%</span>
                    </div>
                    <div className="h-[7px] overflow-hidden rounded-[4px] bg-[#1a1f25]">
                        <span
                            className={cn("block h-full rounded-[4px]", GAUGE_FILL[usageLevel(ctxPct)])}
                            style={{ width: `${Math.min(100, ctxPct)}%` }}
                        />
                    </div>
                </div>
            ) : null}

            {subs.length > 0 ? (
                <div>
                    <div className="mb-[11px] flex items-center justify-between">
                        <SectionLabel>Subagents</SectionLabel>
                        <span className="rounded-[20px] bg-accentbg px-[8px] py-[1px] font-mono text-[11px] font-semibold text-accent-soft">
                            {subs.length}
                        </span>
                    </div>
                    <div className="flex flex-col gap-[7px]">
                        {subs.map((s) => (
                            <div
                                key={s.id}
                                className="flex items-center gap-[10px] rounded-[10px] border border-[#1c2128] bg-[#0f1217] px-[11px] py-[9px]"
                            >
                                <span
                                    className="h-[6px] w-[6px] shrink-0 rounded-full"
                                    style={{
                                        background:
                                            s.state === "working"
                                                ? "var(--color-accent)"
                                                : s.state === "failure"
                                                  ? "var(--color-error)"
                                                  : "var(--color-success)",
                                    }}
                                />
                                <div className="min-w-0 flex-1">
                                    <div className="truncate font-mono text-[11.5px] font-semibold text-secondary">
                                        {s.type || "subagent"}
                                    </div>
                                    <div className="truncate text-[10px] text-muted">{s.model ?? ""}</div>
                                </div>
                                <span className="whitespace-nowrap font-mono text-[9.5px] font-medium text-muted">
                                    {s.state}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            ) : null}

            {tools.length > 0 ? (
                <div>
                    <div className="mb-[11px]">
                        <SectionLabel>Tools used</SectionLabel>
                    </div>
                    <div className="flex flex-wrap gap-[7px]">
                        {tools.map((t) => (
                            <span
                                key={t.verb}
                                className="rounded-[6px] border border-edge-mid bg-surface-raised px-[9px] py-[4px] font-mono text-[11px] font-medium text-[#9aa3ad]"
                            >
                                {t.verb} ×{t.count}
                            </span>
                        ))}
                    </div>
                </div>
            ) : null}

            <div>
                <div className="mb-[11px]">
                    <SectionLabel>Files touched</SectionLabel>
                </div>
                {/* PLACEHOLDER (1b): no git status source — see spec §8 */}
                <div className="flex flex-col gap-[7px]">
                    {PLACEHOLDER_FILES.map((f) => (
                        <div key={f.path} className="flex items-center gap-[8px] font-mono text-[11.5px] font-medium text-[#aeb6bf]">
                            <span className={f.color}>{f.status}</span>
                            {f.path}
                        </div>
                    ))}
                </div>
            </div>

            {/* DISABLED (1b): no agent-lifecycle RPC — see spec §8 */}
            <div className="mt-[4px] flex gap-[8px]">
                <button
                    type="button"
                    disabled
                    title="coming soon"
                    className="flex-1 cursor-not-allowed rounded-[8px] border border-edge-mid bg-surface-raised py-[8px] text-[12px] font-medium text-muted opacity-50"
                >
                    Resume
                </button>
                <button
                    type="button"
                    disabled
                    title="coming soon"
                    className="flex-1 cursor-not-allowed rounded-[8px] border border-error/30 bg-transparent py-[8px] text-[12px] font-medium text-error opacity-50"
                >
                    Stop
                </button>
            </div>
        </aside>
    );
}
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: only the 3 baseline errors. If `recentActions` import errors, confirm it is exported from `agentsviewmodel.ts` (it is) — `recentActions(entries, 0)` returns all action-kind entries.

No commit yet.

---

## Task 4: `AgentTranscript` center pane

**Files:**
- Create: `frontend/app/view/agents/agenttranscript.tsx`

Absorbs `FocusView`'s center logic (scroll-stick, "↓ N new" pill, `NarrationTimeline`) and adds the handoff header + footer (lines **400–486**). Reads/writes the model's answer atoms directly (no prop drilling). Amber `AnswerBar` renders for asking agents; static placeholder suggestion chips + the reused `AgentComposer` sit in the footer.

- [ ] **Step 1: Write the component**

Create `frontend/app/view/agents/agenttranscript.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type { AgentsViewModel } from "./agents";
import { AgentComposer } from "./agentcomposer";
import { AnswerBar } from "./answerbar";
import { toggleSelection, type AgentVM } from "./agentsviewmodel";
import { liveEntriesByIdAtom } from "./livetranscript";
import { NarrationTimeline } from "./narrationtimeline";
import { projectNameFromTranscriptPath } from "./projectname";
import { StatusDot } from "./statusdot";

const STATE_COLOR: Record<AgentVM["state"], string> = {
    asking: "var(--color-warning)",
    working: "var(--color-accent)",
    idle: "var(--color-muted)",
};
const STATE_LABEL: Record<AgentVM["state"], string> = { asking: "asking", working: "working", idle: "idle" };

// PLACEHOLDER (1b): no suggestion generator — see spec §8. Disabled, for visual parity with the handoff footer.
const PLACEHOLDER_SUGGESTIONS = ["Looks good, continue", "Run the tests", "Explain your plan"];

export function AgentTranscript({ model, agent }: { model: AgentsViewModel; agent: AgentVM }) {
    const liveEntries = useAtomValue(liveEntriesByIdAtom);
    const answerSel = useAtomValue(model.answerSelAtom);
    const answerTab = useAtomValue(model.answerTabAtom);
    const sentIds = useAtomValue(model.sentIdsAtom);
    const focusReply = useAtomValue(model.focusReplyAtom);
    const entries = liveEntries[agent.id] ?? agent.previousInfo ?? [];
    const project = projectNameFromTranscriptPath(agent.transcriptPath ?? "");
    const asking = agent.state === "asking";

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
        if (focusReply) {
            composerWrapRef.current?.querySelector("textarea")?.focus();
        }
    }, [focusReply, agent.id]);

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
        <div className="flex min-w-0 flex-1 flex-col">
            {/* header */}
            <div className="flex shrink-0 items-center gap-[13px] border-b border-[#1a1f26] bg-[#0d1014] px-[22px] py-[14px]">
                <StatusDot state={agent.state} className="!h-[9px] !w-[9px]" />
                <div className="min-w-0">
                    <div className="flex items-center gap-[9px]">
                        <span className="whitespace-nowrap font-mono text-[15px] font-semibold text-[#eef1f4]">
                            {agent.name}
                        </span>
                        <span
                            className="rounded-[5px] border px-[7px] py-[1px] font-mono text-[10.5px] font-medium opacity-85"
                            style={{ color: STATE_COLOR[agent.state], borderColor: STATE_COLOR[agent.state] }}
                        >
                            {STATE_LABEL[agent.state]}
                        </span>
                    </div>
                    {/* PLACEHOLDER (1b): branch has no data source — see spec §8 */}
                    <div className="mt-[2px] font-mono text-[11px] font-medium text-muted">
                        {project ? `${project} · ` : ""}main
                    </div>
                </div>
                <div className="flex-1" />
                <button
                    type="button"
                    onClick={() => model.openTerminal(agent.id)}
                    className="rounded-[7px] border border-edge-mid bg-surface-raised px-[11px] py-[6px] text-[12px] font-medium text-[#aeb6bf] hover:border-edge-strong"
                >
                    Open terminal
                </button>
                {/* DISABLED (1b): no lifecycle RPC — see spec §8 */}
                <button
                    type="button"
                    disabled
                    title="coming soon"
                    className="cursor-not-allowed rounded-[7px] border border-edge-mid bg-surface-raised px-[11px] py-[6px] text-[12px] font-medium text-muted opacity-50"
                >
                    Pause
                </button>
            </div>

            {/* transcript */}
            <div ref={scrollRef} onScroll={onScroll} className={cn("relative min-h-0 flex-1 overflow-y-auto px-[22px] pb-[16px] pt-[24px]", asking && "opacity-90")}>
                <div className="mx-auto flex max-w-[720px] flex-col gap-[18px]">
                    <NarrationTimeline key={agent.id} entries={entries} accentLatest large active={agent.state === "working"} />
                </div>
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

            {/* amber answer for structured asks */}
            {asking ? (
                <AnswerBar
                    agent={agent}
                    selections={answerSel[agent.id] ?? {}}
                    sent={sentIds.has(agent.id)}
                    numbered
                    activeQuestion={answerTab[agent.id] ?? 0}
                    onToggle={(qi, oi) => {
                        const multi = agent.ask?.questions?.[qi]?.multiSelect ?? false;
                        globalStore.set(model.answerSelAtom, {
                            ...answerSel,
                            [agent.id]: toggleSelection(answerSel[agent.id] ?? {}, qi, oi, multi),
                        });
                    }}
                    onSubmit={() => model.submitAnswer(agent.id)}
                    onSelectQuestion={(qi) => globalStore.set(model.answerTabAtom, { ...answerTab, [agent.id]: qi })}
                    className="shrink-0 border-t border-warning bg-warning/5 px-[18px] py-3"
                />
            ) : null}

            {/* footer: suggestion chips (placeholder) + composer */}
            <div className="shrink-0 border-t border-[#1a1f26] bg-[#0d1014] px-[22px] pb-[16px] pt-[14px]">
                <div className="mx-auto max-w-[720px]">
                    <div className="mb-[11px] flex flex-wrap gap-[8px]">
                        {PLACEHOLDER_SUGGESTIONS.map((s) => (
                            <button
                                key={s}
                                type="button"
                                disabled
                                title="coming soon"
                                className="cursor-not-allowed rounded-[20px] border border-warning/30 bg-warning/10 px-[13px] py-[5px] text-[12px] font-medium text-[#e6cd97] opacity-60"
                            >
                                {s}
                            </button>
                        ))}
                    </div>
                    <div ref={composerWrapRef}>
                        <AgentComposer blockId={agent.blockId} placeholder={`message ${agent.name}…`} />
                    </div>
                </div>
            </div>
        </div>
    );
}
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: only the 3 baseline errors. (`AgentComposer` takes `{ blockId, placeholder }`; `AnswerBar` props match `focusview.tsx`'s prior usage.)

No commit yet.

---

## Task 5: `AgentSurface` container, wire shell, delete `FocusView`

**Files:**
- Create: `frontend/app/view/agents/agentsurface.tsx`
- Modify: `frontend/app/view/agents/cockpitshell.tsx`
- Delete: `frontend/app/view/agents/focusview.tsx`

`AgentSurface` reproduces the interim's terminal-vs-focus branch + keyboard, now laying out the three panes. The `CockpitFocusPane` import lives here (shell-side only — `agents.tsx` never imports this file, so the TDZ cycle stays broken).

- [ ] **Step 1: Write `AgentSurface`**

Create `frontend/app/view/agents/agentsurface.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Agent (Focus) surface (Phase 1b): a 3-pane focus over the existing agents/* data. When a
// terminal target is set ("Open terminal"), the whole surface is the term block (CockpitFocusPane),
// matching the interim. With no focus it falls back to the Cockpit surface. Routing is shell-side
// (this file is imported only by cockpitshell.tsx) so agents.tsx never imports CockpitFocusPane,
// keeping the agents -> focus-pane -> blockregistry -> agents eval cycle broken.

import { CockpitFocusPane } from "@/app/cockpit/focus-pane";
import { globalStore } from "@/app/store/jotaiStore";
import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";
import type { AgentsViewModel } from "./agents";
import { AgentDetailsRail } from "./agentdetailsrail";
import { AgentTranscript } from "./agenttranscript";
import { AgentTree } from "./agenttree";
import { moveCursor } from "./agentsviewmodel";
import { CockpitSurface } from "./cockpitsurface";

export function AgentSurface({ model, tabId }: { model: AgentsViewModel; tabId: string }) {
    const terminalTarget = useAtomValue(model.terminalTargetAtom);
    const focusId = useAtomValue(model.focusIdAtom);
    const agents = useAtomValue(model.agentsAtom);
    const order = useAtomValue(model.orderAtom);
    const wrapRef = useRef<HTMLDivElement>(null);
    const agent = focusId != null ? agents.find((a) => a.id === focusId) : undefined;
    const showFocus = !terminalTarget && agent != null;

    // pull keyboard focus to the wrapper so esc/←→/t work without a click (mirrors the interim)
    useEffect(() => {
        if (showFocus) {
            wrapRef.current?.focus();
        }
    }, [showFocus, agent?.id]);

    if (terminalTarget) {
        return <CockpitFocusPane blockId={terminalTarget} tabId={tabId} />;
    }
    if (!agent) {
        return <CockpitSurface model={model} />;
    }

    const step = (delta: number) => {
        globalStore.set(model.focusIdAtom, moveCursor(order, agent.id, delta) ?? agent.id);
        globalStore.set(model.focusReplyAtom, false);
    };
    const onKeyDown = (e: React.KeyboardEvent) => {
        const el = e.target as HTMLElement;
        if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) {
            return;
        }
        if (e.key === "Escape") {
            e.preventDefault();
            globalStore.set(model.surfaceAtom, "cockpit");
        } else if (e.key === "ArrowLeft") {
            e.preventDefault();
            step(-1);
        } else if (e.key === "ArrowRight") {
            e.preventDefault();
            step(1);
        } else if (e.key === "t") {
            e.preventDefault();
            model.openTerminal(agent.id);
        }
    };

    return (
        <div ref={wrapRef} tabIndex={0} onKeyDown={onKeyDown} className="flex h-full w-full outline-none">
            <AgentTree model={model} />
            <AgentTranscript model={model} agent={agent} />
            <AgentDetailsRail model={model} agent={agent} />
        </div>
    );
}
```

- [ ] **Step 2: Rewrite `cockpitshell.tsx` to route through `AgentSurface`**

Replace the entire contents of `frontend/app/view/agents/cockpitshell.tsx` with:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { useAtomValue } from "jotai";
import type { AgentsViewModel } from "./agents";
import { AgentSurface } from "./agentsurface";
import { CockpitSurface } from "./cockpitsurface";
import { NavRail } from "./navrail";
import { PlaceholderSurface } from "./placeholdersurface";

export function CockpitShell({ model, tabId }: { model: AgentsViewModel; tabId: string }) {
    const surface = useAtomValue(model.surfaceAtom);
    return (
        <div className="flex h-full w-full">
            <NavRail model={model} />
            <div className="relative min-w-0 flex-1">
                {surface === "cockpit" ? (
                    <CockpitSurface model={model} />
                ) : surface === "agent" ? (
                    <AgentSurface model={model} tabId={tabId} />
                ) : (
                    <PlaceholderSurface surface={surface} />
                )}
            </div>
        </div>
    );
}
```

- [ ] **Step 3: Delete `focusview.tsx`**

Run: `git rm frontend/app/view/agents/focusview.tsx`
Expected: file removed. (`cockpitshell.tsx` was its only importer; `AgentTranscript` now carries its logic.)

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: only the 3 baseline `api.test.ts` errors. Any "Cannot find module './focusview'" means a leftover importer — grep `rg "focusview"` under `frontend/` and remove the reference.

- [ ] **Step 5: Run unit tests**

Run: `npx vitest run`
Expected: all green, including the new `agenttree.test.ts` (6) and the unchanged `agentsviewmodel.test.ts` / `sessionviewmodel.test.ts` suites.

- [ ] **Step 6: Build to prove the import graph stays acyclic**

Run: `npx vite build --config frontend/tauri/vite.config.ts`
Expected: build succeeds (no circular-dependency / TDZ error). This is the gate that the `FocusView` delete + `AgentSurface` add didn't reintroduce the `agents → focus-pane → blockregistry` cycle.

- [ ] **Step 7: Commit (juncture)**

Show the diff for approval first (project git rule), then on approval:

```bash
git add frontend/app/view/agents/agenttreemodel.ts frontend/app/view/agents/agenttreemodel.test.ts \
        frontend/app/view/agents/agenttree.tsx frontend/app/view/agents/agentdetailsrail.tsx \
        frontend/app/view/agents/agenttranscript.tsx frontend/app/view/agents/agentsurface.tsx \
        frontend/app/view/agents/cockpitshell.tsx \
        docs/superpowers/specs/2026-06-25-cockpit-phase1b-agent-surface-design.md \
        docs/superpowers/plans/2026-06-25-cockpit-phase1b-agent-surface.md
git rm frontend/app/view/agents/focusview.tsx
git commit -m "feat(cockpit): Agent 3-pane focus surface (Phase 1b)"
```

(Spec + plan fold into this feature commit per the project rule — not a separate docs commit.)

---

## Task 6: Visual verification (user `task dev` + CDP)

CDP is not automatable on the Tauri webview, so this is the user's manual gate (see the 1a convention).

- [ ] **Step 1: Run the dev app**

Run: `task dev`
Note: a `vite.config.ts`-level change is not involved here, so a hot reload is enough; no restart needed.

- [ ] **Step 2: Walk the surface**

Confirm:
1. NavRail → **Agent** shows three panes at 248 / flex / 296px with the handoff palette (surface `#0e1116` panes, `#0d1014` center header/footer, periwinkle accent).
2. The **left tree** groups agents by project (mono uppercase headers, attn badge, count); clicking a parent re-focuses; a working parent with subagents shows the expand pill and `↳` children.
3. The **center** streams the transcript with burst-collapse + the "↓ N new" pill; an asking agent shows the amber `AnswerBar`; the footer shows disabled suggestion chips + the composer.
4. The **right rail** shows live Project/Model/Running/Cost, the context-window gauge, the Subagents list (when working), derived Tools-used pills, the placeholder Files-touched list, and disabled Resume/Stop.
5. **Open terminal** swaps the whole surface to the term block; **Esc** returns to the cockpit; **←/→** step focus; **t** toggles the terminal.
6. The **Cockpit** surface (NavRail → Cockpit) is visually and behaviorally unchanged.

---

## Self-review (completed during planning)

**Spec coverage:** Tree (Task 2) ✓ · Transcript+composer (Task 4) ✓ · Details rail incl. derived tools-used + placeholders + disabled actions (Task 3) ✓ · `AgentSurface` container + terminal swap + keyboard + fallback (Task 5) ✓ · `buildAgentTree` pure + test (Task 1) ✓ · delete `FocusView` / rewire shell (Task 5) ✓ · verification gates (Tasks 5–6) ✓. Deferred seams (spec §8) are rendered as marked placeholders/disabled, not omitted.

**Placeholder scan:** The only "placeholder" content is the *intentional* not-yet-live UI (branch, files-touched, suggestion chips, lifecycle buttons), each carrying a `PLACEHOLDER`/`DISABLED` code comment pointing at spec §8. No TBD/TODO steps; every code step shows complete code.

**Type consistency:** `AgentTreeRow` / `buildAgentTree` signatures match between Task 1 and Task 2. `getSubagentsAtom`/`getSubagentExpandAtom`/`toggleSubagentExpand`/`subagentExpanded`/`SubagentState` match `agentstatusstore.ts` + `sessionviewmodel.ts`. `recentActions`/`summarizeActions`/`formatAge`/`formatTokens`/`usageLevel`/`moveCursor`/`toggleSelection` match `agentsviewmodel.ts`. `AnswerBar`/`AgentComposer`/`NarrationTimeline`/`StatusDot` props match current usage in `focusview.tsx`/`cockpitsurface.tsx`. The oref form `block:${agent.blockId}` matches `liveagents.ts` (`blockId = termBlockOref.split(":")[1]`).

## Known follow-ups (not in 1b)

- The reused `AgentComposer` keeps its existing styling — it is NOT rebuilt to the handoff composer (model-picker/attach/Send) because it is shared with the Cockpit cards; reskinning it is a separate, cross-surface change.
- Subagent children are display-only (no per-child transcript); selecting one is a no-op in 1b (spec §9).
