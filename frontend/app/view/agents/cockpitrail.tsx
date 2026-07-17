// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The cockpit's right rail: the usage windows (per-provider 5-hour/weekly bars) and the recent-activity
// list. Extracted from cockpitsurface.tsx; presentational + the UsageBar it renders.

import { CollapsibleRail, type RailSection } from "@/app/element/collapsiblerail";
import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import type { AgentsViewModel } from "./agents";
import { formatReset, formatTokens, usageLevel, type AgentVM } from "./agentsviewmodel";
import { ICON } from "./navrail";
import { mergeRateLimitWindows } from "./ratelimitstore";
import { RecentActivityRail } from "./recentactivityrail";
import { RollingCount } from "./rollingcount";
import { type WindowTokens } from "./windowtokenstore";

const PLAN_BAR: Record<"ok" | "warn" | "hot", string> = { ok: "bg-accent", warn: "bg-warning", hot: "bg-error" };
const PLAN_TXT: Record<"ok" | "warn" | "hot", string> = { ok: "text-accent", warn: "text-warning", hot: "text-error" };

// Provider identity dots for the plan strip. Not theme tokens — Claude clay / Codex periwinkle are
// brand colors, kept here as the single source.
const PROVIDER_DOT: Record<string, string> = { claude: "bg-provider-claude", codex: "bg-provider-codex" };
const PROVIDER_LABEL: Record<string, string> = { claude: "Claude", codex: "Codex" };

// One plan window as a full-width handoff bar: label + pct + bar + (real used tokens) + reset
// countdown. A null pct (API-key auth, or a window not yet reported) renders nothing. `used` is
// the real Claude-only token sum for the window (windowtokenstore); absent -> no token line.
export function UsageBar({
    label,
    pct,
    reset,
    used,
    now,
}: {
    label: string;
    pct?: number;
    reset?: number;
    used?: number;
    now: number;
}) {
    if (pct == null) {
        return null;
    }
    const lvl = usageLevel(pct);
    return (
        <div>
            <div className="mb-[7px] flex items-baseline justify-between">
                <span className="text-[12.5px] font-medium text-secondary">{label}</span>
                <span className={cn("font-mono text-[12px] font-semibold", PLAN_TXT[lvl])}>{Math.round(pct)}%</span>
            </div>
            <div className="h-[7px] overflow-hidden rounded-[4px] bg-surface-raised">
                <div
                    className={cn("h-full rounded-[4px]", PLAN_BAR[lvl])}
                    style={{ width: `${Math.min(100, pct)}%` }}
                />
            </div>
            {used != null || reset ? (
                <div className="mt-[6px] flex justify-between font-mono text-[10.5px] text-muted">
                    <span>{used != null ? `${formatTokens(used)} tok` : ""}</span>
                    {reset ? <span>resets {formatReset(reset, now)}</span> : null}
                </div>
            ) : null}
        </div>
    );
}

export function CockpitRail({
    model,
    usageDonuts,
    windowTokens,
    agents,
}: {
    model: AgentsViewModel;
    usageDonuts: ReturnType<typeof mergeRateLimitWindows>;
    windowTokens: WindowTokens | null;
    agents: AgentVM[];
}) {
    // Self-source the 1s tick here (was prop-drilled from CockpitSurface) so the usage reset
    // countdown stays live without the surface re-rendering the agent grid every second.
    const now = useAtomValue(model.nowAtom);
    return (
        <CollapsibleRail
            openAtom={model.railOpenAtom}
            ariaLabel="Usage and recent activity"
            sections={[
                {
                    id: "usage",
                    label: "Usage",
                    icon: ICON.usage,
                    content: (
                        <div>
                            <div className="mb-3.5 flex items-center justify-between">
                                <h3 className="font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
                                    Usage
                                </h3>
                                <button
                                    type="button"
                                    onClick={() => globalStore.set(model.surfaceAtom, "usage")}
                                    className="cursor-pointer border-0 bg-transparent text-[11.5px] text-accent"
                                >
                                    Details →
                                </button>
                            </div>
                            <div className="flex flex-col gap-4">
                                {usageDonuts.map((d) => (
                                    <div key={d.provider} className="flex flex-col gap-4">
                                        {usageDonuts.length > 1 ? (
                                            <div className="flex items-center gap-1.5 font-mono text-[11px] font-semibold text-primary">
                                                <span
                                                    className={cn(
                                                        "h-[7px] w-[7px] rounded-full",
                                                        PROVIDER_DOT[d.provider] ?? "bg-muted"
                                                    )}
                                                />
                                                {PROVIDER_LABEL[d.provider] ?? d.provider}
                                            </div>
                                        ) : null}
                                        <UsageBar
                                            label="5-hour window"
                                            pct={d.fivehour.pct}
                                            reset={d.fivehour.reset}
                                            used={d.provider === "claude" ? windowTokens?.fivehour : undefined}
                                            now={now}
                                        />
                                        <UsageBar
                                            label="Weekly"
                                            pct={d.week.pct}
                                            reset={d.week.reset}
                                            used={d.provider === "claude" ? windowTokens?.week : undefined}
                                            now={now}
                                        />
                                    </div>
                                ))}
                            </div>
                        </div>
                    ),
                },
                {
                    id: "recent-activity",
                    label: "Recent activity",
                    icon: ICON.sessions,
                    // Self-subscribing leaf: reads the whole-map transcript atoms + nowAtom itself, so a
                    // stream chunk or the 1s tick re-renders only it (renders null when there's none).
                    content: <RecentActivityRail agents={agents} model={model} />,
                } as RailSection,
            ]}
        />
    );
}
