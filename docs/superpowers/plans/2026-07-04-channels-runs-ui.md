# Channels Runs — Run UI (Piece 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Channels Runs view — run tabs, a vertical phase rail threading each phase's activity, a review gate, and a Start-run composer — wired to the Piece 1 backend.

**Architecture:** Runs are read from `channel.runs` (already mirrored via WOS `activeChannelAtom`); worker liveness from the existing `model.agentsAtom` roster. A new pure module (`runmodel.ts`) derives everything the view renders; a new `runssurface.tsx` renders it; `channelssurface.tsx` gains a Chat/Runs toggle. Human decisions (approve/send-back/cancel/steer) call existing RPCs; phase completion is reported by the external `~/.claude` hook (not the UI).

**Tech Stack:** React 19, Vite, Tailwind 4, jotai, vitest. wshrpc typed client (`RpcApi`/`TabRpcClient`).

**Design spec:** `docs/superpowers/specs/2026-07-04-channels-runs-ui-design.md`. Locked IA: `wave-handoff/wave/project/Wave-runs.dc.html` section 2a ("Turn 2 · converged").

## Global Constraints

- **Never hand-edit generated files** (`frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts`). The `Run`/`RunPhase` types and `CreateRun`/`AdvanceRun`/`CancelRun` commands already exist from Piece 1.
- **Typecheck command (tsc stack-overflows normally):** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`. Baseline is clean (exit 0); any error it reports is yours.
- **No unit-test render harness exists** for the cockpit. Pure `.ts` logic is unit-tested with vitest; React components are verified with `tsc` + a CDP screenshot against the live dev app (`node scripts/cdp-shot.mjs out.png`), never a render test.
- **`Run.status`** values: `planning | awaiting-review | executing | blocked | done | failed | cancelled`. **`RunPhase.state`** values: `pending | running | blocked | done | failed | skipped`. **`RunPhase.kind`**: `brainstorm | plan | execute | custom`. Copy these verbatim; do not invent variants.
- **`AdvanceRun` action** values: `complete | approve | sendback`. The UI issues only `approve` and `sendback`.
- **Match existing conventions** in `frontend/app/view/agents/`: Tailwind utility classes with the project's CSS tokens (`text-primary`, `bg-surface-raised`, `border-edge-mid`, `text-accent`, `bg-asking`, etc.), `fireAndForget` for fire-and-forget async in handlers, `globalStore.get/set` for imperative atom access.
- **Commits:** this repo requires explicit human approval before any `git commit`. Each task below ends with a "Commit" step; when executing, stage the listed files and **present** the commit for approval rather than committing unattended.

---

## File Structure

- `frontend/app/view/agents/channelsprimitives.tsx` (**new**) — shared UI atoms extracted from `channelssurface.tsx`: `STATE_DOT`, `workerFor`, `jumpToAgent`, `timeLabel`, `Avatar`, `Tag`, `AskRow`, `WorkerRow`. Imported by both `channelssurface.tsx` and `runssurface.tsx`.
- `frontend/app/view/agents/runmodel.ts` (**new**) — pure Run/phase derivations. Unit-tested.
- `frontend/app/view/agents/runmodel.test.ts` (**new**) — vitest.
- `frontend/app/view/agents/runactions.ts` (**new**) — impure Run lifecycle RPC wrappers.
- `frontend/app/view/agents/runssurface.tsx` (**new**) — `<RunsView>` + sub-components.
- `frontend/app/view/agents/channelssurface.tsx` (**modify**) — remove the extracted primitives (import them back), add the Chat/Runs toggle + conditional render.

---

## Task 1: Extract shared primitives to `channelsprimitives.tsx`

Pure refactor, no behavior change. Moves the atoms the Runs view reuses out of `channelssurface.tsx` so both surfaces import them instead of duplicating.

**Files:**
- Create: `frontend/app/view/agents/channelsprimitives.tsx`
- Modify: `frontend/app/view/agents/channelssurface.tsx` (delete the moved definitions; import them)

**Interfaces:**
- Produces: `STATE_DOT: Record<string,string>`, `workerFor(agents: AgentVM[], refORef: string): AgentVM | undefined`, `jumpToAgent(model: AgentsViewModel, id: string): void`, `timeLabel(ts: number, now: number): string`, `Avatar({name: string})`, `Tag({label: string, tone: "muted"|"asking"})`, `AskRow({model: AgentsViewModel, agent: AgentVM})`, `WorkerRow({model: AgentsViewModel, w: WorkerState})`.

- [ ] **Step 1: Create `channelsprimitives.tsx` with the moved code**

Cut these exact definitions from `channelssurface.tsx` (currently at lines ~60-156, ~68-92, ~200-220, ~812-840) and paste into the new file, adding `export` to each. Full file:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Shared UI atoms for the Channels + Runs surfaces: avatars, tags, the live-ask answer row, a fleet
// worker row, and small worker-resolution helpers. Extracted from channelssurface.tsx so runssurface.tsx
// reuses them without duplication.

import { globalStore } from "@/app/store/jotaiStore";
import { useAtomValue, useSetAtom } from "jotai";
import type { AgentsViewModel } from "./agents";
import { toggleSelection, type AgentVM } from "./agentsviewmodel";
import { AnswerBar } from "./answerbar";
import { avatarColor } from "./channelderive";
import type { WorkerState } from "./jarvisderive";
import { runtimeLogo } from "./runtimelogo";

export const STATE_DOT: Record<string, string> = {
    working: "var(--color-success)",
    asking: "var(--color-asking)",
    idle: "var(--color-muted)",
    gone: "var(--color-edge-strong)",
};

// resolve a dispatch/directive RefORef ("tab:<id>") to the live roster row, if still present
export function workerFor(agents: AgentVM[], refORef: string): AgentVM | undefined {
    if (!refORef.startsWith("tab:")) {
        return undefined;
    }
    const id = refORef.slice(4);
    return agents.find((a) => a.id === id);
}

export function jumpToAgent(model: AgentsViewModel, id: string) {
    globalStore.set(model.focusIdAtom, id);
    globalStore.set(model.terminalTargetAtom, undefined);
    globalStore.set(model.surfaceAtom, "agent");
}

export function timeLabel(ts: number, now: number): string {
    return now - ts < 60_000 ? "now" : new Date(ts).toLocaleTimeString();
}

// 32px rounded avatar. Jarvis (the manager) gets a diamond glyph on an accent gradient; a runtime
// author (claude/codex/antigravity) gets its real brand mark on a white logo-tile (initials are
// ambiguous — claude and codex both start with "C"); everyone else gets a deterministically-colored initial.
export function Avatar({ name }: { name: string }) {
    if (name.toLowerCase() === "jarvis") {
        return (
            <div className="flex h-8 w-8 flex-none items-center justify-center rounded-[9px] bg-accent">
                <span className="h-2.5 w-2.5 rotate-45 rounded-[2px] bg-background" />
            </div>
        );
    }
    const logo = runtimeLogo(name);
    if (logo) {
        return (
            <img
                src={logo}
                alt={name}
                title={name}
                className="h-8 w-8 flex-none rounded-[9px] border border-edge-mid bg-white object-contain p-1.5"
            />
        );
    }
    return (
        <div
            className="flex h-8 w-8 flex-none items-center justify-center rounded-[9px] font-mono text-[13px] font-bold text-background"
            style={{ backgroundColor: avatarColor(name) }}
        >
            {(name.charAt(0) || "?").toUpperCase()}
        </div>
    );
}

export function Tag({ label, tone }: { label: string; tone: "muted" | "asking" }) {
    if (tone === "asking") {
        return (
            <span className="rounded-[4px] bg-asking px-1.5 py-px font-mono text-[9px] font-semibold uppercase tracking-[.08em] text-background">
                {label}
            </span>
        );
    }
    return (
        <span className="rounded-[4px] border border-edge-mid bg-surface-raised px-1.5 py-px font-mono text-[9px] font-semibold uppercase tracking-[.08em] text-ink-mid">
            {label}
        </span>
    );
}

// An asking worker's answer row, reusing the cockpit's AnswerBar + model answer state.
export function AskRow({ model, agent }: { model: AgentsViewModel; agent: AgentVM }) {
    const answerSel = useAtomValue(model.answerSelAtom);
    const setAnswerSel = useSetAtom(model.answerSelAtom);
    const sentIds = useAtomValue(model.sentIdsAtom);
    const toggle = (qi: number, oi: number) => {
        const multi = agent.ask?.questions?.[qi]?.multiSelect ?? false;
        setAnswerSel((prev) => ({ ...prev, [agent.id]: toggleSelection(prev[agent.id] ?? {}, qi, oi, multi) }));
    };
    return (
        <div className="rounded-[9px] border border-asking/40 bg-lane-asking p-3">
            <AnswerBar
                agent={agent}
                selections={answerSel[agent.id] ?? {}}
                sent={sentIds.has(agent.id)}
                numbered
                onToggle={toggle}
                onSubmit={() => model.submitAnswer(agent.id)}
            />
        </div>
    );
}

export function WorkerRow({ model, w }: { model: AgentsViewModel; w: WorkerState }) {
    return (
        <div className="mb-2.5">
            <div className="flex items-center gap-2">
                <span
                    className="h-2 w-2 flex-none rounded-full"
                    style={{ backgroundColor: STATE_DOT[w.state] ?? "var(--color-muted)" }}
                />
                <span className="font-mono text-[12.5px] text-primary">{w.name}</span>
                {w.state === "gone" ? (
                    <span className="ml-auto font-mono text-[10px] text-muted">gone</span>
                ) : (
                    <button
                        type="button"
                        onClick={() => jumpToAgent(model, w.oref.slice("tab:".length))}
                        className="ml-auto cursor-pointer font-mono text-[10px] text-accent-soft hover:text-accent"
                    >
                        open ↗
                    </button>
                )}
            </div>
            {(w.dispatchTask ?? w.task) ? (
                <div title={w.dispatchTask ?? w.task} className="mt-0.5 truncate pl-4 text-[11px] text-muted">
                    {w.dispatchTask ?? w.task}
                </div>
            ) : null}
        </div>
    );
}
```

