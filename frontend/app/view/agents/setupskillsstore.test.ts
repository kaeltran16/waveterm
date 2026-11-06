// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { pushToast } from "@/app/cockpit/notificationstore";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { adoptSkills, loadSkills, setupSkillKeepAtom, setupSkillsAtom, setupSkillsErrorAtom } from "./setupskillsstore";
import { setupInstructionsErrorAtom } from "./setupstore";
import { KEEP_LEAVE, KEEP_VAULT } from "./skillsmatrix";

vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: { AgentSyncSkillsCommand: vi.fn(), AgentSyncAdoptCommand: vi.fn() },
}));
vi.mock("@/app/cockpit/notificationstore", () => ({ pushToast: vi.fn() }));

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
    vi.mocked(RpcApi.AgentSyncAdoptCommand).mockReset();
    vi.mocked(pushToast).mockReset();
    globalStore.set(setupSkillsAtom, null);
    globalStore.set(setupSkillsErrorAtom, null);
    globalStore.set(setupInstructionsErrorAtom, null);
    globalStore.set(setupSkillKeepAtom, {});
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

describe("adoptSkills", () => {
    const move = (runtime: string, name: string, over: Partial<AgentSyncSkillMove> = {}): AgentSyncSkillMove => ({
        runtime,
        name,
        from: `/h/${runtime}/${name}`,
        seed: true,
        bodydiff: false,
        ...over,
    });
    // four unmanaged names and a vault skill's stray copy: the matrix would count three before the click
    const MATRIX: CommandAgentSyncSkillsRtnData = {
        ...SKILLS,
        columns: [{ runtime: "claude", label: "Claude Code", present: true }],
        skills: [{ name: "helper", states: { claude: "unmanaged" } }],
        unmanaged: [
            move("claude", "a"),
            move("claude", "b"),
            move("claude", "c"),
            move("claude", "left"),
            move("claude", "helper", { seed: false, vault: true }),
        ],
    };

    beforeEach(() => {
        globalStore.set(setupSkillsAtom, MATRIX);
        vi.mocked(RpcApi.AgentSyncSkillsCommand).mockResolvedValue(MATRIX);
    });

    it("sends keep and skip from the one keep map", async () => {
        globalStore.set(setupSkillKeepAtom, { left: KEEP_LEAVE, helper: KEEP_VAULT });
        vi.mocked(RpcApi.AgentSyncAdoptCommand).mockResolvedValue({ moves: [] });
        await adoptSkills();
        expect(vi.mocked(RpcApi.AgentSyncAdoptCommand).mock.calls[0][1]).toEqual({
            apply: true,
            keep: { helper: "vault" },
            skip: ["left"],
        });
    });

    it("toasts the counts the reply carries, not the pre-click matrix", async () => {
        globalStore.set(setupSkillKeepAtom, { left: KEEP_LEAVE });
        // the backend moved one name and left another waiting, whatever the matrix showed
        vi.mocked(RpcApi.AgentSyncAdoptCommand).mockResolvedValue({
            moves: [move("claude", "a"), move("claude", "b")],
            unresolved: ["b"],
        });
        await adoptSkills();
        expect(pushToast).toHaveBeenCalledWith({
            title: "Moved 1 skill into the vault · 1 wait for a decision · 1 left alone",
            message: "",
            level: "info",
        });
        // a left-alone choice outlives the adopt, so the next Manage leaves it alone too
        expect(globalStore.get(setupSkillKeepAtom)).toEqual({ left: KEEP_LEAVE });
    });

    it("says a snapshot moved nothing and keeps every choice", async () => {
        globalStore.set(setupSkillKeepAtom, { helper: KEEP_VAULT });
        vi.mocked(RpcApi.AgentSyncAdoptCommand).mockResolvedValue({
            moves: [move("claude", "a"), move("claude", "helper", { seed: false, vault: true })],
            dryrun: true,
        });
        await adoptSkills();
        expect(vi.mocked(pushToast).mock.calls[0][0].title).toBe("Snapshot: nothing moved (would move 2)");
        expect(globalStore.get(setupSkillKeepAtom)).toEqual({ helper: KEEP_VAULT });
    });

    it("shows a failed adopt in the Skills banner with no toast, and re-reads the matrix", async () => {
        vi.mocked(RpcApi.AgentSyncAdoptCommand).mockRejectedValue(new Error("adopt exploded"));
        await adoptSkills();
        expect(globalStore.get(setupSkillsErrorAtom)).toBe("adopt exploded");
        expect(pushToast).not.toHaveBeenCalled();
        expect(RpcApi.AgentSyncSkillsCommand).toHaveBeenCalled();
    });
});
