// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Reads Claude Code's spinner row ("✻ Undulating… (58s · ↓ 4.5k tokens · esc to interrupt)") off the terminal
// screen. Pure, unit-tested in spinnerrow.test.ts. Tracks Claude Code's layout, as pkg/agentask/deliver.go does.

export interface SpinnerRead {
    glyph: string;
    verb: string; // with its trailing "…"
    detail?: string; // the parenthesised part without the parens, key hints dropped
}

// one capitalised word ending in "…" keeps agent output such as "* Reading the file…" from reading as a spinner
const SPINNER_ROW = /^\s*([·✢✳✶✻✽*])\s+([A-Z][A-Za-z]*…)(?:\s+\((.*)\))?\s*$/;
const DETAIL_SEP = " · ";
// key hints are dropped: Esc lives on the composer's Interrupt button
const KEY_HINT = /^(esc |ctrl\+|shift\+)/i;

export function parseSpinner(rows: string[]): SpinnerRead | null {
    for (let i = rows.length - 1; i >= 0; i--) {
        const m = SPINNER_ROW.exec(rows[i]);
        if (m == null) {
            continue;
        }
        const read: SpinnerRead = { glyph: m[1], verb: m[2] };
        const detail = (m[3] ?? "")
            .split(DETAIL_SEP)
            .map((s) => s.trim())
            .filter((s) => s !== "" && !KEY_HINT.test(s))
            .join(DETAIL_SEP);
        if (detail !== "") {
            read.detail = detail;
        }
        return read;
    }
    return null;
}
