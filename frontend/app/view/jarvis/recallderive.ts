// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure, deterministic view-model helpers for the Jarvis recall surface. No React, no atoms — testable
// in isolation. Rendering components import these; they never re-derive copy inline.

import type { AnswerSegment, Freshness, GroundingCard, SourceType } from "./jarviscontract";
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

// parseCitations splits the model's prose into text + citation segments. Only [n] references matching a known
// grounding card are turned into citations; unknown refs stay literal text (never fabricate a citation). Runs
// on every streamed text chunk (accumulated raw text in, segments out) — must be pure and cheap.
export function parseCitations(text: string, cards: GroundingCard[]): AnswerSegment[] {
    const valid = new Set(cards.map((c) => c.n));
    const segs: AnswerSegment[] = [];
    const re = /\[(\d+)\]/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const n = Number(m[1]);
        if (!valid.has(n)) continue;
        if (m.index > last) segs.push({ text: text.slice(last, m.index) });
        segs.push({ citationRef: n });
        last = re.lastIndex;
    }
    if (last < text.length) segs.push({ text: text.slice(last) });
    return segs;
}

// mapWireCard converts a generated JarvisGroundingCard (snake/lowercase JSON keys) into the camelCase
// view-model GroundingCard the renderer consumes.
export function mapWireCard(w: JarvisGroundingCard): GroundingCard {
    return {
        n: w.n,
        sourceType: w.sourcetype as SourceType,
        title: w.title,
        project: w.project,
        ageMs: w.agems,
        freshness: w.freshness as Freshness,
        navTarget: w.navtarget,
    };
}
