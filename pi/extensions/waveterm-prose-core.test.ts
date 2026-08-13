import { describe, expect, it } from "vitest";
import { detectProseQuestion } from "./waveterm-prose-core";

describe("detectProseQuestion", () => {
    it("returns null for a settled turn with no question", () => {
        expect(detectProseQuestion("The build failed because X.\n\nAll done.")).toBeNull();
    });

    it("returns null when the last paragraph does not end with a question mark", () => {
        expect(detectProseQuestion("Should I try X? Anyway, all done.")).toBeNull();
    });

    it("detects a plain trailing question with no options", () => {
        const r = detectProseQuestion("The build failed because X.\n\nDoes A sound right, or do you want B/C?");
        expect(r?.question).toBe("Does A sound right, or do you want B/C?");
        expect(r?.options).toBeUndefined();
    });

    it("extracts Approach-style option paragraphs into chips", () => {
        const text = [
            "Approach A: Backend default for agent-session blocks.",
            "Approach B: Launcher-side opt-in.",
            "Approach C: A plus background retention sweep.",
            "",
            "Does A sound right, or do you want B/C?",
        ].join("\n");
        const r = detectProseQuestion(text);
        expect(r?.question).toBe("Does A sound right, or do you want B/C?");
        expect(r?.options).toEqual([
            { label: "Approach A", description: "Backend default for agent-session blocks." },
            { label: "Approach B", description: "Launcher-side opt-in." },
            { label: "Approach C", description: "A plus background retention sweep." },
        ]);
    });

    it("extracts A)-style list lines into chips", () => {
        const text = "A) red\nB) green\nC) blue\n\nWhich one?";
        const r = detectProseQuestion(text);
        expect(r?.question).toBe("Which one?");
        expect(r?.options).toEqual([
            { label: "A", description: "red" },
            { label: "B", description: "green" },
            { label: "C", description: "blue" },
        ]);
    });

    it("extracts dash bullets into chips", () => {
        const text = "- red\n- green\n\nPick one?";
        const r = detectProseQuestion(text);
        expect(r?.options).toEqual([{ label: "red" }, { label: "green" }]);
    });

    it("returns no chips for a single option", () => {
        const r = detectProseQuestion("A) only one\n\nQuestion?");
        expect(r?.question).toBe("Question?");
        expect(r?.options).toBeUndefined();
    });

    it("caps options at 4", () => {
        const lines = ["A) one", "B) two", "C) three", "D) four", "E) five", "", "Which?"];
        expect(detectProseQuestion(lines.join("\n"))?.options).toHaveLength(4);
    });

    it("ignores list-like lines inside fenced code blocks", () => {
        // The fence precedes the question: the v1 rule only scans the last paragraph for the
        // question itself, so a TRAILING fence would null the whole detection (pinned
        // limitation, next test). The point here is the option guard: fence bullets must not
        // become chips.
        const text = ["```", "- fake option A", "- fake option B", "```", "", "Pick one?"].join("\n");
        const r = detectProseQuestion(text);
        expect(r?.question).toBe("Pick one?");
        expect(r?.options).toBeUndefined();
    });

    it("misses a question followed by a trailing code fence (pinned v1 limitation)", () => {
        const r = detectProseQuestion("Does this work?\n\n```\ncode\n```");
        expect(r).toBeNull();
    });
});
