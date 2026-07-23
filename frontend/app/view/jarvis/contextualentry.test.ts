import { describe, expect, it } from "vitest";
import { attachedScope, sourceRefForMemory, sourceRefForRadar, sourceRefForRun } from "./contextualentry";

describe("contextual-entry SourceRef builders", () => {
    it("builds a run SourceRef from id + goal", () => {
        const ref = sourceRefForRun({ id: "r1", goal: "ship the thing" } as any);
        expect(ref).toEqual({ oref: "run:r1", sourceType: "run", title: "ship the thing" });
    });
    it("builds a radar SourceRef as radar:<finding.id>", () => {
        const ref = sourceRefForRadar({ id: "f9", risk: "retry storm" } as any);
        expect(ref).toEqual({ oref: "radar:f9", sourceType: "radar", title: "retry storm" });
    });
    it("builds a memory SourceRef as memory:<note.id>", () => {
        const ref = sourceRefForMemory({ id: "m3", title: "worktree gotcha" } as any);
        expect(ref).toEqual({ oref: "memory:m3", sourceType: "memory", title: "worktree gotcha" });
    });
    it("wraps a ref in an attached scope with an active chip", () => {
        const ref = sourceRefForRun({ id: "r1", goal: "g" } as any);
        const scope = attachedScope(ref);
        expect(scope.mode).toBe("attached");
        expect(scope.attached).toEqual([ref]);
        expect(scope.chips.some((c) => c.active)).toBe(true);
    });
});
