// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { autonomySummary, channelAutonomy } from "./briefautonomy";

function channel(over: Partial<Channel> & { meta?: Record<string, unknown> }): Channel {
    return {
        otype: "channel",
        oid: "c1",
        version: 1,
        name: "waveterm",
        ...over,
    } as Channel;
}

describe("channelAutonomy", () => {
    it("reads the nested tier and the dispatch mode off each channel's meta", () => {
        const rows = channelAutonomy([
            channel({ oid: "c1", name: "waveterm", meta: { "delegator:enabled": true, "delegator:mode": "fanout" } }),
            channel({ oid: "c2", name: "arc", meta: { "gatekeeper:enabled": true } }),
        ]);
        expect(rows).toEqual([
            { channelId: "c2", name: "arc", tier: "gatekeeper", mode: "" },
            { channelId: "c1", name: "waveterm", tier: "delegator", mode: "fanout" },
        ]);
    });

    it("leaves archived channels out — an archived project is not work you have a policy over", () => {
        const rows = channelAutonomy([
            channel({ oid: "c1", name: "waveterm", meta: {} }),
            channel({ oid: "c2", name: "old", meta: { archived: true, "delegator:enabled": true } }),
        ]);
        expect(rows.map((r) => r.channelId)).toEqual(["c1"]);
    });

    it("falls to concierge for a channel that has never been given a tier", () => {
        expect(channelAutonomy([channel({})])[0]).toMatchObject({ tier: "concierge", mode: "" });
    });

    it("survives a null roster, which is what the store holds before the first load", () => {
        expect(channelAutonomy(null)).toEqual([]);
    });
});

describe("autonomySummary", () => {
    const row = (tier: string, name: string) => ({ channelId: name, name, tier, mode: "" }) as never;

    it("states the tier and what it costs you when every project agrees", () => {
        expect(autonomySummary([row("delegator", "a"), row("delegator", "b")])).toEqual({
            label: "Delegator · answers routine asks",
            tier: "delegator",
            mixed: false,
        });
    });

    it("names the highest tier in force when they disagree, because that is the one acting without you", () => {
        expect(autonomySummary([row("delegator", "a"), row("concierge", "b"), row("gatekeeper", "c")])).toEqual({
            label: "Mixed · 1 of 3 delegator",
            tier: "delegator",
            mixed: true,
        });
    });

    it("counts every project at the top tier, not just one", () => {
        expect(autonomySummary([row("gatekeeper", "a"), row("gatekeeper", "b"), row("concierge", "c")])?.label).toBe(
            "Mixed · 2 of 3 gatekeeper"
        );
    });

    // a chip over no projects would be a policy claim about nothing, the same defect as "all clear" over
    // a snapshot that has not landed
    it("says nothing at all when there are no projects", () => {
        expect(autonomySummary([])).toBeNull();
    });
});
