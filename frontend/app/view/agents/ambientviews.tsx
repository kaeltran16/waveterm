// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Ambient attribution render bits: task tag chips (row-level) and a "relevant past decision" card block
// (detail-level). Read from the fixture provider; non-interactive (no Tasks surface exists in v1). Marked
// visually as ambient so it never reads as a confirmed edge. ageLabel is imported from ./ambient (inlined
// there) so this stays jarvis-free — agents must not import the jarvis view.

import { ageLabel, fixtureAmbientProvider } from "./ambient";

export function AmbientTags({ oref }: { oref: string }) {
    const tags = fixtureAmbientProvider.tagsFor(oref);
    if (tags.length === 0) {
        return null;
    }
    return (
        <span className="flex flex-wrap items-center gap-1">
            {tags.map((t) => (
                <span
                    key={t.taskId}
                    title="Ambient task attribution (placeholder)"
                    className="rounded-[4px] border border-edge-mid px-1.5 py-px font-mono text-[9px] uppercase tracking-[.06em] text-muted"
                >
                    {t.label}
                </span>
            ))}
        </span>
    );
}

export function RelevantDecisions({ oref }: { oref: string }) {
    const decisions = fixtureAmbientProvider.decisionsFor(oref);
    if (decisions.length === 0) {
        return null;
    }
    return (
        <div className="flex flex-col gap-1.5">
            <div className="font-mono text-[9px] font-semibold uppercase tracking-[.08em] text-muted">
                Relevant past decisions
            </div>
            {decisions.map((d) => (
                <div key={d.oref} className="rounded-[9px] border border-border bg-surface px-3 py-2">
                    <div className="text-[12.5px] font-semibold text-secondary">{d.title}</div>
                    <div className="text-[11px] text-muted">{ageLabel(d.ageMs)}</div>
                </div>
            ))}
        </div>
    );
}
