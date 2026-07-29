// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCommitScheduler, CURSOR_COMMIT_MS } from "./subjectcursor";

describe("createCommitScheduler", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("does not commit before the idle window elapses", () => {
        const commit = vi.fn();
        createCommitScheduler(commit).schedule("channel:a");
        vi.advanceTimersByTime(CURSOR_COMMIT_MS - 1);
        expect(commit).not.toHaveBeenCalled();
    });

    it("commits once for a burst, with the last id", () => {
        const commit = vi.fn();
        const s = createCommitScheduler(commit);
        s.schedule("channel:a");
        s.schedule("channel:b");
        s.schedule("dossier:c");
        vi.advanceTimersByTime(CURSOR_COMMIT_MS);
        expect(commit).toHaveBeenCalledTimes(1);
        expect(commit).toHaveBeenCalledWith("dossier:c");
    });

    it("commits each deliberate move separately", () => {
        const commit = vi.fn();
        const s = createCommitScheduler(commit);
        s.schedule("channel:a");
        vi.advanceTimersByTime(CURSOR_COMMIT_MS);
        s.schedule("channel:b");
        vi.advanceTimersByTime(CURSOR_COMMIT_MS);
        expect(commit.mock.calls).toEqual([["channel:a"], ["channel:b"]]);
    });

    it("flush commits immediately and only once", () => {
        const commit = vi.fn();
        const s = createCommitScheduler(commit);
        s.schedule("channel:a");
        s.flush();
        expect(commit).toHaveBeenCalledWith("channel:a");
        vi.advanceTimersByTime(CURSOR_COMMIT_MS * 2);
        expect(commit).toHaveBeenCalledTimes(1);
    });

    it("flush with nothing pending does nothing", () => {
        const commit = vi.fn();
        createCommitScheduler(commit).flush();
        expect(commit).not.toHaveBeenCalled();
    });

    it("cancel drops the pending commit", () => {
        const commit = vi.fn();
        const s = createCommitScheduler(commit);
        s.schedule("channel:a");
        s.cancel();
        vi.advanceTimersByTime(CURSOR_COMMIT_MS * 2);
        expect(commit).not.toHaveBeenCalled();
    });
});
