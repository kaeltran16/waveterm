// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The one place an agent's state reads as words: the header pill and the rail's Session line both render it.

import type { AgentState, AgentVM } from "./agentsviewmodel";

export type StateTone = "success" | "error" | "warning" | "accent" | AgentState;

export const STATE_TONE_COLOR: Record<StateTone, string> = {
    success: "var(--color-success)",
    error: "var(--color-error)",
    warning: "var(--color-warning)",
    accent: "var(--color-accent)",
    asking: "var(--color-warning)",
    working: "var(--color-accent)",
    idle: "var(--color-muted)",
};

const STATE_LABEL: Record<AgentState, string> = { asking: "asking", working: "working", idle: "idle" };

const MS_PER_MINUTE = 60_000;

export interface StateViewInput {
    agent: Pick<AgentVM, "state" | "kind" | "startError" | "agent">;
    ended: boolean;
    landed: boolean;
    runDone: boolean;
    standingBy: boolean;
    silentMs: number | null;
}

/** Pure: the state text and tone an agent reads as, or null for a plain terminal, which has no state. */
export function agentStateView(input: StateViewInput): { text: string; tone: StateTone } | null {
    const { agent, ended, landed, runDone, standingBy, silentMs } = input;
    if (agent.kind === "terminal") {
        return null;
    }
    if (ended || runDone) {
        return { text: landed ? "landed" : "done", tone: "success" };
    }
    if (agent.startError != null) {
        return { text: "failed to start", tone: "error" };
    }
    if (silentMs != null) {
        return { text: `quiet ${Math.floor(silentMs / MS_PER_MINUTE)}m`, tone: "warning" };
    }
    if (standingBy) {
        return { text: "standing by", tone: "accent" };
    }
    return { text: STATE_LABEL[agent.state], tone: agent.state };
}
