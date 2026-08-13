// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Restoring the last subject on boot. The hard part is not persistence but validation: a stored id can name
// a channel, record or thread that no longer exists, and the lists load asynchronously. So each kind's list
// is null until it has loaded, and the decision waits only on the ONE list the stored subject needs.
//
// Degrading to the empty Stage is deliberate and silent — the surface's rule is absent rather than empty.

import type { SubjectKind } from "./subjects";

// structurally identical to ActiveSubject on purpose: importing it would point this pure module at
// jarvissubjectstore.ts, which already imports the store. Do not "fix" this by adding the import.
export interface StoredSubject {
    kind: SubjectKind;
    id: string;
}

// null means "not loaded yet"; [] means "loaded, and there are none"
export interface SubjectListState {
    channels: string[] | null;
    dossiers: string[] | null;
    conversations: string[] | null;
}

export type RestoreAction = { action: "wait" } | { action: "select"; subject: StoredSubject } | { action: "clear" };

function listFor(kind: SubjectKind, lists: SubjectListState): string[] | null {
    if (kind === "channel") {
        return lists.channels;
    }
    return kind === "dossier" ? lists.dossiers : lists.conversations;
}

export function restoreDecision(stored: StoredSubject | null, lists: SubjectListState): RestoreAction {
    // briefing is never a stored subject; treat it as absent rather than waiting on a list that
    // will never load.
    if (stored == null || stored.kind === "briefing") {
        return { action: "clear" };
    }
    const list = listFor(stored.kind, lists);
    if (list == null) {
        return { action: "wait" };
    }
    return list.includes(stored.id) ? { action: "select", subject: stored } : { action: "clear" };
}
