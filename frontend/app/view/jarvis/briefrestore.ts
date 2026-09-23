// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// What the Brief does with the subject stored on the last launch: a dossier becomes the record peek and a
// channel opens its sheet. Pure and total — the caller owns
// the effects.
//
// Deliberately built on restoreDecision rather than re-implementing "is this list loaded yet" and "is this
// id still there": that rule is subtle (it waits only on the ONE list the stored kind needs) and a second
// copy of it would drift.

import { restoreDecision, type StoredSubject, type SubjectListState } from "./subjectrestore";

export type BriefRestorePlan =
    | { action: "wait" }
    | { action: "record"; id: string }
    | { action: "channel"; id: string }
    | { action: "clear" };

export function briefRestorePlan(stored: StoredSubject | null, lists: SubjectListState): BriefRestorePlan {
    const decision = restoreDecision(stored, lists);
    if (decision.action === "wait") {
        return { action: "wait" };
    }
    if (decision.action === "clear") {
        return { action: "clear" };
    }
    const { subject } = decision;
    if (subject.kind === "dossier") {
        return { action: "record", id: subject.id };
    }
    return { action: "channel", id: subject.id };
}
