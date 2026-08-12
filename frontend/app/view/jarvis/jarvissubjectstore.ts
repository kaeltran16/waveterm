// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Which subject the Stage is showing. Module-scope so it survives the surface unmount on nav switch, and
// so the per-kind stores below it stay the single source of truth for their own detail.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import * as WOS from "@/app/store/wos";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { activeChannelAtom, activeChannelRunsAtom, selectChannel } from "@/app/view/agents/channelsstore";
import { resolveActiveRunId, isTerminal } from "@/app/view/agents/runmodel";
import { fireAndForget } from "@/util/util";
import { atom, type Atom, type PrimitiveAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import type { JarvisScope, SourceType } from "./jarviscontract";
import {
    getConversation,
    profileRailOpenAtom,
    pruneEmptyConversation,
    selectConversation,
    startConversation,
    submitJarvisQuery,
} from "./jarvisstore";
import type { SubjectKind } from "./subjects";

export interface ActiveSubject {
    kind: SubjectKind;
    id: string;
}

export const activeSubjectAtom = atom<ActiveSubject | null>(null) as PrimitiveAtom<ActiveSubject | null>;

// the last subject, persisted across launches. Only the id pair is stored — the subject itself is
// re-resolved on boot, because a stored id can name something that has since been deleted.
//
// getOnInit is load-bearing, not a tuning flag: without it the stored value arrives one render AFTER the
// first read, so the boot restore would see null, read that as "nothing was stored", and latch its
// one-attempt guard before the real value ever landed. null has to mean empty, not "not yet".
export const persistedSubjectAtom = atomWithStorage<ActiveSubject | null>("jarvis.subject.last", null, undefined, {
    getOnInit: true,
});

// the Subjects column's filter text. A module atom, not useState: the column unmounts with the surface.
export const subjectFilterAtom = atom<string>("");

// A record's attributed runs, keyed by dossier id. Resolved once per selection through the same
// ResolveSpaceScope read a Space uses, and consumed by both the record's thread and the rail's
// fleet-on-record roster — a dossier has no run list of its own.
export const recordScopeAtom = atom<Record<string, SpaceScope>>({}) as PrimitiveAtom<Record<string, SpaceScope>>;

// the Run snapshots behind those orefs, so a record's activity can name what actually ran. A snapshot,
// not a live subscription: a record's attributed runs are history by the time they are attributed.
export const recordRunsAtom = atom<Record<string, Run[]>>({}) as PrimitiveAtom<Record<string, Run[]>>;

// Leaving a thread nobody asked anything in discards it, along with the draft and source mapping that
// pointed at it. Re-selecting the same subject is not leaving it — asking about one source twice in a row
// lands back on the thread already showing, and pruning there would delete what the click is opening.
function pruneOnLeave(next: ActiveSubject): void {
    const prev = globalStore.get(activeSubjectAtom);
    if (prev == null || prev.kind !== "conversation" || (prev.kind === next.kind && prev.id === next.id)) {
        return;
    }
    if (!pruneEmptyConversation(prev.id)) {
        return;
    }
    const drafts = { ...globalStore.get(jarvisDraftAtom) };
    delete drafts[prev.id];
    globalStore.set(jarvisDraftAtom, drafts);
    const sources = globalStore.get(sourceConversationAtom);
    const stale = Object.entries(sources).filter(([, id]) => id === prev.id);
    if (stale.length > 0) {
        const kept = { ...sources };
        for (const [oref] of stale) {
            delete kept[oref];
        }
        globalStore.set(sourceConversationAtom, kept);
    }
}

export function selectSubject(subject: ActiveSubject): void {
    pruneOnLeave(subject);
    // leaving a channel drops a run selection that has gone cold, so coming back to it lands on live
    // work or the fresh-run state — never the finished run that was selected last time. A live run's
    // selection survives (it is the default anyway), and re-selecting the channel you are on is not
    // leaving, so a re-click keeps the run it is showing.
    const prev = globalStore.get(activeSubjectAtom);
    if (prev != null && prev.kind === "channel" && (subject.kind !== "channel" || subject.id !== prev.id)) {
        const cur = globalStore.get(activeRunIdAtom)[prev.id];
        if (cur != null) {
            const run = globalStore.get(activeChannelRunsAtom).find((r) => r.id === cur);
            if (run != null && isTerminal(run.status)) {
                setActiveRunId(prev.id, undefined);
            }
        }
    }
    globalStore.set(activeSubjectAtom, subject);
    globalStore.set(persistedSubjectAtom, subject);
    if (subject.kind === "channel") {
        fireAndForget(() => selectChannel(subject.id));
        return;
    }
    // the ⚙ drawer is channel-only and the Stage header drops its trigger off-channel, so leaving it open
    // strands it: no control closes it, and its forceCollapsed keeps "Needs you" hidden the whole time.
    globalStore.set(profileRailOpenAtom, false);
    if (subject.kind === "dossier") {
        loadRecordDetail(subject.id);
        loadRecordScope(subject.id);
        return;
    }
    selectConversation(subject.id);
}

// "an empty thread, on the Stage, now" — the Subjects column's + Thread button and the keyboard's `n` are
// the same action, so they share one definition rather than each spelling out the empty scope.
export function startJarvisThread(): string {
    const id = startConversation({ mode: "all", chips: [], attached: [] });
    selectSubject({ kind: "conversation", id });
    return id;
}

export function loadRecordScope(dossierId: string): void {
    if (globalStore.get(recordScopeAtom)[dossierId] != null) {
        return;
    }
    fireAndForget(() => reloadRecordScope(dossierId));
}

export async function reloadRecordScope(dossierId: string): Promise<void> {
    const scope = await RpcApi.ResolveSpaceScopeCommand(TabRpcClient, { dossierid: dossierId });
    if (scope == null) {
        return;
    }
    globalStore.set(recordScopeAtom, { ...globalStore.get(recordScopeAtom), [dossierId]: scope });
    const runs: Run[] = [];
    for (const oref of scope.runorefs ?? []) {
        const run = await WOS.loadAndPinWaveObject<Run>(oref).catch(() => null);
        if (run != null) {
            runs.push(run);
        }
    }
    globalStore.set(recordRunsAtom, { ...globalStore.get(recordRunsAtom), [dossierId]: runs });
}

// keyed by subject id, not a single value: switching subjects must return each one to the state it was in
// (spec: "the last subject you were on, exactly as you left it").
export const recordBandOpenAtom = atom<Record<string, boolean>>({}) as PrimitiveAtom<Record<string, boolean>>;
export const activeRunIdAtom = atom<Record<string, string | undefined>>({}) as PrimitiveAtom<
    Record<string, string | undefined>
>;

// The run the Stage is showing, resolved once. Both the Stage and the context rail need it — the Stage to
// render the run body, the rail to derive its ambient section — and this used to be resolved inline in
// stage.tsx twice with different guards, so the two could name different runs mid-channel-switch.
export const stageRunAtom: Atom<Run | null> = atom((get) => {
    const subject = get(activeSubjectAtom);
    if (subject == null || subject.kind !== "channel") {
        return null;
    }
    const channel = get(activeChannelAtom);
    // the runs list belongs to the *active* channel, so a subject that has not caught up to it yet would
    // otherwise resolve a run out of the previous channel's list
    if (channel == null || subject.id !== channel.oid) {
        return null;
    }
    // a draft run is not a Run yet (the server requires a goal), so nothing should auto-resolve underneath it
    if (get(composingRunAtom)[subject.id] ?? false) {
        return null;
    }
    const runs = get(activeChannelRunsAtom);
    const id = resolveActiveRunId(runs, get(activeRunIdAtom)[subject.id]);
    return runs.find((r) => r.id === id) ?? null;
});

// A record's detail, keyed by dossier id — the ONLY cache of it. Both readers use this: the record
// subject (the record the user selected) and a channel's record band (the record its run is attributed
// to, usually a different one). It was two atoms, and only one of them was invalidated on write, so
// setting a record's status from the band appeared to do nothing.
export const recordDetailAtom = atom<Record<string, DossierDetail>>({}) as PrimitiveAtom<
    Record<string, DossierDetail>
>;

export function toggleRecordBand(subjectId: string): void {
    const prev = globalStore.get(recordBandOpenAtom);
    globalStore.set(recordBandOpenAtom, { ...prev, [subjectId]: !prev[subjectId] });
}

// Which Subjects groups the user has collapsed, keyed by group key. Holds only *explicit* choices — an
// absent key falls back to subjects.ts's default, so "Records starts shut" needs no seeding here and a new
// project group is open the first time it appears. A module atom for the same reason as subjectFilterAtom:
// the column unmounts with the surface on every nav switch. Deliberately not persisted across launches —
// the default is already the useful state, and one more storage key would need its own getOnInit dance.
export const collapsedSubjectGroupsAtom = atom<Record<string, boolean>>({}) as PrimitiveAtom<Record<string, boolean>>;

export function toggleSubjectGroup(groupKey: string, collapsed: boolean): void {
    const prev = globalStore.get(collapsedSubjectGroupsAtom);
    globalStore.set(collapsedSubjectGroupsAtom, { ...prev, [groupKey]: collapsed });
}

export function setActiveRunId(channelId: string, runId: string | undefined): void {
    const prev = globalStore.get(activeRunIdAtom);
    globalStore.set(activeRunIdAtom, { ...prev, [channelId]: runId });
}

// The composer's draft, keyed by subject id like the atoms above — one box serves every face, so one
// keyed store does too (a channel subject's id *is* its channel oid). A single string carried a
// half-typed question onto the next subject, where one Enter would have dispatched it against that
// subject instead of the one it was written for.
export const jarvisDraftAtom = atom<Record<string, string>>({}) as PrimitiveAtom<Record<string, string>>;

export function setJarvisDraft(subjectId: string, text: string): void {
    const prev = globalStore.get(jarvisDraftAtom);
    globalStore.set(jarvisDraftAtom, { ...prev, [subjectId]: text });
}

// "this subject is asking which channel to dispatch into". Keyed for the same reason and by the same key:
// the prompt only means anything beside the draft that raised it, so the two travel together.
export const channelPickingAtom = atom<Record<string, boolean>>({}) as PrimitiveAtom<Record<string, boolean>>;

export function setChannelPicking(subjectId: string, picking: boolean): void {
    const prev = globalStore.get(channelPickingAtom);
    globalStore.set(channelPickingAtom, { ...prev, [subjectId]: picking });
}

// "the user is composing a new run in this channel", keyed by channel id. Sticky, because clearing the
// active run id cannot express it: resolveActiveRunId reads undefined as "pick one for me" and lands back
// on the most-recent non-terminal run — the very run the Talk face was steering. So while any run in a
// channel was live, the channel's own composer could not start another one.
export const composingRunAtom = atom<Record<string, boolean>>({}) as PrimitiveAtom<Record<string, boolean>>;

export function setComposingRun(channelId: string, composing: boolean): void {
    const prev = globalStore.get(composingRunAtom);
    globalStore.set(composingRunAtom, { ...prev, [channelId]: composing });
}

// One thread per source object, keyed by that object's oref. Asking about a record or a Run has to land
// somewhere and neither has a turn list of its own; the attachment is also what makes the thread
// discoverable later, since a conversation's only link back to an object is what it cited. Asking twice
// about the same object continues the same thread rather than minting a second one — a new thread per
// click is what filled the Threads group with duplicate rows (four questions, twelve rows).
export const sourceConversationAtom = atom<Record<string, string>>({}) as PrimitiveAtom<Record<string, string>>;

export function conversationForSource(oref: string, scope: JarvisScope): string {
    const existing = globalStore.get(sourceConversationAtom)[oref];
    // a mapping can outlive its thread (an unasked one is pruned on the way out). Submitting into an id
    // nothing holds any more is a silent no-op, so a dead mapping mints a fresh thread.
    if (existing != null && getConversation(existing) != null) {
        return existing;
    }
    const id = startConversation(scope);
    globalStore.set(sourceConversationAtom, { ...globalStore.get(sourceConversationAtom), [oref]: id });
    return id;
}

// A chip is a short badge, so it names the KIND of source and lets the attachment carry the full title.
// Same convention as contextualentry.tsx's CHIP_LABEL, which is the newer of the two patterns here.
const SOURCE_CHIP_LABEL: Partial<Record<SourceType, string>> = {
    task: "This record",
    decision: "This decision",
    memory: "This memory",
    run: "This Run",
};

const SOURCE_TYPES: readonly string[] = [
    "memory",
    "decision",
    "run",
    "channel",
    "radar",
    "commit",
    "agent",
    "session",
    "task",
];

// The vault names a record's type "dossier" (pkg/jarvisdossier), which is what the volunteer payload
// carries; this union calls the same thing "task", which is also its oref prefix. Narrowed here rather
// than widening SourceType, so the wire keeps the backend's vocabulary and the view keeps one. Null for
// a type this union does not know, so the caller labels it generically instead of asserting a kind.
function asSourceType(raw: string): SourceType | null {
    const alias = raw === "dossier" ? "task" : raw;
    return SOURCE_TYPES.includes(alias) ? (alias as SourceType) : null;
}

// Ask Jarvis about any grounding source. conversationForSource keys one thread per source oref, so
// asking twice about the same utterance continues one thread rather than minting duplicates — the
// property the jarvis-contextual CDP scenario guards.
export function askAboutSource(oref: string, sourceType: string, title: string, text: string): void {
    const narrowed = asSourceType(sourceType);
    const convId = conversationForSource(oref, {
        mode: "object",
        chips: [{ label: (narrowed != null ? SOURCE_CHIP_LABEL[narrowed] : null) ?? "This source", active: true }],
        // the field is required, so an unknown type still needs a value; it drives the chip and the
        // grounding icon only — navigation reads the oref — so the cost is a generic badge, never a
        // wrong destination
        attached: [{ oref, sourceType: narrowed ?? "task", title }],
    });
    submitJarvisQuery(convId, text);
}

// kept so existing callers do not change: a record is one source type among several
export function askAboutRecord(dossierId: string, objective: string, text: string): void {
    askAboutSource("task:" + dossierId, "task", objective, text);
}

// The cache-guarded read: a band that opens the same record twice must not refetch it. Every mutation
// goes through recordactions.afterRecordWrite, which drops the key first, so a guarded read is correct
// rather than merely cheap.
export function loadRecordDetail(dossierId: string): void {
    if (globalStore.get(recordDetailAtom)[dossierId] != null) {
        return;
    }
    fireAndForget(() => reloadRecordDetail(dossierId));
}

// The unguarded read. Returns a promise so a write can await the refreshed detail before the UI settles.
export async function reloadRecordDetail(dossierId: string): Promise<void> {
    const detail = await RpcApi.GetDossierCommand(TabRpcClient, { dossierid: dossierId });
    if (detail == null) {
        return;
    }
    globalStore.set(recordDetailAtom, { ...globalStore.get(recordDetailAtom), [dossierId]: detail });
}
