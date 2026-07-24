// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "vitest";
import { buildFocusItems } from "./palette-focus";

const spaces: SpaceSummary[] = [
    { id: "t1", objective: "alpha", ticket: "A-1", status: "active", updated: 2 },
    { id: "t2", objective: "beta", ticket: "", status: "paused", updated: 1 },
];
const noop = { focus: () => {}, exit: () => {} };

test("one row per task; ticket becomes the subtitle (blank => undefined)", () => {
    const items = buildFocusItems(spaces, null, noop);
    expect(items.map((i) => i.key)).toEqual(["focus-t1", "focus-t2"]);
    expect(items[0].subtitle).toBe("A-1");
    expect(items[1].subtitle).toBeUndefined();
});

test("prepends an Exit focus row when a Space is active", () => {
    const items = buildFocusItems(spaces, "t1", noop);
    expect(items[0].key).toBe("focus-exit");
    expect(items).toHaveLength(3);
});

test("empty list + no active Space => no rows", () => {
    expect(buildFocusItems([], null, noop)).toEqual([]);
});

test("a task row's run() focuses that summary", () => {
    let got: SpaceSummary | null = null;
    const items = buildFocusItems(spaces, null, { focus: (s) => (got = s), exit: () => {} });
    items[0].run();
    expect(got?.id).toBe("t1");
});
