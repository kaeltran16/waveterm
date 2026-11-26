// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { SubagentVM } from "./session-models/sessionviewmodel";
import { runningBackground, subagentElapsedMs, subagentOutcome } from "./subagentmodel";

const sub = (over: Partial<SubagentVM>): SubagentVM => ({ id: "s", type: "Explore", state: "working", ...over });

describe("subagentOutcome", () => {
    it.each([
        ["working", "running"],
        ["success", "done"],
        ["done", "done"],
        ["failure", "failed"],
        ["stopped", "stopped"],
    ] as const)("reads %s as %s", (state, want) => {
        expect(subagentOutcome(sub({ state }))).toBe(want);
    });
});

describe("subagentElapsedMs", () => {
    const NOW = 62_000;
    it.each([
        ["running: start to now", sub({ startedAtMs: 2_000 }), 60_000],
        ["finished: start to end", sub({ state: "success", startedAtMs: 2_000, endedAtMs: 32_000 }), 30_000],
        ["no start", sub({}), undefined],
        ["finished with no end", sub({ state: "stopped", startedAtMs: 2_000 }), undefined],
    ] as const)("%s", (_name, s, want) => {
        expect(subagentElapsedMs(s, NOW)).toBe(want);
    });
});

describe("runningBackground", () => {
    it("keeps the working background ones, most recently started first", () => {
        const subs = [
            sub({ id: "older", background: true, startedAtMs: 100 }),
            sub({ id: "foreground", startedAtMs: 300 }),
            sub({ id: "finished", background: true, state: "done", startedAtMs: 400 }),
            sub({ id: "newer", background: true, startedAtMs: 200 }),
        ];
        expect(runningBackground(subs).map((s) => s.id)).toEqual(["newer", "older"]);
    });
});
