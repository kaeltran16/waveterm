// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Hand-authored Jarvis conversation fixtures — one per surface state (spec states 1-7, 11, 12). They
// exercise every branch of the view-model so the contract is validated before F exists (Plan 2 swaps
// the source, not the shape). Content is fabricated placeholder data, not real project claims.

import type { GroundingCard, JarvisConversation, JarvisScope } from "./jarviscontract";

export type FixtureState =
    | "empty" // 1: first use, no conversations
    | "active" // 2: active multi-turn
    | "grounded" // 3: grounded answer, mixed sources, one expanded
    | "working" // 4: retrieval activity while streaming
    | "weak" // 5: weak grounding
    | "notfound" // 6: not found
    | "stale" // 7: source unavailable / stale
    | "contextual" // 11: contextual invocation from a Run
    | "narrow"; // 12: narrow window (same data as grounded; layout differs)

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const defaultScope: JarvisScope = {
    mode: "all",
    chips: [
        { label: "This project", active: false },
        { label: "All Wave", active: true },
    ],
    attached: [],
};

const card = (n: number, over: Partial<GroundingCard>): GroundingCard => ({
    n,
    sourceType: "decision",
    title: "Untitled source",
    project: "waveterm",
    ageMs: 2 * DAY,
    freshness: "fresh",
    navTarget: `run:00000000-0000-0000-0000-00000000000${n}`,
    ...over,
});

const empty: JarvisConversation = { id: "empty", title: "New conversation", turns: [], scope: defaultScope };

const active: JarvisConversation = {
    id: "active",
    title: "Channel scaling — where we left off",
    scope: defaultScope,
    turns: [
        { role: "user", text: "Where did we leave the channel-scaling work?", attachments: [] },
        {
            role: "jarvis",
            workingSteps: [{ id: "s1", label: "Searched decisions + runs", status: "done" }],
            terminal: "answered",
            grounding: [card(1, { sourceType: "run", title: "Run: shard channel fan-out", ageMs: 3 * DAY })],
            segments: [
                { text: "You paused after landing the fan-out sharding " },
                { citationRef: 1 },
                { text: ". The open thread was back-pressure on slow subscribers." },
            ],
        },
        { role: "user", text: "What was the back-pressure decision?", attachments: [] },
        {
            role: "jarvis",
            workingSteps: [{ id: "s2", label: "Traversed decision → run", status: "done" }],
            terminal: "answered",
            grounding: [card(1, { sourceType: "decision", title: "Decision: drop-oldest on overflow", ageMs: 2 * DAY })],
            segments: [{ text: "Drop-oldest on overflow, chosen over blocking " }, { citationRef: 1 }, { text: "." }],
        },
    ],
};

const grounded: JarvisConversation = {
    id: "grounded",
    title: "Why avoid per-run worktrees?",
    scope: defaultScope,
    turns: [
        { role: "user", text: "Why did we avoid per-run worktrees?", attachments: [] },
        {
            role: "jarvis",
            workingSteps: [
                { id: "s1", label: "Structured query: decisions", status: "done" },
                { id: "s2", label: "Full-text: 'worktree'", status: "done" },
                { id: "s3", label: "Traversed decision → run → commit", status: "done" },
            ],
            terminal: "answered",
            grounding: [
                card(1, { sourceType: "decision", title: "Decision: shared working tree", ageMs: 5 * DAY, expanded: true }),
                card(2, { sourceType: "run", title: "Run: worktree spike", ageMs: 6 * DAY }),
                card(3, { sourceType: "commit", title: "commit a779ac2a", ageMs: 6 * DAY, project: "waveterm" }),
                card(4, { sourceType: "memory", title: "EnterWorktree baseRef gotcha", ageMs: 12 * DAY }),
            ],
            segments: [
                { text: "Per-run worktrees were rejected because they branch from a stale origin " },
                { citationRef: 1 },
                { text: ", which the spike confirmed " },
                { citationRef: 2 },
                { text: " and the gotcha note captured " },
                { citationRef: 4 },
                { text: "." },
            ],
        },
    ],
};

