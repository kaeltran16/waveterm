// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Usage surface (handoff parity: Wave-cockpit-live.dc.html:809-850). Account/provider-level usage for
// external agents: rate-limit windows (live, from AgentUsage via providerPlanUsage) + token/spend/
// per-model breakdown (historical, from the transcript scan in usagestore). Loads on mount, refreshes
// on a 60s interval; a 1s tick keeps the reset countdowns current.

import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect } from "react";
import type { AgentsViewModel } from "./agents";
import {
    formatReset,
    formatTokens,
    groupAgents,
    projectsFromAgents,
    providerPlanUsage,
    usageLevel,
} from "./agentsviewmodel";
import type { ModelUsage } from "./usagestats";
import { loadUsage, usageStatsAtom } from "./usagestore";

const PROVIDER_RANK: Record<string, number> = { claude: 0, codex: 1 };
const PROVIDER_LABEL: Record<string, string> = { claude: "Claude", codex: "Codex" };
const RING: Record<"ok" | "warn" | "hot", string> = {
    ok: "var(--color-accent)",
    warn: "var(--color-warning)",
    hot: "var(--color-error)",
};

function StatCard({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
    return (
        <div className="rounded-[12px] border border-border bg-surface-raised px-[17px] py-[16px]">
            <div className="mb-2 font-mono text-[11px] font-medium text-muted">{label}</div>
            <div className={cn("font-mono text-[24px] font-bold", accent ? "text-success" : "text-primary")}>
                {value}
            </div>
        </div>
    );
}

// One rate-limit window as a conic-gradient donut (handoff L828-835). pct null (API-key auth, or a
// window not reported) renders nothing. Token cap denominator is intentionally dropped (no source).
function Donut({ label, pct, reset, now }: { label: string; pct?: number; reset?: number; now: number }) {
    if (pct == null) {
        return null;
    }
    const ring = RING[usageLevel(pct)];
    return (
        <div className="flex items-center gap-[22px] rounded-[14px] border border-border bg-surface-raised px-[22px] py-[20px]">
            <div
                className="relative flex h-[104px] w-[104px] flex-none items-center justify-center rounded-full"
                style={{ background: `conic-gradient(${ring} 0 ${Math.min(100, pct)}%, var(--color-edge-strong) 0)` }}
            >
                <div className="flex h-[78px] w-[78px] flex-col items-center justify-center rounded-full bg-background">
                    <span className="font-mono text-[22px] font-bold text-primary">{Math.round(pct)}%</span>
                    <span className="font-mono text-[9px] text-muted">used</span>
                </div>
            </div>
            <div>
                <div className="mb-[7px] font-mono text-[13.5px] font-semibold text-secondary">{label}</div>
                {reset ? <div className="font-mono text-[12px] text-muted">resets {formatReset(reset, now)}</div> : null}
            </div>
        </div>
    );
}

function ModelBar({ m }: { m: ModelUsage }) {
    return (
        <div className="mb-[12px] flex items-center gap-[14px]">
            <span className="w-[120px] flex-none truncate font-mono text-[12.5px] text-secondary">{m.model}</span>
            <div className="h-[8px] flex-1 overflow-hidden rounded-[5px] bg-surface-raised">
                <div className="h-full rounded-[5px] bg-accent" style={{ width: `${m.pct}%` }} />
            </div>
            <span className="w-[42px] flex-none text-right font-mono text-[12px] text-muted">{Math.round(m.pct)}%</span>
        </div>
    );
}

export function UsageSurface({ model }: { model: AgentsViewModel }) {
    const agents = useAtomValue(model.agentsAtom);
    const stats = useAtomValue(usageStatsAtom);
    const now = useAtomValue(model.nowAtom);
    const { asking, working, idle } = groupAgents(agents);

    useEffect(() => {
        void loadUsage();
        const refresh = setInterval(() => void loadUsage(), 60_000);
        const tick = setInterval(() => globalStore.set(model.nowAtom, Date.now()), 1000);
        return () => {
            clearInterval(refresh);
            clearInterval(tick);
        };
    }, [model]);

    const planByProvider = providerPlanUsage([...asking, ...working, ...idle]);
    const planMap = new Map(planByProvider.map((p) => [p.provider, p.usage]));
    const tokenMap = new Map(stats.providers.map((p) => [p.provider, p]));
    const providerKeys = [...new Set([...planMap.keys(), ...tokenMap.keys()])].sort(
        (a, b) => (PROVIDER_RANK[a] ?? 99) - (PROVIDER_RANK[b] ?? 99)
    );
    const hasAny = providerKeys.length > 0 || stats.totals.tokensWeek > 0;

    return (
        <div className="absolute inset-0 overflow-y-auto">
            <div className="mx-auto max-w-[920px] px-[30px] pb-[70px] pt-[30px]">
                <div className="mb-6">
                    <h1 className="text-[25px] font-bold tracking-[-0.02em] text-primary">Usage</h1>
                    <p className="text-[13.5px] text-secondary">
                        Live quota across providers. Rolling 5-hour window and weekly caps.
                    </p>
                </div>

                <div className="mb-[34px] grid grid-cols-4 gap-3">
                    <StatCard label="Active agents" value={String(working.length)} accent />
                    <StatCard label="Projects" value={String(projectsFromAgents(agents).length)} />
                    <StatCard label="Tokens today" value={formatTokens(stats.totals.tokensToday)} />
                    <StatCard label="Spend today" value={`$${stats.totals.spendTodayUsd.toFixed(2)}`} />
                </div>

                {!hasAny ? (
                    <div className="mt-10 text-center text-[13px] text-muted">No usage yet — start an agent.</div>
                ) : (
                    providerKeys.map((key) => {
                        const usage = planMap.get(key);
                        const tokens = tokenMap.get(key);
                        return (
                            <div key={key} className="mb-[34px]">
                                <div className="mb-[15px] flex items-center gap-[11px]">
                                    <h2 className="text-[16px] font-bold tracking-[-0.01em] text-primary">
                                        {PROVIDER_LABEL[key] ?? key}
                                    </h2>
                                    <div className="h-px flex-1 bg-border" />
                                </div>
                                {usage ? (
                                    <div className="mb-[14px] grid grid-cols-2 gap-[14px]">
                                        <Donut label="5-hour window" pct={usage.fivehourpct} reset={usage.fivehourreset} now={now} />
                                        <Donut label="Weekly" pct={usage.weekpct} reset={usage.weekreset} now={now} />
                                    </div>
                                ) : null}
                                {tokens && tokens.models.length > 0 ? (
                                    <div className="rounded-[14px] border border-border bg-surface-raised px-[22px] py-[18px]">
                                        <div className="mb-[14px] font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
                                            By model · this week
                                        </div>
                                        {tokens.models.map((m) => (
                                            <ModelBar key={m.model} m={m} />
                                        ))}
                                    </div>
                                ) : null}
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );
}
