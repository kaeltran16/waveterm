// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The project Overview's Activity calendar (projectactivity.tsx): a project's tokens per local day, read from the
// usage scan, laid out as 53 Monday-first weeks ending with today.

import { formatTokens } from "./agentsviewmodel";
import { samePath } from "./projectoverviewmodel";
import { bucketTokens, localDayKey, windowStartDay } from "./usagestats";

export const ACTIVITY_WEEKS = 53;
const DAYS_PER_WEEK = 7;
// the window the scan is asked for: every day the grid can show
export const ACTIVITY_WINDOW_DAYS = ACTIVITY_WEEKS * DAYS_PER_WEEK;
const LAST_WEEK_DAYS = 7;
// the last columns are too narrow for a month name to fit before the grid ends
const UNLABELED_TAIL_WEEKS = 2;

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export type ActivityProject = { path: string; channelId?: string };
export type DayActivity = { tokens: number; sessions: number };
export type DayLevel = 0 | 1 | 2 | 3 | 4;
export type DayCell = {
    day: string;
    tokens: number;
    sessions: number;
    level: DayLevel;
    state: "tracked" | "before" | "future";
    today: boolean;
};
export type Calendar = { weeks: DayCell[][]; months: { label: string; week: number }[]; total: number };

const sessionKey = (harness: string, session: string) => `${harness}\u0000${session}`;

// the project's sessions: run in its folder, or a run worker in an arc-wt worktree that reports to its channel
function projectSessions(reply: CommandGetUsageStatsRtnData, project: ActivityProject): Map<string, UsageSession> {
    const out = new Map<string, UsageSession>();
    for (const s of reply.sessions ?? []) {
        const inChannel = !!project.channelId && s.channelid === project.channelId;
        if (inChannel || samePath(s.project ?? "", project.path)) {
            out.set(sessionKey(s.harness, s.session), s);
        }
    }
    return out;
}

// the project's buckets, each with the session it belongs to; a bucket without a session belongs to no project
function projectBuckets(
    reply: CommandGetUsageStatsRtnData,
    project: ActivityProject
): { bucket: UsageBucket; key: string; session: UsageSession }[] {
    const sessions = projectSessions(reply, project);
    const out: { bucket: UsageBucket; key: string; session: UsageSession }[] = [];
    for (const b of reply.buckets ?? []) {
        if (!b.session) continue;
        const key = sessionKey(b.harness, b.session);
        const session = sessions.get(key);
        if (session != null) out.push({ bucket: b, key, session });
    }
    return out;
}

export function projectDays(reply: CommandGetUsageStatsRtnData, project: ActivityProject): Map<string, DayActivity> {
    const tokens = new Map<string, number>();
    const sessions = new Map<string, Set<string>>();
    for (const { bucket, key } of projectBuckets(reply, project)) {
        tokens.set(bucket.day, (tokens.get(bucket.day) ?? 0) + bucketTokens(bucket));
        if (!sessions.has(bucket.day)) sessions.set(bucket.day, new Set());
        sessions.get(bucket.day).add(key);
    }
    const out = new Map<string, DayActivity>();
    for (const [day, t] of tokens) out.set(day, { tokens: t, sessions: sessions.get(day).size });
    return out;
}

// Quartiles by rank among the non-zero days: a day's share of the days at or below it picks its level, so the
// busiest day is always 4 and a lone active day is 4 too.
function levelOf(tokens: number, sortedNonZero: number[]): DayLevel {
    if (tokens <= 0 || sortedNonZero.length === 0) return 0;
    let atOrBelow = 0;
    while (atOrBelow < sortedNonZero.length && sortedNonZero[atOrBelow] <= tokens) atOrBelow++;
    const rank = atOrBelow / sortedNonZero.length;
    if (rank <= 0.25) return 1;
    if (rank <= 0.5) return 2;
    if (rank <= 0.75) return 3;
    return 4;
}

// rows run Monday..Sunday
const weekdayRow = (d: Date) => (d.getDay() + 6) % DAYS_PER_WEEK;

