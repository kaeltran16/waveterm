// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure copy/tone decisions for a Jarvis turn. Split out of the renderer so the badge wording is
// testable and identical wherever a turn is drawn (the recall thread and a run's thread).

import type { Terminal } from "./jarviscontract";

export interface TerminalBadge {
    label: string;
    tone: "muted" | "warning" | "error";
}

// A normal answer wears no badge. "weak" warns because acting on it is a risk; "notfound" is merely a
// stated absence, so it stays muted. "error" is not a verdict on the corpus at all — the request died —
// so it takes the error tone and is the only state that offers a retry.
export function terminalBadge(terminal: Terminal): TerminalBadge | null {
    switch (terminal) {
        case "weak":
            return { label: "Weak grounding", tone: "warning" };
        case "notfound":
            return { label: "Not found", tone: "muted" };
        case "error":
            return { label: "Couldn't reach Jarvis", tone: "error" };
        case "cancelled":
            return { label: "Cancelled", tone: "muted" };
        default:
            return null;
    }
}

// What a failed converse stream should become. Null means "leave the turn alone": a user cancel has
// already set its own terminal, and gen.return() can surface here as a throw.
export function terminalAfterStreamFailure(cancelled: boolean): Terminal | null {
    return cancelled ? null : "error";
}
