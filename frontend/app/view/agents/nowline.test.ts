// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentActionEntry, AgentEntry, AgentState } from "./agentsviewmodel";
import {
    GLYPH_CYCLE_MS,
    glyphPose,
    nowLineState,
    nowLineText,
    SHIMMER_HALF_CH,
    shimmerSweep,
    SPINNER_FRAME_MS,
    SPINNER_FRAMES,
    spinnerGlyph,
    subagentChipText,
    subagentNowLine,
    subagentsRunningText,
    summarizeTurn,
    TURN_SKEW_MS,
    turnAwaitingTranscript,
    type NowLine,
} from "./nowline";
import { fmtDuration } from "./runcompletion";
import type { SubagentVM } from "./session-models/sessionviewmodel";
import type { SpinnerRead } from "./spinnerrow";

const T0 = 1_800_000_000_000;
const SPINNER: SpinnerRead = { glyph: "✻", verb: "Undulating…", detail: "58s · ↓ 4.5k tokens", tokens: "4.5k" };
const NO_TOKENS: SpinnerRead = { glyph: "✶", verb: "Pondering…", detail: "12s · ↑ 1.2k tokens" };

const user = (ts?: number): AgentEntry => ({ kind: "user", text: "do it", ts });
const msg = (ts?: number): AgentEntry => ({ kind: "message", text: "ok", ts });
const done = (target = "a.ts"): AgentEntry => ({ kind: "action", verb: "read", target, outcome: "ok" });
const pending = (target: string, startedTs?: number): AgentEntry => ({
    kind: "action",
    verb: "bash",
    target,
    pending: true,
    startedTs,
});
const actions = (n: number): AgentEntry[] => Array.from({ length: n }, (_, i) => done(`f${i}.ts`));

function line(over: {
    state?: AgentState;
    docked?: boolean;
    entries: AgentEntry[];
    spinner?: SpinnerRead | null;
    lastHook?: { hook: string; ts: number } | null;
    now?: number;
}): NowLine {
    return nowLineState({
        state: over.state ?? "working",
        docked: over.docked ?? false,
        entries: over.entries,
        spinner: over.spinner ?? null,
        lastHook: over.lastHook ?? null,
        now: over.now ?? T0 + 60_000,
    });
}

describe("summarizeTurn", () => {
    it("counts only the actions after the last user or command entry", () => {
        const entries = [user(T0 - 99_000), ...actions(5), msg(T0 - 90_000), user(T0), ...actions(2), msg(T0 + 5_000)];
        expect(summarizeTurn(entries)).toEqual({ startTs: T0, tools: 2 });
    });

    it("starts a turn at a command entry", () => {
        const entries: AgentEntry[] = [user(T0 - 9_000), done(), { kind: "command", name: "/review", ts: T0 }, done()];
        expect(summarizeTurn(entries)).toEqual({ startTs: T0, tools: 1 });
    });

    it("is null with no user or command entry", () => {
        expect(summarizeTurn([msg(T0), done()])).toBeNull();
        expect(summarizeTurn([])).toBeNull();
    });
});

