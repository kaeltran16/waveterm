// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import * as keyutil from "@/util/keyutil";
import type { Binding, KeyContext, MatchResult } from "./types";

export function isSequenceKeys(keys: string): boolean {
    return keys.includes(" ");
}

function hasModifier(e: WaveKeyboardEvent): boolean {
    return !!(e.control || e.alt || e.meta || e.cmd || e.option);
}

// Pure. No DOM, no atoms. `ctx.leader` carries the active leader prefix (or null).
export function matchBinding(waveEvent: WaveKeyboardEvent, ctx: KeyContext, bindings: Binding[]): MatchResult {
    const active = bindings.filter((b) => (b.when ? b.when(ctx) : true));
    const sequences = active.filter((b) => isSequenceKeys(b.keys));
    const singles = active.filter((b) => !isSequenceKeys(b.keys));

    if (ctx.leader != null) {
        // A modifier chord during leader mode cancels the leader and is processed normally.
        if (hasModifier(waveEvent)) {
            return { kind: "resetAndProcess", result: matchBinding(waveEvent, { ...ctx, leader: null }, bindings) };
        }
        for (const b of sequences) {
            const [lead, next] = b.keys.split(" ");
            if (lead === ctx.leader && keyutil.checkKeyPressed(waveEvent, next)) {
                return { kind: "run", binding: b };
            }
        }
        return { kind: "reset" };
    }

    // Exact single/chord matches take priority over entering a leader.
    for (const b of singles) {
        if (keyutil.checkKeyPressed(waveEvent, b.keys)) {
            return { kind: "run", binding: b };
        }
    }
    // Leader entry.
    const prefixes = new Set(sequences.map((b) => b.keys.split(" ")[0]));
    for (const p of prefixes) {
        if (keyutil.checkKeyPressed(waveEvent, p)) {
            return { kind: "enterLeader", leader: p };
        }
    }
    return { kind: "none" };
}
