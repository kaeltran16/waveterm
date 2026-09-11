// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Contextual entry into Jarvis from Run / Radar / Memory: build a SourceRef for the object, start a recall
// conversation in an "attached" scope with a suggested prompt pre-filled, and open the Jarvis surface. The
// handoff runs agents -> Jarvis, so the agents surfaces importing AskJarvisButton is a sanctioned
// agents->jarvis import.

import { globalStore } from "@/app/store/global";
import * as WOS from "@/app/store/wos";
import type { AgentsViewModel } from "../agents/agents";
import type { MemNote } from "../agents/memtypes";
import { primeBriefThread } from "./briefingstore";
import type { JarvisScope, SourceRef, SourceType } from "./jarviscontract";

export function sourceRefForRun(run: Run): SourceRef {
    return { oref: WOS.makeORef("run", run.id) ?? `run:${run.id}`, sourceType: "run", title: run.goal };
}
export function sourceRefForRadar(finding: RadarFinding): SourceRef {
    return { oref: `radar:${finding.id}`, sourceType: "radar", title: finding.risk };
}
export function sourceRefForMemory(note: MemNote): SourceRef {
    return { oref: `memory:${note.id}`, sourceType: "memory", title: note.title };
}
// A graph node's id is a bare id for a vault node and already a full oref for a run —
// ResolveDossierEdges emits RunORef, so the run's id IS its address. Prefixing blindly would produce
// "run:run:…" and send the ask after a source that does not exist.
export function sourceRefForGraphNode(node: GraphNode): SourceRef {
    return {
        oref: node.kind === "run" ? node.id : `${node.kind}:${node.id}`,
        // the cast is the graph peek's own existing mapping, unchanged: `kind` drives the citation icon,
        // and routing reads the oref, so an unmapped kind costs a generic badge rather than a wrong
        // destination. Narrowing it here would be a second copy of the SourceType vocabulary.
        sourceType: node.kind as SourceType,
        title: node.label,
    };
}

const CHIP_LABEL: Partial<Record<SourceType, string>> = {
    run: "This Run",
    radar: "This finding",
    memory: "This memory",
};

export function attachedScope(ref: SourceRef): JarvisScope {
    return {
        mode: "attached",
        chips: [{ label: CHIP_LABEL[ref.sourceType] ?? "This source", active: true }],
        attached: [ref],
    };
}

export function suggestedPrompt(t: SourceType): string {
    switch (t) {
        case "run":
            return "What changed in this Run and why?";
        case "radar":
            return "Explain this Radar finding.";
        case "memory":
            return "Recall decisions related to this.";
        default:
            return "";
    }
}

export function openJarvisWithSource(model: AgentsViewModel, ref: SourceRef): void {
    // one attached stateless thread, re-primed from this source: the Brief's thread is not a persisted
    // conversation, so there is no per-source thread to reuse — priming replaces whatever was asked before.
    primeBriefThread(attachedScope(ref), suggestedPrompt(ref.sourceType));
    globalStore.set(model.surfaceAtom, "jarvis");
}

export function AskJarvisButton({
    model,
    sourceRef,
    label,
}: {
    model: AgentsViewModel;
    sourceRef: SourceRef;
    label: string;
}) {
    return (
        <button
            type="button"
            onClick={() => openJarvisWithSource(model, sourceRef)}
            className="rounded border border-accent/25 px-2.5 py-1.5 text-[11.5px] font-semibold text-accent-soft hover:border-accent/40"
        >
            {label}
        </button>
    );
}
