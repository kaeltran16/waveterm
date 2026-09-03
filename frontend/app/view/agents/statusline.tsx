// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { useAtomValue, type Atom } from "jotai";
import type { ReactNode } from "react";
import { type AgentState, isQuiet, projectOf, type AgentVM } from "./agentsviewmodel";
import { activityAtomFor } from "./livetranscriptatoms";
import { RuntimeMark } from "./runtimemark";
import { runtimeMeta } from "./runtimemeta";
import { StatusDot } from "./statusdot";

// Liveness dot as a self-subscribing leaf: reads the 1s nowAtom + this agent's last-activity stamp
// itself, so the tick re-renders only this dot (quiet flips at the 45s threshold) instead of the whole
// card/row. Shared by the agent card header and the orchestrator overview's worker rows.
export function QuietDot({ nowAtom, agentId, state }: { nowAtom: Atom<number>; agentId: string; state: AgentState }) {
    const now = useAtomValue(nowAtom);
    const stamp = useAtomValue(activityAtomFor(agentId));
    const quiet = isQuiet(stamp, now);
    return <StatusDot state={state} quiet={quiet} pulse={state !== "idle" && !quiet} className="!h-2 !w-2" />;
}

// StatusLine is the compact worker identity + liveness row shared by the agent card header and the
// orchestrator overview's worker rows: state dot (with quiet aging), runtime mark, name, project chip.
// Status is always conveyed by dot + text — never color alone.
export function StatusLine({
    agent,
    nowAtom,
    className,
}: {
    agent: AgentVM;
    nowAtom: Atom<number>;
    className?: string;
}) {
    const project = projectOf(agent);
    const rt = runtimeMeta(agent.agent);
    return (
        <div className={cn("flex min-w-0 items-center gap-2", className)}>
            <QuietDot nowAtom={nowAtom} agentId={agent.id} state={agent.state} />
            <span title={rt.label} className="shrink-0">
                <RuntimeMark runtime={agent.agent} className={cn("shrink-0 font-mono text-[10px] leading-none", rt.text)} />
            </span>
            <b className="min-w-[30px] flex-1 truncate font-mono text-[13.5px] font-semibold text-primary">{agent.name}</b>
            {project ? (
                <span className="shrink-0 rounded-[5px] border border-edge-mid bg-surface-raised px-1.5 py-px font-mono text-[10px] text-muted">
                    {project}
                </span>
            ) : null}
        </div>
    );
}

// ActivityLine is the current-activity row: a live pulse dot + the agent's activity text. Renders
// nothing once the working activity line is gone (idle/quiet). `right` carries the caller's extra
// controls (task chip in the card, actions in the overview) and `className` their placement.
export function ActivityLine({
    agent,
    right,
    className,
}: {
    agent: AgentVM;
    right?: ReactNode;
    className?: string;
}) {
    if (agent.state !== "working" || !agent.activity) {
        return null;
    }
    return (
        <div className={cn("flex items-center gap-2", className)}>
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success animate-[pulseDot_1.6s_infinite] motion-reduce:animate-none" />
            <span
                title={agent.activity}
                className="min-w-0 flex-1 truncate font-mono text-[12px] leading-[1.4] text-success-soft"
            >
                {agent.activity}
            </span>
            {right}
        </div>
    );
}