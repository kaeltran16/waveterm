import { describe, expect, it } from "vitest";
import { buildEditDiff, formatDuration, parseGrep, sliceRead, toolResultText } from "./tooldetail";

describe("toolResultText", () => {
    it("returns a string result verbatim", () => {
        expect(toolResultText("hello")).toBe("hello");
    });
    it("joins text blocks of an array result", () => {
        expect(toolResultText([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb");
    });
    it("returns '' for missing/odd content", () => {
        expect(toolResultText(undefined)).toBe("");
        expect(toolResultText(42)).toBe("");
    });
});

describe("buildEditDiff", () => {
    it("emits removed lines then added lines with counts", () => {
        const f = buildEditDiff("/proj/a.ts", "old1\nold2", "new1");
        expect(f).toEqual({
            path: "/proj/a.ts",
            badge: "M",
            adds: 1,
            dels: 2,
            lines: [
                { sign: "-", text: "old1" },
                { sign: "-", text: "old2" },
                { sign: "+", text: "new1" },
            ],
        });
    });
    it("marks an empty old_string as an add (new file)", () => {
        const f = buildEditDiff("/proj/n.ts", "", "line");
        expect(f.badge).toBe("A");
        expect(f.dels).toBe(0);
    });
});

describe("parseGrep", () => {
    it("splits path:line prefix from code", () => {
        expect(parseGrep("src/a.ts:42:  const x = 1")).toEqual([{ loc: "src/a.ts:42", code: "  const x = 1" }]);
    });
    it("falls back to whole line as code when no prefix", () => {
        expect(parseGrep("no-prefix line")).toEqual([{ loc: "", code: "no-prefix line" }]);
    });
});

describe("sliceRead", () => {
    it("keeps content under the cap intact", () => {
        expect(sliceRead("a\nb", 9)).toEqual({ snippet: "a\nb", truncated: false });
    });
    it("truncates past the cap and flags it", () => {
        const r = sliceRead("1\n2\n3\n4", 2);
        expect(r).toEqual({ snippet: "1\n2", truncated: true });
    });
});

describe("formatDuration", () => {
    it("sub-minute → seconds with one decimal", () => {
        expect(formatDuration(3200)).toBe("3.2s");
        expect(formatDuration(400)).toBe("0.4s");
    });
    it("minutes past 60s", () => {
        expect(formatDuration(720000)).toBe("12m");
    });
    it("undefined → empty", () => {
        expect(formatDuration(undefined)).toBe("");
    });
});
