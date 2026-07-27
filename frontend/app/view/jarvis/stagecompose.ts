// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// What the Stage draws for each subject kind. The rule is "absent rather than empty": a band a subject
// cannot have is not rendered, never greyed out and parked. One table so a control cannot drift onto the
// wrong subject.

import { subjectMark, type SubjectKind, type SubjectMark } from "./subjects";

export interface StageComposition {
    mark: SubjectMark;
    showAutonomy: boolean;
    showProfile: boolean;
    reachText: string | null; // static statement of grounding reach; not a control (Spaces own scoping)
    absenceChip: string | null;
    recordBand: "attributed" | "subject" | "mentions";
    showPipeline: boolean;
    thread: "run" | "record" | "turns";
    composerTarget: "worker-or-jarvis" | "jarvis-record" | "jarvis-thread";
    showFleet: boolean;
    fleetTitle: string | null;
}

const TABLE: Record<SubjectKind, Omit<StageComposition, "mark">> = {
    channel: {
        showAutonomy: true,
        showProfile: true,
        reachText: null,
        absenceChip: null,
        recordBand: "attributed",
        showPipeline: true,
        thread: "run",
        composerTarget: "worker-or-jarvis",
        showFleet: true,
        fleetTitle: "Fleet",
    },
    dossier: {
        showAutonomy: false,
        showProfile: false,
        reachText: "this record + its runs",
        absenceChip: "Record · not a run",
        recordBand: "subject",
        showPipeline: false,
        thread: "record",
        composerTarget: "jarvis-record",
        showFleet: true,
        fleetTitle: "Fleet · on this record",
    },
    conversation: {
        showAutonomy: false,
        showProfile: false,
        reachText: "all projects",
        absenceChip: "No channel · no fleet · no profile",
        recordBand: "mentions",
        showPipeline: false,
        thread: "turns",
        composerTarget: "jarvis-thread",
        showFleet: false,
        fleetTitle: null,
    },
};

export function composeStage(kind: SubjectKind): StageComposition {
    return { mark: subjectMark(kind), ...TABLE[kind] };
}
