// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { PopoverReveal } from "@/app/element/popoverreveal";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { AlertTriangle, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AgentsViewModel } from "./agents";
import { projectsAtom } from "./projectsstore";
import { classifyScanState, coverageEntries, groupSummary, resolveSelection } from "./radarmodel";
import { RadarFindingDetail } from "./radarfindingdetail";
import { RadarFindingsList } from "./radarfindingslist";
import { RadarScanStatePanel } from "./radarscanstatepanel";
import { TONE_DOT } from "./radarstyles";
import {
    currentReportAtom,
    initRadarScope,
    radarScopeAtom,
    resolveScope,
    startScan,
    type RadarScope,
} from "./radarstore";

// Scan-scope selector: the Radar surface owns its scanned repo, initialized from the cockpit's global
// project but explicitly selectable here (the handoff's "# repo ▾" control) so the surface is
// self-contained. Reuses the project registry — no second path validator.
function ScopeSelector({ scope, onSelect }: { scope: RadarScope | null; onSelect: (s: RadarScope) => void }) {
    const projects = useAtomValue(projectsAtom);
    const [open, setOpen] = useState(false);
    const entries = Object.entries(projects ?? {}).filter(([, v]) => v?.path);

    return (
        <div className="relative flex flex-col gap-1">
            <span className="pl-0.5 font-mono text-[8px] uppercase tracking-widest text-muted">Scan scope</span>
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className="flex items-center gap-2 rounded-lg border border-edge-mid bg-surface-raised px-2.5 py-1.5 text-xs font-medium text-secondary hover:border-edge-strong"
            >
                <span className="font-mono text-muted">#</span>
                {scope?.name ?? "Select project"}
                <ChevronDown className="h-3 w-3 text-muted" />
            </button>
            {open ? <div className="fixed inset-0 z-50" onClick={() => setOpen(false)} /> : null}
            <PopoverReveal
                open={open}
                origin="top left"
                className="absolute left-0 top-[calc(100%+6px)] z-[60] w-[240px] overflow-hidden rounded-xl border border-edge-strong bg-surface-raised p-1.5 shadow-popover"
            >
                {entries.length === 0 ? (
                    <div className="px-2 py-3 text-center text-xs text-muted">No registered projects.</div>
                ) : (
                    entries.map(([name, v]) => (
                        <button
                            key={name}
                            type="button"
                            onClick={() => {
                                onSelect({ name, path: v.path });
                                setOpen(false);
                            }}
                            className={cn(
                                "flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[13px] hover:bg-surface-hover",
                                scope?.name === name && "bg-accent/10"
                            )}
                        >
                            <span className="truncate text-secondary">{name}</span>
                        </button>
                    ))
                )}
            </PopoverReveal>
        </div>
    );
}

