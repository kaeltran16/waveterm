// frontend/app/view/code/codestore.test.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listFiles = vi.fn();
const fileInfo = vi.fn();
const fileDelete = vi.fn();
const fileMkdir = vi.fn();
const fileMove = vi.fn();
const listWorktrees = vi.fn();
const fileRead = vi.fn();
const listBranches = vi.fn();
const divergence = vi.fn();
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        ListBranchesCommand: (...a: any[]) => listBranches(...a),
        GitDivergenceCommand: (...a: any[]) => divergence(...a),
        GitListFilesCommand: (...a: any[]) => listFiles(...a),
        GitChangesCommand: async () => ({ statusz: "", numstat: "" }),
        GitListWorktreesCommand: (...a: any[]) => listWorktrees(...a),
        FileInfoCommand: (...a: any[]) => fileInfo(...a),
        FileDeleteCommand: (...a: any[]) => fileDelete(...a),
        FileMkdirCommand: (...a: any[]) => fileMkdir(...a),
        FileMoveCommand: (...a: any[]) => fileMove(...a),
        FileReadCommand: (...a: any[]) => fileRead(...a),
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
// the real atom reads the app's config, which vitest never boots; selectPath resolves names through it
vi.mock("@/app/view/agents/projectsstore", async (importOriginal) => {
    const { atom } = await import("jotai");
    return { ...(await importOriginal<object>()), projectsAtom: atom({}) };
});

import type { AgentsViewModel } from "@/app/view/agents/agents";
import { atom } from "jotai";
import { EMPTY_HISTORY, push } from "./codehistory";
import { codeSearchModeAtom } from "./codesearchstore";
import {
    codeBodyPhase,
    codeCursorAtom,
    codeDiffBaseAtom,
    codeDiffTargetAtom,
    codeEditAtom,
    codeExpandedAtom,
    codeFileAtom,
    codeHistoryAtom,
    codeIndexAtom,
    codeIndexErrorAtom,
    codeMutateErrorAtom,
    codePendingJumpAtom,
    codeProjectAtom,
    codeSaveAtom,
    codeSessionDirsAtom,
    codeStaleAtom,
    codeViewModeAtom,
    codeWorktreeFoldersAtom,
    compareWithDisk,
    createEntry,
    cycleDiff,
    deletePath,
    editDraft,
    ensureIndex,
    goToLine,
    isCurrentPick,
    lastCodeProjectAtom,
    openInCode,
    openPath,
    refreshIndex,
    registeredProjects,
    renamePath,
    restoreKind,
    restorePath,
    revertDraft,
    saveCurrent,
    selectProject,
    showDiffTarget,
    type CodeIndex,
} from "./codestore";

const registry = {
    alpha: { path: "C:\\repos\\alpha" },
    beta: { path: "/home/u/beta" },
} as Record<string, ProjectKeywords>;

describe("restoreKind", () => {
    it("restoreKind is registered for a registry path", () => {
        expect(restoreKind({ name: "alpha", path: "C:\\repos\\alpha" }, registry)).toBe("registered");
        expect(restoreKind({ name: "alpha", path: "c:/repos/ALPHA" }, registry)).toBe("registered");
    });

    it("restoreKind is by-path for an unregistered stored folder", () => {
        expect(restoreKind({ name: "gone", path: "C:\\repos\\gone" }, registry)).toBe("by-path");
        expect(restoreKind({ name: "alpha", path: "C:\\repos\\alpha" }, {})).toBe("by-path");
        expect(restoreKind({ name: "alpha", path: "C:\\repos\\alpha" }, undefined)).toBe("by-path");
    });

    it("restoreKind is none without a stored project", () => {
        expect(restoreKind(null, registry)).toBe("none");
    });
});

describe("isCurrentPick", () => {
    const alpha = { name: "alpha", path: "C:\\repos\\alpha" };

    it("is true for the same path in another case or separator", () => {
        expect(isCurrentPick(alpha, "c:/Repos/ALPHA/")).toBe(true);
        expect(isCurrentPick(alpha, "C:\\repos\\alpha")).toBe(true);
    });

    it("is false for another path or with nothing selected", () => {
        expect(isCurrentPick(alpha, "C:\\repos\\alpha\\sub")).toBe(false);
        expect(isCurrentPick(null, "C:\\repos\\alpha")).toBe(false);
    });
});

