// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { afterEach, describe, expect, it, vi } from "vitest";

const fileAtRef = vi.fn();
const fileRead = vi.fn();
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        GitFileAtRefCommand: (...a: any[]) => fileAtRef(...a),
        FileReadCommand: (...a: any[]) => fileRead(...a),
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import { clearDiffPair, diffPairAtom, loadDiffPair, MAX_DIFF_BYTES } from "./diffcontentstore";

const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64");

afterEach(() => {
    fileAtRef.mockReset();
    fileRead.mockReset();
    clearDiffPair();
});

describe("loading both sides of a diff", () => {
    it("reads a commit against its first parent", async () => {
        fileAtRef.mockImplementation((_c: any, d: any) => Promise.resolve({ content: `at ${d.ref}` }));
        await loadDiffPair("/repo", "src/x.ts", { kind: "commit", hash: "deadbee" });
        expect(globalStore.get(diffPairAtom)).toMatchObject({
            path: "src/x.ts",
            original: "at deadbee^",
            modified: "at deadbee",
        });
    });

    // The working-tree side is the file on disk, not a ref — a git read of it would show the last
    // committed content and silently hide every uncommitted edit, which is the whole point of the row.
    it("reads the working-tree side from disk, not from git", async () => {
        fileAtRef.mockResolvedValue({ content: "committed\n" });
        fileRead.mockResolvedValue({ data64: b64("edited\n") });
        await loadDiffPair("/repo", "src/x.ts", { kind: "worktree", anchorRef: "HEAD" });
        expect(globalStore.get(diffPairAtom)).toMatchObject({ original: "committed\n", modified: "edited\n" });
        expect(fileRead).toHaveBeenCalledTimes(1);
    });

    it("reads a deleted working-tree file as an empty right side rather than failing", async () => {
        fileAtRef.mockResolvedValue({ content: "was here\n" });
        fileRead.mockRejectedValue(new Error("ENOENT"));
        await loadDiffPair("/repo", "gone.ts", { kind: "worktree", anchorRef: "HEAD" });
        expect(globalStore.get(diffPairAtom)).toMatchObject({ original: "was here\n", modified: "" });
    });

    it("caps both sides and reports the larger one", async () => {
        fileAtRef.mockImplementation((_c: any, d: any) =>
            Promise.resolve(d.ref === "main" ? { content: "", toolarge: true, size: 9_000_000 } : { content: "ok\n" })
        );
        await loadDiffPair("/repo", "lock.json", {
            kind: "compare",
            base: "main",
            head: "feature",
            mergeBase: "",
            form: "tips",
        });
        expect(globalStore.get(diffPairAtom)).toMatchObject({ tooLarge: true, size: 9_000_000 });
        expect(fileAtRef).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ maxbytes: MAX_DIFF_BYTES })
        );
    });

    // Clicking a second file while the first is still in flight: the slow answer must not overwrite
    // the fast one, or the pane ends up showing a file the list no longer has selected.
    it("drops a read the selection has moved past", async () => {
        let releaseFirst: (v: any) => void = () => {};
        fileAtRef.mockImplementationOnce(() => new Promise((res) => (releaseFirst = res)));
        fileAtRef.mockImplementation(() => Promise.resolve({ content: "second\n" }));

        const slow = loadDiffPair("/repo", "first.ts", { kind: "commit", hash: "aaa" });
        await loadDiffPair("/repo", "second.ts", { kind: "commit", hash: "bbb" });
        releaseFirst({ content: "first\n" });
        await slow;

        expect(globalStore.get(diffPairAtom)?.path).toBe("second.ts");
    });

    it("clears the pane while a new pair is loading, so a stale diff is never on screen", async () => {
        fileAtRef.mockResolvedValue({ content: "x\n" });
        await loadDiffPair("/repo", "a.ts", { kind: "commit", hash: "aaa" });
        expect(globalStore.get(diffPairAtom)).not.toBeNull();
        const pending = loadDiffPair("/repo", "b.ts", { kind: "commit", hash: "bbb" });
        expect(globalStore.get(diffPairAtom)).toBeNull();
        await pending;
    });
});

describe("refreshing the pair already on screen", () => {
    // The change poll replaces the working-tree state every few seconds, and the surface re-reads the
    // open file with it. Blanking the atom first would flash the skeleton on every tick.
    it("keeps the current content on screen while re-reading the same file", async () => {
        fileAtRef.mockResolvedValue({ content: "v1\n" });
        fileRead.mockResolvedValue({ data64: b64("v1 edited\n") });
        await loadDiffPair("/repo", "a.ts", { kind: "worktree", anchorRef: "HEAD" });

        fileRead.mockResolvedValue({ data64: b64("v2 edited\n") });
        const pending = loadDiffPair("/repo", "a.ts", { kind: "worktree", anchorRef: "HEAD" });
        expect(globalStore.get(diffPairAtom)?.modified).toBe("v1 edited\n");
        await pending;
        expect(globalStore.get(diffPairAtom)?.modified).toBe("v2 edited\n");
    });
});
