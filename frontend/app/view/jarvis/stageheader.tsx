// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Stage header. Which controls exist is decided by composeStage, never inline — a control must not be
// able to drift onto a subject that cannot have it.

import type { JarvisTier } from "@/app/view/agents/channelmessages";
import { cn } from "@/util/util";
import { AutonomyLadder } from "./autonomyladderview";
import type { StageComposition } from "./stagecompose";
import { STAGE_BAND_INSET, STAGE_GUTTER, STAGE_HEADER_BAND } from "./stagemeasure";

export function StageHeader({
    comp,
    title,
    subtitle,
    channelId,
    tier,
    mode,
    onOpenGraph,
}: {
    comp: StageComposition;
    title: string;
    subtitle: string;
    channelId: string | null;
    tier: JarvisTier;
    mode: string;
    onOpenGraph: () => void;
}) {
    return (
        // the rule spans the Stage; the row inside it sits in the shared gutter, so the title starts on the
        // same x as the thread and the composer below it.
        <div className={cn(STAGE_HEADER_BAND, STAGE_BAND_INSET)}>
            {/* @container: the subtitle yields to the header's own width, not the window's. The title was
                the only shrinkable item in this row, so it truncated to 0px whenever the autonomy control
                grew — the subject you are looking at lost its name. The control is now a fixed-width chip
                that cannot grow, and the title keeps its floor. The query container is the gutter row,
                which is the box its children actually get. */}
            <div className={cn(STAGE_GUTTER, "@container flex h-full items-center gap-2.5")}>
                <span className="flex-none font-mono text-[13px] font-semibold text-accent-soft">{comp.mark}</span>
                <span
                    title={title}
                    className="min-w-[10ch] truncate text-[14px] font-bold tracking-[-.01em] text-primary"
                >
                    {title}
                </span>
                {/* the project path is the row's least load-bearing item and was its widest fixed one (244px
                of a 706px header). It shrinks before the title's floor is touched, and leaves entirely
                once the header is too narrow to seat the ladder beside it. */}
                <span
                    title={subtitle}
                    className="min-w-0 truncate font-mono text-[11px] text-muted @max-[640px]:hidden"
                >
                    {subtitle}
                </span>
                <div className="flex-1" />
                {/* a statement of reach, not a scope picker — Spaces own scoping, and two controls for one
                thing would be two sources of truth. */}
                {comp.reachText != null ? (
                    <span className="flex-none rounded-[7px] border border-border bg-surface px-2.5 py-1 text-[11px] font-semibold text-secondary">
                        Grounded in: {comp.reachText}
                    </span>
                ) : null}
                {comp.absenceChip != null ? (
                    <span className="flex-none rounded-[6px] border border-dashed border-border px-2 py-[3px] font-mono text-[10.5px] text-muted">
                        {comp.absenceChip}
                    </span>
                ) : null}
                {comp.showAutonomy && channelId != null ? (
                    <AutonomyLadder channelId={channelId} tier={tier} mode={mode} />
                ) : null}
                {/* no ⚙ here: the channel profile's trigger sits in the context rail's icon slot, beside
                    the edge its drawer actually opens from (see stagerail / RailExtraIcon). */}
                <button
                    type="button"
                    onClick={onOpenGraph}
                    title="Peek the vault graph around this subject"
                    className="flex-none cursor-pointer rounded-[7px] border border-border bg-surface px-2.5 py-1 text-[11px] font-semibold text-secondary hover:text-primary"
                >
                    Graph
                </button>
            </div>
        </div>
    );
}
