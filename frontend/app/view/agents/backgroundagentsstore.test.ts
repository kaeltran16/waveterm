// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { atom } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listed = vi.hoisted(() => ({ agents: [] as BackgroundAgentData[], calls: 0 }));

vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        GetBackgroundAgentsCommand: vi.fn(async () => {
            listed.calls++;
            // a fresh array of fresh objects each call, as the RPC decode produces
            return { agents: listed.agents.map((a) => ({ ...a })) };
        }),
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/store/global-atoms", () => ({ atoms: { fullConfigAtom: atom({ projects: {} }) } }));
vi.mock("@/app/view/jarvis/petstore", () => ({ pushPetEvent: vi.fn() }));

import { globalStore } from "@/app/store/jotaiStore";
import {
    backgroundAgentsAtom,
    backgroundAgentVMsAtom,
    loadBackgroundAgents,
    pollBackgroundAgents,
} from "./backgroundagentsstore";

function bg(sessionid: string, state: string): BackgroundAgentData {
    return { sessionid, cwd: "C:\\proj", kind: "background", name: "task", state, startedts: 1000 };
}

describe("loadBackgroundAgents", () => {
    beforeEach(async () => {
        listed.agents = [];
        listed.calls = 0;
        await loadBackgroundAgents();
    });

    it("keeps the same array, and no derived atom re-runs, when the listing is unchanged", async () => {
        listed.agents = [bg("s1", "working")];
        await loadBackgroundAgents();
        const first = globalStore.get(backgroundAgentsAtom);
        const vms = globalStore.get(backgroundAgentVMsAtom);
        await loadBackgroundAgents();
        expect(globalStore.get(backgroundAgentsAtom)).toBe(first);
        expect(globalStore.get(backgroundAgentVMsAtom)).toBe(vms);
    });

    it("keeps the empty array across empty listings", async () => {
        const first = globalStore.get(backgroundAgentsAtom);
        await loadBackgroundAgents();
        expect(globalStore.get(backgroundAgentsAtom)).toBe(first);
    });

    it("publishes a changed listing", async () => {
        listed.agents = [bg("s1", "working")];
        await loadBackgroundAgents();
        listed.agents = [bg("s1", "blocked")];
        await loadBackgroundAgents();
        expect(globalStore.get(backgroundAgentsAtom).map((a) => a.state)).toEqual(["blocked"]);
    });
});

describe("pollBackgroundAgents", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("does not list while the window is hidden", async () => {
        vi.stubGlobal("document", { hidden: true });
        listed.calls = 0;
        await pollBackgroundAgents();
        expect(listed.calls).toBe(0);
    });

    it("lists while the window is visible", async () => {
        vi.stubGlobal("document", { hidden: false });
        listed.calls = 0;
        await pollBackgroundAgents();
        expect(listed.calls).toBe(1);
    });
});
