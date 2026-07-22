import { afterEach, describe, expect, it, vi } from "vitest";
import { globalStore } from "@/app/store/jotaiStore";

const gitChanges = vi.fn();
const gitDiff = vi.fn();
const resolveCwd = vi.fn();
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        GitChangesCommand: (...a: any[]) => gitChanges(...a),
        GitDiffCommand: (...a: any[]) => gitDiff(...a),
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("./agentcwdresolve", () => ({ resolveCwd: (...a: any[]) => resolveCwd(...a) }));
const ensureSessionStart = vi.fn();
vi.mock("./agentsessionstore", () => ({ ensureSessionStart: (...a: any[]) => ensureSessionStart(...a) }));

import { filesDiffAtom, filesSelectedPathAtom, filesStateAtom, loadFilesForAgent, loadFilesForRun } from "./filesstore";

afterEach(() => {
    gitChanges.mockReset();
    gitDiff.mockReset();
    resolveCwd.mockReset();
    ensureSessionStart.mockReset();
    globalStore.set(filesStateAtom, null);
    globalStore.set(filesSelectedPathAtom, null);
    globalStore.set(filesDiffAtom, null);
});

describe("loadFilesForRun", () => {
    it("threads the base commit as ref into GitChanges and the follow-up GitDiff", async () => {
        gitChanges.mockResolvedValue({ isrepo: true, branch: "main", statusz: "M  x.ts\0", numstat: "1\t0\tx.ts\n" });
        gitDiff.mockResolvedValue({ diff: "", content: "", untracked: false });

        await loadFilesForRun("run-1", "/repo", "abc123");
        // let the fire-and-forget selectFile settle
        await new Promise((r) => setTimeout(r, 0));

        expect(gitChanges).toHaveBeenCalledWith({}, { cwd: "/repo", ref: "abc123" });
        expect(gitDiff).toHaveBeenCalledWith({}, { cwd: "/repo", path: "x.ts", ref: "abc123" });
        expect(globalStore.get(filesStateAtom)?.ref).toBe("abc123");
    });
});

describe("loadFilesForAgent", () => {
    it("resolves the session-start ts, sends it as sessionstartts, and threads the echoed base into GitDiff", async () => {
        resolveCwd.mockResolvedValue("/wt");
        ensureSessionStart.mockResolvedValue(1719000000);
        // backend resolved the session-start commit and echoed it back as `ref`
        gitChanges.mockResolvedValue({ isrepo: true, branch: "feat", statusz: "M  y.ts\0", numstat: "2\t0\ty.ts\n", ref: "base9" });
        gitDiff.mockResolvedValue({ diff: "", content: "", untracked: false });

        await loadFilesForAgent("a1", "/t.jsonl");
        await new Promise((r) => setTimeout(r, 0));

        expect(gitChanges).toHaveBeenCalledWith({}, { cwd: "/wt", sessionstartts: 1719000000 });
        // the per-file diff must use the SAME base the list did, not "" — else pill/list/diff disagree
        expect(gitDiff).toHaveBeenCalledWith({}, { cwd: "/wt", path: "y.ts", ref: "base9" });
        expect(globalStore.get(filesStateAtom)?.ref).toBe("base9");
    });

    it("falls back to a live diff (no base) when the session start can't be resolved", async () => {
        resolveCwd.mockResolvedValue("/wt");
        ensureSessionStart.mockResolvedValue(null);
        gitChanges.mockResolvedValue({ isrepo: true, branch: "main", statusz: "M  y.ts\0", numstat: "2\t0\ty.ts\n", ref: "" });
        gitDiff.mockResolvedValue({ diff: "", content: "", untracked: false });

        await loadFilesForAgent("a2", "/t.jsonl");
        await new Promise((r) => setTimeout(r, 0));

        expect(gitChanges).toHaveBeenCalledWith({}, { cwd: "/wt" });
        expect(globalStore.get(filesStateAtom)?.ref).toBe("");
    });
});
