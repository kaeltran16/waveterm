import { describe, expect, it } from "vitest";
import { normalizeAgentUsage } from "./agentstatusstore";

describe("normalizeAgentUsage", () => {
    it("keeps Claude used percentages unchanged", () => {
        expect(normalizeAgentUsage("claude", { contextpct: 30, fivehourpct: 40, weekpct: 50 })).toEqual({
            contextpct: 30,
            fivehourpct: 40,
            weekpct: 50,
        });
    });

    it("converts Codex remaining percentages to used percentages", () => {
        expect(normalizeAgentUsage("codex", { contextpct: 100, fivehourpct: 75, weekpct: 0 })).toEqual({
            contextpct: 0,
            fivehourpct: 25,
            weekpct: 100,
        });
    });
});
