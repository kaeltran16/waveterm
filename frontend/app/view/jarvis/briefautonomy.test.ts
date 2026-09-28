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
    it("reads the tier off each channel's meta", () => {
        const rows = channelAutonomy(
            [
                channel({ oid: "c1", name: "waveterm", meta: { "gatekeeper:enabled": false } }),
                channel({ oid: "c2", name: "arc", meta: { "gatekeeper:enabled": true } }),
            ],
            {}
        );
        expect(rows).toEqual([
            { channelId: "c2", name: "arc", tier: "gatekeeper" },
            { channelId: "c1", name: "waveterm", tier: "concierge" },
        ]);
    });

    it("leaves archived channels out — an archived project is not work you have a policy over", () => {
        const rows = channelAutonomy(
            [
                channel({ oid: "c1", name: "waveterm", meta: {} }),
                channel({ oid: "c2", name: "old", meta: { archived: true, "gatekeeper:enabled": false } }),
            ],
            {}
        );
        expect(rows.map((r) => r.channelId)).toEqual(["c1"]);
    });

    it("defaults to gatekeeper for a channel that has never been given a tier", () => {
        expect(channelAutonomy([channel({})], {})[0]).toMatchObject({ tier: "gatekeeper" });
    });

    it("survives a null roster, which is what the store holds before the first load", () => {
        expect(channelAutonomy(null, {})).toEqual([]);
    });

    it("labels each row with the registered project, not the channel's own name", () => {
        const rows = channelAutonomy([{ oid: "c1", name: "old-thread-name", projectpath: "/repo/wave" } as Channel], {
            wave: { path: "/repo/wave" },
        });
        expect(rows[0]).toMatchObject({ channelId: "c1", name: "wave" });
    });

    it("shows one row per project when a project has duplicate channels", () => {
        const rows = channelAutonomy(
            [
                { oid: "new", name: "a", projectpath: "/repo/a" } as Channel,
                { oid: "old", name: "a (2)", projectpath: "/repo/a" } as Channel,
            ],
            { a: { path: "/repo/a" } }
        );
        expect(rows.map((r) => r.channelId)).toEqual(["new"]);
    });
});

describe("autonomySummary", () => {
    const row = (tier: string, name: string) => ({ channelId: name, name, tier }) as never;

    it("states the tier and what it costs you when every project agrees", () => {
        expect(autonomySummary([row("gatekeeper", "a"), row("gatekeeper", "b")])).toEqual({
            label: "Gatekeeper · answers routine asks",
            tier: "gatekeeper",
            mixed: false,
        });
        expect(autonomySummary([row("concierge", "a")])?.label).toBe("Concierge · asks you everything");
    });

    it("names the highest tier in force when they disagree, because that is the one acting without you", () => {
        expect(autonomySummary([row("concierge", "a"), row("gatekeeper", "b"), row("concierge", "c")])).toEqual({
            label: "Mixed · 1 of 3 gatekeeper",
            tier: "gatekeeper",
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
