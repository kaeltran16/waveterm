// frontend/app/view/code/codehandoff.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: what gets handed to an agent, and which agents can receive it.
//
// The payload is a REFERENCE, never a snippet, and always exactly one line. ControllerInputCommand
// appends a carriage return and submits, so a multi-line payload would submit at its first newline
// and dribble the rest in as separate messages. Reading the file is what the agent is for.

import type { AgentVM } from "@/app/view/agents/agentsviewmodel";

export function handoffLine(a: { rel: string; startLine?: number; endLine?: number; note?: string }): string {
    let ref = a.rel;
    if (a.startLine != null) {
        ref += a.endLine != null && a.endLine !== a.startLine ? `:${a.startLine}-${a.endLine}` : `:${a.startLine}`;
    }
    // collapsing every run of whitespace is what guarantees the single line above
    const note = (a.note ?? "").replace(/\s+/g, " ").trim();
    return note === "" ? `look at ${ref}` : `look at ${ref} — ${note}`;
}

// Agents that can receive a keystroke injection for this project: a real agent (not a plain
// terminal, not a detached background agent) with a terminal block to write to. A blank project
// name matches nothing — a worktree browsed outside the registry has no registry name, and must
// fall back to the clipboard rather than claiming every agent.
export function liveAgentsForProject(agents: readonly AgentVM[], projectName: string): AgentVM[] {
    if (!projectName) {
        return [];
    }
    return agents.filter((a) => !!a.blockId && (a.kind == null || a.kind === "agent") && a.project === projectName);
}
