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
import { runAtom, selectChannel } from "../agents/channelsstore";
import { selectNote } from "../agents/memstore";
import { selectReport } from "../agents/radarstore";
import { pendingRunFocusAtom } from "../agents/runactions";
import { vaultFocusAtom, vaultRecordIdAtom, vaultRecordPaneAtom, vaultTabAtom } from "../agents/vaultstore";
import { expandEffort } from "./effortstore";
import { briefPeekRecordAtom, jarvisCompositionAtom } from "./jarvisstore";
import { loadRecordDetail, selectSubject } from "./jarvissubjectstore";
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

// impure: open the oref in its native surface. Unsupported kinds are a deliberate no-op (never an error).
// `anchor` names a sub-object to highlight once the surface lands — today only a decision within a record.
export async function openORef(model: AgentsViewModel, oref: string, anchor?: string): Promise<void> {
    const plan = orefNavPlan(oref);
    if (plan.kind === "channel") {
        await selectChannel(plan.oid);
        selectSubject({ kind: "channel", id: plan.oid });
        globalStore.set(model.surfaceAtom, "jarvis");
        return;
    }
    if (plan.kind === "run") {
        const ref = WOS.makeORef("run", plan.oid);
        if (!ref) {
            return;
        }
        await WOS.loadAndPinWaveObject(ref);
        const run = globalStore.get(runAtom(plan.oid));
        if (run?.channeloid) {
            globalStore.set(pendingRunFocusAtom, { channelId: run.channeloid, runId: plan.oid });
            globalStore.set(model.surfaceAtom, "jarvis");
        }
        return;
    }
    // a record has a surface for the first time: it is a subject on the merged Stage, not a separate tab.
    // In the Brief there is no Stage, so the destination is the peek instead — the same one-branch shape
    // the radarreport route uses rather than a second router, and the arm B5 deletes when the panes go.
    if (plan.kind === "task") {
        globalStore.set(pendingDecisionAnchorAtom, anchor ?? null);
        if (globalStore.get(jarvisCompositionAtom) === "brief") {
            globalStore.set(briefPeekRecordAtom, plan.oid);
        } else {
            selectSubject({ kind: "dossier", id: plan.oid });
        }
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
    // an effort address opens the briefing with that effort expanded (spec UI §1): the subjects
    // column and delta rows point here, and the detail subject is the expanded card's own "details".
    if (plan.kind === "effort") {
        selectSubject({ kind: "briefing", id: "all" });
        await expandEffort("effort:" + plan.oid);
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
