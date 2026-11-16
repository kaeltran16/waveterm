// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Reads Claude Code's spinner row ("✻ Undulating… (58s · ↓ 4.5k tokens · esc to interrupt)") off the terminal
// screen. Pure, unit-tested in spinnerrow.test.ts. Tracks Claude Code's layout, as pkg/agentask/deliver.go does.

export interface SpinnerRead {
    glyph: string;
    verb: string; // with its trailing "…"
    detail?: string; // the parenthesised part without the parens, key hints dropped
    tokens?: string; // the output token count as shown ("4.5k"), when the detail has one
}

// one capitalised word ending in "…" keeps agent output such as "* Reading the file…" from reading as a spinner
const SPINNER_ROW = /^\s*([·✢✳✶✻✽*])\s+([A-Z][A-Za-z]*…)(?:\s+\((.*)\))?\s*$/;
const DETAIL_SEP = " · ";
// key hints are dropped: Esc lives on the composer's Interrupt button
const KEY_HINT = /^(esc |ctrl\+|shift\+)/i;
// "↓" is output; "↑" is the request still uploading, not tokens the agent wrote
const OUTPUT_TOKENS = /^↓\s*(\S+)\s+tokens$/;

export function parseSpinner(rows: string[]): SpinnerRead | null {
    for (let i = rows.length - 1; i >= 0; i--) {
        const m = SPINNER_ROW.exec(rows[i]);
        if (m == null) {
            continue;
        }
        const read: SpinnerRead = { glyph: m[1], verb: m[2] };
        const parts = (m[3] ?? "")
            .split(DETAIL_SEP)
            .map((s) => s.trim())
            .filter((s) => s !== "" && !KEY_HINT.test(s));
        if (parts.length > 0) {
            read.detail = parts.join(DETAIL_SEP);
        }
        const tokens = parts.map((s) => OUTPUT_TOKENS.exec(s)?.[1]).find((t) => t != null);
        if (tokens != null) {
            read.tokens = tokens;
        }
        return read;
    }
    return null;
}
