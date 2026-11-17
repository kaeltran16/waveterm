// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The record band's case selection and edge encoding. A run has zero or more attributed records, and the
// collapsed line must distinguish a weak inferred link from a confirmed one — otherwise the attribution
// model reads as certain when it is not.

import type { AmbientTag } from "@/app/view/agents/ambient";

export type BandCase =
    | { case: "none" }
    | { case: "one"; edge: AmbientTag }
    | { case: "several"; primary: AmbientTag; others: AmbientTag[] };

export interface BandInput {
    tags: AmbientTag[];
}

const BUCKET_RANK: Record<string, number> = { strong: 3, medium: 2, weak: 1 };

// unknown buckets rank below weak: never let an unrecognised value present as stronger than it is.
function rank(tag: AmbientTag): number {
    const state = tag.state === "confirmed" ? 10 : 0;
    return state + (BUCKET_RANK[tag.bucket] ?? 0);
}

export interface EdgeLine {
    style: "solid" | "dashed" | "dotted";
    weightPx: number;
}

const LINE: Record<string, EdgeLine> = {
    strong: { style: "solid", weightPx: 2.5 },
    medium: { style: "dashed", weightPx: 1.5 },
    weak: { style: "dotted", weightPx: 1 },
};

// copied on the way out: the table is module state, and a caller adjusting a returned weight for a hover
// treatment would otherwise change every later edge.
export function edgeLineStyle(tag: AmbientTag): EdgeLine {
    return { ...(LINE[tag.bucket] ?? LINE.weak) };
}

// the engine's names (informing, medium) mean nothing to a person. A confirmed link has no confidence left to
// show; anything else is a guess, and an unknown bucket never reads as stronger than weak.
const GUESS_WORD: Record<string, string> = { strong: "strong", medium: "likely", weak: "weak" };

export function edgeLabel(tag: AmbientTag): string {
    if (tag.state === "confirmed") {
        return "confirmed";
    }
    return `guessed · ${GUESS_WORD[tag.bucket] ?? GUESS_WORD.weak}`;
}

// records on one ticket often share a long objective prefix and differ at the end, which the server's label cut
// keeps (ambientLabelTail, wshserver_jarvis.go); the chip shows this many end runes whole, so its css cut lands
// in the middle rather than on them.
export const LABEL_END_RUNES = 14;

export function labelEnds(label: string): [head: string, tail: string] {
    const runes = Array.from(label);
    if (runes.length <= LABEL_END_RUNES * 2) {
        return [label, ""];
    }
    return [runes.slice(0, -LABEL_END_RUNES).join(""), runes.slice(-LABEL_END_RUNES).join("")];
}

// the collapsed row marks only a guess: a confirmed edge has nothing left for you to check.
export function bandGlyph(band: BandCase): boolean {
    const shown = band.case === "one" ? band.edge : band.case === "several" ? band.primary : null;
    return shown != null && shown.state !== "confirmed";
}

export function recordPickerMatches<T extends { id: string; objective: string; ticket?: string }>(
    records: T[],
    q: string,
    max: number
): T[] {
    const needle = q.trim().toLowerCase();
    const hit = (r: T) => [r.objective, r.id, r.ticket ?? ""].some((s) => s.toLowerCase().includes(needle));
    return (needle === "" ? records : records.filter(hit)).slice(0, max);
}

export function recordBandCase(input: BandInput): BandCase {
    const tags = input.tags ?? [];
    if (tags.length === 0) {
        return { case: "none" };
    }
    if (tags.length === 1) {
        return { case: "one", edge: tags[0] };
    }
    const sorted = [...tags].sort((a, b) => rank(b) - rank(a));
    return { case: "several", primary: sorted[0], others: sorted.slice(1) };
}
