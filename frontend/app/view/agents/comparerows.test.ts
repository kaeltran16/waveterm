// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    AGGREGATE,
    buildCompareRows,
    compareNavIds,
    formSentence,
    sideJumpTarget,
    splitLabel,
    type CompareRow,
} from "./comparerows";
import type { GitChanges } from "./gitstatus";

const NOW = 1_700_000_000_000;

function commit(hash: string, subject: string, agoMs = 3_600_000): HistoryCommit {
    return {
        hash,
        parents: [],
        subject,
        author: "dana k",
        email: "dana@example.com",
        ts: NOW - agoMs,
        refs: [],
    } as HistoryCommit;
}

const AGG: GitChanges = {
    files: [
        { path: "src/a.ts", status: "M", adds: 10, dels: 2 },
        { path: "src/b.ts", status: "A", adds: 4, dels: 0 },
    ],
    adds: 14,
    dels: 2,
};

function rows(over: Partial<Parameters<typeof buildCompareRows>[0]> = {}): CompareRow[] {
    return buildCompareRows({
        base: "main",
        head: "feature/idem",
        ahead: [commit("aaa1111", "feature two"), commit("aaa2222", "feature one")],
        behind: [commit("bbb1111", "main one")],
        aggregate: AGG,
        now: NOW,
        ...over,
    });
}

describe("buildCompareRows", () => {
    it("puts the aggregate first, then head's group, then base's", () => {
        expect(rows().map((r) => r.kind)).toEqual(["aggregate", "header", "commit", "commit", "header", "commit"]);
    });

    it("labels each header with its ref, side and count", () => {
        const [, headHeader, , , baseHeader] = rows();
        expect(headHeader).toMatchObject({ kind: "header", side: "head", ref: "feature/idem", count: 2 });
        expect(baseHeader).toMatchObject({ kind: "header", side: "base", ref: "main", count: 1 });
        expect((headHeader as any).note).toBe("2 ahead");
        expect((baseHeader as any).note).toBe("1 behind");
    });

    it("carries the aggregate's file count and totals on the aggregate row", () => {
        expect(rows()[0]).toMatchObject({ kind: "aggregate", id: AGGREGATE, files: 2, adds: 14, dels: 2 });
    });

    it("shows the aggregate row as pending when the aggregate has not loaded", () => {
        expect(rows({ aggregate: null })[0]).toMatchObject({ kind: "aggregate", files: null });
    });

    it("tags every commit row with its side and keeps HistoryRow fields", () => {
        const commits = rows().filter((r) => r.kind === "commit") as any[];
        expect(commits.map((c) => c.side)).toEqual(["head", "head", "base"]);
        expect(commits[0]).toMatchObject({ hash: "aaa1111", subject: "feature two", author: "dana k" });
        expect(commits[0].when).toBe("1h"); // formatted through historyrows' shared mapper
        expect(commits[0].refs).toEqual([]);
    });

    it("omits a side's header entirely when that side has no commits", () => {
        const only = rows({ behind: [] });
        expect(only.filter((r) => r.kind === "header")).toHaveLength(1);
        expect(only.map((r) => r.kind)).toEqual(["aggregate", "header", "commit", "commit"]);
    });

    it("still yields the aggregate row when neither side diverges", () => {
        expect(rows({ ahead: [], behind: [] }).map((r) => r.kind)).toEqual(["aggregate"]);
    });
});

describe("compareNavIds", () => {
    it("lists the aggregate and every commit, excluding headers, in column order", () => {
        expect(compareNavIds(rows())).toEqual([AGGREGATE, "aaa1111", "aaa2222", "bbb1111"]);
    });

    it("is just the aggregate when nothing diverges", () => {
        expect(compareNavIds(rows({ ahead: [], behind: [] }))).toEqual([AGGREGATE]);
    });
});

describe("sideJumpTarget", () => {
    it("goes from the aggregate to head's first commit", () => {
        expect(sideJumpTarget(rows(), AGGREGATE)).toBe("aaa1111");
    });

    it("crosses from a head commit to base's first commit", () => {
        expect(sideJumpTarget(rows(), "aaa2222")).toBe("bbb1111");
    });

    it("crosses back from a base commit to head's first commit", () => {
        expect(sideJumpTarget(rows(), "bbb1111")).toBe("aaa1111");
    });

    it("returns null when the other side has no commits", () => {
        expect(sideJumpTarget(rows({ behind: [] }), "aaa1111")).toBeNull();
    });

    it("returns null for an unknown row id", () => {
        expect(sideJumpTarget(rows(), "nope")).toBeNull();
    });
});

describe("the aggregate row", () => {
    it("reads All changes", () => {
        const rows = buildCompareRows({ base: "main", head: "x", ahead: [], behind: [], aggregate: null, now: 0 });
        expect(rows[0]).toMatchObject({ kind: "aggregate", label: "All changes" });
    });
});

describe("formSentence", () => {
    it("says what the merge-base form leaves out", () => {
        expect(formSentence("mergebase", "main", "exp-native", "7a4155cdead")).toBe(
            "Only what exp-native added since the two split at 7a4155c. Commits main gained since are left out."
        );
    });
    it("says what tip to tip includes", () => {
        expect(formSentence("tips", "main", "exp-native", "7a4155cdead")).toBe(
            "Everything that differs between the two tips, including what main gained since the split."
        );
    });
    it("does not print an empty hash when there is no merge base", () => {
        expect(formSentence("mergebase", "main", "x", "")).toBe(
            "Only what x added since the two split. Commits main gained since are left out."
        );
    });
});

describe("splitLabel", () => {
    const DAY = 86_400_000;
    it("names the merge base and how long ago it was", () => {
        expect(splitLabel("7a4155cdead", 1_000, 1_000 + 7 * DAY)).toBe("split at 7a4155c · 7d ago");
    });
    it("omits the age it does not know", () => {
        expect(splitLabel("7a4155cdead", 0, 5 * DAY)).toBe("split at 7a4155c");
    });
    it("is empty without a merge base", () => {
        expect(splitLabel("", 0, 0)).toBe("");
    });
});
