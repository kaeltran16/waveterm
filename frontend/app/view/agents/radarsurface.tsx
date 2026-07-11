// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import type { AgentsViewModel } from "./agents";
import { projectsAtom } from "./projectsstore";
import { classifyScanState, resolveSelection } from "./radarmodel";
import { RadarFindingDetail } from "./radarfindingdetail";
import { RadarFindingsList } from "./radarfindingslist";
import { RadarScanStatePanel } from "./radarscanstatepanel";
import { currentReportAtom, initRadarScope, radarScopeAtom, resolveScope, startScan } from "./radarstore";

export function RadarSurface({ model }: { model: AgentsViewModel }) {
    const filter = useAtomValue(model.projectFilterAtom);
    const projects = useAtomValue(projectsAtom);
    const scope = useAtomValue(radarScopeAtom);
    const report = useAtomValue(currentReportAtom);
    const [selectedId, setSelectedId] = useState<string | undefined>(undefined);

    // Initialize (and re-sync) the owned scope from the cockpit's global project selection.
    useEffect(() => {
        const next = resolveScope(filter, projects);
        fireAndForget(() => initRadarScope(next));
    }, [filter, projects]);

    // DEV-ONLY: expose the scenario driver so CDP can render each scan state without a live scan.
    // Tree-shaken from prod builds (import.meta.env.DEV is false there).
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

    return (
        <div className="flex h-full w-full flex-col bg-background">
            <header className="flex items-center justify-between border-b border-border px-6 py-4">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight text-primary">Repo Radar</h1>
                    <p className="text-xs text-muted-foreground">
                        {scope ? `Scanning ${scope.name}` : "Select a registered project to scan"}
                    </p>
                </div>
                {isResults && scope ? (
                    <button
                        type="button"
                        onClick={() => fireAndForget(() => startScan(scope.path))}
                        className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-background"
                    >
                        {state === "partial" ? "Re-run full scan" : "Re-scan"}
                    </button>
                ) : null}
            </header>

            <div className="min-h-0 flex-1">
                {isResults && report ? (
                    <div className="relative flex h-full">
                        {state === "partial" ? (
                            <div className="absolute left-0 right-0 top-0 z-[1] bg-asking/10 px-6 py-1.5 text-xs text-asking">
                                Partial scan — some collectors did not complete.
                            </div>
                        ) : null}
                        <RadarFindingsList findings={findings} selectedId={effectiveSelected} onSelect={setSelectedId} />
                        {selectedFinding ? (
                            <RadarFindingDetail report={report} finding={selectedFinding} />
                        ) : (
                            <div className="flex flex-1 items-center justify-center text-muted-foreground">Select a finding</div>
                        )}
                    </div>
                ) : (
                    <RadarScanStatePanel state={state} report={report} scopePath={scope?.path} />
                )}
            </div>
        </div>
    );
}
