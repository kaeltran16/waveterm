// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Contextual entry into Jarvis from Run / Radar / Memory: build a SourceRef for the object, start a recall
// conversation in an "attached" scope with a suggested prompt pre-filled, and open the Jarvis surface. This
// is the same producer->consumer handoff direction as channelactions' @jarvis handoff (agents surface ->
// Jarvis), so the agents surfaces importing AskJarvisButton is a sanctioned agents->jarvis import.

import { globalStore } from "@/app/store/global";
import * as WOS from "@/app/store/wos";
import type { AgentsViewModel } from "../agents/agents";
import type { MemNote } from "../agents/memtypes";
import type { JarvisScope, SourceRef, SourceType } from "./jarviscontract";
import { jarvisDraftAtom, jarvisModeAtom, startConversation } from "./jarvisstore";

export function sourceRefForRun(run: Run): SourceRef {
    return { oref: WOS.makeORef("run", run.id) ?? `run:${run.id}`, sourceType: "run", title: run.goal };
}
export function sourceRefForRadar(finding: RadarFinding): SourceRef {
    return { oref: `radar:${finding.id}`, sourceType: "radar", title: finding.risk };
}
export function sourceRefForMemory(note: MemNote): SourceRef {
    return { oref: `memory:${note.id}`, sourceType: "memory", title: note.title };
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
    startConversation(attachedScope(ref)); // creates + activates the conversation (jarvisstore)
    globalStore.set(jarvisDraftAtom, suggestedPrompt(ref.sourceType));
    globalStore.set(jarvisModeAtom, "recall");
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
