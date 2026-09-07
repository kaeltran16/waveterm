// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure builder for the command palette's "Launch" lead group (Ctrl+P fast-dispatch).
// The typed query is the *goal*, not a filter — these rows are always shown (never ranked)
// when there is a goal and an active channel. The component injects the impure deps
// (dispatch/run/consult) and renders LaunchItem's presentational fields.

export interface LaunchItem {
    key: string; // launch:quick | launch:run | launch:consult:claude | launch:consult:codex
    glyph: string; // monospace badge glyph
    mode: string; // "Quick · claude", "Run", "Ask · claude", "Ask · codex"
    suffix: string; // Run strategy suffix, e.g. " · pipeline" (else "")
    desc: string; // mono subtitle describing the mode
    footer: string; // one-line echo of what firing this row does to the goal
    run: () => void;
}

export interface LaunchDeps {
    quick: (goal: string) => void; // Quick: a single-phase run, one worker
    run: (goal: string) => void; // top-level run, Quick by default
    consult: (runtime: string, goal: string) => void; // Ask: one-shot, no worker
}

// Empty goal or no channel -> []. Otherwise the 4 launch rows, Quick first (preselected by the caller).
export function buildLaunchItems(
    query: string,
    channelName: string | undefined,
    deps: LaunchDeps
): LaunchItem[] {
    const goal = query.trim();
    if (!goal || !channelName) {
        return [];
    }
    return [
        {
            key: "launch:quick",
            glyph: "↯",
            mode: "Quick · claude",
            suffix: "",
            desc: "one worker · no phases",
            footer: `Spawns a Quick worker on “${goal}” in #${channelName}`,
            run: () => deps.quick(goal),
        },
        {
            key: "launch:run",
            glyph: "▸▸",
            mode: "Run",
            suffix: " · quick",
            desc: "one worker · no plan gate",
            footer: `Starts a quick run on “${goal}” in #${channelName}`,
            run: () => deps.run(goal),
        },
        {
            key: "launch:consult:claude",
            glyph: "?",
            mode: "Ask · claude",
            suffix: "",
            desc: "one-shot consult · no worker",
            footer: `Asks claude about “${goal}” — no worker spawned`,
            run: () => deps.consult("claude", goal),
        },
        {
            key: "launch:consult:codex",
            glyph: "?",
            mode: "Ask · codex",
            suffix: "",
            desc: "one-shot consult · different model",
            footer: `Asks codex about “${goal}” — no worker spawned`,
            run: () => deps.consult("codex", goal),
        },
    ];
}
