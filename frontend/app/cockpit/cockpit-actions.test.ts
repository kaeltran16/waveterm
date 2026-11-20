import { atom, type PrimitiveAtom } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { globalStore } from "@/app/store/jotaiStore";
import { atoms } from "@/app/store/global-atoms";

const createWorktree = vi.fn();
const launchTab = vi.fn();
const reloadWaveObject = vi.fn().mockResolvedValue(undefined);
const fileInfo = vi.fn();
const agentSyncApply = vi.fn().mockResolvedValue({ actions: [] });
const pushToast = vi.fn();

vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        FileInfoCommand: (...a: any[]) => fileInfo(...a),
        CreateWorktreeCommand: (...a: any[]) => createWorktree(...a),
        AgentSyncApplyCommand: (...a: any[]) => agentSyncApply(...a),
        LaunchAgentTabCommand: (...a: any[]) => launchTab(...a),
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/cockpit/notificationstore", () => ({ pushToast: (...a: any[]) => pushToast(...a) }));
vi.mock("@/app/view/agents/agents", () => ({ AgentsViewModel: class {} }));
vi.mock("@/app/view/agents/session-models/sessionsidebarmodel", async () => {
    const { atom } = await import("jotai");
    return { sessionSidebarViewModelAtom: atom({ groups: [] }) };
});
vi.mock("@/app/store/global-atoms", () => ({ atoms: { workspace: atom({ oid: "ws1", tabids: [] }) } }));
vi.mock("@/app/store/wos", () => ({
    makeORef: (otype: string, oid: string) => `${otype}:${oid}`,
    reloadWaveObject: (...a: any[]) => reloadWaveObject(...a),
}));

import { sessionSidebarViewModelAtom } from "@/app/view/agents/session-models/sessionsidebarmodel";
import { getStartErrorAtom } from "@/app/view/agents/agentcontrollerstore";
import { launchAgent, launchAgentOrToast } from "./cockpit-actions";

// the mocks above make the workspace and sidebar atoms writable; their real types are read-only.
const workspaceAtom = atoms.workspace as unknown as PrimitiveAtom<Workspace>;
const sidebarAtom = sessionSidebarViewModelAtom as unknown as PrimitiveAtom<{ groups: any[] }>;

function fakeModel(surface = "cockpit") {
    return {
        pendingLaunchesAtom: atom([]),
        focusIdAtom: atom<string | undefined>(undefined),
        surfaceAtom: atom(surface),
    } as any;
}

beforeEach(() => {
    launchTab.mockReset().mockResolvedValue({ tabid: "tab-1", blockid: "blk-1" });
    reloadWaveObject.mockClear();
    fileInfo.mockReset().mockResolvedValue({});
    agentSyncApply.mockClear();
    pushToast.mockClear();
    globalStore.set(sidebarAtom, { groups: [] });
    globalStore.set(getStartErrorAtom("blk-1"), undefined);
    createWorktree.mockReset().mockResolvedValue({ worktreepath: "C:/wt/feat-x" });
    globalStore.set(workspaceAtom, { oid: "ws1", tabids: [] } as any);
});

const agentOpts = {
    runtime: "claude" as const,
    startupCommand: "claude",
    task: "",
    projectPath: "C:/proj",
    projectName: "proj",
};

// the one LaunchAgentTabCommand's data
const launched = (): CommandLaunchAgentTabData => {
    expect(launchTab).toHaveBeenCalledTimes(1);
    return launchTab.mock.calls[0][1];
};

