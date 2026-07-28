// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Open a Jarvis grounding source (an oref) in its native cockpit surface. There is no generic oref router
// in the app; navigation is per-surface (a pending-focus atom + a surfaceAtom flip). Channel / run / task /
// agent have a clean focus path; the rest no-op (memory and radar need new per-object focus plumbing;
// decision/commit have no surface). orefNavPlan is a pure, total classifier (never throws); openORef
// performs the side effects.

import { globalStore } from "@/app/store/global";
import * as WOS from "@/app/store/wos";
import type { AgentsViewModel } from "../agents/agents";
import { runAtom, selectChannel } from "../agents/channelsstore";
import { pendingRunFocusAtom } from "../agents/runactions";
import { selectSubject } from "./jarvissubjectstore";

export type OrefNav =
    | { kind: "channel"; oid: string }
    | { kind: "run"; oid: string }
    | { kind: "task"; oid: string }
    | { kind: "agent"; oid: string }
    | { kind: "unsupported"; otype: string };

// pure + total: classify an oref into a nav plan. Malformed input or an unroutable otype => unsupported.
export function orefNavPlan(oref: string): OrefNav {
    const parts = (oref ?? "").split(":");
    if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
        return { kind: "unsupported", otype: parts[0] ?? "" };
    }
    const [otype, oid] = parts;
    if (otype === "channel" || otype === "run" || otype === "task" || otype === "agent") {
        return { kind: otype, oid };
    }
    return { kind: "unsupported", otype };
}

// impure: open the oref in its native surface. Unsupported kinds are a deliberate no-op (never an error).
export async function openORef(model: AgentsViewModel, oref: string): Promise<void> {
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
        selectSubject({ kind: "dossier", id: plan.oid });
        globalStore.set(model.surfaceAtom, "jarvis");
        return;
    }
    if (plan.kind === "agent") {
        model.openTerminal(plan.oid);
    }
}
