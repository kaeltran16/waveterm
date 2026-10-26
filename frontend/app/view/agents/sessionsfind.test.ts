// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { forgetOrigin } from "@/app/view/jarvis/returnsurface";
import { atom, type PrimitiveAtom } from "jotai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentsViewModel, SurfaceKey } from "./agents";
import { findEnded, findRanges, findTerms, openSessionHit, stepFind, type SessionsFind } from "./sessionsfind";
import { LEAD_MEMBER, sessionKey, sessionSelection } from "./sessionsruns";

function fakeModel() {
    return {
        surfaceAtom: atom<SurfaceKey>("cockpit"),
        sessionsSelAtom: atom<string>("all"),
        sessionsMemberAtom: atom<string>("lead"),
        sessionsViewAtom: atom<"transcript" | "activity">("transcript"),
        sessionsQueryAtom: atom<string>(""),
        sessionsFindAtom: atom<SessionsFind | null>(null) as PrimitiveAtom<SessionsFind | null>,
    } as unknown as AgentsViewModel;
}

function session(over: Partial<SessionActivity> = {}): SessionActivity {
    return {
        id: "s1",
        runtime: "claude",
        projectpath: "/p",
        projectname: "p",
        lastactivets: 1,
        status: "done",
        startedts: 0,
        durationms: 0,
        events: [],
        ...over,
    } as SessionActivity;
}

function hit(kind: "turn" | "event", ord: number): SessionHit {
    return { kind, speaker: kind === "turn" ? "agent" : "committed", ord, text: "x", marks: [[0, 1]] };
}

function result(s: SessionActivity, hits: SessionHit[]): SessionSearchResult {
    return {
        session: s,
        hits,
        turnhits: hits.filter((h) => h.kind === "turn").length,
        eventhits: hits.filter((h) => h.kind === "event").length,
    };
}

afterEach(() => forgetOrigin());

describe("openSessionHit", () => {
    it("openSessionHit opens a solo turn hit on the transcript", () => {
        const m = fakeModel();
        const r = result(session(), [hit("turn", 0), hit("turn", 1), hit("turn", 2), hit("event", 0)]);
        openSessionHit(m, r, "flaky test", ["flaky", "test"], r.hits[2]);
        expect(globalStore.get(m.sessionsSelAtom)).toBe("claude:s1");
        expect(globalStore.get(m.sessionsViewAtom)).toBe("transcript");
        expect(globalStore.get(m.sessionsQueryAtom)).toBe("flaky test");
        expect(globalStore.get(m.sessionsFindAtom)).toEqual({
            sessionKey: "claude:s1",
            query: "flaky test",
            terms: ["flaky", "test"],
            target: { kind: "turn", ord: 2 },
            at: { sel: "claude:s1" },
        });
        expect(globalStore.get(m.surfaceAtom)).toBe("sessions");
    });

    it("openSessionHit opens an event hit on the activity view", () => {
        const m = fakeModel();
        const r = result(session(), [hit("event", 3)]);
        openSessionHit(m, r, "fix", ["fix"], r.hits[0]);
        expect(globalStore.get(m.sessionsViewAtom)).toBe("activity");
        expect(globalStore.get(m.sessionsFindAtom)?.target).toEqual({ kind: "event", ord: 3 });
    });

    it("openSessionHit opens a run member inside its run", () => {
        const m = fakeModel();
        const r = result(session({ runid: "r9", role: "worker", taskid: "t-2" }), [hit("turn", 0)]);
        openSessionHit(m, r, "fix", ["fix"]);
        expect(globalStore.get(m.sessionsSelAtom)).toBe("run:r9");
        expect(globalStore.get(m.sessionsMemberAtom)).toBe("t-2");
        expect(globalStore.get(m.sessionsFindAtom)?.sessionKey).toBe("claude:s1");
    });

    it("openSessionHit with no hits targets turn 0", () => {
        const m = fakeModel();
        globalStore.set(m.sessionsViewAtom, "activity");
        openSessionHit(m, result(session(), []), "fix", ["fix"]);
        expect(globalStore.get(m.sessionsViewAtom)).toBe("transcript");
        expect(globalStore.get(m.sessionsFindAtom)?.target).toEqual({ kind: "turn", ord: 0 });
    });
});

