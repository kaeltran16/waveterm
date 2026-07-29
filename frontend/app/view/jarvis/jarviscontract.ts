// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Jarvis conversation view-model — the G ⇄ F seam (spec §"The seam"). G renders this for every
// state; F (Plan 2+) implements it. Plan 1 defines it as plain TS; Plan 2 replaces these with the
// Go-generated wire types once JarvisConverseCommand exists. Keep shapes minimal and additive.

export type SourceType =
    | "memory"
    | "decision"
    | "run"
    | "channel"
    | "radar"
    | "commit"
    | "agent"
    | "session"
    | "task";

export type Freshness = "fresh" | "stale" | "unavailable";
// "weak" and "notfound" are statements about the corpus; "error" is a statement about the request — it
// never reached an answer. Collapsing the two made a dead backend read as "I looked and found little".
// "cancelled" is a statement about the user: they stopped it, so it is neither.
export type Terminal = "answered" | "weak" | "notfound" | "error" | "cancelled";
export type StepStatus = "done" | "active" | "pending";
export type ScopeMode = "object" | "project" | "all" | "attached";

export interface SourceRef {
    oref: string; // ORef of the native object; the click target
    sourceType: SourceType;
    title: string;
}

export interface WorkingStep {
    id: string;
    label: string;
    status: StepStatus;
}

// A jarvis answer is a list of segments: prose text interleaved with citation references. A citationRef
// points at a GroundingCard.n in the same turn. Discriminated by the presence of `citationRef`.
export type AnswerSegment = { text: string } | { citationRef: number };

export interface GroundingCard {
    n: number; // citation index, referenced by AnswerSegment.citationRef
    sourceType: SourceType;
    title: string;
    project: string;
    ageMs: number; // age at synthesis time; rendered via recallderive.ageLabel
    freshness: Freshness;
    navTarget: string; // ORef opened in the native surface
    expanded?: boolean; // one card may be expanded (state 3)
}

export interface ScopeChip {
    label: string;
    active: boolean;
}

export interface JarvisScope {
    mode: ScopeMode;
    chips: ScopeChip[];
    attached: SourceRef[];
}

export interface JarvisUserTurn {
    role: "user";
    text: string;
    attachments: SourceRef[];
}

export interface JarvisAnswerTurn {
    role: "jarvis";
    workingSteps: WorkingStep[];
    segments: AnswerSegment[];
    grounding: GroundingCard[];
    terminal: Terminal;
    // true only while the converse stream is open. `terminal` cannot express this: it starts at "answered"
    // and is only meaningful once the stream ends, so the Cancel control needs its own signal.
    streaming?: boolean;
}

export type JarvisTurn = JarvisUserTurn | JarvisAnswerTurn;

export interface JarvisConversation {
    id: string;
    title: string;
    turns: JarvisTurn[];
    scope: JarvisScope;
    // set from the persisted summary; a locally-created thread is never archived
    archived?: boolean;
}

export function isAnswerTurn(t: JarvisTurn): t is JarvisAnswerTurn {
    return t.role === "jarvis";
}

export function isCitation(s: AnswerSegment): s is { citationRef: number } {
    return "citationRef" in s;
}
