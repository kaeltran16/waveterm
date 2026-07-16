// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The channel surface's static chrome: the header (name + Jarvis autonomy toggle + profile ⚙), the
// collapsible overview/notes strip (with the on-demand Jarvis summary), and the run-tab strip.
// Extracted from channelssurface.tsx; presentational only.

import { type AgentVM } from "./agentsviewmodel";
import { Avatar } from "./channelsprimitives";
import { MarkdownMessage } from "./markdownmessage";
import { PHASE_TONE_CLASS, TONE_CLASS } from "./runbody";
import { cancelSurvivors, phaseProgressDots, runStatusView } from "./runmodel";
import { type SummaryState } from "./usefleetsummary";

export function ChannelHeader({
    channel,
    autonomyOn,
    onToggleAutonomy,
    onOpenProfile,
}: {
    channel: Channel | null;
    autonomyOn: boolean;
    onToggleAutonomy: () => void;
    onOpenProfile: () => void;
}) {
    return (
        <div className="flex flex-none items-center gap-2.5 border-b border-border bg-background px-6 py-3">
            <span className="font-mono text-[17px] font-bold text-muted">#</span>
            <div className="min-w-0">
                <div className="truncate text-[15px] font-bold tracking-[-0.01em] text-primary">
                    {channel?.name ?? "no channel"}
                </div>
                {channel?.projectpath ? (
                    <div className="truncate font-mono text-[11.5px] text-muted">{channel.projectpath}</div>
                ) : null}
            </div>
            <div className="flex-1" />
            {channel ? (
                <>
                    <span className="font-mono text-[9px] font-semibold uppercase tracking-[.09em] text-muted">Jarvis</span>
                    <button
                        type="button"
                        onClick={onToggleAutonomy}
                        title={
                            autonomyOn
                                ? "Jarvis auto-answers routine asks and escalates real forks to you. Click to switch to Observing."
                                : "Jarvis stays hands-off; every worker ask routes to you. Click to let Jarvis handle routine asks."
                        }
                        className={
                            "flex cursor-pointer items-center gap-2.5 rounded-[9px] border px-2.5 py-1.5 " +
                            (autonomyOn ? "border-accent/40 bg-accentbg/20" : "border-edge-mid bg-background")
                        }
                    >
                        <span className={"text-[11.5px] font-bold " + (autonomyOn ? "text-accent-soft" : "text-secondary")}>
                            {autonomyOn ? "Handling asks" : "Observing"}
                        </span>
                        <span
                            className={
                                "relative h-[18px] w-[34px] flex-none rounded-full transition-colors " +
                                (autonomyOn ? "bg-accent" : "bg-edge-mid")
                            }
                        >
                            <span
                                className={
                                    "absolute top-0.5 h-[14px] w-[14px] rounded-full transition-all " +
                                    (autonomyOn ? "left-[18px] bg-background" : "left-0.5 bg-secondary")
                                }
                            />
                        </span>
                    </button>
                    <button
                        type="button"
                        onClick={onOpenProfile}
                        title="Channel profile — run engine (pipeline vs. adaptive lead) & plan gate live here"
                        className="flex h-8 w-8 flex-none items-center justify-center rounded border border-edge-mid bg-background text-[15px] text-muted hover:border-edge-strong hover:text-secondary"
                    >
                        ⚙
                    </button>
                </>
            ) : null}
        </div>
    );
}

