// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// What the Brief does with the subject the three-pane composition stored on the last launch.
//
// The three-pane restore lands on a Stage subject; the Brief has no Stage, so the same stored value means
// something else here: a dossier becomes the record peek, a conversation becomes a hydrated thread, and a
// channel has no destination at all until B5 gives it one. Pure and total — the caller owns the effects.
//
// Deliberately built on restoreDecision rather than re-implementing "is this list loaded yet" and "is this
// id still there": that rule is subtle (it waits only on the ONE list the stored kind needs) and a second
// copy of it would drift.

import { restoreDecision, type StoredSubject, type SubjectListState } from "./subjectrestore";

export type BriefRestorePlan =
    | { action: "wait" }
    | { action: "record"; id: string }
    | { action: "conversation"; id: string }
    | { action: "defer-channel" }
    | { action: "clear" };

export function briefRestorePlan(stored: StoredSubject | null, lists: SubjectListState): BriefRestorePlan {
    // A channel is decided before restoreDecision, not through it: the Brief has no destination for one, so
    // whether the id still exists changes nothing about what this composition can do with it. The stored
    // subject is left in place for B5 to honour rather than cleared, and one launch of a no-op costs
    // nothing against losing a restore target the user never asked to forget.
    if (stored != null && stored.kind === "channel") {
        return { action: "defer-channel" };
    }
    const decision = restoreDecision(stored, lists);
    if (decision.action === "wait") {
        return { action: "wait" };
    }
    if (decision.action === "clear") {
        return { action: "clear" };
    }
    const { subject } = decision;
    return subject.kind === "dossier"
        ? { action: "record", id: subject.id }
        : { action: "conversation", id: subject.id };
}
