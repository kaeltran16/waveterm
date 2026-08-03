// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The correction controls for one attribution edge. Rendered wherever an edge is drawn — a channel's
// record band lists a run's records, a record lists its runs — so the same gesture reaches the same edge
// from either end.

import { modalsModel } from "@/app/store/modalmodel";
import { cn } from "@/util/util";
import { Check, RotateCcw, X } from "lucide-react";
import { edgeControls } from "./edgecontrols";
import { acceptEdge, detachEdge } from "./recordactions";

const BTN = "flex cursor-pointer items-center gap-1 rounded-[6px] px-1.5 py-0.5 text-[10.5px] font-semibold";

export function EdgeControls({
    dossierId,
    runORef,
    state,
    subjectLabel,
}: {
    dossierId: string;
    runORef: string;
    state: string;
    // what the confirm dialog names — the record from a run's row, the run from a record's row
    subjectLabel: string;
}) {
    const c = edgeControls(state);
    const detach = () => {
        if (!c.confirmFirst) {
            detachEdge(dossierId, runORef);
            return;
        }
        modalsModel.pushModal("ConfirmModal", {
            title: "Detach a confirmed attribution",
            message: `The worker reported ${subjectLabel} itself when it finished. Detaching overrides that. You can restore it from the Detached group.`,
            confirmLabel: "Detach",
            destructive: true,
            onConfirm: () => detachEdge(dossierId, runORef),
        });
    };
    return (
        <span className="flex flex-none items-center gap-1">
            {c.confirm ? (
                <button
                    type="button"
                    onClick={() => acceptEdge(dossierId, runORef)}
                    className={cn(BTN, "text-muted hover:bg-surface-hover hover:text-success")}
                >
                    <Check size={11} strokeWidth={2.5} />
                    Confirm
                </button>
            ) : null}
            {c.detach ? (
                <button
                    type="button"
                    onClick={detach}
                    className={cn(BTN, "text-muted hover:bg-surface-hover hover:text-error")}
                >
                    <X size={11} strokeWidth={2.5} />
                    Not this record
                </button>
            ) : null}
            {c.restore ? (
                <button
                    type="button"
                    onClick={() => acceptEdge(dossierId, runORef)}
                    className={cn(BTN, "text-muted hover:bg-surface-hover hover:text-accent")}
                >
                    <RotateCcw size={11} strokeWidth={2.5} />
                    Restore
                </button>
            ) : null}
        </span>
    );
}
