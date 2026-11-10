// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Rendered view's now line: what the agent is doing now and what this turn has done, derived from the
// transcript entries, the agent's state, the block's last hook and the parsed spinner row. Pure, unit-tested in
// nowline.test.ts; nowline.tsx renders it.

import type { AgentEntry, AgentState } from "./agentsviewmodel";
import { fmtDuration } from "./runcompletion";
import type { SpinnerRead } from "./spinnerrow";

// a UserPromptSubmit hook later than the transcript's turn start by more than this is a turn not yet transcribed
export const TURN_SKEW_MS = 2000;
const SUBMIT_HOOK = "UserPromptSubmit";
const SEP = " · ";

export interface TurnSummary {
    startTs?: number;
    endTs?: number;
    tools: number;
    running?: { verb: string; target: string; startedTs?: number };
}

export type NowLine =
    | { kind: "hidden" }
    | {
          kind: "working";
          spinner: SpinnerRead | null;
          elapsedMs?: number;
          tools: number;
          call?: { verb: string; target: string; elapsedMs?: number };
      }
    | { kind: "done"; durationMs?: number; tools: number };

/** The turn that starts at the last user/command entry; null when there is none. */
export function summarizeTurn(entries: AgentEntry[]): TurnSummary | null {
    let start = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
        const k = entries[i].kind;
        if (k === "user" || k === "command") {
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
        if (e.kind === "message" && e.ts != null) {
            summary.endTs = e.ts;
        } else if (e.kind === "action") {
            summary.tools++;
            if (e.pending) {
                summary.running = { verb: e.verb, target: e.target };
                if (e.startedTs != null) {
                    summary.running.startedTs = e.startedTs;
                }
            }
        }
    }
    return summary;
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
    if (docked || state === "asking") {
        return { kind: "hidden" };
    }
    let turn = summarizeTurn(input.entries);
    if (state === "idle") {
        if (turn == null) {
            return { kind: "hidden" };
        }
        const done: NowLine = { kind: "done", tools: turn.tools };
        if (turn.startTs != null && turn.endTs != null) {
            done.durationMs = turn.endTs - turn.startTs;
        }
        return done;
    }
    // between Send and Claude writing the user line, the previous turn's time and count must not read as this one's
    const submitted = lastHook?.hook === SUBMIT_HOOK;
    if (submitted && (turn == null || (turn.startTs != null && lastHook.ts - turn.startTs > TURN_SKEW_MS))) {
        turn = { startTs: lastHook.ts, tools: 0 };
    }
    const line: NowLine = { kind: "working", spinner, tools: turn?.tools ?? 0 };
    if (turn?.startTs != null) {
        line.elapsedMs = now - turn.startTs;
    }
    if (turn?.running != null) {
        const { verb, target, startedTs } = turn.running;
        line.call = { verb, target };
        if (startedTs != null) {
            line.call.elapsedMs = now - startedTs;
        }
    }
    return line;
}

function toolCount(n: number): string {
    return n === 1 ? "1 tool" : `${n} tools`;
}

function joinParts(parts: (string | undefined)[]): string {
    return parts.filter((p) => p != null && p !== "").join(SEP);
}

/** The line's copy. A running call's verb and target are drawn by the view, so they can truncate first. */
export function nowLineText(line: NowLine): { left: string; right: string } {
    if (line.kind === "hidden") {
        return { left: "", right: "" };
    }
    const tools = line.tools > 0 ? toolCount(line.tools) : undefined;
    if (line.kind === "done") {
        const duration = line.durationMs == null ? undefined : fmtDuration(line.durationMs);
        return { left: joinParts(["done", duration, tools]), right: "" };
    }
    let left: string;
    if (line.spinner != null) {
        const { glyph, verb, detail } = line.spinner;
        left = detail == null ? `${glyph} ${verb}` : `${glyph} ${verb} (${detail})`;
    } else {
        left = joinParts(["working", line.elapsedMs == null ? undefined : fmtDuration(line.elapsedMs)]);
    }
    const callTime = line.call?.elapsedMs == null ? undefined : fmtDuration(line.call.elapsedMs);
    return { left, right: joinParts([callTime, tools]) };
}
