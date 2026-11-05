// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    cacheRewriteTitle,
    contextLevel,
    contextNote,
    contextTokens,
    filesSummary,
    lastTurnInterrupted,
    linkedWorktree,
    newTokens,
    offersContextReset,
    railAction,
    railReloadKey,
    toolChips,
} from "./agentrailmodel";
import type { TokenClass } from "./usagestats";

describe("contextLevel", () => {
    it("colors a big window by the tokens every turn re-reads, not by how full it is", () => {
        expect(contextLevel(10, 1_000_000)).toBe("ok");
        expect(contextLevel(15, 1_000_000)).toBe("warn");
        expect(contextLevel(30, 1_000_000)).toBe("hot");
    });

    it("keeps the fullness warning for a small window", () => {
        expect(contextLevel(62, 200_000)).toBe("warn");
        expect(contextLevel(90, 200_000)).toBe("hot");
    });

    it("falls back to fullness when the window size is unknown", () => {
        expect(contextLevel(30, undefined)).toBe("ok");
        expect(contextLevel(70, undefined)).toBe("warn");
    });
});

describe("contextTokens", () => {
    it("labels the tokens in context, or nothing without a window size", () => {
        expect(contextTokens(18.2, 1_000_000)).toBe("182k");
        expect(contextTokens(18.2, undefined)).toBeUndefined();
    });
});

describe("contextNote", () => {
    it("says how much of the window is used, in the window's own size", () => {
        expect(contextNote(62, 200_000)).toBe("124k of 200k tokens");
        expect(contextNote(10, 1_000_000)).toBe("100k of 1M tokens");
    });

    it("says what each turn re-reads once the context is costly", () => {
        expect(contextNote(18.2, 1_000_000)).toBe("182k re-read every turn");
        expect(contextNote(38, 1_000_000)).toBe("380k re-read every turn");
    });

    it("warns instead once the window is nearly full", () => {
        expect(contextNote(90, 200_000)).toBe("Near the limit.");
    });

    it("says nothing when the window size is unknown", () => {
        expect(contextNote(40, undefined)).toBe("");
    });
});

describe("offersContextReset", () => {
    const base = { isClaude: true, state: "idle" as const, level: "warn" as const, live: true };

    it("offers Compact and Clear to an idle Claude agent carrying a costly context", () => {
        expect(offersContextReset(base)).toBe(true);
        expect(offersContextReset({ ...base, level: "hot" })).toBe(true);
    });

    it("offers nothing mid-turn, where the command would queue into the agent's input", () => {
        expect(offersContextReset({ ...base, state: "working" })).toBe(false);
        expect(offersContextReset({ ...base, state: "asking" })).toBe(false);
    });

    it("offers nothing for a cheap context, another runtime, or no live terminal", () => {
        expect(offersContextReset({ ...base, level: "ok" })).toBe(false);
        expect(offersContextReset({ ...base, isClaude: false })).toBe(false);
        expect(offersContextReset({ ...base, live: false })).toBe(false);
    });
});

describe("cacheRewriteTitle", () => {
    it("says what an expired cache costs the next turn", () => {
        expect(cacheRewriteTitle(18.2, 1_000_000)).toBe("if the cache expires, the next turn rewrites ~182k");
    });

    it("says nothing without a context reading", () => {
        expect(cacheRewriteTitle(undefined, 1_000_000)).toBeUndefined();
        expect(cacheRewriteTitle(18, undefined)).toBeUndefined();
    });
});

describe("railAction", () => {
    const base = {
        state: "working" as const,
        age: "4m",
        live: true,
        standingBy: false,
        interrupted: false,
        silentMs: null,
    };

    it("asking offers no stop", () => {
        expect(railAction({ ...base, state: "asking" })).toEqual({
            kind: "none",
            hint: "waiting on you · answer in the terminal",
        });
    });

    it("idle offers resume only after an interrupt", () => {
        expect(railAction({ ...base, state: "idle", age: "38m" })).toBeNull();
        expect(railAction({ ...base, state: "idle", age: "38m", interrupted: true })).toEqual({
            kind: "resume",
            hint: "idle 38m · nudge to continue",
        });
    });

    it("quiet working warns and keeps stop", () => {
        expect(railAction(base)).toEqual({ kind: "stop", hint: "working 4m · Esc also stops" });
        expect(railAction({ ...base, silentMs: 4 * 60_000 + 30_000 })).toEqual({
            kind: "stop",
            hint: "quiet · no output 4m · Esc also stops",
            tone: "warning",
        });
    });

    it("standing by offers nothing", () => {
        expect(railAction({ ...base, state: "idle", standingBy: true, interrupted: true })).toBeNull();
        expect(railAction({ ...base, standingBy: true })).toBeNull();
    });

    it("offers nothing without a live terminal", () => {
        expect(railAction({ ...base, live: false })).toBeNull();
        expect(railAction({ ...base, state: "idle", live: false, interrupted: true })).toBeNull();
    });
});

