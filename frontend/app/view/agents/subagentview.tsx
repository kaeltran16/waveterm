// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// A subagent in the Agent surface's center, reached from every way in (its Agent step's Open, its finish notice, the
// tree row, the now line): its own transcript read back at full size the way an ended worker's is, live while it runs,
// under a banner naming it and its parent. A subagent takes no input, so there is no message box; its now line comes
// from its transcript (subagentviewmodel.ts), since it has no terminal spinner to read. The parent's view stays laid
// out under it, so "↑ parent" and Esc return to it where it was.

import { CrossFade } from "@/app/element/crossfade";
import { DrawCheck } from "@/app/element/drawcheck";
import { MOTION } from "@/app/element/motiontokens";
import { globalStore } from "@/app/store/jotaiStore";
import { useAtomValue, type Atom } from "jotai";
import { LoaderCircle, Square, X } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useMemo } from "react";
import type { AgentsViewModel } from "./agents";
import type { AgentEntry } from "./agentsviewmodel";
import { startTranscriptStream, stopTranscriptStream } from "./livetranscript";
import { entriesAtomFor } from "./livetranscriptatoms";
import { NarrationTimeline } from "./narrationtimeline";
import { TRANSCRIPT_COLUMN } from "./renderedview";
import type { SubagentVM } from "./session-models/sessionviewmodel";
import { JumpToLatestPill, useStickToBottom } from "./sticktobottom";
import type { SubagentOutcome } from "./subagentmodel";
import { focusSubagentAtom, subagentsByIdAtom, type FocusSubagent } from "./subagentsstore";
import { subagentBanner, subagentFromEntries, subagentViewLine } from "./subagentviewmodel";
import { transcriptContextFor } from "./transcriptcontext";
import { TranscriptSkeleton } from "./transcriptskeleton";

const ICON_SIZE = 12;

const back = () => globalStore.set(focusSubagentAtom, null);

// the parent's list entry for the child, else what its own transcript says
function useSubagent(focus: FocusSubagent, entries: AgentEntry[]): SubagentVM {
    const listed = useAtomValue(subagentsByIdAtom)[focus.parentId]?.find((s) => s.id === focus.agentId);
    return useMemo(() => listed ?? subagentFromEntries(focus, entries), [listed, focus, entries]);
}

// the check stays mounted, so a running child that finishes draws it on (moment 16)
function StateIcon({ outcome }: { outcome: SubagentOutcome }) {
    return (
        <span data-subagent-state={outcome} className="relative flex size-[12px] flex-none items-center justify-center">
            <DrawCheck done={outcome === "done"} className="absolute text-ink-mid" />
            {outcome === "running" ? (
                <LoaderCircle
                    size={ICON_SIZE}
                    strokeWidth={2.2}
                    aria-label="Running"
                    className="animate-spin text-ink-mid"
                />
            ) : outcome === "failed" ? (
                <X size={ICON_SIZE} strokeWidth={2.2} aria-label="Failed" className="text-error" />
            ) : outcome === "stopped" ? (
                <Square size={ICON_SIZE - 3} strokeWidth={2.2} aria-label="Stopped" className="text-muted" />
            ) : null}
        </span>
    );
}

function Banner({ sub, parentName, nowAtom }: { sub: SubagentVM; parentName: string; nowAtom: Atom<number> }) {
    const b = subagentBanner(sub, parentName, useAtomValue(nowAtom));
    return (
        <div
            data-subagent-banner
            className="mx-[22px] mt-[12px] flex flex-none items-center gap-[10px] rounded-[6px] border border-edge-mid bg-surface-raised px-[12px] py-[8px] font-mono text-[11px] text-muted"
        >
            <StateIcon outcome={b.outcome} />
            <span className="flex-none font-semibold text-ink-mid">{b.type}</span>
            <span className="min-w-0 truncate">{b.parent}</span>
            <span data-subagent-status className={b.outcome === "failed" ? "flex-none text-error" : "flex-none"}>
                {b.status}
            </span>
            <span className="flex-none">{b.tools}</span>
            <span className="min-w-0 flex-1 truncate">read-only</span>
            <button
                type="button"
                data-subagent-back
                onClick={back}
                title="Back to parent (Esc)"
                className="flex-none cursor-pointer rounded-[6px] px-[6px] py-[2px] font-semibold text-accent-soft hover:bg-surface-hover"
            >
                ↑ parent
            </button>
        </div>
    );
}

// the timeline's tail; reads the clock and the list itself, so the memoised timeline does not re-render on each tick
function SubagentNowLine({
    focus,
    entries,
    nowAtom,
}: {
    focus: FocusSubagent;
    entries: AgentEntry[];
    nowAtom: Atom<number>;
}) {
    const sub = useSubagent(focus, entries);
    const line = subagentViewLine(sub, useAtomValue(nowAtom));
    const running = sub.state === "working";
    return (
        <div data-subagent-now className="mt-2 flex min-w-0 items-center gap-2 text-[13px] text-muted">
            {running ? (
                <LoaderCircle
                    size={ICON_SIZE + 1}
                    strokeWidth={2.2}
                    aria-hidden
                    className="shrink-0 animate-spin text-ink-mid"
                />
            ) : null}
            {/* a new call, or the call ending, cross-fades in */}
            <CrossFade swapKey={`${line.title}\u0000${line.mono ?? ""}`} className="min-w-0 shrink gap-[6px]">
                <span data-subagent-now-title className="shrink-0 text-ink-mid">
                    {line.title}
                </span>
                {line.mono != null ? <span className="min-w-0 truncate font-mono text-[12px]">{line.mono}</span> : null}
            </CrossFade>
            <span data-subagent-now-facts className="shrink-0">
                {line.facts}
            </span>
        </div>
    );
}

export function SubagentView({
    model,
    focus,
    parentName,
}: {
    model: AgentsViewModel;
    focus: FocusSubagent;
    parentName: string;
}) {
    const streamId = `sub:${focus.agentId}`;
    useEffect(() => {
        startTranscriptStream(streamId, focus.transcriptPath, "claude");
        return () => stopTranscriptStream(streamId);
    }, [streamId, focus.transcriptPath]);

    const entries = useAtomValue(entriesAtomFor(streamId));
    const sub = useSubagent(focus, entries);
    const running = sub.state === "working";
    const { scrollRef, onScroll, atBottom, jumpToBottom } = useStickToBottom(entries);
    // a subagent holds no run role, so its first prompt (the parent's Agent call) is never read as an Arc brief
    const ctx = useMemo(() => transcriptContextFor({ model }), [model]);
    const tail = useMemo(
        () => <SubagentNowLine focus={focus} entries={entries} nowAtom={model.nowAtom} />,
        [focus, entries, model.nowAtom]
    );
    return (
        <motion.div
            data-subagent-view={focus.agentId}
            className="flex min-h-0 flex-1 flex-col"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: MOTION.durMicro, ease: MOTION.easeFluid }}
        >
            <Banner sub={sub} parentName={parentName} nowAtom={model.nowAtom} />
            <div className="relative min-h-0 flex-1">
                <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto px-[22px] py-[12px]">
                    <div className={TRANSCRIPT_COLUMN}>
                        {entries.length > 0 ? (
                            <NarrationTimeline
                                entries={entries}
                                renderers
                                thoughts
                                accentLatest
                                active={running}
                                ctx={ctx}
                                tail={tail}
                            />
                        ) : (
                            <TranscriptSkeleton />
                        )}
                    </div>
                </div>
                <JumpToLatestPill show={!atBottom} onClick={jumpToBottom} />
            </div>
        </motion.div>
    );
}
