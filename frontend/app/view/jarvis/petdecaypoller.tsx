// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Always-mounted (cockpit root) poll driver for the vault's cleanup queue, mirroring AttentionPoller.
// Renders nothing.
//
// loadPrune()'s only other production caller is the Memory surface, so before this existed the queue was
// empty until you happened to visit Memory — which made the creature's rank-3 condition unreadable
// exactly when it mattered (you are not on Memory).
//
// Far slower than attention's 10s on purpose: memgarden's decay sweep is hourly and deterministic, so a
// tighter poll would spend RPCs re-reading a number that cannot have moved.

import { loadPrune } from "@/app/view/agents/memstore";
import { useEffect } from "react";
import { readUntilLanded } from "./petboot";

const DECAY_POLL_MS = 10 * 60_000;

export function PetDecayPoller() {
    useEffect(() => {
        // Retried until it lands: loadPrune empties the queue on failure, so a read lost at mount would show
        // as a clean vault for ten minutes. petview only reports decay once memPruneLoadedAtom is true, and
        // that flag is what this retry exists to reach. See petboot.ts.
        let mounted = true;
        void readUntilLanded({ read: loadPrune, live: () => mounted });
        const t = setInterval(() => void loadPrune(), DECAY_POLL_MS);
        return () => {
            mounted = false;
            clearInterval(t);
        };
    }, []);
    return null;
}
