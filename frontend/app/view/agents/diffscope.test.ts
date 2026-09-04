// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    availableRanges,
    defaultRangeFor,
    historyKey,
    historyOptsFor,
    originCwd,
    rangeSummary,
    scopeKey,
    summaryLine,
    type DiffScope,
} from "./diffscope";
import type { GitChanges } from "./gitstatus";
import { NO_FILTERS } from "./historyquery";

const agentScope: DiffScope = {
    repo: { origin: { kind: "agent", id: "a1" }, label: "jarvis-recall" },
    range: { kind: "session", agentId: "a1" },
};
const projectScope: DiffScope = {
    repo: { origin: { kind: "project", name: "waveterm", path: "/repo" }, label: "waveterm" },
    range: { kind: "working" },
};
const runScope: DiffScope = {
    repo: { origin: { kind: "run", runId: "r1", cwd: "/repo", baseCommit: "9f2c1de" }, label: "run 9f2c1de" },
    range: { kind: "run", runId: "r1", baseCommit: "9f2c1de" },
};

const kinds = (s: DiffScope, ctx = { sessionStartTs: 1719000000, sessionRef: "a3f9c21" }) =>
    availableRanges(s, ctx).map((o) => o.range.kind);

describe("availableRanges", () => {
    // The whole point of the refactor: a chip is drawn only when it has something to switch to, so
    // no permanently-inert control can exist in the bar.
    it("offers working tree, session and compare for an agent", () => {
        expect(kinds(agentScope)).toEqual(["working", "session", "compare"]);
        expect(
            availableRanges(agentScope, { sessionStartTs: 1719000000, sessionRef: "a3f9c21" }).every((o) => o.available)
        ).toBe(true);
    });

    it("omits the session range entirely for a project — there is no session to anchor on", () => {
        expect(kinds(projectScope)).toEqual(["working", "compare"]);
    });

    it("offers the run range only when the repository came from a run", () => {
        expect(kinds(runScope)).toEqual(["working", "run", "compare"]);
        expect(kinds(agentScope)).not.toContain("run");
        expect(kinds(projectScope)).not.toContain("run");
    });

    // Temporary unavailability is drawn, not hidden: the chip becomes live on its own once the
    // transcript lands, and hiding it would report a passing state as an impossible one.
    it("keeps the session chip but disables it with a reason when no session start has resolved", () => {
        const opts = availableRanges(agentScope, { sessionStartTs: null, sessionRef: "" });
        const session = opts.find((o) => o.range.kind === "session");
        expect(session?.available).toBe(false);
        expect(session?.reason).toBe("no session-start commit recorded yet");
    });

    it("shows the resolved commit beside the session chip only once it is the active range", () => {
        const active = availableRanges(agentScope, { sessionStartTs: 1719000000, sessionRef: "a3f9c21" });
        expect(active.find((o) => o.range.kind === "session")?.detail).toBe("a3f9c21");
        const inactive = availableRanges(
            { ...agentScope, range: { kind: "working" } },
            { sessionStartTs: 1719000000, sessionRef: "" }
        );
        expect(inactive.find((o) => o.range.kind === "session")?.detail).toBe("");
    });
});

describe("scopeKey", () => {
    // Load-bearing: githistorystore compares this against the previous load to tell a remount from a
    // genuine subject change, which is what keeps scroll offset and selection across a nav switch.
    it("is stable for the same scope", () => {
        expect(scopeKey(agentScope)).toBe(scopeKey({ ...agentScope }));
    });

    it("separates an agent, a project and a run that all answer to the same id", () => {
        const keys = new Set([
            scopeKey({ repo: { origin: { kind: "agent", id: "x" }, label: "x" }, range: { kind: "working" } }),
            scopeKey({
                repo: { origin: { kind: "project", name: "x", path: "/x" }, label: "x" },
                range: { kind: "working" },
            }),
            scopeKey({
                repo: { origin: { kind: "run", runId: "x", cwd: "/x", baseCommit: "" }, label: "x" },
                range: { kind: "working" },
            }),
        ]);
        expect(keys.size).toBe(3);
    });

    it("changes when the range changes, so a stale change-list read cannot land on a new range", () => {
        expect(scopeKey(agentScope)).not.toBe(scopeKey({ ...agentScope, range: { kind: "working" } }));
    });
});

describe("historyKey", () => {
    // Decision 5 of the design: the commit list depends on directory and filters only. The anchor
    // never reaches git — it only labels a divider — so it must not sit in the identity that decides
    // whether to blank the list and scroll to the top.
    it("is stable for the same directory and filters", () => {
        expect(historyKey("/repo", NO_FILTERS)).toBe(historyKey("/repo", NO_FILTERS));
    });

    it("changes when a filter changes", () => {
        expect(historyKey("/repo", NO_FILTERS)).not.toBe(historyKey("/repo", { ...NO_FILTERS, author: "kael" }));
    });

    it("changes when the directory changes", () => {
        expect(historyKey("/repo", NO_FILTERS)).not.toBe(historyKey("/other", NO_FILTERS));
    });
});