const working: JarvisConversation = {
    id: "working",
    title: "What do recent Radar findings have in common?",
    scope: defaultScope,
    turns: [
        { role: "user", text: "What do the recent Radar findings have in common?", attachments: [] },
        {
            role: "jarvis",
            workingSteps: [
                { id: "s1", label: "Structured query: radar findings (7d)", status: "done" },
                { id: "s2", label: "Full-text across evidence", status: "active" },
                { id: "s3", label: "Synthesize common thread", status: "pending" },
            ],
            terminal: "answered",
            grounding: [card(1, { sourceType: "radar", title: "Finding: retry storm", ageMs: 1 * DAY })],
            segments: [{ text: "Reading the findings…" }],
        },
    ],
};

const weak: JarvisConversation = {
    id: "weak",
    title: "Did we decide on a rate-limit backoff curve?",
    scope: defaultScope,
    turns: [
        { role: "user", text: "Did we decide on a rate-limit backoff curve?", attachments: [] },
        {
            role: "jarvis",
            workingSteps: [{ id: "s1", label: "Searched decisions + memory", status: "done" }],
            terminal: "weak",
            grounding: [
                card(1, { sourceType: "memory", title: "wshrpc 5s budget note", ageMs: 9 * DAY, freshness: "fresh" }),
            ],
            segments: [
                { text: "No confirmed decision found. The closest candidate is a timeout-budget note " },
                { citationRef: 1 },
                { text: ", but it does not specify a backoff curve — treat as weak." },
            ],
        },
    ],
};

const notfound: JarvisConversation = {
    id: "notfound",
    title: "What is the Kafka partition count?",
    scope: defaultScope,
    turns: [
        { role: "user", text: "What partition count did we pick for Kafka?", attachments: [] },
        {
            role: "jarvis",
            workingSteps: [{ id: "s1", label: "Structured + full-text search", status: "done" }],
            terminal: "notfound",
            grounding: [],
            segments: [{ text: "Not found. No Wave source references Kafka or a partition count." }],
        },
    ],
};

const stale: JarvisConversation = {
    id: "stale",
    title: "Status of the migration run",
    scope: defaultScope,
    turns: [
        { role: "user", text: "Is the migration run still green?", attachments: [] },
        {
            role: "jarvis",
            workingSteps: [{ id: "s1", label: "Resolved run status at synthesis", status: "done" }],
            terminal: "answered",
            grounding: [
                card(1, { sourceType: "run", title: "Run: schema migration", ageMs: 20 * DAY, freshness: "stale" }),
                card(2, { sourceType: "session", title: "Session: nightly deploy", ageMs: 40 * DAY, freshness: "unavailable" }),
            ],
            segments: [
                { text: "The last recorded status was green " },
                { citationRef: 1 },
                { text: ", but that source is stale; the originating session is no longer available " },
                { citationRef: 2 },
                { text: "." },
            ],
        },
    ],
};

const contextual: JarvisConversation = {
    id: "contextual",
    title: "About this Run",
    scope: {
        mode: "attached",
        chips: [{ label: "This Run", active: true }],
        attached: [{ oref: "run:11111111-1111-1111-1111-111111111111", sourceType: "run", title: "Run: recolor runtime pills" }],
    },
    turns: [
        {
            role: "user",
            text: "What changed in this Run and why?",
            attachments: [{ oref: "run:11111111-1111-1111-1111-111111111111", sourceType: "run", title: "Run: recolor runtime pills" }],
        },
        {
            role: "jarvis",
            workingSteps: [{ id: "s1", label: "Read run evidence + linked decision", status: "done" }],
            terminal: "answered",
            grounding: [
                card(1, { sourceType: "run", title: "Run: recolor runtime pills", ageMs: 4 * HOUR }),
                card(2, { sourceType: "decision", title: "Decision: trademark pill colors", ageMs: 5 * HOUR }),
            ],
            segments: [
                { text: "This Run recolored the Claude/Codex pills to trademark colors " },
                { citationRef: 1 },
                { text: ", per the decision to match brand palettes " },
                { citationRef: 2 },
                { text: "." },
            ],
        },
    ],
};

// state 12 (narrow) renders the grounded conversation; only the layout differs, driven by the rail atom.
export const FIXTURES: Record<FixtureState, JarvisConversation> = {
    empty,
    active,
    grounded,
    working,
    weak,
    notfound,
    stale,
    contextual,
    narrow: { ...grounded, id: "narrow", title: "Narrow — why avoid per-run worktrees?" },
};

export const FIXTURE_STATES: FixtureState[] = [
    "empty",
    "active",
    "grounded",
    "working",
    "weak",
    "notfound",
    "stale",
    "contextual",
    "narrow",
];
