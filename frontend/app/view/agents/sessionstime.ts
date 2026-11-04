// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure time labels for the Sessions surface: when a session started, when an event happened, how long it ran.
// No React.

import { formatAgeShort } from "./agentsviewmodel";
import { fmtClock } from "./runcompletion";

// "Oct 23 09:13", with the year when it is not this year: "Oct 23 2025 09:13"
export function startedLabel(ts: number, now: number): string {
    const d = new Date(ts);
    const day = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const year = d.getFullYear() === new Date(now).getFullYear() ? "" : ` ${d.getFullYear()}`;
    return `${day}${year} ${fmtClock(ts)}`;
}

// the clock alone for today, else the date too
export function eventTime(ts: number, now: number): string {
    return new Date(ts).toDateString() === new Date(now).toDateString() ? fmtClock(ts) : startedLabel(ts, now);
}

export function ranLabel(ms: number): string {
    return ms > 0 ? `ran ${formatAgeShort(ms)}` : "";
}
