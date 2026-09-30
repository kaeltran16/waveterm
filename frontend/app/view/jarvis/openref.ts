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
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import type { AgentsViewModel } from "../agents/agents";
import { canvasDir, canvasProjectDir } from "../agents/canvasmodel";
import { attachCanvas, canvasOwner, getCanvas, selectCanvasBoard, setCanvasMode } from "../agents/canvasstore";
import { jumpToAgent } from "../agents/channelsprimitives";
import { selectChannel } from "../agents/channelsstore";
import { initRadarScope, radarScopeAtom, radarSelectedIdAtom, scopeOfReport, selectReport } from "../agents/radarstore";
import { isCanvasSegment, parseAddress, type AddressHint, type OpenTarget } from "./address";
import { briefPeekRecordAtom, briefSheetOpenAtom } from "./jarvisstore";
import { loadRecordDetail, selectSubject, setActiveRunId } from "./jarvissubjectstore";
import { pendingDecisionAnchorAtom } from "./petstore";
import { refreshTaskList, taskListAtom, tasksErrorAtom } from "./tasksstore";

export type OpenResult =
    | { ok: true; notice?: string }
    | { ok: false; reason: "unsupported" | "unavailable" | "failed" | "superseded"; message: string };

export type ReportOpen = (result: OpenResult) => void;

type RecordTarget = Extract<OpenTarget, { kind: "record" }>;
type RadarTarget = Extract<OpenTarget, { kind: "radar" }>;
type CanvasTarget = Extract<OpenTarget, { kind: "canvas" }>;
type Caller = AddressHint["caller"];

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
        case "effort":
            return `initiative ${target.effortId}`;
        case "radar":
            return `scan report ${target.reportId}`;
        case "canvas":
            return `canvas ${target.topic}`;
    }
}

// A landing waits on its load, so a second click can start before the first lands. Each open takes the next
// number, and a landing that finds the counter moved on during an await is superseded and writes nothing more.
let openSeq = 0;

export async function openTarget(
    model: AgentsViewModel,
    target: OpenTarget,
    report: ReportOpen = toast,
    caller?: Caller
): Promise<OpenResult> {
    const token = ++openSeq;
    const current = () => token === openSeq;
    let result: OpenResult;
    try {
        result = await land(model, target, current, caller);
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
        return openTarget(model, parsed, report, hint?.caller);
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

async function land(
    model: AgentsViewModel,
    target: OpenTarget,
    current: () => boolean,
    caller: Caller
): Promise<OpenResult> {
    switch (target.kind) {
        case "channel":
            return landChannel(model, target.channelId, target.runId, current);
        case "run":
            return landRun(model, target.runId, current);
        case "agent":
            return landAgent(model, target.tabId);
        case "record":
            return landRecord(model, target, current);
        case "effort":
            openEffortSheet(target.effortId);
            globalStore.set(model.surfaceAtom, "jarvis");
            return OK;
        case "radar":
            return landRadar(model, target, current);
        case "canvas":
            return landCanvas(model, target, current, caller);
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

// A reveal names its caller: the canvas is that agent's, in its cwd. The agent reveals on every revision, so its
// reveal only attaches: the user may be anywhere, and moving them there each time pulls them off their work. The
// trail toast and the header's Canvas toggle say it is there. A palette or citation open has no caller, so it is
// the user asking to see it: it lands on whichever agent already has the topic open, in canvas mode.
async function landCanvas(
    model: AgentsViewModel,
    target: CanvasTarget,
    current: () => boolean,
    caller: Caller
): Promise<OpenResult> {
    const { topic, board } = target;
    // parseAddress refuses path characters, but a target built in code never went through it
    if (!isCanvasSegment(topic) || (board != null && !isCanvasSegment(board))) {
        return { ok: false, reason: "unsupported", message: `Not a canvas name: ${topic}` };
    }
    if (caller == null) {
        const owner = canvasOwner(topic);
        if (owner == null) {
            return unavailable(`No agent has the canvas ${topic} open`);
        }
        if (board != null && board !== getCanvas(owner)?.board) {
            selectCanvasBoard(owner, board);
        }
        setCanvasMode(owner, "canvas", Date.now());
        jumpToAgent(model, owner);
        return OK;
    }
    const roster = [...globalStore.get(model.agentsAtom), ...globalStore.get(model.terminalsAtom)];
    const agent = roster.find((a) => a.blockId != null && a.blockId === caller.blockId);
    if (agent == null || !caller.cwd) {
        return unavailable(`Run wsh ui reveal canvas:${topic} from the agent's terminal`);
    }
    const dir = canvasDir(caller.cwd, topic);
    const project = canvasProjectDir(dir);
    const info = await RpcApi.FileInfoCommand(TabRpcClient, { info: { path: project } });
    if (!current()) {
        return SUPERSEDED;
    }
    if (info == null || info.notfound) {
        return unavailable(`No canvas at ${project}`);
    }
    attachCanvas(agent.id, { topic, dir, projectDir: caller.cwd, board }, Date.now());
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
// selected had a null run and read "Reading this channel…" forever. Exported for Jarvis's own flow (the
// investigation draft), not for cross-surface callers — those open a target. + Run is one of those: it
// sits on the app bar, so a launch started from any surface has to land through the router.
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
