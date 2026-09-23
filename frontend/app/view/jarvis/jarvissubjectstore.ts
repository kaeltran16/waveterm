// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Which subject the surface is showing — the sheet draws it. Module-scope so it survives the surface
// unmount on nav switch, and so the per-kind stores below it stay the single source of truth for their own
// detail.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import * as WOS from "@/app/store/wos";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { activeChannelAtom, activeChannelRunsAtom, selectChannel } from "@/app/view/agents/channelsstore";
import { resolveActiveRunId, isTerminal } from "@/app/view/agents/runmodel";
import { fireAndForget } from "@/util/util";
import { atom, type Atom, type PrimitiveAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { loadEffortDetail } from "./effortstore";
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

// A record's attributed runs, keyed by dossier id. Resolved once per selection through the same
// ResolveSpaceScope read a Space uses, and consumed by both the record's thread and the rail's
// fleet-on-record roster — a dossier has no run list of its own.
export const recordScopeAtom = atom<Record<string, SpaceScope>>({}) as PrimitiveAtom<Record<string, SpaceScope>>;

// the Run snapshots behind those orefs, so a record's activity can name what actually ran. A snapshot,
// not a live subscription: a record's attributed runs are history by the time they are attributed.
export const recordRunsAtom = atom<Record<string, Run[]>>({}) as PrimitiveAtom<Record<string, Run[]>>;

// Deselect everything: the sheet's Close, and the only way the persisted subject is ever forgotten. Both
// halves move together on purpose — leaving the stored one behind would reopen on the next launch the very
// subject the user just dismissed.
export function clearSubject(): void {
    globalStore.set(activeSubjectAtom, null);
    globalStore.set(persistedSubjectAtom, null);
}

export function selectSubject(subject: ActiveSubject): void {
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
    // Briefing is a synthetic subject: selecting it must not overwrite the last meaningful subject, which
    // is what the next launch restores. Effort subjects are navigations, not restore targets — nothing
    // persists a list of them to validate a stored id against.
    if (subject.kind !== "briefing" && subject.kind !== "effort") {
        globalStore.set(persistedSubjectAtom, subject);
    }
    if (subject.kind === "channel") {
        fireAndForget(() => selectChannel(subject.id));
        return;
    }
    if (subject.kind === "briefing") {
        return;
    }
    if (subject.kind === "effort") {
        // warm the detail cache so the Stage header can name the effort while the view mounts.
        fireAndForget(() => loadEffortDetail("effort:" + subject.id));
        return;
    }
    if (subject.kind === "dossier") {
        loadRecordDetail(subject.id);
        loadRecordScope(subject.id);
    }
}

export function loadRecordScope(dossierId: string): void {
    if (globalStore.get(recordScopeAtom)[dossierId] != null) {
        return;
    }
    fireAndForget(() => reloadRecordScope(dossierId));
}

export async function reloadRecordScope(dossierId: string): Promise<void> {
    const scope = await RpcApi.ResolveFocusScopeCommand(TabRpcClient, { kind: "task", id: dossierId });
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

// The last detail-read failure per dossier, kept BESIDE the cache rather than in place of it: a failed
// refresh must leave the last good record on screen and still say it is stale, because Vault Records can
// be showing a record whose re-read is failing. Keyed, so one broken record does not warn on every other.
export const recordDetailErrorAtom = atom<Record<string, string>>({}) as PrimitiveAtom<Record<string, string>>;

function setRecordDetailError(dossierId: string, error: string | null): void {
    const prev = globalStore.get(recordDetailErrorAtom);
    if (error != null) {
        globalStore.set(recordDetailErrorAtom, { ...prev, [dossierId]: error });
        return;
    }
    if (prev[dossierId] == null) {
        return;
    }
    const next = { ...prev };
    delete next[dossierId];
    globalStore.set(recordDetailErrorAtom, next);
}

export function toggleRecordBand(subjectId: string): void {
    const prev = globalStore.get(recordBandOpenAtom);
    globalStore.set(recordBandOpenAtom, { ...prev, [subjectId]: !prev[subjectId] });
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

// The cache-guarded read: a band that opens the same record twice must not refetch it. Every mutation
// goes through recordactions.afterRecordWrite, which drops the key first, so a guarded read is correct
// rather than merely cheap.
export function loadRecordDetail(dossierId: string): void {
    if (globalStore.get(recordDetailAtom)[dossierId] != null) {
        return;
    }
    fireAndForget(() => reloadRecordDetail(dossierId));
}

// The unguarded read. Returns a promise so a write can await the refreshed detail before the UI settles,
// and rethrows on failure so the write can report it. The cache is never dropped before the read lands.
export async function reloadRecordDetail(dossierId: string): Promise<void> {
    let detail: DossierDetail;
    try {
        detail = await RpcApi.GetDossierCommand(TabRpcClient, { dossierid: dossierId });
    } catch (e) {
        setRecordDetailError(dossierId, String(e));
        throw e;
    }
    setRecordDetailError(dossierId, null);
    if (detail == null) {
        return;
    }
    globalStore.set(recordDetailAtom, { ...globalStore.get(recordDetailAtom), [dossierId]: detail });
}
