// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import * as WOS from "@/app/store/wos";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type Atom, type PrimitiveAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";

export interface RadarScope {
    name: string;
    path: string;
}

// resolveScope maps the cockpit's global project FILTER (a project name, or "all") to Radar's
// name+path scope. Returns null when there is no single registered project to scan.
export function resolveScope(filter: string, projects: Record<string, ProjectKeywords>): RadarScope | null {
    if (!filter || filter === "all") {
        return null;
    }
    const path = projects?.[filter]?.path;
    if (!path) {
        return null;
    }
    return { name: filter, path };
}

// The project Radar is scoped to, persisted across reloads. Stores the project NAME only — the path is
// re-resolved from the registry so the registry stays the single source of truth for paths.
export const lastRadarProjectAtom = atomWithStorage<string | null>("radar.scope.project", null);

export type InitScopeDecision = { action: "keep" } | { action: "wait" } | { action: "set"; scope: RadarScope | null };

// pickInitialScope decides how RadarSurface should initialize its scope on mount. An already-owned scope
// is kept untouched (a remount must not re-derive it — that clobbered the current scan). Otherwise it
// prefers the persisted project, then the cockpit's global filter, resolving name->path via the registry;
// it waits when a desired project can't be resolved yet (registry not loaded, or the project was removed).
export function pickInitialScope(
    owned: RadarScope | null,
    persisted: string | null,
    filter: string,
    projects: Record<string, ProjectKeywords>
): InitScopeDecision {
    if (owned != null) {
        return { action: "keep" };
    }
    const desired = persisted ?? (filter !== "all" ? filter : null);
    if (!desired) {
        return { action: "set", scope: null };
    }
    const scope = resolveScope(desired, projects);
    if (!scope) {
        return { action: "wait" };
    }
    return { action: "set", scope };
}

export const radarScopeAtom = atom<RadarScope | null>(null) as PrimitiveAtom<RadarScope | null>;
export const radarReportsAtom = atom<RadarReport[] | null>(null) as PrimitiveAtom<RadarReport[] | null>;
export const currentReportIdAtom = atom<string | undefined>(undefined) as PrimitiveAtom<string | undefined>;

// DEV-ONLY: when set, fully replaces the live current report (see radardevmock.ts). null in prod.
export const radarDevMockAtom = atom<RadarReport | null>(null) as PrimitiveAtom<RadarReport | null>;

// Current report: the dev-mock override if present, else the WOS-pinned live report (so an in-flight
// scan streams status/phase/coverage updates without polling).
export const currentReportAtom: Atom<RadarReport | null> = atom((get) => {
    const mock = get(radarDevMockAtom);
    if (mock) {
        return mock;
    }
    const id = get(currentReportIdAtom);
    if (!id) {
        return null;
    }
    return get(WOS.getWaveObjectAtom<RadarReport>(WOS.makeORef("radarreport", id))) ?? null;
});

let loading = false;

// loadReports fetches the report list for a path (newest-first) and selects the newest.
export async function loadReports(path: string): Promise<void> {
    if (loading) {
        return;
    }
    loading = true;
    try {
        const rtn = await RpcApi.ListRadarReportsCommand(TabRpcClient, { projectpath: path });
        const list = (rtn.reports ?? []).slice().sort((a, b) => b.startedts - a.startedts);
        globalStore.set(radarReportsAtom, list);
        if (list.length > 0) {
            await selectReport(list[0].oid);
        } else {
            globalStore.set(currentReportIdAtom, undefined);
        }
    } catch (err) {
        console.error("loading radar reports failed", err);
        globalStore.set(radarReportsAtom, []);
    } finally {
        loading = false;
    }
}

// selectReport pins the report in WOS (so subsequent SendWaveObjUpdate deltas apply) and marks it current.
export async function selectReport(reportId: string): Promise<void> {
    await WOS.loadAndPinWaveObject<RadarReport>(WOS.makeORef("radarreport", reportId));
    globalStore.set(currentReportIdAtom, reportId);
}

// initRadarScope sets the owned scope and loads its reports. Clearing scope (null) empties the list.
// The scoped project name is persisted (across reloads) so a return to Radar restores the same scan.
export async function initRadarScope(scope: RadarScope | null): Promise<void> {
    globalStore.set(radarScopeAtom, scope);
    globalStore.set(lastRadarProjectAtom, scope?.name ?? null);
    if (!scope) {
        globalStore.set(radarReportsAtom, null);
        globalStore.set(currentReportIdAtom, undefined);
        return;
    }
    await loadReports(scope.path);
}

// startScan kicks a scan for path; the returned report is pinned + selected so its live scan streams in.
export async function startScan(path: string): Promise<void> {
    const rtn = await RpcApi.StartRadarScanCommand(TabRpcClient, { projectpath: path });
    await loadReports(path);
    await selectReport(rtn.report.oid);
}

export async function cancelScan(reportId: string): Promise<void> {
    await RpcApi.CancelRadarScanCommand(TabRpcClient, { reportid: reportId });
}

export async function retryClustering(reportId: string): Promise<void> {
    await RpcApi.RetryRadarClusteringCommand(TabRpcClient, { reportid: reportId });
}

// setDisposition applies dismiss/suppress/reopen/unsuppress; the report update round-trips via WOS.
export async function setDisposition(
    reportId: string,
    findingId: string,
    action: string,
    reason?: string,
    note?: string
): Promise<void> {
    await RpcApi.SetRadarFindingDispositionCommand(TabRpcClient, {
        reportid: reportId,
        findingid: findingId,
        action,
        reason,
        note,
    });
}
