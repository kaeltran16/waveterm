// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { liveWindowAgents, providerPlanUsage, usageLevel } from "@/app/view/agents/agentsviewmodel";
import { ProjectSwitcher } from "@/app/view/agents/projectswitcher";
import { mergeRateLimitWindows, savedRateLimitsAtom } from "@/app/view/agents/ratelimitstore";
import { runtimeMeta } from "@/app/view/agents/runtimemeta";
import { cn } from "@/util/util";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAtomValue } from "jotai";

// donut foreground tracks the usage band — the SAME rings the Usage tab uses (success/warn/error), so
// a given percentage reads the same color in the app bar and on the tab
const DONUT_COLOR: Record<"ok" | "warn" | "hot", string> = {
    ok: "var(--color-success)",
    warn: "var(--color-warning)",
    hot: "var(--color-error)",
};

// Handoff top app bar (46px). Replaces CockpitTitlebar + the old "+ New Agent" strip.
// Windows adaptation (spec D1): functional min/max/close on the right; no mac traffic-lights.
export function CockpitAppBar({ model }: { model: AgentsViewModel }) {
    const win = getCurrentWindow();
    const agents = useAtomValue(model.agentsAtom);
    const saved = useAtomValue(savedRateLimitsAtom);
    const now = useAtomValue(model.nowAtom);
    // one compact gauge per provider that reports a 5-hour window (claude + codex) — the SAME merged
    // (live-over-saved) per-provider data as the Usage tab. Showing every provider (not just the most-
    // utilized) means a maxed-out provider no longer hides the other's usage.
    const gauges = mergeRateLimitWindows(providerPlanUsage(liveWindowAgents(agents)), saved, now)
        .filter((d) => d.fivehour.pct != null)
        .map((d) => {
            const pct = d.fivehour.pct!;
            return {
                provider: d.provider,
                pct,
                rt: runtimeMeta(d.provider),
                donut: `conic-gradient(${DONUT_COLOR[usageLevel(pct)]} 0 ${pct}%, var(--color-edge-mid) ${pct}% 100%)`,
            };
        });
    return (
        <div
            data-tauri-drag-region
            className="flex h-[46px] shrink-0 items-center gap-4 border-b border-border bg-surface pl-4"
        >
            <div className="flex items-center gap-[9px]">
                <div className="flex h-[19px] w-[19px] items-center justify-center rounded-[6px] bg-gradient-to-br from-accent-300 to-accent-500">
                    <div className="h-[7px] w-[7px] rounded-full bg-surface" />
                </div>
                <span className="text-[14.5px] font-bold tracking-[-0.01em] text-primary">Arc</span>
                <span className="text-[13px] text-ink-faint">/</span>
                <ProjectSwitcher model={model} variant="bar" />
            </div>

            <button
                type="button"
                onClick={() => globalStore.set(model.paletteOpenAtom, true)}
                className="mx-auto flex w-[min(520px,42%)] cursor-text items-center gap-2.5 rounded-[9px] border border-edge-mid bg-surface-raised px-3 py-[7px] text-muted hover:border-edge-strong hover:bg-surface-hover"
            >
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <circle cx="5.5" cy="5.5" r="4" />
                    <path d="M9 9l3 3" strokeLinecap="round" />
                </svg>
                <span className="flex-1 text-left text-[13px]">Search agents, sessions, commands…</span>
                <span className="rounded-[5px] border border-border px-1.5 py-0.5 font-mono text-[11px]">⌘P</span>
            </button>

            <button
                type="button"
                onClick={() => globalStore.set(model.newAgentOpenAtom, true)}
                className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-[8px] bg-accent px-[clamp(9px,1.3vw,12px)] py-[7px] text-[clamp(11px,1.35vw,12.5px)] font-semibold text-background hover:bg-accenthover"
            >
                <span className="-mt-px text-[15px] leading-none">+</span>New agent
            </button>

            {/* Usage column: the 5h gauge sits above the usage rail. The left border IS the rail divider —
                this column is w-[300px] and flush to the right edge, so its border-l lands exactly on the
                rail's left edge (also 300px), reading as one continuous vertical line from top to bottom. */}
            <div className="flex h-full w-[300px] shrink-0 items-center border-l border-border pl-3">
                <button
                    type="button"
                    onClick={() => globalStore.set(model.surfaceAtom, "usage")}
                    className="flex cursor-pointer flex-col items-start justify-center gap-0.5 rounded-[7px] px-1.5 py-1 hover:bg-surface-hover"
                >
                    {gauges.length === 0 ? (
                        <span className="font-mono text-[11px] text-secondary">—</span>
                    ) : (
                        <span className="flex items-center gap-3">
                            {gauges.map((g) => (
                                <span key={g.provider} className="flex items-center gap-1.5">
                                    <span
                                        className="flex h-[18px] w-[18px] items-center justify-center rounded-full"
                                        style={{ background: g.donut }}
                                    >
                                        <span className="h-[11px] w-[11px] rounded-full bg-surface" />
                                    </span>
                                    <span className="flex items-center gap-1 font-mono text-[11px] text-secondary">
                                        <span className={cn("leading-none", g.rt.text)}>{g.rt.glyph}</span>
                                        {`${Math.round(g.pct)}%`}
                                    </span>
                                </span>
                            ))}
                        </span>
                    )}
                    <span className="text-[9px] text-muted">5h limit</span>
                </button>
                <div className="ml-auto flex h-full items-center">
                    <button
                        onClick={() => win.minimize()}
                        aria-label="Minimize"
                        className="flex h-8 w-11 cursor-pointer items-center justify-center text-secondary hover:bg-hover"
                    >
                        &#x2013;
                    </button>
                    <button
                        onClick={() => win.toggleMaximize()}
                        aria-label="Maximize"
                        className="flex h-8 w-11 cursor-pointer items-center justify-center text-secondary hover:bg-hover"
                    >
                        &#x25A1;
                    </button>
                    <button
                        onClick={() => win.close()}
                        aria-label="Close"
                        className="flex h-8 w-11 cursor-pointer items-center justify-center text-secondary hover:bg-error hover:text-white"
                    >
                        &#x2715;
                    </button>
                </div>
            </div>
        </div>
    );
}
