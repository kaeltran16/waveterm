// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

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
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import type { ShellTask } from "./shelltasks";
import { readShellTaskOutput } from "./shelltasksstore";

const PEEK_POLL_MS = 2000;
// from a tree row's right edge past the tree's own 8px padding, so the peek sits 8px beside the tree
const PEEK_GAP_PX = 16;
const EXITED_LINE = /^\[exited with code (-?\d+)\]$/;

export function failedLabel(task: ShellTask): string {
    return task.exitCode != null ? `failed · exit ${task.exitCode}` : "failed";
}

function lineFailed(line: string, last: boolean): boolean {
    const code = last ? EXITED_LINE.exec(line.trim())?.[1] : undefined;
    return code != null && Number(code) !== 0;
}

// a running task's output is re-read while the peek is open; a failed one's is final
function useTaskOutput(path: string | undefined, running: boolean): string[] | null {
    const [lines, setLines] = useState<string[] | null>(null);
    useEffect(() => {
        if (!path) {
            setLines([]);
            return;
        }
        let live = true;
        const read = () => void readShellTaskOutput(path).then((l) => live && setLines(l));
        read();
        const timer = running ? setInterval(read, PEEK_POLL_MS) : undefined;
        return () => {
            live = false;
            clearInterval(timer);
        };
    }, [path, running]);
    return lines;
}

export function ShellTaskPeek({
    task,
    anchor,
    onClose,
}: {
    task: ShellTask;
    anchor: HTMLElement;
    onClose: () => void;
}) {
    const running = task.state === "running";
    const lines = useTaskOutput(task.outputPath, running);
    const { refs, floatingStyles, context } = useFloating({
        open: true,
        onOpenChange: (open) => !open && onClose(),
        elements: { reference: anchor },
        placement: "right-start",
        strategy: "fixed",
        middleware: [offset(PEEK_GAP_PX), shift({ padding: 8 })],
        whileElementsMounted: autoUpdate,
    });
    // the anchor row counts as inside, so clicking it again toggles the peek instead of reopening it
    const { getFloatingProps } = useInteractions([useDismiss(context)]);
    const tone = running ? "text-accent" : "text-error";

    return (
        <FloatingPortal>
            <div
                ref={refs.setFloating}
                style={floatingStyles}
                {...getFloatingProps()}
                data-shell-task-peek={task.id}
                className="z-[60] w-[460px] overflow-hidden rounded-[9px] border border-edge-strong bg-surface-raised shadow-popover-lg"
            >
                <div className="flex items-center gap-[8px] px-[10px] py-[8px]">
                    <span
                        className={cn("h-[7px] w-[7px] flex-none rounded-full", running ? "bg-accent" : "bg-error")}
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] font-medium text-secondary">
                        {task.description}
                    </span>
                    <span className={cn("flex-none font-mono text-[10.5px] font-semibold", tone)}>
                        {running ? "running" : failedLabel(task)}
                    </span>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close output"
                        className="flex h-[20px] w-[20px] flex-none cursor-pointer items-center justify-center text-muted hover:text-secondary"
                    >
                        <X size={13} aria-hidden />
                    </button>
                </div>
                <div className="max-h-[220px] overflow-auto border-t border-edge-mid bg-surface-code p-[10px] font-mono text-[11.5px] leading-[1.5]">
                    {lines != null && lines.length === 0 ? (
                        <div className="text-muted">No output yet.</div>
                    ) : (
                        (lines ?? []).map((line, i) => (
                            <div
                                key={i}
                                className={cn(
                                    "whitespace-pre-wrap break-words",
                                    lineFailed(line, i === lines.length - 1) ? "text-error" : "text-secondary"
                                )}
                            >
                                {line}
                            </div>
                        ))
                    )}
                </div>
                <div className="flex items-center gap-[8px] border-t border-edge-mid px-[10px] py-[6px] font-mono text-[10.5px] text-muted">
                    <span className="min-w-0 flex-1 truncate">{`…\\tasks\\${task.id}.output`}</span>
                    <span className="flex-none">{running ? "last 4 KB · live" : "last 4 KB"}</span>
                </div>
            </div>
        </FloatingPortal>
    );
}
