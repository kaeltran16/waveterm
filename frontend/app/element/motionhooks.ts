// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from "react";

// Completion settle (moment 4): returns true for one ~520ms shot when `done` flips false→true, so a
// caller can play `@keyframes settle` once. Mounting already-done does not fire (only a transition does).
export function useSettle(done: boolean): boolean {
    const [settling, setSettling] = useState(false);
    const prevDone = useRef(done);
    useEffect(() => {
        if (done && !prevDone.current) {
            setSettling(true);
            const t = setTimeout(() => setSettling(false), 520);
            prevDone.current = done;
            return () => clearTimeout(t);
        }
        prevDone.current = done;
    }, [done]);
    return settling;
}

// One-shot edge latch (moment 1 load reveal): returns true from the render where `flag` is first
// observed to go false→true within this mount, false while mounted already-true. Computed during
// render (not in an effect) so a wrapper that mounts on the same render the flag flips sees true
// immediately. Because usage data is cached in jotai, a tab re-entry mounts already-true and the
// reveal is correctly suppressed. See docs/superpowers/specs/2026-07-04-usage-motion-design.md.
export function useDidBecomeTrue(flag: boolean): boolean {
    const prev = useRef(flag);
    const became = useRef(false);
    if (flag && !prev.current) became.current = true;
    prev.current = flag;
    return became.current;
}
