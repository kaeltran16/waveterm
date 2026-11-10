// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentEntry, AgentState } from "./agentsviewmodel";
import { nowLineState, nowLineText, summarizeTurn, TURN_SKEW_MS, type NowLine } from "./nowline";
import type { SpinnerRead } from "./spinnerrow";

const T0 = 1_800_000_000_000;
const SPINNER: SpinnerRead = { glyph: "✻", verb: "Undulating…", detail: "58s · ↓ 4.5k tokens" };

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
        expect(summarizeTurn(entries)).toEqual({ startTs: T0, endTs: T0 + 5_000, tools: 2 });
    });

    it("starts a turn at a command entry", () => {
        const entries: AgentEntry[] = [user(T0 - 9_000), done(), { kind: "command", name: "/review", ts: T0 }, done()];
        expect(summarizeTurn(entries)).toMatchObject({ startTs: T0, tools: 1 });
    });

    it("a Skill the model calls mid-turn is one of the turn's tools, not a new turn", () => {
        const skill: AgentEntry = { kind: "command", name: "verify", isSkill: true, byModel: true, ts: T0 + 3_000 };
        const entries = [user(T0), done(), skill, done(), msg(T0 + 9_000)];
        expect(summarizeTurn(entries)).toEqual({ startTs: T0, endTs: T0 + 9_000, tools: 3 });
    });

    it("is null with no user or command entry", () => {
        expect(summarizeTurn([msg(T0), done()])).toBeNull();
        expect(summarizeTurn([])).toBeNull();
    });
});

describe("nowLineState", () => {
    it("working with a spinner and no pending call: no call, tools count only this turn", () => {
        const entries = [user(T0 - 99_000), ...actions(4), user(T0), ...actions(3)];
        const l = line({ entries, spinner: SPINNER });
        expect(l).toEqual({ kind: "working", spinner: SPINNER, elapsedMs: 60_000, tools: 3 });
        expect(nowLineText(l)).toEqual({ left: "✻ Undulating… (58s · ↓ 4.5k tokens)", right: "3 tools" });
    });

    it("working with a pending call shows its elapsed time", () => {
        const now = T0 + 100_000;
        const entries = [user(T0), done(), done(), pending("go test ./pkg/jarvis", now - 42_000)];
        const l = line({ entries, spinner: SPINNER, now });
        expect(l.kind === "working" && l.call).toEqual({
            verb: "bash",
            target: "go test ./pkg/jarvis",
            elapsedMs: 42_000,
        });
        expect(nowLineText(l).right).toBe("42s · 3 tools");
    });

    it("two pending calls: the later one shows", () => {
        const entries = [user(T0), pending("first", T0 + 1_000), pending("second", T0 + 2_000)];
        const l = line({ entries, spinner: SPINNER });
        expect(l.kind === "working" && l.call?.target).toBe("second");
    });

    it("a pending call without startedTs has no elapsed", () => {
        const l = line({ entries: [user(T0), pending("x")], spinner: SPINNER });
        expect(l.kind === "working" && l.call).toEqual({ verb: "bash", target: "x" });
        expect(nowLineText(l).right).toBe("1 tool");
    });

    it("working with no spinner reads the time since the turn started", () => {
        const l = line({ entries: [user(T0)], now: T0 + 2_000 });
        expect(nowLineText(l)).toEqual({ left: "working · 2s", right: "" });
    });

    it("working with no known turn start reads bare working", () => {
        expect(nowLineText(line({ entries: [user()] }))).toEqual({ left: "working", right: "" });
    });

    it("idle after a turn reads done with its length and tool count", () => {
        const entries = [user(T0), ...actions(12), msg(T0 + 190_000)];
        expect(nowLineText(line({ state: "idle", entries }))).toEqual({ left: "done · 3m 10s · 12 tools", right: "" });
    });

    it("idle with no message time reads done with only the tool count", () => {
        const entries = [user(T0), ...actions(12), msg()];
        expect(nowLineText(line({ state: "idle", entries })).left).toBe("done · 12 tools");
    });

    it("idle wins over a spinner row still on screen", () => {
        const entries = [user(T0), ...actions(2), msg(T0 + 10_000)];
        const l = line({ state: "idle", entries, spinner: SPINNER });
        expect(l).toEqual({ kind: "done", durationMs: 10_000, tools: 2 });
    });

    it("a submit the transcript has not caught up with reads as a fresh turn", () => {
        const entries = [user(T0), ...actions(5), msg(T0 + 50_000)];
        const hookTs = T0 + 10_000 + 50_000;
        const l = line({ entries, lastHook: { hook: "UserPromptSubmit", ts: hookTs }, now: hookTs });
        expect(l).toEqual({ kind: "working", spinner: null, elapsedMs: 0, tools: 0 });
        expect(nowLineText(l)).toEqual({ left: "working · 0s", right: "" });
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

    it("other hooks never start a turn", () => {
        const entries = [user(T0), done()];
        const l = line({ entries, lastHook: { hook: "PreToolUse", ts: T0 + 30_000 }, now: T0 + 40_000 });
        expect(l).toMatchObject({ kind: "working", elapsedMs: 40_000, tools: 1 });
    });

    it("hides while a dock holds the slot, while asking, and with no turn", () => {
        const entries = [user(T0), done()];
        expect(line({ entries, docked: true })).toEqual({ kind: "hidden" });
        expect(line({ entries, state: "asking" })).toEqual({ kind: "hidden" });
        expect(line({ entries: [msg(T0)], state: "idle" })).toEqual({ kind: "hidden" });
        expect(nowLineText({ kind: "hidden" })).toEqual({ left: "", right: "" });
    });

    it("one tool reads singular", () => {
        const entries = [user(T0), done(), msg(T0 + 42_000)];
        expect(nowLineText(line({ state: "idle", entries })).left).toBe("done · 42s · 1 tool");
    });
});
