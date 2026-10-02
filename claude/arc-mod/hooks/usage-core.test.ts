import { describe, expect, it } from "vitest";
import { usageArgs } from "./usage-core";

describe("usageArgs", () => {
    it("reports nothing before the session has a context reading", () => {
        expect(usageArgs({ context: { window: 1000000 }, rateLimits: [] })).toBeNull();
    });

    it("maps context, cost and both rate-limit windows", () => {
        expect(
            usageArgs({
                context: { window: 1000000, percent: 4 },
                rateLimits: [
                    { kind: "five_hour", percentUsed: 15, resetsAt: "2026-10-02T05:10:00.000Z" },
                    { kind: "seven_day", percentUsed: 97, resetsAt: "2026-10-03T00:00:00.000Z" },
                ],
                cost: { usd: 0.1190696 },
            })
        ).toEqual([
            "agentstatus", "--usage",
            "--context-pct", "4",
            "--context-max", "1000000",
            "--cost-usd", "0.1190696",
            "--five-hour-pct", "15", "--five-hour-reset", "1790917800",
            "--week-pct", "97", "--week-reset", "1790985600",
        ]);
    });

    it("sends no rate-limit flags for an API-key session and cost 0 when the host keeps no ledger", () => {
        expect(usageArgs({ context: { window: 200000, percent: 42 }, rateLimits: [] })).toEqual([
            "agentstatus", "--usage", "--context-pct", "42", "--context-max", "200000", "--cost-usd", "0",
        ]);
    });

    it("ignores an unknown window and omits a reset it cannot read", () => {
        expect(
            usageArgs({
                context: { window: 200000, percent: 10 },
                rateLimits: [
                    { kind: "spend_limit", percentUsed: 50 },
                    { kind: "five_hour", percentUsed: 23.5 },
                    { kind: "seven_day", percentUsed: 7, resetsAt: "not a date" },
                ],
            })
        ).toEqual([
            "agentstatus", "--usage", "--context-pct", "10", "--context-max", "200000", "--cost-usd", "0",
            "--five-hour-pct", "23.5",
            "--week-pct", "7",
        ]);
    });
});
