// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The cockpit's one router. A caller holding a string goes through openAddress (parseAddress, then
// openTarget); a caller holding an id builds the target. A landing loads what proves its target exists,
// writes the destination's selection, then switches surface, so the destination renders the item on its first
// frame and a click never flashes the wrong one. A landing that cannot open says why and leaves the user where
// they were — a silent no-op is the failure this module exists to remove.

import { pushToast } from "@/app/cockpit/notificationstore";
import { globalStore } from "@/app/store/global";
import * as WOS from "@/app/store/wos";
import { fireAndForget } from "@/util/util";
import type { AgentsViewModel } from "../agents/agents";
import { jumpToAgent } from "../agents/channelsprimitives";
import { selectChannel } from "../agents/channelsstore";
import { loadMemory, memErrorAtom, memNotesAtom, selectNote } from "../agents/memstore";
import { initRadarScope, radarScopeAtom, radarSelectedIdAtom, scopeOfReport, selectReport } from "../agents/radarstore";
import { vaultFocusAtom, vaultTabAtom } from "../agents/vaultstore";
import { parseAddress, type AddressHint, type OpenTarget } from "./address";
import { briefPeekRecordAtom, briefSheetOpenAtom } from "./jarvisstore";
import { loadRecordDetail, selectSubject, setActiveRunId } from "./jarvissubjectstore";
import { pendingDecisionAnchorAtom } from "./petstore";
import { refreshTaskList, taskListAtom, tasksErrorAtom } from "./tasksstore";

export type OpenResult =
    | { ok: true; notice?: string }
    | { ok: false; reason: "unsupported" | "unavailable" | "failed" | "superseded"; message: string };

export type ReportOpen = (result: OpenResult) => void;

type RecordTarget = Extract<OpenTarget, { kind: "record" }>;
type MemoryNoteTarget = Extract<OpenTarget, { kind: "memory-note" }>;
type RadarTarget = Extract<OpenTarget, { kind: "radar" }>;

const OK: OpenResult = { ok: true };
const SUPERSEDED: OpenResult = { ok: false, reason: "superseded", message: "" };

function unavailable(message: string): OpenResult {
    return { ok: false, reason: "unavailable", message };
}

function failed(target: OpenTarget, why: string): OpenResult {
    return { ok: false, reason: "failed", message: `Couldn't open ${targetName(target)}: ${why}` };
}

function targetName(target: OpenTarget): string {
    switch (target.kind) {
        case "channel":
            return `channel ${target.channelId}`;
        case "run":
            return `run ${target.runId}`;
        case "agent":
            return `agent ${target.tabId}`;
        case "record":
            return `record ${target.dossierId}`;
        case "memory-note":
            return `memory note ${target.noteId}`;
        case "effort":
            return `initiative ${target.effortId}`;
        case "radar":
            return `scan report ${target.reportId}`;
    }
}

// A landing waits on its load, so a second click can start before the first lands. Each open takes the next
// number, and a landing that finds the counter moved on during an await is superseded and writes nothing more.
let openSeq = 0;

export async function openTarget(
    model: AgentsViewModel,
    target: OpenTarget,
    report: ReportOpen = toast
): Promise<OpenResult> {
    const token = ++openSeq;
    const current = () => token === openSeq;
    let result: OpenResult;
    try {
        result = await land(model, target, current);
    } catch (e) {
        result = current() ? failed(target, e instanceof Error ? e.message : String(e)) : SUPERSEDED;
    }
    deliver(result, report);
    return result;
}

export async function openAddress(
    model: AgentsViewModel,
    address: string,
    hint?: AddressHint,
    report: ReportOpen = toast
): Promise<OpenResult> {
    const parsed = parseAddress(address, hint);
    if (parsed.kind !== "unsupported") {
        return openTarget(model, parsed, report);
    }
    // a click on a dead address is still the user's latest; a slower landing must not arrive over its toast
    ++openSeq;
    const result: OpenResult = { ok: false, reason: "unsupported", message: parsed.message };
    deliver(result, report);
    return result;
}

// superseded is never reported: the open that replaced it is the one the user is waiting on
function deliver(result: OpenResult, report: ReportOpen): void {
    if ("reason" in result ? result.reason !== "superseded" : result.notice != null) {
        report(result);
    }
}

// narrowed with `in`: the tsconfig is not strict, so the `ok` literal does not discriminate the union
function toast(result: OpenResult): void {
    if ("reason" in result) {
        pushToast({ title: result.message, message: "", level: result.reason === "failed" ? "error" : "warn" });
        return;
    }
    pushToast({ title: result.notice ?? "", message: "", level: "info" });
}

async function land(model: AgentsViewModel, target: OpenTarget, current: () => boolean): Promise<OpenResult> {
    switch (target.kind) {
        case "channel":
            return landChannel(model, target.channelId, target.runId, current);
        case "run":
            return landRun(model, target.runId, current);
        case "agent":
            return landAgent(model, target.tabId);
        case "record":
            return landRecord(model, target, current);
        case "memory-note":
            return landMemoryNote(model, target, current);
        case "effort":
            openEffortSheet(target.effortId);
            globalStore.set(model.surfaceAtom, "jarvis");
            return OK;
        case "radar":
            return landRadar(model, target, current);
    }
}

async function landChannel(
    model: AgentsViewModel,
    channelId: string,
    runId: string | undefined,
    current: () => boolean
): Promise<OpenResult> {
    const channel = await WOS.loadAndPinWaveObject<Channel>(WOS.makeORef("channel", channelId));
    if (!current()) {
        return SUPERSEDED;
    }
    if (channel == null) {
        return unavailable("That channel no longer exists");
    }
    await openChannelSheet(channelId, runId ?? null);
    if (!current()) {
        return SUPERSEDED;
    }
    globalStore.set(model.surfaceAtom, "jarvis");
    return OK;
}

