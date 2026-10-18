import { atom } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { globalStore } from "@/app/store/jotaiStore";
import { atoms } from "@/app/store/global-atoms";

// launchAgent configures the new tab's default block via SetMeta, but the frontend's cached
// (unsubscribed) block object stays stale at the pre-conversion shell meta — so the session
// sidebar never sees cmd:cwd and the agent never enters the roster (empty cockpit panel). The fix
// reloads the block object after SetMeta. These tests lock in that reload.

const h = vi.hoisted(() => ({ tab: { blockids: ["blk-1"] } as { blockids?: string[] } | undefined }));
const createTab = vi.fn();
const createWorktree = vi.fn();
const setMeta = vi.fn().mockResolvedValue(undefined);
const reloadWaveObject = vi.fn().mockResolvedValue(undefined);
const fileInfo = vi.fn();
const agentSyncApply = vi.fn().mockResolvedValue({ actions: [] });

vi.mock("@/app/store/services", () => ({ WorkspaceService: { CreateTab: (...a: any[]) => createTab(...a) } }));
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        SetMetaCommand: (...a: any[]) => setMeta(...a),
        FileInfoCommand: (...a: any[]) => fileInfo(...a),
        CreateWorktreeCommand: (...a: any[]) => createWorktree(...a),
        AgentSyncApplyCommand: (...a: any[]) => agentSyncApply(...a),
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/view/agents/agents", () => ({ AgentsViewModel: class {} }));
vi.mock("@/app/store/global-atoms", () => ({ atoms: { workspace: atom({ oid: "ws1", tabids: [] }) } }));
vi.mock("@/app/store/wos", () => ({
    makeORef: (otype: string, oid: string) => `${otype}:${oid}`,
    getWaveObjectAtom: () => atom(h.tab),
    reloadWaveObject: (...a: any[]) => reloadWaveObject(...a),
}));

import { launchAgent } from "./cockpit-actions";

function fakeModel() {
    return {
        pendingLaunchesAtom: atom([]),
        focusIdAtom: atom<string | undefined>(undefined),
        surfaceAtom: atom("cockpit"),
    } as any;
}

afterEach(() => {
    createTab.mockReset().mockResolvedValue("tab-1");
    setMeta.mockClear();
    reloadWaveObject.mockClear();
    fileInfo.mockReset().mockResolvedValue({});
    agentSyncApply.mockClear();
    createWorktree.mockReset().mockResolvedValue({ worktreepath: "C:/wt/feat-x" });
    h.tab = { blockids: ["blk-1"] };
    globalStore.set(atoms.workspace, { oid: "ws1", tabids: [] } as any);
});

const agentOpts = {
    runtime: "claude" as const,
    startupCommand: "claude",
    task: "",
    projectPath: "C:/proj",
    projectName: "proj",
};

const metaOf = (oref: string) => setMeta.mock.calls.find((c) => c[1]?.oref === oref)?.[1].meta;

