// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { ERROR_TOAST_TTL_MS } from "@/app/cockpit/toaststack";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUndoQueue, UNDO_WINDOW_MS, type BriefToast } from "./briefundo";

function harness() {
    const state = { hidden: new Set<string>(), toast: null as BriefToast | null };
    const q = createUndoQueue({
        setHidden: (k) => (state.hidden = k),
        setToast: (t) => (state.toast = t),
        windowMs: 5000,
    });
    return { q, state };
}

describe("createUndoQueue", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("hides at once and commits only after the window", async () => {
        const { q, state } = harness();
        const commit = vi.fn(async () => {});
        q.schedule(["chunk:e:a"], "Deleted “a”", commit);
        expect(state.hidden.has("chunk:e:a")).toBe(true);
        expect(state.toast?.pendingUndo?.undo).toBeTypeOf("function");
        await vi.advanceTimersByTimeAsync(4999);
        expect(commit).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(commit).toHaveBeenCalledOnce();
        expect(state.hidden.size).toBe(0);
    });

    it("undo cancels the commit and unhides", async () => {
        const { q, state } = harness();
        const commit = vi.fn(async () => {});
        q.schedule(["chunk:e:a"], "Deleted", commit);
        state.toast?.pendingUndo?.undo();
        await vi.advanceTimersByTimeAsync(6000);
        expect(commit).not.toHaveBeenCalled();
        expect(state.hidden.size).toBe(0);
        expect(state.toast).toBeNull();
    });

    it("a second delete inside the window takes the toast, and the first still commits", async () => {
        const { q, state } = harness();
        const first = vi.fn(async () => {});
        const second = vi.fn(async () => {});
        q.schedule(["a"], "first", first);
        await vi.advanceTimersByTimeAsync(1000);
        q.schedule(["b"], "second", second);
        expect(state.toast?.text).toBe("second");
        expect([...state.hidden].sort()).toEqual(["a", "b"]);
        await vi.advanceTimersByTimeAsync(4000);
        expect(first).toHaveBeenCalledOnce();
        expect(second).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1000);
        expect(second).toHaveBeenCalledOnce();
    });

    it("flushAll commits everything pending now", async () => {
        const { q, state } = harness();
        const commit = vi.fn(async () => {});
        q.schedule(["a"], "x", commit);
        await q.flushAll();
        expect(commit).toHaveBeenCalledOnce();
        expect(state.hidden.size).toBe(0);
        await vi.advanceTimersByTimeAsync(6000);
        expect(commit).toHaveBeenCalledOnce();
    });

    it("a failed commit unhides the item and shows the error", async () => {
        const { q, state } = harness();
        q.schedule(["a"], "x", async () => {
            throw new Error("EC-LAST-CHUNK: cannot remove the last chunk");
        });
        await vi.advanceTimersByTimeAsync(5000);
        expect(state.hidden.size).toBe(0);
        expect(state.toast?.error).toBe(true);
        expect(state.toast?.text).toContain("EC-LAST-CHUNK");
    });

    it("notify's undo runs the inverse and clears the toast", () => {
        const { q, state } = harness();
        const inverse = vi.fn();
        q.notify("Archived", inverse);
        state.toast?.undo?.();
        expect(inverse).toHaveBeenCalledOnce();
        expect(state.toast).toBeNull();
    });

    it("the toast clears itself after the window", async () => {
        const { q, state } = harness();
        q.notify("Moved");
        await vi.advanceTimersByTimeAsync(5000);
        expect(state.toast).toBeNull();
    });

    it("waits the default window when none is given", async () => {
        const state = { toast: null as BriefToast | null };
        const q = createUndoQueue({ setHidden: () => {}, setToast: (t) => (state.toast = t) });
        const commit = vi.fn(async () => {});
        q.schedule(["a"], "x", commit);
        await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS - 1);
        expect(commit).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(commit).toHaveBeenCalledOnce();
    });

    it("waits the window it is given", async () => {
        const q = createUndoQueue({ setHidden: () => {}, setToast: () => {}, windowMs: 1000 });
        const commit = vi.fn(async () => {});
        q.schedule(["a"], "x", commit);
        await vi.advanceTimersByTimeAsync(999);
        expect(commit).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(commit).toHaveBeenCalledOnce();
    });

    it("numbers each toast one past the last", () => {
        const { q, state } = harness();
        q.notify("one");
        const first = state.toast?.id;
        q.notify("two");
        expect([first, state.toast?.id]).toEqual([1, 2]);
    });

    it("a notify with no undo carries none", () => {
        const { q, state } = harness();
        q.notify("Moved");
        expect(state.toast?.undo).toBeUndefined();
    });

    it("an undo pressed after its delete already committed does nothing but clear the toast", async () => {
        const { q, state } = harness();
        const commit = vi.fn(async () => {});
        q.schedule(["a"], "x", commit);
        const undo = state.toast?.pendingUndo?.undo;
        await q.flushAll();
        expect(() => undo?.()).not.toThrow();
        expect(commit).toHaveBeenCalledOnce();
        expect(state.toast).toBeNull();
    });

    it("an error shown while a delete is pending carries its Undo, which cancels the commit", async () => {
        const { q, state } = harness();
        const commit = vi.fn(async () => {});
        q.schedule(["a"], "Deleted", commit);
        q.error("db locked");
        expect(state.toast?.error).toBe(true);
        expect(state.toast?.pendingUndo?.count).toBe(1);
        state.toast?.pendingUndo?.undo();
        await vi.advanceTimersByTimeAsync(6000);
        expect(commit).not.toHaveBeenCalled();
        expect(state.hidden.size).toBe(0);
        expect(state.toast).toBeNull();
    });

    it("a reversible edit over two pending deletes shows its own undo and Undo 2", () => {
        const { q, state } = harness();
        q.schedule(["a"], "first", async () => {});
        q.schedule(["b"], "second", async () => {});
        q.notify("Archived", () => {});
        expect(state.toast?.undo).toBeTypeOf("function");
        expect(state.toast?.pendingUndo?.count).toBe(2);
    });

    it("the pending Undo on an error cancels every pending delete", async () => {
        const { q, state } = harness();
        const first = vi.fn(async () => {});
        const second = vi.fn(async () => {});
        q.schedule(["a"], "first", first);
        q.schedule(["b"], "second", second);
        q.error("db locked");
        expect(state.toast?.pendingUndo?.count).toBe(2);
        state.toast?.pendingUndo?.undo();
        expect(state.toast).toBeNull();
        expect(state.hidden.size).toBe(0);
        await vi.advanceTimersByTimeAsync(6000);
        expect(first).not.toHaveBeenCalled();
        expect(second).not.toHaveBeenCalled();
    });

    it("own undo on a toast over a pending delete keeps the pending Undo up", () => {
        const { q, state } = harness();
        const inverse = vi.fn();
        q.schedule(["a"], "Deleted", async () => {});
        q.notify("Archived", inverse);
        state.toast?.undo?.();
        expect(inverse).toHaveBeenCalledOnce();
        expect(state.toast?.undo).toBeUndefined();
        expect(state.toast?.pendingUndo?.count).toBe(1);
    });

    it("a toast the inverse puts up keeps its own lifetime", () => {
        const { q, state } = harness();
        q.notify("Archived", () => q.error("db locked"));
        state.toast?.undo?.();
        expect(state.toast?.error).toBe(true);
        expect(state.toast?.text).toBe("db locked");
    });

    it("the count drops as pending deletes commit", async () => {
        const { q, state } = harness();
        q.schedule(["a"], "first", async () => {});
        await vi.advanceTimersByTimeAsync(4000);
        q.schedule(["b"], "second", async () => {});
        expect(state.toast?.pendingUndo?.count).toBe(2);
        await vi.advanceTimersByTimeAsync(1000);
        expect(state.toast?.pendingUndo?.count).toBe(1);
    });

    it("the toast clears only after the last pending delete commits", async () => {
        const { q, state } = harness();
        let land!: () => void;
        const commit = vi.fn(() => new Promise<void>((r) => (land = r)));
        q.schedule(["a"], "Deleted", commit);
        await vi.advanceTimersByTimeAsync(5000);
        expect(commit).toHaveBeenCalledOnce();
        // its own lifetime is over, but the delete has not landed
        await vi.advanceTimersByTimeAsync(3000);
        expect(state.toast?.text).toBe("Deleted");
        land();
        await vi.advanceTimersByTimeAsync(0);
        expect(state.toast).toBeNull();
    });

    it("an error toast lives the error lifetime", async () => {
        const { q, state } = harness();
        q.error("db locked");
        await vi.advanceTimersByTimeAsync(ERROR_TOAST_TTL_MS - 1);
        expect(state.toast?.error).toBe(true);
        await vi.advanceTimersByTimeAsync(1);
        expect(state.toast).toBeNull();
    });
});
