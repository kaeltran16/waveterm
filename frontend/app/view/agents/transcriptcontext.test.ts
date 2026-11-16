// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import { transcriptContextFor } from "./transcriptcontext";

const agent: AgentVM = {
    id: "tab-1",
    name: "loom",
    task: "t",
    state: "idle",
    effortId: "e-1",
    brainstormFile: "C:/b/brainstorm.json",
};

describe("transcriptContextFor", () => {
    it("copies the agent's id, effort and brainstorm with the given model, role and channel", () => {
        const model = {} as AgentsViewModel;
        const role = { kind: "lead", runId: "r-1" } as const;
        expect(transcriptContextFor({ model, agent, role, channelId: "c-1" })).toEqual({
            model,
            agentId: "tab-1",
            role,
            channelId: "c-1",
            effortId: "e-1",
            brainstormFile: "C:/b/brainstorm.json",
        });
    });

    it("without an agent carries no agent fields", () => {
        const ctx = transcriptContextFor({ channelId: "c-1" });
        expect(ctx.agentId).toBeUndefined();
        expect(ctx.effortId).toBeUndefined();
        expect(ctx.channelId).toBe("c-1");
    });
});