describe("nowLineState", () => {
    it("carries the spinner's output tokens, the turn's elapsed and only this turn's tools", () => {
        const entries = [user(T0 - 99_000), ...actions(4), user(T0), ...actions(3)];
        expect(line({ entries, spinner: SPINNER })).toEqual({
            kind: "working",
            spinner: SPINNER,
            elapsedMs: 60_000,
            tokens: "4.5k",
            tools: 3,
        });
    });

    it("has no tokens when the spinner shows no output count", () => {
        const l = line({ entries: [user(T0), done()], spinner: NO_TOKENS });
        expect(l.kind === "working" && "tokens" in l).toBe(false);
    });

    it("does not carry the running call: it is the step row's", () => {
        const now = T0 + 100_000;
        const entries = [user(T0), done(), done(), pending("go test ./pkg/jarvis", now - 42_000)];
        const l = line({ entries, spinner: SPINNER, now });
        expect(l).toEqual({ kind: "working", spinner: SPINNER, elapsedMs: 100_000, tokens: "4.5k", tools: 3 });
        expect(nowLineText(l).rest).not.toContain("go test");
    });

    it("working with no known turn start has no elapsed", () => {
        expect(line({ entries: [user()] })).toEqual({ kind: "working", spinner: null, tools: 0 });
    });

    it("a submit the transcript has not caught up with reads as a fresh turn", () => {
        const entries = [user(T0), ...actions(5), msg(T0 + 50_000)];
        const hookTs = T0 + 10_000 + 50_000;
        const l = line({ entries, lastHook: { hook: "UserPromptSubmit", ts: hookTs }, now: hookTs });
        expect(l).toEqual({ kind: "working", spinner: null, elapsedMs: 0, tools: 0 });
    });

    it("a submit within the skew of the transcript's turn start is that turn", () => {
        const entries = [user(T0), ...actions(2)];
        const l = line({ entries, lastHook: { hook: "UserPromptSubmit", ts: T0 + TURN_SKEW_MS }, now: T0 + 5_000 });
        expect(l).toEqual({ kind: "working", spinner: null, elapsedMs: 5_000, tools: 2 });
    });

    it("a submit before the transcript has any user entry starts the turn", () => {
        const l = line({ entries: [], lastHook: { hook: "UserPromptSubmit", ts: T0 }, now: T0 + 3_000 });
        expect(l).toEqual({ kind: "working", spinner: null, elapsedMs: 3_000, tools: 0 });
    });

    it("a /compact after the turn ended reads as its own fresh turn, not the last turn's time and tools", () => {
        const entries = [user(T0), ...actions(2), msg(T0 + 30_000)];
        const hookTs = T0 + 60_000;
        const l = line({ entries, lastHook: { hook: "PreCompact", ts: hookTs }, now: hookTs + 4_000 });
        expect(l).toEqual({ kind: "working", spinner: null, elapsedMs: 4_000, tools: 0 });
    });

    it("other hooks never start a turn", () => {
        const entries = [user(T0), done()];
        const l = line({ entries, lastHook: { hook: "PreToolUse", ts: T0 + 30_000 }, now: T0 + 40_000 });
        expect(l).toMatchObject({ kind: "working", elapsedMs: 40_000, tools: 1 });
    });

    it("hides while a dock holds the slot, while asking, and once idle", () => {
        const entries = [user(T0), done(), msg(T0 + 10_000)];
        expect(line({ entries, docked: true, spinner: SPINNER })).toEqual({ kind: "hidden" });
        expect(line({ entries, state: "asking" })).toEqual({ kind: "hidden" });
        expect(line({ entries, state: "idle", spinner: SPINNER })).toEqual({ kind: "hidden" });
    });
});

describe("nowLineText", () => {
    const working = line({ entries: [user(T0), ...actions(3)], spinner: SPINNER });

    it("leads with the spinner's verb, then elapsed and tokens", () => {
        const { verb, rest } = nowLineText(working);
        expect(verb).toBe(SPINNER.verb);
        expect(rest.indexOf(fmtDuration(60_000))).toBe(0);
        expect(rest).toContain("4.5k");
        expect(rest).toContain("3");
    });

    // the screen is sampled once a second while claude cycles its glyph many times a second: a copy keyed on the
    // sampled glyph cross-faded the verb out and back in on nearly every tick
    it("is the same copy whichever spinner glyph the screen was sampled on", () => {
        const at = (glyph: string) => nowLineText(line({ entries: [user(T0)], spinner: { ...SPINNER, glyph } }));
        expect(at("✢")).toEqual(at("✽"));
    });

    it("a compact host drops the tool count and keeps the rest", () => {
        const full = nowLineText(working).rest;
        const compact = nowLineText(working, true).rest;
        expect(compact).not.toContain("3");
        expect(full.startsWith(compact)).toBe(true);
        expect(compact).toContain("4.5k");
    });

    it("with no spinner there is no lead and the elapsed still shows", () => {
        const { verb, rest } = nowLineText(line({ entries: [user(T0), done()], now: T0 + 2_000 }));
        expect(verb).toBeNull();
        expect(rest).toContain(fmtDuration(2_000));
    });

    it("hidden has no copy", () => {
        expect(nowLineText({ kind: "hidden" })).toEqual({ verb: null, rest: "" });
    });
});

describe("spinnerGlyph", () => {
    it("plays the frames forward then back, each end once per bounce", () => {
        const n = SPINNER_FRAMES.length;
        const seq = Array.from({ length: 2 * (2 * n - 2) }, (_, t) => spinnerGlyph(t));
        const bounce = [...SPINNER_FRAMES, ...SPINNER_FRAMES.slice(1, -1).reverse()];
        expect(seq).toEqual([...bounce, ...bounce]);
    });
});

describe("shimmerSweep", () => {
    it("sweeps from before the verb to past it at one character per spinner frame", () => {
        const len = 10;
        const sweep = shimmerSweep(len);
        expect(sweep.from).toBe(-SHIMMER_HALF_CH);
        expect(sweep.to).toBe(len + SHIMMER_HALF_CH);
        expect(sweep.durationMs).toBe((sweep.to - sweep.from) * SPINNER_FRAME_MS);
    });
});

