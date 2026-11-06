// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    ACTIVITY_WEEKS,
    calendar,
    lastWeek,
    lastWeekLine,
    moveFocus,
    projectDays,
    tooltipLines,
    type DayCell,
} from "./projectactivitymodel";

function bucket(session: string, day: string, tokens: number, model = "opus"): UsageBucket {
    return {
        harness: "claude",
        provider: "anthropic",
        model,
        day,
        session,
        input: tokens,
        output: 0,
        reasoning: 0,
        cacheread: 0,
        cachecreate: 0,
        cachecreate1h: 0,
        msgs: 1,
    };
}

function session(id: string, extra: Partial<UsageSession>): UsageSession {
    return { harness: "claude", session: id, ...extra };
}

function reply(buckets: UsageBucket[], sessions: UsageSession[]): CommandGetUsageStatsRtnData {
    return { buckets, sessions };
}

const PROJECT = { path: "C:\\Repo\\X", channelId: "ch-x" };

// local noon, so a day key never slides across midnight
const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).getTime();
const FRIDAY = at(2026, 11, 6);
const MONDAY = at(2026, 11, 9);
const SUNDAY = at(2026, 11, 8);

const allCells = (weeks: DayCell[][]) => weeks.flat();

describe("projectDays", () => {
    it("matches one project spelled with other slashes, case and a trailing slash", () => {
        const days = projectDays(
            reply(
                [bucket("a", "2026-11-01", 10), bucket("b", "2026-11-01", 20), bucket("c", "2026-11-01", 40)],
                [
                    session("a", { project: "C:\\Repo\\X\\" }),
                    session("b", { project: "c:/repo/x" }),
                    session("c", { project: "C:\\Repo\\X" }),
                ]
            ),
            { path: "C:\\Repo\\X" }
        );
        expect(days.get("2026-11-01")).toEqual({ tokens: 70, sessions: 3 });
    });

    it("counts a run worker in an arc-wt worktree through the project's channel", () => {
        const days = projectDays(
            reply(
                [bucket("w", "2026-11-02", 5)],
                [session("w", { project: "C:\\Users\\u\\AppData\\Local\\arc-wt\\abc", channelid: "ch-x" })]
            ),
            PROJECT
        );
        expect(days.get("2026-11-02")).toEqual({ tokens: 5, sessions: 1 });
    });

    it("leaves out sessions of other projects, other channels and buckets with no session", () => {
        const noSession = { ...bucket("", "2026-11-03", 99), session: undefined };
        const days = projectDays(
            reply(
                [bucket("o", "2026-11-03", 7), bucket("p", "2026-11-03", 8), noSession],
                [session("o", { project: "C:\\Repo\\Xy" }), session("p", { project: "D:\\Y", channelid: "ch-y" })]
            ),
            PROJECT
        );
        expect(days.size).toBe(0);
    });

    it("sums bucketTokens across a session's models and counts distinct sessions per day", () => {
        const both = {
            ...bucket("a", "2026-11-04", 1, "opus"),
            output: 2,
            reasoning: 3,
            cacheread: 4,
            cachecreate: 5,
            cachecreate1h: 100,
        };
        const days = projectDays(
            reply(
                [
                    both,
                    bucket("a", "2026-11-04", 10, "sonnet"),
                    bucket("b", "2026-11-04", 1),
                    bucket("a", "2026-11-05", 2),
                ],
                [session("a", { project: "C:\\Repo\\X" }), session("b", { project: "C:\\Repo\\X" })]
            ),
            PROJECT
        );
        // cachecreate1h is part of cachecreate, so bucketTokens leaves it out
        expect(days.get("2026-11-04")).toEqual({ tokens: 15 + 10 + 1, sessions: 2 });
        expect(days.get("2026-11-05")).toEqual({ tokens: 2, sessions: 1 });
    });
});

