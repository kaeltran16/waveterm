// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The session sheet's live-reconfiguration logic, as data. Three rules shape everything here, and all
// three are consequences of the same fact — a running plan has already committed to its shape:
//
//   * only an engine orchestrator has a scheduler to reconfigure, and only while it is still live;
//   * the effective settings live on the TaskGroup once a DAG exists, because that is what the scheduler
//     reads, and on the Run before that, because that is what DagSubmit will read;
//   * the plan gate is editable only while nothing has crossed it.
//
// A missing run renders as unavailable rather than as stale controls over a run that no longer exists.

import { MAX_PARALLELISM } from "../agents/runconfig";

export const PLAN_GATE_SPENT_APPROVED = "the plan was approved";
export const PLAN_GATE_SPENT_DISPATCHED = "work is already running";

export type SheetFace =
    | { kind: "missing" }
    | { kind: "readonly"; reason: string }
    | { kind: "editable"; gateEditable: boolean };

export type RunSettingsDraft = {
    parallelism: number;
    workerRoute: RoutePin | null;
    planGate: boolean;
};

// the engine resolves every dispatch width through this, not just CreateRun.
const TERMINAL_DAG = new Set(["done", "cancelled"]);

export type RunSettingsPanelState =
    | { kind: "missing" }
    | { kind: "loading" }
    | { kind: "unavailable"; reason: "missing" | "error" }
    | { kind: "readonly"; reason: string }
    | { kind: "editable"; gateEditable: boolean };

// How far the sheet has got with the TaskGroup a run links. "missing" is a loaded read that found nothing
// (the group was deleted); "error" is a read that failed. Neither may fall back to the run's launch
// snapshot — the engine owns these settings once a plan exists, and the snapshot is not what it is running.
export type LinkedGroupRead = "loading" | "ready" | "missing" | "error";

// What the sheet may render, given how far the linked group has got. A run that links a DAG has mutable
// settings, but never from the launch snapshot: until the group arrives the sheet cannot know what the
// scheduler is actually running at, and a save sent from the snapshot would overwrite it. A failed or
// vanished group states that plainly instead of reading as loading forever.
export function runSettingsPanelState(
    run: Run | null | undefined,
    group: TaskGroup | null,
    groupRead: LinkedGroupRead
): RunSettingsPanelState {
    if (run == null) {
        return { kind: "missing" };
    }
    if ((run.dagoref ?? "") !== "") {
        if (groupRead === "loading") {
            return { kind: "loading" };
        }
        if (groupRead === "error") {
            return { kind: "unavailable", reason: "error" };
        }
        if (groupRead === "missing" || group == null) {
            return { kind: "unavailable", reason: "missing" };
        }
    }
    return sheetFace(run, group);
}

export function sheetFace(run: Run | null | undefined, group: TaskGroup | null): SheetFace {
    if (run == null) {
        return { kind: "missing" };
    }
    if (run.status === "done" || run.status === "cancelled") {
        return { kind: "readonly", reason: `this run is ${run.status}` };
    }
    if (run.mode !== "orchestrator") {
        return { kind: "readonly", reason: `a ${run.mode} run has no scheduler to reconfigure` };
    }
    // an empty orchestration predates the control; the runtime decided then, exactly as the prompt does.
    const machine = run.orchestration || (run.runtime === "pi" ? "engine" : "adaptive");
    if (machine !== "engine") {
        return { kind: "readonly", reason: "an adaptive lead runs its own subagents" };
    }
    return { kind: "editable", gateEditable: gateEditable(group) };
}

// The mirror of jarvis.GateSettingsBlocker: a nil group has its whole gate ahead of it, an approved or
// terminal one has spent it, and a dispatched task proves it was spent whether or not it was recorded.
export function gateEditable(group: TaskGroup | null): boolean {
    if (group == null) {
        return true;
    }
    if (TERMINAL_DAG.has(group.status) || (group.planapprovedts ?? 0) !== 0) {
        return false;
    }
    return !(group.tasks ?? []).some((t) => (t.runid ?? "") !== "");
}

// Why the gate is locked, for the line the sheet prints beside the disabled control.
export function gateLockReason(group: TaskGroup | null): string {
    if (group == null) {
        return "";
    }
    if ((group.planapprovedts ?? 0) !== 0) {
        return PLAN_GATE_SPENT_APPROVED;
    }
    return PLAN_GATE_SPENT_DISPATCHED;
}

