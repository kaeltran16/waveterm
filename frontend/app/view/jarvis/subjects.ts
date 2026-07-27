// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Subjects column's model: channels, dossiers and conversations are three kinds of one list. Pure —
// no jotai, no React — so the grouping and Space-scoping rules unit-test without a store.

import type { JarvisConversation } from "./jarviscontract";
import { mentionedDossierIds } from "./mentions";

export type SubjectKind = "channel" | "dossier" | "conversation";

export type Subject =
    | { kind: "channel"; id: string; label: string; projectName: string }
    | { kind: "dossier"; id: string; label: string; status: string }
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

const MARKS: Record<SubjectKind, "#" | "▤" | "~"> = {
    channel: "#",
    dossier: "▤",
    conversation: "~",
};

export function subjectMark(kind: SubjectKind): "#" | "▤" | "~" {
    return MARKS[kind];
}

export function buildSubjectGroups(input: SubjectInput): SubjectGroup[] {
    // a revealed surface or a null scope means Global: every kind passes through untouched.
    const scoped = input.spaceScope != null && !input.revealed;
    const channelOids = scoped ? new Set(input.spaceScope!.channeloids ?? []) : null;

    const channels = (input.channels ?? []).filter((c) => channelOids == null || channelOids.has(c.oid));
    // a Space *is* a dossier, so scoping the record list means showing that one record.
    const dossiers =
        scoped && input.spaceDossierId != null
            ? input.dossiers.filter((d) => d.id === input.spaceDossierId)
            : input.dossiers;
    // a conversation has no attribution edge; "on this task" can only mean it cited the task.
    const conversations =
        scoped && input.spaceDossierId != null
            ? input.conversations.filter((v) => mentionedDossierIds(v).includes(input.spaceDossierId!))
            : input.conversations;

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
            items: dossiers.map((d) => ({ kind: "dossier", id: d.id, label: d.objective, status: d.status })),
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
