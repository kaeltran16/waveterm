// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { PopoverReveal } from "@/app/element/popoverreveal";
import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget } from "@/util/util";
import { useAtom, useAtomValue } from "jotai";
import { AlertTriangle, ChevronDown } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentsViewModel } from "./agents";
import { projectsAtom } from "./projectsstore";
import {
    classifyCoverage,
    classifyScanState,
    coverageEntries,
    type CoverageCell,
    failedLenses,
    filterByMode,
    findingMode,
    groupSummary,
    isResultsState,
    MODE_META,
    modeFilterOptions,
    projectsWithPath,
    type RadarMode,
    rescanLabel,
    resolveSelection,
    scanScopeLabel,
    toPendingRunDraft,
} from "./radarmodel";
import { pendingRunDraftAtom } from "./runactions";
import { RadarFindingDetail } from "./radarfindingdetail";
import { RadarFindingsList } from "./radarfindingslist";
import { RadarScanStatePanel } from "./radarscanstatepanel";
import { modeBadge, TONE_DOT } from "./radarstyles";
import {
    currentReportAtom,
    findNewestScannedProject,
    initRadarScope,
    lastRadarProjectAtom,
    pickInitialScope,
    radarScopeAtom,
    radarSelectedIdAtom,
    retryClustering,
    startScan,
    type RadarScope,
} from "./radarstore";
import { SurfaceHeader } from "./surfacescaffold";

// Header coverage row treats an in-progress ("running") or not-yet-reached ("queued") collector as muted
// rather than an error, since coverage now streams in during a scan (see classifyCoverage).
const HEADER_CELL_TONE: Record<CoverageCell, string> = {
    done: "text-success",
    running: "text-muted",
    failed: "text-error",
    queued: "text-muted",
};

