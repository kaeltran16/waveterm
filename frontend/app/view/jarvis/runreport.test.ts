import { describe, expect, it } from "vitest";
import { parseRunReport } from "./runreport";

const MD = [
    "# Retire the recall arm — run report",
    "",
    "DAG 2848: 6/6 tasks done, 0 failures, 44m elapsed.",
    "",
    "## Landed",
    "- 9e4ec1a4 retire `wsh jarvis ask` (t-3)",
    "- c08e46e4 pet recall acts (t-1 + t-5)",
    "## Verified on merged main",
    "- vitest: 246 files pass",
    "- task verify:ui: failures in brief-surface 7,",
    "  jarvis-motion 5",
    "## Answered",
    "- t-1: keep the pet expression",
    "## Forwarded",
    "- none",
    "## Live checks (dev app, CDP)",
    "- NOT checked: composer on a live lead",
].join("\n");

describe("parseRunReport", () => {
    const r = parseRunReport(MD)!;
    it("reads the title and the lead line", () => {
        expect(r.title).toBe("Retire the recall arm — run report");
        expect(r.lead).toBe("DAG 2848: 6/6 tasks done, 0 failures, 44m elapsed.");
    });
    it("splits a landed commit into hash, text and task tag", () => {
        expect(r.sections[0]).toMatchObject({ heading: "Landed", count: "2" });
        expect(r.sections[0].items[0]).toMatchObject({
            hash: "9e4ec1a4",
            text: "retire wsh jarvis ask",
            tag: "t-3",
            dot: "ok",
        });
        expect(r.sections[0].items[1].tag).toBe("t-1 + t-5");
    });
    it("joins a continuation line and marks failures as warn", () => {
        const v = r.sections[1].items[1];
        expect(v.text).toBe("task verify:ui: failures in brief-surface 7, jarvis-motion 5");
        expect(v.dot).toBe("warn");
        expect(r.sections[1].items[0].dot).toBe("ok");
    });
    it("reads a leading task id as the tag", () => {
        expect(r.sections[2].items[0]).toMatchObject({ tag: "t-1", text: "keep the pet expression", dot: "accent" });
    });
    it("counts none as none and dims it", () => {
        expect(r.sections[3]).toMatchObject({ count: "none" });
        expect(r.sections[3].items[0]).toMatchObject({ dim: true, dot: "faint" });
        expect(r.sections[4].items[0]).toMatchObject({ dim: true, dot: "faint" });
    });
    it("a blank report is no report", () => {
        expect(parseRunReport("  \n")).toBeNull();
        expect(parseRunReport("# only a title").sections).toEqual([]);
    });
});