describe("launchAgent", () => {
    beforeEach(() => {
        createTab.mockResolvedValue("tab-1");
        createWorktree.mockResolvedValue({ worktreepath: "C:/wt/feat-x" });
    });

    it("reloads the configured block's WOS object so the sidebar sees the agent meta (not stale shell)", async () => {
        createTab.mockResolvedValue("tab-1");
        await launchAgent(fakeModel(), {
            runtime: "claude",
            startupCommand: "claude",
            task: "",
            projectPath: "C:/proj",
            projectName: "proj",
        });
        // the block was configured with the agent meta...
        const blockSetMeta = setMeta.mock.calls.find((c) => c[1]?.oref === "block:blk-1");
        expect(blockSetMeta, "SetMeta called on the tab's default block").toBeTruthy();
        expect(blockSetMeta[1].meta.controller).toBe("cmd");
        // ...and its stale FE cache must be refreshed so the roster recognizes it
        expect(reloadWaveObject).toHaveBeenCalledWith("block:blk-1");
    });

    it("preflights a missing Pi resumePath and refuses to create a tab", async () => {
        const missing = "C:\\Users\\Jane Doe\\.pi\\agent\\sessions\\gone.jsonl";
        fileInfo.mockRejectedValue(new Error("no such file"));
        const err = (await launchAgent(fakeModel(), {
            runtime: "pi",
            startupCommand: "pi",
            task: "",
            projectPath: "C:/proj",
            projectName: "proj",
            resumePath: missing,
        }).catch((e: unknown) => e)) as Error;
        expect(fileInfo).toHaveBeenCalledWith({}, { info: { path: missing } });
        expect(createTab).not.toHaveBeenCalled();
        expect(err.message).toContain("Pi session no longer exists");
        expect(err.message).toContain(missing);
    });

    it("forwards startupArgs into the block meta (pi resume is one argv element per arg)", async () => {
        await launchAgent(fakeModel(), {
            runtime: "pi",
            startupCommand: "pi",
            startupArgs: ["--session", "C:\\Users\\Jane Doe\\.pi\\agent\\sessions\\s.jsonl"],
            task: "",
            projectPath: "C:/proj",
            projectName: "proj",
        });
        const blockSetMeta = setMeta.mock.calls.find((c) => c[1]?.oref === "block:blk-1");
        expect(blockSetMeta[1].meta["cmd:args"]).toEqual([
            "--session",
            "C:\\Users\\Jane Doe\\.pi\\agent\\sessions\\s.jsonl",
        ]);
    });

    it("does not touch the resume path when none is given", async () => {
        fileInfo.mockRejectedValue(new Error("no such file"));
        await expect(launchAgent(fakeModel(), agentOpts)).resolves.toBe("tab-1");
        expect(fileInfo).not.toHaveBeenCalled();
    });

    it("refuses to launch without an active workspace", async () => {
        for (const ws of [undefined, {}]) {
            globalStore.set(atoms.workspace, ws as any);
            await expect(launchAgent(fakeModel(), agentOpts)).rejects.toThrow("no active workspace");
        }
        expect(createTab).not.toHaveBeenCalled();
    });

    it("creates the tab in the active workspace, named for the project, without selecting it", async () => {
        await launchAgent(fakeModel(), agentOpts);
        expect(createTab).toHaveBeenCalledWith("ws1", "proj", false);
    });

    it("refuses a new tab that has no block", async () => {
        h.tab = { blockids: [] };
        await expect(launchAgent(fakeModel(), agentOpts)).rejects.toThrow("new tab has no block");
        expect(setMeta).not.toHaveBeenCalled();
    });

    it("creates a worktree for an agent given a branch and launches in it", async () => {
        await launchAgent(fakeModel(), { ...agentOpts, branch: "  feat/x " });
        expect(createWorktree).toHaveBeenCalledWith({}, { projectpath: "C:/proj", branch: "feat/x" });
        expect(metaOf("block:blk-1")["cmd:cwd"]).toBe("C:/wt/feat-x");
    });

    it("launches an agent in the project when the branch is blank", async () => {
        await launchAgent(fakeModel(), { ...agentOpts, branch: "   " });
        expect(createWorktree).not.toHaveBeenCalled();
        expect(metaOf("block:blk-1")["cmd:cwd"]).toBe("C:/proj");
    });

    it("leaves an agent with no project path without a cwd", async () => {
        await launchAgent(fakeModel(), { ...agentOpts, projectPath: "" });
        expect(metaOf("block:blk-1")).not.toHaveProperty("cmd:cwd");
    });

    it("starts the agent sync for every launch", async () => {
        await launchAgent(fakeModel(), agentOpts);
        expect(agentSyncApply).toHaveBeenCalledWith({}, { dryrun: false });
    });

    it("tags the tab with the agent, project, label and initiative", async () => {
        await launchAgent(fakeModel(), { ...agentOpts, label: "Fix login", effortORef: "effort:e1" });
        expect(metaOf("tab:tab-1")).toStrictEqual({
            "session:agent": "claude",
            "session:project": "proj",
            "session:label": "Fix login",
            "session:effort": "effort:e1",
        });
    });

    it("tags the tab with only the agent and project when there is no label or initiative", async () => {
        await launchAgent(fakeModel(), agentOpts);
        expect(metaOf("tab:tab-1")).toStrictEqual({ "session:agent": "claude", "session:project": "proj" });
    });

    it("adds a booting row for an agent, after the rows already pending, and foregrounds it", async () => {
        const now = vi.spyOn(Date, "now").mockReturnValue(1234);
        const model = fakeModel();
        const earlier = { tabId: "t0", blockId: "b0", name: "old", project: "p0", ts: 1 };
        globalStore.set(model.pendingLaunchesAtom, [earlier]);
        await launchAgent(model, { ...agentOpts, label: "Fix login" });
        now.mockRestore();
        expect(globalStore.get(model.pendingLaunchesAtom)).toStrictEqual([
            earlier,
            { tabId: "tab-1", blockId: "blk-1", name: "Fix login", project: "proj", ts: 1234 },
        ]);
        expect(globalStore.get(model.focusIdAtom)).toBe("tab-1");
        expect(globalStore.get(model.surfaceAtom)).toBe("agent");
    });

    it("names the booting row for the project when there is no label", async () => {
        const model = fakeModel();
        await launchAgent(model, agentOpts);
        expect(globalStore.get(model.pendingLaunchesAtom)[0]).toMatchObject({ name: "proj" });
    });

    it("opens a terminal in the project in the background, with no agent row and no branch worktree", async () => {
        const model = fakeModel();
        await launchAgent(model, { ...agentOpts, runtime: "terminal", startupCommand: "", branch: "feat/x" });
        expect(createWorktree).not.toHaveBeenCalled();
        expect(metaOf("block:blk-1")).toStrictEqual({ view: "term", controller: "shell", "cmd:cwd": "C:/proj" });
        expect(metaOf("tab:tab-1")).toStrictEqual({ "session:project": "proj" });
        expect(globalStore.get(model.pendingLaunchesAtom)).toStrictEqual([]);
        expect(globalStore.get(model.focusIdAtom)).toBeUndefined();
        expect(globalStore.get(model.surfaceAtom)).toBe("cockpit");
    });

    it("opens a terminal with no project path in the home directory", async () => {
        await launchAgent(fakeModel(), { ...agentOpts, runtime: "terminal", startupCommand: "", projectPath: "" });
        expect(metaOf("block:blk-1")["cmd:cwd"]).toBe("~");
    });
});
