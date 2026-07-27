// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// S3 proactive resurfacing (read side). The suggestion is written to run.Meta by
// the backend at dispatch (pkg/jarvisproactive) and delivered via the run's
// waveobj:update. This module derives the card view-model and owns dismissal:
// an optimistic module atom hides it immediately; ObjectService.UpdateObjectMeta
// persists the flag so it stays gone across reload. Keys mirror the Go constants
// in pkg/jarvisproactive/suggestion.go — keep identical.

import { globalStore } from "@/app/store/jotaiStore";
import { ObjectService } from "@/app/store/services";
import * as WOS from "@/app/store/wos";
import { fireAndForget } from "@/util/util";
import { atom } from "jotai";

export const PROACTIVE_META_KEY = "jarvis:proactive";
export const PROACTIVE_DISMISSED_KEY = "jarvis:proactive:dismissed";

export interface ProactiveVM {
    nodeId: string;
    sourceType: string;
    title: string;
    snippet: string;
    why: string;
}

// dismissedProactiveAtom holds run oids dismissed this session, for an immediate
// optimistic hide independent of the persisted-meta round-trip.
export const dismissedProactiveAtom = atom<Set<string>>(new Set<string>());

export function readProactiveSuggestion(run: Run): ProactiveVM | null {
    const meta = run?.meta as Record<string, unknown> | undefined;
    if (!meta || meta[PROACTIVE_DISMISSED_KEY] === true) {
        return null;
    }
    const raw = meta[PROACTIVE_META_KEY] as (Partial<ProactiveVM> & { status?: string }) | undefined;
    if (!raw || raw.status !== "hit") {
        return null;
    }
    return {
        nodeId: raw.nodeId ?? "",
        sourceType: raw.sourceType ?? "memory",
        title: raw.title ?? "",
        snippet: raw.snippet ?? "",
        why: raw.why ?? "",
    };
}

export function dismissProactive(run: Run): void {
    const oid = run?.oid;
    if (!oid) {
        return;
    }
    const next = new Set(globalStore.get(dismissedProactiveAtom));
    next.add(oid);
    globalStore.set(dismissedProactiveAtom, next);
    // the dismissal flag is a generic run.Meta key, deliberately outside the generated MetaType
    // contract (S3 adds no codegen), so the patch is cast at this single write site.
    const patch = { [PROACTIVE_DISMISSED_KEY]: true } as unknown as MetaType;
    fireAndForget(() => ObjectService.UpdateObjectMeta(WOS.makeORef("run", oid), patch));
}
