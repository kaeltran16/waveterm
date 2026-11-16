import { describe, expect, it } from "vitest";
import { shellRunLines } from "./shellrunmodel";

const numbered = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

describe("shellRunLines", () => {
    it("shows 8 lines or fewer whole, with no control", () => {
        const out = numbered("o", 5);
        const err = numbered("e", 3);
        expect(shellRunLines(out.join("\n"), err.join("\n"), false)).toEqual({
            stdout: out,
            stderr: err,
            total: 8,
            showAll: false,
            showLess: false,
        });
    });
    it("shows the first 8 of 12 stdout lines, with the Show all control", () => {
        const out = numbered("o", 12);
        const seen = shellRunLines(out.join("\n"), "", false);
        expect(seen.stdout).toEqual(out.slice(0, 8));
        expect(seen.stderr).toEqual([]);
        expect(seen.total).toBe(12);
        expect(seen.showAll).toBe(true);
        expect(seen.showLess).toBe(false);
    });
    it("fills the 8 with stdout first: 5 stdout and 6 stderr show 5 and 3, with the control", () => {
        const out = numbered("o", 5);
        const err = numbered("e", 6);
        const seen = shellRunLines(out.join("\n"), err.join("\n"), false);
        expect(seen.stdout).toEqual(out);
        expect(seen.stderr).toEqual(["e1", "e2", "e3"]);
        expect(seen.total).toBe(11);
        expect(seen.showAll).toBe(true);
    });
    it("opened shows every line and no Show all control, only the way back", () => {
        const out = numbered("o", 5);
        const err = numbered("e", 6);
        const seen = shellRunLines(out.join("\n"), err.join("\n"), true);
        expect(seen.stdout).toEqual(out);
        expect(seen.stderr).toEqual(err);
        expect(seen.showAll).toBe(false);
        expect(seen.showLess).toBe(true);
    });
    it("opened with nothing held back draws neither control", () => {
        const seen = shellRunLines("a\nb", "", true);
        expect(seen).toMatchObject({ stdout: ["a", "b"], showAll: false, showLess: false });
    });
    it("does not count trailing newlines as lines", () => {
        const out = numbered("o", 8);
        const seen = shellRunLines(out.join("\n") + "\n\n\n", "\n", false);
        expect(seen).toEqual({ stdout: out, stderr: [], total: 8, showAll: false, showLess: false });
    });
    it("has no lines for missing or empty output", () => {
        expect(shellRunLines(undefined, "", false)).toEqual({
            stdout: [],
            stderr: [],
            total: 0,
            showAll: false,
            showLess: false,
        });
    });
});
