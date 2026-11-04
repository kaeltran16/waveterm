// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The cockpit's "No agents running" empty state: the shared SurfaceEmptyState, so it matches every
// other surface's empty state, laid over the grid. A grid empty for another reason gets the smaller
// CockpitGridNotice instead.

import { cardVariants } from "@/app/element/motiontokens";
import { formatChordString } from "@/util/keysym";
import { SquareTerminal } from "lucide-react";
import { motion } from "motion/react";
import type { GridNotice } from "./cockpitsurfacemodel";
import { SurfaceEmptyState } from "./surfacescaffold";

export function CockpitEmptyState({ onNewAgent }: { onNewAgent: () => void }) {
    return (
        <SurfaceEmptyState
            className="absolute inset-0 z-10"
            glyph={<SquareTerminal className="mb-[18px] h-[30px] w-[30px] text-accent-soft" strokeWidth={1.8} />}
            title="No agents running"
            body="Launch a terminal agent and it lands here as a live lane — watch it work, answer its questions, and review changes in place."
            action={{
                label: (
                    <>
                        <span>New terminal agent</span>
                        <span className="rounded-sm bg-background/15 px-[7px] py-[3px] font-mono text-[11px] font-semibold">
                            {formatChordString("Ctrl:n")}
                        </span>
                    </>
                ),
                onClick: onNewAgent,
                hint: (
                    <>
                        or press{" "}
                        <span className="rounded-[5px] border border-border px-1.5 py-0.5 font-mono text-[11px]">
                            {formatChordString("Ctrl:p")}
                        </span>{" "}
                        to search, or to start a run from a goal
                    </>
                ),
            }}
        />
    );
}

// the grid's own notice when the roster has agents but none of them is a card here
export function CockpitGridNotice({ notice }: { notice: GridNotice }) {
    const text =
        notice.kind === "empty-scope"
            ? `No agents in ${notice.project}`
            : `Nothing live: ${notice.idle} idle, ${notice.backgrounded} backgrounded below`;
    return (
        <motion.div
            data-cockpit-grid-notice={notice.kind}
            variants={cardVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-[30px] text-center"
        >
            <span className="text-[14px] font-medium text-muted">{text}</span>
        </motion.div>
    );
}
