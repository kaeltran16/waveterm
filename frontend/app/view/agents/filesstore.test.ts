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

import { scopeKey, type DiffScope } from "./diffscope";
import {
    consumeFileLink,
    filesDiffAtom,
    filesSelectedPathAtom,
    filesStateAtom,
    loadFilesForScope,
    requestFileLink,
} from "./filesstore";

const runScopeVal = (id: string, cwd = "/repo", base = "abc123"): DiffScope => ({
    repo: { origin: { kind: "run", runId: id, cwd, baseCommit: base }, label: `run ${base}` },
    range: { kind: "run", runId: id, baseCommit: base },
});
const agentScopeVal = (id: string): DiffScope => ({
    repo: { origin: { kind: "agent", id }, label: id },
    range: { kind: "session", agentId: id },
});
const projectScopeVal = (name: string, path = "/repo"): DiffScope => ({
    repo: { origin: { kind: "project", name, path }, label: name },
    range: { kind: "working" },
});

afterEach(() => {
    gitChanges.mockReset();
    gitDiff.mockReset();
    resolveCwd.mockReset();
    ensureSessionStart.mockReset();
    globalStore.set(filesStateAtom, null);
    globalStore.set(filesSelectedPathAtom, null);
    globalStore.set(filesDiffAtom, null);
});

describe("loadFilesForScope, run range", () => {
    it("threads the base commit as ref into GitChanges and the follow-up GitDiff", async () => {
        gitChanges.mockResolvedValue({ isrepo: true, branch: "main", statusz: "M  x.ts\0", numstat: "1\t0\tx.ts\n" });
        gitDiff.mockResolvedValue({ diff: "", content: "", untracked: false });

        await loadFilesForScope(runScopeVal("run-1"));
        // let the fire-and-forget selectFile settle
        await new Promise((r) => setTimeout(r, 0));

        expect(gitChanges).toHaveBeenCalledWith({}, { cwd: "/repo", ref: "abc123" });
        expect(gitDiff).toHaveBeenCalledWith({}, { cwd: "/repo", path: "x.ts", ref: "abc123" });
        expect(globalStore.get(filesStateAtom)?.ref).toBe("abc123");
    });
});

describe("loadFilesForScope, session range", () => {
    it("resolves the session-start ts, sends it as sessionstartts, and threads the echoed base into GitDiff", async () => {
        resolveCwd.mockResolvedValue("/wt");
        ensureSessionStart.mockResolvedValue(1719000000);
        // backend resolved the session-start commit and echoed it back as `ref`
        gitChanges.mockResolvedValue({
            isrepo: true,
            branch: "feat",
            statusz: "M  y.ts\0",
            numstat: "2\t0\ty.ts\n",
            ref: "base9",
        });
        gitDiff.mockResolvedValue({ diff: "", content: "", untracked: false });

        await loadFilesForScope(agentScopeVal("a1"), { transcriptPath: "/t.jsonl" });
        await new Promise((r) => setTimeout(r, 0));

        expect(gitChanges).toHaveBeenCalledWith({}, { cwd: "/wt", sessionstartts: 1719000000 });
        // the per-file diff must use the SAME base the list did, not "" — else pill/list/diff disagree
        expect(gitDiff).toHaveBeenCalledWith({}, { cwd: "/wt", path: "y.ts", ref: "base9" });
        expect(globalStore.get(filesStateAtom)?.ref).toBe("base9");
    });

    it("falls back to a live diff (no base) when the session start can't be resolved", async () => {
        resolveCwd.mockResolvedValue("/wt");
        ensureSessionStart.mockResolvedValue(null);
        gitChanges.mockResolvedValue({
            isrepo: true,
            branch: "main",
            statusz: "M  y.ts\0",
            numstat: "2\t0\ty.ts\n",
            ref: "",
        });
        gitDiff.mockResolvedValue({ diff: "", content: "", untracked: false });

        await loadFilesForScope(agentScopeVal("a2"), { transcriptPath: "/t.jsonl" });
        await new Promise((r) => setTimeout(r, 0));

        expect(gitChanges).toHaveBeenCalledWith({}, { cwd: "/wt" });
        expect(globalStore.get(filesStateAtom)?.ref).toBe("");
    });
});

