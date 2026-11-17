// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The session's facts the details rail and the composer ring's popover both show: the Session line (state, age, cache
// countdown), the Context line (meter, note, Compact and Clear) and the loaders behind them and Token usage. Both
// mount these only while open, so the 1 s clock and the 15 s reloads never run under a closed rail or popover.

import { Meter } from "@/app/element/meter";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect } from "react";
import { driveAgent } from "./agentactions";
import { getLastOutputAtom } from "./agentcontrollerstore";
import { hungSilenceMs } from "./agenthung";
import { cacheRewriteTitle, contextFacts, type ContextFacts } from "./agentrailmodel";
import type { AgentsViewModel } from "./agents";
import { agentStateView, STATE_TONE_COLOR } from "./agentstateview";
import { agentRunDone, displayAgeMs, formatAgeShort, type AgentVM } from "./agentsviewmodel";
import { agentCacheStatusAtom, formatCacheCountdown, loadCacheStatusForAgent } from "./cachestatusstore";
import { isEndedWorkerId, roleRunId } from "./runlineage";
import type { EndedWorker } from "./runlineagestore";
import { isStandingBy } from "./shelltasks";
import { shellTasksByIdAtom } from "./shelltasksstore";
import { subagentsByIdAtom } from "./subagentsstore";
import { loadSessionUsage } from "./transcriptusagestore";

export const GAUGE_FILL: Record<ContextFacts["level"], string> = {
    ok: "bg-accent",
    warn: "bg-warning",
    hot: "bg-error",
};

export const GAUGE_TEXT: Record<ContextFacts["level"], string> = {
    ok: "text-accent",
    warn: "text-warning",
    hot: "text-error",
};

const USAGE_REFRESH_MS = 15_000;
// a cache nobody has read yet; the Session line leaves it out rather than say so
const NO_CACHE = "—";

export function DetailLine({
    label,
    title,
    clipStart,
    children,
}: {
    label: string;
    title?: string;
    // clipStart elides the start of a long value instead of its end, for a path whose tail names it
    clipStart?: boolean;
    children: React.ReactNode;
}) {
    return (
        <div className="flex min-w-0 items-baseline gap-[10px]">
            <span className="w-[52px] shrink-0 text-[12px] text-muted">{label}</span>
            <span
                title={title}
                dir={clipStart ? "rtl" : undefined}
                className="min-w-0 flex-1 truncate text-left font-mono text-[11.5px] font-medium text-secondary"
            >
                {clipStart ? <bdi dir="ltr">{children}</bdi> : children}
            </span>
        </div>
    );
}

export interface SessionView {
    stateView: ReturnType<typeof agentStateView>;
    age: string;
    ended: EndedWorker | undefined;
    cache: string;
    standingBy: boolean;
    silentMs: number | null;
    live: boolean;
    context: ContextFacts | null;
}

// useSessionView reads the agent's session as the header pill does, so the Session line and the pill always agree
export function useSessionView(model: AgentsViewModel, agent: AgentVM): SessionView {
    const subs = useAtomValue(subagentsByIdAtom)[agent.id] ?? [];
    const standingBy = isStandingBy(agent.state, useAtomValue(shellTasksByIdAtom)[agent.id] ?? [], subs);
    const lineage = useAtomValue(model.lineageAtom);
    const role = lineage.roles[agent.id];
    const roleRun = role ? lineage.runs[roleRunId(role)] : undefined;
    const now = useAtomValue(model.nowAtom);
    const cacheStatus = useAtomValue(agentCacheStatusAtom);
    const endedWorker = useAtomValue(model.endedWorkerAtom);
    const ended = endedWorker?.agent.id === agent.id ? endedWorker : undefined;
    const silentMs = hungSilenceMs(
        agent,
        useAtomValue(getLastOutputAtom(agent.blockId ?? "")),
        useAtomValue(model.structuralNowAtom)
    );
    const task = role?.kind === "worker" ? roleRun?.dag?.tasks?.find((t) => t.id === role.taskId) : undefined;
    const isClaude = (agent.agent || "claude") === "claude";
    const live = agent.blockId != null && !ended;
    return {
        stateView: agentStateView({
            agent,
            ended: isEndedWorkerId(agent.id),
            landed: task?.merged === true,
            runDone: agentRunDone(agent, standingBy),
            standingBy,
            silentMs,
        }),
        age: formatAgeShort(displayAgeMs(agent, now)),
        ended,
        cache: isClaude ? formatCacheCountdown(cacheStatus, now) : NO_CACHE,
        standingBy,
        silentMs,
        live,
        context: contextFacts(agent.usage, { isClaude, state: agent.state, live }),
    };
}

