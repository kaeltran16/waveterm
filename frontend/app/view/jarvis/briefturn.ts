// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// How the Brief reads one turn. Pure so the thread's two rules are tested: a restored turn's citations stay in its
// prose, and a verdict is badged only when the Brief has not already said it.

import type { JarvisTurn, Terminal } from "./jarviscontract";
import { terminalBadge, type TerminalBadge } from "./jarvisturnderive";

export function turnProse(turn: JarvisTurn): string {
    if (turn.role === "user") {
        return turn.text;
    }
    return turn.segments.map((s) => ("text" in s ? s.text : `[${s.citationRef}]`)).join("");
}

// a failed ask already reads "Ask failed — try again" under the composer, so a badge would say it twice
const BADGED_VERDICTS = new Set<Terminal>(["weak", "notfound"]);

export function turnVerdict(terminal: Terminal): TerminalBadge | null {
    return BADGED_VERDICTS.has(terminal) ? terminalBadge(terminal) : null;
}
