// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The working line, drawn as the transcript's tail under its last item (nowline.ts derives it). WorkingLine is a pure
// view of a NowLine; LiveWorkingLine reads the 1s clock, the block's last hook, its permission requests and the
// spinner row on its terminal, so the host's memoised timeline does not re-render on each tick. A non-compact host
// (the Rendered view) also draws the agent's running background subagents: named on their own line while it is idle,
// a chip at the working line's end while it works.

import { CrossFade } from "@/app/element/crossfade";
import { composerReveal } from "@/app/element/motiontokens";
import { PaneReveal } from "@/app/element/panereveal";
import { TickNumber } from "@/app/element/ticknumber";
import { atoms } from "@/app/store/global";
import { screenRows } from "@/app/view/term/termscreen";
import { cn } from "@/util/util";
import { useAtomValue, type Atom } from "jotai";
import { LoaderCircle } from "lucide-react";
import { animate, motion, useMotionValue, useTransform, type MotionStyle } from "motion/react";
import { useEffect, useMemo, type CSSProperties, type ReactNode } from "react";
import type { AgentEntry, AgentState, AgentVM } from "./agentsviewmodel";
import {
    GLYPH_CYCLE_MS,
    glyphPose,
    nowLineState,
    nowLineText,
    SHIMMER_HALF_CH,
    shimmerSweep,
    subagentChipText,
    subagentNowLine,
    subagentsRunningText,
    turnAwaitingTranscript,
    type NowLine,
    type SubagentNowLine,
} from "./nowline";
import { getAgentPermissionsAtom } from "./permissionstore";
import { fmtDuration } from "./runcompletion";
import { getLastHookAtom } from "./session-models/agentstatusstore";
import type { SubagentVM } from "./session-models/sessionviewmodel";
import { parseSpinner } from "./spinnerrow";
import { openSubagent, subagentsByIdAtom } from "./subagentsstore";

// stable references, so a parent with no subagents derives nothing new on each list change
const NO_SUBAGENTS: SubagentVM[] = [];
const HIDDEN: SubagentNowLine = { kind: "hidden" };
// the glyph shown under reduced motion and before the first frame
const REST_GLYPH = "✻";
const MS_PER_S = 1000;
// a shimmer centre this far off the verb leaves it unlit: before the first sweep, and under reduced motion
const SHIMMER_OFF = -99;
// the shimmer's position in characters, set per frame
const SHIMMER_AT = `var(--shimmer, ${SHIMMER_OFF})`;
const SHIMMER_STYLE: CSSProperties = {
    backgroundImage: `linear-gradient(90deg,
        var(--color-provider-claude) calc((${SHIMMER_AT} + 0.5 - ${SHIMMER_HALF_CH}) * 1ch),
        color-mix(in oklab, var(--color-provider-claude) 35%, var(--color-primary)) calc((${SHIMMER_AT} + 0.5) * 1ch),
        var(--color-provider-claude) calc((${SHIMMER_AT} + 0.5 + ${SHIMMER_HALF_CH}) * 1ch))`,
};

/** Spins the glyph and sweeps the shimmer as motion values, so a frame re-renders nothing. Still under reduced
 *  motion, and with no verb to draw. */
function useSpinnerMotion(verbLength: number | null) {
    const reduce = useAtomValue(atoms.prefersReducedMotionAtom);
    const phase = useMotionValue(0);
    const shimmer = useMotionValue(SHIMMER_OFF);
    const glyph = useTransform(phase, (p) => glyphPose(p).glyph);
    const rotate = useTransform(phase, (p) => glyphPose(p).rotate);
    const scale = useTransform(phase, (p) => glyphPose(p).scale);
    const animated = verbLength != null && !reduce;
    useEffect(() => {
        if (!animated) {
            return;
        }
        const sweep = shimmerSweep(verbLength);
        const loop = { ease: "linear", repeat: Infinity } as const;
        const spin = animate(phase, [0, 1], { ...loop, duration: GLYPH_CYCLE_MS / MS_PER_S });
        const shine = animate(shimmer, [sweep.from, sweep.to], { ...loop, duration: sweep.durationMs / MS_PER_S });
        return () => {
            spin.stop();
            shine.stop();
        };
    }, [animated, verbLength, phase, shimmer]);
    return { animated, glyph, rotate, scale, shimmer };
}

