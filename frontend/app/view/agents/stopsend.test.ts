// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PI_STOP_SETTLE_MS, sendsQueuedOnStop, stopAndSend } from "./stopsend";

describe("sendsQueuedOnStop", () => {
    it("only a pi agent with a non-empty foot sends its queue on Stop", () => {
        expect(sendsQueuedOnStop("pi", 1)).toBe(true);
        expect(sendsQueuedOnStop("pi", 0)).toBe(false);
        expect(sendsQueuedOnStop("claude", 2)).toBe(false);
        expect(sendsQueuedOnStop(undefined, 2)).toBe(false);
    });
});

describe("stopAndSend", () => {
    let typed: string[];
    let warned: number;
    let idle: (() => void) | null;
    let unsubscribed: number;
    const io = () => ({
        type: (data: string) => typed.push(data),
        onIdle: (cb: () => void) => {
            idle = cb;
            return () => {
                idle = null;
                unsubscribed++;
            };
        },
        warn: () => warned++,
    });

    beforeEach(() => {
        vi.useFakeTimers();
        typed = [];
        warned = 0;
        idle = null;
        unsubscribed = 0;
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("types Esc at once and Enter once after the next idle report", () => {
        stopAndSend(io());
        expect(typed).toEqual(["\x1b"]);
        idle!();
        expect(typed).toEqual(["\x1b", "\r"]);
        expect(unsubscribed).toBe(1);
        vi.advanceTimersByTime(PI_STOP_SETTLE_MS * 2);
        expect(typed).toEqual(["\x1b", "\r"]);
        expect(warned).toBe(0);
    });

    it("a second idle report types nothing more", () => {
        const capture = io();
        let cb: (() => void) | null = null;
        stopAndSend({ ...capture, onIdle: (f) => ((cb = f), () => unsubscribed++) });
        cb!();
        cb!();
        expect(typed).toEqual(["\x1b", "\r"]);
    });

    it("with no idle report within the settle time types nothing more and warns once", () => {
        stopAndSend(io());
        vi.advanceTimersByTime(PI_STOP_SETTLE_MS - 1);
        expect(warned).toBe(0);
        vi.advanceTimersByTime(1);
        expect(warned).toBe(1);
        expect(idle).toBeNull();
        expect(typed).toEqual(["\x1b"]);
    });

    it("cancelled, it neither presses Enter nor warns", () => {
        const cancel = stopAndSend(io());
        cancel();
        expect(idle).toBeNull();
        vi.advanceTimersByTime(PI_STOP_SETTLE_MS);
        expect(typed).toEqual(["\x1b"]);
        expect(warned).toBe(0);
    });
});
