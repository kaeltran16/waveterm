import { describe, expect, it } from "vitest";
import { splitInsightBlocks } from "./insightblocks";

const OPEN = "`★ Insight ─────────────────────────────────────`";
const CLOSE = "`─────────────────────────────────────────────────`";

describe("splitInsightBlocks", () => {
    it("returns a single text segment for plain prose", () => {
        expect(splitInsightBlocks("just a normal message")).toEqual([{ kind: "text", text: "just a normal message" }]);
    });

    it("splits a backtick-wrapped insight block out of surrounding prose", () => {
        const text = [OPEN, "- The renderer is NarrationTimeline.", "- The projection is lossy.", CLOSE].join("\n");
        const withProse = ["Here is the intro.", text, "And the conclusion."].join("\n");
        expect(splitInsightBlocks(withProse)).toEqual([
            { kind: "text", text: "Here is the intro." },
            { kind: "insight", text: "- The renderer is NarrationTimeline.\n- The projection is lossy." },
            { kind: "text", text: "And the conclusion." },
        ]);
    });

    it("detects an insight block even without the wrapping backticks", () => {
        const text = ["★ Insight ─────────", "- no backticks here", "─────────────────"].join("\n");
        expect(splitInsightBlocks(text)).toEqual([{ kind: "insight", text: "- no backticks here" }]);
    });

    it("leaves an opener with no closer untransformed", () => {
        const text = [OPEN, "- a point", "- another point"].join("\n");
        expect(splitInsightBlocks(text)).toEqual([{ kind: "text", text }]);
    });

    it("handles two insight blocks in one message", () => {
        const text = [OPEN, "- first block", CLOSE, "Middle prose.", OPEN, "- second block", CLOSE].join("\n");
        expect(splitInsightBlocks(text)).toEqual([
            { kind: "insight", text: "- first block" },
            { kind: "text", text: "Middle prose." },
            { kind: "insight", text: "- second block" },
        ]);
    });

    it("emits no empty text segments when an insight is at the start or end", () => {
        const text = [OPEN, "- only an insight", CLOSE].join("\n");
        expect(splitInsightBlocks(text)).toEqual([{ kind: "insight", text: "- only an insight" }]);
    });
});
