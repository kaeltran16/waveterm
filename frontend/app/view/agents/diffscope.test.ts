// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    availableRanges,
    defaultRangeFor,
    historyKey,
    historyOptsFor,
    originCwd,
    pollAnchor,
    rangeKey,
    scopeKey,
    summaryLine,
    type DiffRange,
    type DiffScope,
} from "./diffscope";
import { NO_FILTERS } from "./historyquery";
import { reviewSubjectFor } from "./reviewmarks";

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
    it("offers working tree, the agent's edits, session and compare for a Claude agent", () => {
        expect(kinds(agentScope)).toEqual(["working", "edits", "session", "compare"]);
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
        const opts = availableRanges(
            { ...agentScope, range: { kind: "working" } },
            { sessionStartTs: null, sessionRef: "" }
        );
        const session = opts.find((o) => o.range.kind === "session");
        expect(session?.available).toBe(false);
        expect(session?.reason).toBe("no session-start commit recorded yet");
    });

    // the active range measures from HEAD until the start resolves; a disabled active chip would
    // claim the panes show nothing
    it("draws the active session chip enabled with 'not yet' when no start has resolved", () => {
        const session = availableRanges(agentScope, { sessionStartTs: null, sessionRef: "" }).find(
            (o) => o.range.kind === "session"
        );
        expect(session?.available).toBe(true);
        expect(session?.detail).toBe("not yet");
        expect(session?.reason).toBe("no session-start commit recorded yet");
    });

    it("omits Compare outside a git repository", () => {
        const ctx = { sessionStartTs: 1719000000, sessionRef: "a3f9c21" };
        expect(availableRanges(projectScope, { ...ctx, isRepo: false }).map((o) => o.range.kind)).toEqual(["working"]);
        expect(availableRanges(projectScope, { ...ctx, isRepo: true }).map((o) => o.range.kind)).toEqual([
            "working",
            "compare",
        ]);
    });

    it("offers a landed run's range bounded at its tip", () => {
        const landed: DiffScope = {
            repo: {
                origin: { kind: "run", runId: "r1", cwd: "/repo", baseCommit: "9f2c1de", headCommit: "c0ffee1" },
                label: "run",
            },
            range: { kind: "working" },
        };
        const run = availableRanges(landed, { sessionStartTs: null, sessionRef: "" }).find(
            (o) => o.range.kind === "run"
        );
        expect(run?.range).toEqual({ kind: "run", runId: "r1", baseCommit: "9f2c1de", headCommit: "c0ffee1" });
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

describe("rangeKey of a run", () => {
    // review marks persist by this key, so an unbounded run must keep the key it always had
    it("keeps today's key for an unbounded run", () => {
        expect(rangeKey({ kind: "run", runId: "r1", baseCommit: "9f2c1de" })).toBe("run:r1:9f2c1de");
    });

    it("appends the tip for a landed run", () => {
        expect(rangeKey({ kind: "run", runId: "r1", baseCommit: "9f2c1de", headCommit: "c0ffee1" })).toBe(
            "run:r1:9f2c1de:c0ffee1"
        );
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

    // walking every ref and walking from HEAD are different answers from git
    it("changes when the walked ref changes", () => {
        expect(historyKey("/repo", NO_FILTERS)).not.toBe(historyKey("/repo", NO_FILTERS, "HEAD"));
        expect(historyKey("/repo", NO_FILTERS, "HEAD")).not.toBe(historyKey("/repo", NO_FILTERS, "c0ffee1"));
        expect(historyKey("/repo", NO_FILTERS)).toBe(historyKey("/repo", NO_FILTERS, ""));
    });
});

describe("historyOptsFor", () => {
    it("labels the session anchor and names what the top row counts", () => {
        expect(historyOptsFor({ kind: "session", agentId: "a1" }, "base9")).toEqual({
            anchor: "base9",
            anchorLabel: "session start",
            rowLabel: "Since session start",
            ref: "HEAD",
        });
    });

    // --all would list other branches' commits above the anchor; the scope's own head does not
    it("walks a session from HEAD even before its start resolves", () => {
        expect(historyOptsFor({ kind: "session", agentId: "a1" }, "")).toEqual({ ref: "HEAD" });
    });

    it("walks a landed run from its tip", () => {
        expect(historyOptsFor({ kind: "run", runId: "r1", baseCommit: "9f2c1de", headCommit: "c0ffee1" }, "")).toEqual({
            anchor: "9f2c1de",
            anchorLabel: "run base",
            rowLabel: "Run changes",
            ref: "c0ffee1",
        });
    });

    it("walks every ref in compare", () => {
        const compare = {
            kind: "compare",
            base: "a",
            head: "b",
            form: "mergebase",
            from: { kind: "working" },
        } as const;
        expect(historyOptsFor(compare, "")).toStrictEqual({});
    });

    it("labels the run's base commit", () => {
        expect(historyOptsFor({ kind: "run", runId: "r1", baseCommit: "9f2c1de" }, "")).toEqual({
            anchor: "9f2c1de",
            anchorLabel: "run base",
            rowLabel: "Run changes",
            ref: "HEAD",
        });
    });

    // No label on purpose: in the working-tree range the top row's count really is uncommitted work
    // against HEAD, so naming it would be noise.
    it("gives the working-tree range no anchor and no label", () => {
        expect(historyOptsFor({ kind: "working" }, "")).toStrictEqual({});
    });
});

describe("compare range", () => {
    it("carries the range it interrupted so leaving restores it", () => {
        const interrupted = { kind: "session", agentId: "a1" } as const;
        const compare = { kind: "compare", base: "main", head: "feat", form: "mergebase", from: interrupted } as const;
        expect(compare.from).toEqual(interrupted);
    });

    it("is a distinct scope identity per ref pair", () => {
        const a: DiffScope = {
            ...agentScope,
            range: { kind: "compare", base: "main", head: "feat", form: "mergebase", from: { kind: "working" } },
        };
        const b: DiffScope = {
            ...agentScope,
            range: { kind: "compare", base: "main", head: "other", form: "mergebase", from: { kind: "working" } },
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
    it("opens a pi agent on its session, a project on its working tree, and a run on the run", () => {
        expect(defaultRangeFor({ kind: "agent", id: "a1", runtime: "pi" })).toEqual({ kind: "session", agentId: "a1" });
        expect(defaultRangeFor({ kind: "project", name: "w", path: "/r" })).toEqual({ kind: "working" });
        expect(defaultRangeFor({ kind: "run", runId: "r1", cwd: "/r", baseCommit: "9f2c1de" })).toEqual({
            kind: "run",
            runId: "r1",
            baseCommit: "9f2c1de",
        });
    });

    it("carries a landed run's tip into its range", () => {
        expect(
            defaultRangeFor({ kind: "run", runId: "r1", cwd: "/r", baseCommit: "9f2c1de", headCommit: "c0ffee1" })
        ).toEqual({ kind: "run", runId: "r1", baseCommit: "9f2c1de", headCommit: "c0ffee1" });
    });
});

const ch = (n: number, adds = 10, dels = 2) =>
    ({
        files: Array.from({ length: n }, (_, i) => ({ path: `f${i}`, status: "M", adds: 1, dels: 0 })),
        adds,
        dels,
    }) as any;
const base = { branch: "main", ref: "", mergeBase: "", commit: null as string | null };

describe("summaryLine follows what the panes show", () => {
    it("counts uncommitted files on the branch, against HEAD", () => {
        expect(summaryLine({ ...base, range: { kind: "working" }, changes: ch(15, 661, 403) })).toBe(
            "15 uncommitted files on main · +661 −403"
        );
    });
    it("says against HEAD when detached", () => {
        expect(summaryLine({ ...base, branch: "", range: { kind: "working" }, changes: ch(1) })).toBe(
            "1 uncommitted file against HEAD · +10 −2"
        );
        expect(summaryLine({ ...base, branch: "HEAD", range: { kind: "working" }, changes: ch(1) })).toBe(
            "1 uncommitted file against HEAD · +10 −2"
        );
    });
    it("describes a selected commit, not the range", () => {
        expect(summaryLine({ ...base, commit: "3eaffac99", range: { kind: "working" }, changes: ch(1, 2, 2) })).toBe(
            "3eaffac · 1 file · +2 −2"
        );
    });
    // the ref picker beside the summary names both refs, so the summary names none
    it("reads the merge-base comparison from its merge base, naming no ref", () => {
        const range = {
            kind: "compare",
            base: "main",
            head: "exp-native",
            form: "mergebase",
            from: { kind: "working" },
        } as const;
        expect(summaryLine({ ...base, mergeBase: "7a4155cff", range, changes: ch(31, 764, 88) })).toBe(
            "since 7a4155c · 31 files · +764 −88"
        );
    });
    it("reads tip to tip naming no ref", () => {
        const range = { kind: "compare", base: "main", head: "x", form: "tips", from: { kind: "working" } } as const;
        expect(summaryLine({ ...base, range, changes: ch(2) })).toBe("tip to tip · 2 files · +10 −2");
    });
    it("keeps the run and session phrasing for their top rows", () => {
        expect(
            summaryLine({ ...base, range: { kind: "run", runId: "r", baseCommit: "b41d000aa" }, changes: ch(3) })
        ).toBe("b41d000 … HEAD · 3 files · +10 −2");
        expect(
            summaryLine({ ...base, ref: "9f2c1de00", range: { kind: "session", agentId: "a" }, changes: ch(3) })
        ).toBe("worktree against 9f2c1de · 3 files · +10 −2");
    });
    it("bounds a landed run's summary at its tip", () => {
        expect(
            summaryLine({
                ...base,
                range: { kind: "run", runId: "r", baseCommit: "b41d000aa", headCommit: "c0ffee123" },
                changes: ch(3),
            })
        ).toBe("b41d000 … c0ffee1 · 3 files · +10 −2");
    });
    it("says a session with no start yet is measured against HEAD", () => {
        expect(summaryLine({ ...base, range: { kind: "session", agentId: "a" }, changes: ch(3) })).toBe(
            "3 files against HEAD (no session start yet) · +10 −2"
        );
        expect(summaryLine({ ...base, range: { kind: "session", agentId: "a" }, changes: ch(1) })).toBe(
            "1 file against HEAD (no session start yet) · +10 −2"
        );
    });
    it("drops the line delta when the counts are unknown, keeping the file count", () => {
        const unknown = { ...base, lineCounts: false };
        expect(summaryLine({ ...unknown, range: { kind: "working" }, changes: ch(7) })).toBe(
            "7 uncommitted files on main"
        );
        expect(
            summaryLine({ ...unknown, ref: "9f2c1de00", range: { kind: "session", agentId: "a" }, changes: ch(3) })
        ).toBe("worktree against 9f2c1de · 3 files");
        expect(summaryLine({ ...unknown, range: { kind: "session", agentId: "a" }, changes: ch(3) })).toBe(
            "3 files against HEAD (no session start yet)"
        );
    });
});

describe("compare range form", () => {
    const mergebase: DiffRange = {
        kind: "compare",
        base: "main",
        head: "feature",
        form: "mergebase",
        from: { kind: "working" },
    };

    // the key is what drops stale reads, so two forms of the same pair must not share one
    it("distinguishes the two forms in rangeKey", () => {
        expect(rangeKey(mergebase)).not.toBe(rangeKey({ ...mergebase, form: "tips" }));
    });

    it("names the active form in the summary line", () => {
        const input = { branch: "feature", ref: "", mergeBase: "7a4155cff", commit: null, changes: null };
        expect(summaryLine({ ...input, range: mergebase })).toContain("since 7a4155c");
        expect(summaryLine({ ...input, range: { ...mergebase, form: "tips" } })).toContain("tip to tip");
    });

    // unrelated histories have no merge base (or it is still loading): no "since" with an empty hash
    it("reads the counts alone when there is no merge base", () => {
        const input = { branch: "feature", ref: "", mergeBase: "", commit: null, changes: null };
        expect(summaryLine({ ...input, range: mergebase })).toBe("0 files · +0 −0");
    });
});

// a session whose start was not known at load keeps measuring from HEAD until a poll tick re-reads it
describe("pollAnchor", () => {
    const session: DiffRange = { kind: "session", agentId: "a1" };

    it("reads with the session start once it is known and no ref resolved yet", () => {
        expect(pollAnchor(session, "", "", 1700000000)).toStrictEqual({ sessionStartTs: 1700000000 });
    });

    it("keeps the live read while the session start is still unknown", () => {
        expect(pollAnchor(session, "", "", null)).toStrictEqual({ ref: "", end: "" });
    });

    it("keeps an already-resolved session ref whatever the start", () => {
        expect(pollAnchor(session, "base9", "", 1700000000)).toStrictEqual({ ref: "base9", end: "" });
        expect(pollAnchor(session, "base9", "", null)).toStrictEqual({ ref: "base9", end: "" });
    });

    it("keeps the ref and end of every other range", () => {
        const run: DiffRange = { kind: "run", runId: "r1", baseCommit: "9f2c1de", headCommit: "c0ffee1" };
        const compare: DiffRange = { kind: "compare", base: "a", head: "b", form: "mergebase", from: session };
        expect(pollAnchor(run, "9f2c1de", "c0ffee1", 1700000000)).toStrictEqual({ ref: "9f2c1de", end: "c0ffee1" });
        expect(pollAnchor({ kind: "working" }, "", "", 1700000000)).toStrictEqual({ ref: "", end: "" });
        expect(pollAnchor(compare, "", "", 1700000000)).toStrictEqual({ ref: "", end: "" });
    });
});

describe("the Agent's edits range", () => {
    const edits: DiffRange = { kind: "edits", agentId: "a1" };
    const agentOf = (runtime?: string): DiffScope => ({
        repo: { origin: { kind: "agent", id: "a1", runtime }, label: "a1" },
        range: { kind: "working" },
    });

    it("is the default range of a Claude agent, named or by the absent runtime", () => {
        expect(defaultRangeFor({ kind: "agent", id: "a1", runtime: "claude" })).toEqual(edits);
        expect(defaultRangeFor({ kind: "agent", id: "a1" })).toEqual(edits);
    });

    it("leaves pi, codex and opencode agents on their session range", () => {
        for (const runtime of ["pi", "codex", "opencode"]) {
            expect(defaultRangeFor({ kind: "agent", id: "a1", runtime })).toEqual({ kind: "session", agentId: "a1" });
        }
    });

    it("lists the edits chip for a Claude agent, beside the session chip", () => {
        const ctx = { sessionStartTs: 1719000000, sessionRef: "" };
        for (const runtime of [undefined, "claude"]) {
            const opts = availableRanges(agentOf(runtime), ctx);
            expect(opts.map((o) => o.range.kind)).toEqual(["working", "edits", "session", "compare"]);
            const chip = opts.find((o) => o.range.kind === "edits");
            expect(chip).toMatchObject({ range: edits, label: "Agent's edits", available: true });
        }
    });

    it("lists no edits chip for an agent the range can never apply to", () => {
        for (const runtime of ["pi", "codex", "opencode"]) {
            expect(kinds(agentOf(runtime))).toEqual(["working", "session", "compare"]);
        }
        expect(kinds(projectScope)).not.toContain("edits");
        expect(kinds(runScope)).not.toContain("edits");
    });

    it("keys on the agent, and review marks key on the cwd and that range", () => {
        expect(rangeKey(edits)).toBe("edits:a1");
        expect(reviewSubjectFor("/repo", edits, null)).toBe("/repo|edits:a1");
    });

    // B and H are synthetic commits, so the history column lists none of them
    it("reads no commit list, and names the scope's own row", () => {
        expect(historyOptsFor(edits, "b0b0b0b")).toEqual({ noCommits: true, rowLabel: "Agent's edits" });
    });

    describe("caption", () => {
        const at = { ...base, range: edits, ref: "b0b0b0b" };

        it("states the file count, with no Bash sentence when no Bash call ran", () => {
            expect(summaryLine({ ...at, changes: ch(3), bashCalls: 0 })).toBe("3 files by this agent · +10 −2");
            expect(summaryLine({ ...at, changes: ch(1) })).toBe("1 file by this agent · +10 −2");
        });

        it("says how many Bash calls may have changed files not shown", () => {
            expect(summaryLine({ ...at, changes: ch(3), bashCalls: 1 })).toBe(
                "3 files by this agent · +10 −2 · 1 Bash call may have changed files not shown"
            );
            expect(summaryLine({ ...at, changes: ch(2), bashCalls: 4 })).toBe(
                "2 files by this agent · +10 −2 · 4 Bash calls may have changed files not shown"
            );
        });

        it("shows the reason when there is no base to show", () => {
            expect(
                summaryLine({ ...at, ref: "", changes: ch(0), bashCalls: 2, reason: "no Edit or Write calls yet" })
            ).toBe("no Edit or Write calls yet");
        });
    });
});
