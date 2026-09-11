// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Which object the graph peek opens on. The peek's contract is that you enter it *from* an object, so
// arriving on the whole vault with nothing selected breaks it: 432 nodes and no way in but hunting. Pure —
// the resolution rule is a table over the subject kind, not an effect.

import type { AmbientTag } from "@/app/view/agents/ambient";
import { recordBandCase } from "./recordband";
import type { SubjectKind } from "./subjects";

// A run node exists in the graph only inside its record's attribution bloom (VaultGraph emits no runs), so
// focusing a run means naming the record to bloom *and* the run to select once that bloom lands.
export interface PeekFocus {
    dossierId: string | null;
    runORef: string | null;
}

export interface PeekFocusInput {
    subject: { kind: SubjectKind; id: string } | null;
    // the run the Stage is showing, as an oref — a run node's graph id is its oref.
    runORef: string | null;
    // a thread's attached sources, in the order it attached them.
    attachedORefs: string[];
    // records the thread's answers cited.
    mentionedDossierIds: string[];
    // attribution: which records a run oref is attributed to (ambient.tagsFor).
    tagsFor: (oref: string) => AmbientTag[];
}

const NOTHING: PeekFocus = { dossierId: null, runORef: null };

// the record the band would call primary for this run. Deliberately the band's own ranking rather than a
// second one: the peek and the band describe the same run, and two rankings would eventually disagree.
function primaryRecord(tags: AmbientTag[]): string | null {
    const band = recordBandCase({ kind: "channel", tags });
    if (band.case === "one") {
        return band.edge.taskId;
    }
    if (band.case === "several") {
        return band.primary.taskId;
    }
    return null;
}

function focusRun(runORef: string, input: PeekFocusInput): PeekFocus {
    const dossierId = primaryRecord(input.tagsFor(runORef));
    // an unattributed run has no node anywhere in the graph — there is nothing to select, and blooming
    // nothing would leave the overlay claiming a focus it does not have.
    return dossierId == null ? NOTHING : { dossierId, runORef };
}

export function peekFocus(input: PeekFocusInput): PeekFocus {
    const subject = input.subject;
    if (subject == null) {
        return NOTHING;
    }
    if (subject.kind === "dossier") {
        return { dossierId: subject.id, runORef: null };
    }
    if (subject.kind === "channel") {
        return input.runORef == null ? NOTHING : focusRun(input.runORef, input);
    }
    for (const oref of input.attachedORefs ?? []) {
        const [kind, id] = [oref.slice(0, oref.indexOf(":")), oref.slice(oref.indexOf(":") + 1)];
        if (kind === "run" && id !== "") {
            return focusRun(oref, input);
        }
        if (kind === "task" && id !== "") {
            return { dossierId: id, runORef: null };
        }
        // radar findings and memory notes have no id the peek can name: radar is not a vault collection,
        // and a note's graph id is its vault path rather than its oref. Guessing would select a wrong node.
    }
    const cited = (input.mentionedDossierIds ?? [])[0];
    return cited != null ? { dossierId: cited, runORef: null } : NOTHING;
}
