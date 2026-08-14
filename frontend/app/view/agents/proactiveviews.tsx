// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// S3 proactive-resurfacing card: one "related prior work" suggestion surfaced on a
// run at dispatch. Navigable when the suggestion maps to an oref (dossier -> jarvis
// dossier subject, memory -> Memory surface note); a decision hit has no nav kind, so it
// stays informational. Marked visually as ambient so it never reads as a confirmed edge.

import { useAtomValue } from "jotai";
import { openORef } from "@/app/view/jarvis/openref";
import type { AgentsViewModel } from "./agents";
import { AmbientCard } from "./ambientcard";
import { dismissProactive, dismissedProactiveAtom, proactiveNavOref, readProactiveSuggestion } from "./proactive";

export function ProactiveCard({ model, run }: { model: AgentsViewModel; run: Run }) {
    const dismissed = useAtomValue(dismissedProactiveAtom);
    const vm = readProactiveSuggestion(run);
    if (!vm || dismissed.has(run.oid)) {
        return null;
    }
    const oref = proactiveNavOref(vm);
    return (
        <AmbientCard
            eyebrow={`Related prior work · ${vm.sourceType}`}
            dismissLabel="Dismiss suggestion"
            onDismiss={() => dismissProactive(run)}
            onClick={oref != null ? () => void openORef(model, oref) : undefined}
        >
            <div className="truncate text-[12.5px] font-semibold text-secondary" title={vm.title}>
                {vm.title}
            </div>
            {vm.snippet ? <div className="mt-0.5 line-clamp-2 text-[11px] text-muted">{vm.snippet}</div> : null}
        </AmbientCard>
    );
}
