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
    // status + updated ride along so the record row can draw its status chip and age without a second
    // lookup: they are already on the SpaceSummary the list arrives as, and were being discarded here.
    | { kind: "dossier"; id: string; label: string; status: string; updated: number }
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

// The "nothing selected yet" landing: the first channel the Subjects column actually shows. Must apply the
// same scoping and archiving as buildSubjectGroups or the Stage can land on a channel the column hides.
// Null when nothing is visible, so the caller can keep the empty Stage's guidance instead.
export function firstVisibleChannel(
    channels: Channel[] | null,
    scope: SpaceScope | null,
    revealed: boolean
): Channel | null {
    const scoped = filterChannelsBySpace(channels, scope, revealed);
    if (scoped == null || scoped.length === 0) {
        return null;
    }
    return partitionChannels(scoped).active[0] ?? null;
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

export type RecordBucket = "active" | "paused" | "done";

// The four dossier statuses (jarvisdossier.SetStatus) collapse to three tones for a row: in a list, the
// distinction between `completed` and `archived` is not what you are scanning for — "not now" is. An
// unrecognised status buckets as done rather than as live work, so a future status cannot quietly promote
// itself to the loudest tone in the column.
export function recordStatusBucket(status: string): RecordBucket {
    return status === "active" || status === "paused" ? status : "done";
}

// Groups that accumulate history rather than hold work in progress open shut. Both grow without bound, and
// neither is what the column is for — you come here to pick a channel or a thread.
const DEFAULT_COLLAPSED = new Set(["dossiers", "archived"]);

export interface VisibleGroup {
    key: string;
    label: string;
    count: number; // the group's true size, shown in the header even while collapsed
    collapsed: boolean;
    items: Subject[]; // empty when collapsed
}

// The one derivation of what the column draws, so the rows, the header counts and the j/k nav order cannot
// disagree. A collapsed group keeps its label and count but contributes no items — which is what makes the
// nav list correct *by construction*: the cursor walks the flattened items, so a hidden row simply is not in
// it. Deriving nav from the unfiltered groups instead would move the cursor into a collapsed group and let
// the debounced commit select a row the user cannot see.
//
// `filtering` (a non-empty filter box) forces every group open: a query matching a record inside a collapsed
// group would otherwise return visibly nothing and read as a broken search.
export function visibleSubjectGroups(
    groups: SubjectGroup[],
    collapsed: Record<string, boolean>,
    filtering: boolean
): VisibleGroup[] {
    return groups.map((g) => {
        const shut = !filtering && (collapsed[g.key] ?? DEFAULT_COLLAPSED.has(g.key));
        return { key: g.key, label: g.label, count: g.items.length, collapsed: shut, items: shut ? [] : g.items };
    });
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

    // archived threads join the channels' trailing group rather than getting one of their own: two
    // "Archived" headers for two kinds would read as two different states.
    const liveConversations = conversations.filter((v) => v.archived !== true);
    const archivedConversations = conversations.filter((v) => v.archived === true);
    if (liveConversations.length > 0) {
        groups.push({
            key: "threads",
            label: "Threads",
            items: liveConversations.map((v) => ({ kind: "conversation", id: v.id, label: v.title })),
        });
    }
    // Records go *after* threads, and this order is the point rather than a preference. Channels and
    // threads are both created deliberately, so their counts are small and stable; records are written by
    // the machine on every run, so this is the one group that grows without bound. With it in the middle
    // (where the Tasks→Jarvis merge left it) 17 records pushed Threads ~600px down and off a 720px window
    // entirely. Last, it can still grow forever and displace nothing.
    if (dossiers.length > 0) {
        groups.push({
            key: "dossiers",
            label: "Records",
            items: dossiers.map((d) => ({
                kind: "dossier",
                id: d.id,
                label: d.objective,
                status: d.status,
                updated: d.updated,
            })),
        });
    }
    const archivedItems: Subject[] = [
        ...archived.map((c) => ({
            kind: "channel" as const,
            id: c.oid,
            label: c.name ?? c.oid,
            projectName: input.projectNameFor(c),
        })),
        ...archivedConversations.map((v) => ({ kind: "conversation" as const, id: v.id, label: v.title })),
    ];
    if (archivedItems.length > 0) {
        groups.push({
            key: "archived",
            // no count in the label: every group header draws one as a badge, and two copies of "2" read as
            // two different numbers.
            label: "Archived",
            items: archivedItems,
        });
    }
    return groups;
}
