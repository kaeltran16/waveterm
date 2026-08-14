import { describe, expect, it } from "vitest";
import { orefNavPlan } from "./openref";

describe("orefNavPlan", () => {
    it("routes channel/run/task/agent to their kinds", () => {
        expect(orefNavPlan("channel:abc")).toEqual({ kind: "channel", oid: "abc" });
        // a record became routable when it became a subject on the merged Stage
        expect(orefNavPlan("task:TASK-418")).toEqual({ kind: "task", oid: "TASK-418" });
        expect(orefNavPlan("run:11111111-1111-1111-1111-111111111111")).toEqual({
            kind: "run",
            oid: "11111111-1111-1111-1111-111111111111",
        });
        expect(orefNavPlan("agent:a1")).toEqual({ kind: "agent", oid: "a1" });
        // an effort address opens the briefing with that effort expanded
        expect(orefNavPlan("effort:eff-1")).toEqual({ kind: "effort", oid: "eff-1" });
    });
    it("marks types with no clean focus path as unsupported (no throw)", () => {
        for (const ot of ["memory", "radar", "decision", "commit", "session"]) {
            expect(orefNavPlan(`${ot}:x`)).toEqual({ kind: "unsupported", otype: ot });
        }
    });
    it("is total on malformed input (never throws)", () => {
        expect(orefNavPlan("").kind).toBe("unsupported");
        expect(orefNavPlan("nope").kind).toBe("unsupported");
        expect(orefNavPlan("run:").kind).toBe("unsupported");
        expect(orefNavPlan(":x").kind).toBe("unsupported");
    });
});

describe("volunteered-knowledge routes", () => {
    it("classifies a memory note address", () => {
        expect(orefNavPlan("memnote:mem-abc123")).toEqual({ kind: "memnote", oid: "mem-abc123" });
    });

    it("still classifies the existing routes", () => {
        expect(orefNavPlan("task:task-a").kind).toBe("task");
        expect(orefNavPlan("run:run-9").kind).toBe("run");
        expect(orefNavPlan("channel:c1").kind).toBe("channel");
    });

    // a decision stays unroutable on purpose: it is rendered inside its parent record's thread, so the
    // backend addresses that record and passes the decision id as an anchor instead.
    it("leaves a bare decision address unsupported", () => {
        expect(orefNavPlan("decision:dec-abc123").kind).toBe("unsupported");
    });

    it("treats a malformed address as unsupported rather than throwing", () => {
        expect(orefNavPlan("memnote:").kind).toBe("unsupported");
        expect(orefNavPlan("").kind).toBe("unsupported");
        expect(orefNavPlan("decision").kind).toBe("unsupported");
    });
});
