// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// S3 proactive-resurfacing card: one "related prior work" suggestion surfaced on a
// run at dispatch. Informational + dismissible; non-navigating this cycle (no Tasks
// surface exists yet — same posture as ambientviews.RelevantDecisions). Marked
// visually as ambient so it never reads as a confirmed edge.

import { useAtomValue } from "jotai";
import { dismissProactive, dismissedProactiveAtom, readProactiveSuggestion } from "./proactive";

export function ProactiveCard({ run }: { run: Run }) {
    const dismissed = useAtomValue(dismissedProactiveAtom);
    const vm = readProactiveSuggestion(run);
    if (!vm || dismissed.has(run.oid)) {
        return null;
    }
    return (
        <div className="mb-3 flex items-start gap-2 rounded-[9px] border border-border bg-surface px-3 py-2">
            <div className="min-w-0 flex-1">
                <div className="mb-0.5 font-mono text-[9px] font-semibold uppercase tracking-[.08em] text-muted">
                    Related prior work · {vm.sourceType}
                </div>
                <div className="truncate text-[12.5px] font-semibold text-secondary" title={vm.title}>
                    {vm.title}
                </div>
                {vm.snippet ? <div className="mt-0.5 line-clamp-2 text-[11px] text-muted">{vm.snippet}</div> : null}
            </div>
            <button
                type="button"
                aria-label="Dismiss suggestion"
                onClick={() => dismissProactive(run)}
                className="flex-none rounded-[4px] px-1.5 py-px text-[13px] leading-none text-muted hover:text-secondary"
            >
                ×
            </button>
        </div>
    );
}
