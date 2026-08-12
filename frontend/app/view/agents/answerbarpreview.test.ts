import { describe, expect, it } from "vitest";
import type { AgentAskQuestion } from "./agentsviewmodel";
import { activePreview, previewMode } from "./answerbarpreview";

const q = (over: Partial<AgentAskQuestion> = {}): AgentAskQuestion => ({
    question: "Q?",
    options: [{ label: "A", preview: "mockup A" }, { label: "B" }],
    ...over,
});

describe("previewMode", () => {
    it("is true when any single-select option has a preview", () => {
        expect(previewMode(q())).toBe(true);
    });
    it("is false for multi-select questions (rpiv rule)", () => {
        expect(previewMode(q({ multiSelect: true }))).toBe(false);
    });
    it("is false when no option has a preview", () => {
        expect(previewMode(q({ options: [{ label: "A" }, { label: "B" }] }))).toBe(false);
    });
    it("is false when there are no options", () => {
        expect(previewMode(q({ options: [] }))).toBe(false);
    });
});

describe("activePreview", () => {
    it("returns the focused option's preview", () => {
        expect(activePreview(q(), 0)).toBe("mockup A");
    });
    it("returns undefined when the focused option has none", () => {
        expect(activePreview(q(), 1)).toBeUndefined();
    });
    it("clamps out-of-range focus to the first option", () => {
        expect(activePreview(q(), 99)).toBe("mockup A");
    });
    it("returns undefined when no option has a preview", () => {
        expect(activePreview(q({ options: [{ label: "A" }] }), 0)).toBeUndefined();
    });
});