describe("registeredProjects", () => {
    it("lists every entry that has a path, sorted by name", () => {
        const unsorted = { zeta: { path: "C:\\z" }, blank: {}, ...registry } as Record<string, ProjectKeywords>;
        expect(registeredProjects(unsorted)).toEqual([
            { name: "alpha", path: "C:\\repos\\alpha" },
            { name: "beta", path: "/home/u/beta" },
            { name: "zeta", path: "C:\\z" },
        ]);
    });

    it("is empty while the registry has not loaded yet", () => {
        expect(registeredProjects(undefined)).toEqual([]);
    });
});

describe("codeBodyPhase", () => {
    const alpha = { name: "alpha", path: "C:\\repos\\alpha" };
    const byPath = { name: "scratch", path: "C:\\scratch" };
    const idx = (isRepo: boolean) => ({ paths: [], isRepo, truncated: false });
    const base = { registry, project: alpha, stored: null, index: idx(true), indexError: null };

    it("is loading while a stored project is about to be restored, not no-project", () => {
        expect(codeBodyPhase({ ...base, project: null, stored: alpha })).toBe("loading");
    });
    it("codeBodyPhase is loading for a by-path restore", () => {
        expect(codeBodyPhase({ ...base, project: null, stored: byPath })).toBe("loading");
    });
    it("codeBodyPhase is loading for a by-path restore with an empty registry", () => {
        expect(codeBodyPhase({ ...base, registry: {}, project: null, stored: byPath })).toBe("loading");
        expect(codeBodyPhase({ ...base, registry: undefined, project: null, stored: byPath })).toBe("loading");
    });
    it("is no-project when nothing was stored", () => {
        expect(codeBodyPhase({ ...base, project: null })).toBe("no-project");
    });
    it("is loading while the file list has not arrived", () => {
        expect(codeBodyPhase({ ...base, index: null })).toBe("loading");
    });
    it("keeps the existing branches", () => {
        expect(codeBodyPhase({ ...base, registry: {}, project: null })).toBe("no-projects");
        expect(codeBodyPhase({ ...base, index: null, indexError: "boom" })).toBe("error");
        expect(codeBodyPhase(base)).toBe("ready");
    });
    it("browses a directory that is not a repository", () => {
        expect(codeBodyPhase({ ...base, index: idx(false) })).toBe("ready");
    });
    it("shows a project opened by a jump when none is registered", () => {
        expect(codeBodyPhase({ ...base, registry: {} })).toBe("ready");
        expect(codeBodyPhase({ ...base, registry: {}, index: null })).toBe("loading");
        expect(codeBodyPhase({ ...base, registry: undefined })).toBe("ready");
    });
});

// a project path per test: the store caches each project's index, and a shared path would answer from it
let seq = 0;
const nextProject = () => ({ name: "repo", path: `C:\\repos\\session-${++seq}` });
const index = (paths: string[]): CodeIndex => ({ paths, isRepo: true, truncated: false });
const text = (path: string, body = "one\n") =>
    ({ kind: "text", path, text: body, size: body.length, modtime: 1 }) as const;

function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
}

// an open session: a file, its expanded folder, two history entries
function seedSession(paths: string[]) {
    const project = nextProject();
    globalStore.set(codeProjectAtom, project);
    globalStore.set(codeIndexAtom, index(paths));
    globalStore.set(codeIndexErrorAtom, null);
    globalStore.set(codeFileAtom, text("src/a.ts"));
    globalStore.set(codeCursorAtom, "src/a.ts");
    globalStore.set(codeExpandedAtom, new Set(["src"]));
    globalStore.set(codeHistoryAtom, push(push(EMPTY_HISTORY, "README.md"), "src/a.ts"));
    globalStore.set(codeSessionDirsAtom, new Set<string>());
    return project;
}

beforeEach(() => {
    listFiles.mockImplementation(async () => ({ files: ["src/a.ts", "README.md"], isrepo: true }));
    listWorktrees.mockResolvedValue({ worktrees: [] });
    fileInfo.mockResolvedValue({ isdir: true });
});

afterEach(() => {
    vi.clearAllMocks();
    revertDraft();
    globalStore.set(codeSaveAtom, { kind: "idle" });
    globalStore.set(codeStaleAtom, null);
    globalStore.set(codeMutateErrorAtom, null);
});

