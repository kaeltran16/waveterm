import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalStageId } from "./finalstage";
import { loadRailForAgent, railStateAtom } from "./railstore";
import { endedReviewerId, endedVerifierId, endedWorkerId } from "./runlineage";

vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        GitChangesCommand: vi.fn(),
        GitAgentEditsCommand: vi.fn(),
        GitListWorktreesCommand: vi.fn(async () => ({ worktrees: [] })),
        GitHistoryCommand: vi.fn(),
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("./agentcwdresolve", () => ({ resolveCwd: vi.fn(async () => "C:/src/demo") }));
vi.mock("./agentsessionstore", () => ({ ensureSessionStart: vi.fn(async () => null) }));
// the object store a finished row's read loads its runs and dag from, by oref
const objects = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@/app/store/wos", async () => {
    const { atom } = await import("jotai");
    return {
        makeORef: (otype: string, oid: string) => `${otype}:${oid}`,
        getWaveObjectAtom: () => atom(null),
        loadAndPinWaveObject: async (oref: string) => objects.get(oref) ?? null,
    };
});
const leadRun = vi.fn();
const digests = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("./runlineagestore", async () => {
    const { atom } = await import("jotai");
    return { leadRunAtom: () => atom(() => leadRun()), runDigestsAtom: atom(() => digests.value) };
});

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

    // a session started in the main checkout that edits a sibling worktree listed nothing
    it("reads a Claude agent's edits in the other checkout they went to", async () => {
        vi.mocked(RpcApi.GitAgentEditsCommand).mockResolvedValueOnce({
            base: "B",
            end: "H",
            files: [],
            bashcalls: 0,
            cwd: "C:/src/demo-wt",
        });
        vi.mocked(RpcApi.GitChangesCommand).mockResolvedValueOnce({ ...changes("mine.ts"), ref: "B" });
        await loadRailForAgent(claude);
        expect(RpcApi.GitChangesCommand).toHaveBeenLastCalledWith({}, { cwd: "C:/src/demo-wt", ref: "B", end: "H" });
        expect(RpcApi.GitListWorktreesCommand).toHaveBeenLastCalledWith({}, { cwd: "C:/src/demo-wt" });
        expect(globalStore.get(railStateAtom)).toMatchObject({ cwd: "C:/src/demo-wt", edits: true });
    });

    // a lead writes little itself: what it reviews is what its workers merged into the run's tree
    it("lists a lead's run's changes, read in the run's tree from its base", async () => {
        vi.mocked(RpcApi.GitAgentEditsCommand).mockClear();
        leadRun.mockReturnValueOnce({
            run: { id: "r1", projectpath: "C:/src/demo", landpath: "C:/wt/r1", basecommit: "BASE" },
            merged: 2,
        });
        vi.mocked(RpcApi.GitChangesCommand).mockResolvedValueOnce({ ...changes("worker.ts"), ref: "BASE" });
        await loadRailForAgent({ ...claude, runId: "r1" });
        expect(RpcApi.GitAgentEditsCommand).not.toHaveBeenCalled();
        expect(RpcApi.GitChangesCommand).toHaveBeenLastCalledWith({}, { cwd: "C:/wt/r1", ref: "BASE", end: undefined });
        expect(globalStore.get(railStateAtom)).toMatchObject({ cwd: "C:/wt/r1", ref: "BASE", run: true, edits: false });
        expect(globalStore.get(railStateAtom)?.changes?.files.map((f) => f.path)).toEqual(["worker.ts"]);
    });
});

