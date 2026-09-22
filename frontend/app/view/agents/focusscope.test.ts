// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "vitest";
import type { AgentVM } from "./agentsviewmodel";
import { filterByFocus, filterChannelsByFocus, filterSessionsByFocus, focusBannerText } from "./focusscope";

const agent = (id: string): AgentVM => ({ id, name: id, task: "", state: "idle" });
const scope = (over: Partial<SpaceScope>): SpaceScope => ({ runorefs: [], channeloids: [], tabids: [], ...over });

test("filterByFocus: null scope passes all through (Global)", () => {
    const a = [agent("t1"), agent("t2")];
    expect(filterByFocus(a, null, false)).toBe(a);
});

test("filterByFocus: keeps only rows whose id is in tabids", () => {
    const a = [agent("t1"), agent("t2"), agent("t3")];
    expect(filterByFocus(a, scope({ tabids: ["t1", "t3"] }), false).map((x) => x.id)).toEqual(["t1", "t3"]);
});

test("filterByFocus: revealed passes all through despite scope", () => {
    const a = [agent("t1"), agent("t2")];
    expect(filterByFocus(a, scope({ tabids: ["t1"] }), true)).toBe(a);
});

test("filterChannelsByFocus: keeps only channels whose oid is in channeloids", () => {
    const ch = [{ oid: "c1" }, { oid: "c2" }];
    expect(filterChannelsByFocus(ch, scope({ channeloids: ["c2"] }), false)?.map((c) => c.oid)).toEqual(["c2"]);
});

test("filterChannelsByFocus: null channels stays null", () => {
    expect(filterChannelsByFocus(null, scope({ channeloids: ["c2"] }), false)).toBeNull();
});

test("filterSessionsByFocus: includes only sessions with a scoped live tab id", () => {
    const sessions = [{ id: "ended" }, { id: "in", liveId: "t1" }, { id: "out", liveId: "t2" }];
    expect(filterSessionsByFocus(sessions, scope({ tabids: ["t1"] }), false).map((s) => s.id)).toEqual(["in"]);
    expect(filterSessionsByFocus(sessions, null, false)).toBe(sessions);
    expect(filterSessionsByFocus(sessions, scope({ tabids: ["t1"] }), true)).toBe(sessions);
});

test("focusBannerText: focused with hidden, focused zero, revealed", () => {
    expect(focusBannerText("alpha", 3, false)).toBe("Focused: alpha · 3 hidden");
    expect(focusBannerText("alpha", 0, false)).toBe("Focused: alpha");
    expect(focusBannerText("alpha", 3, true)).toBe("Showing all · Focused: alpha");
});
