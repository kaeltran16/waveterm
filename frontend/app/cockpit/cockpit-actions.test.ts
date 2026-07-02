import { atom } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { globalStore } from "@/app/store/jotaiStore";

// launchAgent configures the new tab's default block via SetMeta, but the frontend's cached
// (unsubscribed) block object stays stale at the pre-conversion shell meta — so the session
// sidebar never sees cmd:cwd and the agent never enters the roster (empty cockpit panel). The fix
// reloads the block object after SetMeta. These tests lock in that reload.

const createTab = vi.fn();
const setMeta = vi.fn().mockResolvedValue(undefined);
const reloadWaveObject = vi.fn().mockResolvedValue(undefined);

vi.mock("@/app/store/services", () => ({ WorkspaceService: { CreateTab: (...a: any[]) => createTab(...a) } }));
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { SetMetaCommand: (...a: any[]) => setMeta(...a) } }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/view/agents/agents", () => ({ AgentsViewModel: class {} }));
vi.mock("@/app/store/global-atoms", () => ({ atoms: { workspace: atom({ oid: "ws1", tabids: [] }) } }));
vi.mock("@/app/store/wos", () => ({
    makeORef: (otype: string, oid: string) => `${otype}:${oid}`,
    getWaveObjectAtom: () => atom({ blockids: ["blk-1"] }),
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
});

describe("launchAgent", () => {
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
});
