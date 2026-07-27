// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Which subject the Stage is showing. Module-scope so it survives the surface unmount on nav switch, and
// so the per-kind stores below it stay the single source of truth for their own detail.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import * as WOS from "@/app/store/wos";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { selectChannel } from "@/app/view/agents/channelsstore";
import { fireAndForget } from "@/util/util";
import { atom, type PrimitiveAtom } from "jotai";
import { selectConversation } from "./jarvisstore";
import type { SubjectKind } from "./subjects";
import { selectDossier } from "./tasksstore";

export interface ActiveSubject {
    kind: SubjectKind;
    id: string;
}

export const activeSubjectAtom = atom<ActiveSubject | null>(null) as PrimitiveAtom<ActiveSubject | null>;

// the Subjects column's filter text. A module atom, not useState: the column unmounts with the surface.
export const subjectFilterAtom = atom<string>("");

// A record's attributed runs, keyed by dossier id. Resolved once per selection through the same
// ResolveSpaceScope read a Space uses, and consumed by both the record's thread and the rail's
// fleet-on-record roster — a dossier has no run list of its own.
export const recordScopeAtom = atom<Record<string, SpaceScope>>({}) as PrimitiveAtom<Record<string, SpaceScope>>;

// the Run snapshots behind those orefs, so a record's activity can name what actually ran. A snapshot,
// not a live subscription: a record's attributed runs are history by the time they are attributed.
export const recordRunsAtom = atom<Record<string, Run[]>>({}) as PrimitiveAtom<Record<string, Run[]>>;

export function selectSubject(subject: ActiveSubject): void {
    globalStore.set(activeSubjectAtom, subject);
    if (subject.kind === "channel") {
        fireAndForget(() => selectChannel(subject.id));
        return;
    }
    if (subject.kind === "dossier") {
        selectDossier(subject.id);
        loadRecordScope(subject.id);
        return;
    }
    selectConversation(subject.id);
}

export function loadRecordScope(dossierId: string): void {
    if (globalStore.get(recordScopeAtom)[dossierId] != null) {
        return;
    }
    fireAndForget(async () => {
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
    });
}

// keyed by subject id, not a single value: switching subjects must return each one to the state it was in
// (spec: "the last subject you were on, exactly as you left it").
export const recordBandOpenAtom = atom<Record<string, boolean>>({}) as PrimitiveAtom<Record<string, boolean>>;
export const activeRunIdAtom = atom<Record<string, string | undefined>>({}) as PrimitiveAtom<
    Record<string, string | undefined>
>;

// The record an *attributed* band expands to, keyed by dossier id. Distinct from tasksstore's
// dossierDetailAtom, which holds the record the user selected as a subject: a channel's band opens the
// record its run is attributed to, which is usually not that one.
export const recordDetailAtom = atom<Record<string, DossierDetail>>({}) as PrimitiveAtom<
    Record<string, DossierDetail>
>;

export function toggleRecordBand(subjectId: string): void {
    const prev = globalStore.get(recordBandOpenAtom);
    globalStore.set(recordBandOpenAtom, { ...prev, [subjectId]: !prev[subjectId] });
}

export function setActiveRunId(channelId: string, runId: string | undefined): void {
    const prev = globalStore.get(activeRunIdAtom);
    globalStore.set(activeRunIdAtom, { ...prev, [channelId]: runId });
}

export function loadRecordDetail(dossierId: string): void {
    if (globalStore.get(recordDetailAtom)[dossierId] != null) {
        return;
    }
    fireAndForget(async () => {
        const detail = await RpcApi.GetDossierCommand(TabRpcClient, { dossierid: dossierId });
        if (detail == null) {
            return;
        }
        globalStore.set(recordDetailAtom, { ...globalStore.get(recordDetailAtom), [dossierId]: detail });
    });
}
