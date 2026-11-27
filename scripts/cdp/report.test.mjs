import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { contactSheetHtml, exitCode, formatResults, shotsManifest, shotsUnder } from "./report.mjs";

const pass = { name: "s1", steps: [{ step: "a", ok: true, detail: "d" }] };
const fail = { name: "s2", steps: [{ step: "b", ok: false, detail: "boom" }] };
const errored = { name: "s3", steps: [], error: "attach failed" };
const skipped = { name: "s4", steps: [{ step: "c", skip: true, detail: "no scan report in this profile" }] };

describe("exitCode", () => {
    it("is 0 when every step of every scenario passes", () => {
        expect(exitCode([pass, { name: "s1b", steps: [{ step: "x", ok: true }] }])).toBe(0);
    });
    it("is 1 when any step fails", () => {
        expect(exitCode([pass, fail])).toBe(1);
    });
    it("is 1 when a scenario errored", () => {
        expect(exitCode([pass, errored])).toBe(1);
    });
    it("is 0 when a step was skipped rather than run", () => {
        expect(exitCode([pass, skipped])).toBe(0);
    });
    it("still fails when a real failure sits beside a skip", () => {
        expect(exitCode([skipped, fail])).toBe(1);
    });
});

describe("formatResults", () => {
    it("labels PASS/FAIL per step and prints a summary", () => {
        const out = formatResults([pass, fail]);
        expect(out).toContain("PASS  a");
        expect(out).toContain("FAIL  b");
        expect(out).toContain("1/2 steps passed");
    });
    it("surfaces a scenario error", () => {
        expect(formatResults([errored])).toContain("ERROR: attach failed");
    });
    it("labels a skip and keeps it out of the ran total", () => {
        const out = formatResults([pass, skipped]);
        expect(out).toContain("SKIP  c");
        expect(out).toContain("1/1 steps passed, 1 skipped");
    });
    it("indents every line of a step detail under its step", () => {
        const multi = { name: "s5", steps: [{ step: "e", ok: false, detail: "first\nsecond" }] };
        expect(formatResults([multi]).split("\n")).toEqual([
            "",
            "# s5",
            "  FAIL  e",
            "        first",
            "        second",
            "",
            "0/1 steps passed",
        ]);
    });
    it("prints a one-line detail indented eight spaces under its step", () => {
        expect(formatResults([fail]).split("\n")).toEqual(["", "# s2", "  FAIL  b", "        boom", "", "0/1 steps passed"]);
    });
    it("says nothing about skips when there are none", () => {
        expect(formatResults([pass, fail])).toContain("1/2 steps passed");
        expect(formatResults([pass, fail])).not.toContain("skipped");
    });
});

describe("contactSheetHtml", () => {
    it("renders one img per shot, its src relative to the sheet's dir", () => {
        const html = contactSheetHtml(
            [
                { name: "cockpit", path: "cdp-shots/cockpit.png" },
                { name: "nested", path: "cdp-shots/nested/a.png" },
                { name: "outside", path: "fixtures/seed.png" },
            ],
            "cdp-shots"
        );
        expect(html).toContain('src="cockpit.png"');
        expect(html).toContain('src="nested/a.png"');
        expect(html).toContain('src="../fixtures/seed.png"');
    });
    it("emits a doctype even when empty", () => {
        expect(contactSheetHtml([], "cdp-shots")).toContain("<!doctype html>");
    });
});

describe("shotsManifest", () => {
    it("maps pass, fail and skip, keeping step order and details", () => {
        const scenario = {
            name: "runs",
            steps: [
                { step: "a", ok: true, detail: "d" },
                { step: "b", ok: false, detail: "boom" },
                { step: "c", skip: true, detail: "no scan report" },
                { step: "e", ok: true },
            ],
        };
        expect(shotsManifest([scenario], { runs: [{ file: "runs.png" }, { file: "runs-open.png", step: 1 }] })).toEqual([
            {
                name: "runs",
                files: ["runs.png", "runs-open.png"],
                filesteps: { "runs-open.png": 1 },
                steps: [
                    { step: "a", state: "pass", detail: "d" },
                    { step: "b", state: "fail", detail: "boom" },
                    { step: "c", state: "skip", detail: "no scan report" },
                    { step: "e", state: "pass" },
                ],
            },
        ]);
    });

    it("adds a failing step carrying the error after the steps of a scenario that threw", () => {
        const threw = { name: "s5", steps: [{ step: "a", ok: true }], error: "nav not found" };
        expect(shotsManifest([threw, errored], {})).toEqual([
            {
                name: "s5",
                files: [],
                steps: [
                    { step: "a", state: "pass" },
                    { step: "the scenario threw", state: "fail", detail: "nav not found" },
                ],
            },
            { name: "s3", files: [], steps: [{ step: "the scenario threw", state: "fail", detail: "attach failed" }] },
        ]);
    });

    it("gives a scenario with no shots an empty file list", () => {
        expect(shotsManifest([pass], { other: [{ file: "other.png" }] })).toEqual([
            { name: "s1", files: [], steps: [{ step: "a", state: "pass", detail: "d" }] },
        ]);
    });
});

describe("shotsUnder", () => {
    it("keeps the shots under the dir, relative to it with forward slashes, in order", () => {
        const shots = [
            { path: "cdp-shots/b.png" },
            { path: "cdp-shots/nested/a.png" },
            { path: join(resolve("cdp-shots"), "abs.png") },
        ];
        expect(shotsUnder(shots, "cdp-shots")).toEqual([{ file: "b.png" }, { file: "nested/a.png" }, { file: "abs.png" }]);
    });

    it("keeps the step a shot was tagged with", () => {
        const shots = [{ path: "cdp-shots/a.png", step: 0 }, { path: "cdp-shots/b.png" }, { path: "cdp-shots/c.png", step: 2 }];
        expect(shotsUnder(shots, "cdp-shots")).toEqual([{ file: "a.png", step: 0 }, { file: "b.png" }, { file: "c.png", step: 2 }]);
    });

    it("drops a png a scenario wrote outside the dir", () => {
        const shots = [
            { path: "cdp-shots/kept.png" },
            { path: "fixtures/seed.png" },
            { path: "cdp-shots/../escaped.png" },
            { path: "cdp-shots-old/x.png" },
            { path: resolve("elsewhere", "y.png") },
        ];
        expect(shotsUnder(shots, "cdp-shots")).toEqual([{ file: "kept.png" }]);
    });
});