describe("lastTurnInterrupted", () => {
    it("is true when the last entry is an interrupt", () => {
        expect(lastTurnInterrupted([{ kind: "user", text: "go" }, { kind: "interrupted" }])).toBe(true);
    });

    it("lastTurnInterrupted is false once a later turn ran", () => {
        expect(
            lastTurnInterrupted([
                { kind: "interrupted" },
                { kind: "user", text: "try again" },
                { kind: "message", text: "done" },
            ])
        ).toBe(false);
        expect(lastTurnInterrupted([])).toBe(false);
    });
});

describe("railReloadKey", () => {
    const agent = { id: "a", transcriptPath: "/t.jsonl", blockId: "b", idleSince: 1_000 };

    it("railReloadKey changes with lasteditts and a new idle episode", () => {
        const key = railReloadKey(agent, 500);
        expect(railReloadKey(agent, 500)).toBe(key);
        expect(railReloadKey(agent, 900)).not.toBe(key);
        expect(railReloadKey({ ...agent, idleSince: 2_000 }, 500)).not.toBe(key);
        expect(railReloadKey({ ...agent, idleSince: undefined }, 500)).not.toBe(key);
        expect(railReloadKey(agent)).not.toBe(key);
    });
});

describe("newTokens", () => {
    it("newTokens leaves out cache reads", () => {
        const c = (cls: TokenClass, tokens: number) => ({ cls, label: cls, tokens, spendUsd: 0 });
        expect(
            newTokens([
                c("cacheRead", 1_000_000),
                c("input", 10),
                c("output", 200),
                c("reasoning", 30),
                c("cacheWrite", 4000),
            ])
        ).toBe(4240);
        expect(newTokens([])).toBe(0);
    });
});

describe("toolChips", () => {
    it("sorts by use and dims the rarely used", () => {
        expect(
            toolChips([
                { verb: "Edit", count: 2 },
                { verb: "Bash", count: 11 },
            ])
        ).toEqual([
            { verb: "Bash", count: 11, dim: false },
            { verb: "Edit", count: 2, dim: true },
        ]);
    });
});

describe("filesSummary", () => {
    it("totals the changed lines", () => {
        expect(
            filesSummary([
                { adds: 30, dels: 2 },
                { adds: 7, dels: 15 },
            ])
        ).toBe("2 files · +37 −17");
        expect(filesSummary([{ adds: 1, dels: 0 }])).toBe("1 file · +1 −0");
    });
});

describe("linkedWorktree", () => {
    const main = { path: "C:\\src\\arc-api", branch: "main", ismain: true };
    const wt = { path: "C:\\src\\arc-api\\.waveterm\\worktrees\\r-1\\t-3", branch: "run/t-3" };
    const outside = { path: "D:/wt/arc-api-agent", branch: "arc-api-agent" };

    it("names a worktree under the main checkout by its path from there", () => {
        expect(linkedWorktree("C:/src/arc-api/.waveterm/worktrees/r-1/t-3", [main, wt])).toBe(
            ".waveterm/worktrees/r-1/t-3"
        );
        expect(linkedWorktree("c:\\src\\arc-api\\.waveterm\\worktrees\\r-1\\t-3\\pkg", [main, wt])).toBe(
            ".waveterm/worktrees/r-1/t-3"
        );
    });

    it("names a worktree outside the main checkout by its full path", () => {
        expect(linkedWorktree("D:/wt/arc-api-agent", [main, outside])).toBe("D:/wt/arc-api-agent");
    });

    it("says nothing in the main checkout or outside every worktree", () => {
        expect(linkedWorktree("C:/src/arc-api/pkg", [main, wt])).toBeUndefined();
        expect(linkedWorktree("C:/elsewhere", [main, wt])).toBeUndefined();
        expect(linkedWorktree("C:/src/arc-api", [])).toBeUndefined();
    });
});
