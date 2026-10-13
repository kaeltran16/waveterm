// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// A background shell task's output in a floating peek beside its tree row. Re-reads the output file while
// the task runs and follows the tail. Esc closes it through the keybinding registry (shelltask:back).

import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import {
    autoUpdate,
    FloatingPortal,
    offset,
    shift,
    useDismiss,
    useFloating,
    useInteractions,
} from "@floating-ui/react";
import { useAtomValue } from "jotai";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import type { AgentsViewModel } from "./agents";
import { isFailedExitLine, OUTPUT_MAX_CHARS, shellTaskStatus, type ShellTask } from "./shelltasks";
import { readShellTaskOutput, shellTaskPeekAtom } from "./shelltasksstore";
import { JumpToLatestPill, useStickToBottom } from "./sticktobottom";

const OUTPUT_POLL_MS = 2000;
// from a tree row's right edge past the tree's own 8px padding, so the peek sits 8px beside the tree
const PEEK_GAP_PX = 16;
const NO_LINES: string[] = [];
const TAIL_LABEL = `last ${OUTPUT_MAX_CHARS / 1024} KB`;

const TONE_CLASS = { accent: "text-accent", error: "text-error" } as const;
const DOT_CLASS = { accent: "bg-accent", error: "bg-error" } as const;

// a live task's output is re-read on a timer; a failed one's is final
function useTaskOutput(path: string | undefined, live: boolean): string[] | null {
    const [lines, setLines] = useState<string[] | null>(null);
    useEffect(() => {
        if (!path) {
            setLines([]);
            return;
        }
        let mounted = true;
        const read = () => void readShellTaskOutput(path).then((l) => mounted && setLines(l));
        read();
        const timer = live ? setInterval(read, OUTPUT_POLL_MS) : undefined;
        return () => {
            mounted = false;
            clearInterval(timer);
        };
    }, [path, live]);
    return lines;
}

const close = () => globalStore.set(shellTaskPeekAtom, null);

export function ShellTaskPeek({
    model,
    task,
    anchor,
}: {
    model: AgentsViewModel;
    task: ShellTask;
    anchor: HTMLElement;
}) {
    const status = shellTaskStatus(task);
    const lines = useTaskOutput(task.outputPath, status.live);
    const { scrollRef, onScroll, atBottom, jumpToBottom } = useStickToBottom(lines ?? NO_LINES);
    const { refs, floatingStyles, context } = useFloating({
        open: true,
        onOpenChange: (open) => !open && close(),
        elements: { reference: anchor },
        placement: "right-start",
        strategy: "fixed",
        middleware: [offset(PEEK_GAP_PX), shift({ padding: 8 })],
        whileElementsMounted: autoUpdate,
    });
    // the anchor row counts as inside, so clicking it again toggles the peek instead of reopening it.
    // Esc is left to the registry, which would otherwise also run agent:back
    const { getFloatingProps } = useInteractions([useDismiss(context, { escapeKey: false })]);

    // the Agent surface stays mounted off-screen, and the portal would keep the peek over the next surface
    const surface = useAtomValue(model.surfaceAtom);
    useEffect(() => {
        if (surface !== "agent") {
            close();
        }
    }, [surface]);

    return (
        <FloatingPortal>
            <div
                ref={refs.setFloating}
                style={floatingStyles}
                {...getFloatingProps()}
                data-shell-task-peek={task.id}
                className="z-[60] w-[560px] overflow-hidden rounded-[9px] border border-edge-strong bg-surface-raised shadow-popover-lg"
            >
                <div className="flex items-center gap-[8px] px-[10px] py-[8px]">
                    <span className={cn("h-[7px] w-[7px] flex-none rounded-full", DOT_CLASS[status.tone])} />
                    <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] font-medium text-secondary">
                        {task.description}
                    </span>
                    <span
                        data-shell-task-state
                        className={cn("flex-none font-mono text-[10.5px] font-semibold", TONE_CLASS[status.tone])}
                    >
                        {status.label}
                    </span>
                    <button
                        type="button"
                        onClick={close}
                        aria-label="Close output"
                        className="flex h-[20px] w-[20px] flex-none cursor-pointer items-center justify-center text-muted hover:text-secondary"
                    >
                        <X size={13} aria-hidden />
                    </button>
                </div>
                <div className="relative border-t border-edge-mid bg-surface-code">
                    <div
                        ref={scrollRef}
                        onScroll={onScroll}
                        className="max-h-[360px] overflow-auto p-[10px] font-mono text-[11.5px] leading-[1.5]"
                    >
                        {lines != null && lines.length === 0 ? (
                            <div className="text-muted">No output yet.</div>
                        ) : (
                            (lines ?? NO_LINES).map((line, i) => (
                                <div
                                    key={i}
                                    className={cn(
                                        "whitespace-pre-wrap break-words",
                                        isFailedExitLine(line, i === lines.length - 1) ? "text-error" : "text-secondary"
                                    )}
                                >
                                    {line}
                                </div>
                            ))
                        )}
                    </div>
                    <JumpToLatestPill show={!atBottom} onClick={jumpToBottom} />
                </div>
                <div className="flex items-center gap-[8px] border-t border-edge-mid px-[10px] py-[6px] font-mono text-[10.5px] text-muted">
                    <span className="min-w-0 flex-1 truncate" title={task.outputPath}>
                        {task.outputPath?.split(/[\\/]/).pop()}
                    </span>
                    <span className="flex-none">{status.live ? `${TAIL_LABEL} · live` : TAIL_LABEL}</span>
                </div>
            </div>
        </FloatingPortal>
    );
}
