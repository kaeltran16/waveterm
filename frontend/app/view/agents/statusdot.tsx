// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { agentRunDone, type AgentState, type AgentVM } from "./agentsviewmodel";
import { CommitTick } from "./committick";

// Single source of truth for the in-view dot. Colors mirror the sidebar STATUS_COLOR map (Wave @theme tokens).
const COLOR: Record<AgentState, string> = {
    asking: "var(--color-warning)",
    working: "var(--color-accent)",
    idle: "var(--color-muted)",
};

// standing by (idle with a shell task running) is accent and still: the pulse is reserved for working
export function StatusDot({
    state,
    quiet,
    pulse,
    standing,
    className,
}: {
    state: AgentState;
    quiet?: boolean;
    pulse?: boolean;
    standing?: boolean;
    className?: string;
}) {
    const hollow = !standing && state === "working" && quiet;
    return (
        <span
            className={cn(
                "h-2 w-2 shrink-0 rounded-full transition-colors duration-200",
                hollow ? "border border-muted bg-transparent" : "",
                pulse && !hollow && !standing ? "pulse-dot" : "",
                className
            )}
            style={hollow ? undefined : { backgroundColor: standing ? "var(--color-accent)" : COLOR[state] }}
        />
    );
}

// an agent's dot, or the done tick in its place once its quick run is done
export function AgentStateMark({
    agent,
    className,
}: {
    agent: Pick<AgentVM, "state" | "runDone">;
    className?: string;
}) {
    return agentRunDone(agent) ? <CommitTick runDone /> : <StatusDot state={agent.state} className={className} />;
}
