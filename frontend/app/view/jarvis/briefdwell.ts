// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Behind you visit ack. Dwell, not load: a glance-and-close must leave the delta unseen so it repeats
// on the next visit. The dwell counts only while Behind you is on screen: it sits below Runs, so a dwell on
// the Brief alone marked rows seen that were never scrolled to.

import { useEffect, useState } from "react";
import { ackBriefingVisit } from "./briefingstore";
import { readsAsInView } from "./briefrows";

// how long Behind you must stay on screen before its rows count as seen
const BEHIND_DWELL_MS = 10_000;
const IN_VIEW_STEPS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];

// Returns the ref callback for the Behind you section. Each new snapshot restarts the dwell.
export function useBehindDwell(
    snapshotComplete: boolean,
    queryStartedAt: number | undefined
): (el: HTMLElement | null) => void {
    const [behindEl, setBehindEl] = useState<HTMLElement | null>(null);
    const [behindInView, setBehindInView] = useState(false);
    useEffect(() => {
        if (behindEl == null) {
            setBehindInView(false);
            return;
        }
        const io = new IntersectionObserver(
            ([e]) =>
                setBehindInView(
                    readsAsInView(e.intersectionRect.height, e.boundingClientRect.height, window.innerHeight)
                ),
            { threshold: IN_VIEW_STEPS }
        );
        io.observe(behindEl);
        return () => io.disconnect();
    }, [behindEl]);
    useEffect(() => {
        if (!snapshotComplete || !behindInView) {
            return;
        }
        const t = window.setTimeout(ackBriefingVisit, BEHIND_DWELL_MS);
        return () => window.clearTimeout(t);
    }, [snapshotComplete, queryStartedAt, behindInView]);
    return setBehindEl;
}
