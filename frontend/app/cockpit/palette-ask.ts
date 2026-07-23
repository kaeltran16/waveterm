// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure builder for the command palette's "Ask Jarvis" lead group (mirrors palette-launch.ts). Given the
// typed goal it returns a single rich row whose run() hands the question to deps.ask — which (in
// command-palette.tsx) starts a recall conversation and opens the Jarvis surface. Empty goal => no row.

export interface AskItem {
    key: string; // "ask-jarvis"
    glyph: string; // monospace badge glyph (matches the launch rows' glyph slot)
    mode: string; // "Ask Jarvis"
    desc: string; // the echoed question
    footer: string; // one-line echo shown in the palette footer when selected
    run: () => void;
}

export interface AskDeps {
    ask: (question: string) => void; // start a recall conversation + open the Jarvis surface
}

export function buildAskItems(goal: string, deps: AskDeps): AskItem[] {
    const q = goal.trim();
    if (q === "") {
        return [];
    }
    return [
        {
            key: "ask-jarvis",
            glyph: "✦",
            mode: "Ask Jarvis",
            desc: q,
            footer: `Recall across your Wave knowledge, grounded — “${q}”`,
            run: () => deps.ask(q),
        },
    ];
}
