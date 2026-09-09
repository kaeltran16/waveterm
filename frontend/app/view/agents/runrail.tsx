// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Run rail section: what the live run is doing. The status card used to be pushed into the run body
// above the timeline, where it scrolled away from the thing it described.
//
// Setting a run *up* is not in here — that is the launcher (runlauncher.tsx), which fills the Stage's
// thread slot while a run is being composed. The rail is read-oriented (needs-you, ambient, this), and
// putting the surface's one dispatch gesture into a collapsible reading panel meant the primary action
// could be hidden by a persisted preference.

import type { RailSection } from "@/app/element/collapsiblerail";
import { openDagLive } from "@/app/view/orchestrate/dagmodalstate";
import { DagOverview } from "@/app/view/orchestrate/dagoverview";
import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import { RAIL_ICON } from "./railicons";
import { EYEBROW } from "./runlauncher";

// Absent rather than empty when there is no task graph to show: a pipeline run has no DAG, and an empty
// status panel says less than no section at all. The question is "is there a graph", not "is it running"
// — a finished DAG is still what you want to read when its run is selected.
//
// The one control added to the overview is the way into the full route graph. That button used to sit in
// the run header, three regions away from the status it belongs to.
export function runRailSection(input: {
    model: AgentsViewModel;
    agents: AgentVM[];
    channelId: string | null;
    run: Run | undefined;
}): RailSection | null {
    const { channelId, run, model, agents } = input;
    if (channelId == null || run == null || !run.dagoref) {
        return null;
    }
    const dagOref = "dag:" + run.dagoref;
    return {
        id: "run",
        icon: RAIL_ICON.subagents,
        label: "Run",
        content: (
            <div className="flex flex-col gap-3.5">
                <div className="flex items-center gap-2">
                    <span className={EYEBROW}>Run</span>
                    <div className="flex-1" />
                    <button
                        type="button"
                        onClick={() => openDagLive(channelId, run.id, dagOref)}
                        className="cursor-pointer whitespace-nowrap rounded-[6px] border border-accent/50 bg-accent/10 px-2 py-1 font-mono text-[10.5px] font-semibold text-accent-soft hover:border-accent"
                    >
                        Route DAG ↗
                    </button>
                </div>
                <DagOverview channelId={channelId} runId={run.id} dagOref={dagOref} model={model} agents={agents} />
            </div>
        ),
    };
}