describe("calendar", () => {
    for (const [name, now, todayRow] of [
        ["Friday", FRIDAY, 4],
        ["Monday", MONDAY, 0],
        ["Sunday", SUNDAY, 6],
    ] as const) {
        it(`builds 53 Monday-first weeks with today in the last column on a ${name}`, () => {
            const { weeks } = calendar(new Map(), { now });
            expect(weeks).toHaveLength(ACTIVITY_WEEKS);
            for (const w of weeks) {
                expect(w).toHaveLength(7);
                expect(new Date(`${w[0].day}T12:00`).getDay()).toBe(1);
            }
            const last = weeks[ACTIVITY_WEEKS - 1];
            expect(last[todayRow].today).toBe(true);
            expect(allCells(weeks).filter((c) => c.today)).toHaveLength(1);
            last.forEach((c, row) => expect(c.state).toBe(row > todayRow ? "future" : "tracked"));
            expect(allCells(weeks.slice(0, -1)).every((c) => c.state === "tracked")).toBe(true);
        });
    }

    it("sets levels by quartile of the non-zero days, zero days at 0", () => {
        const days = new Map([
            ["2026-11-02", { tokens: 10, sessions: 1 }],
            ["2026-11-03", { tokens: 20, sessions: 1 }],
            ["2026-11-04", { tokens: 30, sessions: 1 }],
            ["2026-11-05", { tokens: 40, sessions: 1 }],
        ]);
        const cells = allCells(calendar(days, { now: FRIDAY }).weeks);
        const level = (day: string) => cells.find((c) => c.day === day)?.level;
        expect(level("2026-11-02")).toBe(1);
        expect(level("2026-11-03")).toBe(2);
        expect(level("2026-11-04")).toBe(3);
        expect(level("2026-11-05")).toBe(4);
        expect(level("2026-11-06")).toBe(0);
    });

    it("puts a single active day at level 4", () => {
        const cells = allCells(calendar(new Map([["2026-10-01", { tokens: 3, sessions: 1 }]]), { now: FRIDAY }).weeks);
        expect(cells.find((c) => c.day === "2026-10-01")?.level).toBe(4);
        expect(cells.filter((c) => c.level !== 0)).toHaveLength(1);
    });

    it("has every day at level 0 and a zero total with no activity", () => {
        const cal = calendar(new Map(), { now: FRIDAY });
        expect(allCells(cal.weeks).every((c) => c.level === 0)).toBe(true);
        expect(cal.total).toBe(0);
    });

    it("totals the window's tokens and ignores days outside it", () => {
        const days = new Map([
            ["2026-11-06", { tokens: 5, sessions: 1 }],
            ["2025-01-01", { tokens: 1000, sessions: 1 }],
        ]);
        expect(calendar(days, { now: FRIDAY }).total).toBe(5);
    });

    it("marks the days before trackedSinceMs as before", () => {
        const cells = allCells(calendar(new Map(), { now: FRIDAY, trackedSinceMs: at(2026, 10, 15) }).weeks);
        expect(cells.find((c) => c.day === "2026-10-14")?.state).toBe("before");
        expect(cells.find((c) => c.day === "2026-10-15")?.state).toBe("tracked");
        expect(cells.filter((c) => c.state === "before").every((c) => c.day < "2026-10-15")).toBe(true);
    });

    it("labels each week whose Monday starts a new month, none in the last 2 columns", () => {
        const { weeks, months } = calendar(new Map(), { now: FRIDAY });
        const monthOf = (w: number) => weeks[w][0].day.slice(0, 7);
        const want = weeks
            .map((_, w) => w)
            .filter((w) => w > 0 && w < ACTIVITY_WEEKS - 2 && monthOf(w) !== monthOf(w - 1));
        // week 0 (Mon Nov 3 2025) names its month too, since the next label is weeks away
        expect(months.map((m) => m.week)).toEqual([0, ...want]);
        expect(months[0].label).toBe("Nov");
        expect(months[1].label).toBe("Dec");
        expect(months.every((m) => m.week < ACTIVITY_WEEKS - 2)).toBe(true);
    });

    it("drops the first column's label when the next week starts a month", () => {
        // today Sun Nov 29 2026: week 0 is Mon Nov 24 2025, week 1 Mon Dec 1 2025
        const { months } = calendar(new Map(), { now: at(2026, 11, 29) });
        expect(months[0]).toEqual({ label: "Dec", week: 1 });
    });
});

