import type { AmbientTag } from "@/app/view/agents/ambient";
import { describe, expect, it } from "vitest";
import { edgeLabel, edgeLineStyle, recordBandCase } from "./recordband";

function tag(taskId: string, state: string, bucket: string): AmbientTag {
    return { taskId, label: taskId.toUpperCase(), state, bucket };
}

describe("recordBandCase", () => {
    it("states the absence when a run has no attributed record", () => {
        expect(recordBandCase({ kind: "channel", tags: [] })).toEqual({ case: "none" });
    });

    it("returns the single edge when there is exactly one", () => {
        const t = tag("task-418", "confirmed", "strong");
        expect(recordBandCase({ kind: "channel", tags: [t] })).toEqual({ case: "one", edge: t });
    });

    it("promotes the strongest edge to primary and keeps the rest as others", () => {
        const weak = tag("task-377", "informing", "weak");
        const strong = tag("task-418", "confirmed", "strong");
        const medium = tag("task-402", "informing", "medium");
        const band = recordBandCase({ kind: "channel", tags: [weak, strong, medium] });
        expect(band).toMatchObject({ case: "several" });
        if (band.case !== "several") throw new Error("expected several");
        expect(band.primary.taskId).toBe("task-418");
        expect(band.others.map((o) => o.taskId)).toEqual(["task-402", "task-377"]);
    });

    it("prefers a confirmed edge over an informing one of the same bucket", () => {
        const informing = tag("task-a", "informing", "strong");
        const confirmed = tag("task-b", "confirmed", "strong");
        const band = recordBandCase({ kind: "channel", tags: [informing, confirmed] });
        if (band.case !== "several") throw new Error("expected several");
        expect(band.primary.taskId).toBe("task-b");
    });

    it("makes a dossier subject its own band, ignoring any tags", () => {
        expect(recordBandCase({ kind: "dossier", tags: [tag("x", "confirmed", "strong")] })).toEqual({
            case: "subject",
        });
    });
});

describe("edgeLineStyle", () => {
    it("draws a strong edge solid and heaviest", () => {
        expect(edgeLineStyle(tag("t", "confirmed", "strong"))).toEqual({ style: "solid", weightPx: 2.5 });
    });

    it("draws medium dashed and weak dotted so strength is legible without colour", () => {
        expect(edgeLineStyle(tag("t", "informing", "medium"))).toEqual({ style: "dashed", weightPx: 1.5 });
        expect(edgeLineStyle(tag("t", "informing", "weak"))).toEqual({ style: "dotted", weightPx: 1 });
    });

    it("falls back to the weakest treatment for an unknown bucket rather than overstating it", () => {
        expect(edgeLineStyle(tag("t", "informing", "nonsense"))).toEqual({ style: "dotted", weightPx: 1 });
    });

    it("hands back a fresh object so one caller's tweak cannot corrupt every later edge", () => {
        edgeLineStyle(tag("t", "confirmed", "strong")).weightPx = 99;
        expect(edgeLineStyle(tag("t", "confirmed", "strong"))).toEqual({ style: "solid", weightPx: 2.5 });
    });
});

describe("edgeLabel", () => {
    it("names both the state and the confidence", () => {
        expect(edgeLabel(tag("t", "confirmed", "strong"))).toBe("confirmed · strong");
        expect(edgeLabel(tag("t", "informing", "weak"))).toBe("informing · weak");
    });
});
