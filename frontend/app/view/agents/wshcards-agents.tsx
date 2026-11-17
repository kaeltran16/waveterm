// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// wsh agents calls: send and read cards between agents, the agents list view, and ui reveal rows. Names come from
// the live roster (wshdata key "agents"), so a card reads "Sent to Lead · ..." rather than a tab id; the models
// are in agentscards.ts.

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn, fireAndForget } from "@/util/util";
import { ArrowUpRight, Eye, FileText, MessageSquare, Send } from "lucide-react";
import type { ReactNode } from "react";
import { openTarget } from "../jarvis/openref";
import { listRows, readModel, revealModel, sendModel, type CallResult } from "./agentscards";
import type { AgentActionEntry } from "./agentsviewmodel";
import { LoadFailure } from "./recordedoutput";
import { StatusDot } from "./statusdot";
import type { TranscriptContext } from "./transcriptcontext";
import { wshJsonOutput } from "./wshcall";
import { CallFacts } from "./wshchangerow";
import { useWshData } from "./wshdata";
import { AsOfNow, type WshRendererProps, type WshRenderers } from "./wshrenderers";

const ROSTER_KEY = "agents";
// a long sent text or answer scrolls inside its card; the raw output is one click away
const BODY_MAX_H = "max-h-[320px]";

function useRoster() {
    const state = useWshData<CommandAgentsListRtnData>(ROSTER_KEY, () => RpcApi.AgentsListCommand(TabRpcClient));
    return { agents: state.data?.agents, error: state.error };
}

function resultOf(action: AgentActionEntry): CallResult {
    const d = action.detail;
    return d?.kind === "bash"
        ? { command: action.command ?? d.command, output: d.output, exit: d.exit }
        : { command: action.command };
}

// a failed roster fetch leaves the card on argv alone, and says so
function LoadError({
    error,
    action,
    compact,
}: {
    error: string | undefined;
    action: AgentActionEntry;
    compact: boolean;
}) {
    return error ? (
        <LoadFailure
            message={`Could not load the agent list: ${error}`}
            action={action}
            compact={compact}
            className="px-3.5 pb-2"
        />
    ) : null;
}

function OpenAgent({ tabid, ctx }: { tabid: string | undefined; ctx: TranscriptContext }) {
    const { model } = ctx;
    if (!model || !tabid) {
        return null;
    }
    return (
        <button
            type="button"
            onClick={() => fireAndForget(() => openTarget(model, { kind: "agent", tabId: tabid }))}
            className="inline-flex shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap text-[12px] text-ink-mid hover:text-foreground"
        >
            Open agent
            <ArrowUpRight size={11} strokeWidth={2.2} aria-hidden />
        </button>
    );
}

function CardHeader({ compact, children }: { compact: boolean; children: ReactNode }) {
    return (
        <div
            className={cn(
                "flex items-center border-b border-edge-faint text-muted",
                compact ? "gap-1.5 px-2.5 py-1.5 text-[11.5px]" : "gap-2 px-3.5 py-[9px] text-[12.5px]"
            )}
        >
            {children}
        </div>
    );
}

function CardBody({ compact, className, children }: { compact: boolean; className: string; children: ReactNode }) {
    return (
        <div
            className={cn(
                "overflow-y-auto whitespace-pre-wrap break-words",
                BODY_MAX_H,
                compact
                    ? "px-2.5 pb-2 pt-[7px] text-[12.5px] leading-[1.5]"
                    : "px-3.5 pb-3 pt-2.5 text-[13.5px] leading-[1.55]",
                className
            )}
        >
            {children}
        </div>
    );
}

function AgentsSendCard({ call, action, compact }: WshRendererProps) {
    const roster = useRoster();
    const m = sendModel(call, roster.agents, resultOf(action));
    const icon = compact ? 11 : 13;
    return (
        <div
            className={cn(
                "ml-auto overflow-hidden border border-edge-mid",
                compact ? "w-[86%] rounded-lg" : "w-[78%] rounded-xl"
            )}
        >
            <CardHeader compact={compact}>
                <Send size={icon} strokeWidth={2} className="shrink-0 text-ink-mid" aria-hidden />
                <span className="shrink-0">Sent to</span>
                <span className="min-w-0 truncate text-foreground">{m.name}</span>
                <span className="flex-1" />
                {m.midTurn ? <span className="shrink-0">joined its running turn</span> : null}
                <CallFacts action={action} compact={compact} />
            </CardHeader>
            {m.text != null ? (
                <CardBody compact={compact} className="text-secondary">
                    {m.text}
                </CardBody>
            ) : null}
            {m.file ? (
                <CardBody compact={compact} className="font-mono text-[12px] text-muted">
                    text from {m.file}
                </CardBody>
            ) : null}
            <LoadError error={m.tabid ? undefined : roster.error} action={action} compact={compact} />
        </div>
    );
}

