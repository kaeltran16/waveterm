// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure copy/tone decisions for a Jarvis turn. Split out of the renderer so the badge wording is
// testable and identical wherever a turn is drawn (the recall thread and a run's thread).

import type { Terminal } from "./jarviscontract";

export interface TerminalBadge {
    label: string;
    tone: "muted" | "warning";
}

// A normal answer wears no badge. "weak" warns because acting on it is a risk; "notfound" is merely a
// stated absence, so it stays muted.
export function terminalBadge(terminal: Terminal): TerminalBadge | null {
    switch (terminal) {
        case "weak":
            return { label: "Weak grounding", tone: "warning" };
        case "notfound":
            return { label: "Not found", tone: "muted" };
        default:
            return null;
    }
}
