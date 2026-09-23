// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Restoring the last subject on boot. The hard part is not persistence but validation: a stored id can name
// a channel or record that no longer exists, and the lists load asynchronously. So each kind's list
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
}

export type RestoreAction = { action: "wait" } | { action: "select"; subject: StoredSubject } | { action: "clear" };

export function restoreDecision(stored: StoredSubject | null, lists: SubjectListState): RestoreAction {
    // only channels and dossiers are restorable; anything else stored (a briefing, or a conversation from
    // before Ask was retired) is treated as absent rather than waiting on a list that never loads.
    if (stored == null || (stored.kind !== "channel" && stored.kind !== "dossier")) {
        return { action: "clear" };
    }
    const list = stored.kind === "channel" ? lists.channels : lists.dossiers;
    if (list == null) {
        return { action: "wait" };
    }
    return list.includes(stored.id) ? { action: "select", subject: stored } : { action: "clear" };
}
