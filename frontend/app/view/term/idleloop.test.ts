// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startIdleLoop } from "./idleloop";

describe("startIdleLoop", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.stubGlobal("requestIdleCallback", (cb: () => void) => setTimeout(cb, 0));
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it("ticks every interval until stopped, then leaves no timer armed", () => {
        const tick = vi.fn();
        const stop = startIdleLoop(tick, 5000);
        vi.advanceTimersByTime(5001);
        vi.advanceTimersByTime(5001);
        expect(tick).toHaveBeenCalledTimes(2);
        stop();
        vi.advanceTimersByTime(60_000);
        expect(tick).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("drops a tick already queued for an idle slot when stopped", () => {
        const tick = vi.fn();
        const stop = startIdleLoop(tick, 5000);
        vi.advanceTimersByTime(4999);
        vi.advanceTimersByTime(1); // the timer fired; the idle callback is queued
        stop();
        vi.runAllTimers();
        expect(tick).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });
});
