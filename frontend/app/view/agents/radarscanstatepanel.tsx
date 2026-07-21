// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn, fireAndForget } from "@/util/util";
import { AlertTriangle, CheckCircle2, Loader2, Radar, XCircle } from "lucide-react";
import { classifyCoverage, coverageEntries, type CoverageCell, type RadarScanState } from "./radarmodel";
import { cancelScan, retryClustering, startScan } from "./radarstore";

const COLLECTORS = ["structure", "git", "runs", "transcript", "memory", "config"];

const CELL_TONE: Record<CoverageCell, string> = {
    done: "text-success",
    running: "text-accent-soft",
    failed: "text-error",
    queued: "text-muted",
};

const EXAMINES = [
    "Source & test structure",
    "Recent commits & changed files",
    "Recent Runs and outcomes",
    "Agent failures, retries & corrections",
    "Project memory",
    "Config & migration boundaries",
];

function IconTile({ icon: Icon, tone, spin }: { icon: typeof Radar; tone: string; spin?: boolean }) {
    return (
        <div className={cn("flex h-14 w-14 items-center justify-center rounded-2xl border", tone)}>
            <Icon className={cn("h-7 w-7", spin && "animate-spin")} />
        </div>
    );
}

function CollectorChecklist({ report }: { report: RadarReport | null }) {
    const coverage = report ? Object.fromEntries(coverageEntries(report).map((e) => [e.collector, e.status])) : {};
    return (
        <ul className="w-full max-w-sm overflow-hidden rounded-xl border border-border text-left">
            {COLLECTORS.map((c) => {
                const cell = classifyCoverage(coverage[c]);
                const glyph = cell === "done" ? "✓" : cell === "failed" ? "✗" : "…";
                const label = cell === "failed" ? "incomplete" : cell;
                return (
                    <li key={c} className="flex items-center gap-3 border-b border-border px-4 py-2.5 text-sm last:border-b-0">
                        <span className={cn("flex w-3 justify-center font-mono text-xs", CELL_TONE[cell])}>
                            {cell === "running" ? <Loader2 className="h-3 w-3 animate-spin" /> : glyph}
                        </span>
                        <span className="text-muted-foreground">{c}</span>
                        <span className="flex-1" />
                        <span className="font-mono text-[10px] uppercase tracking-wide text-muted">{label}</span>
                    </li>
                );
            })}
        </ul>
    );
}

function Centered({ children }: { children: React.ReactNode }) {
    return (
        <div className="flex h-full items-center justify-center overflow-y-auto p-10">
            <div className="flex w-full max-w-xl flex-col items-center gap-4 text-center">{children}</div>
        </div>
    );
}

export function RadarScanStatePanel({
    state,
    report,
    scopePath,
}: {
    state: RadarScanState;
    report: RadarReport | null;
    scopePath: string | undefined;
}) {
    const scan = () => scopePath && fireAndForget(() => startScan(scopePath));
    const cancel = () => report && fireAndForget(() => cancelScan(report.oid));
    const retry = () => report && fireAndForget(() => retryClustering(report.oid));

    const accentTile = "border-accent/25 bg-accent/10 text-accent-soft";

    switch (state) {
        case "never-scanned":
            return (
                <Centered>
                    <IconTile icon={Radar} tone={accentTile} />
                    <h2 className="text-xl font-bold tracking-tight text-primary">This repository hasn't been scanned yet</h2>
                    <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
                        Radar examines the current tree plus recent engineering activity, converts it into compact signals, and
                        groups them into evidence-backed findings. Nothing runs until you scan.
                    </p>
                    <div className="w-full rounded-xl border border-border p-4 text-left">
                        <div className="mb-3 text-[10px] font-bold uppercase tracking-wider text-muted">What Radar examines</div>
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                            {EXAMINES.map((b) => (
                                <div key={b} className="flex items-start gap-2">
                                    <span className="mt-1.5 h-1 w-1 shrink-0 rounded-[1px] bg-accent" />
                                    <span className="text-xs text-muted-foreground">{b}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={scan}
                        disabled={!scopePath}
                        className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-background disabled:opacity-50"
                    >
                        Scan repository
                    </button>
                </Centered>
            );
        case "collecting":
            return (
                <Centered>
                    <IconTile icon={Loader2} tone={accentTile} spin />
                    <h2 className="text-xl font-bold tracking-tight text-primary">Collecting deterministic signals</h2>
                    <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
                        Local collectors are converting the current tree and recent activity into compact signals. No model
                        budget is spent yet.
                    </p>
                    <CollectorChecklist report={report} />
                    <button type="button" onClick={cancel} className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-surface-hover">
                        Cancel scan
                    </button>
                </Centered>
            );
        case "clustering":
            return (
                <Centered>
                    <IconTile icon={Loader2} tone={accentTile} spin />
                    <h2 className="text-xl font-bold tracking-tight text-primary">Clustering candidate risks</h2>
                    <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
                        Signals were collected and compared with the previous scan — a single bounded model call is grouping the
                        rest into findings.
                    </p>
                    <span className="rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs text-accent-soft">
                        Radar payload · {report?.payloadtokens ?? 0} tokens
                    </span>
                    <CollectorChecklist report={report} />
                    <button type="button" onClick={cancel} className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-surface-hover">
                        Cancel scan
                    </button>
                </Centered>
            );
        case "no-findings":
            return (
                <Centered>
                    <IconTile icon={CheckCircle2} tone="border-success/25 bg-success/10 text-success" />
                    <h2 className="text-xl font-bold tracking-tight text-primary">No new correctness risks found</h2>
                    <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
                        Radar clustered the collected signals and found nothing that meets the evidence bar. This is a snapshot of
                        the current tree, not a guarantee.
                    </p>
                    <button
                        type="button"
                        onClick={scan}
                        disabled={!scopePath}
                        className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-background disabled:opacity-50"
                    >
                        Scan again
                    </button>
                </Centered>
            );
        case "model-failed":
            return (
                <Centered>
                    <IconTile icon={AlertTriangle} tone="border-error/25 bg-error/10 text-error" />
                    <h2 className="text-xl font-bold tracking-tight text-primary">The model step failed — collected signals were kept</h2>
                    <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
                        Signals are cached from this scan. Retrying reuses them and only spends budget on clustering, so you won't
                        re-collect from scratch.
                    </p>
                    <div className="flex gap-2">
                        <button type="button" onClick={retry} className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-background">
                            Retry clustering
                        </button>
                        <button type="button" onClick={scan} disabled={!scopePath} className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-surface-hover disabled:opacity-50">
                            Discard signals
                        </button>
                    </div>
                </Centered>
            );
        case "cancelled":
            return (
                <Centered>
                    <IconTile icon={XCircle} tone="border-border bg-surface text-muted" />
                    <h2 className="text-xl font-bold tracking-tight text-primary">Scan cancelled</h2>
                    <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
                        Signals collected before you cancelled were discarded. Findings from your previous scan are unchanged and
                        still available.
                    </p>
                    <button
                        type="button"
                        onClick={scan}
                        disabled={!scopePath}
                        className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-background disabled:opacity-50"
                    >
                        Scan repository
                    </button>
                </Centered>
            );
        default:
            return null;
    }
}
