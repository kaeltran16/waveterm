// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Always-mounted (cockpit root) 10s poll driver for the background-agents section, mirroring
// NowTicker. Renders nothing. 10s (vs usage's 60s) so a `blocked`/needs-input background agent
// surfaces quickly; each tick is one `claude agents --json` shell-out, skipped while the window is
// hidden and caught up the moment it shows again.

import { useEffect } from "react";
import { pollBackgroundAgents } from "./backgroundagentsstore";

export function BackgroundAgentsPoller() {
    useEffect(() => {
        const tick = () => void pollBackgroundAgents();
        tick();
        const t = setInterval(tick, 10_000);
        document.addEventListener("visibilitychange", tick);
        return () => {
            clearInterval(t);
            document.removeEventListener("visibilitychange", tick);
        };
    }, []);
    return null;
}
