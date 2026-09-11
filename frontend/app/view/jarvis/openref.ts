// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Open a Jarvis grounding source (an oref) in its native cockpit surface. There is no generic oref router
// in the app; navigation is per-surface (a pending-focus atom + a surfaceAtom flip). Channel / run / task /
// agent / memnote have a clean focus path; the rest no-op. A decision has no route of its own on purpose:
// decisionlog.tsx renders it inside its parent record's thread, so a decision addresses that record with
// the decision id passed as `anchor`. orefNavPlan is a pure, total classifier (never throws); openORef
// performs the side effects.

import { globalStore } from "@/app/store/global";
import * as WOS from "@/app/store/wos";
import type { AgentsViewModel } from "../agents/agents";
import { selectChannel } from "../agents/channelsstore";
import { selectNote } from "../agents/memstore";
import { selectReport } from "../agents/radarstore";
import { vaultFocusAtom, vaultRecordIdAtom, vaultRecordPaneAtom, vaultTabAtom } from "../agents/vaultstore";
import type { QueueOpenTarget } from "./briefingmodel";
import { briefPeekRecordAtom, briefSheetOpenAtom } from "./jarvisstore";
import { loadRecordDetail, selectSubject, setActiveRunId } from "./jarvissubjectstore";
import { pendingDecisionAnchorAtom } from "./petstore";

export type OrefNav =
    | { kind: "channel"; oid: string }
    | { kind: "run"; oid: string }
    | { kind: "task"; oid: string }
    | { kind: "agent"; oid: string }
    | { kind: "memnote"; oid: string }
    | { kind: "effort"; oid: string }
    | { kind: "radarreport"; oid: string }
    | { kind: "unsupported"; otype: string };

// pure + total: classify an oref into a nav plan. Malformed input or an unroutable otype => unsupported.
export function orefNavPlan(oref: string): OrefNav {
    const parts = (oref ?? "").split(":");
    if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
        return { kind: "unsupported", otype: parts[0] ?? "" };
    }
    const [otype, oid] = parts;
    if (
        otype === "channel" ||
        otype === "run" ||
        otype === "task" ||
        otype === "agent" ||
        otype === "memnote" ||
        otype === "effort" ||
        otype === "radarreport"
    ) {
        return { kind: otype, oid };
    }
    return { kind: "unsupported", otype };
}

// The Brief's detail sheet, opened on a subject. These three are the only ways in, and they live beside
// the oref router because every one of them is what an oref resolves to: a channel is a destination, a run
// is a channel's selected run rather than a subject kind of its own, and an initiative is the detail the
// palette's effort rows used to reach through the briefing.
export async function openChannelSheet(channelId: string, runId: string | null): Promise<void> {
    // Selecting the channel is what LOADS it: the sheet's body resolves its run from the active channel's
    // list (stageRunAtom), so a sheet opened on a channel that was never selected had a null run and an
    // unloaded channel — it read "Reading this channel…" and stayed there. Every entry point needs this, so
    // it belongs here rather than in each caller.
    await selectChannel(channelId);
    selectSubject({ kind: "channel", id: channelId });
    if (runId != null) {
        setActiveRunId(channelId, runId);
    }
    globalStore.set(briefSheetOpenAtom, true);
}

export function openEffortSheet(effortId: string): void {
    selectSubject({ kind: "effort", id: effortId });
    globalStore.set(briefSheetOpenAtom, true);
}

// A run is not a fifth subject kind: it resolves from its channel plus the selected run id, which is exactly
// what stageRunAtom reads. The channel comes off the run's own object, because the Brief's run rows are
// projected from WorkState and carry no channel of their own.
export async function openRunSheet(runId: string): Promise<void> {
    const ref = WOS.makeORef("run", runId);
    if (ref == null) {
        return;
    }
    const run = await WOS.loadAndPinWaveObject<Run>(ref).catch(() => null);
    const channelId = run?.channeloid ?? "";
    if (channelId === "") {
        return; // nothing to show it against: a run with no channel has no sheet face
    }
    await openChannelSheet(channelId, runId);
}

