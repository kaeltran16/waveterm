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
