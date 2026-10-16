// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { MONO_META } from "@/app/view/jarvis/briefstyle";
import { finalStageEndable } from "@/app/view/jarvis/runsheetmodel";
import { useAtomValue } from "jotai";
import { useState } from "react";
import { shownStep, type FinalStageView, type FinalStepKey } from "../agents/finalstage";
import {
    EndFinalStage,
    FinalKeptOutput,
    FinalOutcome,
    FinalOutput,
    FinalShotsLink,
    FinalStepCells,
} from "../agents/finalstageviews";
import { fmtDuration } from "../agents/runcompletion";
import { DESC_MAX_PX } from "./dagdetailrail";
import { openFinalFromGraph, verifierTabId } from "./dagfinalpeek";
import { dagModalAgentsContextAtom } from "./dagmodalstate";
import { reviewerRouteOf } from "./taskroute";

// the output tail the rail has room for under the steps
const OUTPUT_LINES = 6;
// the end form opens under its button, and the modal clips what leaves the rail: a running stage's rail is
// at least tall enough to hold it
const END_FORM_ROOM_PX = 190;

// when the verifier starts, until it has: after the Final command, or beside the other commands
function verifierLine(group: TaskGroup, view: FinalStageView): string {
    const verifier = view.steps[view.steps.length - 1];
    if (verifier.state !== "waiting") return verifier.text;
    if (group.finalcmd) return "starts after Final";
    const beside = view.steps.filter((s) => s.key === "check" || s.key === "verify").map((s) => s.label);
    return beside.length > 0 ? `starts alongside ${beside.join(" and ")}` : "";
}

// the final stage's rail under the graph, in place of a task's while the final node is selected: each step
// with its command, then the running output, or how the stage ended. A click on a step that ended shows the
// output it kept instead.
export function DagFinalRail({ group, owner, view }: { group: TaskGroup; owner: Run; view: FinalStageView }) {
    const agentsCtx = useAtomValue(dagModalAgentsContextAtom);
    const { route, custom } = reviewerRouteOf(group, owner);
    const state = view.tone === "run" ? "running" : view.state || "waiting";
    const when = verifierLine(group, view);
    const [picked, setPicked] = useState<FinalStepKey | null>(null);
    const shown = shownStep(view, picked);
    const kept = shown?.state !== "running" ? shown?.kept : undefined;
    return (
        <div
            data-dag-final-rail
            style={{ minHeight: finalStageEndable(group) ? END_FORM_ROOM_PX : undefined }}
            className="flex flex-none flex-col gap-2.5 border-t border-border bg-lane px-4 py-2.5"
        >
            <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                    <div className={MONO_META}>
                        final · round {view.round} · {state}
                        {view.stageMs != null ? ` · ${fmtDuration(view.stageMs)}` : ""}
                    </div>
                    <div className="truncate text-[13px] font-semibold text-ink-hi">Final verification</div>
                    <div className="truncate font-mono text-[10.5px] text-secondary">
                        <span className="text-ink-mid">verifier</span> · {custom ? "reviewers route" : "same as lead"} ·{" "}
                        {route.runtime} / {route.model || "default"}
                        {when ? ` · ${when}` : ""}
                    </div>
                </div>
                <div className="flex flex-none items-center gap-1.5">
                    {verifierTabId(group, owner, agentsCtx?.agents) != null ? (
                        <button
                            type="button"
                            onClick={() => openFinalFromGraph(group, owner)}
                            className="flex-none cursor-pointer rounded-[5px] border border-accent/50 px-1.5 py-0.5 font-mono text-[10.5px] font-bold text-accent-soft hover:border-accent"
                        >
                            Open in Agent ↗
                        </button>
                    ) : null}
                    <EndFinalStage group={group} channelId={group.channelid} runId={group.runid} />
                </div>
            </div>
            <FinalStepCells
                steps={view.steps}
                showCommand
                shown={shown?.key}
                onPick={(key) => setPicked(picked === key ? null : key)}
            />
            {kept ? (
                <div className="sc min-h-0 overflow-auto" style={{ maxHeight: DESC_MAX_PX }}>
                    <FinalKeptOutput key={shown.key} kept={kept} />
                </div>
            ) : (
                <>
                    <FinalOutput output={view.output} lines={OUTPUT_LINES} />
                    <div className="flex min-h-0 flex-col empty:hidden" style={{ maxHeight: DESC_MAX_PX }}>
                        <FinalOutcome view={view} />
                    </div>
                </>
            )}
            <FinalShotsLink group={group} />
        </div>
    );
}
