// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUndoQueue, type BriefToast } from "./briefundo";

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
        expect(state.toast?.undo).toBeTypeOf("function");
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
        state.toast?.undo?.();
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
});
