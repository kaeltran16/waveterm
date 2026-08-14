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
import { pendingRunFocusAtom } from "../agents/runactions";
import { selectSubject } from "./jarvissubjectstore";
import { expandEffort } from "./effortstore";
import { pendingDecisionAnchorAtom } from "./petstore";

export type OrefNav =
    | { kind: "channel"; oid: string }
    | { kind: "run"; oid: string }
    | { kind: "task"; oid: string }
    | { kind: "agent"; oid: string }
    | { kind: "memnote"; oid: string }
    | { kind: "effort"; oid: string }
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
        otype === "effort"
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
    if (plan.kind === "task") {
        globalStore.set(pendingDecisionAnchorAtom, anchor ?? null);
        selectSubject({ kind: "dossier", id: plan.oid });
        globalStore.set(model.surfaceAtom, "jarvis");
        return;
    }
    if (plan.kind === "memnote") {
        await selectNote(plan.oid);
        globalStore.set(model.surfaceAtom, "memory");
        return;
    }
    if (plan.kind === "agent") {
        model.openTerminal(plan.oid);
    }
    // an effort address opens the briefing with that effort expanded (spec UI §1): the subjects
    // column and delta rows point here, and the detail subject is the expanded card's own "details".
    if (plan.kind === "effort") {
        selectSubject({ kind: "briefing", id: "all" });
        await expandEffort("effort:" + plan.oid);
        globalStore.set(model.surfaceAtom, "jarvis");
    }
}
