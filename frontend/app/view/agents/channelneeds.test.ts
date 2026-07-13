import { describe, expect, it } from "vitest";
import { buildNeeds } from "./channelneeds";

// minimal shapes — only the fields buildNeeds reads. gateOpen produces a run that reviewGate() treats
// as genuinely gated: status "awaiting-review" with a held running phase (see runmodel.reviewGate).
const run = (id: string, goal: string, workerOref?: string, gateOpen = false): any => ({
    id,
    goal,
    status: gateOpen ? "awaiting-review" : "executing",
    phases: gateOpen
        ? [{ state: "running", held: true }]
        : workerOref
          ? [{ workerorefs: [workerOref] }]
          : [],
});

describe("buildNeeds", () => {
    it("returns [] when nothing needs attention", () => {
        expect(buildNeeds({ runs: [], messages: [], agents: [], snapshot: [] })).toEqual([]);
    });

    it("emits gate items first, then escalations, then asks", () => {
        const runs = [run("r1", "fix flake", undefined, true)];
        const out = buildNeeds({ runs, messages: [], agents: [], snapshot: [] });
        expect(out[0].kind).toBe("review gate");
        expect(out[0].runId).toBe("r1");
        expect(out[0].action).toBe("Review");
    });

    it("resolves an ask's owning run via workerorefs", () => {
        const runs = [run("r2", "do thing", "tab:w1")];
        const snapshot = [{ oref: "tab:w1", name: "worker-1", state: "asking", askText: "which db?" }] as any;
        const messages: any[] = [];
        const out = buildNeeds({ runs, messages, agents: [], snapshot });
        const ask = out.find((n) => n.kind === "worker ask");
        expect(ask?.source).toBe("worker-1");
        expect(ask?.text).toBe("which db?");
        expect(ask?.runId).toBe("r2");
    });
});
