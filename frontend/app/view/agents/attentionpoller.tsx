// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Always-mounted (cockpit root) 10s poll driver for the cockpit-wide attention list. Renders nothing.
// 10s mirrors BackgroundAgentsPoller, which picked it so a blocked agent surfaces quickly; a review
// gate has the same urgency. Polling rather than server push is deliberate — a missed poll self-heals
// on the next tick, whereas a missed push event goes stale while still looking live.

import { useEffect } from "react";
import { loadAttention } from "./attentionstore";

export function AttentionPoller() {
    useEffect(() => {
        void loadAttention();
        const t = setInterval(() => void loadAttention(), 10_000);
        return () => clearInterval(t);
    }, []);
    return null;
}
