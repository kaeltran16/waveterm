// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Stage header. Which controls exist is decided by composeStage, never inline — a control must not be
// able to drift onto a subject that cannot have it.

import type { JarvisTier } from "@/app/view/agents/channelmessages";
import { AutonomyLadder } from "./autonomyladderview";
import type { StageComposition } from "./stagecompose";

export function StageHeader({
    comp,
    title,
    subtitle,
    channelId,
    tier,
    mode,
    onOpenProfile,
    onOpenGraph,
}: {
    comp: StageComposition;
    title: string;
    subtitle: string;
    channelId: string | null;
    tier: JarvisTier;
    mode: string;
    onOpenProfile: () => void;
    onOpenGraph: () => void;
}) {
    return (
        // @container: the ladder's rungs and its dispatch strip yield to the header's own width, not the
        // window's. The title was the only shrinkable item in this row, so it truncated to 0px whenever the
        // ladder grew — the subject you are looking at lost its name. It now has a floor and the ladder
        // gives up its labels first (see autonomyladderview).
        <div className="@container flex h-11 flex-none items-center gap-2.5 border-b border-border bg-surface px-4">
            <span className="flex-none font-mono text-[13px] font-semibold text-accent-soft">{comp.mark}</span>
            <span title={title} className="min-w-[10ch] truncate text-[14px] font-bold tracking-[-.01em] text-primary">
                {title}
            </span>
            {/* the project path is the row's least load-bearing item and was its widest fixed one (244px
                of a 706px header). It shrinks before the title's floor is touched, and leaves entirely
                once the header is too narrow to seat the ladder beside it. */}
            <span title={subtitle} className="min-w-0 truncate font-mono text-[11px] text-muted @max-[640px]:hidden">
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
            {comp.showProfile ? (
                <button
                    type="button"
                    onClick={onOpenProfile}
                    title="Channel profile — playbook, principles, run engine, plan gate"
                    className="h-[26px] w-7 flex-none cursor-pointer rounded-[7px] border border-border bg-surface text-[12px] text-secondary hover:text-primary"
                >
                    ⚙
                </button>
            ) : null}
            <button
                type="button"
                onClick={onOpenGraph}
                title="Peek the vault graph around this subject"
                className="flex-none cursor-pointer rounded-[7px] border border-border bg-surface px-2.5 py-1 text-[11px] font-semibold text-secondary hover:text-primary"
            >
                Graph
            </button>
        </div>
    );
}