describe("launchAgent", () => {
    it("opens and starts an agent's tab with one launch, named for the project, in the active workspace", async () => {
        await expect(launchAgent(fakeModel(), agentOpts)).resolves.toBe("tab-1");
        expect(launchTab).toHaveBeenCalledWith(
            {},
            {
                workspaceid: "ws1",
                tabname: "proj",
                tabmeta: { "session:agent": "claude", "session:project": "proj" },
                blockmeta: {
                    view: "term",
                    controller: "cmd",
                    cmd: "claude",
                    "cmd:args": [],
                    "agent:baseargs": [],
                    "cmd:shell": false,
                    "cmd:jwt": true,
                    "cmd:cwd": "C:/proj",
                },
                start: true,
            }
        );
    });

    it("loads the new tab and its block, so a caller reads them as soon as the launch returns", async () => {
        await launchAgent(fakeModel(), agentOpts);
        expect(reloadWaveObject.mock.calls.flat().sort()).toEqual(["block:blk-1", "tab:tab-1"]);
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
        expect(launchTab).not.toHaveBeenCalled();
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
        expect(launched().blockmeta["cmd:args"]).toEqual([
            "--session",
            "C:\\Users\\Jane Doe\\.pi\\agent\\sessions\\s.jsonl",
        ]);
    });

    it("launchAgent refuses a pi resumePath that FileInfo reports notfound", async () => {
        const missing = "C:/Users/me/.pi/agent/sessions/gone.jsonl";
        fileInfo.mockImplementation(async (_c: unknown, d: { info: { path: string } }) =>
            d.info.path === missing ? { notfound: true } : {}
        );
        const err = (await launchAgent(fakeModel(), {
            ...agentOpts,
            runtime: "pi",
            resumePath: missing,
        }).catch((e: unknown) => e)) as Error;
        expect(launchTab).not.toHaveBeenCalled();
        expect(err.message).toBe(`Pi session no longer exists: ${missing}`);
    });

    it("launchAgent refuses a missing projectPath before creating a tab", async () => {
        fileInfo.mockResolvedValue({ notfound: true });
        await expect(launchAgent(fakeModel(), { ...agentOpts, branch: "feat/x" })).rejects.toThrow(
            "Working directory no longer exists: C:/proj"
        );
        expect(fileInfo).toHaveBeenCalledWith({}, { info: { path: "C:/proj" } });
        expect(createWorktree).not.toHaveBeenCalled();
        expect(launchTab).not.toHaveBeenCalled();
    });

    it("checks only the project path when no resume path is given", async () => {
        await expect(launchAgent(fakeModel(), agentOpts)).resolves.toBe("tab-1");
        expect(fileInfo.mock.calls).toEqual([[{}, { info: { path: "C:/proj" } }]]);
    });

    it("does not check the cwd of a terminal or of an agent with no project path", async () => {
        fileInfo.mockResolvedValue({ notfound: true });
        await expect(launchAgent(fakeModel(), { ...agentOpts, runtime: "terminal", startupCommand: "" })).resolves.toBe(
            "tab-1"
        );
        await expect(launchAgent(fakeModel(), { ...agentOpts, projectPath: "" })).resolves.toBe("tab-1");
        expect(fileInfo).not.toHaveBeenCalled();
    });

    it("refuses to launch without an active workspace", async () => {
        for (const ws of [undefined, {}]) {
            globalStore.set(workspaceAtom, ws as any);
            await expect(launchAgent(fakeModel(), agentOpts)).rejects.toThrow("no active workspace");
        }
        expect(launchTab).not.toHaveBeenCalled();
    });

    it("creates a worktree for an agent given a branch and launches in it", async () => {
        await launchAgent(fakeModel(), { ...agentOpts, branch: "  feat/x " });
        expect(createWorktree).toHaveBeenCalledWith({}, { projectpath: "C:/proj", branch: "feat/x" });
        expect(launched().blockmeta["cmd:cwd"]).toBe("C:/wt/feat-x");
    });

    it("launches an agent in the project when the branch is blank", async () => {
        await launchAgent(fakeModel(), { ...agentOpts, branch: "   " });
        expect(createWorktree).not.toHaveBeenCalled();
        expect(launched().blockmeta["cmd:cwd"]).toBe("C:/proj");
    });

    it("leaves an agent with no project path without a cwd", async () => {
        await launchAgent(fakeModel(), { ...agentOpts, projectPath: "" });
        expect(launched().blockmeta).not.toHaveProperty("cmd:cwd");
    });

    it("starts the agent sync for every launch", async () => {
        await launchAgent(fakeModel(), agentOpts);
        expect(agentSyncApply).toHaveBeenCalledWith({}, { dryrun: false });
    });

    it("warns with a toast when the launch-time sync fails, and launches anyway", async () => {
        agentSyncApply.mockRejectedValueOnce(new Error("boom"));
        await expect(launchAgent(fakeModel(), agentOpts)).resolves.toBe("tab-1");
        await vi.waitFor(() =>
            expect(pushToast).toHaveBeenCalledWith(
                expect.objectContaining({
                    level: "warn",
                    message: "Harness sync failed: boom. Setup → Instructions has Sync now.",
                })
            )
        );
    });

    it("tags the tab with the agent, project, label and initiative", async () => {
        await launchAgent(fakeModel(), { ...agentOpts, label: "Fix login", effortORef: "effort:e1" });
        expect(launched().tabmeta).toStrictEqual({
            "session:agent": "claude",
            "session:project": "proj",
            "session:label": "Fix login",
            "session:effort": "effort:e1",
        });
    });

    it("tags the tab with only the agent and project when there is no label or initiative", async () => {
        await launchAgent(fakeModel(), agentOpts);
        expect(launched().tabmeta).toStrictEqual({ "session:agent": "claude", "session:project": "proj" });
    });

    it("adds a booting row for an agent, after the rows already pending, and foregrounds it", async () => {
        const now = vi.spyOn(Date, "now").mockReturnValue(1234);
        const model = fakeModel("jarvis");
        const earlier = { tabId: "t0", blockId: "b0", name: "old", project: "p0", ts: 1 };
        globalStore.set(model.pendingLaunchesAtom, [earlier]);
        try {
            await launchAgent(model, { ...agentOpts, label: "Fix login" });
        } finally {
            now.mockRestore();
        }
        expect(globalStore.get(model.pendingLaunchesAtom)).toStrictEqual([
            earlier,
            { tabId: "tab-1", blockId: "blk-1", name: "Fix login", project: "proj", ts: 1234, runtime: "claude" },
        ]);
        expect(globalStore.get(model.focusIdAtom)).toBe("tab-1");
        expect(globalStore.get(model.surfaceAtom)).toBe("agent");
    });

    it("names the booting row for the project when there is no label", async () => {
        const model = fakeModel();
        await launchAgent(model, agentOpts);
        expect(globalStore.get(model.pendingLaunchesAtom)[0]).toMatchObject({ name: "proj" });
    });

    it("numbers the booting row against the live agents named for the project, not terminals or titled ones", async () => {
        const row = (tabId: string, label: string, projectNamed: boolean) => ({ tabId, label, projectNamed });
        globalStore.set(sidebarAtom, {
            groups: [
                {
                    label: "proj",
                    sessions: [
                        row("a1", "proj", true),
                        row("term", "proj 2", false),
                        row("a2", "Fix login", false),
                        row("tab-1", "proj 2", true), // the new tab itself, if the sidebar already shows it
                    ],
                },
            ],
        });
        const model = fakeModel();
        await launchAgent(model, agentOpts);
        expect(globalStore.get(model.pendingLaunchesAtom)[0]).toMatchObject({ name: "proj 2" });
    });

    it("launchAgent from the Cockpit leaves surfaceAtom on cockpit", async () => {
        const model = fakeModel("cockpit");
        await launchAgent(model, agentOpts);
        expect(globalStore.get(model.surfaceAtom)).toBe("cockpit");
        expect(globalStore.get(model.focusIdAtom)).toBe("tab-1");
    });

    it("rejects a refused start with its refusal, records it as the block's start error, and does not land", async () => {
        launchTab.mockResolvedValue({ tabid: "tab-1", blockid: "blk-1", starterror: "snapshot refused" });
        const model = fakeModel("jarvis");
        await expect(launchAgent(model, agentOpts)).rejects.toThrow("snapshot refused");
        expect(globalStore.get(getStartErrorAtom("blk-1"))).toBe("snapshot refused");
        expect(globalStore.get(model.surfaceAtom)).toBe("jarvis");
        expect(globalStore.get(model.pendingLaunchesAtom)).toStrictEqual([]);
    });

    it("clears the block's earlier start error once it starts", async () => {
        globalStore.set(getStartErrorAtom("blk-1"), "earlier refusal");
        await launchAgent(fakeModel(), agentOpts);
        expect(globalStore.get(getStartErrorAtom("blk-1"))).toBeUndefined();
    });

    it("rejects with the launch's own error, leaving no booting row", async () => {
        launchTab.mockRejectedValue(new Error("snapshot store: not launching an agent"));
        const model = fakeModel();
        await expect(launchAgent(model, agentOpts)).rejects.toThrow("snapshot store: not launching an agent");
        expect(globalStore.get(model.pendingLaunchesAtom)).toStrictEqual([]);
    });

    it("leaves a terminal to start when it is first opened", async () => {
        await launchAgent(fakeModel(), { ...agentOpts, runtime: "terminal", startupCommand: "" });
        expect(launched().start).toBe(false);
    });

    it("opens a terminal in the project in the background, with no agent row and no branch worktree", async () => {
        const model = fakeModel();
        await launchAgent(model, { ...agentOpts, runtime: "terminal", startupCommand: "", branch: "feat/x" });
        expect(createWorktree).not.toHaveBeenCalled();
        expect(launched().blockmeta).toStrictEqual({ view: "term", controller: "shell", "cmd:cwd": "C:/proj" });
        expect(launched().tabmeta).toStrictEqual({ "session:project": "proj" });
        expect(globalStore.get(model.pendingLaunchesAtom)).toStrictEqual([]);
        expect(globalStore.get(model.focusIdAtom)).toBeUndefined();
        expect(globalStore.get(model.surfaceAtom)).toBe("cockpit");
    });

    it("a terminal launched on the Agent surface is focused", async () => {
        const model = fakeModel("agent");
        await launchAgent(model, { ...agentOpts, runtime: "terminal", startupCommand: "" });
        expect(globalStore.get(model.focusIdAtom)).toBe("tab-1");
        expect(globalStore.get(model.surfaceAtom)).toBe("agent");
        expect(globalStore.get(model.pendingLaunchesAtom)).toStrictEqual([]);
    });

    it("a terminal launched on the Cockpit stays in the background", async () => {
        const model = fakeModel("cockpit");
        await launchAgent(model, { ...agentOpts, runtime: "terminal", startupCommand: "" });
        expect(globalStore.get(model.focusIdAtom)).toBeUndefined();
        expect(globalStore.get(model.surfaceAtom)).toBe("cockpit");
    });

    it("opens a terminal with no project path in the home directory", async () => {
        await launchAgent(fakeModel(), { ...agentOpts, runtime: "terminal", startupCommand: "", projectPath: "" });
        expect(launched().blockmeta["cmd:cwd"]).toBe("~");
    });
});

describe("launchAgentOrToast", () => {
    it("launchAgentOrToast toasts the reason and returns null", async () => {
        fileInfo.mockResolvedValue({ notfound: true });
        const logged = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
            await expect(launchAgentOrToast(fakeModel(), agentOpts)).resolves.toBeNull();
            expect(logged.mock.calls[0].join(" ")).toContain("proj");
        } finally {
            logged.mockRestore();
        }
        expect(pushToast).toHaveBeenCalledWith({
            level: "error",
            title: "Couldn't start the agent",
            message: "Working directory no longer exists: C:/proj",
        });
        expect(launchTab).not.toHaveBeenCalled();
    });

    it("returns the tab id and toasts nothing when the launch works", async () => {
        await expect(launchAgentOrToast(fakeModel(), agentOpts)).resolves.toBe("tab-1");
        expect(pushToast).not.toHaveBeenCalled();
    });
});
