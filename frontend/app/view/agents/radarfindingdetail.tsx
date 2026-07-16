// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget } from "@/util/util";
import { ArrowRight, Target } from "lucide-react";
import type { AgentsViewModel } from "./agents";
import {
    findingSignalCount,
    findingSourceCount,
    groupMeta,
    referencedSignals,
    strengthPips,
    timelineEntries,
    toPendingRunDraft,
} from "./radarmodel";
import { severityPill, collectorText, TONE_DOT, TONE_TEXT } from "./radarstyles";
import { pendingRunDraftAtom, pendingRunFocusAtom } from "./runactions";
import { setDisposition } from "./radarstore";

// Diff-renderer decision (plan D3 Step 1): RadarSignal.snippet is a plain unified-diff string, and the
// repo's diff components both require structured input, not a raw patch. Per the plan we render the
// verbatim specimen in a <pre> with shared surface styling rather than introducing a second diff parser.

const DISMISS_REASONS = ["False positive", "Low priority", "Resolved elsewhere"];

// Source facts (chips, files, timeline, diff) render in neutral surface styling; Radar's own
// interpretation renders in a labelled accent block so the two are never confused.
function Section({ title, meta, children }: { title: string; meta?: string; children: React.ReactNode }) {
    return (
        <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>
                {meta ? <span className="rounded-full bg-surface px-2 text-[10px] text-muted-foreground">{meta}</span> : null}
            </div>
            {children}
        </div>
    );
}

