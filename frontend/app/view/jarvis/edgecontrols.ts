// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Which correction controls one edge gets. Pure, so the band and the record thread cannot disagree about
// the same edge — they draw it from opposite ends.

export interface EdgeControls {
    confirm: boolean;
    detach: boolean;
    restore: boolean;
    // a confirmed edge is a dispatch reference the worker itself wrote: detaching it overrides the machine
    // rather than correcting a guess, so it asks first.
    confirmFirst: boolean;
}

export function edgeControls(state: string): EdgeControls {
    if (state === "detached") {
        return { confirm: false, detach: false, restore: true, confirmFirst: false };
    }
    if (state === "informing") {
        return { confirm: true, detach: true, restore: false, confirmFirst: false };
    }
    // confirmed, and anything unrecognised: offering Confirm would be a no-op, and an unknown state must
    // not get the cheaper of the two detach paths.
    return { confirm: false, detach: true, restore: false, confirmFirst: true };
}