export function WorkingLine({
    line,
    compact = false,
    chip,
}: {
    line: NowLine;
    compact?: boolean;
    // drawn at the line's right end; it gives way before the spinner, which never truncates
    chip?: ReactNode;
}) {
    const { verb, rest } = nowLineText(line, compact);
    const spinner = useSpinnerMotion(verb?.length ?? null);
    // the line is a feed's last row, so it grows and collapses: a snap there jumps a feed pinned to its bottom
    return (
        <PaneReveal open={line.kind !== "hidden"} variants={composerReveal}>
            <motion.div
                style={spinner.animated ? ({ "--shimmer": spinner.shimmer } as MotionStyle) : undefined}
                data-working-line
                data-compact={compact || undefined}
                className={cn(
                    "flex min-w-0 items-center text-muted",
                    compact ? "mt-1 gap-[7px] text-[12px]" : "mt-2 gap-2 text-[13px]"
                )}
            >
                {verb != null ? (
                    <span
                        className={cn(
                            "flex shrink-0 items-center gap-[1ch] font-mono",
                            compact ? "text-[11.5px]" : "text-[12.5px]"
                        )}
                    >
                        {/* outside the cross-fade, so a verb change does not restart the glyph's cycle */}
                        <motion.span
                            data-working-glyph
                            className="inline-block text-provider-claude"
                            style={spinner.animated ? { rotate: spinner.rotate, scale: spinner.scale } : undefined}
                        >
                            {spinner.animated ? spinner.glyph : REST_GLYPH}
                        </motion.span>
                        {/* claude cycles the verb while it works; each new one cross-fades in */}
                        <CrossFade swapKey={verb}>
                            <span data-working-verb className="bg-clip-text text-transparent" style={SHIMMER_STYLE}>
                                {verb}
                            </span>
                        </CrossFade>
                    </span>
                ) : null}
                <span data-working-facts className="min-w-0 truncate">
                    {rest}
                </span>
                {chip}
            </motion.div>
        </PaneReveal>
    );
}

function SubagentChip({ line, onOpen }: { line: Extract<SubagentNowLine, { kind: "chip" }>; onOpen: () => void }) {
    return (
        <button
            type="button"
            data-subagent-chip
            title={`Open ${line.sub.description ?? line.sub.type}`}
            onClick={onOpen}
            className="ml-auto min-w-0 cursor-pointer truncate rounded-[6px] border border-edge-mid px-[7px] py-px font-mono text-[11px] text-ink-mid hover:text-foreground"
        >
            <TickNumber value={line.count} format={subagentChipText} />
        </button>
    );
}

/** The idle parent's line: its most recent running background subagent as a button that opens it, and with more
 *  than one, how many run. */
function SubagentLine({ line, onOpen }: { line: SubagentNowLine; onOpen: () => void }) {
    const named = line.kind === "named" ? line : null;
    return (
        <PaneReveal open={named != null} variants={composerReveal}>
            {named != null ? (
                <div data-subagent-nowline className="mt-2 flex min-w-0 items-center gap-2 text-[13px] text-muted">
                    {/* a change of the named subagent cross-fades */}
                    <CrossFade swapKey={named.sub.id} className="min-w-0">
                        <button
                            type="button"
                            data-subagent-named={named.sub.id}
                            onClick={onOpen}
                            className="flex min-w-0 cursor-pointer items-center gap-2 text-left hover:text-ink-mid"
                        >
                            <LoaderCircle
                                size={14}
                                strokeWidth={2.2}
                                role="img"
                                aria-label="Running"
                                className="shrink-0 animate-spin text-ink-mid"
                            />
                            <span className="shrink-0 text-secondary">{named.sub.type}</span>
                            {/* two of one type read apart only by what they were asked to do */}
                            {named.sub.description ? (
                                <span data-subagent-description className="min-w-0 truncate text-ink-hi">
                                    {named.sub.description}
                                </span>
                            ) : null}
                            {named.call != null ? (
                                // the call gives way before the description
                                <span data-subagent-call className="min-w-0 shrink-[100] truncate text-ink-mid">
                                    {named.call.title}
                                    {named.call.mono != null ? (
                                        <span className="ml-[1ch] font-mono text-[12.5px] text-muted">
                                            {named.call.mono}
                                        </span>
                                    ) : null}
                                </span>
                            ) : null}
                            {named.elapsedMs != null ? (
                                <span
                                    data-subagent-elapsed
                                    className="shrink-0 whitespace-nowrap font-mono text-[12.5px]"
                                >
                                    · {fmtDuration(named.elapsedMs)}
                                </span>
                            ) : null}
                        </button>
                    </CrossFade>
                    {named.count != null ? (
                        <span data-subagent-count className="ml-auto shrink-0 whitespace-nowrap">
                            <TickNumber value={named.count} format={subagentsRunningText} />
                        </span>
                    ) : null}
                </div>
            ) : null}
        </PaneReveal>
    );
}

