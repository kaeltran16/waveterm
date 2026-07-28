import { describe, expect, it } from "vitest";
import { buildRailNeeds } from "./railneeds";

// minimal shapes — only the fields buildNeeds / buildFleetSnapshot read.
const asking = (id: string, name: string, question: string): any => ({
    id,
    name,
    state: "asking",
    ask: { oref: "ask:" + id, questions: [{ question }] },
});

const channel = (oid: string, name: string, workerId: string): any => ({
    oid,
    name,
    runs: [{ id: "run-" + oid, goal: "goal " + oid, status: "executing", phases: [{ workerorefs: ["tab:" + workerId] }] }],
    messages: [{ id: "m-" + oid, kind: "dispatch", author: "claude", text: "task", reforef: "tab:" + workerId, ts: 1 }],
});

const scope = (channeloids: string[]): any => ({ channeloids, runorefs: [], tabids: [] });

describe("buildRailNeeds", () => {
    it("collects asks from every channel, not just the one on the Stage", () => {
        const out = buildRailNeeds({
            channels: [channel("c1", "checkout-revamp", "w1"), channel("c2", "coupon-abuse", "w2")],
            agents: [asking("w1", "impl-2", "where does the counter live?"), asking("w2", "probe-1", "which accounts?")],
            scope: null,
        });
        expect(out.map((n) => n.channelName)).toEqual(["checkout-revamp", "coupon-abuse"]);
        expect(out.map((n) => n.text)).toEqual(["where does the counter live?", "which accounts?"]);
    });

    it("keeps an ask from a channel outside the Space, tagged rather than dropped", () => {
        const out = buildRailNeeds({
            channels: [channel("c1", "checkout-revamp", "w1"), channel("c2", "coupon-abuse", "w2")],
            agents: [asking("w1", "impl-2", "q1"), asking("w2", "probe-1", "q2")],
            scope: scope(["c1"]),
        });
        expect(out).toHaveLength(2);
        expect(out.find((n) => n.channelId === "c1")?.outsideFocus).toBe(false);
        expect(out.find((n) => n.channelId === "c2")?.outsideFocus).toBe(true);
    });

    it("tags nothing outside focus when no Space is active", () => {
        const out = buildRailNeeds({
            channels: [channel("c1", "a", "w1")],
            agents: [asking("w1", "impl-2", "q")],
            scope: null,
        });
        expect(out.every((n) => !n.outsideFocus)).toBe(true);
    });

    it("keys per channel so the same run id in two channels cannot collide", () => {
        const out = buildRailNeeds({
            channels: [channel("c1", "a", "w1"), channel("c2", "b", "w2")],
            agents: [asking("w1", "impl-2", "q1"), asking("w2", "probe-1", "q2")],
            scope: null,
        });
        expect(new Set(out.map((n) => n.key)).size).toBe(out.length);
    });

    it("carries the owning run so a click can land on it", () => {
        const out = buildRailNeeds({
            channels: [channel("c1", "a", "w1")],
            agents: [asking("w1", "impl-2", "q")],
            scope: null,
        });
        expect(out[0].runId).toBe("run-c1");
        expect(out[0].channelId).toBe("c1");
    });

    it("returns [] for a null channel list", () => {
        expect(buildRailNeeds({ channels: null, agents: [], scope: null })).toEqual([]);
    });
});