describe("lastWeek", () => {
    it("totals the last 7 local days, today included, with distinct sessions and runs", () => {
        const r = reply(
            [
                bucket("a", "2026-11-06", 10),
                bucket("a", "2026-10-31", 20),
                bucket("w1", "2026-11-02", 5),
                bucket("w2", "2026-11-03", 5),
                bucket("w3", "2026-11-03", 5),
                bucket("old", "2026-10-30", 1000),
                bucket("other", "2026-11-06", 1000),
            ],
            [
                session("a", { project: "c:/repo/x/" }),
                session("w1", { project: "C:\\wt\\1", channelid: "ch-x", runid: "r1" }),
                session("w2", { project: "C:\\wt\\2", channelid: "ch-x", runid: "r1" }),
                session("w3", { project: "C:\\wt\\3", channelid: "ch-x", runid: "r2" }),
                session("old", { project: "C:\\Repo\\X" }),
                session("other", { project: "C:\\Other" }),
            ]
        );
        expect(lastWeek(r, PROJECT, FRIDAY)).toEqual({ tokens: 45, sessions: 4, runs: 2 });
    });

    it("is all zero with no activity", () => {
        expect(lastWeek(reply([], []), PROJECT, FRIDAY)).toEqual({ tokens: 0, sessions: 0, runs: 0 });
    });
});

describe("lastWeekLine", () => {
    it("names tokens, sessions and runs", () => {
        expect(lastWeekLine({ tokens: 412_000, sessions: 23, runs: 4 })).toBe("412k tokens · 23 sessions · 4 runs");
        expect(lastWeekLine({ tokens: 900, sessions: 1, runs: 1 })).toBe("900 tokens · 1 session · 1 run");
    });
    it("leaves out runs when there were none", () => {
        expect(lastWeekLine({ tokens: 5_000, sessions: 2, runs: 0 })).toBe("5k tokens · 2 sessions");
    });
    it("says no sessions on a quiet week", () => {
        expect(lastWeekLine({ tokens: 0, sessions: 0, runs: 0 })).toBe("no sessions");
    });
});

describe("tooltipLines", () => {
    const cell = (over: Partial<DayCell>): DayCell => ({
        day: "2026-11-06",
        tokens: 0,
        sessions: 0,
        level: 0,
        state: "tracked",
        today: false,
        ...over,
    });

    it("names the day and its tokens and sessions", () => {
        expect(tooltipLines(cell({ tokens: 61_400, sessions: 3, level: 2 }))).toEqual({
            title: "Fri, Nov 6",
            line: "61k tokens · 3 sessions",
        });
        expect(tooltipLines(cell({ day: "2026-11-09", tokens: 2_500_000, sessions: 1 })).line).toBe(
            "2.5M tokens · 1 session"
        );
        expect(tooltipLines(cell({ day: "2026-11-09" })).title).toBe("Mon, Nov 9");
    });

    it("says no sessions on a quiet tracked day", () => {
        expect(tooltipLines(cell({})).line).toBe("no sessions");
    });

    it("says the day is before tracking", () => {
        expect(tooltipLines(cell({ state: "before" })).line).toBe("before Arc tracked this project");
    });
});

describe("moveFocus", () => {
    it("moves one day with the arrow keys", () => {
        expect(moveFocus(10, 3, "ArrowLeft", 4)).toEqual({ week: 9, row: 3 });
        expect(moveFocus(10, 3, "ArrowRight", 4)).toEqual({ week: 11, row: 3 });
        expect(moveFocus(10, 3, "ArrowUp", 4)).toEqual({ week: 10, row: 2 });
        expect(moveFocus(10, 3, "ArrowDown", 4)).toEqual({ week: 10, row: 4 });
    });

    it("clamps to the grid", () => {
        expect(moveFocus(0, 3, "ArrowLeft", 4)).toEqual({ week: 0, row: 3 });
        expect(moveFocus(5, 0, "ArrowUp", 4)).toEqual({ week: 5, row: 0 });
        expect(moveFocus(5, 6, "ArrowDown", 4)).toEqual({ week: 5, row: 6 });
        expect(moveFocus(ACTIVITY_WEEKS - 1, 2, "ArrowRight", 4)).toEqual({ week: ACTIVITY_WEEKS - 1, row: 2 });
    });

    it("never lands on a future day", () => {
        expect(moveFocus(ACTIVITY_WEEKS - 2, 6, "ArrowRight", 4)).toEqual({ week: ACTIVITY_WEEKS - 1, row: 4 });
        expect(moveFocus(ACTIVITY_WEEKS - 1, 4, "ArrowDown", 4)).toEqual({ week: ACTIVITY_WEEKS - 1, row: 4 });
    });

    it("ignores other keys", () => {
        expect(moveFocus(7, 2, "Enter", 4)).toEqual({ week: 7, row: 2 });
    });
});