describe("historyOptsFor", () => {
    it("labels the session anchor and names what the top row counts", () => {
        expect(historyOptsFor({ kind: "session", agentId: "a1" }, "base9")).toEqual({
            anchor: "base9",
            anchorLabel: "session start",
            rowLabel: "Since session start",
        });
    });

    it("labels the run's base commit", () => {
        expect(historyOptsFor({ kind: "run", runId: "r1", baseCommit: "9f2c1de" }, "")).toEqual({
            anchor: "9f2c1de",
            anchorLabel: "run base",
            rowLabel: "Run changes",
        });
    });

    // No label on purpose: in the working-tree range the top row's count really is uncommitted work
    // against HEAD, so naming it would be noise.
    it("gives the working-tree range no anchor and no label", () => {
        expect(historyOptsFor({ kind: "working" }, "")).toEqual({});
    });
});

describe("compare range", () => {
    it("carries the range it interrupted so leaving restores it", () => {
        const interrupted = { kind: "session", agentId: "a1" } as const;
        const compare = { kind: "compare", base: "main", head: "feat", from: interrupted } as const;
        expect(compare.from).toEqual(interrupted);
    });

    it("is a distinct scope identity per ref pair", () => {
        const a: DiffScope = {
            ...agentScope,
            range: { kind: "compare", base: "main", head: "feat", from: { kind: "working" } },
        };
        const b: DiffScope = {
            ...agentScope,
            range: { kind: "compare", base: "main", head: "other", from: { kind: "working" } },
        };
        expect(scopeKey(a)).not.toBe(scopeKey(b));
    });
});

describe("originCwd", () => {
    // An agent's directory is resolved asynchronously from its transcript, so it is the one origin
    // that cannot answer synchronously.
    it("answers for a project and a run, and defers for an agent", () => {
        expect(originCwd({ kind: "project", name: "waveterm", path: "/repo" })).toBe("/repo");
        expect(originCwd({ kind: "run", runId: "r1", cwd: "/repo", baseCommit: "x" })).toBe("/repo");
        expect(originCwd({ kind: "agent", id: "a1" })).toBeNull();
    });
});

describe("defaultRangeFor", () => {
    it("opens an agent on its session, a project on its working tree, and a run on the run", () => {
        expect(defaultRangeFor({ kind: "agent", id: "a1" })).toEqual({ kind: "session", agentId: "a1" });
        expect(defaultRangeFor({ kind: "project", name: "w", path: "/r" })).toEqual({ kind: "working" });
        expect(defaultRangeFor({ kind: "run", runId: "r1", cwd: "/r", baseCommit: "9f2c1de" })).toEqual({
            kind: "run",
            runId: "r1",
            baseCommit: "9f2c1de",
        });
    });
});

describe("rangeSummary", () => {
    it("says what is being compared against what, in words", () => {
        expect(
            rangeSummary(
                { kind: "session", agentId: "a1" },
                { branch: "main", ref: "a3f9c21", files: 12, adds: 340, dels: 82 }
            )
        ).toBe("worktree against a3f9c21 · 12 files · +340 −82");
    });

    it("names the branch when there is no anchor", () => {
        expect(rangeSummary({ kind: "working" }, { branch: "main", ref: "", files: 3, adds: 9, dels: 1 })).toBe(
            "uncommitted work against HEAD on main · 3 files · +9 −1"
        );
    });

    it("names both refs while comparing", () => {
        expect(
            rangeSummary(
                { kind: "compare", base: "main", head: "feat", from: { kind: "working" } },
                { branch: "feat", ref: "", files: 4, adds: 51, dels: 9 }
            )
        ).toBe("main … feat · 4 files · +51 −9");
    });
});

describe("summaryLine", () => {
    // The dirty working tree the shipped git-history fixture does not have: with a clean tree both
    // stores read zero and the wrong one is indistinguishable from the right one.
    const working: GitChanges = {
        files: Array(8).fill({ path: "f", status: "M", adds: 0, dels: 0 }),
        adds: 689,
        dels: 0,
    };
    const compared: GitChanges = {
        files: Array(1827).fill({ path: "f", status: "M", adds: 0, dels: 0 }),
        adds: 288262,
        dels: 177129,
    };

    it("reports the compared refs' counts while comparing, not the working tree's", () => {
        expect(
            summaryLine({
                range: { kind: "compare", base: "main", head: "feat/memory-redesign", from: { kind: "working" } },
                branch: "main",
                ref: "",
                changes: working,
                compareChanges: compared,
            })
        ).toBe("main … feat/memory-redesign · 1827 files · +288262 −177129");
    });

    it("reports the working tree's counts outside compare", () => {
        expect(
            summaryLine({
                range: { kind: "working" },
                branch: "main",
                ref: "",
                changes: working,
                compareChanges: compared,
            })
        ).toBe("uncommitted work against HEAD on main · 8 files · +689 −0");
    });

    it("reads zero while the compare load is still in flight", () => {
        expect(
            summaryLine({
                range: { kind: "compare", base: "main", head: "feat", from: { kind: "working" } },
                branch: "main",
                ref: "",
                changes: working,
                compareChanges: null,
            })
        ).toBe("main … feat · 0 files · +0 −0");
    });
});