- [ ] **Step 2: Update `channelssurface.tsx` — delete the moved defs, import them**

Delete from `channelssurface.tsx`: the `STATE_DOT` const, `workerFor`, `jumpToAgent`, `timeLabel`, `Avatar`, `Tag`, `AskRow`, and `WorkerRow` function definitions (leave `OptionList`, `EscalationRow`, `MessageRow`, `consultIdOf`, `jarvisReqIdOf`, `useSettle`, and everything else in place — `OptionList` and `EscalationRow` stay because they are used only by the chat timeline).

Add this import near the other `./` imports:

```tsx
import { Avatar, AskRow, STATE_DOT, Tag, timeLabel, WorkerRow, workerFor } from "./channelsprimitives";
```

Remove any now-unused imports from `channelssurface.tsx` that were used *only* by the moved code: check `runtimeLogo` (used only by `Avatar`), `toggleSelection` (used only by `AskRow`), `avatarColor` (used only by `Avatar`) — remove those imports from `channelssurface.tsx` if nothing else references them. Keep `AnswerBar` only if `MessageRow` still uses it (it does — leave it). Keep `WorkerState` import only if still referenced (it is, by `ContextPanel`/`buildFleetSnapshot` usage — leave it).

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0, no errors. (If it reports "declared but never used" for `runtimeLogo`/`toggleSelection`/`avatarColor` in `channelssurface.tsx`, remove those imports and re-run.)

- [ ] **Step 4: Run the existing channels tests**

