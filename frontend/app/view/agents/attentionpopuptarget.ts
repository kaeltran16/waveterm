// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Where a click on the desktop popup lands. Main window only: it reads the roster through palette-needs.

import { askAgent } from "@/app/cockpit/palette-needs";
import type { AgentVM } from "@/app/view/agents/agentsviewmodel";
import { parseAddress, type OpenTarget } from "@/app/view/jarvis/address";

export function popupTarget(item: AttentionItem, agents: AgentVM[]): OpenTarget | null {
    const agent = askAgent(item, agents);
    if (agent != null) {
        return { kind: "agent", tabId: agent.id };
    }
    if (item.oref) {
        const parsed = parseAddress(item.oref);
        if (parsed.kind !== "unsupported") {
            return parsed;
        }
    }
    if (item.runid) {
        return { kind: "run", runId: item.runid };
    }
    if (item.channelid) {
        return { kind: "channel", channelId: item.channelid };
    }
    return null;
}
