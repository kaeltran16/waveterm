// frontend/app/view/agents/gitdiff.test.ts
import { describe, expect, it } from "vitest";
import { parseUnifiedDiff, plainFileView } from "./gitdiff";

const DIFF = [
    "diff --git a/src/x.ts b/src/x.ts",
    "index 111..222 100644",
    "--- a/src/x.ts",
    "+++ b/src/x.ts",
    "@@ -10,3 +10,4 @@ createSession",
    " ctx line",
    "-old line",
    "+new line",
    "+added line",
].join("\n");

describe("parseUnifiedDiff", () => {
    it("drops file headers and parses the hunk header", () => {
        const v = parseUnifiedDiff(DIFF);
        expect(v.isDiff).toBe(true);
        expect(v.hunkLabel).toBe("@@ -10,3 +10,4 @@ createSession");
        expect(v.lines.some((l) => l.text.startsWith("diff --git"))).toBe(false);
    });

    it("tracks old/new gutters and counts adds/dels", () => {
        const v = parseUnifiedDiff(DIFF);
        const body = v.lines.filter((l) => l.kind !== "hunk");
        expect(body.map((l) => [l.gOld, l.gNew, l.sign, l.text])).toEqual([
            ["10", "10", "", "ctx line"],
            ["11", "", "−", "old line"],
            ["", "11", "+", "new line"],
            ["", "12", "+", "added line"],
        ]);
        expect(v.adds).toBe(2);
        expect(v.dels).toBe(1);
    });
});

describe("plainFileView", () => {
    it("numbers every line in the new gutter, no signs", () => {
        const v = plainFileView("a\nb");
        expect(v.isDiff).toBe(false);
        expect(v.lines).toEqual([
            { gOld: "", gNew: "1", sign: "", text: "a", kind: "ctx" },
            { gOld: "", gNew: "2", sign: "", text: "b", kind: "ctx" },
        ]);
    });
});