export function LiveWorkingLine({
    nowAtom,
    blockId,
    state,
    entries,
    compact,
    agentId,
}: {
    nowAtom: Atom<number>;
    blockId: string;
    state: AgentState;
    entries: AgentEntry[];
    compact?: boolean;
    // the agent whose running background subagents the line draws; unset in compact hosts
    agentId?: string;
}) {
    const now = useAtomValue(nowAtom);
    const oref = `block:${blockId}`;
    const lastHook = useAtomValue(getLastHookAtom(oref));
    // a pending permission request docks under the column and holds the slot; an ask hides the line by state
    const permissions = useAtomValue(getAgentPermissionsAtom(oref));
    // the screen is only read while working; a terminal not yet mounted reads as no spinner
    const rows = state === "working" ? screenRows(blockId) : null;
    const line = nowLineState({
        state,
        docked: permissions.length > 0,
        entries,
        spinner: rows == null ? null : parseSpinner(rows),
        lastHook,
        now,
    });
    const subagents = useAtomValue(subagentsByIdAtom)[agentId ?? ""] ?? NO_SUBAGENTS;
    const subLine = agentId == null ? HIDDEN : subagentNowLine(subagents, line.kind === "working", now);
    const open = () => {
        if (subLine.kind !== "hidden" && agentId != null) {
            openSubagent(agentId, subLine.sub);
        }
    };
    const chip = subLine.kind === "chip" ? <SubagentChip line={subLine} onOpen={open} /> : undefined;
    return (
        <>
            <WorkingLine line={line} compact={compact} chip={chip} />
            {agentId != null ? <SubagentLine line={subLine} onOpen={open} /> : null}
        </>
    );
}

/** Whether a host's timeline lays out its last turn as live: the agent is busy and the transcript has caught up with
 *  the turn the last hook opened. */
export function useTurnLive(blockId: string | undefined, busy: boolean, entries: AgentEntry[]): boolean {
    const lastHook = useAtomValue(getLastHookAtom(blockId ? `block:${blockId}` : ""));
    return busy && !turnAwaitingTranscript(entries, lastHook);
}

/** The working line as a host's timeline tail, memoised on what it reads so the timeline's memo holds between turns
 *  (each agent:status rebuilds the AgentVM). Null for an agent with no terminal block. */
export function useWorkingTail(
    nowAtom: Atom<number>,
    agent: Pick<AgentVM, "id" | "blockId" | "state">,
    entries: AgentEntry[],
    compact?: boolean
): React.ReactNode {
    const { blockId, state } = agent;
    // only the Rendered view (non-compact) draws the agent's running background subagents
    const agentId = compact ? undefined : agent.id;
    return useMemo(
        () =>
            blockId == null ? null : (
                <LiveWorkingLine
                    nowAtom={nowAtom}
                    blockId={blockId}
                    state={state}
                    entries={entries}
                    compact={compact}
                    agentId={agentId}
                />
            ),
        [nowAtom, blockId, state, entries, compact, agentId]
    );
}
