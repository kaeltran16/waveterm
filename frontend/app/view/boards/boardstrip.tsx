// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The strip above an open board's canvas, the same in the workspace board tab and the Boards surface: what the
// caller puts on its left (the drawings row), and the Edit switch pinned at its right end.

import { cn } from "@/util/util";
import { useAtom } from "jotai";
import { PenLine } from "lucide-react";
import type { ReactNode } from "react";
import { boardEditingAtom } from "./boardstore";

export function BoardStrip({ boardId, children }: { boardId: string; children?: ReactNode }) {
    const [editing, setEditing] = useAtom(boardEditingAtom(boardId));
    return (
        <div data-board-strip className="flex h-[38px] flex-none items-center gap-2 border-b border-border px-3">
            <div className="min-w-0 flex-1 overflow-x-auto">{children}</div>
            <button
                type="button"
                data-board-edit
                aria-pressed={editing}
                onClick={() => setEditing(!editing)}
                className={cn(
                    "inline-flex h-[26px] flex-none cursor-pointer items-center gap-[6px] rounded-[7px] border px-[10px] text-[12px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                    editing
                        ? "border-accent bg-accentbg text-primary"
                        : "border-edge-mid bg-surface text-secondary hover:border-edge-strong hover:bg-surface-hover"
                )}
            >
                <PenLine size={12} strokeWidth={2} aria-hidden />
                Edit
            </button>
        </div>
    );
}
