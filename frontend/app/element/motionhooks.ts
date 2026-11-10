// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from "react";
import { CHANGE_FLASH_MS } from "./motiontokens";

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

// Change flash edge (moment 14), pure so the edge is testable: the first value seen never flashes (mounting is not
// a change), an equal value never flashes, a different one does. Object.is, so callers pass a primitive or a key.
export interface ChangeFlashState<T> {
    seen: boolean;
    value: T | undefined;
}

export function initialChangeFlashState<T>(): ChangeFlashState<T> {
    return { seen: false, value: undefined };
}

export function nextChangeFlash<T>(
    prev: ChangeFlashState<T>,
    value: T
): { flash: boolean; state: ChangeFlashState<T> } {
    const flash = prev.seen && !Object.is(prev.value, value);
    return { flash, state: { seen: true, value } };
}

// Change flash (moment 14): true for CHANGE_FLASH_MS after `value` changes while mounted, so the caller can put
// changeFlashClass on the element whose value moved under the user. A change mid-wash rides the wash already
// playing: restarting it would need the class off for a frame, a flicker that says less than one wash.
export function useChangeFlash<T>(value: T): boolean {
    const [flashing, setFlashing] = useState(false);
    const state = useRef(initialChangeFlashState<T>());
    const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
    useEffect(() => {
        const next = nextChangeFlash(state.current, value);
        state.current = next.state;
        if (!next.flash || timer.current != null) return;
        setFlashing(true);
        timer.current = setTimeout(() => {
            timer.current = undefined;
            setFlashing(false);
        }, CHANGE_FLASH_MS);
    }, [value]);
    useEffect(
        () => () => {
            clearTimeout(timer.current);
            timer.current = undefined;
        },
        []
    );
    return flashing;
}
