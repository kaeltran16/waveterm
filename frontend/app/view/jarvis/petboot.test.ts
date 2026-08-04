// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { BOOT_RETRY_DELAYS, readUntilLanded } from "./petboot";

// injected so the test never waits; the recorded delays are the assertion about backoff
function recorder() {
    const slept: number[] = [];
    return { slept, sleep: async (ms: number) => void slept.push(ms) };
}

describe("readUntilLanded", () => {
    it("reads once when the first attempt lands", async () => {
        const { slept, sleep } = recorder();
        let calls = 0;
        const ok = await readUntilLanded({
            read: async () => {
                calls++;
                return true;
            },
            sleep,
        });
        expect(ok).toBe(true);
        expect(calls).toBe(1);
        expect(slept).toEqual([]); // no delay on the happy path, so boot is not slowed by the retry
    });

    it("retries until a read lands, backing off between attempts", async () => {
        const { slept, sleep } = recorder();
        let calls = 0;
        const ok = await readUntilLanded({
            read: async () => ++calls === 3,
            delays: [10, 20, 30],
            sleep,
        });
        expect(ok).toBe(true);
        expect(calls).toBe(3);
        expect(slept).toEqual([10, 20]); // one delay per failure, none after the success
    });

    // the point of the whole module: a read that never lands must report that it never landed, so the
    // caller leaves the signal absent rather than presenting a default as a reading.
    it("gives up after the delays are exhausted and says so", async () => {
        const { slept, sleep } = recorder();
        let calls = 0;
        const ok = await readUntilLanded({
            read: async () => {
                calls++;
                return false;
            },
            delays: [1, 2],
            sleep,
        });
        expect(ok).toBe(false);
        expect(calls).toBe(3); // one immediate attempt plus one per delay
        expect(slept).toEqual([1, 2]);
    });

    it("stops when the caller unmounts mid-backoff instead of resuming against a dead component", async () => {
        const { sleep } = recorder();
        let calls = 0;
        let mounted = true;
        const ok = await readUntilLanded({
            read: async () => {
                calls++;
                mounted = false;
                return false;
            },
            live: () => mounted,
            delays: [1, 2, 3],
            sleep,
        });
        expect(ok).toBe(false);
        expect(calls).toBe(1);
    });

    it("never runs a read at all if the caller is already gone", async () => {
        let calls = 0;
        const ok = await readUntilLanded({
            read: async () => {
                calls++;
                return true;
            },
            live: () => false,
        });
        expect(ok).toBe(false);
        expect(calls).toBe(0);
    });

    it("backs off monotonically and stays bounded", async () => {
        expect(BOOT_RETRY_DELAYS.length).toBeGreaterThan(2);
        for (let i = 1; i < BOOT_RETRY_DELAYS.length; i++) {
            expect(BOOT_RETRY_DELAYS[i]).toBeGreaterThan(BOOT_RETRY_DELAYS[i - 1]);
        }
        // the whole ladder must be shorter than the slow cadence it precedes (index status, 15 min), or a
        // still-retrying boot read would collide with the steady-state poll.
        const total = BOOT_RETRY_DELAYS.reduce((a, b) => a + b, 0);
        expect(total).toBeLessThan(15 * 60_000);
    });
});
