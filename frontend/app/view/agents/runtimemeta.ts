// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Per-runtime chrome (label, glyph, accent classes) for the roster/header/details badges. Ports the
// RUNTIME() map from Wave-cockpit-live.dc.html. Keyed on an agent's provider string (AgentVM.agent,
// e.g. "claude" | "codex"); unknown providers fall back to claude. The class strings are full literals
// so Tailwind's source scanner emits the utilities.

export interface RuntimeMeta {
    id: "claude" | "codex" | "terminal";
    label: string;
    glyph: string;
    text: string; // text-color utility (glyph/label tint)
    softBg: string; // soft fill utility (pill background)
    line: string; // border-color utility (pill outline)
}

const RUNTIMES: Record<string, RuntimeMeta> = {
    claude: {
        id: "claude",
        label: "Claude Code",
        glyph: "✳",
        text: "text-rt-claude",
        softBg: "bg-rt-claude-soft",
        line: "border-rt-claude-line",
    },
    codex: {
        id: "codex",
        label: "Codex",
        glyph: "◆",
        text: "text-rt-codex",
        softBg: "bg-rt-codex-soft",
        line: "border-rt-codex-line",
    },
    terminal: {
        id: "terminal",
        label: "Terminal",
        glyph: "▮",
        text: "text-rt-terminal",
        softBg: "bg-rt-terminal-soft",
        line: "border-rt-terminal-line",
    },
};

export function runtimeMeta(provider: string | undefined): RuntimeMeta {
    return RUNTIMES[(provider ?? "claude").toLowerCase()] ?? RUNTIMES.claude;
}
