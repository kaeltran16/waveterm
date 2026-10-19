import { describe, expect, it } from "vitest";
import { descriptionBlocks, descriptionLead, type DescBlock } from "./dagdescription";

describe("descriptionBlocks", () => {
    it("splits paragraphs, headings, list items and fences", () => {
        const b = descriptionBlocks("Intro line\ncontinued.\n\n## Head\n- [ ] step one\n  - nested\n```\ncode\n```");
        expect(b.map((x) => [x.kind, x.depth, x.check])).toEqual([
            ["p", 0, ""],
            ["h", 0, ""],
            ["li", 0, "open"],
            ["li", 1, ""],
            ["code", 0, ""],
        ]);
        expect(b[0].text).toBe("Intro line continued.");
    });
});

describe("descriptionBlocks fences, headings and lists", () => {
    const FENCE = "```";
    const block = (kind: DescBlock["kind"], text: string, depth = 0, check: DescBlock["check"] = ""): DescBlock => ({
        kind,
        depth,
        text,
        check,
    });

    it("closes a fence on the first line that opens with the marker, keeping the lines it holds verbatim", () => {
        const src = [FENCE, "first", `x ${FENCE} y`, "  second", `  ${FENCE}`, "after"].join("\n");
        expect(descriptionBlocks(src)).toEqual([block("code", `first\nx ${FENCE} y\n  second`), block("p", "after")]);
    });

    it("reads an indented fence's depth from its indent, and keeps an unclosed fence's lines", () => {
        expect(descriptionBlocks(`    ${FENCE}\ncode`)).toEqual([block("code", "code", 2)]);
    });

    it("does not open a fence on a marker in the middle of a line", () => {
        expect(descriptionBlocks(`use ${FENCE} inline`)).toEqual([block("p", `use ${FENCE} inline`)]);
    });

    it("splits paragraphs on a whitespace-only line", () => {
        expect(descriptionBlocks("one\n   \ntwo")).toEqual([block("p", "one"), block("p", "two")]);
    });

    it("reads a heading's text after any run of spaces, and only from the line's start", () => {
        expect(descriptionBlocks("## Head")).toEqual([block("h", "Head")]);
        expect(descriptionBlocks("##  Two spaces")).toEqual([block("h", "Two spaces")]);
        expect(descriptionBlocks("see # note here")).toEqual([block("p", "see # note here")]);
    });

    it("reads bullets and numbers of any width, with the box's state, past any run of spaces", () => {
        expect(descriptionBlocks("10. ten")).toEqual([block("li", "ten")]);
        expect(descriptionBlocks("1. one")).toEqual([block("li", "one")]);
        expect(descriptionBlocks("-  wide")).toEqual([block("li", "wide")]);
        expect(descriptionBlocks("- [x]  done")).toEqual([block("li", "done", 0, "done")]);
        expect(descriptionBlocks("  * [ ] todo")).toEqual([block("li", "todo", 1, "open")]);
    });

    it("trims a paragraph's lines, and starts a new one after a list item whose next line is not indented", () => {
        expect(descriptionBlocks("  Intro  \n  continued  ")).toEqual([block("p", "Intro continued")]);
        expect(descriptionBlocks("- item\n  more\nplain text")).toEqual([
            block("li", "item more"),
            block("p", "plain text"),
        ]);
    });
});

describe("descriptionLead", () => {
    it("leads with the first prose paragraph, skipping bare labels", () => {
        const r = descriptionLead(
            "**Context:**\n\nSpec section 1.1. Today `workerContract` tells workers.\n\n**Files:**\n- Modify: `a.go`"
        );
        expect(r).toEqual({ lead: "Spec section 1.1. Today `workerContract` tells workers.", more: true });
    });
    it("names the files a plan that opens on Files: touches", () => {
        const src =
            "**Files:**\n- Modify: `a.ts`\n- Modify: `b.ts` (why)\n- Test: `c.test.ts`\n- Create: `d.ts`\n- Create: `e.ts`\n  - `nested.ts`\n\nLater prose.";
        expect(descriptionLead(src).lead).toBe("Touches `a.ts`, `b.ts`, `c.test.ts`, `d.ts` +1 more");
    });
    it("does not count task boxes as files", () => {
        expect(descriptionLead("**Files:**\n- `a.ts`\n- [ ] **Step 1**").lead).toBe("Touches `a.ts`");
    });
    it("falls back to later prose when Files: has no list", () => {
        expect(descriptionLead("**Files:**\n\nThe prose.").lead).toBe("The prose.");
        expect(descriptionLead("**Files:**").lead).toBe("");
    });
    it("is empty for no description", () => {
        expect(descriptionLead(undefined)).toEqual({ lead: "", more: false });
        expect(descriptionLead("  ")).toEqual({ lead: "", more: false });
    });
    it("keeps a one-paragraph description's lead without more", () => {
        expect(descriptionLead("Just this.")).toEqual({ lead: "Just this.", more: false });
    });
    it("leads with the prose before a Files: label rather than the files after it", () => {
        expect(descriptionLead("Prose first\n\n**Files:**\n- `a.ts`")).toEqual({ lead: "Prose first", more: true });
    });
    it("skips a heading or list to reach the first prose paragraph", () => {
        expect(descriptionLead("## Heading\nSome prose").lead).toBe("Some prose");
    });
    it("ignores a list that precedes any Files: label", () => {
        expect(descriptionLead("- `a.ts`\n\nProse").lead).toBe("Prose");
    });
    it("counts only the Files: label as the Files: block", () => {
        expect(descriptionLead("Intro prose\n\n- `a.ts`").lead).toBe("Intro prose");
        expect(descriptionLead("Edit the **Files:**\n- `a.ts`").lead).toBe("Edit the **Files:**");
        expect(descriptionLead("**Files:** all of them\n- `a.ts`").lead).toBe("**Files:** all of them");
    });
    it("stops collecting files at the first block that is not a list item", () => {
        expect(descriptionLead("**Files:**\n- `a.ts`\n\nSee `b.ts` too.").lead).toBe("Touches `a.ts`");
    });
    it("names exactly the most files it shows without a count of the rest", () => {
        expect(descriptionLead("**Files:**\n- `a`\n- `b`\n- `c`\n- `d`").lead).toBe("Touches `a`, `b`, `c`, `d`");
    });
});
