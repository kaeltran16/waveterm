// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// E continuity resume card (read side). The narrative is written to run.Meta by
// the backend at a rest boundary (pkg/jarviscontinuity) and delivered via the
// run's waveobj:update, so rendering it costs no model call. This module derives
// the card view-model and owns dismissal, mirroring the S3 proactive card:
// an optimistic module atom hides it immediately; ObjectService.UpdateObjectMeta
// persists the flag so it stays gone across reload. Keys mirror the Go constants
// in pkg/jarviscontinuity/continuity.go — keep identical.

import { globalStore } from "@/app/store/jotaiStore";
import { ObjectService } from "@/app/store/services";
import * as WOS from "@/app/store/wos";
import { fireAndForget } from "@/util/util";
import { atom } from "jotai";

export const RESUME_META_KEY = "jarvis:resume";
export const RESUME_DISMISSED_KEY = "jarvis:resume:dismissed";

export interface ResumeVM {
    taskId: string;
    summary: string;
    status: string;
    updated: number;
}

// dismissedResumeAtom holds run oids dismissed this session, for an immediate
// optimistic hide independent of the persisted-meta round-trip.
export const dismissedResumeAtom = atom<Set<string>>(new Set<string>());

export function readResumeCard(run: Run): ResumeVM | null {
    const meta = run?.meta as Record<string, unknown> | undefined;
    if (!meta || meta[RESUME_DISMISSED_KEY] === true) {
        return null;
    }
    const raw = meta[RESUME_META_KEY] as Partial<ResumeVM> | undefined;
    const summary = raw?.summary?.trim() ?? "";
    if (!summary) {
        return null;
    }
    return {
        taskId: raw.taskId ?? "",
        summary,
        status: raw.status ?? "",
        updated: raw.updated ?? 0,
    };
}

export function dismissResume(run: Run): void {
    const oid = run?.oid;
    if (!oid) {
        return;
    }
    const next = new Set(globalStore.get(dismissedResumeAtom));
    next.add(oid);
    globalStore.set(dismissedResumeAtom, next);
    // the dismissal flag is a generic run.Meta key, deliberately outside the generated MetaType
    // contract (E adds no codegen), so the patch is cast at this single write site.
    const patch = { [RESUME_DISMISSED_KEY]: true } as unknown as MetaType;
    fireAndForget(() => ObjectService.UpdateObjectMeta(WOS.makeORef("run", oid), patch));
}