// A queue row's destination, from the model's own plan (briefingmodel.queueOpenTarget). A channel row opens
// the sheet — carrying the run it named, so the sheet lands on THAT run — and everything else already has a
// surface of its own, so it goes through the same oref router the palette and the citations use.
export function openQueueTarget(model: AgentsViewModel, target: QueueOpenTarget): void {
    if (target.kind === "channel") {
        void openChannelSheet(target.channelId, target.runId);
        globalStore.set(model.surfaceAtom, "jarvis");
        return;
    }
    void openORef(model, target.oref);
}

// impure: open the oref in its native surface. Unsupported kinds are a deliberate no-op (never an error).
// `anchor` names a sub-object to highlight once the surface lands — today only a decision within a record.
export async function openORef(model: AgentsViewModel, oref: string, anchor?: string): Promise<void> {
    const plan = orefNavPlan(oref);
    if (plan.kind === "channel") {
        await openChannelSheet(plan.oid, null);
        globalStore.set(model.surfaceAtom, "jarvis");
        return;
    }
    if (plan.kind === "run") {
        await openRunSheet(plan.oid);
        globalStore.set(model.surfaceAtom, "jarvis");
        return;
    }
    // a record is the Brief's peek, which is the same destination the palette, a citation and the record
    // band all use — one answer to "show me this record" rather than one per entry point.
    if (plan.kind === "task") {
        globalStore.set(pendingDecisionAnchorAtom, anchor ?? null);
        globalStore.set(briefPeekRecordAtom, plan.oid);
        globalStore.set(model.surfaceAtom, "jarvis");
        return;
    }
    if (plan.kind === "memnote") {
        await selectNote(plan.oid);
        // the memory collection, not merely the Vault surface: the note detail is only reachable there
        globalStore.set(vaultTabAtom, "memory");
        globalStore.set(vaultFocusAtom, "saved");
        globalStore.set(model.surfaceAtom, "vault");
        return;
    }
    if (plan.kind === "agent") {
        model.openTerminal(plan.oid);
    }
    // a scan report is not a grounding source, which is what the rest of this module routes — but it is
    // an oref that has to open in its own surface, and a second router for one otype would be worse.
    // selectReport, not radarSelectedIdAtom: that atom holds the selected FINDING, and pinning the
    // report is what lets an in-flight scan keep streaming into the surface once it lands.
    if (plan.kind === "radarreport") {
        await selectReport(plan.oid);
        globalStore.set(model.surfaceAtom, "radar");
        return;
    }
    // an effort address opens the initiative's own sheet: the Brief's Initiatives rows and the palette's
    // effort rows both land here, where the chunk detail and its two writes live.
    if (plan.kind === "effort") {
        openEffortSheet(plan.oid);
        globalStore.set(model.surfaceAtom, "jarvis");
    }
}

// The Vault's record landing, reached only from the Brief peek's own control. Deliberately not folded into
// the `task:` arm above: that arm means "show me this record", which in the Brief is the peek, and widening
// it would move every palette and citation click off the peek. This one means "go to where this record
// lives", and it exists as its own named route for exactly that reason.
//
// Selection and pane are set BEFORE the surface flips so the Vault mounts on the record rather than on an
// empty index, and the peek is cleared so the modal does not reappear over the surface the user asked for.
export function openRecordInVault(model: AgentsViewModel, dossierId: string): void {
    globalStore.set(vaultRecordIdAtom, dossierId);
    globalStore.set(vaultRecordPaneAtom, "detail");
    loadRecordDetail(dossierId);
    globalStore.set(briefPeekRecordAtom, null);
    globalStore.set(vaultTabAtom, "records");
    globalStore.set(model.surfaceAtom, "vault");
}
