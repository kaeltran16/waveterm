// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The rail's Needs-you list, across every channel. Attention beats focus: a Space scopes the Subjects
// column and the Stage, never this list — an ask in a channel outside focus still surfaces, labelled as
// such. The label describes membership, not filtering, so it stands whether or not "Show all" is on.

import type { AgentVM } from "@/app/view/agents/agentsviewmodel";
import { buildNeeds, type NeedsItem } from "@/app/view/agents/channelneeds";
import { buildFleetSnapshot } from "@/app/view/agents/jarvisderive";

export interface RailNeedsItem extends NeedsItem {
    channelId: string;
    channelName: string;
    outsideFocus: boolean;
}

export function buildRailNeeds(input: {
    channels: Channel[] | null;
    agents: AgentVM[];
    scope: SpaceScope | null;
}): RailNeedsItem[] {
    const focused = input.scope != null ? new Set(input.scope.channeloids ?? []) : null;
    const out: RailNeedsItem[] = [];
    for (const channel of input.channels ?? []) {
        const needs = buildNeeds({
            runs: channel.runs ?? [],
            messages: channel.messages ?? [],
            agents: input.agents,
            snapshot: buildFleetSnapshot(channel, input.agents),
        });
        for (const n of needs) {
            out.push({
                ...n,
                // buildNeeds keys within one channel; two channels can hold the same run or ask key.
                key: `${channel.oid}:${n.key}`,
                channelId: channel.oid,
                channelName: channel.name ?? "channel",
                outsideFocus: focused != null && !focused.has(channel.oid),
            });
        }
    }
    return out;
}
