// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { buildBriefIndex, rankBriefRows } from "@/app/view/jarvis/briefpalette";
import { describe, expect, it } from "vitest";
import { mergeRanked } from "./palette-entities";
import { assembleDefaultGroups, capGroups } from "./palette-groups";

interface Row {
    key: string;
    search: string;
}

const row = (key: string, search: string): Row => ({ key, search });

const keys = (rows: Row[]) => rows.map((r) => r.key);

describe("mergeRanked", () => {
    it("leads with the better-scoring head whichever list it came from", () => {
        expect(keys(mergeRanked("usage", [row("weak", "unfinished stage")], [row("strong", "usage")]))).toEqual([
            "strong",
            "weak",
        ]);
        expect(keys(mergeRanked("usage", [row("strong", "usage")], [row("weak", "unfinished stage")]))).toEqual([
            "strong",
            "weak",
        ]);
    });

    it("preserves each list's own order rather than re-ranking it", () => {
        const primary = [row("p1", "login"), row("p2", "l0g1n log in")];
        const extra = [row("e1", "login record"), row("e2", "loading agin record")];
        const out = mergeRanked("login", primary, extra);
        expect(out).toHaveLength(4);
        expect(keys(out.filter((r) => r.key.startsWith("p")))).toEqual(["p1", "p2"]);
        expect(keys(out.filter((r) => r.key.startsWith("e")))).toEqual(["e1", "e2"]);
    });

    it("appends the extra list untouched when there is nothing to score against", () => {
        expect(keys(mergeRanked("   ", [row("p", "zzz")], [row("e", "aaa")]))).toEqual(["p", "e"]);
    });

    it("gives ties to the palette's own rows", () => {
        expect(keys(mergeRanked("run", [row("p", "run")], [row("e", "run")]))).toEqual(["p", "e"]);
    });

    it("drops nothing, including rows the query does not match at all", () => {
        expect(keys(mergeRanked("zzz", [row("p", "nothing here")], [row("e", "zzz")]))).toEqual(["e", "p"]);
        expect(keys(mergeRanked("x", [], [row("e", "x")]))).toEqual(["e"]);
        expect(keys(mergeRanked("x", [row("p", "x")], []))).toEqual(["p"]);
    });

    // The one property the merge exists to protect: rankBriefRows has already sunk archived rows below
    // every live one, and a well-matching archived row must not climb back over a weakly-matching live one.
    it("keeps an archived entry below its live sibling even when it matches better", () => {
        const index = buildBriefIndex({
            records: [
                { id: "live", objective: "loading agin", ticket: "", status: "active", updated: 1 },
                { id: "old", objective: "login", ticket: "", status: "archived", updated: 2 },
            ],
        });
        const brief = rankBriefRows(index, "login").rows.map((r) => row(r.key, r.search));
        const out = mergeRanked("login", [row("cmd", "login")], brief);
        expect(keys(out)).toEqual(["cmd", "record:live", "record:old"]);
    });
});

// A live regression: the palette used to pre-cap the brief ranking at MAX_PER_GROUP * 3 before the rows
// were split into their three groups. rankBriefRows sorts archived rows last across the WHOLE index, so
// once the live rows alone exceeded that cap the archived tail was sliced off and never reached a group —
// silently deleting the one thing this feature exists to make findable. Caught in the running app: 55
// records + 7 efforts = 62 rows against a cap of 60, and the profile's single archived effort vanished.
describe("the palette's brief pipeline", () => {
    const manyRecords = Array.from({ length: 55 }, (_, i) => ({
        id: `r${i}`,
        objective: `record ${i}`,
        ticket: "",
        status: "active",
        updated: 1000 - i,
    }));
    const effort = (id: string, status: string) => ({
        oref: `effort:${id}`,
        title: `initiative ${id}`,
        status,
        done: 0,
        total: 0,
        updatedts: 1,
    });

    function groupsFor(query: string) {
        const index = buildBriefIndex({
            records: manyRecords,
            efforts: [...Array.from({ length: 6 }, (_, i) => effort(`live${i}`, "active")), effort("old", "archived")],
        });
        const ranked = rankBriefRows(index, query, index.length).rows.map((r) => ({
            key: r.key,
            kind: r.kind,
            search: r.search,
        }));
        return capGroups(assembleDefaultGroups({ query, ranked, launchItems: [], askItems: [], recent: [] }));
    }

    it("lets an archived row reach its group even when live rows outnumber the old cap", () => {
        const efforts = groupsFor("").find((g) => g.kind === "effort");
        expect(efforts?.items.map((i) => i.key)).toContain("effort:effort:old");
    });

    it("caps per group and reports the overflow rather than truncating the whole ranking", () => {
        const groups = groupsFor("");
        const records = groups.find((g) => g.kind === "record");
        expect(records?.items).toHaveLength(20);
        expect(records?.overflow).toBe(35);
        // the effort group is untouched by the record group's overflow
        expect(groups.find((g) => g.kind === "effort")?.items).toHaveLength(7);
    });
});
