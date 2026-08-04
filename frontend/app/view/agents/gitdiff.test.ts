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

    // git always terminates its output with a newline; the fixture above deliberately does not, so the
    // gutter assertions below would never have caught the blank row that trailing newline used to add.
    it("drops the phantom blank line git's trailing newline leaves behind", () => {
        const v = parseUnifiedDiff(DIFF + "\n");
        const body = v.lines.filter((l) => l.kind !== "hunk");
        expect(body[body.length - 1].text).toBe("added line");
        expect(body.map((l) => [l.gOld, l.gNew, l.sign, l.text])).toEqual([
            ["10", "10", "", "ctx line"],
            ["11", "", "−", "old line"],
            ["", "11", "+", "new line"],
            ["", "12", "+", "added line"],
        ]);
    });

    it("a hunk body still ends with the newline git apply needs", () => {
        const v = parseUnifiedDiff(DIFF + "\n");
        expect(v.hunks).toHaveLength(1);
        expect(v.hunks[0].body.endsWith("\n")).toBe(true);
        expect(v.hunks[0].body.endsWith("\n\n")).toBe(false);
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

describe("parseUnifiedDiff on files with no diff text", () => {
    // git emits one sentence and no hunk for a binary file; rendering it as a context line put a
    // line number ("0") beside prose.
    const BINARY = [
        "diff --git a/blob.bin b/blob.bin",
        "index 111..222 100644",
        "Binary files a/blob.bin and b/blob.bin differ",
        "",
    ].join("\n");

    it("flags a binary file and renders none of it as a line", () => {
        const v = parseUnifiedDiff(BINARY);
        expect(v.binary).toBe(true);
        expect(v.lines).toEqual([]);
        expect(v.adds).toBe(0);
        expect(v.dels).toBe(0);
    });

    it("flags the binary-patch form too", () => {
        const v = parseUnifiedDiff("diff --git a/x b/x\nGIT binary patch\n");
        expect(v.binary).toBe(true);
        expect(v.lines).toEqual([]);
    });

    // a pure rename has no content at all, so the pane needs the old path to say anything useful
    const RENAME = [
        "diff --git a/oldname.txt b/newname.txt",
        "similarity index 100%",
        "rename from oldname.txt",
        "rename to newname.txt",
        "",
    ].join("\n");

    it("reports the old path of a pure rename and produces no lines", () => {
        const v = parseUnifiedDiff(RENAME);
        expect(v.renamedFrom).toBe("oldname.txt");
        expect(v.binary).toBe(false);
        expect(v.lines).toEqual([]);
    });

    it("an ordinary diff is neither binary nor a rename", () => {
        const v = parseUnifiedDiff(DIFF);
        expect(v.binary).toBe(false);
        expect(v.renamedFrom).toBeUndefined();
    });
});

describe("plainFileView", () => {
    it("renders a new file as an all-additions diff (green +, new gutter)", () => {
        const v = plainFileView("a\nb");
        expect(v.isDiff).toBe(true);
        expect(v.adds).toBe(2);
        expect(v.dels).toBe(0);
        expect(v.lines).toEqual([
            { gOld: "", gNew: "1", sign: "+", text: "a", kind: "add" },
            { gOld: "", gNew: "2", sign: "+", text: "b", kind: "add" },
        ]);
    });

    it("drops the phantom empty line a trailing newline leaves behind", () => {
        const v = plainFileView("a\nb\n");
        expect(v.lines.map((l) => l.text)).toEqual(["a", "b"]);
        expect(v.adds).toBe(2);
    });

    it("an empty file has no added lines", () => {
        const v = plainFileView("");
        expect(v.lines).toEqual([]);
        expect(v.adds).toBe(0);
    });
});

const TWO_HUNK = `diff --git a/a.txt b/a.txt
index 111..222 100644
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,3 @@
 l1
-l2
+X2
 l3
@@ -8,3 +8,3 @@
 l8
-l9
+X9
 l10
`;

describe("parseUnifiedDiff hunks", () => {
    it("splits into two hunks with counts", () => {
        const v = parseUnifiedDiff(TWO_HUNK);
        expect(v.hunks).toHaveLength(2);
        expect(v.hunks[0].adds).toBe(1);
        expect(v.hunks[0].dels).toBe(1);
    });

    it("each hunk patch = diff header + its own block, prefixes intact", () => {
        const v = parseUnifiedDiff(TWO_HUNK);
        const p0 = v.diffHeader + v.hunks[0].body;
        expect(p0).toContain("--- a/a.txt");
        expect(p0).toContain("+++ b/a.txt");
        expect(p0).toContain("@@ -1,3 +1,3 @@");
        expect(p0).toContain("-l2");
        expect(p0).toContain("+X2");
        expect(p0).not.toContain("X9"); // only the first hunk
        expect(p0.endsWith("\n")).toBe(true); // git apply needs a trailing newline
    });

    it("combined patch = header + selected bodies", () => {
        const v = parseUnifiedDiff(TWO_HUNK);
        const combined = v.diffHeader + v.hunks.map((h) => h.body).join("");
        expect(combined).toContain("+X2");
        expect(combined).toContain("+X9");
    });
});
