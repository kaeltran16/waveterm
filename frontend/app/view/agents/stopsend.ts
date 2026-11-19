// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Stop and send now, for pi: pi's Esc aborts the turn and moves its queued steers back into its editor, unsent, so
// once the abort settles Enter submits them, keeping the queued foot's "Esc to stop and send now" true. Claude sends
// its own queue on Esc.

import { PI_HARNESS } from "./picommands";

// how long a stop waits for pi's idle report before leaving the steers in its editor
export const PI_STOP_SETTLE_MS = 10_000;

const ESC = "\x1b";
const ENTER = "\r";

export type StopSendIO = {
    // types into the agent's terminal
    type: (data: string) => void;
    // calls back on each idle state report of the agent's block; returns the unsubscribe
    onIdle: (cb: () => void) => () => void;
    // no idle report came in time
    warn: () => void;
};

// whether a Stop sends the agent's queue at once, rather than the bare Esc
export function sendsQueuedOnStop(harness: string | undefined, queued: number): boolean {
    return harness === PI_HARNESS && queued > 0;
}

// Types Esc, then Enter once on the next idle report; with none within PI_STOP_SETTLE_MS types nothing more and warns.
// Returns a cancel that drops the wait.
export function stopAndSend(io: StopSendIO): () => void {
    let open = true;
    // a no-op until subscribed, should the idle callback run inside onIdle
    let unsubscribe = () => {};
    // true for the first caller only: the idle report, the timeout or the cancel
    const close = (): boolean => {
        if (!open) {
            return false;
        }
        open = false;
        unsubscribe();
        clearTimeout(timer);
        return true;
    };
    io.type(ESC);
    const timer = setTimeout(() => {
        if (close()) {
            io.warn();
        }
    }, PI_STOP_SETTLE_MS);
    unsubscribe = io.onIdle(() => {
        if (close()) {
            io.type(ENTER);
        }
    });
    return () => {
        close();
    };
}
