// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { GetChannelRunsCommand: vi.fn() } }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import { mergeChannelRuns, palettePickChannel } from "./palette-data";

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
