// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { agentStateView } from "./agentstateview";

const agent = { state: "idle" as const, kind: "agent" as const, agent: "claude", startError: undefined };
const base = { agent, ended: false, landed: false, runDone: false, standingBy: false, silentMs: null };

describe("agentStateView", () => {
    it("terminal has no state view", () => {
        expect(agentStateView({ ...base, agent: { ...agent, kind: "terminal" } })).toBeNull();
    });
    it("quiet wins over working", () => {
        const working = { ...agent, state: "working" as const };
        expect(agentStateView({ ...base, agent: working, silentMs: 4 * 60_000 + 5_000 })).toEqual({
            text: "quiet 4m",
            tone: "warning",
        });
    });
    it("failed to start wins over standing by", () => {
        const failed = { ...agent, startError: "refused" };
        expect(agentStateView({ ...base, agent: failed, standingBy: true })).toEqual({
            text: "failed to start",
            tone: "error",
        });
    });
    it("done and landed", () => {
        expect(agentStateView({ ...base, runDone: true })).toEqual({ text: "done", tone: "success" });
        expect(agentStateView({ ...base, ended: true })).toEqual({ text: "done", tone: "success" });
        expect(agentStateView({ ...base, ended: true, landed: true })).toEqual({ text: "landed", tone: "success" });
    });
    it("standing by is accent", () => {
        expect(agentStateView({ ...base, standingBy: true })).toEqual({ text: "standing by", tone: "accent" });
    });
    it("plain idle and asking", () => {
        expect(agentStateView(base)).toEqual({ text: "idle", tone: "idle" });
        expect(agentStateView({ ...base, agent: { ...agent, state: "asking" } })).toEqual({
            text: "asking",
            tone: "asking",
        });
    });
});
