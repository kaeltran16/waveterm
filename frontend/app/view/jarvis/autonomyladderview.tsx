// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The channel's autonomy control. The header carries a fixed-width chip naming the current tier; the three
// nested rungs, their blurbs and the Delegator-only dispatch mode live in the popover it opens.
//
// Why a chip. The rungs used to sit in the header with the dispatch strip beside them, rendered only at
// Delegator — so selecting that tier grew the group ~140px and slid all three rungs left, out from under
// the cursor that had just clicked one (this is JC12's cause, measured at a 0px title). The chip's box is
// identical at every tier and every mode, so the shift is gone by construction rather than absorbed by a
// reserved gap. It also brings the control to the header's own scale: 27px tall, like the Graph button
// beside it, where the group was 41px in a 43px band.

import { PopoverReveal } from "@/app/element/popoverreveal";
import type { JarvisTier } from "@/app/view/agents/channelmessages";
import { setChannelTier } from "@/app/view/agents/channelsstore";
import { cn, fireAndForget } from "@/util/util";
import { autoUpdate, offset, useClick, useDismiss, useFloating, useInteractions } from "@floating-ui/react";
import { useAtom } from "jotai";
import { useEffect } from "react";
import {
    autonomyPanelOpenAtom,
    chipParts,
    DISPATCH_MODES,
    LADDER,
    RUNG_BAR_PX,
    rungState,
    showsDispatchMode,
} from "./autonomyladder";

// The ladder itself, at whatever width its host wants: 3px in the chip's glyph, 4px in a panel row. Bars
// fill up to `tier`, so a row passed its own tier says what that tier includes — which makes the current
// row's glyph identical to the chip's, and the chip's glyph legible once you have opened the panel.
function RungBars({ tier, width }: { tier: JarvisTier; width: number }) {
    return (
        <span className="flex flex-none items-end gap-[2px]">
            {LADDER.map((rung, i) => (
                <span
                    key={rung.tier}
                    className={cn("rounded-[1px]", rungState(tier, rung.tier) === "off" ? "bg-edge-mid" : "bg-accent")}
                    style={{ width, height: RUNG_BAR_PX[i] }}
                />
            ))}
        </span>
    );
}

