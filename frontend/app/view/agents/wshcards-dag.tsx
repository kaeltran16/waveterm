// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// wsh jarvis dag calls about the run itself: plan submit, review verdicts, Final, completion, and the dag status view.

import type { TranscriptContext } from "./transcriptcontext";
import type { WshRenderers } from "./wshrenderers";

export const DAG_RENDERERS: WshRenderers = {};

export interface FinalVerdictCardProps {
    passed: boolean;
    round?: number;
    total?: number;
    sha?: string;
    text?: string;
    runId?: string;
    ctx: TranscriptContext;
    compact: boolean;
}

// Final's verdict, shared by the dag-final card and the run-finished wake
export function FinalVerdictCard({ passed, text }: FinalVerdictCardProps) {
    return (
        <div className="mt-2 rounded-[8px] border border-edge-mid bg-surface-raised px-3 py-2">
            <div className="font-sans text-[13px] font-semibold text-foreground">
                {passed ? "Final passed" : "Final failed"}
            </div>
            {text ? <div className="mt-1 whitespace-pre-wrap text-[12px] text-secondary">{text}</div> : null}
        </div>
    );
}
