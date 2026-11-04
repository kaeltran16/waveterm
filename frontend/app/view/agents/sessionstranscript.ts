// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure rules for reading a session's transcript in the Sessions detail: how much of the file to fetch, whether
// earlier turns may be cut off, the live refresh and when the body follows new lines. No React.

// the recent window a transcript read tails
export const TAIL_LINES = 2000;
// grouped timeline items kept in the DOM; off-screen history above them is dropped
export const TIMELINE_RENDER_CAP = 200;
// a live session's transcript is read again this often while it is shown
export const LIVE_REFRESH_MS = 5000;
// a reader this close to the bottom is following the end
const STICK_PX = 40;

// pi's parent-linked active branch needs the complete file, and so does a read that must reach the first turn
export function transcriptMaxLines(runtime: string, full: boolean): number {
    return runtime === "pi" || full ? -1 : TAIL_LINES;
}

// the tail came back full, so the file may hold more, or the timeline drops items over its cap
export function mayHaveEarlier(fetched: number, maxlines: number, items: number, full: boolean): boolean {
    if (full) {
        return false;
    }
    return (maxlines > 0 && fetched >= maxlines) || items > TIMELINE_RENDER_CAP;
}

export function shouldStick(scrollTop: number, scrollHeight: number, clientHeight: number): boolean {
    return scrollHeight - scrollTop - clientHeight <= STICK_PX;
}
