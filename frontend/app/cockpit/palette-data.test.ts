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
    const c = (oid: string) => ({ oid }) as Channel;
    const row = (name: string, channel?: Channel) => ({ name, path: `/${name}`, channel });
    it("prefers the active channel", () =>
        expect(palettePickChannel(c("a"), [row("a", c("a")), row("b", c("b"))], "b")?.oid).toBe("a"));
    it("falls back to the most recently used project", () =>
        expect(palettePickChannel(null, [row("a", c("a")), row("b", c("b"))], "b")?.oid).toBe("b"));
    it("falls back to the only project", () =>
        expect(palettePickChannel(null, [row("a", c("a"))], null)?.oid).toBe("a"));
    it("picks nothing among several with no memory", () =>
        expect(palettePickChannel(null, [row("a", c("a")), row("b", c("b"))], null)).toBeNull());
    it("picks nothing before channels load", () => expect(palettePickChannel(null, [row("a")], "a")).toBeNull());
    it("ignores a recent project that is no longer registered", () =>
        expect(palettePickChannel(null, [row("a", c("a")), row("b", c("b"))], "gone")).toBeNull());
});
