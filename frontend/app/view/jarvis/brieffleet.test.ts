// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentVM } from "@/app/view/agents/agentsviewmodel";
import { describe, expect, it } from "vitest";
import { briefFleet, NO_FLEET_LINE } from "./brieffleet";

const agent = (over: Partial<AgentVM>): AgentVM => ({
    id: "tab-1",
    name: "loom",
    task: "ship the brief",
    state: "working",
    agent: "claude",
    ...over,
});

const withCost = (id: string, state: AgentVM["state"], costusd?: number): AgentVM =>
    agent({ id, state, usage: costusd == null ? undefined : ({ costusd } as AgentUsage) });

describe("briefFleet", () => {
    it("sums reported cost across the roster and prints it beside the live count", () => {
        const fleet = briefFleet([
            withCost("a", "working", 1.2),
            withCost("b", "asking", 0.75),
            withCost("c", "working", 0.46),
        ]);
        expect(fleet.liveCount).toBe(3);
        expect(fleet.spendUsd).toBeCloseTo(2.41, 5);
        expect(fleet.line).toBe("3 sessions live · $2.41");
    });

    it("counts live exactly as liveWindowAgents does, so idle workers drop out of the count", () => {
        const fleet = briefFleet([
            withCost("a", "working", 0.5),
            withCost("b", "idle", 0.25),
            withCost("c", "asking", 0.25),
        ]);
        expect(fleet.liveCount).toBe(2);
        // an idle worker leaves the count, so its spend leaves the total printed beside that count —
        // otherwise the dollars describe a larger set than the sessions they sit next to
        expect(fleet.spendUsd).toBeCloseTo(0.75, 5);
        expect(fleet.line).toBe("2 sessions live · $0.75");
    });

    it("treats a missing or malformed usage reading as zero rather than poisoning the line", () => {
        const fleet = briefFleet([
            withCost("a", "working", 1.5),
            withCost("b", "working"), // no usage at all
            agent({ id: "c", usage: {} as AgentUsage }), // usage present, cost absent
            agent({ id: "d", usage: { costusd: NaN } as AgentUsage }),
            agent({ id: "e", usage: { costusd: "0.99" as unknown as number } as AgentUsage }),
        ]);
        expect(fleet.spendUsd).toBe(1.5);
        expect(fleet.line).toBe("5 sessions live · $1.50");
    });

    it("states absence for an empty roster instead of a zeroed fleet", () => {
        const fleet = briefFleet([]);
        expect(fleet.liveCount).toBe(0);
        expect(fleet.spendUsd).toBe(0);
        expect(fleet.line).toBe(NO_FLEET_LINE);
    });

    it("states absence for an all-idle roster, and reports no spend rather than an orphaned total", () => {
        const fleet = briefFleet([withCost("a", "idle", 3.2), withCost("b", "idle", 1.1)]);
        expect(fleet.liveCount).toBe(0);
        expect(fleet.spendUsd).toBe(0);
        expect(fleet.line).toBe(NO_FLEET_LINE);
    });

    it("omits the spend part rather than printing $0.00", () => {
        expect(briefFleet([withCost("a", "working")]).line).toBe("1 session live");
    });

    it("rounds to cents and absorbs float drift in the sum", () => {
        expect(briefFleet([withCost("a", "working", 0.1), withCost("b", "working", 0.2)]).line).toBe(
            "2 sessions live · $0.30"
        );
        expect(briefFleet([withCost("a", "working", 2.565), withCost("b", "asking", 0.002)]).line).toBe(
            "2 sessions live · $2.57"
        );
    });
});
