// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { closeTargetForDoubleCtrlC } from "./bindings";

describe("closeTargetForDoubleCtrlC", () => {
    const agents = [
        { id: "agent-tab", name: "Agent", state: "working" },
        { id: "terminal-tab", name: "Terminal", state: "idle", kind: "terminal" },
    ] as any;

    it("does not close an agent session", () => {
        expect(closeTargetForDoubleCtrlC(agents, "agent-tab")).toBeNull();
    });

    it("closes a focused plain terminal row", () => {
        expect(closeTargetForDoubleCtrlC(agents, "terminal-tab")).toEqual(agents[1]);
    });

    it("does not fall back to the first agent when focus is missing", () => {
        expect(closeTargetForDoubleCtrlC(agents, undefined)).toBeNull();
    });
});
