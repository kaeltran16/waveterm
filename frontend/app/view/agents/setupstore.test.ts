// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadSkills } from "./setupskillsstore";
import { loadSetup, setupInstructionsErrorAtom, setupStatusAtom } from "./setupstore";

vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        AgentSyncStatusCommand: vi.fn(),
        AgentSyncSteeringReadCommand: vi.fn(),
        AgentSyncSkillsCommand: vi.fn(),
    },
}));

const STATUS: CommandAgentSyncStatusRtnData = { harnesses: [], steeringdoc: "/v/AGENTS.md", skillsroot: "/v/skills" };
const DOC: CommandAgentSyncSteeringReadRtnData = { path: "/v/AGENTS.md", content: "# doc\n", mtime: 1000 };

beforeEach(() => {
    vi.mocked(RpcApi.AgentSyncStatusCommand).mockReset().mockResolvedValue(STATUS);
    vi.mocked(RpcApi.AgentSyncSteeringReadCommand).mockReset().mockResolvedValue(DOC);
    vi.mocked(RpcApi.AgentSyncSkillsCommand).mockReset();
    globalStore.set(setupStatusAtom, null);
    globalStore.set(setupInstructionsErrorAtom, null);
});

describe("loadSetup", () => {
    it("keeps a failed steering read on the Instructions tab and leaves the status unread", async () => {
        vi.mocked(RpcApi.AgentSyncSteeringReadCommand).mockRejectedValue(new Error("steering doc unreadable"));
        await loadSetup();
        expect(globalStore.get(setupInstructionsErrorAtom)).toBe("steering doc unreadable");
        expect(globalStore.get(setupStatusAtom)).toBeNull();
    });

    it("clears the Instructions error on a later successful read", async () => {
        vi.mocked(RpcApi.AgentSyncSteeringReadCommand).mockRejectedValueOnce(new Error("steering doc unreadable"));
        await loadSetup();
        await loadSetup();
        expect(globalStore.get(setupInstructionsErrorAtom)).toBeNull();
        expect(globalStore.get(setupStatusAtom)).toEqual(STATUS);
    });

    it("never takes a failing skills read as an Instructions error", async () => {
        vi.mocked(RpcApi.AgentSyncSkillsCommand).mockRejectedValue(new Error("skills unreadable"));
        await loadSkills();
        expect(globalStore.get(setupInstructionsErrorAtom)).toBeNull();
    });
});
