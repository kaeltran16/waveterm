// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { ModalShell } from "@/app/modals/modalshell";
import { modalsModel } from "@/app/store/modalmodel";
import { cn } from "@/util/util";
import { X } from "lucide-react";
import type { AgentActionEntry } from "./agentsviewmodel";
import { formatDuration } from "./tooldetail";
import { CODE_TEXT, StatusSquare, ToolDetailBody } from "./tooldetailbody";
import { stepTitle } from "./transcriptlayout";

// a failed or blocked call's mark as a word, as the step row draws it; a successful call has none (a square read as
// a checkbox), and a call with no result yet keeps its pending square
function OutcomeMark({ action }: { action: AgentActionEntry }) {
    if (action.outcome === "fail") {
        const exit = action.detail?.kind === "bash" ? action.detail.exit : null;
        return (
            <span className="shrink-0 rounded-[4px] bg-error/15 px-1.5 py-px font-mono text-[11px] text-error">
                {exit ? `exit ${exit}` : "failed"}
            </span>
        );
    }
    if (action.outcome === "blocked") {
        return <span className="shrink-0 text-[12px] text-muted">blocked</span>;
    }
    return action.pending ? <StatusSquare ok pending /> : null;
}

// Viewport-level full-detail view for one tool call. Pushed via
// modalsModel.pushModal("AgentToolDetailModal", { action }). The card is overflow-hidden, so detail
// that exceeds the inline budget escalates here where there is room: wide, with long lines whole and scrolled
// sideways. Reuses ToolDetailBody (shared with the inline view), the outcome word and the step row's title and
// command, so the modal reads as that row opened. A failed call leads with its error.
// Rides the shared ModalShell chrome (scrim, motion, Esc), like every modal; the body runs edge to edge
// inside it rather than as a second framed box.
export function AgentToolDetailModal({ action }: { action: AgentActionEntry }) {
    const close = () => modalsModel.popModal();
    const { title, mono } = stepTitle(action);
    return (
        <ModalShell open onClose={close} className="w-[min(1100px,90vw)]">
            <div data-tool-modal-head className="flex items-center gap-2.5 border-b border-border py-3 pl-[18px] pr-3">
                {title ? <span className="min-w-0 truncate text-[14px] text-primary">{title}</span> : null}
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-faint">{mono}</span>
                <OutcomeMark action={action} />
                {action.durationMs ? (
                    <span className="font-mono text-[11px] text-muted">{formatDuration(action.durationMs)}</span>
                ) : null}
                <button
                    type="button"
                    aria-label="Close"
                    onClick={close}
                    className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-[7px] text-muted hover:bg-surface-hover hover:text-primary"
                >
                    <X size={15} strokeWidth={2} />
                </button>
            </div>
            {action.error || action.detail ? (
                <div data-tool-modal-body className="max-h-[70vh] overflow-y-auto bg-surface-code">
                    {action.error ? (
                        <div
                            data-tool-error
                            className={cn(
                                "whitespace-pre-wrap border-b border-edge-faint px-4 py-3 font-mono leading-[1.6] [overflow-wrap:anywhere]",
                                CODE_TEXT,
                                action.outcome === "blocked" ? "text-muted" : "text-error"
                            )}
                        >
                            {action.error}
                        </div>
                    ) : null}
                    {action.detail ? <ToolDetailBody detail={action.detail} variant="modal" /> : null}
                </div>
            ) : null}
        </ModalShell>
    );
}
