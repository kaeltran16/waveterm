import { describe, expect, it } from "vitest";
import { LADDER, RUNG_BAR_PX, rungState } from "./autonomyladder";

describe("LADDER", () => {
    it("orders the rungs from least to most autonomy", () => {
        expect(LADDER.map((r) => r.tier)).toEqual(["concierge", "gatekeeper"]);
    });

    it("states the nesting in each blurb above the floor", () => {
        expect(LADDER[1].blurb).toContain("implies Concierge");
    });
});

describe("rungState", () => {
    it("marks the current tier active and everything below it implied", () => {
        expect(rungState("gatekeeper", "gatekeeper")).toBe("active");
        expect(rungState("gatekeeper", "concierge")).toBe("implied");
    });

    it("marks rungs above the current tier off", () => {
        expect(rungState("concierge", "gatekeeper")).toBe("off");
    });

    it("makes the floor active at concierge — never merely implied", () => {
        expect(rungState("concierge", "concierge")).toBe("active");
    });
});

describe("RUNG_BAR_PX", () => {
    it("gives every rung a height, index-aligned to the ladder", () => {
        expect(RUNG_BAR_PX).toHaveLength(LADDER.length);
    });

    it("grows with the rung, so the bars read as accumulation", () => {
        const rising = RUNG_BAR_PX.every((h, i) => i === 0 || h > RUNG_BAR_PX[i - 1]);
        expect(rising).toBe(true);
    });
});
