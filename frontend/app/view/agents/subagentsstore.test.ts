// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({ GetSubagentsCommand: vi.fn(), GetAgentTranscriptCommand: vi.fn() }));
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: rpc }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import { globalStore } from "@/app/store/jotaiStore";
import type { SubagentVM } from "./session-models/sessionviewmodel";
import { refreshSubagents, subagentsByIdAtom } from "./subagentsstore";

describe("refreshSubagents", () => {
    it("keeps the last known list when a read fails, rather than reading as the subagents finishing", async () => {
        const list = [{ agentId: "s1" }] as unknown as SubagentVM[];
        globalStore.set(subagentsByIdAtom, { a1: list });
        rpc.GetSubagentsCommand.mockRejectedValue(new Error("timeout"));
        rpc.GetAgentTranscriptCommand.mockResolvedValue({ lines: [] });
        vi.spyOn(console, "warn").mockImplementation(() => {});

        await refreshSubagents("a1", "/t.jsonl");

        expect(globalStore.get(subagentsByIdAtom).a1).toBe(list);
    });

    it("clears the list when a read finds no subagents", async () => {
        globalStore.set(subagentsByIdAtom, { a1: [{ agentId: "s1" }] as unknown as SubagentVM[] });
        rpc.GetSubagentsCommand.mockResolvedValue({ subagents: [] });
        rpc.GetAgentTranscriptCommand.mockResolvedValue({ lines: [] });

        await refreshSubagents("a1", "/t.jsonl");

        expect(globalStore.get(subagentsByIdAtom).a1).toBeUndefined();
    });
});
