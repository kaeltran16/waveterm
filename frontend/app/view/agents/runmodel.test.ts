import { describe, expect, it } from "vitest";
import type { AgentVM } from "./agentsviewmodel";
import {
    composerSummary,
    currentPhaseIndex,
    defaultRunId,
    defaultView,
    isOrchestrator,
    isTerminal,
    leadWorker,
    liveWorkers,
    phaseStateView,
    phaseProgressDots,
    phaseRailIds,
    phaseThread,
    phaseWorkers,
    planDirty,
    resolveActiveRunId,
    resolveArtifactPath,
    reviewGate,
    runStatusView,
    steerTarget,
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

function agent(over: Partial<AgentVM> = {}): AgentVM {
    return { id: "t1", name: "claude", state: "working", ...over } as AgentVM;
    // note: cast — AgentVM has many fields; tests only touch id/name/state/ask
}

describe("phaseWorkers", () => {
    it("resolves tab: orefs to live roster rows, dropping missing ones", () => {
        const p: RunPhase = { kind: "execute", state: "running", workerorefs: ["tab:t1", "tab:gone"] };
        const agents = [agent({ id: "t1" })];
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
        const agents = [agent({ id: "t1", state: "asking" })];
        const t = phaseThread(run, 0, agents);
        expect(t.showAsk).toBe(true);
        expect(t.askKind).toBe("fork");
        expect(t.askAgent?.id).toBe("t1");
        expect(t.showWorkers).toBe(false); // suppressed while asking
    });
    it("labels a brainstorm-phase ask as clarify", () => {
        const run = base({ phases: [{ kind: "brainstorm", state: "running", workerorefs: ["tab:t1"] }] });
        const agents = [agent({ id: "t1", state: "asking" })];
        expect(phaseThread(run, 0, agents).askKind).toBe("clarify");
    });
    it("shows execute worker rows when running and not asking", () => {
        const run = base({ phases: [{ kind: "execute", state: "running", workerorefs: ["tab:t1"] }] });
        const agents = [agent({ id: "t1", state: "working" })];
        const t = phaseThread(run, 0, agents);
        expect(t.showWorkers).toBe(true);
        expect(t.showAsk).toBe(false);
    });
    it("shows the context-clear boundary for a started freshctx phase", () => {
        const run = base({ phases: [{ kind: "execute", state: "running", freshctx: true, workerorefs: ["tab:t1"] }] });
        expect(phaseThread(run, 0, [agent({ id: "t1" })]).showBoundary).toBe(true);
    });
    it("does not show the boundary for a pending freshctx phase", () => {
        const run = base({ phases: [{ kind: "execute", state: "pending", freshctx: true }] });
        expect(phaseThread(run, 0, []).showBoundary).toBe(false);
    });
    it("shows blocked when a running phase's recorded worker is gone", () => {
        const run = base({ phases: [{ kind: "execute", state: "running", workerorefs: ["tab:gone"] }] });
        expect(phaseThread(run, 0, []).showBlocked).toBe(true);
    });
    it("shows starting (not blocked) while a recorded worker's tab exists but has not reported status", () => {
        const run = base({ phases: [{ kind: "execute", state: "running", workerorefs: ["tab:t1"] }] });
        // t1 is a live session (spawned tab) but not yet in the status-bearing roster
        const t = phaseThread(run, 0, [], new Set(["t1"]));
        expect(t.showStarting).toBe(true);
        expect(t.showBlocked).toBe(false);
    });
    it("shows blocked (not starting) when the recorded worker's tab no longer exists", () => {
        const run = base({ phases: [{ kind: "execute", state: "running", workerorefs: ["tab:t1"] }] });
        const t = phaseThread(run, 0, [], new Set());
        expect(t.showBlocked).toBe(true);
        expect(t.showStarting).toBe(false);
    });
    it("prefers the live worker over starting once it reports status", () => {
        const run = base({ phases: [{ kind: "execute", state: "running", workerorefs: ["tab:t1"] }] });
        const t = phaseThread(run, 0, [agent({ id: "t1", state: "working" })], new Set(["t1"]));
        expect(t.showWorkers).toBe(true);
        expect(t.showStarting).toBe(false);
        expect(t.showBlocked).toBe(false);
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

describe("resolveActiveRunId", () => {
    it("keeps the current id when still visible", () => {
        expect(resolveActiveRunId([run({ id: "a" }), run({ id: "b" })], "b")).toBe("b");
    });
    it("falls back to the default when the current id is gone", () => {
        expect(resolveActiveRunId([run({ id: "a", createdts: 5, status: "executing" })], "b")).toBe("a");
    });
    it("returns undefined when nothing is visible", () => {
        expect(resolveActiveRunId([], "b")).toBeUndefined();
    });
});

describe("phaseProgressDots", () => {
    it("maps each phase to its tone in order", () => {
        const r = run({ phases: [phase({ state: "done" }), phase({ state: "running" }), phase({ state: "pending" })] });
        expect(phaseProgressDots(r)).toEqual(["done", "running", "pending"]);
    });
    it("is empty for a run with no phases", () => {
        expect(phaseProgressDots(run({ phases: [] }))).toEqual([]);
    });
});

describe("phaseRailIds", () => {
    it("returns one stable id per phase", () => {
        expect(phaseRailIds(run({ phases: [phase(), phase(), phase()] }))).toEqual(["p0", "p1", "p2"]);
    });
    it("is empty for no phases", () => {
        expect(phaseRailIds(run({ phases: [] }))).toEqual([]);
    });
});

describe("leadWorker", () => {
    it("returns the first worker of the current phase", () => {
        const r = run({
            status: "executing",
            phases: [phase({ state: "running", workerorefs: ["tab:t1"] })],
        });
        expect(leadWorker(r, [agent({ id: "t1" })])?.id).toBe("t1");
    });
    it("returns undefined when the current phase has no live worker", () => {
        const r = run({ status: "executing", phases: [phase({ state: "running" })] });
        expect(leadWorker(r, [])).toBeUndefined();
    });
    it("still resolves the lead on a terminal run (not terminal-gated)", () => {
        const r = run({
            status: "done",
            phases: [phase({ state: "done", workerorefs: ["tab:t1"] })],
        });
        expect(leadWorker(r, [agent({ id: "t1" })])?.id).toBe("t1");
    });
});

describe("steerTarget (regression after refactor)", () => {
    it("returns undefined on a terminal run even though a worker exists", () => {
        const r = run({
            status: "done",
            phases: [phase({ state: "done", workerorefs: ["tab:t1"] })],
        });
        expect(steerTarget(r, [agent({ id: "t1" })])).toBeUndefined();
    });
    it("returns the current phase worker on a live run", () => {
        const r = run({
            status: "executing",
            phases: [phase({ state: "running", workerorefs: ["tab:t1"] })],
        });
        expect(steerTarget(r, [agent({ id: "t1" })])?.id).toBe("t1");
    });
});

describe("planDirty", () => {
    it("is false when edited equals saved", () => {
        expect(planDirty("abc", "abc")).toBe(false);
    });
    it("is true when edited differs from saved", () => {
        expect(planDirty("abc x", "abc")).toBe(true);
    });
});

describe("resolveArtifactPath", () => {
    it("passes an absolute POSIX artifact through", () => {
        expect(resolveArtifactPath("/home/proj", "/etc/plan.md")).toBe("/etc/plan.md");
    });
    it("passes an absolute Windows artifact through", () => {
        expect(resolveArtifactPath("C:\\proj", "D:\\plans\\plan.md")).toBe("D:\\plans\\plan.md");
    });
    it("joins a relative artifact under the project path", () => {
        expect(resolveArtifactPath("/home/proj", "docs/plan.md")).toBe("/home/proj/docs/plan.md");
    });
    it("collapses a trailing separator on the base to a single join separator", () => {
        expect(resolveArtifactPath("/home/proj/", "docs/plan.md")).toBe("/home/proj/docs/plan.md");
    });
    it("joins under a Windows project path (mixed separators read fine)", () => {
        expect(resolveArtifactPath("C:\\proj", "docs/plan.md")).toBe("C:\\proj/docs/plan.md");
    });
});

describe("liveWorkers", () => {
    it("returns recorded workers whose roster row is not idle, deduped across phases", () => {
        const r = run({
            phases: [
                { kind: "plan", state: "done", workerorefs: ["tab:a"] },
                { kind: "execute", state: "running", workerorefs: ["tab:b", "tab:c"] },
                { kind: "custom", state: "running", workerorefs: ["tab:b"] }, // b recurs → must dedup, not repeat
            ],
        });
        const agents = [
            agent({ id: "a", state: "idle" }),
            agent({ id: "b", state: "working" }),
            agent({ id: "c", state: "asking" }),
        ];
        expect(liveWorkers(r, agents).map((w) => w.id)).toEqual(["b", "c"]);
    });
    it("is empty when every recorded worker is idle or gone (blocked · worker exited)", () => {
        const r = run({ phases: [{ kind: "execute", state: "running", workerorefs: ["tab:a", "tab:gone"] }] });
        expect(liveWorkers(r, [agent({ id: "a", state: "idle" })])).toEqual([]);
    });
});

describe("orchestrator derivations", () => {
    function orchHeldRun(): Run {
        return {
            id: "r1", goal: "g", mode: "orchestrator", status: "awaiting-review",
            phases: [{ kind: "orchestrate", state: "running", gate: true, held: true }],
            createdts: 1, workspaceid: "w", projectpath: "/p",
        } as unknown as Run;
    }

    it("reviewGate matches a held orchestrator phase", () => {
        expect(reviewGate(orchHeldRun())).toEqual({ phaseIdx: 0 });
    });

    it("isOrchestrator reads the mode", () => {
        expect(isOrchestrator(orchHeldRun())).toBe(true);
        expect(isOrchestrator({ mode: "pipeline" } as unknown as Run)).toBe(false);
        expect(isOrchestrator({} as unknown as Run)).toBe(false);
    });

    it("composerSummary describes mode + gate", () => {
        expect(composerSummary("orchestrator", true)).toBe("orchestrator · plan gate on");
        expect(composerSummary("orchestrator", false)).toBe("orchestrator · adaptive");
        expect(composerSummary("pipeline", true)).toBe("pipeline · Superpowers default");
    });
});
