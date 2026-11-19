// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { railReloadKey } from "./agentrailmodel";
import type { AgentVM } from "./agentsviewmodel";
import { holdRailGit } from "./railgit";
import { railStateAtom } from "./railstore";

vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: { GitChangesCommand: vi.fn(), GitAgentEditsCommand: vi.fn(), GitListWorktreesCommand: vi.fn() },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("./agentcwdresolve", () => ({ resolveCwd: vi.fn(async () => "C:/src/demo") }));
vi.mock("./agentsessionstore", () => ({ ensureSessionStart: vi.fn(async () => null) }));

const CHANGES = { isrepo: true, branch: "main", statusz: "", numstat: "", numstaterror: "" };

const agent = (id: string, idleSince?: number): AgentVM => ({
    id,
    name: id,
    task: "",
    state: "idle",
    transcriptPath: `/t/${id}.jsonl`,
    blockId: `block-${id}`,
    idleSince,
});

const reads = () => vi.mocked(RpcApi.GitChangesCommand).mock.calls.length;
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
    vi.mocked(RpcApi.GitChangesCommand)
        .mockReset()
        .mockResolvedValue(CHANGES as never);
    // a Claude agent with no edits of its own: the plain read supplies the branch
    vi.mocked(RpcApi.GitAgentEditsCommand)
        .mockReset()
        .mockResolvedValue({ base: "", end: "", files: [], bashcalls: 0 } as never);
    vi.mocked(RpcApi.GitListWorktreesCommand)
        .mockReset()
        .mockResolvedValue({ worktrees: [] } as never);
});

describe("holdRailGit", () => {
    it("starts one git read for two holders of the same agent and key", async () => {
        const a = agent("one");
        const releases = [holdRailGit(a, railReloadKey(a)), holdRailGit(a, railReloadKey(a))];
        await settle();
        expect(reads()).toBe(1);
        expect(globalStore.get(railStateAtom)?.branch).toBe("main");
        releases.forEach((r) => r());
    });

    it("reloads for a new key, under the list it shows", async () => {
        const a = agent("two");
        const release = holdRailGit(a, railReloadKey(a));
        await settle();
        const next = agent("two", 1000);
        const releaseNext = holdRailGit(next, railReloadKey(next));
        expect(globalStore.get(railStateAtom)).not.toBeNull();
        await settle();
        expect(reads()).toBe(2);
        release();
        releaseNext();
    });

    it("blanks first for a new agent", async () => {
        const a = agent("three");
        const release = holdRailGit(a, railReloadKey(a));
        await settle();
        const b = agent("four");
        const releaseB = holdRailGit(b, railReloadKey(b));
        expect(globalStore.get(railStateAtom)).toBeNull();
        await settle();
        expect(reads()).toBe(2);
        release();
        releaseB();
    });

    it("reads again once every holder let go and one holds the same key again", async () => {
        const a = agent("five");
        holdRailGit(a, railReloadKey(a))();
        await settle();
        const release = holdRailGit(a, railReloadKey(a));
        await settle();
        expect(reads()).toBe(2);
        release();
    });
});
