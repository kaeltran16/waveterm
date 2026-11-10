// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The design's project chips (design L864: a two-column grid with "last used"; L796: a wrapping row). The
// design shows four projects; a registry of a hundred cannot be four chips, so the last-used project and
// the next three ranked names are chips, and a search box reaches the rest.

import { indicatorSlide, morphTransition } from "@/app/element/motiontokens";
import { atoms } from "@/app/store/global";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { MotionConfig, motion, type Transition } from "motion/react";
import { useId, useState, type KeyboardEvent } from "react";
import { rankProjects } from "./newrun";

const CHIP_COUNT = 4;
const SEARCH_RESULT_COUNT = 8;
const CHIP_TONE_ON = "border-transparent text-accent-soft";
const CHIP_TONE_OFF = "border-border bg-surface-raised text-ink-mid";
// reducedMotion="user" leaves layout animations running, so reduced motion snaps them itself
const SNAP: Transition = { duration: 0 };

// The picked chip's highlight: one element per chip row, so a new pick slides it across instead of one chip going
// dark as another lights. It sits under the chip's content (isolate + -z-10) and covers the chip's own border.
function PickedMark({ layoutId, transition }: { layoutId: string; transition: Transition }) {
    return (
        <motion.span
            layoutId={layoutId}
            data-project-chip-mark
            aria-hidden
            transition={transition}
            className="absolute -inset-px -z-10 rounded-[7px] border border-accent/40 bg-accentbg"
        />
    );
}

export function ProjectChips({
    names,
    picked,
    recent,
    onPick,
    columns,
    allowCustom = false,
    onKeyDown,
}: {
    names: string[];
    picked: string | null;
    recent: string | null;
    onPick: (name: string) => void;
    columns: 1 | 2;
    // a free-text project (New initiative): a query nothing matches can be used as the value itself
    allowCustom?: boolean;
    // the search box's keys, with the chips it currently shows, so a caller can walk them with arrows
    onKeyDown?: (e: KeyboardEvent<HTMLInputElement>, visible: string[]) => void;
}) {
    const [query, setQuery] = useState("");
    const q = query.trim();
    const ranked = rankProjects(names, query);
    // picked stays a chip even off the registry, so a free-text value an initiative already carries shows
    const head =
        q === ""
            ? [
                  ...new Set(
                      [recent, picked, ...ranked].filter(
                          (n): n is string => n != null && n !== "" && (names.includes(n) || n === picked)
                      )
                  ),
              ].slice(0, CHIP_COUNT)
            : ranked.slice(0, SEARCH_RESULT_COUNT);
    const custom = allowCustom && q !== "" && ranked.length === 0 ? q : null;
    // per instance, so two pickers on screen never trade one highlight
    const markId = `project-chip-${useId()}`;
    const reduce = useAtomValue(atoms.prefersReducedMotionAtom);
    const markMove = reduce ? SNAP : indicatorSlide;
    return (
        <MotionConfig reducedMotion="user">
            <div className="flex flex-col gap-1.5">
                {head.length > 0 || custom != null ? (
                    <div className={cn(columns === 2 ? "grid grid-cols-2 gap-1.5" : "flex flex-wrap gap-1.5")}>
                        {head.map((name) => {
                            const on = name === picked;
                            // a pick moves the picked chip to the front, so each chip slides to its new place;
                            // position only, since chips differ in width and a scaled label smears
                            return (
                                <motion.button
                                    key={name}
                                    layout="position"
                                    transition={reduce ? SNAP : morphTransition}
                                    type="button"
                                    title={name}
                                    aria-pressed={on}
                                    onClick={() => onPick(name)}
                                    className={cn(
                                        "relative isolate flex min-w-0 cursor-pointer items-center gap-2 rounded-[7px] border text-left text-[12px] font-medium hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                                        columns === 2 ? "px-2.5 py-[7px]" : "px-2.5 py-[5px]",
                                        on ? CHIP_TONE_ON : CHIP_TONE_OFF
                                    )}
                                >
                                    {on ? <PickedMark layoutId={markId} transition={markMove} /> : null}
                                    {columns === 2 ? (
                                        <span
                                            className={cn(
                                                "h-[7px] w-[7px] flex-none rounded-[2px]",
                                                name === recent ? "bg-asking" : "bg-success"
                                            )}
                                        />
                                    ) : null}
                                    <span className="min-w-0 flex-1 truncate">{name}</span>
                                    {columns === 2 && name === recent ? (
                                        <span className="flex-none font-mono text-[10.5px] text-muted">last used</span>
                                    ) : null}
                                </motion.button>
                            );
                        })}
                        {custom != null ? (
                            <button
                                type="button"
                                aria-pressed={picked === custom}
                                onClick={() => onPick(custom)}
                                className={cn(
                                    "relative isolate flex min-w-0 cursor-pointer rounded-[7px] border px-2.5 py-[5px] text-left text-[12px] font-medium hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                                    picked === custom ? CHIP_TONE_ON : CHIP_TONE_OFF
                                )}
                            >
                                {picked === custom ? <PickedMark layoutId={markId} transition={markMove} /> : null}
                                {/* truncated inside, so the button's own overflow never clips the mark's border */}
                                <span className="min-w-0 truncate">Use “{custom}”</span>
                            </button>
                        ) : null}
                    </div>
                ) : q !== "" ? (
                    <span className="px-2.5 py-[5px] text-[12px] text-muted">No project matches.</span>
                ) : null}
                {names.length > CHIP_COUNT || allowCustom ? (
                    <input
                        value={query}
                        aria-label="Search projects"
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={onKeyDown != null ? (e) => onKeyDown(e, head) : undefined}
                        placeholder={
                            names.length > CHIP_COUNT ? `Search ${names.length} projects…` : "Search or type a project…"
                        }
                        className="w-full rounded-[7px] border border-edge-mid bg-background px-2.5 py-1.5 text-[12px] text-primary outline-none placeholder:text-muted focus:border-accent/60"
                    />
                ) : null}
            </div>
        </MotionConfig>
    );
}
