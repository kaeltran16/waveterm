// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn, fireAndForget, stringToBase64 } from "@/util/util";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { useAtomValue } from "jotai";
import { useEffect } from "react";
import type { AgentsViewModel } from "./agents";
import {
    formatAge,
    formatTokens,
    projectOf,
    recentActions,
    summarizeActions,
    usageLevel,
    type AgentVM,
} from "./agentsviewmodel";
import { capFiles, statusColor } from "./gitstatus";
import { liveEntriesByIdAtom } from "./livetranscript";
import { loadRailForAgent, railStateAtom } from "./railstore";
import { getSubagentsAtom } from "./session-models/agentstatusstore";

const DefaultContextMax = 200000; // fallback when the reporter omits contextmax (mirrors focusview)
const GAUGE_FILL: Record<"ok" | "warn" | "hot", string> = {
    ok: "bg-accent",
    warn: "bg-warning",
    hot: "bg-error",
};

const RailFilesCap = 8; // a 296px rail can't show a large worktree; overflow folds into "+N more"

function DetailRow({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex items-baseline justify-between border-b border-[#161a20] py-[8px] last:border-b-0">
            <span className="text-[12.5px] text-muted">{label}</span>
            <span className="font-mono text-[12px] font-medium text-secondary">{value}</span>
        </div>
    );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
    return (
        <h3 className="font-mono text-[11px] font-semibold uppercase tracking-[.1em] text-[#8b939d]">{children}</h3>
    );
}

export function AgentDetailsRail({ model, agent }: { model: AgentsViewModel; agent: AgentVM }) {
    const liveEntries = useAtomValue(liveEntriesByIdAtom);
    const subs = useAtomValue(getSubagentsAtom(`block:${agent.blockId}`));
    const entries = liveEntries[agent.id] ?? agent.previousInfo ?? [];
    const project = projectOf(agent);
    const usage = agent.usage;
    const ctxPct = usage?.contextpct;
    const tools = summarizeActions(recentActions(entries, 0)).byVerb;
    const railState = useAtomValue(railStateAtom);

    useEffect(() => {
        fireAndForget(() => loadRailForAgent(agent.id, agent.transcriptPath, agent.blockId));
    }, [agent.id, agent.transcriptPath, agent.blockId]);

    const { shown: shownFiles, more: moreFiles } = capFiles(railState?.changes?.files ?? [], RailFilesCap);

    const noTerminal = agent.blockId == null;
    const drive = (data: string) => {
        if (!agent.blockId) {
            return;
        }
        fireAndForget(() =>
            RpcApi.ControllerInputCommand(TabRpcClient, {
                blockid: agent.blockId!,
                inputdata64: stringToBase64(data),
            })
        );
    };

    const running = agent.state === "idle" ? `${formatAge(undefined)} idle` : formatAge(agent.activeMs);
    const tokens =
        ctxPct != null ? formatTokens(Math.round((ctxPct / 100) * (usage?.contextmax || DefaultContextMax))) : "—";
    const cost = usage?.costusd ? `$${usage.costusd.toFixed(2)}` : "—";

    return (
        <aside className="flex w-[296px] shrink-0 flex-col gap-[24px] overflow-y-auto border-l border-[#1a1f26] bg-surface px-[18px] pb-[40px] pt-[20px]">
            <div>
                <div className="mb-[13px]">
                    <SectionLabel>Details</SectionLabel>
                </div>
                <div className="flex flex-col">
                    <DetailRow label="Project" value={project || "—"} />
                    <DetailRow label="Branch" value={railState?.branch || "—"} />
                    <DetailRow label="Model" value={agent.model ?? "—"} />
                    <DetailRow label="Running" value={running} />
                    <DetailRow label="Tokens" value={tokens} />
                    <DetailRow label="Cost" value={cost} />
                </div>
            </div>

            {ctxPct != null ? (
                <div>
                    <div className="mb-[8px] flex items-baseline justify-between">
                        <SectionLabel>Context window</SectionLabel>
                        <span className="font-mono text-[12px] font-semibold text-accent">{Math.round(ctxPct)}%</span>
                    </div>
                    <div className="h-[7px] overflow-hidden rounded-[4px] bg-[#1a1f25]">
                        <span
                            className={cn("block h-full rounded-[4px]", GAUGE_FILL[usageLevel(ctxPct)])}
                            style={{ width: `${Math.min(100, ctxPct)}%` }}
                        />
                    </div>
                </div>
            ) : null}

            {subs.length > 0 ? (
                <div>
                    <div className="mb-[11px] flex items-center justify-between">
                        <SectionLabel>Subagents</SectionLabel>
                        <span className="rounded-[20px] bg-accentbg px-[8px] py-[1px] font-mono text-[11px] font-semibold text-accent-soft">
                            {subs.length}
                        </span>
                    </div>
                    <div className="flex flex-col gap-[7px]">
                        {subs.map((s) => (
                            <div
                                key={s.id}
                                className="flex items-center gap-[10px] rounded-[10px] border border-[#1c2128] bg-[#0f1217] px-[11px] py-[9px]"
                            >
                                <span
                                    className="h-[6px] w-[6px] shrink-0 rounded-full"
                                    style={{
                                        background:
                                            s.state === "working"
                                                ? "var(--color-accent)"
                                                : s.state === "failure"
                                                  ? "var(--color-error)"
                                                  : "var(--color-success)",
                                    }}
                                />
                                <div className="min-w-0 flex-1">
                                    <div className="truncate font-mono text-[11.5px] font-semibold text-secondary">
                                        {s.type || "subagent"}
                                    </div>
                                    <div className="truncate text-[10px] text-muted">{s.model ?? ""}</div>
                                </div>
                                <span className="whitespace-nowrap font-mono text-[9.5px] font-medium text-muted">
                                    {s.state}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            ) : null}

            {tools.length > 0 ? (
                <div>
                    <div className="mb-[11px]">
                        <SectionLabel>Tools used</SectionLabel>
                    </div>
                    <div className="flex flex-wrap gap-[7px]">
                        {tools.map((t) => (
                            <span
                                key={t.verb}
                                className="rounded-[6px] border border-edge-mid bg-surface-raised px-[9px] py-[4px] font-mono text-[11px] font-medium text-[#9aa3ad]"
                            >
                                {t.verb} ×{t.count}
                            </span>
                        ))}
                    </div>
                </div>
            ) : null}

            <div>
                <div className="mb-[11px]">
                    <SectionLabel>Files touched</SectionLabel>
                </div>
                {railState == null ? (
                    <div className="text-[11.5px] text-muted">Loading…</div>
                ) : !railState.isRepo ? (
                    <div className="text-[11.5px] text-muted">Not a git repository</div>
                ) : shownFiles.length === 0 ? (
                    <div className="text-[11.5px] text-muted">No changes</div>
                ) : (
                    <div className="flex flex-col gap-[7px]">
                        {shownFiles.map((f) => (
                            <div
                                key={f.path}
                                className="flex items-center gap-[8px] font-mono text-[11.5px] font-medium text-[#aeb6bf]"
                            >
                                <span className={cn("flex-none font-bold", statusColor(f.status))}>{f.status}</span>
                                <span className="min-w-0 truncate">{f.path}</span>
                            </div>
                        ))}
                        {moreFiles > 0 ? <div className="text-[11px] text-muted">+{moreFiles} more</div> : null}
                    </div>
                )}
            </div>

            <div className="mt-[4px] flex gap-[8px]">
                <button
                    type="button"
                    onClick={() => drive("continue\r")}
                    disabled={noTerminal}
                    title={noTerminal ? "no live terminal" : "nudge the agent to continue from idle"}
                    className="flex-1 rounded-[8px] border border-edge-mid bg-surface-raised py-[8px] text-[12px] font-medium text-secondary hover:border-edge-strong disabled:cursor-not-allowed disabled:text-muted disabled:opacity-50"
                >
                    Resume
                </button>
                <button
                    type="button"
                    onClick={() => drive("\x1b")}
                    disabled={noTerminal}
                    title={noTerminal ? "no live terminal" : "interrupt the current turn"}
                    className="flex-1 rounded-[8px] border border-error/30 bg-transparent py-[8px] text-[12px] font-medium text-error hover:bg-error/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    Stop
                </button>
            </div>
        </aside>
    );
}
