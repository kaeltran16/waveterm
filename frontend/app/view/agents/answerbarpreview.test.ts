import { describe, expect, it } from "vitest";
import type { AgentAskQuestion } from "./agentsviewmodel";
import { activePreview, previewBody, previewMode } from "./answerbarpreview";

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

describe("previewBody", () => {
    it("keeps an ASCII diagram's lines and spacing exactly", () => {
        const box = "+--------+\n|  box   |\n+--------+\n  (box)";
        expect(previewBody(box)).toBe(box);
    });
    it("keeps a dashed line under text, which markdown would read as a heading", () => {
        expect(previewBody("line\n----------")).toBe("line\n----------");
    });
    it("shows what is inside a code fence wrapping the whole preview, language tag or not", () => {
        expect(previewBody("```ts\nconst a = 1;\n  b();\n```")).toBe("const a = 1;\n  b();");
        expect(previewBody("```\n| x |\n```\n")).toBe("| x |");
    });
    it("unwraps a fence around nothing, and one whose fence lines carry spaces", () => {
        expect(previewBody("```\n```")).toBe("");
        expect(previewBody("  ```\ncode\n```")).toBe("code");
        expect(previewBody("```\ncode\n  ```")).toBe("code");
        expect(previewBody("```\ncode\n```  ")).toBe("code");
    });
    it("leaves a preview alone when its last line opens a fence of its own", () => {
        expect(previewBody("```\ncode\n```ts")).toBe("```\ncode\n```ts");
    });
    it("leaves a preview alone when a fence wraps only part of it", () => {
        const mixed = "intro\n```\ncode\n```";
        expect(previewBody(mixed)).toBe(mixed);
        const two = "```\na\n```\n```\nb\n```";
        expect(previewBody(two)).toBe(two);
    });
    it("drops trailing newlines only", () => {
        expect(previewBody("  a\n\n")).toBe("  a");
    });
});
