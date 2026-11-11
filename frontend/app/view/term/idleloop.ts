// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// startIdleLoop runs tick in an idle slot every delayMs until the returned stop runs. The pending timer and
// idle callback hold tick (and whatever it closes over), so a caller that never stops it leaks that forever.
export function startIdleLoop(tick: () => void, delayMs: number): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
        timer = setTimeout(() => {
            requestIdleCallback(() => {
                if (stopped) {
                    return;
                }
                tick();
                arm();
            });
        }, delayMs);
    };
    arm();
    return () => {
        stopped = true;
        clearTimeout(timer);
    };
}
