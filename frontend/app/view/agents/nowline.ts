// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The working line drawn under a working agent's last transcript item: the spinner's verb, the turn's elapsed time,
// its output tokens and tool count. Derived from the transcript entries, the agent's state, the block's last hook and
// the parsed spinner row. Pure, unit-tested in nowline.test.ts; nowlineview.tsx renders it. A finished turn's time
// and count are the fold line's, and the running call's verb and target its step row's.

import type { AgentEntry, AgentState } from "./agentsviewmodel";
import { fmtDuration } from "./runcompletion";
import type { SpinnerRead } from "./spinnerrow";

// a UserPromptSubmit hook later than the transcript's turn start by more than this is a turn not yet transcribed
export const TURN_SKEW_MS = 2000;
const SUBMIT_HOOK = "UserPromptSubmit";
const SEP = " · ";

export interface TurnSummary {
    startTs?: number;
    tools: number;
}

export type NowLine =
    | { kind: "hidden" }
    | {
          kind: "working";
          spinner: SpinnerRead | null;
          elapsedMs?: number;
          // output tokens as the spinner shows them ("1.8k")
          tokens?: string;
          tools: number;
      };

/** The turn that starts at the last user entry or user-typed command; null when there is none. */
export function summarizeTurn(entries: AgentEntry[]): TurnSummary | null {
    let start = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
        if (startsTurn(entries[i])) {
            start = i;
            break;
        }
    }
    if (start < 0) {
        return null;
    }
    const first = entries[start] as Extract<AgentEntry, { kind: "user" | "command" }>;
    const summary: TurnSummary = { tools: 0 };
    if (first.ts != null) {
        summary.startTs = first.ts;
    }
    for (const e of entries.slice(start + 1)) {
        if (e.kind === "action") {
            summary.tools++;
        }
    }
    return summary;
}

function startsTurn(e: AgentEntry): boolean {
    return e.kind === "user" || e.kind === "command";
}

export function nowLineState(input: {
    state: AgentState;
    docked: boolean;
    entries: AgentEntry[];
    spinner: SpinnerRead | null;
    lastHook: { hook: string; ts: number } | null;
    now: number;
}): NowLine {
    const { state, docked, spinner, lastHook, now } = input;
    if (docked || state !== "working") {
        return { kind: "hidden" };
    }
    let turn = summarizeTurn(input.entries);
    // between Send and Claude writing the user line, the previous turn's time and count must not read as this one's
    const submitted = lastHook?.hook === SUBMIT_HOOK;
    if (submitted && (turn == null || (turn.startTs != null && lastHook.ts - turn.startTs > TURN_SKEW_MS))) {
        turn = { startTs: lastHook.ts, tools: 0 };
    }
    const line: NowLine = { kind: "working", spinner, tools: turn?.tools ?? 0 };
    if (turn?.startTs != null) {
        line.elapsedMs = now - turn.startTs;
    }
    if (spinner?.tokens != null) {
        line.tokens = spinner.tokens;
    }
    return line;
}

function toolCount(n: number): string {
    return n === 1 ? "1 tool" : `${n} tools`;
}

/** The line's copy: the spinner's glyph and verb (null with no spinner on screen) and the facts after it. A compact
 *  host drops the tool count. */
export function nowLineText(line: NowLine, compact = false): { lead: string | null; rest: string } {
    if (line.kind === "hidden") {
        return { lead: null, rest: "" };
    }
    const parts = [
        line.spinner == null ? "Working" : undefined,
        line.elapsedMs == null ? undefined : fmtDuration(line.elapsedMs),
        line.tokens == null ? undefined : `↓ ${line.tokens} tokens`,
        compact || line.tools === 0 ? undefined : toolCount(line.tools),
    ];
    const rest = parts.filter((p) => p != null).join(SEP);
    return { lead: line.spinner == null ? null : `${line.spinner.glyph} ${line.spinner.verb}`, rest };
}