// useSessionLoaders re-reads the cache status and the session's token usage while mounted: every turn writes the
// cache again, so a status read once at focus counts down to "expired" under an agent that is still working. Usage
// follows the transcript in view, a subagent's own while its interior is open.
export function useSessionLoaders(agent: AgentVM, usage: { id: string; path?: string }) {
    useEffect(() => {
        fireAndForget(() => loadCacheStatusForAgent(agent.id, agent.transcriptPath));
        const refresh = setInterval(() => {
            fireAndForget(() => loadCacheStatusForAgent(agent.id, agent.transcriptPath, { silent: true }));
        }, USAGE_REFRESH_MS);
        return () => clearInterval(refresh);
    }, [agent.id, agent.transcriptPath]);

    useEffect(() => {
        fireAndForget(() => loadSessionUsage(usage.id, usage.path));
        const refresh = setInterval(() => {
            fireAndForget(() => loadSessionUsage(usage.id, usage.path, { silent: true }));
        }, USAGE_REFRESH_MS);
        return () => clearInterval(refresh);
    }, [usage.id, usage.path]);
}

export function SessionLine({ view }: { view: SessionView }) {
    const { stateView, age, ended, cache, context } = view;
    return (
        <DetailLine
            label="Session"
            title={cache !== NO_CACHE ? cacheRewriteTitle(context?.pct, context?.max) : undefined}
        >
            {stateView ? (
                <>
                    <span data-rail-state style={{ color: STATE_TONE_COLOR[stateView.tone] }}>
                        {stateView.text}
                    </span>
                    <span className="text-muted"> · </span>
                </>
            ) : null}
            {ended ? <>{age} ago</> : age}
            {cache !== NO_CACHE ? (
                <>
                    <span className="text-muted"> · </span>
                    cache {cache}
                </>
            ) : null}
        </DetailLine>
    );
}

const RESET_BTN =
    "flex-none cursor-pointer rounded-[6px] px-[6px] py-[2px] font-mono text-[10.5px] font-semibold text-accent-soft hover:bg-surface-hover";

// Compact and Clear, when offered, sit under the note: they shrink what every turn re-reads
export function ContextLine({ ctx, blockId }: { ctx: ContextFacts; blockId: string | undefined }) {
    return (
        <div data-session-context className="flex flex-col gap-[6px]">
            <div title={ctx.note || undefined} className="flex min-w-0 items-center gap-[10px]">
                <span className="w-[52px] shrink-0 text-[12px] text-muted">Context</span>
                <Meter
                    pct={ctx.pct}
                    fill={GAUGE_FILL[ctx.level]}
                    height={5}
                    radius={3}
                    track="bg-border"
                    className="flex-1"
                />
                <span
                    className={cn("w-[34px] text-right font-mono text-[11.5px] font-semibold", GAUGE_TEXT[ctx.level])}
                >
                    {Math.round(ctx.pct)}%
                </span>
            </div>
            {ctx.note ? <div className="pl-[62px] font-mono text-[10.5px] text-muted">{ctx.note}</div> : null}
            {ctx.offerReset ? (
                <div className="flex gap-[4px] pl-[56px]">
                    <button
                        type="button"
                        data-context-reset="compact"
                        onClick={() => driveAgent(blockId, "/compact\r")}
                        title="summarize the conversation so far and keep going from the summary"
                        className={RESET_BTN}
                    >
                        Compact
                    </button>
                    <button
                        type="button"
                        data-context-reset="clear"
                        onClick={() => driveAgent(blockId, "/clear\r")}
                        title="start a fresh conversation; /resume brings this one back"
                        className={RESET_BTN}
                    >
                        Clear
                    </button>
                </div>
            ) : null}
        </div>
    );
}
