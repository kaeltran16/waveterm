// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Step 4 of the design's narrow-window collapse order. It lives with the nav rail rather than in
// jarvislayout.ts because the nav rail is global chrome shared by every surface — collapsing it from inside
// one surface would be the wrong layer. Jarvis needs no wiring for it: its own ResizeObserver just measures
// a wider surface once this fires.

export const NAV_NARROW_WINDOW_PX = 900;

export function navRailCollapsed(windowWidth: number): boolean {
    // a width of 0 is the unmeasured first frame, not the narrowest possible window
    return windowWidth > 0 && windowWidth < NAV_NARROW_WINDOW_PX;
}