function formatDate(ts: number): string {
    if (!ts) {
        return "";
    }
    return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function RadarFindingDetail({ model, report, finding }: { model: AgentsViewModel; report: RadarReport; finding: RadarFinding }) {
    const referenced = referencedSignals(finding, report);
    const timeline = timelineEntries(finding, report);
    const meta = groupMeta(finding.group);
    const dismissed = finding.disposition?.action === "dismiss";
    const suppressed = finding.disposition?.action === "suppress";
    const pips = strengthPips(finding.strength);

    const dispose = (action: string, reason?: string, note?: string) =>
        fireAndForget(() => setDisposition(report.oid, finding.id, action, reason, note));

    const startInvestigation = () => {
        globalStore.set(pendingRunDraftAtom, toPendingRunDraft(report, finding));
        globalStore.set(model.surfaceAtom, "channels");
    };

    const inv = finding.investigation;
    const openRun = () => {
        if (!inv) {
            return;
        }
        globalStore.set(pendingRunFocusAtom, { channelId: inv.channelid, runId: inv.runid });
        globalStore.set(model.surfaceAtom, "channels");
    };
    const stillDetected = finding.group === "new" || finding.group === "recurring";

    return (
        <div className="flex min-w-0 flex-1 flex-col gap-6 overflow-y-auto p-6">
            {/* status row */}
            <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className={cn("flex items-center gap-1.5 rounded px-2 py-0.5 font-semibold uppercase tracking-wide", TONE_TEXT[meta.tone])}>
                        <span className={cn("h-1.5 w-1.5 rounded-full", TONE_DOT[meta.tone])} />
                        {meta.label}
                    </span>
                    <span className={cn("rounded px-2 py-0.5 font-semibold uppercase tracking-wide", severityPill(finding.severity))}>
                        {finding.severity} severity
                    </span>
                    <span className="flex items-center gap-1.5 rounded bg-surface px-2 py-0.5 text-muted-foreground">
                        evidence
                        <span className="flex gap-0.5">
                            {[0, 1, 2].map((i) => (
                                <span key={i} className={cn("h-2.5 w-1 rounded-[1px]", i < pips ? "bg-accent-soft" : "bg-border")} />
                            ))}
                        </span>
                        <span className="uppercase tracking-wide">{finding.strength}</span>
                    </span>
                    <span className="flex-1" />
                    <span className="font-mono text-[11px] text-muted">{finding.subsystem}</span>
                </div>
                <h2 className="text-xl font-bold tracking-tight text-primary">{finding.risk}</h2>
            </div>

            <Section title="Why it matters">
                <p className="text-sm leading-relaxed text-muted-foreground">{finding.why}</p>
            </Section>

            <Section title="Supporting evidence" meta={`${findingSignalCount(finding)} signals · ${findingSourceCount(finding, report)} sources`}>
                {referenced.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                        {referenced.map((s) => (
                            <div key={s.id} className="flex items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5">
                                <span className={cn("text-[9px] font-bold uppercase tracking-wide", collectorText(s.collector))}>
                                    {s.collector}
                                </span>
                                <div className="min-w-0">
                                    <div className="truncate text-xs text-primary">{s.summary}</div>
                                    <div className="font-mono text-[10px] text-muted">{s.sourceref}</div>
                                </div>
                            </div>
                        ))}
                    </div>
                ) : (
                    <p className="text-xs text-muted">No linked signals.</p>
                )}
            </Section>

            {/* affected files — paths only; the backend does not carry per-file change counts */}
            {finding.files.length > 0 ? (
                <div className="overflow-hidden rounded-md border border-border">
                    <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2">
                        <span className="text-[10px] font-bold uppercase tracking-wide text-muted">Affected files</span>
                        <span className="font-mono text-[10px] text-muted">{finding.files.length}</span>
                    </div>
                    <ul>
                        {finding.files.map((f) => (
                            <li key={f} className="border-b border-border px-3 py-1.5 font-mono text-xs text-muted-foreground last:border-b-0">
                                {f}
                            </li>
                        ))}
                    </ul>
                </div>
            ) : null}

            {/* signals timeline */}
            {timeline.length > 0 ? (
                <Section title="Signals timeline">
                    <div className="flex flex-col">
                        {timeline.map((t, i) => (
                            <div key={i} className="flex gap-3">
                                <div className="flex flex-col items-center">
                                    <span className={cn("mt-1 h-2 w-2 shrink-0 rounded-full", TONE_DOT.new)} />
                                    {i < timeline.length - 1 ? <span className="w-px flex-1 bg-border" /> : null}
                                </div>
                                <div className="min-w-0 pb-3">
                                    <div className={cn("font-mono text-[10px]", collectorText(t.collector))}>
                                        {formatDate(t.ts)} · {t.collector}
                                    </div>
                                    <div className="text-xs leading-relaxed text-muted-foreground">{t.summary}</div>
                                </div>
                            </div>
                        ))}
                    </div>
                </Section>
            ) : null}

            {/* verbatim diff specimens (rendered as <pre>, per plan D3) */}
            {referenced
                .filter((s) => s.snippet)
                .map((s) => (
                    <div key={s.id} className="overflow-hidden rounded-md border border-border">
                        <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-1.5">
                            <span className="text-[9px] font-bold uppercase tracking-wide text-muted">Verbatim diff</span>
                            <span className="font-mono text-[10px] text-muted">{s.sourceref}</span>
                        </div>
                        <pre className="overflow-x-auto p-3 font-mono text-xs text-muted-foreground">{s.snippet}</pre>
                    </div>
                ))}

            {/* Radar interpretation — labelled + visually distinct from the source facts above */}
            <div className="rounded-md border border-dashed border-accent/40 bg-accent/5 p-4">
                <div className="mb-2 flex items-center gap-2">
                    <Target className="h-3.5 w-3.5 text-accent-soft" />
                    <span className="text-[10px] font-bold uppercase tracking-wider text-accent-soft">Suggested investigation</span>
                </div>
                <p className="text-sm leading-relaxed text-foreground">{finding.mission}</p>
                <p className="mt-2 text-[10px] text-muted">Interpretation generated by Radar — not part of the evidence above.</p>
            </div>

            {inv ? (
                <div className="rounded-md border border-border p-4">
                    <div className="mb-2 flex items-center gap-2">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-muted">Investigation</span>
                        {inv.status === "executing" ? (
                            <span className="flex items-center gap-1.5 text-[11px] font-semibold text-accent-soft">
                                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent-soft" />
                                Investigating…
                            </span>
                        ) : inv.status === "done" ? (
                            <span className={cn("text-[11px] font-semibold", stillDetected ? TONE_TEXT.recurring : TONE_TEXT.nolonger)}>
                                {stillDetected ? "Investigated — still detected" : "Investigated"}
                            </span>
                        ) : (
                            <span className="text-[11px] font-semibold text-muted">
                                {inv.status === "cancelled" ? "Investigation cancelled" : "Investigation failed"}
                            </span>
                        )}
                        <span className="flex-1" />
                        <button
                            type="button"
                            onClick={openRun}
                            className="rounded border border-border px-2 py-1 text-[11px] text-muted-foreground hover:border-edge-strong hover:text-primary"
                        >
                            Open run
                        </button>
                    </div>
                    {inv.status === "done" ? (
                        <div className="flex flex-wrap items-center gap-3 font-mono text-[11px] text-muted-foreground">
                            <span>{inv.filestouched ?? 0} {(inv.filestouched ?? 0) === 1 ? "file" : "files"}</span>
                            <span className="text-accent-soft">+{inv.addtotal ?? 0}</span>
                            <span className="text-muted">−{inv.deltotal ?? 0}</span>
                            <span>{inv.verifspass ?? 0} pass</span>
                            {(inv.verifsfail ?? 0) > 0 ? <span className={TONE_TEXT.recurring}>{inv.verifsfail} fail</span> : null}
                        </div>
                    ) : null}
                    {inv.summary ? <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{inv.summary}</p> : null}
                </div>
            ) : null}

            {/* actions */}
            <div className="flex flex-col gap-3">
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={startInvestigation}
                        className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-background hover:bg-accent/90"
                    >
                        {inv ? "Investigate again" : "Start investigation"}
                        <ArrowRight className="h-3.5 w-3.5" />
                    </button>
                    {dismissed || suppressed ? (
                        <button
                            type="button"
                            onClick={() => dispose(dismissed ? "reopen" : "unsuppress")}
                            className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-surface-hover"
                        >
                            {dismissed ? "Reopen finding" : "Unsuppress pattern"}
                        </button>
                    ) : null}
                </div>

                {!dismissed && !suppressed ? (
                    <div className="flex flex-col gap-3 sm:flex-row">
                        <div className="flex-1 rounded-md border border-border p-3">
                            <div className="mb-1 flex items-center gap-2">
                                <span className="text-xs font-semibold text-primary">Dismiss</span>
                                <span className="font-mono text-[10px] text-muted">this finding</span>
                            </div>
                            <p className="mb-2 text-[11px] leading-relaxed text-muted">
                                Closes this one finding with a reason. Re-appears if new evidence arrives.
                            </p>
                            <div className="flex flex-wrap gap-1.5">
                                {DISMISS_REASONS.map((r) => (
                                    <button
                                        key={r}
                                        type="button"
                                        onClick={() => dispose("dismiss", r)}
                                        className="rounded border border-border px-2 py-1 font-mono text-[10px] text-muted-foreground hover:border-edge-strong hover:text-primary"
                                    >
                                        {r}
                                    </button>
                                ))}
                            </div>
                            {inv?.status === "done" ? (
                                <button
                                    type="button"
                                    onClick={() => dispose("dismiss", "Resolved by investigation", `addressed by run ${inv.runid}`)}
                                    className="mt-2 rounded border border-border px-2 py-1 font-mono text-[10px] text-muted-foreground hover:border-edge-strong hover:text-primary"
                                >
                                    Addressed by run
                                </button>
                            ) : null}
                        </div>
                        <div className="flex-1 rounded-md border border-border p-3">
                            <div className="mb-1 flex items-center gap-2">
                                <span className="text-xs font-semibold text-primary">Suppress pattern</span>
                                <span className="font-mono text-[10px] text-muted">{finding.fingerprint}</span>
                            </div>
                            <p className="mb-2 text-[11px] leading-relaxed text-muted">
                                Hides future findings with this fingerprint until materially different evidence appears.
                            </p>
                            <button
                                type="button"
                                onClick={() => dispose("suppress")}
                                className="rounded border border-border px-2.5 py-1 text-[11px] font-semibold text-muted-foreground hover:border-edge-strong hover:text-primary"
                            >
                                Suppress this pattern
                            </button>
                        </div>
                    </div>
                ) : null}

                <p className="text-[11px] leading-relaxed text-muted">
                    Radar does not edit files, run tests, or launch agents on its own — starting an investigation is the only
                    action that spins up a Run.
                </p>
            </div>
        </div>
    );
}
