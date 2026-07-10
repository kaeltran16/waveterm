import { describe, expect, it } from "vitest";
import { contactSheetHtml, exitCode, formatResults } from "./report.mjs";

const pass = { name: "s1", steps: [{ step: "a", ok: true, detail: "d" }] };
const fail = { name: "s2", steps: [{ step: "b", ok: false, detail: "boom" }] };
const errored = { name: "s3", steps: [], error: "attach failed" };

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
});

describe("contactSheetHtml", () => {
    it("renders one img per entry with the png src", () => {
        const html = contactSheetHtml([
            { name: "cockpit", png: "cockpit.png" },
            { name: "channels", png: "channels.png" },
        ]);
        expect(html).toContain('src="cockpit.png"');
        expect(html).toContain('src="channels.png"');
    });
    it("emits a doctype even when empty", () => {
        expect(contactSheetHtml([])).toContain("<!doctype html>");
    });
});
