// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitChange } from "./gitstatus";
import type { RailGitState } from "./railstore";

const gitPatch = vi.fn();
const rpcClient = { id: "tab-rpc-client" };
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: { GitPatchCommand: (...a: any[]) => gitPatch(...a) },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: rpcClient }));

// the store keeps its read sequence and per-agent atoms at module scope, so each test gets a fresh copy
async function freshStore() {
    vi.resetModules();
    const store = await import("./workspacechangesstore");
    const { globalStore } = await import("@/app/store/jotaiStore");
    const { ignoreWsAtom } = await import("./diffoptions");
    const { railStateAtom } = await import("./railstore");
    return { ...store, globalStore, ignoreWsAtom, railStateAtom };
}

const modified = (path: string, ...hunks: string[]) =>
    [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, ...hunks].join("\n");
const hunk = (newStart: number, text: string) =>
    [`@@ -${newStart},1 +${newStart},1 @@`, `-old ${text}`, `+${text}`].join("\n");
const reply = (patch: string, truncated = false) => ({ patch, isrepo: true, truncated });
const change = (path: string, status = "M"): GitChange => ({ path, status, adds: 1, dels: 1 });
const rail = (files: GitChange[]): RailGitState => ({
    cwd: "C:/src/demo",
    branch: "main",
    isRepo: true,
    changes: { files, adds: 0, dels: 0 },
    ref: "abc",
});

function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

afterEach(() => {
    gitPatch.mockReset();
});

describe("reading the change set's patch", () => {
    it("asks git for the rail's cwd and base with Hide whitespace, past the server's 10 s git timeout", async () => {
        gitPatch.mockResolvedValue(reply(""));
        const s = await freshStore();
        s.globalStore.set(s.ignoreWsAtom, true);
        await s.loadChangesPatch("a", "C:/src/demo", "abc");
        expect(gitPatch).toHaveBeenCalledTimes(1);
        const [client, data, opts] = gitPatch.mock.calls[0];
        expect(client).toBe(rpcClient);
        expect(data).toEqual({ cwd: "C:/src/demo", ref: "abc", ignorews: true });
        expect(opts.timeout).toBeGreaterThan(10_000);
    });

    it("parses the patch into files", async () => {
        gitPatch.mockResolvedValue(reply(modified("a.ts", hunk(3, "x")), true));
        const s = await freshStore();
        await s.loadChangesPatch("a", "C:/src/demo", "");
        const p = s.globalStore.get(s.changesPatchAtom);
        expect(p?.agentId).toBe("a");
        expect(p?.files?.map((f) => f.path)).toEqual(["a.ts"]);
        expect(p?.truncated).toBe(true);
        expect(p?.failure).toBeUndefined();
    });

    // an empty or wholly cut patch has no file, which must read as read, not as still pending
    it("reads an empty patch as no files rather than pending", async () => {
        gitPatch.mockResolvedValue(reply("", true));
        const s = await freshStore();
        await s.loadChangesPatch("a", "C:/src/demo", "");
        expect(s.globalStore.get(s.changesPatchAtom)?.files).toEqual([]);
    });

    it("drops a reply that a later read overtook", async () => {
        const first = deferred<ReturnType<typeof reply>>();
        gitPatch.mockReturnValueOnce(first.promise).mockResolvedValueOnce(reply(modified("new.ts", hunk(1, "y"))));
        const s = await freshStore();
        const slow = s.loadChangesPatch("a", "C:/src/demo", "");
        await s.loadChangesPatch("a", "C:/src/demo", "");
        first.resolve(reply(modified("old.ts", hunk(1, "x"))));
        await slow;
        expect(s.globalStore.get(s.changesPatchAtom)?.files?.map((f) => f.path)).toEqual(["new.ts"]);
    });

    it("keeps the same agent's rows until the re-read lands, and blanks another agent's", async () => {
        gitPatch.mockResolvedValueOnce(reply(modified("a.ts", hunk(1, "x"))));
        const s = await freshStore();
        await s.loadChangesPatch("a", "C:/src/demo", "");
        const pending = deferred<ReturnType<typeof reply>>();
        gitPatch.mockReturnValue(pending.promise);
        const reread = s.loadChangesPatch("a", "C:/src/demo", "");
        expect(s.globalStore.get(s.changesPatchAtom)?.files?.map((f) => f.path)).toEqual(["a.ts"]);
        const other = s.loadChangesPatch("b", "C:/src/other", "");
        expect(s.globalStore.get(s.changesPatchAtom)).toMatchObject({ agentId: "b", files: null });
        pending.resolve(reply(""));
        await Promise.all([reread, other]);
    });

    it("blanks on clear and drops a reply in flight", async () => {
        const pending = deferred<ReturnType<typeof reply>>();
        gitPatch.mockReturnValue(pending.promise);
        const s = await freshStore();
        const read = s.loadChangesPatch("a", "C:/src/demo", "");
        s.clearChangesPatch();
        pending.resolve(reply(modified("a.ts", hunk(1, "x"))));
        await read;
        expect(s.globalStore.get(s.changesPatchAtom)).toBeNull();
    });

    it("records a failed read's message, and a later read clears it", async () => {
        gitPatch.mockRejectedValueOnce(new Error("git diff: exit status 128")).mockResolvedValueOnce(reply(""));
        const s = await freshStore();
        await s.loadChangesPatch("a", "C:/src/demo", "");
        expect(s.globalStore.get(s.changesPatchAtom)).toMatchObject({
            agentId: "a",
            files: null,
            failure: "git diff: exit status 128",
        });
        await s.loadChangesPatch("a", "C:/src/demo", "");
        expect(s.globalStore.get(s.changesPatchAtom)?.failure).toBeUndefined();
    });
});

