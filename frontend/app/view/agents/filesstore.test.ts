import { afterEach, describe, expect, it, vi } from "vitest";
import { globalStore } from "@/app/store/jotaiStore";

const gitChanges = vi.fn();
const gitDiff = vi.fn();
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        GitChangesCommand: (...a: any[]) => gitChanges(...a),
        GitDiffCommand: (...a: any[]) => gitDiff(...a),
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import { filesDiffAtom, filesSelectedPathAtom, filesStateAtom, loadFilesForRun } from "./filesstore";

afterEach(() => {
    gitChanges.mockReset();
    gitDiff.mockReset();
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
