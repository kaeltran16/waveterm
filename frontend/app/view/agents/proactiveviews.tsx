// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// S3 proactive-resurfacing card: one "related prior work" suggestion surfaced on a
// run at dispatch. Informational + dismissible; non-navigating this cycle (no Tasks
// surface exists yet — same posture as ambientviews.RelevantDecisions). Marked
// visually as ambient so it never reads as a confirmed edge.

import { useAtomValue } from "jotai";
import { AmbientCard } from "./ambientcard";
import { dismissProactive, dismissedProactiveAtom, readProactiveSuggestion } from "./proactive";

export function ProactiveCard({ run }: { run: Run }) {
    const dismissed = useAtomValue(dismissedProactiveAtom);
    const vm = readProactiveSuggestion(run);
    if (!vm || dismissed.has(run.oid)) {
        return null;
    }
    return (
        <AmbientCard
            eyebrow={`Related prior work · ${vm.sourceType}`}
            dismissLabel="Dismiss suggestion"
            onDismiss={() => dismissProactive(run)}
        >
            <div className="truncate text-[12.5px] font-semibold text-secondary" title={vm.title}>
                {vm.title}
            </div>
            {vm.snippet ? <div className="mt-0.5 line-clamp-2 text-[11px] text-muted">{vm.snippet}</div> : null}
        </AmbientCard>
    );
}
