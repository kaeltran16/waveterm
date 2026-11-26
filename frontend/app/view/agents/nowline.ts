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

// a hook that opens a turn later than the transcript's turn start by more than this is a turn not yet transcribed
export const TURN_SKEW_MS = 2000;
// a prompt, and a typed /compact (an auto one reports no hook), which claude transcribes only once it ends
const TURN_START_HOOKS = ["UserPromptSubmit", "PreCompact"];
const SEP = " · ";
// claude's spinner frames, which its terminal spinner plays forward then back
export const SPINNER_FRAMES = ["·", "✢", "✳", "✶", "✻", "✽"];
// the shimmer's half-width in characters; a sweep starts and ends this far outside the verb so it enters and leaves
export const SHIMMER_HALF_CH = 2;
// claude's own spinner pace
export const SPINNER_FRAME_MS = 120;
// the frames forward then back, each end shown once
const GLYPH_BOUNCE_FRAMES = 2 * SPINNER_FRAMES.length - 2;
// one glyph turn spans two bounces, so it spins slower than the frames step
const GLYPH_CYCLE_FRAMES = 2 * GLYPH_BOUNCE_FRAMES;
export const GLYPH_CYCLE_MS = GLYPH_CYCLE_FRAMES * SPINNER_FRAME_MS;
const GLYPH_SCALE_MIN = 0.9;
const GLYPH_SCALE_MAX = 1.1;

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

/** A turn the last hook opened that the transcript has written nothing for yet: the newest record predates the hook
 *  by more than the skew and no call is running. Until it lands, the transcript's last turn is a finished one, so a
 *  timeline drawing it live would open its work and fold it again when the prompt arrives. */
export function turnAwaitingTranscript(entries: AgentEntry[], lastHook: { hook: string; ts: number } | null): boolean {
    if (lastHook == null || !TURN_START_HOOKS.includes(lastHook.hook)) {
        return false;
    }
    for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (e.kind === "action" && e.pending) {
            return false;
        }
        const ts = "ts" in e ? e.ts : undefined;
        if (ts != null) {
            const end = e.kind === "action" ? ts + (e.durationMs ?? 0) : ts;
            return lastHook.ts - end > TURN_SKEW_MS;
        }
    }
    return false;
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
    const submitted = lastHook != null && TURN_START_HOOKS.includes(lastHook.hook);
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

/** One sweep of the shimmer's centre, in characters from the verb's start: from just before the verb to just past
 *  it, one character per spinner frame, so a longer verb takes longer. */
export function shimmerSweep(verbLength: number): { from: number; to: number; durationMs: number } {
    const span = verbLength + 2 * SHIMMER_HALF_CH;
    return { from: -SHIMMER_HALF_CH, to: verbLength + SHIMMER_HALF_CH, durationMs: span * SPINNER_FRAME_MS };
}

/** The glyph `phase` (0..1) into one GLYPH_CYCLE_MS: claude's frame cycle at its own pace, plus one full turn and a
 *  scale that swells and shrinks with the frames, so the frame steps read as one continuous motion. */
export function glyphPose(phase: number): { glyph: string; rotate: number; scale: number } {
    const p = ((phase % 1) + 1) % 1;
    const tick = Math.floor(p * GLYPH_CYCLE_FRAMES);
    // 0 at the smallest frame, 1 at the largest, back to 0: the frames' own bounce, made continuous
    const bounces = GLYPH_CYCLE_FRAMES / GLYPH_BOUNCE_FRAMES;
    const swell = 1 - Math.abs(((p * bounces) % 1) * 2 - 1);
    return {
        glyph: spinnerGlyph(tick),
        rotate: p * 360,
        scale: GLYPH_SCALE_MIN + (GLYPH_SCALE_MAX - GLYPH_SCALE_MIN) * swell,
    };
}

export function toolCount(n: number): string {
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
