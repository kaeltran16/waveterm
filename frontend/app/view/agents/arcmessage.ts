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
    | { kind: "agent"; sender: string; tabId: string; text: string }
    // a board's question typed into its agent: the board, the labels it was about (none when nothing was selected),
    // the board turn it came from, and the question
    | { kind: "board"; board: string; on?: string; turnId: string; text: string };

const WAKE_PREFIX = "wake:";
const BRAINSTORM_PREFIX = "brainstorm:";
// agentmsg.Envelope in pkg/agentmsg/agentmsg.go
const AGENT_ENVELOPE = /^\[Message from agent "(.*)" \(tab (\S+)\), sent with wsh agents send\.[^\n]*\]\n([^]*)$/;
// boardforward.Marker in pkg/boardforward/boardforward.go. The board name is not escaped there, so the name stops at
// the first quote the rest of the line can follow, and the turn id is the line's last token.
const BOARD_MARKER = /^\[From board "(.*?)"(?: · on (.*?))? · turn (\S+)\]\n([^]*)$/;

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
    const board = BOARD_MARKER.exec(text);
    if (board != null) {
        const [, name, on, turnId, question] = board;
        return { kind: "board", board: name, ...(on ? { on } : {}), turnId, text: question.trim() };
    }
    if (isFirstUser && ctx?.role) {
        return { kind: "brief", role: ctx.role.kind, text };
    }
    return null;
}
