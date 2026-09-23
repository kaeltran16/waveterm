// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure, deterministic view-model helpers shared by the Jarvis views. No React, no atoms — testable in
// isolation. Rendering components import these; they never re-derive copy inline.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function ageLabel(ageMs: number): string {
    if (ageMs < MIN) return "just now";
    if (ageMs < HOUR) return `${Math.floor(ageMs / MIN)}m ago`;
    if (ageMs < DAY) return `${Math.floor(ageMs / HOUR)}h ago`;
    return `${Math.floor(ageMs / DAY)}d ago`;
}
