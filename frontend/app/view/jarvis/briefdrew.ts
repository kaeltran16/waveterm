// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// What a thread drew on, in aggregate: every source its answers cited, deduped, each carrying the
// freshness of the reading that matters. The per-answer Sources card treatment lives on one turn at a
// time; this is the whole thread's footing, which is the question you ask before you trust it.
//
// Distinct from mentions.ts, which resolves dossier ids only — for Space scoping and the "Mentioned
// here" band. This keeps every source type and the freshness with it.

import type { Freshness, JarvisConversation, SourceType } from "./jarviscontract";
import { isAnswerTurn } from "./jarviscontract";

export interface DrewRow {
    key: string; // navTarget: the source's identity, and the dedupe key
    sourceType: SourceType;
    title: string;
    project: string;
    freshness: Freshness;
    ageMs: number;
    citations: number;
}

export interface DrewSummary {
    rows: DrewRow[];
    // the dedupe is only worth mentioning when it did something
    meta: string;
}

// worst freshness wins when a source is cited more than once. A thread that cited something while it was
// fresh and again after it went stale is resting on stale footing, so reporting the first or the best
// reading would hide exactly what invariant 7 exists to surface.
// "unverified" sits between them on purpose: an unchecked citation is weaker footing than one verified
// fresh, and stronger evidence of trouble than nothing — but it must never mask a real stale reading.
const SEVERITY: Record<Freshness, number> = { fresh: 0, unverified: 1, stale: 2, unavailable: 3 };

function isWorse(next: Freshness, current: Freshness): boolean {
    return SEVERITY[next] > SEVERITY[current];
}

function label(n: number): string {
    return n + (n === 1 ? " source" : " sources");
}

export function drewOn(conversation: JarvisConversation): DrewSummary {
    const byKey = new Map<string, DrewRow>();
    let cited = 0;
    for (const turn of conversation?.turns ?? []) {
        if (!isAnswerTurn(turn)) {
            continue;
        }
        for (const card of turn.grounding ?? []) {
            const key = card.navTarget ?? "";
            if (key === "") {
                continue; // a card with no target names no source we could open
            }
            cited += 1;
            const prior = byKey.get(key);
            if (prior == null) {
                byKey.set(key, {
                    key,
                    sourceType: card.sourceType,
                    title: card.title,
                    project: card.project,
                    freshness: card.freshness,
                    ageMs: card.ageMs,
                    citations: 1,
                });
                continue;
            }
            prior.citations += 1;
            // age travels with the freshness that won, so the row's label and its age describe the same
            // observation rather than two different turns' readings of it.
            if (isWorse(card.freshness, prior.freshness)) {
                prior.freshness = card.freshness;
                prior.ageMs = card.ageMs;
            }
        }
    }
    const rows = [...byKey.values()];
    return {
        rows,
        meta: rows.length === 0 ? "" : label(rows.length) + (cited > rows.length ? ` across ${cited} citations` : ""),
    };
}
