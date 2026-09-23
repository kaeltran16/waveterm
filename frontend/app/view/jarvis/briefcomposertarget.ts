// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Whether the Brief has a composer at all, and whose terminal a keystroke in it reaches. The composer is
// steer-only: it exists on a session sheet with a live lead and nowhere else, since every other shape it
// once had asked Jarvis, and the Ask audiences were retired 2026-09-23 (docs/deferred.md).
//
// The target is derived from the sheet face: what the detail sheet is drawing IS the context.

import type { AgentVM } from "@/app/view/agents/agentsviewmodel";
import { steerTarget } from "@/app/view/agents/runmodel";
import type { SheetFace } from "./briefsheetmodel";

// The one shape a Brief composer has: a session drawer with a live lead. Anything else has no one to
// talk to, so there is no composer.
export type BriefComposerTarget = {
    audience: "worker";
    channelId: string;
    workerORef: string;
    workerName: string;
    sessionName: string;
};

export interface BriefTargetInput {
    sheetOpen: boolean;
    face: SheetFace;
    run: Run | null;
    agents: AgentVM[];
    projectName?: string;
}

/** Pure: what the sheet is drawing -> who the composer is talking to, or null for no composer. */
export function resolveBriefComposerTarget(input: BriefTargetInput): BriefComposerTarget | null {
    const face = input.face;
    // the launcher face has no run at all, and a terminal run has no live lead: steerTarget answers both.
    if (!input.sheetOpen || face.kind !== "channel" || face.body !== "run" || input.run == null) {
        return null;
    }
    const lead = steerTarget(input.run, input.agents);
    // a worker with no blockId has no terminal to write to, so steerWorker would no-op: no composer
    // rather than one whose send silently does nothing.
    if (lead?.blockId == null || lead.blockId === "") {
        return null;
    }
    return {
        audience: "worker",
        channelId: face.channelId,
        workerORef: `tab:${lead.id}`,
        workerName: lead.name,
        sessionName: input.projectName?.trim() || lead.name,
    };
}
