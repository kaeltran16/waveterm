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
import { MOTION } from "./motiontokens";
import { Tooltip } from "./tooltip";

export interface RailSection {
    id: string;
    icon: ReactNode; // the first section's icon is the rail's collapsed glyph; others are unused for now
    label: string; // in-content headings are caller-owned
    content: ReactNode;
}

const RAIL_EXPANDED_PX = 300; // matches the app-bar usage column (app-bar.tsx) → continuous divider
const RAIL_COLLAPSED_PX = 44;

export function CollapsibleRail({
    openAtom,
    sections,
    footer,
    ariaLabel,
}: {
    openAtom: PrimitiveAtom<boolean>;
    sections: RailSection[];
    footer?: ReactNode;
    ariaLabel?: string;
}) {
    const [open, setOpen] = useAtom(openAtom);

    return (
        <MotionConfig reducedMotion="user">
            <motion.aside
                aria-label={ariaLabel}
                initial={false}
                animate={{ width: open ? RAIL_EXPANDED_PX : RAIL_COLLAPSED_PX }}
                transition={{ duration: MOTION.durMacro, ease: MOTION.easeFluid }}
                className="flex h-full shrink-0 flex-col overflow-hidden border-l border-border bg-surface"
            >
                {open ? (
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
                ) : (
                    <div className="flex flex-col items-center pt-3">
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
                    </div>
                )}
            </motion.aside>
        </MotionConfig>
    );
}