export function RadarSurface({ model }: { model: AgentsViewModel }) {
    const filter = useAtomValue(model.projectFilterAtom);
    const projects = useAtomValue(projectsAtom);
    const scope = useAtomValue(radarScopeAtom);
    const report = useAtomValue(currentReportAtom);
    const [selectedId, setSelectedId] = useState<string | undefined>(undefined);

    // Initialize the owned scope once from the cockpit's global project selection; after that the
    // header selector owns it (so a projects/config reload never clobbers an explicit pick).
    const initialized = useRef(false);
    useEffect(() => {
        if (initialized.current) {
            return;
        }
        const next = resolveScope(filter, projects);
        if (filter !== "all" && !next) {
            return; // registry not loaded yet — wait for it to resolve the path
        }
        initialized.current = true;
        fireAndForget(() => initRadarScope(next));
    }, [filter, projects]);

    const selectScope = (s: RadarScope) => {
        initialized.current = true;
        fireAndForget(() => initRadarScope(s));
    };

    // DEV-ONLY: expose the scenario driver so CDP can render each scan state without a live scan.
    useEffect(() => {
        if (import.meta.env.DEV) {
            void import("./radardevmock").then((m) => {
                (window as any).__setRadarScenario = m.setRadarScenario;
            });
        }
    }, []);

    const state = classifyScanState(report);
    const isResults = state === "results" || state === "partial";
    const findings = report?.findings ?? [];
    const effectiveSelected = resolveSelection(findings, selectedId);
    const selectedFinding = findings.find((f) => f.id === effectiveSelected);
    const coverage = report ? coverageEntries(report) : [];

    return (
        <div className="flex h-full w-full flex-col bg-background">
            <header className="flex items-start justify-between gap-5 border-b border-border px-6 py-4">
                <div className="min-w-0">
                    <div className="mb-1 flex items-center gap-2.5">
                        <h1 className="text-2xl font-bold tracking-tight text-primary">Repo Radar</h1>
                        <span className="rounded border border-accent/25 bg-accent/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-accent-soft">
                            Correctness risk
                        </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                        <p className="text-xs text-muted-foreground">
                            {scope ? `Scanning ${scope.name}` : "Select a registered project to scan"}
                        </p>
                        {coverage.length > 0 ? (
                            <div className="flex items-center gap-2">
                                <span className="font-mono text-[9px] uppercase tracking-widest text-muted">Coverage</span>
                                {coverage.map((c) => (
                                    <span
                                        key={c.collector}
                                        className={cn(
                                            "font-mono text-[10px]",
                                            c.status === "ok" ? "text-success" : "text-error"
                                        )}
                                    >
                                        {c.status === "ok" ? "✓" : "✗"} {c.collector}
                                    </span>
                                ))}
                            </div>
                        ) : null}
                    </div>
                </div>
                <div className="flex items-end gap-3">
                    <ScopeSelector scope={scope} onSelect={selectScope} />
                    {isResults && scope ? (
                        <button
                            type="button"
                            onClick={() => fireAndForget(() => startScan(scope.path))}
                            className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-background"
                        >
                            {state === "partial" ? "Re-run full scan" : "Re-scan"}
                        </button>
                    ) : null}
                </div>
            </header>

            <div className="min-h-0 flex-1">
                {isResults && report ? (
                    <div className="flex h-full flex-col">
                        {/* summary chips + hypotheses disclaimer */}
                        <div className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-3">
                            {groupSummary(findings)
                                .filter((s) => s.count > 0)
                                .map((s) => (
                                    <div key={s.group} className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1">
                                        <span className={cn("h-1.5 w-1.5 rounded-full", TONE_DOT.new)} />
                                        <span className="font-mono text-sm font-semibold text-primary">{s.count}</span>
                                        <span className="text-xs text-muted-foreground">{s.label}</span>
                                    </div>
                                ))}
                            <span className="flex-1" />
                            <span className="text-[11px] text-muted">
                                Findings are evidence-backed hypotheses — investigation is a separate, explicit step.
                            </span>
                        </div>

                        {state === "partial" ? (
                            <div className="flex items-center gap-2.5 border-b border-border bg-warning/10 px-6 py-2 text-xs text-warning">
                                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                                <span>
                                    <b>Partial scan.</b> Some collectors did not complete — findings that rely on the missing
                                    evidence may be absent.
                                </span>
                            </div>
                        ) : null}

                        <div className="flex min-h-0 flex-1">
                            <RadarFindingsList findings={findings} selectedId={effectiveSelected} onSelect={setSelectedId} />
                            {selectedFinding ? (
                                <RadarFindingDetail model={model} report={report} finding={selectedFinding} />
                            ) : (
                                <div className="flex flex-1 items-center justify-center text-muted-foreground">
                                    Select a finding
                                </div>
                            )}
                        </div>
                    </div>
                ) : (
                    <RadarScanStatePanel state={state} report={report} scopePath={scope?.path} />
                )}
            </div>
        </div>
    );
}
