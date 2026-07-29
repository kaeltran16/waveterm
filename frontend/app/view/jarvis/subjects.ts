// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Subjects column's model: channels, dossiers and conversations are three kinds of one list. Pure —
// no jotai, no React — so the grouping and Space-scoping rules unit-test without a store.

import { partitionChannels } from "@/app/view/agents/channelderive";
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

// A run is not a subject, and the only run list in the product is the selected channel's inline switcher —
// so finding a run by what it was about meant selecting every channel in turn and reading each expansion.
// The channel snapshot already carries its runs, so the filter can reach them without another fetch.
export function runGoalMatches(channel: Channel, query: string): Run[] {
    const q = query.trim().toLowerCase();
    if (q === "") {
        return [];
    }
    return (channel.runs ?? []).filter((r) => (r.goal ?? "").toLowerCase().includes(q));
}

export function filterSubjectGroups(
    groups: SubjectGroup[],
    query: string,
    channels: Channel[] | null
): SubjectGroup[] {
    const q = query.trim().toLowerCase();
    if (q === "") {
        return groups;
    }
    const matches = (s: Subject) => {
        if (s.label.toLowerCase().includes(q)) {
            return true;
        }
        const channel = s.kind === "channel" ? channels?.find((c) => c.oid === s.id) : undefined;
        return channel != null && runGoalMatches(channel, q).length > 0;
    };
    return groups.map((g) => ({ ...g, items: g.items.filter(matches) })).filter((g) => g.items.length > 0);
}

export function buildSubjectGroups(input: SubjectInput): SubjectGroup[] {
    // all three kinds scope together — scoping only some of them leaves a global list on show beside a
    // filtered one.
    const scoped = filterChannelsBySpace(input.channels, input.spaceScope, input.revealed) ?? [];
    // archiving has to remove a channel from where you look for it, or the menu item does nothing visible.
    // It lands in one trailing group rather than disappearing — archive stays reversible from the column.
    const { active: channels, archived } = partitionChannels(scoped);
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
    if (archived.length > 0) {
        groups.push({
            key: "archived",
            label: `Archived · ${archived.length}`,
            items: archived.map((c) => ({
                kind: "channel",
                id: c.oid,
                label: c.name ?? c.oid,
                projectName: input.projectNameFor(c),
            })),
        });
    }
    return groups;
}
