// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test, vi } from "vitest";

const getTranscriptUsage = vi.fn();
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: { GetTranscriptUsageCommand: (...a: any[]) => getTranscriptUsage(...a) },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import { globalStore } from "@/app/store/jotaiStore";
import { loadSessionUsage, sessionUsageAtom } from "./transcriptusagestore";

describe("loadSessionUsage", () => {
    test("an agent with no transcript is unavailable, not loading forever", async () => {
        await loadSessionUsage("a", undefined);
        expect(globalStore.get(sessionUsageAtom)).toBe("unavailable");
    });

    test("a failed load is unavailable and says why", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        getTranscriptUsage.mockRejectedValueOnce(new Error("rpc down"));
        await loadSessionUsage("b", "/b.jsonl");
        expect(globalStore.get(sessionUsageAtom)).toBe("unavailable");
        expect(String(warn.mock.calls[0])).toContain("/b.jsonl");
        warn.mockRestore();
    });

    test("is loading while the first load is in flight", async () => {
        getTranscriptUsage.mockReturnValueOnce(new Promise(() => {}));
        void loadSessionUsage("c", "/c.jsonl");
        expect(globalStore.get(sessionUsageAtom)).toBeNull();
    });

    test("a failed silent reload keeps the last good usage", async () => {
        getTranscriptUsage.mockResolvedValueOnce({ buckets: [] });
        await loadSessionUsage("d", "/d.jsonl");
        const loaded = globalStore.get(sessionUsageAtom);
        expect(loaded).not.toBeNull();
        expect(loaded).not.toBe("unavailable");
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        getTranscriptUsage.mockRejectedValueOnce(new Error("rpc down"));
        await loadSessionUsage("d", "/d.jsonl", { silent: true });
        expect(globalStore.get(sessionUsageAtom)).toBe(loaded);
        warn.mockRestore();
    });
});
