// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Which ambient views apply to the subject on the Stage. Pure, and returns data rather than JSX so the
// decision is testable without a renderer — this table used to be implicit in which run render branch
// happened to draw, which is how a sealed run (RunCompletion, not RunHeader) came to show none of them.
//
// | subject | resume | proactive | decisions |
// | channel with a run | that run, any status | that run | that run's oref |
// | channel, draft or no run | — | — | — |
// | dossier | most recent by ResumeVM.updated | — | — |
// | conversation | — | — | — |
//
// A dossier gets no suggestion because a suggestion is written at dispatch and is about that goal; across a
// record's runs it would be several stale ones competing. A dossier gets no decisions block because a record
// already renders its own decision log in the thread (decisionlog.tsx). A conversation gets nothing at all:
// every one of the three is run-scoped and a thread has no run.

import { readProactiveSuggestion } from "@/app/view/agents/proactive";
import { readResumeCard } from "@/app/view/agents/resume";
import type { SubjectKind } from "./subjects";

export interface AmbientRailInput {
    kind: SubjectKind;
    // the run the Stage resolved (channel subjects) — see jarvissubjectstore.stageRunAtom
    run?: Run | null;
    // a record's attributed runs (dossier subjects) — see jarvissubjectstore.recordRunsAtom
    recordRuns?: Run[];
    // whether the attribution engine has decisions for `run`. Not derivable here: it needs the ambient
    // provider, which is not pure.
    hasDecisions?: boolean;
}

export interface AmbientRailModel {
    resumeRun: Run | null;
    proactiveRun: Run | null;
    decisionsORef: string | null;
}

// the most recent narrative wins: "where this stands" is singular, and ResumeVM.updated makes the pick
// deterministic. Earlier narratives stay reachable as history through the record's own run list.
function latestNarrated(runs: Run[]): Run | null {
    let best: Run | null = null;
    let bestUpdated = -Infinity;
    for (const r of runs) {
        const vm = readResumeCard(r);
        if (vm == null) {
            continue;
        }
        if (vm.updated >= bestUpdated) {
            best = r;
            bestUpdated = vm.updated;
        }
    }
    return best;
}

export function ambientRailFor(input: AmbientRailInput): AmbientRailModel | null {
    let model: AmbientRailModel;
    if (input.kind === "channel") {
        const run = input.run ?? null;
        if (run == null) {
            return null;
        }
        model = {
            resumeRun: readResumeCard(run) != null ? run : null,
            proactiveRun: readProactiveSuggestion(run) != null ? run : null,
            decisionsORef: input.hasDecisions ? `run:${run.id}` : null,
        };
    } else if (input.kind === "dossier") {
        model = { resumeRun: latestNarrated(input.recordRuns ?? []), proactiveRun: null, decisionsORef: null };
    } else {
        return null;
    }
    // absent rather than empty: a section drawn with nothing in it is worse than no section
    if (model.resumeRun == null && model.proactiveRun == null && model.decisionsORef == null) {
        return null;
    }
    return model;
}
