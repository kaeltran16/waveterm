// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { fireAndForget } from "@/util/util";
import { coverageEntries, type RadarScanState } from "./radarmodel";
import { cancelScan, retryClustering, startScan } from "./radarstore";

const COLLECTORS = ["structure", "git", "runs", "transcript", "memory", "config"];

function Panel({ heading, message, children }: { heading: string; message?: string; children?: React.ReactNode }) {
    return (
        <div className="mx-auto flex max-w-xl flex-col items-start gap-4 p-8">
            <h2 className="text-xl font-bold tracking-tight text-primary">{heading}</h2>
            {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}
            {children}
        </div>
    );
}

function CollectorChecklist({ report }: { report: RadarReport | null }) {
    const coverage = report ? Object.fromEntries(coverageEntries(report).map((e) => [e.collector, e.status])) : {};
    return (
        <ul className="flex w-full flex-col gap-1.5">
            {COLLECTORS.map((c) => {
                const status = coverage[c];
                const mark = status === "ok" ? "✓" : status === "failed" || status === "partial" ? "✗" : "…";
                return (
                    <li key={c} className="flex items-center gap-2 text-sm text-muted-foreground">
                        <span className="font-mono text-xs text-accent-soft">{mark}</span>
                        <span>{c}</span>
                    </li>
                );
            })}
        </ul>
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

    switch (state) {
        case "never-scanned":
            return (
                <Panel heading="Not yet scanned" message="Radar reads Git history, runs, transcripts, memory, and config to surface correctness risks. It never writes to the repo or runs commands.">
                    <button type="button" onClick={scan} disabled={!scopePath} className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-background disabled:opacity-50">
                        Scan repository
                    </button>
                </Panel>
            );
        case "collecting":
            return (
                <Panel heading="Collecting deterministic signals…">
                    <CollectorChecklist report={report} />
                    <button type="button" onClick={cancel} className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground">Cancel scan</button>
                </Panel>
            );
        case "clustering":
            return (
                <Panel heading="Clustering candidate risks…" message={`Radar payload: ${report?.payloadtokens ?? 0} tokens`}>
                    <CollectorChecklist report={report} />
                    <button type="button" onClick={cancel} className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground">Cancel scan</button>
                </Panel>
            );
        case "no-findings":
            return (
                <Panel heading="No correctness risks found" message="This scan surfaced no evidence-backed risks. Signals were collected and clustered cleanly.">
                    <button type="button" onClick={scan} disabled={!scopePath} className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-background disabled:opacity-50">Scan again</button>
                </Panel>
            );
        case "model-failed":
            return (
                <Panel heading="Clustering failed" message="Signals are cached from this scan. Retrying reuses them and only spends budget on clustering, so you won’t re-collect from scratch.">
                    <div className="flex gap-2">
                        <button type="button" onClick={retry} className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-background">Retry clustering</button>
                        <button type="button" onClick={scan} disabled={!scopePath} className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground disabled:opacity-50">Discard signals</button>
                    </div>
                </Panel>
            );
        case "cancelled":
            return (
                <Panel heading="Scan cancelled" message="Signals collected before you cancelled were discarded. Findings from your previous scan are unchanged and still available.">
                    <button type="button" onClick={scan} disabled={!scopePath} className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-background disabled:opacity-50">Scan repository</button>
                </Panel>
            );
        default:
            return null;
    }
}
