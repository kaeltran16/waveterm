import { describe, expect, it } from "vitest";
import { highlightLine } from "./highlight";

describe("highlightLine", () => {
    it("classifies keyword, ident, punctuation and string", () => {
        expect(highlightLine('const x = "hi";')).toEqual([
            { t: "const", cls: "text-syntax-keyword" },
            { t: " ", cls: "text-syntax-ident" },
            { t: "x", cls: "text-syntax-ident" },
            { t: " ", cls: "text-syntax-ident" },
            { t: "=", cls: "text-syntax-punct" },
            { t: " ", cls: "text-syntax-ident" },
            { t: '"hi"', cls: "text-syntax-string" },
            { t: ";", cls: "text-syntax-punct" },
        ]);
    });

    it("classifies numbers and line comments", () => {
        expect(highlightLine("return 42; // done")).toEqual([
            { t: "return", cls: "text-syntax-keyword" },
            { t: " ", cls: "text-syntax-ident" },
            { t: "42", cls: "text-syntax-number" },
            { t: ";", cls: "text-syntax-punct" },
            { t: " ", cls: "text-syntax-ident" },
            { t: "// done", cls: "text-syntax-comment" },
        ]);
    });

    it("never returns an empty token list (blank line yields one space)", () => {
        expect(highlightLine("")).toEqual([{ t: " ", cls: "text-syntax-ident" }]);
    });
});