function AgentsReadCard({ call, action, ctx, compact }: WshRendererProps) {
    const roster = useRoster();
    const m = readModel(call, roster.agents, resultOf(action));
    const icon = compact ? 11 : 13;
    return (
        <div
            className={cn(
                "overflow-hidden border border-edge-mid bg-surface",
                compact ? "w-[86%] rounded-lg" : "w-[78%] rounded-xl"
            )}
        >
            <CardHeader compact={compact}>
                <MessageSquare size={icon} strokeWidth={2} className="shrink-0 text-ink-mid" aria-hidden />
                <span className="shrink-0">From</span>
                <span className="min-w-0 truncate text-foreground">{m.name}</span>
                <span className="flex-1" />
                <OpenAgent tabid={m.tabid} ctx={ctx} />
                <CallFacts action={action} compact={compact} />
            </CardHeader>
            {m.answer ? (
                <CardBody compact={compact} className="text-foreground">
                    {m.answer}
                </CardBody>
            ) : null}
            <LoadError error={m.tabid ? undefined : roster.error} action={action} compact={compact} />
        </div>
    );
}

function UiRevealRow({ call, action, compact }: WshRendererProps) {
    const roster = useRoster();
    const m = revealModel(call.args[0] ?? "", roster.agents);
    const Icon = m.kind === "show" ? Eye : FileText;
    return (
        <div
            className={cn(
                "flex items-center px-0.5 py-1 text-ink-mid",
                compact ? "gap-[7px] text-[12.5px]" : "gap-2.5 text-[13.5px]"
            )}
        >
            <Icon size={compact ? 12 : 14} strokeWidth={2} className="shrink-0" aria-hidden />
            <span className="shrink-0">{m.kind === "show" ? "Showed in Arc" : "Opened in Arc"}</span>
            <span className={cn("min-w-0 truncate text-foreground", m.mono && "font-mono text-[12px]")}>{m.label}</span>
            <span className="flex-1" />
            <CallFacts action={action} compact={compact} />
        </div>
    );
}

// the opened body of `agents list`: its own --json rows, else the live roster (current state, so "as of now")
function AgentsListView({ action, compact }: WshRendererProps) {
    const { command, output, exit } = resultOf(action);
    const printed = wshJsonOutput<AgentInfo[]>(command, output, exit);
    const state = useWshData<CommandAgentsListRtnData>(printed ? null : ROSTER_KEY, () =>
        RpcApi.AgentsListCommand(TabRpcClient)
    );
    const agents = printed ?? state.data?.agents;
    if (!agents) {
        return state.status === "error" ? (
            <LoadFailure message={`Could not load the agent list: ${state.error}`} action={action} compact={compact} />
        ) : (
            <div className="text-[12px] text-muted">Loading agents</div>
        );
    }
    const rows = listRows(agents);
    return (
        <div className="rounded-lg border border-edge-mid bg-surface py-1.5">
            {rows.length === 0 ? <div className="px-3 py-1.5 text-[12.5px] text-muted">No live agents</div> : null}
            {rows.map((r) => (
                <div
                    key={r.key}
                    data-agent-row
                    className={cn("flex items-center gap-2.5 px-3 py-1.5", compact ? "text-[12.5px]" : "text-[13px]")}
                >
                    <StatusDot state={r.state} />
                    <span className={cn("min-w-0 truncate", r.state === "idle" ? "text-ink-mid" : "text-foreground")}>
                        {r.name}
                    </span>
                    <span className="shrink-0 text-[12px] text-muted">{r.about}</span>
                    <span className="flex-1" />
                    <span className="shrink-0 font-mono text-[11px] text-ink-faint">{r.id}</span>
                </div>
            ))}
            {printed ? null : (
                <div className="flex justify-end px-3 pt-1">
                    <AsOfNow />
                </div>
            )}
        </div>
    );
}

export const AGENTS_RENDERERS: WshRenderers = {
    "agents-list": AgentsListView,
    "agents-send": AgentsSendCard,
    "agents-read": AgentsReadCard,
    "ui-reveal": UiRevealRow,
};
