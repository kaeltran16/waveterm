import { describe, expect, it } from "vitest";
import { descriptionBlocks, descriptionLead } from "./dagdescription";

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
});
