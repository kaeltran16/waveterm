// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// A record's fleet crosses channels: attribution yields dossier -> run orefs, and workers hang off runs.
// buildFleetSnapshot is per-channel, so this rolls it up over every channel that owns an attributed run
// and dedups by worker oref (one worker can be reached through more than one channel).

import type { AgentVM } from "@/app/view/agents/agentsviewmodel";
import { buildFleetSnapshot, type WorkerState } from "@/app/view/agents/jarvisderive";

export interface RecordFleetInput {
    channels: Channel[];
    agents: AgentVM[];
    attributedRunORefs: string[];
}

export interface RecordFleet {
    workers: WorkerState[];
    channelCount: number;
}

export function fleetForRecord(input: RecordFleetInput): RecordFleet {
    const wanted = new Set(input.attributedRunORefs ?? []);
    if (wanted.size === 0) {
        return { workers: [], channelCount: 0 };
    }
    const workers: WorkerState[] = [];
    const seen = new Set<string>();
    let channelCount = 0;
    for (const channel of input.channels ?? []) {
        const owns = (channel.runs ?? []).some((r) => wanted.has("run:" + r.id));
        if (!owns) continue;
        channelCount++;
        for (const w of buildFleetSnapshot(channel, input.agents)) {
            if (seen.has(w.oref)) continue;
            seen.add(w.oref);
            workers.push(w);
        }
    }
    return { workers, channelCount };
}
