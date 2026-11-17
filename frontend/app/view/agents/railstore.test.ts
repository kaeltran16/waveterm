import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { describe, expect, it, vi } from "vitest";
import { loadRailForAgent, railStateAtom } from "./railstore";

vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: { GitChangesCommand: vi.fn(), GitListWorktreesCommand: vi.fn(async () => ({ worktrees: [] })) },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("./agentcwdresolve", () => ({ resolveCwd: vi.fn(async () => "C:/src/demo") }));
vi.mock("./agentsessionstore", () => ({ ensureSessionStart: vi.fn(async () => null) }));

const changes = (path: string) => ({ branch: "main", statusz: ` M ${path}\0`, numstat: "", isrepo: true });

describe("loadRailForAgent", () => {
    it("keeps the newer load when an older one for the same agent lands last", async () => {
        let finishOlder!: (v: ReturnType<typeof changes>) => void;
        vi.mocked(RpcApi.GitChangesCommand)
            .mockReturnValueOnce(new Promise((r) => (finishOlder = r)))
            .mockResolvedValueOnce(changes("b.ts"));

        const older = loadRailForAgent("t.jsonl", undefined, { silent: true });
        await vi.waitFor(() => expect(RpcApi.GitChangesCommand).toHaveBeenCalledTimes(1));
        await loadRailForAgent("t.jsonl", undefined, { silent: true });
        finishOlder(changes("a.ts"));
        await older;

        expect(globalStore.get(railStateAtom)?.changes?.files.map((f) => f.path)).toEqual(["b.ts"]);
    });

    // the Changes tab reads each file's diff against the base the list was read against
    it("keeps the base the backend resolved for the list", async () => {
        vi.mocked(RpcApi.GitChangesCommand).mockResolvedValueOnce({
            ...changes("a.ts"),
            ref: "abc123",
            head: "def456",
        });
        await loadRailForAgent("t.jsonl");
        expect(globalStore.get(railStateAtom)).toMatchObject({ ref: "abc123", head: "def456", isRepo: true });
    });

    it("says why a read failed rather than reading as no repo", async () => {
        vi.mocked(RpcApi.GitChangesCommand).mockRejectedValueOnce(new Error("git: index.lock exists"));
        await loadRailForAgent("t.jsonl");
        expect(globalStore.get(railStateAtom)).toMatchObject({
            cwd: "C:/src/demo",
            changes: null,
            failure: "git: index.lock exists",
        });
    });
});
