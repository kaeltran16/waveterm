// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// A background shell task's output in the focused view's center pane, swapped in over the (kept-mounted)
// parent terminal as the subagent interior is. Re-reads the output file while the task runs; a task that
// finishes cleanly leaves the tree's list, and the pane keeps its last known snapshot so the output stays.

import { MOTION } from "@/app/element/motiontokens";
import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { isFailedExitLine, shellTaskStatus, visibleShellTasks, type ShellTask } from "./shelltasks";
import { focusShellTaskAtom, readShellTaskOutput, shellTasksByIdAtom, type FocusShellTask } from "./shelltasksstore";
import { JumpToLatestPill, useStickToBottom } from "./sticktobottom";

const OUTPUT_POLL_MS = 2000;
const NO_LINES: string[] = [];

const TONE_CLASS = { accent: "text-accent", error: "text-error", muted: "text-muted" } as const;

// a live task's output is re-read on a timer; turning not-live (a finish) re-runs the effect, which is
// the one last read that picks up the trailing exit line
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

export function ShellTaskPane({ focus, parentName }: { focus: FocusShellTask; parentName: string }) {
    const listed = visibleShellTasks(useAtomValue(shellTasksByIdAtom)[focus.parentId] ?? []).find(
        (t) => t.id === focus.taskId
    );
    // keyed by task id by the caller, so the snapshot never carries over to another task
    const lastRef = useRef<ShellTask | undefined>(listed);
    if (listed != null) {
        lastRef.current = listed;
    }
    const task = lastRef.current;
    const status = task != null ? shellTaskStatus(task, listed == null) : null;
    const lines = useTaskOutput(task?.outputPath, status?.live ?? false);
    const { scrollRef, onScroll, atBottom, jumpToBottom } = useStickToBottom(lines ?? NO_LINES);

    // focus set for a task never seen in the list has nothing to show
    useEffect(() => {
        if (task == null) {
            globalStore.set(focusShellTaskAtom, null);
        }
    }, [task]);

    if (task == null || status == null) {
        return null;
    }
    // Esc lives in the keybinding registry (shelltask:back in bindings.ts); the breadcrumb uses `back` directly
    const back = () => globalStore.set(focusShellTaskAtom, null);

    return (
        <motion.div
            data-shell-task-pane={task.id}
            className="flex min-h-0 flex-1 flex-col"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: MOTION.durMicro, ease: MOTION.easeFluid }}
        >
            <div className="flex shrink-0 items-center gap-2 border-b border-edge-mid bg-surface px-3 py-2 font-mono text-[11px]">
                <button
                    type="button"
                    onClick={back}
                    title="Back to parent (Esc)"
                    className="cursor-pointer text-muted hover:text-primary"
                >
                    ◂ {parentName}
                </button>
                <span className="text-edge-strong">›</span>
                <span className="min-w-0 truncate text-secondary">{task.description}</span>
                <span data-shell-task-state className={cn("ml-auto flex-none font-semibold", TONE_CLASS[status.tone])}>
                    {status.label}
                </span>
            </div>
            <div className="relative min-h-0 flex-1 bg-surface-code">
                <div
                    ref={scrollRef}
                    onScroll={onScroll}
                    className="h-full overflow-y-auto px-3 py-2 font-mono text-[11.5px] leading-[1.5]"
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
        </motion.div>
    );
}
