// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { afterEach, describe, expect, it, vi } from "vitest";

const fileAtRef = vi.fn();
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        GitFileAtRefCommand: (...a: any[]) => fileAtRef(...a),
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import { pairRefsFor } from "./diffcontent";
import {
    clearDiffPair,
    diffPairAtom,
    diffPairFailureAtom,
    loadDiffPair,
    MAX_DIFF_BYTES,
    retryDiffPair,
} from "./diffcontentstore";

// a ref read answers `committed`, the working-tree read answers `disk`
const byMode = (committed: any, disk: any) => (_c: any, d: any) => Promise.resolve(d.worktree ? disk : committed);

afterEach(() => {
    fileAtRef.mockReset();
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

    // a pure rename then reads the same text on both sides, rather than the whole file as added
    it("reads a renamed file's left side at its old path", async () => {
        fileAtRef.mockImplementation((_c: any, d: any) => Promise.resolve({ content: `${d.path} at ${d.ref}` }));
        await loadDiffPair("/repo", "src/new.ts", { kind: "commit", hash: "deadbee" }, "src/old.ts");
        expect(globalStore.get(diffPairAtom)).toMatchObject({
            path: "src/new.ts",
            original: "src/old.ts at deadbee^",
            modified: "src/new.ts at deadbee",
        });
    });

    // The working-tree side is the file on disk, not a ref — a git read of it would show the last
    // committed content and silently hide every uncommitted edit, which is the whole point of the row.
    it("reads the working-tree side from disk, not from git", async () => {
        fileAtRef.mockImplementation(byMode({ content: "committed\n" }, { content: "edited\n" }));
        await loadDiffPair("/repo", "src/x.ts", { kind: "worktree", anchorRef: "HEAD" });
        expect(globalStore.get(diffPairAtom)).toMatchObject({ original: "committed\n", modified: "edited\n" });
        expect(fileAtRef).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ worktree: true }));
    });

    it("reads a deleted working-tree file as an empty, missing right side rather than failing", async () => {
        fileAtRef.mockImplementation(byMode({ content: "was here\n" }, { content: "", missing: true }));
        await loadDiffPair("/repo", "gone.ts", { kind: "worktree", anchorRef: "HEAD" });
        expect(globalStore.get(diffPairAtom)).toMatchObject({
            original: "was here\n",
            modified: "",
            originalMissing: false,
            modifiedMissing: true,
        });
    });

    it("records the side a new file is missing from", async () => {
        fileAtRef.mockImplementation(byMode({ content: "", missing: true }, { content: "" }));
        await loadDiffPair("/repo", "empty.txt", { kind: "worktree", anchorRef: "HEAD" });
        expect(globalStore.get(diffPairAtom)).toMatchObject({ originalMissing: true, modifiedMissing: false });
    });

    // the disk read gets the same caps as a ref read, so an untracked lockfile or binary cannot freeze the pane
    it("reports an untracked binary or oversized file from the working-tree side", async () => {
        fileAtRef.mockImplementation(byMode({ content: "", missing: true }, { content: "", binary: true, size: 1024 }));
        await loadDiffPair("/repo", "blob.bin", { kind: "worktree", anchorRef: "HEAD" });
        expect(globalStore.get(diffPairAtom)).toMatchObject({ binary: true, tooLarge: false });

        fileAtRef.mockImplementation(
            byMode({ content: "", missing: true }, { content: "", toolarge: true, size: 3_000_000 })
        );
        await loadDiffPair("/repo", "big.log", { kind: "worktree", anchorRef: "HEAD" });
        expect(globalStore.get(diffPairAtom)).toMatchObject({ binary: false, tooLarge: true, size: 3_000_000 });
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

describe("what each side reports about itself", () => {
    it("reads the working-tree side by its path in the repository, capped like a ref read", async () => {
        fileAtRef.mockImplementation(byMode({ content: "committed\n" }, { content: "edited\n" }));
        await loadDiffPair("/repo", "src/x.ts", { kind: "worktree", anchorRef: "HEAD" });
        expect(fileAtRef).toHaveBeenCalledWith(expect.anything(), {
            cwd: "/repo",
            path: "src/x.ts",
            ref: "",
            worktree: true,
            maxbytes: MAX_DIFF_BYTES,
        });
    });

    it("is neither binary nor too large when neither side says so", async () => {
        fileAtRef.mockResolvedValue({ content: "text\n" });
        await loadDiffPair("/repo", "a.ts", { kind: "commit", hash: "aaa" });
        expect(globalStore.get(diffPairAtom)).toStrictEqual({
            path: "a.ts",
            original: "text\n",
            modified: "text\n",
            binary: false,
            tooLarge: false,
            size: 0,
            originalMissing: false,
            modifiedMissing: false,
            refs: pairRefsFor({ kind: "commit", hash: "aaa" }),
        });
    });

    it("carries the refs it was read from", async () => {
        fileAtRef.mockImplementation(byMode({ content: "x\n" }, { content: "y\n" }));
        const worktree = { kind: "worktree", anchorRef: "main" } as const;
        await loadDiffPair("/repo", "a.ts", worktree);
        expect(globalStore.get(diffPairAtom)?.refs).toEqual(pairRefsFor(worktree));
        const compare = { kind: "compare", base: "main", head: "feature", mergeBase: "m1", form: "mergebase" } as const;
        await loadDiffPair("/repo", "a.ts", compare);
        expect(globalStore.get(diffPairAtom)?.refs).toEqual(pairRefsFor(compare));
    });

    it("is binary when git has no text for the sides", async () => {
        fileAtRef.mockResolvedValue({ content: "", binary: true });
        await loadDiffPair("/repo", "logo.png", { kind: "commit", hash: "aaa" });
        expect(globalStore.get(diffPairAtom)).toMatchObject({ binary: true, tooLarge: false });
    });

    it("is too large when both sides exceed the cap", async () => {
        fileAtRef.mockResolvedValue({ content: "", toolarge: true, size: 3_000_000 });
        await loadDiffPair("/repo", "lock.json", { kind: "commit", hash: "aaa" });
        expect(globalStore.get(diffPairAtom)).toMatchObject({ binary: false, tooLarge: true, size: 3_000_000 });
    });
});

describe("refreshing the pair already on screen", () => {
    // The change poll replaces the working-tree state every few seconds, and the surface re-reads the
    // open file with it. Blanking the atom first would flash the skeleton on every tick.
    it("keeps the current content on screen while re-reading the same file", async () => {
        fileAtRef.mockImplementation(byMode({ content: "v1\n" }, { content: "v1 edited\n" }));
        await loadDiffPair("/repo", "a.ts", { kind: "worktree", anchorRef: "HEAD" });

        fileAtRef.mockImplementation(byMode({ content: "v1\n" }, { content: "v2 edited\n" }));
        const pending = loadDiffPair("/repo", "a.ts", { kind: "worktree", anchorRef: "HEAD" });
        expect(globalStore.get(diffPairAtom)?.modified).toBe("v1 edited\n");
        await pending;
        expect(globalStore.get(diffPairAtom)?.modified).toBe("v2 edited\n");
    });
});

describe("a read that fails", () => {
    it("says why instead of leaving the skeleton up, and keeps the pair empty", async () => {
        fileAtRef.mockRejectedValue(new Error("read src/x.ts: is a directory"));
        await loadDiffPair("/repo", "src/x.ts", { kind: "worktree", anchorRef: "HEAD" });
        expect(globalStore.get(diffPairAtom)).toBeNull();
        expect(globalStore.get(diffPairFailureAtom)).toBe("read src/x.ts: is a directory");
    });

    it("re-reads the same file on retry and clears the failure once it reads", async () => {
        fileAtRef.mockRejectedValue(new Error("boom"));
        await loadDiffPair("/repo", "src/x.ts", { kind: "worktree", anchorRef: "HEAD" });
        expect(globalStore.get(diffPairFailureAtom)).toBe("boom");

        fileAtRef.mockReset();
        fileAtRef.mockImplementation(byMode({ content: "a\n" }, { content: "b\n" }));
        await retryDiffPair();
        expect(globalStore.get(diffPairFailureAtom)).toBeNull();
        expect(globalStore.get(diffPairAtom)).toMatchObject({ path: "src/x.ts", original: "a\n", modified: "b\n" });
        expect(fileAtRef).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ path: "src/x.ts", worktree: true })
        );
    });

    it("forgets the failure when the selection moves to another file", async () => {
        fileAtRef.mockRejectedValue(new Error("boom"));
        await loadDiffPair("/repo", "a.ts", { kind: "commit", hash: "aaa" });
        fileAtRef.mockReset();
        const releases: ((v: any) => void)[] = [];
        fileAtRef.mockImplementation(() => new Promise((res) => releases.push(res)));
        const pending = loadDiffPair("/repo", "b.ts", { kind: "commit", hash: "aaa" });
        expect(globalStore.get(diffPairFailureAtom)).toBeNull();
        releases.forEach((r) => r({ content: "x\n" }));
        await pending;
    });

    it("is cleared with the pair", async () => {
        fileAtRef.mockRejectedValue(new Error("boom"));
        await loadDiffPair("/repo", "a.ts", { kind: "commit", hash: "aaa" });
        clearDiffPair();
        expect(globalStore.get(diffPairFailureAtom)).toBeNull();
    });

    it("does nothing on retry when nothing was loaded", async () => {
        await retryDiffPair();
        expect(fileAtRef).not.toHaveBeenCalled();
    });
});