describe("glyphPose", () => {
    const n = SPINNER_FRAMES.length;
    const frames = 2 * (2 * n - 2);
    const at = (tick: number) => glyphPose((tick + 0.5) / frames);

    it("steps claude's frames at its pace across one cycle", () => {
        expect(Array.from({ length: frames }, (_, t) => at(t).glyph)).toEqual(
            Array.from({ length: frames }, (_, t) => spinnerGlyph(t))
        );
        expect(GLYPH_CYCLE_MS).toBe(frames * SPINNER_FRAME_MS);
    });

    it("turns once per cycle and swells largest on the largest frame", () => {
        expect(glyphPose(0).rotate).toBe(0);
        expect(glyphPose(0.5).rotate).toBe(180);
        const largest = at(n - 1);
        expect(largest.glyph).toBe(SPINNER_FRAMES.at(-1));
        expect(largest.scale).toBeGreaterThan(at(0).scale);
        expect(glyphPose(0).scale).toBeCloseTo(glyphPose(0.999).scale, 1);
    });
});

describe("turnAwaitingTranscript", () => {
    const submit = (ts: number) => ({ hook: "UserPromptSubmit", ts });
    const finished = [user(T0), done(), msg(T0 + 30_000)];
    it.each([
        ["a submit after the last turn's reply, before its prompt lands", finished, submit(T0 + 60_000), true],
        ["a /compact after the turn ended", finished, { hook: "PreCompact", ts: T0 + 60_000 }, true],
        ["the prompt has landed", [...finished, user(T0 + 60_000)], submit(T0 + 60_000), false],
        ["a submit within the skew of the newest record", finished, submit(T0 + 30_000 + TURN_SKEW_MS), false],
        ["a submit while a call runs", [user(T0), pending("go test", T0 + 1_000)], submit(T0 + 60_000), false],
        [
            "a submit while a finished call's run reaches it",
            [user(T0), { ...done(), ts: T0 + 1_000, durationMs: 58_000 }],
            submit(T0 + 60_000),
            false,
        ],
        ["a hook that opens no turn", finished, { hook: "PreToolUse", ts: T0 + 60_000 }, false],
        ["no hook", finished, null, false],
        ["no record carries a time", [user(), done(), msg()], submit(T0), false],
    ])("%s", (_name, entries, hook, want) => {
        expect(turnAwaitingTranscript(entries as AgentEntry[], hook)).toBe(want);
    });
});

describe("subagentNowLine", () => {
    const NOW = T0 + 600_000;
    const grep: AgentActionEntry = { kind: "action", verb: "grep", target: "parsePlan(", pending: true };
    const sub = (over: Partial<SubagentVM>): SubagentVM => ({
        id: "s",
        type: "general-purpose",
        state: "working",
        background: true,
        ...over,
    });
    const older = sub({ id: "research", startedAtMs: NOW - 290_000 });
    const newer = sub({ id: "audit", startedAtMs: NOW - 240_000, currentCall: grep });

    it.each([
        ["no subagents", []],
        ["only a foreground one", [sub({ background: false, startedAtMs: NOW - 1_000 })]],
        ["only a finished background one", [sub({ state: "done", startedAtMs: NOW - 1_000 })]],
    ])("is hidden with %s", (_name, subs) => {
        expect(subagentNowLine(subs as SubagentVM[], false, NOW)).toEqual({ kind: "hidden" });
        expect(subagentNowLine(subs as SubagentVM[], true, NOW)).toEqual({ kind: "hidden" });
    });

    it("names the one running background subagent while the parent is idle, with no count", () => {
        expect(subagentNowLine([newer], false, NOW)).toEqual({
            kind: "named",
            sub: newer,
            call: { title: "Searched", mono: "parsePlan(" },
            elapsedMs: 240_000,
        });
    });

    it("names the most recently started of two while the parent is idle, and counts them", () => {
        const line = subagentNowLine([older, newer], false, NOW);
        expect(line).toMatchObject({ kind: "named", sub: newer, count: 2 });
        expect(subagentsRunningText(2)).toBe("2 subagents running");
    });

    it("gives the working parent a chip that counts them and opens the most recent", () => {
        expect(subagentNowLine([older], true, NOW)).toEqual({ kind: "chip", sub: older, count: 1 });
        expect(subagentNowLine([older, newer], true, NOW)).toEqual({ kind: "chip", sub: newer, count: 2 });
        expect(subagentChipText(1)).toBe("1 subagent");
        expect(subagentChipText(2)).toBe("2 subagents");
    });
});
