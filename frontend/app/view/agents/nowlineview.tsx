// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The working line, drawn as the transcript's tail under its last item (nowline.ts derives it). WorkingLine is a pure
// view of a NowLine; LiveWorkingLine reads the 1s clock, the block's last hook, its permission requests and the
// spinner row on its terminal, so the host's memoised timeline does not re-render on each tick.

import { CrossFade } from "@/app/element/crossfade";
import { microFade } from "@/app/element/motiontokens";
import { screenRows } from "@/app/view/term/termscreen";
import { cn } from "@/util/util";
import { useAtomValue, type Atom } from "jotai";
import { motion } from "motion/react";
import { useMemo } from "react";
import type { AgentEntry, AgentState, AgentVM } from "./agentsviewmodel";
import { nowLineState, nowLineText, type NowLine } from "./nowline";
import { getAgentPermissionsAtom } from "./permissionstore";
import { getLastHookAtom } from "./session-models/agentstatusstore";
import { parseSpinner } from "./spinnerrow";

const SPINNER_GLYPH = "✻";

export function WorkingLine({ line, compact = false }: { line: NowLine; compact?: boolean }) {
    if (line.kind === "hidden") {
        return null;
    }
    const { verb, rest } = nowLineText(line, compact);
    return (
        <motion.div
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
                // claude cycles the verb while it works; each new one cross-fades in
                <CrossFade swapKey={verb} className="shrink-0">
                    <span
                        data-working-verb
                        className={cn("font-mono text-provider-claude", compact ? "text-[11.5px]" : "text-[12.5px]")}
                    >
                        {/* a steady breathing glyph (pulse driver, 12fps) stands in for claude's cycling one */}
                        <span className="pulse-soft">{SPINNER_GLYPH}</span> {verb}
                    </span>
                </CrossFade>
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
