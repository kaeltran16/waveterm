// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "vitest";
import type { AgentVM } from "./agentsviewmodel";
import { filterByFocus, filterChannelsByFocus, filterSessionsByFocus, focusBannerCopy } from "./focusscope";

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

test("focusBannerCopy: filtering names the counts and offers Show all", () => {
    expect(focusBannerCopy("alpha", 2, 5, false, "agents")).toEqual({
        lead: "Focused on ",
        label: "alpha",
        trail: " · showing 2 of 5 agents",
        toggle: "Show all 5",
    });
});

test("focusBannerCopy: a focus that hides nothing offers no toggle", () => {
    expect(focusBannerCopy("alpha", 3, 3, false, "agents")).toEqual({
        lead: "Focused on ",
        label: "alpha",
        trail: "",
        toggle: null,
    });
});

test("focusBannerCopy: an empty focus says so, with Show all only when there is something to show", () => {
    expect(focusBannerCopy("alpha", 0, 4, false, "sessions").trail).toBe(" · none of its sessions are live");
    expect(focusBannerCopy("alpha", 0, 4, false, "sessions").toggle).toBe("Show all 4");
    expect(focusBannerCopy("alpha", 0, 0, false, "sessions").toggle).toBeNull();
});

test("focusBannerCopy: revealed counts what is in the focus and offers to hide the rest", () => {
    expect(focusBannerCopy("alpha", 2, 5, true, "agents")).toEqual({
        lead: "Showing all 5 · 2 in ",
        label: "alpha",
        trail: "",
        toggle: "Hide the other 3",
    });
    expect(focusBannerCopy("alpha", 5, 5, true, "agents").toggle).toBeNull();
});
