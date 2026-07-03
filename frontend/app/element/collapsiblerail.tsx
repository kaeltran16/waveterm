// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Reusable right-rail: a thin always-visible icon strip that expands to a 300px scroll panel.
// Content-agnostic — callers pass a list of {icon,label,content} sections and a caller-owned
// openAtom (so each surface keeps its own persistence/default). Owns width, border, the width-
// reveal animation, scroll, and jump-to-section. Collapsed icons double as jump-to-section anchors.
// See docs/superpowers/specs/2026-07-03-collapsible-rail-and-cockpit-motion-gaps-design.md.

import { MotionConfig, motion } from "motion/react";
import { useAtom, type PrimitiveAtom } from "jotai";
import { useCallback, useRef, type ReactNode } from "react";
import { MOTION } from "./motiontokens";
import { Tooltip } from "./tooltip";

export interface RailSection {
    id: string;
    icon: ReactNode; // rendered in the collapsed strip (e.g. <i className={makeIconClass("gauge", true)} />)
    label: string; // tooltip when collapsed; callers keep their own in-content headings
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
    const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});

    const openTo = useCallback(
        (id: string) => {
            setOpen(true);
            // let the expand lay out one frame before scrolling the target into view
            requestAnimationFrame(() => sectionRefs.current[id]?.scrollIntoView({ block: "start" }));
        },
        [setOpen]
    );

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
                                <div
                                    key={s.id}
                                    ref={(el) => {
                                        sectionRefs.current[s.id] = el;
                                    }}
                                >
                                    {s.content}
                                </div>
                            ))}
                        </div>
                        {footer ? <div className="shrink-0 border-t border-border px-[18px] py-3">{footer}</div> : null}
                    </>
                ) : (
                    <div className="flex flex-col items-center gap-1.5 pt-3">
                        {sections.map((s) => (
                            <Tooltip key={s.id} content={s.label} placement="left">
                                <button
                                    type="button"
                                    onClick={() => openTo(s.id)}
                                    aria-label={s.label}
                                    className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-[8px] text-[14px] text-muted hover:bg-surface-hover hover:text-secondary"
                                >
                                    {s.icon}
                                </button>
                            </Tooltip>
                        ))}
                    </div>
                )}
            </motion.aside>
        </MotionConfig>
    );
}
