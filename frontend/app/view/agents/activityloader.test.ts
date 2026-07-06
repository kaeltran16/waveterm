// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { afterEach, describe, expect, it, vi } from "vitest";

const discover = vi.fn();
vi.mock("./activitydiscovery", () => ({
    discoverSessions: () => discover(),
}));
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: { GetAgentTranscriptCommand: vi.fn() },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import { activityEventsAtom, activityLoadedAtom, loadActivity } from "./activitystore";

const model = {
    agentsAtom: {
        read: () => [],
    },
} as any;

afterEach(() => {
    discover.mockReset();
    globalStore.set(activityEventsAtom, []);
    globalStore.set(activityLoadedAtom, false);
});

describe("loadActivity", () => {
    it("marks the surface loaded after an empty successful scan", async () => {
        discover.mockResolvedValue([]);
        await loadActivity(model);
        expect(globalStore.get(activityEventsAtom)).toEqual([]);
        expect(globalStore.get(activityLoadedAtom)).toBe(true);
    });
});