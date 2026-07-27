import { describe, expect, it } from "vitest";
import { DISPATCH_MODES, LADDER, rungState, showsDispatchMode } from "./autonomyladder";

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
