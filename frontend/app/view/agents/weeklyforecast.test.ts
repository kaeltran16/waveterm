// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { buildDayOfWeekShape, formatProjectedDate, projectWeeklyExhaustion } from "./weeklyforecast";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function dayKey(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

describe("buildDayOfWeekShape", () => {
    test("returns null with fewer than 4 distinct days", () => {
        const anchor = new Date(2026, 0, 5, 12, 0, 0);
        const daily = [0, 1, 2].map((i) => {
            const d = new Date(anchor);
            d.setDate(d.getDate() - i);
            return { day: dayKey(d), tokens: 100 };
        });
        expect(buildDayOfWeekShape(daily)).toBeNull();
    });

    test("normalizes so sampled weekdays average to 1; unsampled weekdays default to 1", () => {
        const anchor = new Date(2026, 0, 5, 12, 0, 0);
        const tokensByOffset = [700, 100, 100, 100]; // offset 0 = anchor day, 1 = day before, ...
        const daily = tokensByOffset.map((tokens, i) => {
            const d = new Date(anchor);
            d.setDate(d.getDate() - i);
            return { day: dayKey(d), tokens };
        });
        const mean = (700 + 100 + 100 + 100) / 4;
        const expected = new Array(7).fill(1);
        tokensByOffset.forEach((tokens, i) => {
            const d = new Date(anchor);
            d.setDate(d.getDate() - i);
            expected[d.getDay()] = tokens / mean;
        });

        const shape = buildDayOfWeekShape(daily);
        expect(shape).not.toBeNull();
        shape!.forEach((w, dow) => expect(w).toBeCloseTo(expected[dow], 5));
    });
});

describe("projectWeeklyExhaustion", () => {
    test("returns null with insufficient history", () => {
        const anchor = new Date(2026, 0, 5, 12, 0, 0);
        const daily = [0, 1, 2].map((i) => {
            const d = new Date(anchor);
            d.setDate(d.getDate() - i);
            return { day: dayKey(d), tokens: 100 };
        });
        const now = anchor.getTime();
        const weekreset = (now + DAY_MS) / 1000;
        expect(projectWeeklyExhaustion(daily, 50, weekreset, now)).toBeNull();
    });

    test("uniform shape extrapolates the observed pace linearly", () => {
        // 4 uniform days -> shape is flat (every weekday weight 1), so this reduces to naive linear
        // extrapolation: a hand-verifiable sanity check that the weighting doesn't distort a flat shape.
        // Elapsed is chosen as 40h (not e.g. 42h) so the pace (50/40 = 1.25) is an exact binary
        // fraction -- repeated floating-point summation lands on exactly 50.0 at the crossing step,
        // with no rounding-error risk of tripping the >= comparison onto the wrong side.
        const weekStart = new Date(2026, 0, 1, 0, 0, 0);
        const weekreset = (weekStart.getTime() + 7 * DAY_MS) / 1000;
        const now = weekStart.getTime() + 40 * 60 * 60 * 1000; // 40h elapsed of the 168h window
        const daily = [0, 1, 2, 3].map((i) => {
            const d = new Date(weekStart);
            d.setDate(d.getDate() - i - 1);
            return { day: dayKey(d), tokens: 100 };
        });
        // 50% used in 40h elapsed -> pace of 1.25%/hour -> the remaining 50% takes exactly 40 more
        // hours at the same pace.
        const got = projectWeeklyExhaustion(daily, 50, weekreset, now);
        expect(got).toBe(now + 40 * 60 * 60 * 1000);
    });

    test("a pace that wouldn't exhaust before reset returns null", () => {
        const weekStart = new Date(2026, 0, 1, 0, 0, 0);
        const weekreset = (weekStart.getTime() + 7 * DAY_MS) / 1000;
        const now = weekStart.getTime() + 140 * 60 * 60 * 1000; // 140h elapsed of 168h
        const daily = [0, 1, 2, 3].map((i) => {
            const d = new Date(weekStart);
            d.setDate(d.getDate() - i - 1);
            return { day: dayKey(d), tokens: 100 };
        });
        // 5% used in 140h -> over the remaining 28h at the same pace, +1% -> nowhere near 100%.
        expect(projectWeeklyExhaustion(daily, 5, weekreset, now)).toBeNull();
    });

    test("a heavier near-term weekday shape projects exhaustion no later than a lighter one", () => {
        const weekStart = new Date(2026, 0, 1, 0, 0, 0);
        const weekreset = (weekStart.getTime() + 7 * DAY_MS) / 1000;
        const now = weekStart.getTime() + 6.5 * DAY_MS; // 12h before reset -> the forward walk is
        // dominated by the next day or two, so a large swing in that bucket's weight should reliably
        // move the projection in the expected direction despite the shared normalization.

        const buildDaily = (nearTermTokens: number) => {
            const days = [];
            for (let i = 0; i < 6; i++) {
                const d = new Date(now);
                d.setDate(d.getDate() - i);
                days.push({ day: dayKey(d), tokens: i === 0 ? nearTermTokens : 100 });
            }
            return days;
        };

        // 300 (not 50): the near-term day's weight is calibrated against both the elapsed-pace
        // denominator and the forward-walk numerator, so a too-light near-term value can fail to
        // accumulate the remaining budget within this 12h window at all (a legitimate null, per the
        // "pace that wouldn't exhaust before reset" case above) -- 300 sits above that crossing
        // threshold while staying well below heavy's 1000.
        const heavy = projectWeeklyExhaustion(buildDaily(1000), 90, weekreset, now);
        const light = projectWeeklyExhaustion(buildDaily(300), 90, weekreset, now);

        expect(heavy).not.toBeNull();
        expect(light).not.toBeNull();
        expect(heavy as number).toBeLessThanOrEqual(light as number);
    });
});

describe("formatProjectedDate", () => {
    test("formats weekday + 12-hour time", () => {
        const d = new Date(2026, 0, 1, 15, 0, 0);
        expect(formatProjectedDate(d.getTime())).toBe(`${WEEKDAY[d.getDay()]} 3pm`);
    });

    test("midnight -> 12am, noon -> 12pm", () => {
        const midnight = new Date(2026, 0, 1, 0, 0, 0);
        const noon = new Date(2026, 0, 1, 12, 0, 0);
        expect(formatProjectedDate(midnight.getTime())).toBe(`${WEEKDAY[midnight.getDay()]} 12am`);
        expect(formatProjectedDate(noon.getTime())).toBe(`${WEEKDAY[noon.getDay()]} 12pm`);
    });
});
