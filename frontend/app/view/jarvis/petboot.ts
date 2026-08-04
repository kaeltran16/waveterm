// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// A read that must land exactly once, retried until it does.
//
// Why this exists: the pet's three backend registers read on deliberately slow cadences — the index status
// every 15 minutes (the handler reopens the index and walks the whole vault), the vault decay queue every 10
// minutes (memgarden's sweep is hourly), and the launch narrative once ever (it is a durable DB row). That
// makes them the opposite of AttentionPoller, whose comment states the property they lack: "a missed poll
// self-heals on the next tick".
//
// Without a retry, a single failed read at mount leaves the creature claiming health — at-rest, and a peek
// that says "not read yet" and "clear" — for fifteen minutes or for the whole session. That is precisely the
// silent degradation the rank-1 condition exists to expose, reintroduced by the plumbing underneath it.
//
// So: fast retries until the first success, then the caller settles onto its slow cadence. The delays back
// off because a backend that is not answering yet is usually a few hundred ms from answering, and a backend
// that is genuinely down should not be hammered.

export const BOOT_RETRY_DELAYS: readonly number[] = [400, 1200, 3000, 8000, 20000];

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface ReadUntilLandedOpts {
    // true means the read landed; false means try again. Must not throw — a loader that throws is a loader
    // that has not decided whether it failed, and this helper will not decide for it.
    read: () => Promise<boolean>;
    // false once the caller has unmounted, so a pending backoff does not resume against a dead component
    live?: () => boolean;
    delays?: readonly number[];
    sleep?: (ms: number) => Promise<void>;
}

// Resolves true on the first successful read, false once the delays are exhausted or the caller went away.
// Attempts are delays.length + 1: one immediate, then one per delay.
export async function readUntilLanded(opts: ReadUntilLandedOpts): Promise<boolean> {
    const delays = opts.delays ?? BOOT_RETRY_DELAYS;
    const sleep = opts.sleep ?? realSleep;
    const live = opts.live ?? (() => true);
    for (let attempt = 0; ; attempt++) {
        if (!live()) {
            return false;
        }
        if (await opts.read()) {
            return true;
        }
        if (attempt >= delays.length) {
            return false;
        }
        await sleep(delays[attempt]);
    }
}
