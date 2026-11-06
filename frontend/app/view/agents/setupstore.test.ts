// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { editorReload, editorTyped } from "./setupmodel";
import { loadSkills } from "./setupskillsstore";
import {
    loadSetup,
    saveShared,
    setupInstructionsErrorAtom,
    setupSharedAtom,
    setupStatusAtom,
    syncNow,
} from "./setupstore";

vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        AgentSyncStatusCommand: vi.fn(),
        AgentSyncSteeringReadCommand: vi.fn(),
        AgentSyncSkillsCommand: vi.fn(),
        AgentSyncApplyCommand: vi.fn(),
        AgentSyncSteeringWriteCommand: vi.fn(),
    },
}));

const STATUS: CommandAgentSyncStatusRtnData = { harnesses: [], steeringdoc: "/v/AGENTS.md", skillsroot: "/v/skills" };
const DOC: CommandAgentSyncSteeringReadRtnData = { path: "/v/AGENTS.md", content: "# doc\n", mtime: 1000 };

beforeEach(() => {
    vi.mocked(RpcApi.AgentSyncStatusCommand).mockReset().mockResolvedValue(STATUS);
    vi.mocked(RpcApi.AgentSyncSteeringReadCommand).mockReset().mockResolvedValue(DOC);
    vi.mocked(RpcApi.AgentSyncSkillsCommand).mockReset();
    vi.mocked(RpcApi.AgentSyncApplyCommand).mockReset().mockResolvedValue({ actions: [] });
    vi.mocked(RpcApi.AgentSyncSteeringWriteCommand).mockReset();
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

describe("syncNow", () => {
    it("applies, then reads the status again", async () => {
        const synced: CommandAgentSyncStatusRtnData = {
            ...STATUS,
            harnesses: [
                {
                    runtime: "claude",
                    label: "Claude Code",
                    present: true,
                    path: "/h/CLAUDE.md",
                    steering: "current",
                    skillsmanaged: 0,
                    skillsunmanaged: 0,
                },
            ],
        };
        vi.mocked(RpcApi.AgentSyncStatusCommand).mockResolvedValue(synced);
        await syncNow();
        expect(RpcApi.AgentSyncApplyCommand).toHaveBeenCalledTimes(1);
        const applied = vi.mocked(RpcApi.AgentSyncApplyCommand).mock.invocationCallOrder[0];
        expect(vi.mocked(RpcApi.AgentSyncStatusCommand).mock.invocationCallOrder[0]).toBeGreaterThan(applied);
        expect(globalStore.get(setupStatusAtom)).toEqual(synced);
        expect(globalStore.get(setupInstructionsErrorAtom)).toBeNull();
    });

    it("shows a failed apply in the Instructions banner", async () => {
        vi.mocked(RpcApi.AgentSyncApplyCommand).mockRejectedValue(new Error("apply failed"));
        await syncNow();
        expect(globalStore.get(setupInstructionsErrorAtom)).toBe("apply failed");
        expect(RpcApi.AgentSyncStatusCommand).not.toHaveBeenCalled();
    });
});

describe("saveShared conflict", () => {
    const MINE = "# doc\nmine\n";
    const THEIRS = "# doc\ntheirs\n";

    beforeEach(() => {
        globalStore.set(setupSharedAtom, editorTyped(editorReload(DOC.content, 1000), MINE));
        vi.mocked(RpcApi.AgentSyncSteeringWriteCommand).mockResolvedValue({ mtime: 2000, conflict: true });
    });

    it("reads the doc as it is on disk beside the draft", async () => {
        vi.mocked(RpcApi.AgentSyncSteeringReadCommand).mockResolvedValue({ ...DOC, content: THEIRS });
        await saveShared(false);
        expect(globalStore.get(setupSharedAtom)).toMatchObject({ conflict: true, draft: MINE, disk: THEIRS });
        expect(RpcApi.AgentSyncApplyCommand).not.toHaveBeenCalled();
    });

    it("keeps the conflict with no disk text when that read fails", async () => {
        vi.mocked(RpcApi.AgentSyncSteeringReadCommand).mockRejectedValue(new Error("unreadable"));
        await saveShared(false);
        const ed = globalStore.get(setupSharedAtom);
        expect(ed.conflict).toBe(true);
        expect(ed.disk).toBeNull();
        expect(ed.draft).toBe(MINE);
    });
});
