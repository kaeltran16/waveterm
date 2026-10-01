// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { GetChannelRunsCommand: vi.fn() } }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/view/agents/runeventstore", () => ({ ensureRunEvents: vi.fn() }));

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { ensureRunEvents } from "@/app/view/agents/runeventstore";
import { allRunsAtom, loadAllRuns, mergeChannelRuns, palettePickChannel } from "./palette-data";

describe("mergeChannelRuns", () => {
    const r = (id: string) => ({ id }) as Run;
    it("replaces each loaded channel's runs", () => {
        const out = mergeChannelRuns([{ channelId: "a", run: r("old") }], [{ channelId: "a", runs: [r("new")] }]);
        expect(out.map((p) => p.run.id)).toEqual(["new"]);
    });
    it("keeps a failed channel's previous runs", () => {
        const prev = [
            { channelId: "a", run: r("1") },
            { channelId: "b", run: r("2") },
        ];
        const out = mergeChannelRuns(prev, [
            { channelId: "a", error: new Error("x") },
            { channelId: "b", runs: [] },
        ]);
        expect(out.map((p) => p.run.id)).toEqual(["1"]);
    });
});

describe("loadAllRuns", () => {
    it("a superseded load writes nothing, even when it answers first", async () => {
        const pending: ((runs: Run[]) => void)[] = [];
        vi.mocked(RpcApi.GetChannelRunsCommand).mockImplementation(
            () => new Promise((resolve) => pending.push((runs) => resolve({ runs } as any)))
        );
        globalStore.set(allRunsAtom, []);
        const ch = [{ oid: "a" } as Channel];
        const first = loadAllRuns(ch);
        const second = loadAllRuns(ch);
        pending[0]([{ id: "stale" } as Run]);
        await first;
        expect(globalStore.get(allRunsAtom)).toEqual([]);
        pending[1]([{ id: "fresh" } as Run]);
        await second;
        expect(globalStore.get(allRunsAtom).map((p) => p.run.id)).toEqual(["fresh"]);
    });
    it("loads the events of every unfinished run, which Relaunch reads", async () => {
        vi.mocked(RpcApi.GetChannelRunsCommand).mockResolvedValue({
            runs: [{ id: "live", status: "executing" } as Run, { id: "over", status: "done" } as Run],
        } as any);
        vi.mocked(ensureRunEvents).mockClear();
        await loadAllRuns([{ oid: "a" } as Channel]);
        expect(vi.mocked(ensureRunEvents).mock.calls).toEqual([["live", "a"]]);
    });
});

describe("palettePickChannel", () => {
    const c = (oid: string, projectpath?: string) => ({ oid, projectpath }) as Channel;
    const label = (x: Channel) => x.oid;
    it("prefers the active channel", () =>
        expect(palettePickChannel(c("a"), [c("a"), c("b")], "b", label)?.oid).toBe("a"));
    it("falls back to the last-picked project", () =>
        expect(palettePickChannel(null, [c("a"), c("b")], "b", label)?.oid).toBe("b"));
    it("falls back to the only project", () => expect(palettePickChannel(null, [c("a")], null, label)?.oid).toBe("a"));
    it("counts two channels on one project as the only project", () =>
        expect(palettePickChannel(null, [c("new", "/p"), c("old", "/p")], null, label)?.oid).toBe("new"));
    it("picks nothing among several with no memory", () =>
        expect(palettePickChannel(null, [c("a"), c("b")], null, label)).toBeNull());
    it("picks nothing before channels load", () => expect(palettePickChannel(null, null, "a", label)).toBeNull());
    it("ignores a last-picked project that has no channel", () =>
        expect(palettePickChannel(null, [c("a"), c("b")], "gone", label)).toBeNull());
});
