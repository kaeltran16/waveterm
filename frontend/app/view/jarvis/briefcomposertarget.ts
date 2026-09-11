// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Who a keystroke in the Brief's one composer reaches. The composer never moves and never unmounts, so
// this is the only thing that decides whether Enter lands in Jarvis or in a running worker's terminal;
// briefcompose.ts says that decision out loud and this makes it.
//
// It replaces composertarget.ts, which answered the same question for the Stage and was deleted with it
// (git show fb9034bb^:frontend/app/view/jarvis/composertarget.ts). The difference: the Stage carried a
// composerTarget field on its composition, while the Brief has no such field — what the detail sheet is
// currently drawing IS the context, so the target is derived from the sheet face.

import type { AgentVM } from "@/app/view/agents/agentsviewmodel";
import { steerTarget } from "@/app/view/agents/runmodel";
import type { SheetFace } from "./briefsheetmodel";

export type BriefComposerTarget =
    // the Brief's own thread: an ask across all work, or grounded in whatever the thread attached
    | { audience: "brief" }
    // an initiative drawer. Still Jarvis — an initiative has no worker to message — but the ask carries
    // the effort so the answer is scoped to it rather than to everything.
    | { audience: "initiative"; effortORef: string; name: string }
    // a session drawer with a live lead. This is the only shape whose Enter leaves Jarvis entirely.
    | { audience: "worker"; channelId: string; workerORef: string; workerName: string; sessionName: string };

export interface BriefTargetInput {
    sheetOpen: boolean;
    face: SheetFace;
    run: Run | null;
    agents: AgentVM[];
    projectName?: string;
    effortTitle?: string;
}

/** Pure: what the sheet is drawing -> who the composer is talking to. */
export function resolveBriefComposerTarget(input: BriefTargetInput): BriefComposerTarget {
    const face = input.face;
    if (!input.sheetOpen || face.kind === "none") {
        return { audience: "brief" };
    }
    if (face.kind === "effort") {
        return {
            audience: "initiative",
            effortORef: `effort:${face.effortId}`,
            name: input.effortTitle?.trim() ?? "",
        };
    }
    // the launcher face has no run at all, and a terminal run has no live lead: steerTarget answers both.
    if (face.body !== "run" || input.run == null) {
        return { audience: "brief" };
    }
    const lead = steerTarget(input.run, input.agents);
    // A worker with no blockId has no terminal to write to, so steerWorker would no-op. Claiming "Message
    // the lead of this session" over a send that silently does nothing is the same defect as an inert
    // label, so the absence of a writable block drops the composer back to Jarvis, which does work.
    if (lead?.blockId == null || lead.blockId === "") {
        return { audience: "brief" };
    }
    return {
        audience: "worker",
        channelId: face.channelId,
        workerORef: `tab:${lead.id}`,
        workerName: lead.name,
        sessionName: input.projectName?.trim() || lead.name,
    };
}