describe("stepFind", () => {
    it("stepFind wraps both ways", () => {
        expect(stepFind(1, 4, 1)).toBe(2);
        expect(stepFind(3, 4, 1)).toBe(0);
        expect(stepFind(0, 4, -1)).toBe(3);
        expect(stepFind(2, 4, -1)).toBe(1);
    });

    it("stepFind with no matches stays 0", () => {
        expect(stepFind(0, 0, 1)).toBe(0);
        expect(stepFind(0, 0, -1)).toBe(0);
    });
});

describe("findRanges", () => {
    const slices = (text: string, terms: string[]) => findRanges(text, terms).map(([s, e]) => text.slice(s, e));

    it("findRanges finds every term case-insensitively in order", () => {
        const text = "Timeout in the HOOK, then another timeout";
        expect(findRanges(text, ["hook", "timeout"])).toEqual([
            [0, 7],
            [15, 19],
            [34, 41],
        ]);
        expect(findRanges(text, ["zebra"])).toEqual([]);
    });

    it("findRanges treats a phrase as one term", () => {
        expect(slices("Dial timeout, then timeout dial", ["dial timeout"])).toEqual(["Dial timeout"]);
    });

    it("findRanges keeps offsets right after an emoji and with diacritics", () => {
        const text = "🙂 Lỗi kết nối, lỗi";
        expect(slices(text, ["lỗi"])).toEqual(["Lỗi", "lỗi"]);
        expect(findRanges(text, ["lỗi"])[0]).toEqual([3, 6]);
    });

    it("findRanges merges overlapping terms", () => {
        expect(findRanges("a timeout", ["time", "timeout"])).toEqual([[2, 9]]);
    });

    it("findRanges resumes past each occurrence and keeps touching ranges apart", () => {
        expect(findRanges("aaaa", ["aa"])).toEqual([
            [0, 2],
            [2, 4],
        ]);
        expect(findRanges("aaa", ["aa"])).toEqual([[0, 2]]);
    });
});

describe("findTerms", () => {
    it("findTerms splits words and keeps a quoted phrase", () => {
        expect(findTerms("Hook  Timeout")).toEqual(["hook", "timeout"]);
        expect(findTerms('"dial timeout" warm')).toEqual(["dial timeout", "warm"]);
        expect(findTerms('"open')).toEqual(["open"]);
    });

    it("findTerms of an empty or bare-quote query is empty", () => {
        for (const q of ["", "   ", '"', '""']) {
            expect(findTerms(q)).toEqual([]);
        }
    });
});

describe("findEnded", () => {
    const worker = session({ id: "w1", runid: "r9", role: "worker", taskid: "t-2" });
    const solo = session({ id: "a" });
    const findOf = (s: SessionActivity): SessionsFind => {
        const m = fakeModel();
        openSessionHit(m, result(s, [hit("turn", 0)]), "fix", ["fix"]);
        return globalStore.get(m.sessionsFindAtom)!;
    };

    it("findEnded keeps a find whose run member was just selected", () => {
        const to = sessionSelection(worker);
        expect(findEnded(findOf(worker), to.sel, to.member!)).toBe(false);
    });

    it("findEnded keeps a find whose solo was just selected", () => {
        // the member atom keeps whatever run member was last in view; a solo selection ignores it
        expect(findEnded(findOf(solo), sessionSelection(solo).sel, "t-7")).toBe(false);
    });

    it("findEnded ends a find when another session is selected", () => {
        expect(findEnded(findOf(solo), sessionKey(session({ id: "b" })), "lead")).toBe(true);
        expect(findEnded(findOf(worker), sessionSelection(worker).sel, LEAD_MEMBER)).toBe(true);
        expect(findEnded(findOf(worker), sessionKey(solo), "t-2")).toBe(true);
    });

    it("findEnded leaves a find set on the merged feed", () => {
        expect(findEnded(findOf(solo), "all", "lead")).toBe(false);
    });

    it("findEnded is false with no find", () => {
        expect(findEnded(null, "claude:a", "lead")).toBe(false);
    });
});
