import { describe, expect, it } from "vitest";
import { chipParts, DISPATCH_MODES, LADDER, RUNG_BAR_PX, rungState, showsDispatchMode } from "./autonomyladder";

describe("LADDER", () => {
    it("orders the rungs from least to most autonomy", () => {
        expect(LADDER.map((r) => r.tier)).toEqual(["concierge", "gatekeeper", "delegator"]);
    });

    it("states the nesting in each blurb above the floor", () => {
        expect(LADDER[1].blurb).toContain("implies Concierge");
        expect(LADDER[2].blurb).toContain("implies Gatekeeper");
    });
});

describe("rungState", () => {
    it("marks the current tier active and everything below it implied", () => {
        expect(rungState("delegator", "delegator")).toBe("active");
        expect(rungState("delegator", "gatekeeper")).toBe("implied");
        expect(rungState("delegator", "concierge")).toBe("implied");
    });

    it("marks rungs above the current tier off", () => {
        expect(rungState("gatekeeper", "delegator")).toBe("off");
        expect(rungState("concierge", "gatekeeper")).toBe("off");
        expect(rungState("concierge", "delegator")).toBe("off");
    });

    it("makes the floor active at concierge — never merely implied", () => {
        expect(rungState("concierge", "concierge")).toBe("active");
    });
});

describe("showsDispatchMode", () => {
    it("shows the dispatch mode only at delegator", () => {
        expect(showsDispatchMode("delegator")).toBe(true);
        expect(showsDispatchMode("gatekeeper")).toBe(false);
        expect(showsDispatchMode("concierge")).toBe(false);
    });

    it("offers exactly the three backend modes", () => {
        expect(DISPATCH_MODES).toEqual(["report", "manage", "fanout"]);
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

describe("chipParts", () => {
    it("names the current tier", () => {
        expect(chipParts("gatekeeper", "report").label).toBe("Gatekeeper");
        expect(chipParts("concierge", "report").label).toBe("Concierge");
    });

    it("carries the dispatch mode at delegator only", () => {
        expect(chipParts("delegator", "fanout").mode).toBe("fanout");
        expect(chipParts("gatekeeper", "fanout").mode).toBeNull();
        expect(chipParts("concierge", "fanout").mode).toBeNull();
    });

    it("drops an unset mode rather than rendering a bare separator", () => {
        expect(chipParts("delegator", "").mode).toBeNull();
        expect(chipParts("delegator", undefined).mode).toBeNull();
    });
});