export function OverviewStrip({
    open,
    onToggle,
    runCount,
    summary,
    onRunSummary,
}: {
    open: boolean;
    onToggle: () => void;
    runCount: number;
    summary: SummaryState | null;
    onRunSummary: () => void;
}) {
    return (
        <div className="flex-none border-b border-border bg-background">
            <button
                type="button"
                onClick={onToggle}
                className="flex w-full cursor-pointer items-center gap-2.5 px-6 py-2 hover:bg-surface"
            >
                <span className={"font-mono text-[7px] text-muted transition-transform " + (open ? "rotate-90" : "")}>
                    ▶
                </span>
                <span className="font-mono text-[9px] font-semibold uppercase tracking-[.1em] text-muted">
                    Overview &amp; notes
                </span>
                <span className="font-mono text-[11px] text-ink-mid">
                    · {runCount} run{runCount === 1 ? "" : "s"}
                </span>
                <div className="flex-1" />
                {!open ? (
                    <span className="truncate text-[11px] text-muted" style={{ maxWidth: 420 }}>
                        Channel notes — coming soon
                    </span>
                ) : null}
            </button>
            {open ? (
                <div className="flex items-start gap-3.5 px-6 pb-3.5 pt-0.5">
                    <div className="min-w-0 flex-1">
                        <div className="mb-1.5 font-mono text-[8.5px] font-semibold uppercase tracking-[.08em] text-muted">
                            Channel notes
                        </div>
                        <div className="rounded-[10px] border border-border bg-background px-3 py-2.5 text-[12.5px] leading-[1.6] text-muted opacity-60">
                            Channel notes — coming soon.
                        </div>
                    </div>
                    <div className="w-[280px] flex-none">
                        <div className="mb-1.5 font-mono text-[8.5px] font-semibold uppercase tracking-[.08em] text-muted">
                            Jarvis summary
                        </div>
                        {summary ? (
                            <div className="rounded-[10px] border border-accent/25 bg-accentbg/15 px-3 py-2.5">
                                <div className="mb-1.5 flex items-center gap-1.5">
                                    <Avatar name="jarvis" />
                                    <span className="font-mono text-[8.5px] font-semibold uppercase tracking-[.08em] text-accent-soft">
                                        Jarvis {summary.status === "streaming" ? "· thinking…" : ""}
                                    </span>
                                </div>
                                <MarkdownMessage text={summary.text || "…"} className="text-[12px] leading-[1.55] text-secondary" />
                            </div>
                        ) : (
                            <button
                                type="button"
                                onClick={onRunSummary}
                                className="flex w-full cursor-pointer items-center gap-2.5 rounded-[10px] border border-accent/25 bg-background px-3 py-2.5 text-left hover:border-accent/40"
                            >
                                <Avatar name="jarvis" />
                                <span className="min-w-0 flex-1">
                                    <span className="block text-[12px] font-bold text-accent-soft">Summarize the fleet</span>
                                    <span className="text-[10.5px] text-muted">on-demand · not gated by autonomy</span>
                                </span>
                            </button>
                        )}
                    </div>
                </div>
            ) : null}
        </div>
    );
}

export function RunStrip({
    runs,
    agents,
    activeRunId,
    pendingDraft,
    onGoToRun,
    onDismiss,
    onNewRun,
    hasSelectedRun,
}: {
    runs: Run[];
    agents: AgentVM[];
    activeRunId: string | undefined;
    pendingDraft: boolean;
    onGoToRun: (id: string) => void;
    onDismiss: (id: string) => void;
    onNewRun: () => void;
    hasSelectedRun: boolean;
}) {
    return (
        <div className="sc flex flex-none gap-2 overflow-x-auto border-b border-border bg-background px-6 py-2.5">
            {runs.map((r) => {
                const { tone } = runStatusView(r.status);
                // a cancelled run with still-live workers must not read as a clean cancel here either
                // (mirrors the run header pill) — flag the dot with the blocked tone.
                const dotToneClass = cancelSurvivors(r, agents).length > 0 ? TONE_CLASS.blocked : (TONE_CLASS[tone] ?? "text-muted");
                const dots = phaseProgressDots(r);
                const isActive = !pendingDraft && r.id === activeRunId;
                return (
                    <div
                        key={r.id}
                        className={
                            "group flex max-w-[250px] flex-none items-center gap-2 rounded-[9px] border px-3 py-2 " +
                            (isActive ? "border-accent/50 bg-accentbg/40" : "border-edge-mid hover:border-edge-strong")
                        }
                    >
                        <button type="button" onClick={() => onGoToRun(r.id)} className="flex min-w-0 items-center gap-2">
                            {r.mode === "quick" ? (
                                <span className="flex-none font-mono text-[8px] font-bold uppercase tracking-[.05em] text-accent-soft">Q</span>
                            ) : null}
                            <span className={"h-[7px] w-[7px] flex-none rounded-full bg-current " + dotToneClass} />
                            <span title={r.goal} className="truncate text-[12px] font-semibold text-primary">{r.goal}</span>
                        </button>
                        {dots.length > 0 ? (
                            <span className="flex flex-none items-center gap-0.5">
                                {dots.map((t, i) => (
                                    <span key={i} className={"h-[4px] w-[4px] rounded-full bg-current " + (PHASE_TONE_CLASS[t] ?? "text-muted")} />
                                ))}
                            </span>
                        ) : null}
                        <button
                            type="button"
                            onClick={() => onDismiss(r.id)}
                            title="Dismiss from this list (does not cancel the run)"
                            className="flex-none font-mono text-[13px] leading-none text-muted opacity-0 hover:text-secondary group-hover:opacity-100"
                        >
                            ×
                        </button>
                    </div>
                );
            })}
            <button
                type="button"
                onClick={onNewRun}
                className={
                    "flex-none rounded-[9px] border px-3 py-2 text-[12px] font-semibold " +
                    (!pendingDraft && !hasSelectedRun
                        ? "border-accent/50 bg-accentbg/40 text-accent-soft"
                        : "border-dashed border-edge-mid text-muted hover:text-secondary")
                }
            >
                ＋ New run
            </button>
        </div>
    );
}
