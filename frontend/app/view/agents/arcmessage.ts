// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure: which user entries Arc typed rather than the human. The engine sends text, not kinds, so a wake and a
// brainstorm line are told by their prefix, another agent's message by its envelope, and a brief by being the first prompt of a run's agent (its role comes
// from the run lineage, never from the text).

import type { AgentEntry } from "./agentsviewmodel";
import type { RunRole } from "./runlineage";
import type { TranscriptContext } from "./transcriptcontext";

// text is the whole trimmed entry, prefix included, so a later classifier reads every line as the engine sent it; an
// agent message's text is its body, the envelope line read into sender and tab
export type ArcMessage =
    | { kind: "wake"; text: string }
    | { kind: "brief"; role: RunRole["kind"]; text: string }
    | { kind: "brainstorm"; text: string }
    | { kind: "agent"; sender: string; tabId: string; text: string };

const WAKE_PREFIX = "wake:";
const BRAINSTORM_PREFIX = "brainstorm:";
// agentmsg.Envelope in pkg/agentmsg/agentmsg.go
const AGENT_ENVELOPE = /^\[Message from agent "(.*)" \(tab (\S+)\), sent with wsh agents send\.[^\n]*\]\n([^]*)$/;

export function arcMessageOf(entry: AgentEntry, isFirstUser: boolean, ctx?: TranscriptContext): ArcMessage | null {
    if (entry.kind !== "user") {
        return null;
    }
    const text = entry.text.trim();
    if (text.startsWith(WAKE_PREFIX)) {
        return { kind: "wake", text };
    }
    if (text.startsWith(BRAINSTORM_PREFIX)) {
        return { kind: "brainstorm", text };
    }
    const envelope = AGENT_ENVELOPE.exec(text);
    if (envelope != null) {
        return { kind: "agent", sender: envelope[1], tabId: envelope[2], text: envelope[3].trim() };
    }
    if (isFirstUser && ctx?.role) {
        return { kind: "brief", role: ctx.role.kind, text };
    }
    return null;
}