export function AutonomyLadder({ channelId, tier, mode }: { channelId: string; tier: JarvisTier; mode: string }) {
    // one source for "is it open": the atom, because the keybinding layer reads the same state to hand
    // Escape to the panel (see autonomyladder.ts). Reset on unmount, or leaving the surface with the panel
    // open would keep Escape hostage on every other deep surface.
    const [open, setOpen] = useAtom(autonomyPanelOpenAtom);
    useEffect(() => () => setOpen(false), [setOpen]);
    const setTier = (next: JarvisTier) => fireAndForget(() => setChannelTier(channelId, next, mode));
    const setMode = (next: string) => fireAndForget(() => setChannelTier(channelId, tier, next));
    const face = chipParts(tier, mode);
    // bottom-end + useDismiss is the cockpit's popover pattern (settingssurface TermThemeDropdown): both
    // Escape and an outside click close it, where a hand-rolled backdrop only ever closed on click.
    const { refs, floatingStyles, context } = useFloating({
        open,
        onOpenChange: setOpen,
        placement: "bottom-end",
        middleware: [offset(6)],
        whileElementsMounted: autoUpdate,
    });
    const { getReferenceProps, getFloatingProps } = useInteractions([useClick(context), useDismiss(context)]);
    return (
        <div className="relative flex-none">
            <button
                ref={refs.setReference}
                {...getReferenceProps()}
                type="button"
                data-jarvis-autonomy="chip"
                aria-expanded={open}
                title="Autonomy — how much Jarvis decides on this channel"
                // min-w holds the widest state, measured over CDP at 164px for "Delegator · fanout" (against
                // 107 at Concierge): a chip that sizes to its tier would put back the shift this replaced.
                className={cn(
                    "flex min-w-[164px] cursor-pointer items-center gap-2 rounded-[7px] border bg-surface px-2.5 py-1 text-[11px] font-semibold",
                    open ? "border-accent-700 text-primary" : "border-border text-secondary hover:text-primary"
                )}
            >
                <RungBars tier={tier} width={3} />
                <span className="flex-1 whitespace-nowrap text-left">{face.label}</span>
                {/* capped, not just sized: the mode is a free string off channel meta, so a value longer
                    than the three canonical ones would grow the chip and put the shift back. 52px is the
                    measured width of "· report" / "· manage" / "· fanout" (51px flat), so the canonical
                    modes never clip and anything longer does. */}
                {face.mode != null ? (
                    <span className="max-w-[52px] flex-none truncate font-mono text-[10.5px] font-normal text-muted">
                        · {face.mode}
                    </span>
                ) : null}
                <span className={cn("flex-none font-mono text-[10px] text-muted", open && "rotate-180")}>▾</span>
            </button>
            {/* rendered unconditionally and driven by `open` — a `{open ? … : null}` caller defeats
                PopoverReveal's AnimatePresence and the exit animation never plays. */}
            <div ref={refs.setFloating} style={floatingStyles} {...getFloatingProps()} className="z-20">
                <PopoverReveal
                    open={open}
                    origin="top right"
                    className="w-[300px] rounded-[11px] border border-border bg-surface p-[5px] shadow-[0_12px_34px_rgba(0,0,0,0.5)]"
                >
                    <div data-jarvis-autonomy="panel">
                        <div className="px-[9px] pb-1.5 pt-1 font-mono text-[9px] font-semibold uppercase tracking-[.09em] text-muted">
                            Autonomy
                        </div>
                        {LADDER.map((rung) => {
                            const active = rung.tier === tier;
                            return (
                                <button
                                    key={rung.tier}
                                    type="button"
                                    aria-pressed={active}
                                    onClick={() => setTier(rung.tier)}
                                    className={cn(
                                        "flex w-full cursor-pointer items-start gap-2.5 rounded px-[9px] py-2 text-left hover:bg-surface-hover",
                                        active ? "bg-surface-raised" : "bg-transparent"
                                    )}
                                >
                                    <span className="pt-[5px]">
                                        <RungBars tier={rung.tier} width={4} />
                                    </span>
                                    <span className="min-w-0 flex-1">
                                        <span
                                            className={cn(
                                                "block text-[12.5px] font-semibold",
                                                active ? "text-accent" : "text-primary"
                                            )}
                                        >
                                            {rung.label}
                                        </span>
                                        {/* the blurbs were tooltip-only while the rungs were 70px wide; the
                                            panel is where they finally fit as text */}
                                        <span className="mt-[3px] block text-[11px] leading-[1.45] text-muted">
                                            {rung.blurb}
                                        </span>
                                    </span>
                                    {active ? (
                                        <span className="flex-none pt-[3px] font-mono text-[11px] text-accent">✓</span>
                                    ) : null}
                                </button>
                            );
                        })}
                        {/* Delegator-only, and absent rather than greyed out: a control the tier cannot act
                            on is not drawn. The panel grows downward from a top-anchored header, so nothing
                            under the pointer moves when this appears. */}
                        {showsDispatchMode(tier) ? (
                            <div className="mt-1 border-t border-border px-[9px] pb-1 pt-2">
                                <div className="pb-1.5 font-mono text-[9px] font-semibold uppercase tracking-[.09em] text-muted">
                                    Dispatch mode
                                </div>
                                <div className="flex gap-1">
                                    {DISPATCH_MODES.map((m) => (
                                        <button
                                            key={m}
                                            type="button"
                                            aria-pressed={mode === m}
                                            onClick={() => setMode(m)}
                                            className={cn(
                                                "cursor-pointer rounded-[5px] px-2 py-1 font-mono text-[10.5px]",
                                                mode === m
                                                    ? "bg-success/15 text-success"
                                                    : "text-muted hover:text-secondary"
                                            )}
                                        >
                                            {m}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        ) : null}
                    </div>
                </PopoverReveal>
            </div>
        </div>
    );
}