describe("loadFilesForScope, working range on an agent", () => {
    // Newly expressible: an agent's own worktree read with no anchor. Reaching this today would mean
    // selecting a registered project, which means clearing the agent.
    it("sends neither ref nor sessionstartts", async () => {
        resolveCwd.mockResolvedValue("/wt");
        gitChanges.mockResolvedValue({
            isrepo: true,
            branch: "main",
            statusz: "M  y.ts\0",
            numstat: "2\t0\ty.ts\n",
            ref: "",
        });
        gitDiff.mockResolvedValue({ diff: "", content: "", untracked: false });

        await loadFilesForScope({ ...agentScopeVal("a3"), range: { kind: "working" } }, { transcriptPath: "/t.jsonl" });
        await new Promise((r) => setTimeout(r, 0));

        expect(gitChanges).toHaveBeenCalledWith({}, { cwd: "/wt" });
        expect(ensureSessionStart).not.toHaveBeenCalled();
    });
});

describe("scoped file deep link", () => {
    const AVAILABLE = ["docs/open-issues.md", "pkg/jarvis/evidence.go"];

    it("hands the requested path to the scope that asked for it", () => {
        requestFileLink(scopeKey(runScopeVal("r1")), "pkg/jarvis/evidence.go");
        expect(consumeFileLink(scopeKey(runScopeVal("r1")), AVAILABLE)).toBe("pkg/jarvis/evidence.go");
    });

    // the agent details rail used to have its own mechanism, which wrote an atom no pane renders —
    // clicking the third file there opened the surface on the scope's first file instead
    it("works for an agent scope, not only a run", () => {
        requestFileLink(scopeKey(agentScopeVal("a1")), "pkg/jarvis/evidence.go");
        expect(consumeFileLink(scopeKey(agentScopeVal("a1")), AVAILABLE)).toBe("pkg/jarvis/evidence.go");
    });

    it("is one-shot, so returning to the Diff surface keeps the user's later selection", () => {
        requestFileLink(scopeKey(runScopeVal("r1")), "pkg/jarvis/evidence.go");
        expect(consumeFileLink(scopeKey(runScopeVal("r1")), AVAILABLE)).toBe("pkg/jarvis/evidence.go");
        expect(consumeFileLink(scopeKey(runScopeVal("r1")), AVAILABLE)).toBeUndefined();
    });

    it("does not leak one scope's request into another scope's load", () => {
        requestFileLink(scopeKey(runScopeVal("r1")), "pkg/jarvis/evidence.go");
        expect(consumeFileLink(scopeKey(runScopeVal("r2")), AVAILABLE)).toBeUndefined();
        // still pending for the scope that asked
        expect(consumeFileLink(scopeKey(runScopeVal("r1")), AVAILABLE)).toBe("pkg/jarvis/evidence.go");
    });

    // an agent id and a run id could collide as bare strings; the origin prefix is what keeps them apart
    it("does not confuse an agent with a run or project of the same id", () => {
        const agentX: DiffScope = {
            repo: { origin: { kind: "agent", id: "x" }, label: "x" },
            range: { kind: "working" },
        };
        const runX: DiffScope = {
            repo: { origin: { kind: "run", runId: "x", cwd: "/x", baseCommit: "" }, label: "x" },
            range: { kind: "working" },
        };
        const projectX = projectScopeVal("x", "/x");
        requestFileLink(scopeKey(agentX), "pkg/jarvis/evidence.go");
        expect(consumeFileLink(scopeKey(runX), AVAILABLE)).toBeUndefined();
        expect(consumeFileLink(scopeKey(projectX), AVAILABLE)).toBeUndefined();
        expect(consumeFileLink(scopeKey(agentX), AVAILABLE)).toBe("pkg/jarvis/evidence.go");
    });

    it("survives a load whose change set is not in yet, so the next load can honour it", () => {
        // the Diff surface fires one history read per mount against the state captured in that render,
        // which on a remount is still the outgoing scope's — an empty/foreign set must not eat the link
        requestFileLink(scopeKey(runScopeVal("r1")), "pkg/jarvis/evidence.go");
        expect(consumeFileLink(scopeKey(runScopeVal("r1")), [])).toBeUndefined();
        expect(consumeFileLink(scopeKey(runScopeVal("r1")), ["some/other/file.ts"])).toBeUndefined();
        expect(consumeFileLink(scopeKey(runScopeVal("r1")), AVAILABLE)).toBe("pkg/jarvis/evidence.go");
    });

    it("has nothing pending when no link was followed", () => {
        expect(consumeFileLink(scopeKey(runScopeVal("r-none")), AVAILABLE)).toBeUndefined();
    });

    it("an absent scope claims nothing", () => {
        requestFileLink(scopeKey(agentScopeVal("a1")), "pkg/jarvis/evidence.go");
        expect(consumeFileLink("", AVAILABLE)).toBeUndefined();
    });
});
