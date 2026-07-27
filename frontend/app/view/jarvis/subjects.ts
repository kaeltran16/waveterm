// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Subjects column's model: channels, dossiers and conversations are three kinds of one list. Pure —
// no jotai, no React — so the grouping and Space-scoping rules unit-test without a store.

import { filterChannelsBySpace } from "@/app/view/agents/spacescope";
import type { JarvisConversation } from "./jarviscontract";
import { mentionedDossierIds } from "./mentions";

export type SubjectKind = "channel" | "dossier" | "conversation";
export type SubjectMark = "#" | "▤" | "~";

export type Subject =
    | { kind: "channel"; id: string; label: string; projectName: string }
    | { kind: "dossier"; id: string; label: string }
    | { kind: "conversation"; id: string; label: string };

export interface SubjectGroup {
    key: string;
    label: string;
    items: Subject[];
}

export interface SubjectInput {
    channels: Channel[] | null;
    dossiers: SpaceSummary[];
    conversations: JarvisConversation[];
    projectNameFor: (channel: Channel) => string;
    spaceScope: SpaceScope | null;
    spaceDossierId: string | null;
    revealed: boolean;
}

const MARKS: Record<SubjectKind, SubjectMark> = {
    channel: "#",
    dossier: "▤",
    conversation: "~",
};

export function subjectMark(kind: SubjectKind): SubjectMark {
    return MARKS[kind];
}

// Records and threads hang off the Space's own dossier. A scope with no dossier id is incoherent — the
// scope is derived from a dossier — so it scopes to nothing rather than leaving the global lists on show
// beside an already-filtered channel list.
function scopeToRecord(input: SubjectInput) {
    // same guard as filterChannelsBySpace: a null scope (Global) or a revealed surface passes everything.
    if (input.spaceScope == null || input.revealed) {
        return { dossiers: input.dossiers, conversations: input.conversations };
    }
    const id = input.spaceDossierId;
    if (id == null) {
        return { dossiers: [], conversations: [] };
    }
    return {
        // a Space *is* a dossier, so scoping the record list means showing that one record.
        dossiers: input.dossiers.filter((d) => d.id === id),
        // a conversation has no attribution edge; "on this record" can only mean it cited the record.
        conversations: input.conversations.filter((v) => mentionedDossierIds(v).includes(id)),
    };
}

export function buildSubjectGroups(input: SubjectInput): SubjectGroup[] {
    // all three kinds scope together — scoping only some of them leaves a global list on show beside a
    // filtered one.
    const channels = filterChannelsBySpace(input.channels, input.spaceScope, input.revealed) ?? [];
    const { dossiers, conversations } = scopeToRecord(input);

    const groups: SubjectGroup[] = [];

    // channels group by project, in first-seen order, so the column matches the rail users know.
    const byProject = new Map<string, Subject[]>();
    for (const c of channels) {
        const project = input.projectNameFor(c);
        const item: Subject = { kind: "channel", id: c.oid, label: c.name ?? c.oid, projectName: project };
        const list = byProject.get(project);
        if (list) {
            list.push(item);
        } else {
            byProject.set(project, [item]);
        }
    }
    for (const [project, items] of byProject) {
        groups.push({ key: "project:" + project, label: project, items });
    }

    if (dossiers.length > 0) {
        groups.push({
            key: "dossiers",
            label: "Records · dossiers",
            items: dossiers.map((d) => ({ kind: "dossier", id: d.id, label: d.objective })),
        });
    }
    if (conversations.length > 0) {
        groups.push({
            key: "threads",
            label: "Threads",
            items: conversations.map((v) => ({ kind: "conversation", id: v.id, label: v.title })),
        });
    }
    return groups;
}
