// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// ↑ and ↓ in the Rendered box: they step through the session's own typed prompts, as Claude Code's box does.

import type { AgentEntry } from "./agentsviewmodel";
import { arcMessageOf } from "./arcmessage";

export type BoxKeyState = {
    text: string;
    // newest first (promptHistory)
    history: readonly string[];
    // the history index last recalled; the box is in recall only while its text still equals that entry
    recall: number | null;
};

export type BoxKeyAction = { recall: number | null; text: string };

// null: the key is not the box's, so the caret moves as usual
export function boxKey(key: "ArrowUp" | "ArrowDown", s: BoxKeyState): BoxKeyAction | null {
    const at = s.recall != null && s.history[s.recall] === s.text ? s.recall : null;
    if (key === "ArrowDown") {
        if (at == null) {
            return null;
        }
        return at === 0 ? { recall: null, text: "" } : step(s.history, at - 1);
    }
    if (at != null) {
        return step(s.history, Math.min(at + 1, s.history.length - 1));
    }
    if (s.text !== "") {
        return null;
    }
    return s.history.length > 0 ? step(s.history, 0) : null;
}

function step(history: readonly string[], i: number): BoxKeyAction {
    return { recall: i, text: history[i] };
}

// The session's typed prompts, newest first: user entries Arc did not write and slash commands, a prompt sent twice in
// a row once. Shell runs are not prompts.
export function promptHistory(entries: readonly AgentEntry[]): string[] {
    const out: string[] = [];
    for (const e of entries) {
        const text = typedText(e);
        if (text !== "" && out[out.length - 1] !== text) {
            out.push(text);
        }
    }
    return out.reverse();
}

function typedText(e: AgentEntry): string {
    if (e.kind === "command") {
        return e.args ? `${e.name} ${e.args}` : e.name;
    }
    if (e.kind === "user" && arcMessageOf(e, false) == null) {
        return e.text.trim();
    }
    return "";
}
