// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Rhythm-aware weekly-quota-exhaustion projection for the Usage surface's Weekly donut. Anthropic's
// weekpct is an opaque, cost-weighted percentage -- there's no exposed tokens<->% conversion, so this
// borrows the *relative shape* of daily token history (already loaded, already on disk, no cold
// start) as a day-of-week pace multiplier, rather than trying to log a %-time-series from scratch.
// See docs/superpowers/specs/2026-07-07-cache-countdown-and-weekly-forecast-design.md.

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const STEP_MS = 60 * 60 * 1000; // 1 hour walk resolution
const MIN_HISTORY_DAYS = 4;
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface DailyTokens {
    day: string; // "YYYY-MM-DD", local timezone (matches usagestats.ts's DailyUsage.day)
    tokens: number;
}

// Builds a normalized day-of-week weight (mean of sampled weekdays = 1) from daily token history.
// A weekday with no samples defaults to weight 1 (uniform -- no signal either way). Returns null
// when history is thinner than MIN_HISTORY_DAYS distinct days: too few samples for a shape to mean
// anything, and this is a nice-to-have signal, not core functionality needing a degraded state.
export function buildDayOfWeekShape(daily: DailyTokens[]): number[] | null {
    if (daily.length < MIN_HISTORY_DAYS) {
        return null;
    }
    const sums = new Array(7).fill(0);
    const counts = new Array(7).fill(0);
    for (const d of daily) {
        const [y, m, dd] = d.day.split("-").map(Number);
        const dow = new Date(y, m - 1, dd).getDay();
        sums[dow] += d.tokens;
        counts[dow] += 1;
    }
    const avgs: (number | null)[] = sums.map((s, i) => (counts[i] > 0 ? s / counts[i] : null));
    const sampled = avgs.filter((a): a is number => a != null);
    const overallMean = sampled.reduce((a, b) => a + b, 0) / sampled.length;
    if (overallMean <= 0) {
        return null; // no signal to weight by
    }
    return avgs.map((a) => (a != null ? a / overallMean : 1));
}

function weightedHours(startMs: number, endMs: number, shape: number[]): number {
    let total = 0;
    for (let t = startMs; t < endMs; t += STEP_MS) {
        const stepMs = Math.min(STEP_MS, endMs - t);
        total += shape[new Date(t).getDay()] * (stepMs / STEP_MS);
    }
    return total;
}

// Projects when the weekly rate-limit window will cross 100%, using the OBSERVED pace so far
// (weekpct consumed over the weighted-hours elapsed since window start) extrapolated forward with
// the same day-of-week shape. Returns epoch ms of the projected crossing, or null when there's
// insufficient history, or the observed pace wouldn't cross 100% before weekreset.
export function projectWeeklyExhaustion(
    daily: DailyTokens[],
    weekpct: number,
    weekreset: number, // epoch seconds
    now: number // epoch ms
): number | null {
    const shape = buildDayOfWeekShape(daily);
    if (shape == null) {
        return null;
    }
    const resetMs = weekreset * 1000;
    const windowStartMs = resetMs - WEEK_MS;
    if (resetMs <= now || weekpct <= 0 || weekpct >= 100 || now <= windowStartMs) {
        return null;
    }

    const elapsedWeight = weightedHours(windowStartMs, now, shape);
    if (elapsedWeight <= 0) {
        return null;
    }
    const pctPerWeightUnit = weekpct / elapsedWeight; // observed pace, calibrated to actual usage so far

    const remainingPct = 100 - weekpct;
    let acc = 0;
    for (let t = now; t < resetMs; t += STEP_MS) {
        const stepMs = Math.min(STEP_MS, resetMs - t);
        const weight = shape[new Date(t).getDay()] * (stepMs / STEP_MS);
        acc += weight * pctPerWeightUnit;
        if (acc >= remainingPct) {
            return t + stepMs;
        }
    }
    return null; // observed pace wouldn't cross 100% before reset
}

// Pure: epoch ms -> "Thu 3pm" style short weekday + 12-hour time, for the projected-exhaustion line.
export function formatProjectedDate(ms: number): string {
    const d = new Date(ms);
    let h = d.getHours();
    const ampm = h >= 12 ? "pm" : "am";
    h = h % 12;
    if (h === 0) {
        h = 12;
    }
    return `${WEEKDAY_SHORT[d.getDay()]} ${h}${ampm}`;
}
