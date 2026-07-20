// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Reusable right-rail: a thin always-visible strip that expands to a 300px scroll panel.
// Content-agnostic — callers pass a list of {icon,label,content} sections and a caller-owned
// openAtom (so each surface keeps its own persistence/default). Owns width, border, and the
// width-reveal animation. Collapsed, it shows a single expand button (the first section's icon
// represents the rail) — one affordance, since per-section jump anchors all just opened the panel.
// See docs/superpowers/specs/2026-07-03-collapsible-rail-and-cockpit-motion-gaps-design.md.

import { MotionConfig, motion } from "motion/react";
import { useAtom, type PrimitiveAtom } from "jotai";
import { type ReactNode } from "react";
import { cn } from "@/util/util";
import { MOTION } from "./motiontokens";
import { Tooltip } from "./tooltip";

export interface RailSection {
    id: string;
    icon: ReactNode; // the first section's icon is the rail's collapsed glyph; others are unused for now
    label: string; // in-content headings are caller-owned
    content: ReactNode;
}

// An extra glyph stacked under the rail's own icon in the collapsed strip — a trigger for a *sibling*
// drawer (e.g. the Jarvis profile drawer under the channel context rail), so both live in one 44px
// column instead of two side-by-side strips. The sibling stays a separate drawer; only the icon is here.
export interface RailExtraIcon {
    key: string;
    icon: ReactNode;
    ariaLabel: string;
    onClick: () => void;
}

const RAIL_EXPANDED_PX = 300; // matches the app-bar usage column (app-bar.tsx) → continuous divider
const RAIL_COLLAPSED_PX = 44;

export function CollapsibleRail({
    openAtom,
    sections,
    footer,
    ariaLabel,
    extraIcons,
    hideWhenCollapsed,
    forceCollapsed,
}: {
    openAtom: PrimitiveAtom<boolean>;
    sections: RailSection[];
    footer?: ReactNode;
    ariaLabel?: string;
    extraIcons?: RailExtraIcon[];
    // when true, the rail shows no collapsed strip (it animates to zero width): its glyph lives in a
    // sibling rail's extraIcons, so this drawer only takes space while open. Preserves the slide.
    hideWhenCollapsed?: boolean;
    // when true, the rail is fully hidden (zero width, no strip) regardless of `open`: a sibling drawer
    // has taken the shared right-edge slot, so this rail slides out of the way instead of stacking
    // beside it. The width animation is preserved so it collapses as the sibling expands.
    forceCollapsed?: boolean;
}) {
    const [open, setOpen] = useAtom(openAtom);
    const collapsedWidth = hideWhenCollapsed ? 0 : RAIL_COLLAPSED_PX;
    const width = forceCollapsed ? 0 : open ? RAIL_EXPANDED_PX : collapsedWidth;

    return (
        <MotionConfig reducedMotion="user">
            <motion.aside
                aria-label={ariaLabel}
                initial={false}
                animate={{ width }}
                transition={{ duration: MOTION.durMacro, ease: MOTION.easeFluid }}
                className={cn(
                    "flex h-full shrink-0 flex-col overflow-hidden bg-surface",
                    width > 0 && "border-l border-border"
                )}
            >
                {forceCollapsed ? null : open ? (
                    <>
                        <div className="flex shrink-0 items-center justify-end px-2 pt-2">
                            <button
                                type="button"
                                onClick={() => setOpen(false)}
                                aria-label="Collapse panel"
                                title="Collapse"
                                className="cursor-pointer rounded-[7px] px-2 py-1 text-[14px] leading-none text-muted hover:bg-surface-hover hover:text-secondary"
                            >
                                ›
                            </button>
                        </div>
                        <div className="flex min-h-0 flex-1 flex-col gap-[24px] overflow-y-auto px-[18px] pb-[40px] pt-[8px]">
                            {sections.map((s) => (
                                <div key={s.id}>{s.content}</div>
                            ))}
                        </div>
                        {footer ? <div className="shrink-0 border-t border-border px-[18px] py-3">{footer}</div> : null}
                    </>
                ) : hideWhenCollapsed ? null : (
                    <div className="flex flex-col items-center gap-1 pt-3">
                        <Tooltip content={ariaLabel ?? "Expand"} placement="left">
                            <button
                                type="button"
                                onClick={() => setOpen(true)}
                                aria-label={ariaLabel ?? "Expand panel"}
                                className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-[8px] text-[18px] text-accent hover:bg-surface-hover hover:text-accent-soft"
                            >
                                {sections[0]?.icon}
                            </button>
                        </Tooltip>
                        {extraIcons?.map((ei) => (
                            <Tooltip key={ei.key} content={ei.ariaLabel} placement="left">
                                <button
                                    type="button"
                                    onClick={ei.onClick}
                                    aria-label={ei.ariaLabel}
                                    className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-[8px] text-[18px] text-accent hover:bg-surface-hover hover:text-accent-soft"
                                >
                                    {ei.icon}
                                </button>
                            </Tooltip>
                        ))}
                    </div>
                )}
            </motion.aside>
        </MotionConfig>
    );
}
