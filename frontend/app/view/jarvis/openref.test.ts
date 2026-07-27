import { describe, expect, it } from "vitest";
import { orefNavPlan } from "./openref";

describe("orefNavPlan", () => {
    it("routes channel/run/agent to their kinds", () => {
        expect(orefNavPlan("channel:abc")).toEqual({ kind: "channel", oid: "abc" });
        expect(orefNavPlan("run:11111111-1111-1111-1111-111111111111")).toEqual({
            kind: "run",
            oid: "11111111-1111-1111-1111-111111111111",
        });
        expect(orefNavPlan("agent:a1")).toEqual({ kind: "agent", oid: "a1" });
    });
    it("marks types with no clean focus path as unsupported (no throw)", () => {
        for (const ot of ["memory", "radar", "decision", "commit", "task", "session"]) {
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