describe("refreshIndex", () => {
    it("refreshIndex keeps the open file, expanded folders and history", async () => {
        seedSession(["src/a.ts", "README.md"]);
        const file = globalStore.get(codeFileAtom);
        const expanded = globalStore.get(codeExpandedAtom);
        const history = globalStore.get(codeHistoryAtom);
        const seen: (CodeIndex | null)[] = [];
        const unsub = globalStore.sub(codeIndexAtom, () => seen.push(globalStore.get(codeIndexAtom)));
        listFiles.mockResolvedValue({ files: ["src/a.ts", "src/b.ts", "README.md"], isrepo: true });

        await refreshIndex();
        unsub();

        expect(seen.length).toBeGreaterThan(0);
        expect(seen.every((i) => i != null)).toBe(true);
        expect(globalStore.get(codeIndexAtom)?.paths).toContain("src/b.ts");
        expect(globalStore.get(codeFileAtom)).toBe(file);
        expect(globalStore.get(codeExpandedAtom)).toBe(expanded);
        expect(globalStore.get(codeHistoryAtom)).toBe(history);
    });

    it("a session dir leaves once the index lists a file under it", async () => {
        seedSession(["src/a.ts"]);
        globalStore.set(codeSessionDirsAtom, new Set(["fresh", "other"]));
        listFiles.mockResolvedValue({ files: ["src/a.ts", "fresh/x.ts"], isrepo: true });

        await refreshIndex();

        expect([...globalStore.get(codeSessionDirsAtom)]).toEqual(["other"]);
    });
});

describe("ensureIndex", () => {
    it("ensureIndex does not reset the session", async () => {
        seedSession([]);
        globalStore.set(codeIndexAtom, null);
        const file = globalStore.get(codeFileAtom);
        const expanded = globalStore.get(codeExpandedAtom);
        const history = globalStore.get(codeHistoryAtom);

        await ensureIndex();

        expect(globalStore.get(codeIndexAtom)?.paths).toEqual(["src/a.ts", "README.md"]);
        expect(globalStore.get(codeFileAtom)).toBe(file);
        expect(globalStore.get(codeExpandedAtom)).toBe(expanded);
        expect(globalStore.get(codeHistoryAtom)).toBe(history);
    });

    it("ensureIndex does nothing while a load is in flight", async () => {
        const slow = deferred<{ files: string[]; isrepo: boolean }>();
        listFiles.mockReturnValue(slow.promise);
        const loading = selectProject(nextProject());
        expect(listFiles).toHaveBeenCalledTimes(1);

        await ensureIndex();
        expect(listFiles).toHaveBeenCalledTimes(1);

        slow.resolve({ files: ["a.ts"], isrepo: true });
        await loading;
        expect(globalStore.get(codeIndexAtom)?.paths).toEqual(["a.ts"]);
    });
});

describe("selectProject", () => {
    it("selectProject clears a pending create", async () => {
        globalStore.set(codeEditAtom, { kind: "create", dir: "", isDir: false });
        await selectProject(null);
        expect(globalStore.get(codeEditAtom)).toBeNull();
    });

    it("clears the session dirs", async () => {
        globalStore.set(codeSessionDirsAtom, new Set(["fresh"]));
        await selectProject(nextProject());
        expect(globalStore.get(codeSessionDirsAtom).size).toBe(0);
    });

    it("publishes only the worktree folders that stat as directories", async () => {
        listWorktrees.mockResolvedValue({
            worktrees: [
                { path: "C:/repos/w/main", branch: "main", ismain: true },
                { path: "C:/repos/w/feat", branch: "feat" },
                { path: "C:/repos/w/old", branch: "old" },
            ],
        });
        fileInfo.mockImplementation(async (_client: unknown, { info }: { info: { path: string } }) => {
            if (info.path.includes("feat")) return { notfound: true };
            if (info.path.includes("old")) throw new Error("denied");
            return { isdir: true };
        });
        const logged = vi.spyOn(console, "error").mockImplementation(() => {});

        await selectProject({ name: "web", path: "C:\\repos\\w\\main\\web" });

        await vi.waitFor(() =>
            expect(globalStore.get(codeWorktreeFoldersAtom)).toEqual([
                { label: "main", path: "C:\\repos\\w\\main\\web" },
            ])
        );
        expect(logged).toHaveBeenCalled();
        logged.mockRestore();
    });
});

describe("createEntry", () => {
    it("adds a created folder to the session dirs, expands and selects it", async () => {
        seedSession(["src/a.ts"]);
        fileMkdir.mockResolvedValue(undefined);
        listFiles.mockResolvedValue({ files: ["src/a.ts"], isrepo: true });

        await createEntry("src", "fresh", true);

        expect(globalStore.get(codeSessionDirsAtom).has("src/fresh")).toBe(true);
        expect(globalStore.get(codeExpandedAtom).has("src/fresh")).toBe(true);
        expect(globalStore.get(codeCursorAtom)).toBe("src/fresh");
    });
});

