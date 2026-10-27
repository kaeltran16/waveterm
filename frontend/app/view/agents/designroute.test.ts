// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { routeDesign } from "./designroute";

function fakeIO(reply: () => Promise<CommandRunDesignAttachRtnData>) {
    const asked: CommandRunDesignAttachData[] = [];
    const attached: [string, string][] = [];
    let launched = 0;
    return {
        asked,
        attached,
        launched: () => launched,
        attach: async (data: CommandRunDesignAttachData) => {
            asked.push(data);
            return reply();
        },
        onAttached: (channelId: string, runId: string) => attached.push([channelId, runId]),
        openLauncher: () => launched++,
    };
}

describe("routeDesign", () => {
    it("hands the design to the run waiting on the block", async () => {
        const io = fakeIO(async () => ({ channelid: "c1", runid: "r1" }));
        const got = await routeDesign(io, "blk-1", { spec: "/p/docs/spec.md", prototype: "/p/x.dc.html" });
        expect(got).toBe("attached");
        expect(io.asked).toEqual([{ blockid: "blk-1", spec: "/p/docs/spec.md", prototype: "/p/x.dc.html" }]);
        expect(io.attached).toEqual([["c1", "r1"]]);
        expect(io.launched()).toBe(0);
    });

    it("opens the launcher for a block no run waits on", async () => {
        const io = fakeIO(async () => ({}));
        expect(await routeDesign(io, "blk-1", { spec: "/p/docs/spec.md" })).toBe("launcher");
        expect(io.attached).toEqual([]);
        expect(io.launched()).toBe(1);
    });

    it("opens the launcher without asking when the design names no spec or prototype", async () => {
        const io = fakeIO(async () => ({ channelid: "c1", runid: "r1" }));
        expect(await routeDesign(io, "blk-1", {})).toBe("launcher");
        expect(io.asked).toEqual([]);
        expect(io.launched()).toBe(1);
    });

    it("propagates a refused attach and opens nothing", async () => {
        const io = fakeIO(async () => {
            throw new Error("run r1 already took this session's design");
        });
        await expect(routeDesign(io, "blk-1", { prototype: "/p/x.dc.html" })).rejects.toThrow("already took");
        expect(io.attached).toEqual([]);
        expect(io.launched()).toBe(0);
    });
});
