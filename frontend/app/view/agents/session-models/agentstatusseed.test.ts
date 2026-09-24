// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { getAgentStatusAtom, seededOrefsAtom, setupAgentStatusSubscription } from "./agentstatusstore";

vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: vi.fn() }));
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { EventReadHistoryCommand: vi.fn() } }));

describe("retained status seeding", () => {
    beforeAll(() => setupAgentStatusSubscription());

    it("settles an oref whose read found a status", async () => {
        vi.mocked(RpcApi.EventReadHistoryCommand).mockResolvedValueOnce([
            { data: { oref: "block:a", state: "working", ts: 1 } },
        ] as any);
        getAgentStatusAtom("block:a");
        await vi.waitFor(() => expect(globalStore.get(seededOrefsAtom).has("block:a")).toBe(true));
        expect(globalStore.get(getAgentStatusAtom("block:a"))?.state).toBe("working");
    });

    it("settles an oref whose read failed, so the roster gate cannot hang on it", async () => {
        vi.mocked(RpcApi.EventReadHistoryCommand).mockRejectedValueOnce(new Error("EC-TIME"));
        getAgentStatusAtom("block:b");
        await vi.waitFor(() => expect(globalStore.get(seededOrefsAtom).has("block:b")).toBe(true));
        expect(globalStore.get(getAgentStatusAtom("block:b"))).toBeNull();
    });
});