// A run is not a subject kind of its own: it resolves from its channel plus the selected run id, which is what
// stageRunAtom reads. The channel comes off the run's own object, because a run row projected from WorkState
// carries no channel.
async function landRun(model: AgentsViewModel, runId: string, current: () => boolean): Promise<OpenResult> {
    const run = await WOS.loadAndPinWaveObject<Run>(WOS.makeORef("run", runId));
    if (!current()) {
        return SUPERSEDED;
    }
    if (run == null) {
        return unavailable("That run no longer exists");
    }
    if (!run.channeloid) {
        return unavailable("That run has no channel to open it in");
    }
    return landChannel(model, run.channeloid, runId, current);
}

function landAgent(model: AgentsViewModel, tabId: string): OpenResult {
    // the Agent surface shows a background terminal as readily as an agent, so both count as the roster
    const roster = [...globalStore.get(model.agentsAtom), ...globalStore.get(model.terminalsAtom)];
    if (!roster.some((a) => a.id === tabId)) {
        return unavailable("That agent session has ended");
    }
    jumpToAgent(model, tabId);
    return OK;
}

// The peek renders nothing until the record's detail loads, so it cannot say a record is gone; the list can.
// The list loads once per Brief mount, so a record created since is refreshed in before it is called missing.
async function landRecord(model: AgentsViewModel, target: RecordTarget, current: () => boolean): Promise<OpenResult> {
    const listed = () => globalStore.get(taskListAtom)?.some((d) => d.id === target.dossierId) === true;
    if (!listed()) {
        await refreshTaskList();
        if (!current()) {
            return SUPERSEDED;
        }
        if (!listed()) {
            const loadError = globalStore.get(tasksErrorAtom);
            return loadError != null ? failed(target, loadError) : unavailable("That record no longer exists");
        }
    }
    globalStore.set(pendingDecisionAnchorAtom, target.anchor ?? null);
    openRecordPeek(target.dossierId);
    globalStore.set(model.surfaceAtom, "jarvis");
    return OK;
}

// A record's home is the Brief peek: it is the only surface that writes a record's status, so it was always
// the authoritative view. The Vault's second, read-only index is gone. Detail is loaded before the surface
// flips so the peek mounts on the record rather than on its own empty frame.
function openRecordPeek(dossierId: string): void {
    loadRecordDetail(dossierId);
    globalStore.set(briefPeekRecordAtom, dossierId);
}

// The same refresh on a miss as a record: memory is scanned when the Vault is visited, so a note learned since
// is not in the list yet.
async function landMemoryNote(
    model: AgentsViewModel,
    target: MemoryNoteTarget,
    current: () => boolean
): Promise<OpenResult> {
    const listed = () => globalStore.get(memNotesAtom).some((n) => n.id === target.noteId);
    if (!listed()) {
        await loadMemory();
        if (!current()) {
            return SUPERSEDED;
        }
        if (!listed()) {
            return globalStore.get(memErrorAtom)
                ? failed(target, "the memory scan failed")
                : unavailable("That memory note no longer exists");
        }
    }
    fireAndForget(() => selectNote(target.noteId));
    // the memory collection's saved detail, not merely the Vault surface: the note detail is only reachable there
    globalStore.set(vaultTabAtom, "memory");
    globalStore.set(vaultFocusAtom, "saved");
    globalStore.set(model.surfaceAtom, "vault");
    return OK;
}

// initRadarScope selects its project's newest report, and Radar's first mount derives a scope unless one is
// already owned — so the report's own project is owned first and the report selected after it. selectReport,
// not radarSelectedIdAtom, pins the report: that atom holds the selected FINDING.
async function landRadar(model: AgentsViewModel, target: RadarTarget, current: () => boolean): Promise<OpenResult> {
    const report = await WOS.loadAndPinWaveObject<RadarReport>(WOS.makeORef("radarreport", target.reportId));
    if (!current()) {
        return SUPERSEDED;
    }
    if (report == null) {
        return unavailable("That scan report no longer exists");
    }
    const scope = scopeOfReport(report);
    if (globalStore.get(radarScopeAtom)?.path !== scope.path) {
        await initRadarScope(scope);
        if (!current()) {
            return SUPERSEDED;
        }
    }
    await selectReport(target.reportId);
    if (!current()) {
        return SUPERSEDED;
    }
    const findingId = target.findingId;
    const found = findingId != null && (report.findings ?? []).some((f) => f.id === findingId);
    globalStore.set(radarSelectedIdAtom, found ? findingId : undefined);
    globalStore.set(model.surfaceAtom, "radar");
    return findingId != null && !found ? { ok: true, notice: "That finding is no longer in this report" } : OK;
}

// The Brief's detail sheet, opened on a channel. Selecting the channel is what LOADS it: the sheet's body
// resolves its run from the active channel's list (stageRunAtom), so a sheet opened on a channel that was never
// selected had a null run and read "Reading this channel…" forever. Exported for Jarvis's own flows (restore,
// the investigation draft, the new-run control), not for cross-surface callers — those open a target.
export async function openChannelSheet(channelId: string, runId: string | null): Promise<void> {
    await selectChannel(channelId);
    selectSubject({ kind: "channel", id: channelId });
    if (runId != null) {
        setActiveRunId(channelId, runId);
    }
    globalStore.set(briefSheetOpenAtom, true);
}

function openEffortSheet(effortId: string): void {
    selectSubject({ kind: "effort", id: effortId });
    globalStore.set(briefSheetOpenAtom, true);
}
