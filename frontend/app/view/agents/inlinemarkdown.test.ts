import { describe, expect, it } from "vitest";
import { condenseToLine } from "./inlinemarkdown";

describe("condenseToLine", () => {
    it("keeps a plain first line unchanged", () => {
        expect(condenseToLine("just a line")).toBe("just a line");
    });
    it("strips a leading heading marker", () => {
        expect(condenseToLine("## Direct answer")).toBe("Direct answer");
    });
    it("strips a leading bullet or blockquote or ordered marker", () => {
        expect(condenseToLine("- item one")).toBe("item one");
        expect(condenseToLine("> quoted")).toBe("quoted");
        expect(condenseToLine("1. first")).toBe("first");
    });
    it("takes only the first paragraph and folds inner newlines to spaces", () => {
        expect(condenseToLine("line one\nline two\n\nsecond para")).toBe("line one line two");
    });
    it("leaves inline emphasis markers for the renderer", () => {
        expect(condenseToLine("**bold** and `code`")).toBe("**bold** and `code`");
    });
});