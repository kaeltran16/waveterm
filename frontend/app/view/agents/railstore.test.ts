import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { describe, expect, it, vi } from "vitest";
import { loadRailForAgent, railStateAtom } from "./railstore";

vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        GitChangesCommand: vi.fn(),
        GitAgentEditsCommand: vi.fn(),
        GitListWorktreesCommand: vi.fn(async () => ({ worktrees: [] })),
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("./agentcwdresolve", () => ({ resolveCwd: vi.fn(async () => "C:/src/demo") }));
vi.mock("./agentsessionstore", () => ({ ensureSessionStart: vi.fn(async () => null) }));

// a non-Claude agent reads its checkout since the session started
const pi = { transcriptPath: "t.jsonl", agent: "pi" };
const claude = { transcriptPath: "t.jsonl", agent: "claude" };
const changes = (path: string) => ({ branch: "main", statusz: ` M ${path}\0`, numstat: "", isrepo: true });

describe("loadRailForAgent", () => {
    it("keeps the newer load when an older one for the same agent lands last", async () => {
        let finishOlder!: (v: ReturnType<typeof changes>) => void;
        vi.mocked(RpcApi.GitChangesCommand)
            .mockReturnValueOnce(new Promise((r) => (finishOlder = r)))
            .mockResolvedValueOnce(changes("b.ts"));

        const older = loadRailForAgent(pi, { silent: true });
        await vi.waitFor(() => expect(RpcApi.GitChangesCommand).toHaveBeenCalledTimes(1));
        await loadRailForAgent(pi, { silent: true });
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
        await loadRailForAgent(pi);
        expect(globalStore.get(railStateAtom)).toMatchObject({ ref: "abc123", head: "def456", isRepo: true });
    });

    it("says why a read failed rather than reading as no repo", async () => {
        vi.mocked(RpcApi.GitChangesCommand).mockRejectedValueOnce(new Error("git: index.lock exists"));
        await loadRailForAgent(pi);
        expect(globalStore.get(railStateAtom)).toMatchObject({
            cwd: "C:/src/demo",
            changes: null,
            failure: "git: index.lock exists",
        });
    });

    // a fresh agent in a shared checkout showed the other sessions' uncommitted work as its own
    it("lists nothing for a Claude agent with no edits of its own, whatever else the checkout holds", async () => {
        vi.mocked(RpcApi.GitAgentEditsCommand).mockResolvedValueOnce({
            base: "",
            end: "",
            files: [],
            bashcalls: 0,
            reason: "No transcript for this agent yet",
        });
        vi.mocked(RpcApi.GitChangesCommand).mockResolvedValueOnce(changes("someone-else.ts"));
        await loadRailForAgent(claude);
        expect(globalStore.get(railStateAtom)).toMatchObject({ branch: "main", isRepo: true, edits: true });
        expect(globalStore.get(railStateAtom)?.changes?.files).toEqual([]);
    });

    it("lists a Claude agent's own edits, the range its patch reads too", async () => {
        vi.mocked(RpcApi.GitAgentEditsCommand).mockResolvedValueOnce({ base: "B", end: "H", files: [], bashcalls: 0 });
        vi.mocked(RpcApi.GitChangesCommand).mockResolvedValueOnce({ ...changes("mine.ts"), ref: "B" });
        await loadRailForAgent(claude);
        expect(RpcApi.GitChangesCommand).toHaveBeenLastCalledWith({}, { cwd: "C:/src/demo", ref: "B", end: "H" });
        expect(globalStore.get(railStateAtom)).toMatchObject({ ref: "B", end: "H", edits: true });
        expect(globalStore.get(railStateAtom)?.changes?.files.map((f) => f.path)).toEqual(["mine.ts"]);
    });
});
