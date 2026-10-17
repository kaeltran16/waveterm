// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { ModalShell } from "@/app/modals/modalshell";
import { modalsModel } from "@/app/store/modalmodel";
import { X } from "lucide-react";
import type { AgentActionEntry } from "./agentsviewmodel";
import { StatusSquare, ToolDetailBody, VERB } from "./narrationtimeline";
import { formatDuration } from "./tooldetail";

// Viewport-level full-detail view for one tool call. Pushed via
// modalsModel.pushModal("AgentToolDetailModal", { action }). The card is overflow-hidden, so detail
// that exceeds the inline budget escalates here where there is room. Reuses ToolDetailBody (shared
// with the inline view) and the row's own outcome mark and verb, so the modal reads as that row opened.
// Rides the shared ModalShell chrome (scrim, motion, Esc), like every modal; the body runs edge to edge
// inside it rather than as a second framed box.
export function AgentToolDetailModal({ action }: { action: AgentActionEntry }) {
    const close = () => modalsModel.popModal();
    return (
        <ModalShell open onClose={close} className="w-[min(720px,90vw)]">
            <div className="flex items-center gap-2.5 border-b border-border py-3 pl-[18px] pr-3">
                <StatusSquare ok={action.outcome !== "fail"} />
                <span className={VERB}>{action.verb}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-primary">{action.target}</span>
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
            {action.detail ? (
                <div className="max-h-[70vh] overflow-y-auto bg-surface-code">
                    <ToolDetailBody detail={action.detail} variant="modal" />
                </div>
            ) : null}
        </ModalShell>
    );
}
