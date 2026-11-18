// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure view derivations for a run's evidence: duration, size and clock formatting, verification counts and
// whether the evidence still needs sealing. No React, no jotai — unit-tested in runcompletion.test.ts.

const pad2 = (n: number) => String(n).padStart(2, "0");

// under a second reads "<1s" before rounding, or 500-999 ms would read "1s"; past an hour the seconds drop, past a day
// the minutes
export function fmtDuration(ms: number): string {
    if (ms > 0 && ms < 1000) {
        return "<1s";
    }
    const s = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (d > 0) {
        return `${d}d ${h % 24}h`;
    }
    if (h > 0) {
        return `${h}h ${pad2(m % 60)}m`;
    }
    if (m > 0) {
        return `${m}m ${pad2(s % 60)}s`;
    }
    return `${s}s`;
}

export function fmtBytes(n: number): string {
    if (n < 1024) {
        return `${n} B`;
    }
    if (n < 1024 * 1024) {
        return `${Math.round(n / 1024)} KB`;
    }
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// memory figures: fmtBytes stops at MB, and a free/needed pair reads best in one unit
export function fmtGB(bytes: number): string {
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

// the figures a memory hold or pause shows, the run sheet's row and the final stage's step alike
export function memoryFigures(free: number, need: number): string {
    return `${fmtGB(free)} free, ${fmtGB(need)} needed`;
}

export function fmtClock(tsMs: number): string {
    if (!tsMs) {
        return "—";
    }
    const d = new Date(tsMs);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function verifCounts(v: EvidenceVerif[]): { pass: number; fail: number; unknown: number } {
    const counts = { pass: 0, fail: 0, unknown: 0 };
    for (const item of v ?? []) {
        if (item.result === "pass") counts.pass++;
        else if (item.result === "fail") counts.fail++;
        else counts.unknown++;
    }
    return counts;
}

export function needsEvidenceSeal(run: Run): boolean {
    return run?.status === "done" && !run?.evidence;
}
