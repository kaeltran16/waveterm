// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// A conversation has no attribution edge of its own — its link to a record is whatever it cited. This
// derives that, and is the single source for both the "Mentioned here" band and Space-scoping of threads.

import type { JarvisConversation } from "./jarviscontract";
import { isAnswerTurn } from "./jarviscontract";

// A dossier citation's navTarget is either a bare dossier id or an oref ("task:<id>"). Only the oid half
// is the dossier id; a target with an empty oid is not a citation we can resolve.
function dossierIdFromTarget(navTarget: string): string | null {
    const target = navTarget ?? "";
    const id = target.includes(":") ? target.slice(target.indexOf(":") + 1) : target;
    return id === "" ? null : id;
}

export function mentionedDossierIds(conversation: JarvisConversation): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const turn of conversation.turns ?? []) {
        if (!isAnswerTurn(turn)) continue;
        for (const card of turn.grounding ?? []) {
            if (card.sourceType !== "task") continue;
            const id = dossierIdFromTarget(card.navTarget);
            if (id == null || seen.has(id)) continue;
            seen.add(id);
            out.push(id);
        }
    }
    return out;
}
