// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Always-mounted (cockpit root) 10s poll driver for the background-agents section, mirroring
// NowTicker. Renders nothing. 10s (vs usage's 60s) so a `blocked`/needs-input background agent
// surfaces quickly; each tick is one `claude agents --json` shell-out.

import { useEffect } from "react";
import { loadBackgroundAgents } from "./backgroundagentsstore";

export function BackgroundAgentsPoller() {
    useEffect(() => {
        void loadBackgroundAgents();
        const t = setInterval(() => void loadBackgroundAgents(), 10_000);
        return () => clearInterval(t);
    }, []);
    return null;
}
