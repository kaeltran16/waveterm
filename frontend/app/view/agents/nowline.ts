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
// claude's spinner frames, which its terminal spinner plays forward then back
export const SPINNER_FRAMES = ["·", "✢", "✳", "✶", "✻", "✽"];
// the shimmer's half-width in characters; a sweep starts and ends this far outside the verb so it enters and leaves
export const SHIMMER_HALF_CH = 2;

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

/** The drawn glyph `tick` frames in: the frames forward then back, each end shown once per bounce. */
export function spinnerGlyph(tick: number): string {
    const n = SPINNER_FRAMES.length;
    const period = 2 * n - 2;
    const i = tick % period;
    return SPINNER_FRAMES[i < n ? i : period - i];
}

/** The shimmer's centre `tick` frames in, in characters from the verb's start: one character a frame, from just
 *  before the verb to just past it, then over again. */
export function shimmerCenter(tick: number, verbLength: number): number {
    return (tick % (verbLength + 2 * SHIMMER_HALF_CH)) - SHIMMER_HALF_CH;
}

function toolCount(n: number): string {
    return n === 1 ? "1 tool" : `${n} tools`;
}

/** The line's copy: the spinner's verb (null with no spinner on screen) and the facts after it. A compact host drops
 *  the tool count. The spinner's glyph is left out: claude cycles it faster than the 1s screen sample, so a sampled
 *  glyph only jumps; the view draws its own. */
export function nowLineText(line: NowLine, compact = false): { verb: string | null; rest: string } {
    if (line.kind === "hidden") {
        return { verb: null, rest: "" };
    }
    const parts = [
        line.spinner == null ? "Working" : undefined,
        line.elapsedMs == null ? undefined : fmtDuration(line.elapsedMs),
        line.tokens == null ? undefined : `↓ ${line.tokens} tokens`,
        compact || line.tools === 0 ? undefined : toolCount(line.tools),
    ];
    const rest = parts.filter((p) => p != null).join(SEP);
    return { verb: line.spinner?.verb ?? null, rest };
}