describe("renamePath", () => {
    it("session dirs follow a rename", async () => {
        seedSession(["src/a.ts"]);
        globalStore.set(codeSessionDirsAtom, new Set(["src/fresh", "src/fresh/inner", "keep"]));
        fileMove.mockResolvedValue(undefined);

        await renamePath("src/fresh", "renamed");

        expect([...globalStore.get(codeSessionDirsAtom)].sort()).toEqual(["keep", "src/renamed", "src/renamed/inner"]);
    });
});

describe("deletePath", () => {
    it("a failed delete keeps the open file", async () => {
        seedSession(["src/a.ts"]);
        fileDelete.mockRejectedValue(new Error("in use"));

        await deletePath("src/a.ts", false);

        expect(globalStore.get(codeFileAtom)).toMatchObject({ kind: "text", path: "src/a.ts" });
        expect(globalStore.get(codeCursorAtom)).toBe("src/a.ts");
        expect(globalStore.get(codeMutateErrorAtom)).toMatch(/in use/);
    });

    it("a successful delete closes it", async () => {
        seedSession(["src/a.ts"]);
        fileDelete.mockResolvedValue(undefined);

        await deletePath("src/a.ts", false);

        expect(globalStore.get(codeFileAtom)).toEqual({ kind: "none" });
        expect(globalStore.get(codeCursorAtom)).toBeNull();
    });

    it("a deleted session dir leaves the set", async () => {
        seedSession(["src/a.ts"]);
        globalStore.set(codeSessionDirsAtom, new Set(["fresh", "fresh/inner", "keep"]));
        fileDelete.mockResolvedValue(undefined);

        await deletePath("fresh", true);

        expect([...globalStore.get(codeSessionDirsAtom)]).toEqual(["keep"]);
    });
});

describe("restorePath", () => {
    it("forgets a stored folder that is gone from disk", async () => {
        await selectProject(null);
        const gone = nextProject();
        globalStore.set(lastCodeProjectAtom, gone);
        fileInfo.mockResolvedValue({ notfound: true });

        await restorePath(gone.path);

        expect(globalStore.get(lastCodeProjectAtom)).toBeNull();
        expect(globalStore.get(codeProjectAtom)).toBeNull();
        expect(listFiles).not.toHaveBeenCalled();
    });

    it("reopens a stored folder that is still a directory", async () => {
        await selectProject(null);
        const kept = nextProject();
        globalStore.set(lastCodeProjectAtom, kept);

        await restorePath(kept.path);

        expect(globalStore.get(codeProjectAtom)?.path).toBe(kept.path);
        expect(globalStore.get(codeIndexAtom)?.paths).toEqual(["src/a.ts", "README.md"]);
    });
});

describe("saveCurrent", () => {
    it("a refused save raises the stale bar", async () => {
        seedSession(["src/a.ts"]);
        editDraft("one\nmine\n");
        fileInfo.mockResolvedValue({ size: 99, modtime: 2 });

        await saveCurrent();

        expect(globalStore.get(codeSaveAtom)).toMatchObject({ kind: "conflict", path: "src/a.ts" });
        expect(globalStore.get(codeStaleAtom)).toEqual({ path: "src/a.ts" });
    });
});

