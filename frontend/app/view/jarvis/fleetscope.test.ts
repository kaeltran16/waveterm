import { describe, expect, it } from "vitest";
import type { AgentVM } from "@/app/view/agents/agentsviewmodel";
import { fleetForRecord } from "./fleetscope";

function agent(id: string, state: AgentVM["state"]): AgentVM {
    return { id, name: id, state } as unknown as AgentVM;
}

// a channel whose dispatch message points at the worker tab, which is what buildFleetSnapshot resolves.
function channel(oid: string, runIds: string[], workerIds: string[]): Channel {
    return {
        oid,
        name: oid,
        runs: runIds.map((id) => ({ id })),
        messages: workerIds.map((w, i) => ({
            id: `m${i}`,
            kind: "dispatch",
            reforef: `tab:${w}`,
            text: "do a thing",
        })),
    } as unknown as Channel;
}

describe("fleetForRecord", () => {
    it("returns no workers and no channels when the record has no attributed runs", () => {
        const out = fleetForRecord({
            channels: [channel("c1", ["r1"], ["w1"])],
            agents: [agent("w1", "working")],
            attributedRunORefs: [],
        });
        expect(out).toEqual({ workers: [], channelCount: 0 });
    });

    it("counts only the channels that own an attributed run", () => {
        const out = fleetForRecord({
            channels: [channel("c1", ["r1"], ["w1"]), channel("c2", ["r9"], ["w9"])],
            agents: [agent("w1", "working"), agent("w9", "working")],
            attributedRunORefs: ["run:r1"],
        });
        expect(out.channelCount).toBe(1);
        expect(out.workers.map((w) => w.oref)).toEqual(["tab:w1"]);
    });

    it("rolls up workers across several channels", () => {
        const out = fleetForRecord({
            channels: [channel("c1", ["r1"], ["w1"]), channel("c2", ["r2"], ["w2"])],
            agents: [agent("w1", "working"), agent("w2", "asking")],
            attributedRunORefs: ["run:r1", "run:r2"],
        });
        expect(out.channelCount).toBe(2);
        expect(out.workers.map((w) => w.oref).sort()).toEqual(["tab:w1", "tab:w2"]);
    });

    it("dedups a worker reachable through two channels", () => {
        const out = fleetForRecord({
            channels: [channel("c1", ["r1"], ["w1"]), channel("c2", ["r2"], ["w1"])],
            agents: [agent("w1", "working")],
            attributedRunORefs: ["run:r1", "run:r2"],
        });
        expect(out.workers).toHaveLength(1);
        expect(out.channelCount).toBe(2);
    });

    it("tolerates a channel with no runs", () => {
        const out = fleetForRecord({
            channels: [channel("c1", [], ["w1"])],
            agents: [agent("w1", "working")],
            attributedRunORefs: ["run:r1"],
        });
        expect(out).toEqual({ workers: [], channelCount: 0 });
    });
});