// a run whose lane t-1 -> t-4 squashed as M (the engine records the squash on the tip's run only, so t-1's run keeps its
// own commit W1), t-5 recorded the same M, and t-2 landed apart as M2
describe("loadRailForAgent, a finished row", () => {
    const ROOT = "C:/src/demo";
    const child = (id: string, endcommit: string | undefined, paths: string[]) => ({
        id,
        endcommit,
        evidence: { files: paths.map((path) => ({ path, stat: "M", add: 3, del: 1 })) },
    });
    const task = (id: string, label: string, deps: string[] = []) => ({
        id,
        label,
        deps,
        state: "done",
        merged: true,
        runid: `c-${id}`,
    });
    const seed = (o: { t4Commit?: string; finalCommit?: string } = {}) => {
        objects.clear();
        const put = (otype: string, obj: { id: string; [k: string]: unknown }) =>
            objects.set(`${otype}:${obj.id}`, obj);
        put("run", {
            id: "r1",
            projectpath: "C:/src/demo/app",
            landpath: "C:/wt/r1",
            basecommit: "BASE",
            dagoref: "d1",
        });
        put("dag", {
            id: "d1",
            tasks: [
                task("t-1", "stats counters"),
                task("t-2", "importer"),
                task("t-4", "stats command", ["t-1"]),
                task("t-5", "docs"),
            ],
            final: { state: "passed", round: 2, ...(o.finalCommit ? { commit: o.finalCommit } : {}) },
        });
        put("run", child("c-t-1", "W1", ["internal/stats/counters.go"]));
        put("run", child("c-t-2", "M2", ["internal/importer/url.go"]));
        put("run", child("c-t-4", "t4Commit" in o ? o.t4Commit : "M", ["cmd/stats.go", "cmd/stats_test.go"]));
        put("run", child("c-t-5", "M", ["docs/cli.md"]));
        digests.value = { r1: { lanes: [["t-1", "t-4"], ["t-2"], ["t-5"]] } };
    };
    const resolves = () =>
        vi.mocked(RpcApi.GitHistoryCommand).mockResolvedValue({ commits: [{ hash: "M", parents: ["P"] }] } as any);

    beforeEach(() => {
        vi.mocked(RpcApi.GitChangesCommand).mockReset();
        vi.mocked(RpcApi.GitHistoryCommand).mockReset();
        vi.mocked(RpcApi.GitListWorktreesCommand).mockResolvedValue({
            worktrees: [{ path: ROOT, ismain: true }],
        } as any);
    });
    afterEach(() => {
        vi.mocked(RpcApi.GitListWorktreesCommand).mockResolvedValue({ worktrees: [] } as any);
    });

    it("lists a done worker's merge commit at the checkout root, its own files apart from the merge's others", async () => {
        seed();
        resolves();
        vi.mocked(RpcApi.GitChangesCommand).mockResolvedValueOnce({ ...changes("cmd/stats.go"), ref: "P" });
        await loadRailForAgent({ id: endedWorkerId("r1", "t-4"), runId: "c-t-4" });
        expect(RpcApi.GitHistoryCommand).toHaveBeenCalledWith({}, { cwd: ROOT, ref: "M", limit: 1 }, expect.anything());
        expect(RpcApi.GitChangesCommand).toHaveBeenLastCalledWith({}, { cwd: ROOT, ref: "P", end: "M" });
        expect(globalStore.get(railStateAtom)).toMatchObject({
            cwd: ROOT,
            ref: "P",
            end: "M",
            merge: {
                commit: "M",
                own: ["cmd/stats.go", "cmd/stats_test.go"],
                also: [
                    { id: "t-1", label: "stats counters" },
                    { id: "t-5", label: "docs" },
                ],
                gone: false,
            },
        });
    });

    it("reads a lane's earlier task from the squash its lane's tip recorded", async () => {
        seed();
        resolves();
        vi.mocked(RpcApi.GitChangesCommand).mockResolvedValueOnce(changes("cmd/stats.go"));
        await loadRailForAgent({ id: endedWorkerId("r1", "t-1"), runId: "c-t-1" });
        expect(RpcApi.GitChangesCommand).toHaveBeenLastCalledWith({}, { cwd: ROOT, ref: "P", end: "M" });
        expect(globalStore.get(railStateAtom)?.merge).toMatchObject({
            commit: "M",
            own: ["internal/stats/counters.go"],
            also: [
                { id: "t-4", label: "stats command" },
                { id: "t-5", label: "docs" },
            ],
        });
    });

    it.each([
        ["no longer resolves", "M", 1],
        ["was never recorded", undefined, 0],
    ])("lists the sealed files without a git read when the merge commit %s", async (_, t4Commit, asked) => {
        seed({ t4Commit });
        vi.mocked(RpcApi.GitHistoryCommand).mockResolvedValue({ failure: "bad revision 'M'" } as any);
        await loadRailForAgent({ id: endedWorkerId("r1", "t-4"), runId: "c-t-4" });
        expect(RpcApi.GitHistoryCommand).toHaveBeenCalledTimes(asked);
        expect(RpcApi.GitChangesCommand).not.toHaveBeenCalled();
        expect(globalStore.get(railStateAtom)).toMatchObject({
            isRepo: true,
            merge: { commit: t4Commit ?? "", own: ["cmd/stats.go", "cmd/stats_test.go"], also: [], gone: true },
            changes: {
                files: [
                    { path: "cmd/stats.go", status: "M", adds: 3, dels: 1 },
                    { path: "cmd/stats_test.go", status: "M", adds: 3, dels: 1 },
                ],
                adds: 6,
                dels: 2,
            },
        });
    });

    it.each([
        ["the Final stage's row", finalStageId("r1"), undefined],
        ["an ended verifier", endedVerifierId("r1", "v1"), "v1"],
    ])("lists %s as the run's changes up to the commit Final verified", async (_, id, runId) => {
        seed({ finalCommit: "FINAL" });
        vi.mocked(RpcApi.GitChangesCommand).mockResolvedValueOnce({ ...changes("cmd/stats.go"), ref: "BASE" });
        await loadRailForAgent({ id, runId });
        expect(RpcApi.GitChangesCommand).toHaveBeenLastCalledWith({}, { cwd: ROOT, ref: "BASE", end: "FINAL" });
        expect(globalStore.get(railStateAtom)).toMatchObject({ run: true, verified: { commit: "FINAL", round: 2 } });
    });

    it("lists the lead's run read for the Final stage's row before Final recorded a commit", async () => {
        seed();
        vi.mocked(RpcApi.GitChangesCommand).mockResolvedValueOnce({ ...changes("cmd/stats.go"), ref: "BASE" });
        await loadRailForAgent({ id: finalStageId("r1") });
        expect(RpcApi.GitChangesCommand).toHaveBeenLastCalledWith({}, { cwd: "C:/wt/r1", ref: "BASE", end: undefined });
        expect(globalStore.get(railStateAtom)).toMatchObject({ run: true });
        expect(globalStore.get(railStateAtom)?.verified).toBeUndefined();
    });

    it("reads an ended plan reviewer's own edits, as before", async () => {
        seed();
        vi.mocked(RpcApi.GitChangesCommand).mockResolvedValueOnce(changes("plan.md"));
        await loadRailForAgent({ ...pi, id: endedReviewerId("r1", "p1"), runId: "p1" });
        expect(globalStore.get(railStateAtom)).toMatchObject({ cwd: "C:/src/demo" });
        expect(globalStore.get(railStateAtom)?.merge).toBeUndefined();
    });
});
