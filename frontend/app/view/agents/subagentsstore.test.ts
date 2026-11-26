// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({ GetSubagentsCommand: vi.fn(), GetAgentTranscriptCommand: vi.fn() }));
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: rpc }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: vi.fn() }));

import { globalStore } from "@/app/store/jotaiStore";
import { getProcExitAtom } from "./agentcontrollerstore";
import type { SubagentVM } from "./session-models/sessionviewmodel";
import {
    dropSubagents,
    focusSubagentAtom,
    openSubagent,
    refreshSubagents,
    SUBAGENT_POLL_MS,
    subagentsByIdAtom,
} from "./subagentsstore";

const file = (over: Partial<SubagentFileInfo>): SubagentFileInfo => ({
    agentid: "c1",
    transcriptpath: "/t/subagents/agent-c1.jsonl",
    firstprompt: "find the parser",
    startedatms: 1,
    done: false,
    toolcount: 3,
    ...over,
});
// the parent's Agent call for the file above, so a correlated child takes its type
const spawnLines = [
    JSON.stringify({
        type: "assistant",
        message: {
            content: [
                { type: "tool_use", id: "tu1", name: "Agent", input: { subagent_type: "Explore", prompt: "find the parser" } },
            ],
        },
    }),
];

afterEach(() => {
    dropSubagents("a1");
    vi.useRealTimers();
    rpc.GetSubagentsCommand.mockReset();
    rpc.GetAgentTranscriptCommand.mockReset();
});

describe("subagent polling", () => {
    it("re-reads only the listing every poll while a child works, keeping the last refresh's spawns", async () => {
        vi.useFakeTimers();
        rpc.GetSubagentsCommand.mockResolvedValue({ subagents: [file({})] });
        rpc.GetAgentTranscriptCommand.mockResolvedValue({ lines: spawnLines });
        await refreshSubagents("a1", "/t.jsonl");
        expect(rpc.GetSubagentsCommand).toHaveBeenCalledWith({}, { path: "/t.jsonl" }, { timeout: 30_000 });

        rpc.GetSubagentsCommand.mockResolvedValue({ subagents: [file({ toolcount: 4 })] });
        await vi.advanceTimersByTimeAsync(SUBAGENT_POLL_MS);
        await vi.advanceTimersByTimeAsync(SUBAGENT_POLL_MS);

        expect(rpc.GetSubagentsCommand).toHaveBeenCalledTimes(3);
        expect(rpc.GetAgentTranscriptCommand).toHaveBeenCalledTimes(1);
        const [child] = globalStore.get(subagentsByIdAtom).a1;
        expect([child.type, child.toolCount]).toEqual(["Explore", 4]);
    });

    it("runs no poll when no child works", async () => {
        vi.useFakeTimers();
        rpc.GetSubagentsCommand.mockResolvedValue({ subagents: [file({ done: true })] });
        rpc.GetAgentTranscriptCommand.mockResolvedValue({ lines: [] });
        await refreshSubagents("a1", "/t.jsonl");

        await vi.advanceTimersByTimeAsync(SUBAGENT_POLL_MS * 3);

        expect(rpc.GetSubagentsCommand).toHaveBeenCalledTimes(1);
    });

    it("turns an unfinished child stopped once the parent's process exited, and stops polling", async () => {
        vi.useFakeTimers();
        rpc.GetSubagentsCommand.mockResolvedValue({ subagents: [file({})] });
        rpc.GetAgentTranscriptCommand.mockResolvedValue({ lines: [] });
        await refreshSubagents("a1", "/t.jsonl", "blk1");
        expect(globalStore.get(subagentsByIdAtom).a1[0].state).toBe("working");

        globalStore.set(getProcExitAtom("blk1"), { code: 0, at: 1 });
        await vi.advanceTimersByTimeAsync(SUBAGENT_POLL_MS);
        await vi.advanceTimersByTimeAsync(SUBAGENT_POLL_MS * 3);

        expect(globalStore.get(subagentsByIdAtom).a1[0].state).toBe("stopped");
        expect(rpc.GetSubagentsCommand).toHaveBeenCalledTimes(2);
        globalStore.set(getProcExitAtom("blk1"), undefined);
    });
});

describe("openSubagent", () => {
    it("focuses the child under its parent", () => {
        openSubagent("p1", { id: "c1", type: "Explore", state: "working", transcriptPath: "/c1.jsonl" });
        expect(globalStore.get(focusSubagentAtom)).toEqual({
            parentId: "p1",
            agentId: "c1",
            transcriptPath: "/c1.jsonl",
            label: "Explore",
        });
        globalStore.set(focusSubagentAtom, null);
    });
});

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
