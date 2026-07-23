// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure, deterministic view-model helpers for the Jarvis recall surface. No React, no atoms — testable
// in isolation. Rendering components import these; they never re-derive copy inline.

import type { AnswerSegment, Freshness, GroundingCard } from "./jarviscontract";
import { isCitation } from "./jarviscontract";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function ageLabel(ageMs: number): string {
    if (ageMs < MIN) return "just now";
    if (ageMs < HOUR) return `${Math.floor(ageMs / MIN)}m ago`;
    if (ageMs < DAY) return `${Math.floor(ageMs / HOUR)}h ago`;
    return `${Math.floor(ageMs / DAY)}d ago`;
}

export function freshnessLabel(f: Freshness): string {
    switch (f) {
        case "fresh":
            return "Fresh";
        case "stale":
            return "Stale";
        case "unavailable":
            return "Unavailable";
    }
}

export function groundingByN(cards: GroundingCard[]): Map<number, GroundingCard> {
    return new Map(cards.map((c) => [c.n, c]));
}

export function citedNs(segments: AnswerSegment[]): number[] {
    const seen: number[] = [];
    for (const s of segments) {
        if (isCitation(s) && !seen.includes(s.citationRef)) seen.push(s.citationRef);
    }
    return seen;
}
