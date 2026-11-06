// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadSkills, setupSkillsAtom, setupSkillsErrorAtom } from "./setupskillsstore";
import { setupInstructionsErrorAtom } from "./setupstore";

vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: { AgentSyncSkillsCommand: vi.fn() },
}));

const SKILLS: CommandAgentSyncSkillsRtnData = {
    skills: [],
    columns: [],
    skillsroot: "/v/skills",
    unmanaged: [],
    unresolved: [],
    linked: [],
};

beforeEach(() => {
    vi.mocked(RpcApi.AgentSyncSkillsCommand).mockReset();
    globalStore.set(setupSkillsAtom, null);
    globalStore.set(setupSkillsErrorAtom, null);
    globalStore.set(setupInstructionsErrorAtom, null);
});

describe("loadSkills", () => {
    it("keeps a failed read on the Skills tab", async () => {
        vi.mocked(RpcApi.AgentSyncSkillsCommand).mockRejectedValue(new Error("skills unreadable"));
        await loadSkills();
        expect(globalStore.get(setupSkillsErrorAtom)).toBe("skills unreadable");
        expect(globalStore.get(setupSkillsAtom)).toBeNull();
    });

    it("clears its own error on success and leaves the Instructions error alone", async () => {
        globalStore.set(setupSkillsErrorAtom, "skills unreadable");
        globalStore.set(setupInstructionsErrorAtom, "save failed");
        vi.mocked(RpcApi.AgentSyncSkillsCommand).mockResolvedValue(SKILLS);
        await loadSkills();
        expect(globalStore.get(setupSkillsErrorAtom)).toBeNull();
        expect(globalStore.get(setupSkillsAtom)).toEqual(SKILLS);
        expect(globalStore.get(setupInstructionsErrorAtom)).toBe("save failed");
    });
});