describe("stepping the change counter", () => {
    // display order: the root file a.ts (2 hunks), then lib/n.ts, a new file that starts closed (1 hunk)
    async function loaded() {
        gitPatch.mockResolvedValue(
            reply(
                [
                    modified("a.ts", hunk(3, "x"), hunk(40, "y")),
                    "diff --git a/lib/n.ts b/lib/n.ts",
                    "new file mode 100644",
                    "--- /dev/null",
                    "+++ b/lib/n.ts",
                    "@@ -0,0 +1,1 @@",
                    "+fresh",
                ].join("\n")
            )
        );
        const s = await freshStore();
        s.globalStore.set(s.railStateAtom, rail([change("lib/n.ts", "?"), change("a.ts")]));
        await s.loadChangesPatch("a", "C:/src/demo", "abc");
        return s;
    }

    it("declines with no hunks to walk", async () => {
        const s = await freshStore();
        s.globalStore.set(s.railStateAtom, rail([change("a.ts")]));
        expect(s.stepChangesHunk("a", "next")).toBe(false);
        expect(s.globalStore.get(s.changesAtAtom("a"))).toBe(0);
    });

    it("declines while another agent's patch is the one loaded", async () => {
        const s = await loaded();
        expect(s.stepChangesHunk("b", "next")).toBe(false);
    });

    it("moves the agent's counter and asks for its hunk to scroll into view", async () => {
        const s = await loaded();
        expect(s.stepChangesHunk("a", "next")).toBe(true);
        expect(s.globalStore.get(s.changesAtAtom("a"))).toBe(1);
        expect(s.globalStore.get(s.changesScrollAtom("a"))).toMatchObject({ path: "a.ts", hunk: 0 });
        s.stepChangesHunk("a", "next");
        expect(s.globalStore.get(s.changesScrollAtom("a"))).toMatchObject({ path: "a.ts", hunk: 1 });
        expect(s.globalStore.get(s.changesAtAtom("b"))).toBe(0);
    });

    it("wraps from none yet to the last on previous", async () => {
        const s = await loaded();
        s.stepChangesHunk("a", "previous");
        expect(s.globalStore.get(s.changesAtAtom("a"))).toBe(3);
        expect(s.globalStore.get(s.changesScrollAtom("a"))).toMatchObject({ path: "lib/n.ts", hunk: 0 });
    });

    it("opens a closed file it lands in, and leaves an open one open", async () => {
        const s = await loaded();
        s.stepChangesHunk("a", "previous");
        expect(s.isChangesFileOpen("a", "lib/n.ts", true)).toBe(true);
        s.stepChangesHunk("a", "next");
        expect(s.isChangesFileOpen("a", "a.ts", false)).toBe(true);
    });

    it("asks for a fresh scroll each step, even to the same hunk", async () => {
        gitPatch.mockResolvedValue(reply(modified("a.ts", hunk(3, "x"))));
        const s = await freshStore();
        s.globalStore.set(s.railStateAtom, rail([change("a.ts")]));
        await s.loadChangesPatch("a", "C:/src/demo", "abc");
        s.stepChangesHunk("a", "next");
        const first = s.globalStore.get(s.changesScrollAtom("a"));
        s.stepChangesHunk("a", "next");
        expect(s.globalStore.get(s.changesScrollAtom("a"))).not.toBe(first);
    });
});

describe("a file's open state", () => {
    it("toggles per agent", async () => {
        const s = await freshStore();
        expect(s.isChangesFileOpen("a", "x.ts", false)).toBe(true);
        s.toggleChangesFile("a", "x.ts");
        expect(s.isChangesFileOpen("a", "x.ts", false)).toBe(false);
        expect(s.isChangesFileOpen("b", "x.ts", false)).toBe(true);
        s.toggleChangesFile("a", "x.ts");
        expect(s.isChangesFileOpen("a", "x.ts", false)).toBe(true);
    });

    it("opens a file whether it is new or not", async () => {
        const s = await freshStore();
        s.openChangesFile("a", "n.ts", true);
        expect(s.isChangesFileOpen("a", "n.ts", true)).toBe(true);
        s.toggleChangesFile("a", "m.ts");
        s.openChangesFile("a", "m.ts", false);
        expect(s.isChangesFileOpen("a", "m.ts", false)).toBe(true);
    });
});
