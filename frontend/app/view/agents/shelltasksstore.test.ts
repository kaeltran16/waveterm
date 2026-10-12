// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        GetAgentTranscriptCommand: vi.fn(),
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import type { ShellTask } from "./shelltasks";
import { readShellTaskOutput, refreshShellTasks, shellTaskPollIds, shellTasksByIdAtom } from "./shelltasksstore";

const transcript = vi.mocked(RpcApi.GetAgentTranscriptCommand);

const task = (id: string, state: ShellTask["state"]): ShellTask => ({ id, description: id, state });

afterEach(() => {
    transcript.mockReset();
});

describe("readShellTaskOutput", () => {
    it("resolves to no lines when the file cannot be read", async () => {
        transcript.mockRejectedValue(new Error("reading agent transcript: open x.output: no such file"));
        await expect(readShellTaskOutput("C:/tmp/tasks/x.output")).resolves.toEqual([]);
    });

    it("returns the last 4 KB of the lines, dropping a cut leading line", async () => {
        const lines = ["a".repeat(3000), "b".repeat(3000), "tail"];
        transcript.mockResolvedValue({ lines });
        const out = await readShellTaskOutput("C:/tmp/tasks/x.output");
        expect(out).toEqual(["b".repeat(3000), "tail"]);
        expect(transcript).toHaveBeenCalledWith({}, { path: "C:/tmp/tasks/x.output", maxlines: 80 });
    });

    it("returns short output unchanged", async () => {
        transcript.mockResolvedValue({ lines: ["[exited with code 0]"] });
        await expect(readShellTaskOutput("C:/tmp/tasks/x.output")).resolves.toEqual(["[exited with code 0]"]);
    });
});

describe("refreshShellTasks", () => {
    it("keeps the last known list when a transcript read fails", async () => {
        const known = [task("t1", "running")];
        globalStore.set(shellTasksByIdAtom, { a1: known });
        transcript.mockRejectedValue(new Error("timeout"));
        await refreshShellTasks("a1", "C:/tmp/a1.jsonl");
        expect(globalStore.get(shellTasksByIdAtom).a1).toBe(known);
    });

    it("drops the entry when a read finds no visible tasks", async () => {
        globalStore.set(shellTasksByIdAtom, { a1: [task("t1", "running")] });
        transcript.mockResolvedValue({ lines: [] });
        await refreshShellTasks("a1", "C:/tmp/a1.jsonl");
        expect("a1" in globalStore.get(shellTasksByIdAtom)).toBe(false);
    });
});

describe("shellTaskPollIds", () => {
    it("polls an agent with a running task and skips failed-only or taskless agents", () => {
        const byId = {
            running: [task("t1", "failed"), task("t2", "running")],
            failedOnly: [task("t3", "failed")],
        };
        expect(shellTaskPollIds(["running", "failedOnly", "none"], byId)).toEqual(["running"]);
    });

    it("does not poll an agent that is no longer tracked", () => {
        expect(shellTaskPollIds([], { gone: [task("t1", "running")] })).toEqual([]);
    });
});
