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
import type { AgentVM } from "./agentsviewmodel";
import { agentTransitions, type AgentSnap } from "./cockpitevents";
import { isStandingBy, type ShellTask } from "./shelltasks";
import {
    dropShellTasks,
    readShellTaskOutput,
    refreshShellTasks,
    shellReadAtByIdAtom,
    shellReadPending,
    shellTaskPeekAtom,
    shellTaskPollIds,
    shellTasksByIdAtom,
} from "./shelltasksstore";

const transcript = vi.mocked(RpcApi.GetAgentTranscriptCommand);

const task = (id: string, state: ShellTask["state"]): ShellTask => ({ id, description: id, state });

afterEach(() => {
    transcript.mockReset();
    vi.useRealTimers();
});

describe("readShellTaskOutput", () => {
    it("resolves to no lines when the file cannot be read", async () => {
        transcript.mockRejectedValue(new Error("reading agent transcript: open x.output: no such file"));
        await expect(readShellTaskOutput("C:/tmp/tasks/x.output")).resolves.toEqual([]);
    });

    it("returns the last 64 KB of the last 1000 lines, dropping a cut leading line", async () => {
        const lines = ["a".repeat(40000), "b".repeat(40000), "tail"];
        transcript.mockResolvedValue({ lines });
        const out = await readShellTaskOutput("C:/tmp/tasks/x.output");
        expect(out).toEqual(["b".repeat(40000), "tail"]);
        expect(transcript).toHaveBeenCalledWith({}, { path: "C:/tmp/tasks/x.output", maxlines: 1000 });
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

describe("shell-task read hold", () => {
    const idle = { id: "a1", name: "a1", task: "t", state: "idle", idleSince: 1000 } as AgentVM;
    const working: Record<string, AgentSnap> = { a1: { state: "working", standingBy: false, held: false } };
    // what the rail decides from the store, as useRailTracking derives it
    const decide = (prev: Record<string, AgentSnap>, now: number) => {
        const tasks = globalStore.get(shellTasksByIdAtom).a1 ?? [];
        const pending = shellReadPending(idle, globalStore.get(shellReadAtByIdAtom).a1);
        return agentTransitions(
            prev,
            [idle],
            now,
            new Set(isStandingBy(idle.state, tasks) ? ["a1"] : []),
            new Set(pending ? ["a1"] : [])
        );
    };

    it("is pending for an idle agent until a read that started at or after the Stop completes", () => {
        expect(shellReadPending(idle, 999)).toBe(true);
        expect(shellReadPending(idle, 1000)).toBe(false);
        expect(shellReadPending({ ...idle, state: "working" }, 999)).toBe(false);
        // nothing reads an untracked agent, so nothing holds it
        expect(shellReadPending(idle, undefined)).toBe(false);
        expect(shellReadPending({ ...idle, idleSince: undefined }, 999)).toBe(false);
    });

    it("records a completed read's start, success or failure, and forgets it on drop", async () => {
        vi.useFakeTimers({ now: 2000 });
        transcript.mockResolvedValue({ lines: [] });
        await refreshShellTasks("a1", "C:/tmp/a1.jsonl");
        expect(globalStore.get(shellReadAtByIdAtom).a1).toBe(2000);
        vi.setSystemTime(3000);
        transcript.mockRejectedValue(new Error("timeout"));
        await refreshShellTasks("a1", "C:/tmp/a1.jsonl");
        expect(globalStore.get(shellReadAtByIdAtom).a1).toBe(3000);
        dropShellTasks("a1");
        expect("a1" in globalStore.get(shellReadAtByIdAtom)).toBe(false);
    });

    it("a failed read releases the hold onto a last known running task: standing by, no finish", async () => {
        globalStore.set(shellTasksByIdAtom, { a1: [task("t1", "running")] });
        globalStore.set(shellReadAtByIdAtom, { a1: 900 });
        const stop = decide(working, 1100);
        expect(stop.events).toEqual([]);
        expect(stop.next.a1.held).toBe(true);
        vi.useFakeTimers({ now: 1050 });
        transcript.mockRejectedValue(new Error("timeout"));
        await refreshShellTasks("a1", "C:/tmp/a1.jsonl");
        const landed = decide(stop.next, 1200);
        expect(landed.events).toEqual([]);
        expect(landed.next.a1).toEqual({ state: "idle", standingBy: true, held: false });
    });

    it("a failed read releases the hold onto a last known empty list: one finish at the Stop", async () => {
        globalStore.set(shellTasksByIdAtom, {});
        globalStore.set(shellReadAtByIdAtom, { a1: 900 });
        const stop = decide(working, 1100);
        expect(stop.events).toEqual([]);
        vi.useFakeTimers({ now: 1050 });
        transcript.mockRejectedValue(new Error("timeout"));
        await refreshShellTasks("a1", "C:/tmp/a1.jsonl");
        const landed = decide(stop.next, 1200);
        expect(landed.events.map((e) => [e.kind, e.ts])).toEqual([["finished", 1000]]);
        expect(decide(landed.next, 1300).events).toEqual([]);
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

describe("shellTaskPeekAtom", () => {
    afterEach(() => {
        globalStore.set(shellTaskPeekAtom, null);
    });

    it("dropping the parent closes its task's peek and leaves another parent's open", () => {
        globalStore.set(shellTaskPeekAtom, { parentId: "p1", taskId: "t1" });
        dropShellTasks("p2");
        expect(globalStore.get(shellTaskPeekAtom)).not.toBeNull();
        dropShellTasks("p1");
        expect(globalStore.get(shellTaskPeekAtom)).toBeNull();
    });
});