// Scan-scope selector: the Radar surface owns its scanned repo, initialized from the cockpit's global
// project but explicitly selectable here (the handoff's "# repo ▾" control) so the surface is
// self-contained. Reuses the project registry — no second path validator.
function ScopeSelector({ scope, onSelect }: { scope: RadarScope | null; onSelect: (s: RadarScope) => void }) {
    const projects = useAtomValue(projectsAtom);
    const [open, setOpen] = useState(false);
    const entries = projectsWithPath(projects);

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
    const [selectedId, setSelectedId] = useAtom(radarSelectedIdAtom);

    // Initialize the owned scope from the persisted pick (falling back to the cockpit's global project
    // selection); after that the header selector owns it. An already-owned scope is kept as-is so a
    // remount — RadarSurface unmounts on every navigation away — never re-derives and wipes the scan.
    const initialized = useRef(false);
    useEffect(() => {
        if (initialized.current) {
            return;
        }
        const decision = pickInitialScope(
            globalStore.get(radarScopeAtom),
            globalStore.get(lastRadarProjectAtom),
            filter,
            projects
        );
        if (decision.action === "wait") {
            return; // desired project not resolvable yet — wait for the registry
        }
        initialized.current = true;
        if (decision.action === "keep") {
            return;
        }
        if (decision.scope != null) {
            fireAndForget(() => initRadarScope(decision.scope));
            return;
        }
        // No persisted/filter project to scope to: prefer landing on the most-recently-scanned project so
        // the surface opens on real findings, falling back to the empty picker only when nothing was scanned.
        fireAndForget(async () => initRadarScope(await findNewestScannedProject()));
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
    const isResults = isResultsState(state);
    const [modeFilter, setModeFilter] = useState<RadarMode | "all">("all");
    const allFindings = report?.findings ?? [];
    const modeOptions = modeFilterOptions(allFindings);
    // if the active filter's mode vanished after a re-scan, fall back to "all" so the list is never stuck empty.
    const activeMode = modeFilter !== "all" && !modeOptions.includes(modeFilter) ? "all" : modeFilter;
    const findings = filterByMode(allFindings, activeMode);
    const effectiveSelected = resolveSelection(findings, selectedId);
    const selectedFinding = findings.find((f) => f.id === effectiveSelected);
    const coverage = report ? coverageEntries(report) : [];

    // list-nav Enter fires the selected finding's primary CTA — start (or re-run) its investigation,
    // the same gesture as the detail's "Start investigation" button (radarfindingdetail.tsx).
    const startInvestigation = useCallback(() => {
        if (!report || !selectedFinding) {
            return;
        }
        globalStore.set(pendingRunDraftAtom, toPendingRunDraft(report, selectedFinding));
        globalStore.set(model.surfaceAtom, "channels");
    }, [report, selectedFinding, model]);

    return (
        <div className="flex h-full w-full flex-col bg-background">
            <SurfaceHeader
                title="Repo Radar"
                badge={
                    <span className="rounded border border-accent/25 bg-accent/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-accent-soft">
                        Correctness risk
                    </span>
                }
                subtitle={
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                        <span className="text-muted">{scanScopeLabel(scope)}</span>
                        {coverage.length > 0 ? (
                            <div className="flex items-center gap-2">
                                <span className="font-mono text-[9px] uppercase tracking-widest text-muted">Coverage</span>
                                {coverage.map((c) => {
                                    const cell = classifyCoverage(c.status);
                                    const glyph = cell === "done" ? "✓" : cell === "failed" ? "✗" : "…";
                                    return (
                                        <span
                                            key={c.collector}
                                            className={cn("font-mono text-[10px]", HEADER_CELL_TONE[cell])}
                                        >
                                            {glyph} {c.collector}
                                        </span>
                                    );
                                })}
                            </div>
                        ) : null}
                    </div>
                }
                actions={
                    <>
                        <ScopeSelector scope={scope} onSelect={selectScope} />
                        {isResults && scope ? (
                            <button
                                type="button"
                                onClick={() => fireAndForget(() => startScan(scope.path))}
                                className="self-end rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-background"
                            >
                                {rescanLabel(state)}
                            </button>
                        ) : null}
                    </>
                }
            />

            <div className="min-h-0 flex-1">
                {isResults && report ? (
                    <div className="flex h-full flex-col">
                        {/* summary chips + hypotheses disclaimer */}
                        <div className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-3">
                            {modeOptions.length > 1 ? (
                                <div className="flex items-center gap-1.5">
                                    {(["all", ...modeOptions] as (RadarMode | "all")[]).map((m) => {
                                        const on = activeMode === m;
                                        return (
                                            <button
                                                key={m}
                                                type="button"
                                                onClick={() => setModeFilter(m)}
                                                className={cn(
                                                    "rounded-full border px-2.5 py-0.5 text-[11px] font-semibold",
                                                    m === "all"
                                                        ? on
                                                            ? "border-accent/40 bg-accent/15 text-accent-soft"
                                                            : "border-border text-muted hover:text-secondary"
                                                        : on
                                                          ? modeBadge(m)
                                                          : "border-border text-muted hover:text-secondary"
                                                )}
                                            >
                                                {m === "all" ? "All" : MODE_META[m].label}
                                            </button>
                                        );
                                    })}
                                    <span className="mx-1 h-4 w-px bg-border" />
                                </div>
                            ) : null}
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

                        {failedLenses(report).length > 0 ? (
                            <div className="flex items-center gap-2.5 border-b border-border bg-error/10 px-6 py-2 text-xs text-error">
                                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                                <span className="flex-1">
                                    <b>Lens failed.</b>{" "}
                                    {failedLenses(report)
                                        .map((r) => MODE_META[findingMode({ mode: r.mode } as RadarFinding)].label)
                                        .join(", ")}{" "}
                                    did not cluster — the other lenses' findings are shown.
                                </span>
                                <button
                                    type="button"
                                    onClick={() => fireAndForget(() => retryClustering(report.oid))}
                                    className="shrink-0 rounded border border-error/40 px-2 py-0.5 font-semibold text-error hover:bg-error/15"
                                >
                                    Retry
                                </button>
                            </div>
                        ) : null}

                        <div className="flex min-h-0 flex-1">
                            <RadarFindingsList
                                findings={findings}
                                selectedId={effectiveSelected}
                                onSelect={setSelectedId}
                                onActivate={selectedFinding ? startInvestigation : undefined}
                            />
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