// The sheet's starting values. After submission the group wins: reading the run there would print the
// launch snapshot beside a scheduler honouring something else.
export function runSettingsDraft(run: Run, group: TaskGroup | null): RunSettingsDraft {
    if (group != null) {
        return {
            parallelism: group.parallelism,
            workerRoute: group.workerroute ?? null,
            planGate: group.plangate ?? false,
        };
    }
    const topLevel = run.parentleadoref == null || run.parentleadoref === "";
    return {
        parallelism: run.parallelism ?? 0,
        workerRoute: run.workerroute ?? null,
        planGate: run.plangatepending ?? topLevel,
    };
}

export function draftIsDirty(a: RunSettingsDraft, b: RunSettingsDraft): boolean {
    return a.parallelism !== b.parallelism || a.planGate !== b.planGate || !sameRoute(a.workerRoute, b.workerRoute);
}

// What the sheet re-seeds its draft on: every effective mutable input, from whichever object currently owns
// it (the group after submission, the run before). A key rather than the objects themselves, so a live
// status tick — which changes the object but none of these fields — never wipes what the user has typed.
export function draftSeedKey(run: Run, group: TaskGroup | null): string {
    const draft = runSettingsDraft(run, group);
    const route = draft.workerRoute;
    return [
        draft.parallelism,
        draft.planGate ? "gate" : "nogate",
        route?.runtime ?? "",
        route?.tier ?? "",
        route?.model ?? "",
    ].join("|");
}

function sameRoute(a: RoutePin | null, b: RoutePin | null): boolean {
    if (a == null || b == null) {
        return a == null && b == null;
    }
    return a.runtime === b.runtime && a.tier === b.tier && (a.model ?? "") === (b.model ?? "");
}

// A submitted plan already holds a concrete width, so the sheet never offers "let the lead choose".
export function parallelismInvalid(n: number): boolean {
    return !Number.isInteger(n) || n < 1 || n > MAX_PARALLELISM;
}

// includeGate is false when the sheet was not allowed to touch the gate: sending it anyway would ask the
// server to re-assert a value the user never edited, and turn a spent gate into a refused save.
export function settingsPayload(
    channelId: string,
    runId: string,
    draft: RunSettingsDraft,
    opts: { includeGate?: boolean } = {}
): CommandSetRunSettingsData {
    const payload: CommandSetRunSettingsData = {
        channelid: channelId,
        runid: runId,
        parallelism: draft.parallelism,
    };
    if (draft.workerRoute != null) {
        payload.workerroute = draft.workerRoute;
    }
    if (opts.includeGate !== false) {
        payload.plangate = draft.planGate;
    }
    return payload;
}

// Everything about a run that a future launch could inherit: the launched facts from the run, the mutable
// dials from the draft. Shape, machine and the lead route are immutable here, which is exactly why they are
// the run's own values rather than anything the sheet could have edited.
export type EffectiveRunConfig = {
    shape: string;
    machine: string;
    parallelism: number;
    leadRoute: RoutePin | null;
    workerRoute: RoutePin | null;
    planGate: boolean;
};

export function effectiveRunConfig(run: Run, draft: RunSettingsDraft): EffectiveRunConfig {
    return {
        shape: run.mode || "quick",
        machine: run.orchestration || (run.runtime === "pi" ? "engine" : "adaptive"),
        parallelism: draft.parallelism,
        leadRoute: leadRouteOf(run),
        workerRoute: draft.workerRoute,
        planGate: draft.planGate,
    };
}

function leadRouteOf(run: Run): RoutePin | null {
    if ((run.runtime ?? "") === "") {
        return null;
    }
    return { runtime: run.runtime, tier: run.tier || "capable", ...(run.model ? { model: run.model } : {}) };
}

// "Save as project defaults" copies the whole effective configuration — copying only part of it would
// leave the next launch materially different from the run it was saved from, which is the opposite of what
// the button says. Every other override section is left alone.
export function engineDefaultsPatch(override: ProfileOverride, config: EffectiveRunConfig): ProfileOverride {
    return {
        ...override,
        defaultmode: config.shape,
        machine: config.machine,
        parallelism: config.parallelism,
        route: config.leadRoute ?? undefined,
        workerroute: config.workerRoute ?? undefined,
        defaultplangate: config.planGate,
    };
}

export function routeLabel(route: RoutePin | null | undefined): string {
    if (route == null || (route.runtime ?? "") === "") {
        return "inherit the lead";
    }
    return [route.runtime, route.model || route.tier].filter((p) => p != null && p !== "").join(" · ");
}