export function calendar(days: Map<string, DayActivity>, opts: { now: number; trackedSinceMs?: number }): Calendar {
    const todayKey = localDayKey(opts.now);
    const sinceKey = opts.trackedSinceMs != null ? localDayKey(opts.trackedSinceMs) : undefined;
    const today = new Date(opts.now);
    const first = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    first.setDate(first.getDate() - weekdayRow(today) - (ACTIVITY_WEEKS - 1) * DAYS_PER_WEEK);

    const keys: string[][] = [];
    for (let w = 0; w < ACTIVITY_WEEKS; w++) {
        const week: string[] = [];
        for (let r = 0; r < DAYS_PER_WEEK; r++) {
            week.push(localDayKey(first.getTime()));
            first.setDate(first.getDate() + 1);
        }
        keys.push(week);
    }

    const inWindow = keys.flat().filter((k) => k <= todayKey);
    const sorted = inWindow
        .map((k) => days.get(k)?.tokens ?? 0)
        .filter((t) => t > 0)
        .sort((a, b) => a - b);
    const total = sorted.reduce((sum, t) => sum + t, 0);

    const weeks = keys.map((week) =>
        week.map((day): DayCell => {
            const a = days.get(day);
            const future = day > todayKey;
            const tokens = future ? 0 : (a?.tokens ?? 0);
            return {
                day,
                tokens,
                sessions: future ? 0 : (a?.sessions ?? 0),
                level: levelOf(tokens, sorted),
                state: future ? "future" : sinceKey != null && day < sinceKey ? "before" : "tracked",
                today: day === todayKey,
            };
        })
    );

    const monthOf = (w: number) => Number(keys[w][0].slice(5, 7)) - 1;
    const months: { label: string; week: number }[] = [];
    for (let w = 0; w < ACTIVITY_WEEKS - UNLABELED_TAIL_WEEKS; w++) {
        const starts = w === 0 ? monthOf(1) === monthOf(0) : monthOf(w) !== monthOf(w - 1);
        if (starts) months.push({ label: MONTH_NAMES[monthOf(w)], week: w });
    }
    return { weeks, months, total };
}

export function lastWeek(
    reply: CommandGetUsageStatsRtnData,
    project: ActivityProject,
    now: number
): { tokens: number; sessions: number; runs: number } {
    const start = windowStartDay(LAST_WEEK_DAYS, now);
    const todayKey = localDayKey(now);
    let tokens = 0;
    const sessions = new Set<string>();
    const runs = new Set<string>();
    for (const { bucket, key, session } of projectBuckets(reply, project)) {
        if (bucket.day < start || bucket.day > todayKey) continue;
        tokens += bucketTokens(bucket);
        sessions.add(key);
        if (session.runid) runs.add(session.runid);
    }
    return { tokens, sessions: sessions.size, runs: runs.size };
}

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

// the "last 7 days" figures; a week with no runs leaves them out rather than saying "0 runs"
export function lastWeekLine(w: { tokens: number; sessions: number; runs: number }): string {
    if (w.sessions === 0) return "no sessions";
    const parts = [`${formatTokens(w.tokens)} tokens`, plural(w.sessions, "session")];
    if (w.runs > 0) parts.push(plural(w.runs, "run"));
    return parts.join(" · ");
}

export function tooltipLines(cell: DayCell): { title: string; line: string } {
    const [y, m, d] = cell.day.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    const title = `${DAY_NAMES[weekdayRow(date)]}, ${MONTH_NAMES[m - 1]} ${d}`;
    if (cell.state === "before") return { title, line: "before Arc tracked this project" };
    if (cell.sessions === 0) return { title, line: "no sessions" };
    return { title, line: `${formatTokens(cell.tokens)} tokens · ${plural(cell.sessions, "session")}` };
}

const STEPS: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
};

// one day in the arrow's direction, kept on the grid and off the days after today (the last column below todayRow)
export function moveFocus(week: number, row: number, key: string, todayRow: number): { week: number; row: number } {
    const step = STEPS[key];
    if (step == null) return { week, row };
    const w = Math.min(ACTIVITY_WEEKS - 1, Math.max(0, week + step[0]));
    let r = Math.min(DAYS_PER_WEEK - 1, Math.max(0, row + step[1]));
    if (w === ACTIVITY_WEEKS - 1 && r > todayRow) r = todayRow;
    return { week: w, row: r };
}
