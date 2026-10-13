// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { INITIAL_LINK, LINK_GRACE_MS, linkClosed, linkLostSince, linkOpened } from "./wslink";

const T = 1_000_000;

describe("wslink", () => {
    it("stands as lost only once the grace has passed", () => {
        const down = linkClosed(linkOpened(INITIAL_LINK), T);
        expect(LINK_GRACE_MS).toBe(3000);
        expect(linkLostSince(down, T + 2999)).toBeNull();
        expect(linkLostSince(down, T + 3000)).toBe(T);
    });

    it("keeps the first drop time through a failed retry", () => {
        const down = linkClosed(linkOpened(INITIAL_LINK), T);
        const retried = linkClosed(down, T + 5000);
        expect(retried.lostAt).toBe(T);
        expect(linkLostSince(retried, T + 6000)).toBe(T);
    });

    it("is never lost before the first connect", () => {
        const down = linkClosed(INITIAL_LINK, T);
        expect(linkLostSince(down, T)).toBeNull();
        expect(linkLostSince(down, T + 60_000)).toBeNull();
        expect(linkLostSince(linkClosed(down, T + 5000), T + 60_000)).toBeNull();
    });

    it("clears on reopen", () => {
        const back = linkOpened(linkClosed(linkOpened(INITIAL_LINK), T));
        expect(back).toEqual({ connected: true, everConnected: true, lostAt: null });
        expect(linkLostSince(back, T + 60_000)).toBeNull();
    });
});
