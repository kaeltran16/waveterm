// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "vitest";
import type { AgentVM } from "./agentsviewmodel";
import { filterBySpace, filterChannelsBySpace, spaceBannerText } from "./spacescope";

const agent = (id: string): AgentVM => ({ id, name: id, task: "", state: "idle" });
const scope = (over: Partial<SpaceScope>): SpaceScope => ({ runorefs: [], channeloids: [], tabids: [], ...over });

test("filterBySpace: null scope passes all through (Global)", () => {
    const a = [agent("t1"), agent("t2")];
    expect(filterBySpace(a, null, false)).toBe(a);
});

test("filterBySpace: keeps only rows whose id is in tabids", () => {
    const a = [agent("t1"), agent("t2"), agent("t3")];
    expect(filterBySpace(a, scope({ tabids: ["t1", "t3"] }), false).map((x) => x.id)).toEqual(["t1", "t3"]);
});

test("filterBySpace: revealed passes all through despite scope", () => {
    const a = [agent("t1"), agent("t2")];
    expect(filterBySpace(a, scope({ tabids: ["t1"] }), true)).toBe(a);
});

test("filterChannelsBySpace: keeps only channels whose oid is in channeloids", () => {
    const ch = [{ oid: "c1" }, { oid: "c2" }];
    expect(filterChannelsBySpace(ch, scope({ channeloids: ["c2"] }), false)?.map((c) => c.oid)).toEqual(["c2"]);
});

test("filterChannelsBySpace: null channels stays null", () => {
    expect(filterChannelsBySpace(null, scope({ channeloids: ["c2"] }), false)).toBeNull();
});

test("spaceBannerText: focused with hidden, focused zero, revealed", () => {
    expect(spaceBannerText("alpha", 3, false)).toBe("Focused: alpha · 3 hidden");
    expect(spaceBannerText("alpha", 0, false)).toBe("Focused: alpha");
    expect(spaceBannerText("alpha", 3, true)).toBe("Showing all · Focused: alpha");
});
