// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { useEffect } from "react";
import type { AgentsViewModel } from "./agents";

// Single owner of the 1s now-clock. Mounted once for the app lifetime (cockpit root) so every
// surface's age/quiet/countdown leaf reads a live nowAtom without each surface running its own
// interval. Previously three surfaces (cockpit, focus rail, usage) each ticked while the tick-less
// ones (sessions, app bar) silently froze their "now".
export function NowTicker({ model }: { model: AgentsViewModel }) {
    useEffect(() => {
        const t = setInterval(() => globalStore.set(model.nowAtom, Date.now()), 1000);
        return () => clearInterval(t);
    }, [model]);
    return null;
}
