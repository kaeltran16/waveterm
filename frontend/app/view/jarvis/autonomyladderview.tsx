// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The channel's autonomy control in the Stage header. Three nested rungs with accumulating fill, plus the
// dispatch mode at Delegator only.

import type { JarvisTier } from "@/app/view/agents/channelmessages";
import { setChannelTier } from "@/app/view/agents/channelsstore";
import { cn, fireAndForget } from "@/util/util";
import { DISPATCH_MODES, LADDER, rungState, showsDispatchMode } from "./autonomyladder";

export function AutonomyLadder({ channelId, tier, mode }: { channelId: string; tier: JarvisTier; mode: string }) {
    const setTier = (next: JarvisTier) => fireAndForget(() => setChannelTier(channelId, next, mode));
    const setMode = (next: string) => fireAndForget(() => setChannelTier(channelId, tier, next));
    return (
        <div className="flex items-center gap-2 rounded-[8px] border border-border bg-surface py-0.5 pl-2.5 pr-1">
            <span className="font-mono text-[9px] font-semibold uppercase tracking-[.09em] text-muted">Autonomy</span>
            <div className="flex items-end gap-0.5">
                {LADDER.map((rung, i) => {
                    const state = rungState(tier, rung.tier);
                    return (
                        <button
                            key={rung.tier}
                            type="button"
                            title={`${rung.label} — ${rung.blurb}`}
                            onClick={() => setTier(rung.tier)}
                            className={cn(
                                "flex cursor-pointer flex-col items-center gap-[3px] rounded-[6px] border px-2 pb-1 pt-[3px]",
                                state === "active" && "border-accent/40 bg-accent/20 text-primary",
                                state === "implied" && "border-transparent bg-accent/10 text-accent-soft",
                                state === "off" && "border-transparent bg-transparent text-muted"
                            )}
                        >
                            {/* the ladder yields before the subject's name does (JC12): under pressure the
                                rungs drop to their bars — each keeps its title tooltip — and the dispatch
                                strip below goes next. Container-relative, so it tracks the header's real
                                width rather than a window breakpoint. */}
                            <span className="text-[10.5px] font-bold @max-[820px]:hidden">{rung.label}</span>
                            {/* the bar grows with the rung so the ladder reads as accumulation, not as a picker */}
                            <span
                                className={cn("w-full rounded-[2px]", state === "off" ? "bg-edge-mid" : "bg-accent")}
                                style={{ height: 3 + i * 2 }}
                            />
                        </button>
                    );
                })}
            </div>
            {showsDispatchMode(tier) ? (
                <div className="ml-1 flex items-center gap-0.5 border-l border-border pl-1.5 @max-[640px]:hidden">
                    {DISPATCH_MODES.map((m) => (
                        <button
                            key={m}
                            type="button"
                            onClick={() => setMode(m)}
                            className={cn(
                                "cursor-pointer rounded-[5px] px-1.5 py-0.5 font-mono text-[10px]",
                                mode === m ? "bg-success/15 text-success" : "text-muted hover:text-secondary"
                            )}
                        >
                            {m}
                        </button>
                    ))}
                </div>
            ) : null}
        </div>
    );
}
