// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The working line, drawn as the transcript's tail under its last item (nowline.ts derives it). WorkingLine is a pure
// view of a NowLine; LiveWorkingLine reads the 1s clock, the block's last hook, its permission requests and the
// spinner row on its terminal, so the host's memoised timeline does not re-render on each tick.

import { CrossFade } from "@/app/element/crossfade";
import { microFade } from "@/app/element/motiontokens";
import { atoms } from "@/app/store/global";
import { screenRows } from "@/app/view/term/termscreen";
import { cn } from "@/util/util";
import { useAtomValue, type Atom } from "jotai";
import { animate, motion, useMotionValue, useTransform, type MotionStyle } from "motion/react";
import { useEffect, useMemo, type CSSProperties } from "react";
import type { AgentEntry, AgentState, AgentVM } from "./agentsviewmodel";
import {
    GLYPH_CYCLE_MS,
    glyphPose,
    nowLineState,
    nowLineText,
    SHIMMER_HALF_CH,
    shimmerSweep,
    type NowLine,
} from "./nowline";
import { getAgentPermissionsAtom } from "./permissionstore";
import { getLastHookAtom } from "./session-models/agentstatusstore";
import { parseSpinner } from "./spinnerrow";

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

export function WorkingLine({ line, compact = false }: { line: NowLine; compact?: boolean }) {
    const { verb, rest } = nowLineText(line, compact);
    const spinner = useSpinnerMotion(verb?.length ?? null);
    if (line.kind === "hidden") {
        return null;
    }
    return (
        <motion.div
            style={spinner.animated ? ({ "--shimmer": spinner.shimmer } as MotionStyle) : undefined}
            data-working-line
            data-compact={compact || undefined}
            variants={microFade}
            initial="initial"
            animate="animate"
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
        </motion.div>
    );
}

export function LiveWorkingLine({
    nowAtom,
    blockId,
    state,
    entries,
    compact,
}: {
    nowAtom: Atom<number>;
    blockId: string;
    state: AgentState;
    entries: AgentEntry[];
    compact?: boolean;
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
    return <WorkingLine line={line} compact={compact} />;
}

/** The working line as a host's timeline tail, memoised on what it reads so the timeline's memo holds between turns
 *  (each agent:status rebuilds the AgentVM). Null for an agent with no terminal block. */
export function useWorkingTail(
    nowAtom: Atom<number>,
    agent: Pick<AgentVM, "blockId" | "state">,
    entries: AgentEntry[],
    compact?: boolean
): React.ReactNode {
    const { blockId, state } = agent;
    return useMemo(
        () =>
            blockId == null ? null : (
                <LiveWorkingLine
                    nowAtom={nowAtom}
                    blockId={blockId}
                    state={state}
                    entries={entries}
                    compact={compact}
                />
            ),
        [nowAtom, blockId, state, entries, compact]
    );
}
