// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { fireAndForget } from "@/util/util";
import { buildRunDraft } from "./radarmodel";
import { setDisposition } from "./radarstore";

// Diff-renderer decision (plan D3 Step 1): RadarSignal.snippet is a plain unified-diff string, and the
// repo's diff components (codeeditor/diffviewer.tsx = Monaco needing original+modified content and a
// blockId; filessurface's gitdiff = DiffLine[] parser) both require structured input, not a raw patch.
// Per the plan we render the verbatim specimen in a <pre> with shared surface styling rather than
// introducing a second diff parser. No diff-renderer import is used.

// Source facts (diff specimen, files, timeline) render in neutral surface styling; Radar's own
// interpretation renders in a labelled accent-bordered block so the two are never confused.
function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>
            {children}
        </div>
    );
}

export function RadarFindingDetail({ report, finding }: { report: RadarReport; finding: RadarFinding }) {
    const signalsById = new Map((report.signals ?? []).map((s) => [s.id, s]));
    const referenced = finding.signalids.map((id) => signalsById.get(id)).filter(Boolean) as RadarSignal[];
    const dismissed = finding.disposition?.action === "dismiss";
    const suppressed = finding.disposition?.action === "suppress";
    const draft = buildRunDraft(report, finding); // built for the deferred handoff; payload is ready

    const dispose = (action: string) => fireAndForget(() => setDisposition(report.oid, finding.id, action));

    return (
        <div className="flex min-w-0 flex-1 flex-col gap-6 overflow-y-auto p-6">
            <div className="flex flex-col gap-2">
                <div className="flex gap-2 text-xs text-muted-foreground">
                    <span className="rounded bg-surface px-2 py-0.5">{finding.riskkind}</span>
                    <span className="rounded bg-surface px-2 py-0.5">{finding.severity}</span>
                    <span className="rounded bg-surface px-2 py-0.5">{finding.strength}</span>
                    {finding.boundarylabel ? <span className="rounded bg-surface px-2 py-0.5">{finding.boundarylabel}</span> : null}
                </div>
                <h2 className="text-lg font-bold tracking-tight text-primary">{finding.risk}</h2>
            </div>

            <Section title="Why it matters">
                <p className="text-sm text-muted-foreground">{finding.why}</p>
            </Section>

            <Section title="Evidence">
                <div className="flex flex-wrap gap-1.5">
                    {referenced.map((s) => (
                        <span key={s.id} className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground" title={s.summary}>
                            {s.collector}
                        </span>
                    ))}
                </div>
                {finding.files.length > 0 ? (
                    <ul className="mt-2 flex flex-col gap-1">
                        {finding.files.map((f) => (
                            <li key={f} className="font-mono text-xs text-muted-foreground">{f}</li>
                        ))}
                    </ul>
                ) : null}
                {referenced
                    .filter((s) => s.snippet)
                    .map((s) => (
                        <pre key={s.id} className="mt-2 overflow-x-auto rounded-md border border-border bg-surface p-3 font-mono text-xs text-muted-foreground">
                            {s.snippet}
                        </pre>
                    ))}
            </Section>

            {/* Radar interpretation — visually distinct from the source facts above */}
            <div className="rounded-md border-l-2 border-accent bg-accent/5 p-3">
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-accent-soft">Radar interpretation</h3>
                <p className="text-sm text-muted-foreground">Suggested mission: {finding.mission}</p>
            </div>

            <div className="flex items-center gap-2">
                {/* Start investigation is deferred (docs/deferred.md): draft is built but the Channels composer isn't wired */}
                <button
                    type="button"
                    disabled
                    title="Start investigation opens a prefilled Run in Channels — coming soon"
                    className="cursor-not-allowed rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-background opacity-50"
                    data-run-draft-finding={draft.findingId}
                >
                    Start investigation
                </button>
                {dismissed || suppressed ? (
                    <button type="button" onClick={() => dispose(dismissed ? "reopen" : "unsuppress")} className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground">
                        {dismissed ? "Undo dismiss" : "Unsuppress"}
                    </button>
                ) : (
                    <>
                        <button type="button" onClick={() => dispose("dismiss")} className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground">Dismiss</button>
                        <button type="button" onClick={() => dispose("suppress")} className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground">Suppress</button>
                    </>
                )}
            </div>
        </div>
    );
}
