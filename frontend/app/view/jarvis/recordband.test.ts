import type { AmbientTag } from "@/app/view/agents/ambient";
import { describe, expect, it } from "vitest";
import { bandGlyph, edgeLabel, edgeLineStyle, recordBandCase, recordPickerMatches } from "./recordband";

function tag(taskId: string, state: string, bucket: string): AmbientTag {
    return { taskId, label: taskId.toUpperCase(), state, bucket };
}

describe("recordBandCase", () => {
    it("states the absence when a run has no attributed record", () => {
        expect(recordBandCase({ tags: [] })).toEqual({ case: "none" });
    });

    it("returns the single edge when there is exactly one", () => {
        const t = tag("task-418", "confirmed", "strong");
        expect(recordBandCase({ tags: [t] })).toEqual({ case: "one", edge: t });
    });

    it("promotes the strongest edge to primary and keeps the rest as others", () => {
        const weak = tag("task-377", "informing", "weak");
        const strong = tag("task-418", "confirmed", "strong");
        const medium = tag("task-402", "informing", "medium");
        const band = recordBandCase({ tags: [weak, strong, medium] });
        expect(band).toMatchObject({ case: "several" });
        if (band.case !== "several") throw new Error("expected several");
        expect(band.primary.taskId).toBe("task-418");
        expect(band.others.map((o) => o.taskId)).toEqual(["task-402", "task-377"]);
    });

    it("prefers a confirmed edge over an informing one of the same bucket", () => {
        const informing = tag("task-a", "informing", "strong");
        const confirmed = tag("task-b", "confirmed", "strong");
        const band = recordBandCase({ tags: [informing, confirmed] });
        if (band.case !== "several") throw new Error("expected several");
        expect(band.primary.taskId).toBe("task-b");
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
    it("says confirmed with no bucket: a confirmed link has no confidence to show", () => {
        expect(edgeLabel(tag("t", "confirmed", "strong"))).toBe("confirmed");
        expect(edgeLabel(tag("t", "confirmed", "weak"))).toBe("confirmed");
    });

    it("words a guessed link's confidence for a person, never with the engine's names", () => {
        expect(edgeLabel(tag("t", "informing", "strong"))).toBe("guessed · strong");
        expect(edgeLabel(tag("t", "informing", "medium"))).toBe("guessed · likely");
        expect(edgeLabel(tag("t", "informing", "weak"))).toBe("guessed · weak");
    });

    it("never reads an unknown state or bucket as stronger than weak", () => {
        expect(edgeLabel(tag("t", "informing", "bogus"))).toBe("guessed · weak");
        expect(edgeLabel(tag("t", "mystery", "medium"))).toBe("guessed · likely");
    });
});

describe("bandGlyph", () => {
    it("marks only a guessed shown edge", () => {
        expect(bandGlyph({ case: "one", edge: tag("t", "confirmed", "strong") })).toBe(false);
        expect(bandGlyph({ case: "one", edge: tag("t", "informing", "strong") })).toBe(true);
    });

    it("reads the primary of several, not the others", () => {
        const confirmed = tag("a", "confirmed", "strong");
        const guessed = tag("b", "informing", "weak");
        expect(bandGlyph({ case: "several", primary: confirmed, others: [guessed] })).toBe(false);
        expect(bandGlyph({ case: "several", primary: guessed, others: [confirmed] })).toBe(true);
    });

    it("draws nothing on a band with no edge", () => {
        expect(bandGlyph({ case: "none" })).toBe(false);
    });
});

describe("recordPickerMatches", () => {
    const records = [
        { id: "ship-the-record-band", objective: "Ship the record band", ticket: "PROJ-1739" },
        { id: "fix-the-picker", objective: "Fix the picker rows" },
        { id: "tidy-ambient-tags", objective: "Tidy ambient tags", ticket: "" },
    ];

    it("finds a record by its ticket", () => {
        expect(recordPickerMatches(records, "1739", 8).map((r) => r.id)).toEqual(["ship-the-record-band"]);
    });

    it("finds a record by a fragment of its id", () => {
        expect(recordPickerMatches(records, "ambient-t", 8).map((r) => r.id)).toEqual(["tidy-ambient-tags"]);
    });

    it("matches the objective ignoring case and surrounding space", () => {
        expect(recordPickerMatches(records, "  PICKER ", 8).map((r) => r.id)).toEqual(["fix-the-picker"]);
    });

    it("lists everything for an empty query, capped at max", () => {
        expect(recordPickerMatches(records, "", 8)).toHaveLength(3);
        expect(recordPickerMatches(records, "", 2).map((r) => r.id)).toEqual([
            "ship-the-record-band",
            "fix-the-picker",
        ]);
        expect(recordPickerMatches(records, "the", 1)).toHaveLength(1);
    });
});