describe("diff targets", () => {
    const inDiff = (target: "head" | "base" | "disk") => {
        globalStore.set(codeViewModeAtom, "diff");
        globalStore.set(codeDiffTargetAtom, target);
    };

    afterEach(() => {
        globalStore.set(codeViewModeAtom, "preview");
        globalStore.set(codeDiffTargetAtom, "head");
        globalStore.set(codeDiffBaseAtom, null);
    });

    it("cycleDiff from the disk target returns to Source", async () => {
        seedSession(["src/a.ts"]);
        inDiff("disk");

        await cycleDiff();

        expect(globalStore.get(codeViewModeAtom)).toBe("source");
    });

    it("showDiffTarget base on the default branch stays on HEAD", async () => {
        seedSession(["src/a.ts"]);
        inDiff("head");
        listBranches.mockResolvedValue({ default: "main" });
        divergence.mockResolvedValue({ ahead: [], mergebase: "abc1234", isrepo: true });

        await showDiffTarget("base");

        expect(globalStore.get(codeViewModeAtom)).toBe("diff");
        expect(globalStore.get(codeDiffTargetAtom)).toBe("head");
        expect(globalStore.get(codeDiffBaseAtom)).toEqual({ kind: "skip" });
    });

    it("showDiffTarget base on a feature branch lands on the base", async () => {
        seedSession(["src/a.ts"]);
        inDiff("head");
        listBranches.mockResolvedValue({ default: "main" });
        const commit = { hash: "f00", parents: [], author: "a", email: "e", ts: 0, subject: "s" };
        divergence.mockResolvedValue({ ahead: [commit], mergebase: "abc1234", isrepo: true });

        await showDiffTarget("base");

        expect(globalStore.get(codeDiffTargetAtom)).toBe("base");
        expect(globalStore.get(codeDiffBaseAtom)).toEqual({ kind: "usable", branch: "main", sha: "abc1234" });
    });

    it("showDiffTarget head leaves the disk target", async () => {
        seedSession(["src/a.ts"]);
        inDiff("disk");

        await showDiffTarget("head");

        expect(globalStore.get(codeDiffTargetAtom)).toBe("head");
        expect(listBranches).not.toHaveBeenCalled();
    });

    it("compareWithDisk enters the disk target", () => {
        seedSession(["src/a.ts"]);
        globalStore.set(codeViewModeAtom, "source");

        compareWithDisk();

        expect(globalStore.get(codeViewModeAtom)).toBe("diff");
        expect(globalStore.get(codeDiffTargetAtom)).toBe("disk");
    });
});

describe("jumps", () => {
    // already on Code, so the jump does not move the surface
    const model = { surfaceAtom: atom("code") } as unknown as AgentsViewModel;
    const textFile = (body: string) => {
        fileInfo.mockResolvedValue({ size: body.length, mimetype: "text/plain", modtime: 2 });
        fileRead.mockResolvedValue({ data64: btoa(body) });
    };

    afterEach(() => {
        globalStore.set(codePendingJumpAtom, null);
    });

    it("openInCode tags the pending jump with its path", async () => {
        const project = seedSession(["src/a.ts", "src/b.ts"]);
        textFile("b\n");

        await openInCode(model, { projectPath: project.path, rel: "src/b.ts", line: 9 });

        expect(globalStore.get(codeFileAtom)).toMatchObject({ kind: "text", path: "src/b.ts" });
        expect(globalStore.get(codePendingJumpAtom)).toEqual({ path: "src/b.ts", line: 9 });
    });

    it("openInCode carries an anchor", async () => {
        const project = seedSession(["src/a.ts", "docs/b.md"]);
        textFile("# B\n");

        await openInCode(model, { projectPath: project.path, rel: "docs/b.md", anchor: "b" });

        expect(globalStore.get(codePendingJumpAtom)).toEqual({ path: "docs/b.md", anchor: "b" });
    });

    it("opening another file drops a pending jump for a different path", async () => {
        seedSession(["src/a.ts", "src/b.ts", "README.md"]);
        textFile("x\n");
        globalStore.set(codePendingJumpAtom, { path: "src/b.ts", line: 9 });

        await openPath("src/b.ts");
        expect(globalStore.get(codePendingJumpAtom)).toEqual({ path: "src/b.ts", line: 9 });

        await openPath("README.md");
        expect(globalStore.get(codePendingJumpAtom)).toBeNull();
    });

    it("goToLine tags the pending jump with the open file", () => {
        seedSession(["src/a.ts"]);

        goToLine(152);

        expect(globalStore.get(codePendingJumpAtom)).toEqual({ path: "src/a.ts", line: 152 });
    });

    it("openPath of a directory reveals the folder and leaves the file and history", async () => {
        seedSession(["src/a.ts", "docs/x/y.md"]);
        const file = globalStore.get(codeFileAtom);
        const history = globalStore.get(codeHistoryAtom);
        globalStore.set(codeSearchModeAtom, "search");
        fileInfo.mockResolvedValue({ isdir: true, mimetype: "directory" });

        await openPath("docs/x");

        expect(globalStore.get(codeFileAtom)).toBe(file);
        expect(globalStore.get(codeHistoryAtom)).toBe(history);
        expect(fileRead).not.toHaveBeenCalled();
        expect(globalStore.get(codeCursorAtom)).toBe("docs/x");
        expect([...globalStore.get(codeExpandedAtom)]).toEqual(expect.arrayContaining(["src", "docs", "docs/x"]));
        expect(globalStore.get(codeSearchModeAtom)).toBe("files");
    });
});
