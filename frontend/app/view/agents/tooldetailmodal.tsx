// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { FlexiModal } from "@/app/modals/modal";
import { modalsModel } from "@/app/store/modalmodel";
import { useEffect } from "react";
import type { AgentActionEntry } from "./agentsviewmodel";
import { ToolDetailBody } from "./narrationtimeline";
import { formatDuration } from "./tooldetail";

// Viewport-level full-detail view for one tool call. Pushed via
// modalsModel.pushModal("AgentToolDetailModal", { action }). The card is overflow-hidden, so detail
// that exceeds the inline budget escalates here where there is room. Reuses ToolDetailBody (shared
// with the inline view). Uses FlexiModal (the pushModal-stack shell, per ConfirmModal) — NOT
// ModalShell, which owns its own `open` state and is for direct-render overlays.
export function AgentToolDetailModal({ action }: { action: AgentActionEntry }) {
    const close = () => modalsModel.popModal();
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                close();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);
    const ok = action.outcome !== "fail";
    return (
        <FlexiModal className="w-[min(720px,90vw)]" onClickBackdrop={close}>
            <div className="flex items-center gap-2.5 border-b border-edge-faint pb-3">
                <span className={ok ? "text-success" : "text-error"}>{ok ? "✓" : "✗"}</span>
                <span className="font-mono text-[8.5px] font-bold uppercase tracking-[0.06em] text-feed-label">
                    {action.verb}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-primary">{action.target}</span>
                {action.durationMs ? (
                    <span className="font-mono text-[11px] text-muted">{formatDuration(action.durationMs)}</span>
                ) : null}
                <button
                    type="button"
                    onClick={close}
                    className="rounded-[7px] border border-edge-mid px-2 py-1 text-muted hover:text-primary"
                >
                    ✕
                </button>
            </div>
            <div className="mt-3 max-h-[70vh] overflow-y-auto rounded-[10px] border border-edge-faint bg-surface-code">
                {action.detail ? <ToolDetailBody detail={action.detail} variant="modal" /> : null}
            </div>
        </FlexiModal>
    );
}