Run: `npx vitest run frontend/app/view/agents/channelmessages.test.ts frontend/app/view/agents/jarviscards.test.ts frontend/app/view/agents/channelderive.test.ts`
Expected: all pass (these don't import the moved components, so this just confirms no import graph breakage).

- [ ] **Step 5: Visual smoke — chat still renders**

Ensure the dev app is running (`tail -f /dev/null | task dev` if not — Go isn't hot-reloaded but this is a frontend-only change, so Vite HMR picks it up). Then:
Run: `node scripts/cdp-shot.mjs C:/Users/cktra/AppData/Local/Temp/claude/scratch-primitives.png`
Expected: a screenshot of the app; open it and confirm the Channels chat view still shows avatars and message rows (no blank/broken rows).

- [ ] **Step 6: Commit** (present for approval)

```bash
git add frontend/app/view/agents/channelsprimitives.tsx frontend/app/view/agents/channelssurface.tsx
git commit -m "refactor(channels): extract shared UI primitives for the Runs view"
```

---

## Task 2: `runmodel.ts` — status/phase views + run-level derivations (TDD)

Pure functions mapping a `Run` to view data. Fully unit-tested.

**Files:**
- Create: `frontend/app/view/agents/runmodel.ts`
- Test: `frontend/app/view/agents/runmodel.test.ts`

**Interfaces:**
- Produces: `runStatusView(status: string): {label: string; tone: RunStatusTone}`, `phaseStateView(state: string): {icon: string; label: string; tone: PhaseTone}`, `currentPhaseIndex(run: Run): number`, `reviewGate(run: Run): {phaseIdx: number} | null`, `isTerminal(status: string): boolean`, `defaultView(channel: Channel | null): "runs"|"chat"`, `defaultRunId(runs: Run[] | undefined): string | undefined`. Types `RunStatusTone`, `PhaseTone`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/app/view/agents/runmodel.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
    currentPhaseIndex,
    defaultRunId,
    defaultView,
    isTerminal,
    phaseStateView,
    reviewGate,
    runStatusView,
} from "./runmodel";

function phase(over: Partial<RunPhase> = {}): RunPhase {
    return { kind: "execute", state: "pending", ...over };
}
function run(over: Partial<Run> = {}): Run {
    return {
        id: "r1",
        goal: "g",
        workspaceid: "w1",
        projectpath: "/p",
        status: "planning",
        phases: [],
        createdts: 1,
        ...over,
    };
}

describe("runStatusView", () => {
    it("maps awaiting-review to a review tone with a spaced label", () => {
        expect(runStatusView("awaiting-review")).toEqual({ label: "awaiting review", tone: "review" });
    });
    it("maps executing to a running tone", () => {
        expect(runStatusView("executing").tone).toBe("running");
    });
    it("falls back to the raw status with a planning tone", () => {
        expect(runStatusView("weird")).toEqual({ label: "weird", tone: "planning" });
    });
});

describe("phaseStateView", () => {
    it("maps running", () => {
        expect(phaseStateView("running")).toMatchObject({ label: "running", tone: "running" });
    });
    it("maps unknown to pending", () => {
        expect(phaseStateView("zzz").tone).toBe("pending");
    });
});

describe("currentPhaseIndex", () => {
    it("returns the first running phase", () => {
        expect(currentPhaseIndex(run({ phases: [phase({ state: "done" }), phase({ state: "running" }), phase()] }))).toBe(1);
    });
    it("returns the gated phase when awaiting review", () => {
        const r = run({
            status: "awaiting-review",
            phases: [phase({ state: "done" }), phase({ gate: true, state: "done" }), phase({ state: "pending" })],
        });
        expect(currentPhaseIndex(r)).toBe(1);
    });
    it("returns the last non-skipped phase otherwise", () => {
        expect(currentPhaseIndex(run({ status: "done", phases: [phase({ state: "done" }), phase({ state: "skipped" })] }))).toBe(0);
    });
});

describe("reviewGate", () => {
    it("is null unless the run is awaiting review", () => {
        expect(reviewGate(run({ status: "executing", phases: [phase({ gate: true, state: "done" }), phase()] }))).toBeNull();
    });
    it("returns the done gated phase whose successor is pending", () => {
        const r = run({
            status: "awaiting-review",
            phases: [phase({ state: "done" }), phase({ gate: true, state: "done" }), phase({ state: "pending" })],
        });
        expect(reviewGate(r)).toEqual({ phaseIdx: 1 });
    });
});

describe("isTerminal / defaultView / defaultRunId", () => {
    it("treats done/cancelled/failed as terminal", () => {
        expect(isTerminal("done")).toBe(true);
        expect(isTerminal("executing")).toBe(false);
    });
    it("defaultView is runs when the channel has runs", () => {
        expect(defaultView({ runs: [run()] } as unknown as Channel)).toBe("runs");
        expect(defaultView({ runs: [] } as unknown as Channel)).toBe("chat");
        expect(defaultView(null)).toBe("chat");
    });
    it("defaultRunId prefers the most-recent non-terminal run", () => {
        const runs = [run({ id: "a", createdts: 1, status: "done" }), run({ id: "b", createdts: 2, status: "executing" })];
        expect(defaultRunId(runs)).toBe("b");
    });
    it("defaultRunId falls back to the most-recent run when all terminal", () => {
        const runs = [run({ id: "a", createdts: 1, status: "done" }), run({ id: "b", createdts: 2, status: "cancelled" })];
        expect(defaultRunId(runs)).toBe("b");
    });
    it("defaultRunId is undefined for no runs", () => {
        expect(defaultRunId([])).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run frontend/app/view/agents/runmodel.test.ts`
Expected: FAIL — `Cannot find module './runmodel'`.

- [ ] **Step 3: Implement `runmodel.ts`**

Create `frontend/app/view/agents/runmodel.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure derivations for the Channels Runs view: map a Run/RunPhase (backend types, mirrored via WOS)
// to the view's status pills, phase-node states, the current/gated phase, and the per-channel default
// view + run selection. No React, no jotai — unit-tested in runmodel.test.ts.

export type RunStatusTone = "planning" | "review" | "running" | "blocked" | "done" | "failed" | "cancelled";

export function runStatusView(status: string): { label: string; tone: RunStatusTone } {
    switch (status) {
        case "planning":
            return { label: "planning", tone: "planning" };
        case "awaiting-review":
            return { label: "awaiting review", tone: "review" };
        case "executing":
            return { label: "executing", tone: "running" };
        case "blocked":
            return { label: "blocked", tone: "blocked" };
        case "done":
            return { label: "done", tone: "done" };
        case "failed":
            return { label: "failed", tone: "failed" };
        case "cancelled":
            return { label: "cancelled", tone: "cancelled" };
        default:
            return { label: status, tone: "planning" };
    }
}

export type PhaseTone = "pending" | "running" | "blocked" | "done" | "failed" | "skipped";

export function phaseStateView(state: string): { icon: string; label: string; tone: PhaseTone } {
    switch (state) {
        case "running":
            return { icon: "●", label: "running", tone: "running" };
        case "done":
            return { icon: "✓", label: "done", tone: "done" };
        case "blocked":
            return { icon: "!", label: "blocked", tone: "blocked" };
        case "failed":
            return { icon: "✕", label: "failed", tone: "failed" };
        case "skipped":
            return { icon: "–", label: "skipped", tone: "skipped" };
        default:
            return { icon: "○", label: "pending", tone: "pending" };
    }
}

// The gated phase awaiting approval — non-null only when the run is paused at a review gate. The engine
// halts after a gated phase completes (that phase is `done`, its successor still `pending`).
export function reviewGate(run: Run): { phaseIdx: number } | null {
    if (run.status !== "awaiting-review") {
        return null;
    }
    const phases = run.phases ?? [];
    for (let i = 0; i < phases.length; i++) {
        if (phases[i].gate && phases[i].state === "done") {
            const next = phases[i + 1];
            if (!next || next.state === "pending") {
                return { phaseIdx: i };
            }
        }
    }
    return null;
}

// The phase the view focuses: the first running/blocked phase, else the gated phase awaiting review,
// else the last non-skipped phase.
export function currentPhaseIndex(run: Run): number {
    const phases = run.phases ?? [];
    const active = phases.findIndex((p) => p.state === "running" || p.state === "blocked");
    if (active >= 0) {
        return active;
    }
    const gate = reviewGate(run);
    if (gate) {
        return gate.phaseIdx;
    }
    for (let i = phases.length - 1; i >= 0; i--) {
        if (phases[i].state !== "skipped") {
            return i;
        }
    }
    return Math.max(0, phases.length - 1);
}

const TERMINAL = new Set(["done", "failed", "cancelled"]);

export function isTerminal(status: string): boolean {
    return TERMINAL.has(status);
}

export function defaultView(channel: Channel | null): "runs" | "chat" {
    return (channel?.runs?.length ?? 0) > 0 ? "runs" : "chat";
}

// Most-recent non-terminal run (so the user lands on live work), else the most-recent run.
export function defaultRunId(runs: Run[] | undefined): string | undefined {
    const list = runs ?? [];
    if (list.length === 0) {
        return undefined;
    }
    const sorted = [...list].sort((a, b) => b.createdts - a.createdts);
    const active = sorted.find((r) => !isTerminal(r.status));
    return (active ?? sorted[0]).id;
}
```

Note: `Run`, `RunPhase`, `Channel` are ambient global types (see `frontend/types/gotypes.d.ts` — declared in the global namespace, no import needed, same as `ChannelMessage` in the existing files).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/runmodel.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit** (present for approval)

```bash
git add frontend/app/view/agents/runmodel.ts frontend/app/view/agents/runmodel.test.ts
git commit -m "feat(runs): pure run/phase view derivations"
```

---

## Task 3: `runmodel.ts` — worker resolution + phase thread (TDD)

Adds the derivations that depend on the live agent roster: which workers a phase owns, and which threaded cards a phase shows.

**Files:**
- Modify: `frontend/app/view/agents/runmodel.ts`
- Modify: `frontend/app/view/agents/runmodel.test.ts`

**Interfaces:**
- Consumes: `AgentVM` from `./agentsviewmodel` (`{ id: string; name: string; state: string; ask?: {...}; ... }`).
- Produces: `phaseWorkers(phase: RunPhase, agents: AgentVM[]): AgentVM[]`, `phaseThread(run: Run, idx: number, agents: AgentVM[]): PhaseThread` where `PhaseThread = { showAsk: boolean; askKind: "clarify"|"fork"|null; askAgent?: AgentVM; showBoundary: boolean; showWorkers: boolean; showGate: boolean; showBlocked: boolean; showShip: boolean }`.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/app/view/agents/runmodel.test.ts` (add the imports `phaseWorkers, phaseThread` to the existing top import):

```ts
import type { AgentVM } from "./agentsviewmodel";
import { phaseThread, phaseWorkers } from "./runmodel";

function agent(over: Partial<AgentVM> = {}): AgentVM {
    return { id: "t1", name: "claude", state: "working" } as AgentVM;
    // note: cast — AgentVM has many fields; tests only touch id/name/state/ask
}

describe("phaseWorkers", () => {
    it("resolves tab: orefs to live roster rows, dropping missing ones", () => {
        const p: RunPhase = { kind: "execute", state: "running", workerorefs: ["tab:t1", "tab:gone"] };
        const agents = [{ ...agent(), id: "t1" }];
        expect(phaseWorkers(p, agents).map((a) => a.id)).toEqual(["t1"]);
    });
    it("returns empty for no orefs", () => {
        expect(phaseWorkers({ kind: "execute", state: "pending" }, [])).toEqual([]);
    });
});

describe("phaseThread", () => {
    const base = (over: Partial<Run>) =>
        ({ id: "r", goal: "g", workspaceid: "w", projectpath: "/p", status: "executing", phases: [], createdts: 1, ...over }) as Run;

    it("shows an ask (fork on execute) when a worker is asking", () => {
        const run = base({ phases: [{ kind: "execute", state: "running", workerorefs: ["tab:t1"] }] });
        const agents = [{ ...agent(), id: "t1", state: "asking" }];
        const t = phaseThread(run, 0, agents);
        expect(t.showAsk).toBe(true);
        expect(t.askKind).toBe("fork");
        expect(t.askAgent?.id).toBe("t1");
        expect(t.showWorkers).toBe(false); // suppressed while asking
    });
    it("labels a brainstorm-phase ask as clarify", () => {
        const run = base({ phases: [{ kind: "brainstorm", state: "running", workerorefs: ["tab:t1"] }] });
        const agents = [{ ...agent(), id: "t1", state: "asking" }];
        expect(phaseThread(run, 0, agents).askKind).toBe("clarify");
    });
    it("shows execute worker rows when running and not asking", () => {
        const run = base({ phases: [{ kind: "execute", state: "running", workerorefs: ["tab:t1"] }] });
        const agents = [{ ...agent(), id: "t1", state: "working" }];
        const t = phaseThread(run, 0, agents);
        expect(t.showWorkers).toBe(true);
        expect(t.showAsk).toBe(false);
    });
    it("shows the context-clear boundary for a started freshctx phase", () => {
        const run = base({ phases: [{ kind: "execute", state: "running", freshctx: true, workerorefs: ["tab:t1"] }] });
        expect(phaseThread(run, 0, [{ ...agent(), id: "t1" }]).showBoundary).toBe(true);
    });
    it("does not show the boundary for a pending freshctx phase", () => {
        const run = base({ phases: [{ kind: "execute", state: "pending", freshctx: true }] });
        expect(phaseThread(run, 0, []).showBoundary).toBe(false);
    });
    it("shows blocked when a running phase's recorded worker is gone", () => {
        const run = base({ phases: [{ kind: "execute", state: "running", workerorefs: ["tab:gone"] }] });
        expect(phaseThread(run, 0, []).showBlocked).toBe(true);
    });
    it("shows the gate card only on the gated phase", () => {
        const run = base({
            status: "awaiting-review",
            phases: [{ kind: "plan", gate: true, state: "done" }, { kind: "execute", state: "pending" }],
        });
        expect(phaseThread(run, 0, []).showGate).toBe(true);
        expect(phaseThread(run, 1, []).showGate).toBe(false);
    });
    it("shows ship on the last phase when the run is done", () => {
        const run = base({ status: "done", phases: [{ kind: "execute", state: "done" }] });
        expect(phaseThread(run, 0, []).showShip).toBe(true);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run frontend/app/view/agents/runmodel.test.ts`
Expected: FAIL — `phaseWorkers`/`phaseThread` not exported.

- [ ] **Step 3: Implement — append to `runmodel.ts`**

Add the `AgentVM` import at the top of `runmodel.ts`:

```ts
import type { AgentVM } from "./agentsviewmodel";
```

Append:

```ts
export function phaseWorkers(phase: RunPhase, agents: AgentVM[]): AgentVM[] {
    const out: AgentVM[] = [];
    for (const oref of phase.workerorefs ?? []) {
        if (!oref.startsWith("tab:")) {
            continue;
        }
        const found = agents.find((a) => a.id === oref.slice(4));
        if (found) {
            out.push(found);
        }
    }
    return out;
}

export interface PhaseThread {
    showAsk: boolean;
    askKind: "clarify" | "fork" | null;
    askAgent?: AgentVM;
    showBoundary: boolean;
    showWorkers: boolean;
    showGate: boolean;
    showBlocked: boolean;
    showShip: boolean;
}

// Which threaded elements a phase renders. Ask (live worker awaiting the human) is a clarify on a
// brainstorm phase, a fork otherwise, and it suppresses the plain worker rows. Blocked = a running phase
// whose recorded workers are all gone, or an engine-set blocked state. Ship = the last phase done on a
// finished run.
export function phaseThread(run: Run, idx: number, agents: AgentVM[]): PhaseThread {
    const phases = run.phases ?? [];
    const phase = phases[idx];
    const workers = phaseWorkers(phase, agents);
    const asker = workers.find((w) => w.state === "asking");
    const startedFresh = phase.state !== "pending" && phase.state !== "skipped";
    const recordedButGone = (phase.workerorefs?.length ?? 0) > 0 && workers.length === 0;
    return {
        showAsk: !!asker,
        askKind: asker ? (phase.kind === "brainstorm" ? "clarify" : "fork") : null,
        askAgent: asker,
        showBoundary: !!phase.freshctx && startedFresh,
        showWorkers: phase.state === "running" && workers.length > 0 && !asker,
        showGate: reviewGate(run)?.phaseIdx === idx,
        showBlocked: phase.state === "blocked" || (phase.state === "running" && recordedButGone),
        showShip: idx === phases.length - 1 && phase.state === "done" && run.status === "done",
    };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/runmodel.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit** (present for approval)

```bash
git add frontend/app/view/agents/runmodel.ts frontend/app/view/agents/runmodel.test.ts
git commit -m "feat(runs): phase worker resolution and thread derivation"
```

---

## Task 4: `runactions.ts` — Run lifecycle RPC wrappers

Thin impure wrappers over the generated RPCs, mirroring `channelactions.ts`. No unit tests (they only marshal to `RpcApi`, matching the repo pattern for `channelactions.ts`); verified by `tsc` and later CDP tasks.

**Files:**
- Create: `frontend/app/view/agents/runactions.ts`

**Interfaces:**
- Produces: `createRun(channelId: string, goal: string, playbookId?: string): Promise<Run>`, `approveGate(channelId: string, runId: string, gateIdx: number): Promise<void>`, `sendBackGate(channelId: string, runId: string, gateIdx: number): Promise<void>`, `cancelRun(channelId: string, runId: string): Promise<void>`.

- [ ] **Step 1: Create `runactions.ts`**

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Impure Run lifecycle: thin wrappers over the Piece 1 RPCs. CreateRun sources the active workspace id
// from the boot-resolved global atom (mirrors agentactions.ts). Approve/send-back drive the review gate;
// cancel stops the run. Phase *completion* is reported by the external ~/.claude hook, not from here.

import { atoms } from "@/app/store/global-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";

export async function createRun(channelId: string, goal: string, playbookId?: string): Promise<Run> {
    const workspaceId = globalStore.get(atoms.workspaceId);
    const rtn = await RpcApi.CreateRunCommand(TabRpcClient, {
        channelid: channelId,
        workspaceid: workspaceId,
        goal,
        playbookid: playbookId,
    });
    return rtn.run;
}

export async function approveGate(channelId: string, runId: string, gateIdx: number): Promise<void> {
    await RpcApi.AdvanceRunCommand(TabRpcClient, {
        channelid: channelId,
        runid: runId,
        phaseidx: gateIdx,
        action: "approve",
    });
}

export async function sendBackGate(channelId: string, runId: string, gateIdx: number): Promise<void> {
    await RpcApi.AdvanceRunCommand(TabRpcClient, {
        channelid: channelId,
        runid: runId,
        phaseidx: gateIdx,
        action: "sendback",
    });
}

export async function cancelRun(channelId: string, runId: string): Promise<void> {
    await RpcApi.CancelRunCommand(TabRpcClient, { channelid: channelId, runid: runId });
}
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. (Confirms `atoms.workspaceId`, `RpcApi.CreateRunCommand`, `CommandCreateRunData`/`CommandAdvanceRunData`/`CommandCancelRunData` shapes all line up.)

- [ ] **Step 3: Commit** (present for approval)

```bash
git add frontend/app/view/agents/runactions.ts
git commit -m "feat(runs): run lifecycle rpc wrappers"
```

---

## Task 5: `runssurface.tsx` shell + Chat/Runs toggle

Delivers a reachable Runs view: the Chat/Runs toggle in the header, run tabs + New run, the run header (status pill + goal + Steer/Pause), an empty state, and a Start-run composer that calls `createRun`. The phase rail is a placeholder here (Task 6 fills it).

**Files:**
- Create: `frontend/app/view/agents/runssurface.tsx`
- Modify: `frontend/app/view/agents/channelssurface.tsx` (header toggle + conditional render)

**Interfaces:**
- Consumes: `runStatusView`, `isTerminal`, `defaultRunId`, `currentPhaseIndex` from `./runmodel`; `createRun`, `cancelRun` from `./runactions`; `steerWorker` from `./channelactions`; `AgentVM` from `./agentsviewmodel`; `AgentsViewModel` from `./agents`.
- Produces: `RunsView({ model, channel, agents }: { model: AgentsViewModel; channel: Channel; agents: AgentVM[] })`.

- [ ] **Step 1: Create `runssurface.tsx` shell**

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Runs view of a channel: run tabs (multiple runs per channel) + New run, a run header, and a
// vertical phase rail threading each phase's activity. Reads runs off the channel object (WOS-mirrored)
// and worker liveness off the live agent roster. Human decisions (approve/send-back/cancel/steer) call
// existing RPCs; phase completion arrives via the external hook. See runmodel.ts for all derivations.

import { fireAndForget } from "@/util/util";
import { useEffect, useState } from "react";
import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import { cancelRun, createRun } from "./runactions";
import { defaultRunId, isTerminal, runStatusView } from "./runmodel";

const TONE_CLASS: Record<string, string> = {
    planning: "text-muted",
    review: "text-asking",
    running: "text-success",
    blocked: "text-error",
    done: "text-success",
    failed: "text-error",
    cancelled: "text-muted",
};

function StatusPill({ status }: { status: string }) {
    const { label, tone } = runStatusView(status);
    return (
        <span className={"inline-flex items-center gap-1.5 font-mono text-[9px] font-semibold uppercase tracking-[.08em] " + (TONE_CLASS[tone] ?? "text-muted")}>
            <span className="h-1.5 w-1.5 rounded-full bg-current" />
            {label}
        </span>
    );
}

export function RunsView({ model, channel, agents }: { model: AgentsViewModel; channel: Channel; agents: AgentVM[] }) {
    const runs = channel.runs ?? [];
    const [activeRunId, setActiveRunId] = useState<string | undefined>(() => defaultRunId(runs));
    const [draft, setDraft] = useState("");

    // when the channel changes or runs first arrive, land on the channel's default run
    useEffect(() => {
        if (!activeRunId || !runs.some((r) => r.id === activeRunId)) {
            setActiveRunId(defaultRunId(runs));
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [channel.oid, runs.length]);

    const run = runs.find((r) => r.id === activeRunId);

    const startRun = () => {
        const goal = draft.trim();
        if (!goal) {
            return;
        }
        setDraft("");
        fireAndForget(async () => {
            const created = await createRun(channel.oid, goal);
            setActiveRunId(created.id);
        });
    };

    return (
        <>
            {/* run tabs */}
            <div className="sc flex flex-none gap-2 overflow-x-auto border-b border-border bg-background px-[22px] py-2.5">
                {runs.map((r) => {
                    const { tone } = runStatusView(r.status);
                    return (
                        <button
                            key={r.id}
                            type="button"
                            onClick={() => setActiveRunId(r.id)}
                            className={
                                "flex max-w-[230px] flex-none items-center gap-2 rounded-[9px] border px-3 py-2 " +
                                (r.id === activeRunId ? "border-accent/50 bg-accentbg/40" : "border-edge-mid hover:border-edge-strong")
                            }
                        >
                            <span className={"h-[7px] w-[7px] flex-none rounded-full bg-current " + (TONE_CLASS[tone] ?? "text-muted")} />
                            <span className="truncate text-[12px] font-semibold text-primary">{r.goal}</span>
                        </button>
                    );
                })}
                <button
                    type="button"
                    onClick={() => setActiveRunId(undefined)}
                    className="flex-none rounded-[9px] border border-dashed border-edge-mid px-3 py-2 text-[12px] font-semibold text-muted hover:text-secondary"
                >
                    + New run
                </button>
            </div>

            <div className="sc min-h-0 flex-1 overflow-y-auto px-6 pb-3 pt-5">
                <div className="mx-auto max-w-[750px]">
                    {run ? (
                        <>
                            {/* run header */}
                            <div className="mb-4 flex items-start gap-3">
                                <div className="min-w-0 flex-1">
                                    <div className="mb-1.5">
                                        <StatusPill status={run.status} />
                                    </div>
                                    <div className="text-[19px] font-bold leading-tight tracking-[-0.01em] text-primary">{run.goal}</div>
                                </div>
                                <div className="flex flex-none gap-1.5">
                                    <button
                                        type="button"
                                        disabled={isTerminal(run.status)}
                                        onClick={() => {
                                            const goal = window.prompt("Steer the current worker:");
                                            if (goal) {
                                                // steer wiring lands in Task 7; placeholder no-op-safe guard
                                            }
                                        }}
                                        className="rounded-[8px] border border-edge-mid px-2.5 py-1.5 text-[11.5px] font-semibold text-secondary hover:border-edge-strong disabled:opacity-40"
                                    >
                                        Steer
                                    </button>
                                    <button
                                        type="button"
                                        disabled
                                        title="Pause is coming in a later piece"
                                        className="rounded-[8px] border border-edge-mid px-2.5 py-1.5 text-[11.5px] font-semibold text-secondary opacity-40"
                                    >
                                        Pause
                                    </button>
                                </div>
                            </div>

                            {/* phase rail placeholder — filled in Task 6 */}
                            <div className="rounded-[11px] border border-border bg-background px-4 py-3 text-[12px] text-muted">
                                {run.phases?.length ?? 0} phase(s) — pipeline renders here.
                            </div>

                            {!isTerminal(run.status) ? (
                                <button
                                    type="button"
                                    onClick={() => fireAndForget(() => cancelRun(channel.oid, run.id))}
                                    className="mt-4 rounded-[8px] border border-edge-mid px-3 py-1.5 text-[11.5px] font-semibold text-muted hover:border-error hover:text-error"
                                >
                                    Cancel run
                                </button>
                            ) : null}
                        </>
                    ) : (
                        <div className="mt-10 text-center text-[13px] text-muted">
                            {runs.length === 0 ? "No runs yet." : "Select a run above, or start a new one."} Give Jarvis a goal below to start one.
                        </div>
                    )}
                </div>
            </div>

            {/* start-run composer */}
            <div className="flex-none px-6 pb-4 pt-2">
                <div className="mx-auto max-w-[750px] rounded-[12px] border border-edge-mid bg-surface-raised px-3.5 py-3">
                    <input
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") {
                                startRun();
                            }
                        }}
                        placeholder="Give Jarvis a goal to start a run…"
                        className="w-full bg-transparent text-[13.5px] text-primary placeholder:text-muted focus:outline-none"
                    />
                    <div className="mt-2.5 flex items-center gap-2">
                        <span className="font-mono text-[10.5px] text-muted">playbook · Superpowers default</span>
                        <div className="flex-1" />
                        <button
                            type="button"
                            onClick={startRun}
                            className="rounded-[8px] bg-accent px-3.5 py-1.5 text-[12px] font-bold text-background hover:bg-accent/90"
                        >
                            Start run ⏎
                        </button>
                    </div>
                </div>
            </div>
        </>
    );
}
```

Note: `window.prompt` in Steer is a temporary stand-in kept compiling; Task 7 replaces it with real steer wiring. `agents` is passed now (unused until Task 6/7) — keep the prop so the signature is stable across tasks. Prefix with `void agents;` at the top of the component body if the linter flags an unused arg.

- [ ] **Step 2: Wire the Chat/Runs toggle in `channelssurface.tsx`**

Add imports:

```tsx
import { RunsView } from "./runssurface";
import { defaultView } from "./runmodel";
```

In `ChannelsSurface`, add view state after the existing `useState` hooks (near `const [draft, setDraft] = useState("")`):

```tsx
const [view, setView] = useState<"chat" | "runs">(() => defaultView(active));
useEffect(() => {
    setView(defaultView(active));
    // eslint-disable-next-line react-hooks/exhaustive-deps
}, [activeId]);
```

In the header row (the `<div>` that holds the `#`, channel name, and the tier toggle — currently around line 1052-1097), insert the Chat/Runs segmented control right after the channel name block and before `<div className="flex-1" />`:

```tsx
{active ? (
    <div className="ml-1.5 flex items-center gap-0.5 rounded-[9px] border border-edge-mid p-0.5">
        {(["chat", "runs"] as const).map((v) => (
            <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={
                    view === v
                        ? "rounded-[6px] bg-accentbg/40 px-3 py-1 text-[11.5px] font-bold text-accent-soft"
                        : "rounded-[6px] px-3 py-1 text-[11.5px] font-bold text-muted hover:text-secondary"
                }
            >
                {v === "chat" ? "Chat" : "Runs"}
            </button>
        ))}
    </div>
) : null}
```

Replace the message-stream `<div className="min-h-0 flex-1 overflow-y-auto …">…</div>` **and** the `<Composer .../>` below it with a conditional. Wrap the existing chat stream + Composer in `view === "chat"`, and render `<RunsView>` for `view === "runs"`:

```tsx
{view === "runs" && active ? (
    <RunsView model={model} channel={active} agents={agents} />
) : (
    <>
        {/* existing message-stream div (unchanged) */}
        {/* existing <Composer .../> (unchanged) */}
    </>
)}
```

(Keep the existing chat stream `<div>` and `<Composer>` verbatim inside the `<>...</>` — do not alter their internals.)

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: Visual verification (CDP)**

Dev app running. Then drive a run into being and screenshot:
Run: `node scripts/cdp-e2e-runs.mjs C:/Users/cktra/AppData/Local/Temp/claude/runs-ui-iso` — creates a channel + a run (leaves the channel after; re-run creates fresh). Then in the app select that channel, click **Runs**.
Run: `node scripts/cdp-shot.mjs C:/Users/cktra/AppData/Local/Temp/claude/scratch-runs-shell.png`
Expected: the Runs view shows the Chat/Runs toggle, a run tab with a status dot + goal, the run header with the status pill + goal + Steer/Pause, the phase-count placeholder, and the Start-run composer. Toggling back to **Chat** shows the unchanged chat timeline.

Alternatively, type a goal into the Start-run composer and press Enter; confirm a new run tab appears (proves `createRun` + WOS mirroring).

- [ ] **Step 5: Commit** (present for approval)

```bash
git add frontend/app/view/agents/runssurface.tsx frontend/app/view/agents/channelssurface.tsx
git commit -m "feat(runs): runs view shell + chat/runs toggle"
```

---

## Task 6: Phase rail — compact stepper + vertical rail (display)

Replaces the placeholder with the compact stepper and the vertical phase rail: per-phase node, name, state label, skill, artifact chip, the context-clear divider, and execute worker rows. Display only; interactive cards are Task 7.

**Files:**
- Modify: `frontend/app/view/agents/runssurface.tsx`

**Interfaces:**
- Consumes: `phaseStateView`, `phaseThread`, `currentPhaseIndex` from `./runmodel`; `WorkerRow`, `STATE_DOT` from `./channelsprimitives`; `WorkerState` from `./jarvisderive` (for the `WorkerRow` prop shape).
- Produces: internal `<PhaseRail>`, `<CompactStepper>` components (not exported).

- [ ] **Step 1: Add imports + helper to map an AgentVM to a WorkerState row**

At the top of `runssurface.tsx` add:

```tsx
import { STATE_DOT, WorkerRow } from "./channelsprimitives";
import type { WorkerState } from "./jarvisderive";
import { currentPhaseIndex, phaseStateView, phaseThread, phaseWorkers } from "./runmodel";
```

`WorkerRow` expects a `WorkerState` (`{ oref, name, state, task?, dispatchTask? }`). Add a small adapter near the top of the file (below `TONE_CLASS`):

```tsx
// adapt a live roster row to the WorkerRow shape (oref is the tab: form used by WorkerRow's open-jump)
function toWorkerState(a: AgentVM): WorkerState {
    return { oref: `tab:${a.id}`, name: a.name, state: a.state, task: a.task, dispatchTask: undefined };
}
```

Note: confirm `WorkerState`'s exact fields in `frontend/app/view/agents/jarvisderive.ts` and match them; `AgentVM.task` may be `string | undefined` — pass it through. If `WorkerState` has additional required fields, fill them from `a` (do not invent values).

- [ ] **Step 2: Add the CompactStepper + PhaseRail components**

Add above `RunsView`:

```tsx
const PHASE_TONE_CLASS: Record<string, string> = {
    pending: "text-muted",
    running: "text-success",
    blocked: "text-error",
    done: "text-success",
    failed: "text-error",
    skipped: "text-muted",
};

function CompactStepper({ run, expanded, onToggle }: { run: Run; expanded: boolean; onToggle: () => void }) {
    return (
        <div className="mb-4 flex items-center gap-3 rounded-[11px] border border-border bg-background px-3.5 py-2.5">
            <button type="button" onClick={onToggle} className="w-3.5 flex-none text-[11px] text-muted">
                {expanded ? "▾" : "▸"}
            </button>
            <span className="flex-none font-mono text-[9px] font-semibold uppercase tracking-[.1em] text-muted">Playbook</span>
            <div className="relative flex flex-1 justify-between">
                {(run.phases ?? []).map((p, i) => {
                    const v = phaseStateView(p.state);
                    return (
                        <div key={i} className="flex flex-1 flex-col items-center gap-1.5 text-center">
                            <div className={"flex h-[18px] w-[18px] flex-none items-center justify-center rounded-full border border-current font-mono text-[8px] font-bold " + (PHASE_TONE_CLASS[v.tone] ?? "text-muted")}>
                                {v.icon}
                            </div>
                            <span className="whitespace-nowrap text-[9px] font-semibold text-secondary">{p.kind}</span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function PhaseRail({ model, run, agents }: { model: AgentsViewModel; run: Run; agents: AgentVM[] }) {
    const phases = run.phases ?? [];
    return (
        <div>
            {phases.map((p, i) => {
                const v = phaseStateView(p.state);
                const thread = phaseThread(run, i, agents);
                const workers = phaseWorkers(p, agents);
                const notLast = i < phases.length - 1;
                return (
                    <div key={i}>
                        {thread.showBoundary ? (
                            <div className="my-2 flex items-center gap-3">
                                <div className="h-px flex-1 bg-[repeating-linear-gradient(90deg,var(--color-edge-mid)_0_5px,transparent_5px_10px)]" />
                                <span className="font-mono text-[9.5px] font-semibold text-muted">context cleared → fresh worker</span>
                                <div className="h-px flex-1 bg-[repeating-linear-gradient(90deg,var(--color-edge-mid)_0_5px,transparent_5px_10px)]" />
                            </div>
                        ) : null}
                        <div className="flex gap-4">
                            <div className="flex w-9 flex-none flex-col items-center">
                                <div className={"flex h-9 w-9 flex-none items-center justify-center rounded-[10px] border border-current font-mono text-[14px] font-bold " + (PHASE_TONE_CLASS[v.tone] ?? "text-muted")}>
                                    {v.icon}
                                </div>
                                {notLast ? <div className="my-1 min-h-[22px] w-0.5 flex-1 bg-edge-mid" /> : null}
                            </div>
                            <div className="min-w-0 flex-1 pb-4">
                                <div className="flex items-center gap-2">
                                    <span className="text-[14px] font-bold text-primary">{p.kind}</span>
                                    <span className={"font-mono text-[9px] font-semibold uppercase tracking-[.06em] " + (PHASE_TONE_CLASS[v.tone] ?? "text-muted")}>{v.label}</span>
                                </div>
                                {p.skill ? <div className="mt-0.5 font-mono text-[11px] text-muted">{p.skill}</div> : null}
                                {(p.artifacts ?? []).map((art) => (
                                    <div key={art} className="mt-2 inline-flex items-center gap-1.5 rounded-[7px] border border-border bg-background px-2.5 py-1">
                                        <span className="text-[11px] text-muted">▸</span>
                                        <span className="font-mono text-[11px] text-secondary">{art}</span>
                                    </div>
                                ))}
                                {thread.showWorkers ? (
                                    <div className="mt-2.5 flex flex-col gap-1.5">
                                        {workers.map((w) => (
                                            <WorkerRow key={w.id} model={model} w={toWorkerState(w)} />
                                        ))}
                                    </div>
                                ) : null}
                                {/* interactive cards (gate / ask / blocked / ship) added in Task 7 */}
                            </div>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
```

Note: `void STATE_DOT;` is not needed — remove the `STATE_DOT` import if `WorkerRow` already encapsulates it (it does; `STATE_DOT` was only imported speculatively). Import only what this file references: `WorkerRow`, `WorkerState`, and the runmodel functions.

- [ ] **Step 3: Render the stepper + rail in `RunsView`**

Add a collapse state near the other `useState`s in `RunsView`:

```tsx
const [expanded, setExpanded] = useState(true);
```

Replace the phase-rail placeholder `<div>` (the "…pipeline renders here." block) with:

```tsx
<CompactStepper run={run} expanded={expanded} onToggle={() => setExpanded((e) => !e)} />
{expanded ? <PhaseRail model={model} run={run} agents={agents} /> : null}
```

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 5: Visual verification (CDP)**

With a run present (from Task 5's harness or the composer), open the Runs view.
Run: `node scripts/cdp-shot.mjs C:/Users/cktra/AppData/Local/Temp/claude/scratch-runs-rail.png`
Expected: the compact stepper (collapsible) plus the vertical phase rail — three phases (brainstorm/plan/execute) with node icons, state labels, skill lines, artifact chips where present, the dashed "context cleared → fresh worker" divider before the execute phase once it's started, and worker rows under a running phase.

- [ ] **Step 6: Commit** (present for approval)

```bash
git add frontend/app/view/agents/runssurface.tsx
git commit -m "feat(runs): compact stepper + vertical phase rail"
```

---

## Task 7: Interactive cards — review gate, ask threading, blocked, ship, steer

Adds the human-decision surfaces: the review-gate card (approve/send-back), the threaded ask (AskRow, clarify/fork framing), the blocked card (take control / cancel), the ship marker, and real Steer wiring. Deferred controls (Edit-plan, Re-dispatch) render disabled with tooltips.

**Files:**
- Modify: `frontend/app/view/agents/runssurface.tsx`

**Interfaces:**
- Consumes: `AskRow`, `jumpToAgent` from `./channelsprimitives`; `approveGate`, `sendBackGate`, `cancelRun` from `./runactions`; `steerWorker` from `./channelactions`; `reviewGate` from `./runmodel`.
- Produces: internal `<ReviewGateCard>`, `<AskCard>`, `<BlockedCard>`, `<ShipMarker>`.

- [ ] **Step 1: Add imports**

```tsx
import { AskRow, jumpToAgent } from "./channelsprimitives";
import { steerWorker } from "./channelactions";
import { approveGate, cancelRun, createRun, sendBackGate } from "./runactions"; // extend the existing runactions import
import { currentPhaseIndex, defaultRunId, isTerminal, phaseStateView, phaseThread, phaseWorkers, reviewGate, runStatusView } from "./runmodel"; // extend existing runmodel import
```

- [ ] **Step 2: Add the card components (above `PhaseRail`)**

```tsx
function ReviewGateCard({ channelId, run, gateIdx }: { channelId: string; run: Run; gateIdx: number }) {
    const gatePhase = run.phases[gateIdx];
    const artifact = (gatePhase.artifacts ?? [])[0];
    return (
        <div className="mt-3 overflow-hidden rounded-[12px] border border-asking/40 bg-lane-asking">
            <div className="flex items-center gap-2 border-b border-asking/20 px-3.5 py-2.5">
                <span className="h-[7px] w-[7px] rounded-full bg-asking" />
                <span className="font-mono text-[9px] font-semibold uppercase tracking-[.1em] text-asking">Review gate</span>
                <span className="flex-1 text-[11.5px] text-ink-mid">approve before execution starts</span>
                {artifact ? <span className="font-mono text-[10.5px] text-muted">{artifact}</span> : null}
            </div>
            <div className="flex items-center gap-2.5 px-3.5 py-3">
                <button
                    type="button"
                    onClick={() => fireAndForget(() => approveGate(channelId, run.id, gateIdx))}
                    className="rounded-[8px] bg-accent px-4 py-2 text-[12px] font-bold text-background hover:bg-accent/90"
                >
                    Approve & execute
                </button>
                <button
                    type="button"
                    disabled
                    title="Edit plan is coming in a later piece"
                    className="rounded-[8px] border border-edge-mid px-3 py-2 text-[12px] font-semibold text-secondary opacity-40"
                >
                    Edit plan
                </button>
                <div className="flex-1" />
                <button
                    type="button"
                    onClick={() => fireAndForget(() => sendBackGate(channelId, run.id, gateIdx))}
                    className="rounded-[8px] border border-edge-mid px-3 py-2 text-[12px] font-semibold text-secondary hover:border-asking hover:text-asking"
                >
                    Send back
                </button>
            </div>
        </div>
    );
}

function AskCard({ model, agent, kind }: { model: AgentsViewModel; agent: AgentVM; kind: "clarify" | "fork" }) {
    return (
        <div className="mt-3">
            <div className="mb-1.5 flex items-center gap-2">
                <span className="h-[7px] w-[7px] rounded-full bg-asking" />
                <span className="font-mono text-[9px] font-semibold uppercase tracking-[.08em] text-asking">
                    {kind === "clarify" ? "Clarifying question" : "Escalated to you"}
                </span>
            </div>
            <AskRow model={model} agent={agent} />
        </div>
    );
}

function BlockedCard({ model, channelId, run, worker }: { model: AgentsViewModel; channelId: string; run: Run; worker?: AgentVM }) {
    return (
        <div className="relative mt-3 overflow-hidden rounded-[12px] border border-error/40 bg-lane-error px-4 py-3">
            <div className="mb-2 flex items-center gap-2">
                <span className="font-mono text-[12px] font-bold text-error">!</span>
                <span className="font-mono text-[9px] font-semibold uppercase tracking-[.08em] text-error">Blocked · worker exited</span>
            </div>
            <p className="mb-3 text-[12.5px] leading-[1.5] text-secondary">The worker for this phase is no longer running. Take control to inspect it, or cancel the run.</p>
            <div className="flex items-center gap-2">
                <button
                    type="button"
                    disabled
                    title="Re-dispatch is coming in a later piece"
                    className="rounded-[8px] border border-edge-mid px-3 py-2 text-[12px] font-semibold text-secondary opacity-40"
                >
                    Re-dispatch
                </button>
                {worker ? (
                    <button
                        type="button"
                        onClick={() => jumpToAgent(model, worker.id)}
                        className="rounded-[8px] border border-edge-mid px-3 py-2 text-[12px] font-semibold text-secondary hover:border-edge-strong"
                    >
                        Take control
                    </button>
                ) : null}
                <div className="flex-1" />
                <button
                    type="button"
                    onClick={() => fireAndForget(() => cancelRun(channelId, run.id))}
                    className="rounded-[8px] border border-edge-mid px-3 py-2 text-[12px] font-semibold text-muted hover:border-error hover:text-error"
                >
                    Cancel run
                </button>
            </div>
        </div>
    );
}

function ShipMarker() {
    return (
        <div className="mt-2 inline-flex items-center gap-2 rounded-[9px] border border-success/30 bg-success/10 px-3 py-2">
            <span className="text-[12px] text-success">✓</span>
            <span className="text-[12px] font-semibold text-secondary">Done · all phases complete</span>
        </div>
    );
}
```

Note: `bg-lane-error` / `text-error` / `border-error` — confirm these tokens exist in `tailwindsetup.css`; the escalation card uses `bg-lane-asking`/`text-asking`. If an `error`/`lane-error` token is absent, use the nearest existing danger token (search `--color-error` / `lane-` in `frontend/app/tailwindsetup.css`) and match it; do not introduce a new CSS variable in this piece.

- [ ] **Step 3: Render the cards in `PhaseRail`**

In `PhaseRail`, replace the `{/* interactive cards … */}` comment with:

```tsx
{thread.showGate ? <ReviewGateCard channelId={run.__channelId} run={run} gateIdx={i} /> : null}
{thread.showAsk && thread.askAgent && thread.askKind ? (
    <AskCard model={model} agent={thread.askAgent} kind={thread.askKind} />
) : null}
{thread.showBlocked ? <BlockedCard model={model} channelId={run.__channelId} run={run} worker={workers[0]} /> : null}
{thread.showShip ? <ShipMarker /> : null}
```

`PhaseRail` needs the channel id. Rather than smuggle it on `run`, thread it as a prop: change `PhaseRail`'s signature to `({ model, run, agents, channelId }: { model: AgentsViewModel; run: Run; agents: AgentVM[]; channelId: string })`, use `channelId` in the card props (drop the `run.__channelId` placeholder above — use `channelId`), and update the call site in `RunsView` to `<PhaseRail model={model} run={run} agents={agents} channelId={channel.oid} />`.

- [ ] **Step 4: Wire real Steer in the run header**

Replace the temporary `window.prompt` Steer button `onClick` in `RunsView` with a steer that targets the current phase's live worker:

```tsx
onClick={() => {
    const idx = currentPhaseIndex(run);
    const worker = phaseWorkers(run.phases[idx], agents)[0];
    if (!worker) {
        return;
    }
    const text = window.prompt(`Steer ${worker.name}:`);
    if (text) {
        fireAndForget(() => steerWorker({ channelId: channel.oid, workerORef: `tab:${worker.id}`, agents, text }));
    }
}}
```

(Keep `window.prompt` for the steer input this piece — a proper inline steer composer is out of scope; the existing chat Steer verb also uses a single-line input.)

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 6: Visual + interaction verification (CDP)**

Drive a run to the gate using the harness (it advances brainstorm→plan→gate), then work the gate in the UI:
- Run `node scripts/cdp-e2e-runs.mjs C:/Users/cktra/AppData/Local/Temp/claude/runs-ui-gate` to create a channel + run and advance it; note the channel id it prints.
- In the app, open that channel → Runs. Confirm the **Review gate** card renders under the plan phase with Approve & execute / Edit plan (disabled) / Send back.
- Click **Approve & execute**; confirm the run advances to `executing` (execute phase goes running, a worker row appears) — proves `approveGate`.
- Screenshot: `node scripts/cdp-shot.mjs C:/Users/cktra/AppData/Local/Temp/claude/scratch-runs-gate.png`.
- Cancel the run from the header/blocked control; confirm status → cancelled.

Since completion is hook-driven, use the harness's `advancerun complete` calls (already in `cdp-e2e-runs.mjs`) to move phases; the UI proves the *decision* actions (approve/send-back/cancel/steer).

- [ ] **Step 7: Commit** (present for approval)

```bash
git add frontend/app/view/agents/runssurface.tsx
git commit -m "feat(runs): review gate, ask threading, blocked + ship cards, steer"
```

---

## Self-Review

**Spec coverage:**
- Runs view (tabs, header, stepper, phase rail) → Tasks 5, 6, 7. ✓
- Chat⇄Runs toggle → Task 5. ✓
- Approve/Send-back (`AdvanceRun`), Cancel (`CancelRun`), Steer (`ControllerInputCommand` via `steerWorker`) → Tasks 5, 7. ✓
- Read runs off the channel object (WOS), workers off the roster → Tasks 3, 5. ✓
- Deferred controls disabled+tooltip (Pause, Edit-plan, Re-dispatch) → Tasks 5, 7. ✓
- `@jarvis` fanout + `planMessage` untouched → nothing in the plan modifies `channelmessages.ts` or the jarvis branch of `channelactions.ts`. ✓
- Hook-driven completion (UI never marks a phase done) → no "mark done" control anywhere; only approve/send-back/cancel/steer. ✓
- Extract shared primitives → Task 1. ✓
- Tests: `runmodel.test.ts` pure vitest; `channelmessages.test.ts` untouched; CDP live checks → Tasks 2, 3, 5, 6, 7. ✓
- Edge cases: legacy channels (`defaultView`→chat, empty state), gone worker (blocked), terminal read-only (`isTerminal` gates actions), channel switch reset (Task 5 effect), defensive render → covered across runmodel + runssurface. ✓

**Placeholder scan:** No "TBD"/"handle appropriately". The `window.prompt` steer input and the disabled deferred buttons are explicit, intentional, and documented as such. Two "confirm the token/field exists" notes (WorkerState fields in Task 6; error CSS tokens in Task 7) are verification instructions with concrete fallbacks, not deferred work.

**Type consistency:** `RunsView({model, channel, agents})` stable from Task 5; `PhaseRail` gains a `channelId` prop in Task 7 (call site updated same task). `phaseThread`/`phaseWorkers`/`reviewGate`/`currentPhaseIndex` signatures match Tasks 2–3. `createRun` returns `Run`; `approveGate`/`sendBackGate`/`cancelRun` return `Promise<void>` — consumed consistently. `toWorkerState` produces the `WorkerState` shape `WorkerRow` consumes.
