// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Briefing load lifecycle: one RPC per entry, a validated persisted visit cursor, generation-guarded
// snapshot writes, the launch-local landing guard, and the stateless inline ask.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type Atom, type PrimitiveAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { BRIEFING_FIXTURES, type BriefingFixtureName } from "./briefingfixtures";
import { SEVEN_DAYS_MS } from "./briefingmodel";

export interface BriefingSnapshot {
    state: WorkState;
    queryStartedAt: number;
    actualCursor: number;
    complete: boolean;
    cursorSaved: boolean;
}

export interface BriefingLoadState {
    snapshot: BriefingSnapshot | null;
    loading: boolean;
    error: string | null;
}

// The visit cursor: browser-profile-wide and all-project (Briefing ignores Space scope by design).
// getOnInit is load-bearing — the boot landing reads the stored value in the same tick it decides.
export const briefingCursorAtom = atomWithStorage<number | null>("jarvis.briefing.lastseen", null, undefined, {
    getOnInit: true,
});

const fetchedBriefingStateAtom = atom<BriefingLoadState>({
    snapshot: null,
    loading: false,
    error: null,
}) as PrimitiveAtom<BriefingLoadState>;

// DEV/CDP fixture seam (mirrors jarvisstore's activeFixtureAtom): a selected fixture replaces the
// fetched load state. Compiled out of production builds.
const DEV_FIXTURES = import.meta.env.DEV;
export const briefingFixtureAtom = atom<BriefingFixtureName | null>(null) as PrimitiveAtom<BriefingFixtureName | null>;

export const briefingStateAtom: Atom<BriefingLoadState> = atom((get) => {
    if (DEV_FIXTURES) {
        const fixture = get(briefingFixtureAtom);
        if (fixture != null) {
            return BRIEFING_FIXTURES[fixture].load;
        }
    }
    return get(fetchedBriefingStateAtom);
});

// every load gets a generation; only the latest may write the snapshot or the cursor. Guards React
// remounts and rapid subject changes without a backend write or lock.
let loadGeneration = 0;

function validCursor(v: unknown, at: number): v is number {
    return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= at;
}

export async function loadBriefingAsync(): Promise<void> {
    const gen = ++loadGeneration;
    const queryStartedAt = Date.now();
    const sevenDaysAgo = queryStartedAt - SEVEN_DAYS_MS;
    const stored = globalStore.get(briefingCursorAtom);
    const actualCursor = validCursor(stored, queryStartedAt) ? stored : sevenDaysAgo;
    // min() serves both requirements in one request: the client filters Delta back to actualCursor,
    // while the response still carries the stable seven-day Shipped window when the cursor is newer.
    const fetchSince = Math.min(actualCursor, sevenDaysAgo);
    globalStore.set(fetchedBriefingStateAtom, {
        snapshot: globalStore.get(fetchedBriefingStateAtom).snapshot,
        loading: true,
        error: null,
    });
    try {
        const rtn = await RpcApi.JarvisStateCommand(TabRpcClient, { project: "", sincems: fetchSince });
        if (gen !== loadGeneration) {
            return; // superseded
        }
        const state = rtn.state;
        const complete = state.sources.runs === true && state.sources.dossiers === true;
        let cursorSaved = true;
        if (complete) {
            try {
                // re-read before the write: a slower second window must not regress a cursor another
                // window (or another Wave window) already advanced past its own query start. Only
                // positivity is re-checked — a peer's cursor may legitimately exceed this window's
                // queryStartedAt, so the read-time future rejection must not re-apply here.
                const cur = globalStore.get(briefingCursorAtom);
                const curValid = typeof cur === "number" && Number.isFinite(cur) && cur > 0;
                globalStore.set(briefingCursorAtom, Math.max(curValid ? cur : 0, queryStartedAt));
            } catch {
                // keep the accepted snapshot and say the marker was not saved; the safe consequence
                // is repetition on the next load, never a lost event.
                cursorSaved = false;
            }
        }
        globalStore.set(fetchedBriefingStateAtom, {
            snapshot: { state, queryStartedAt, actualCursor, complete, cursorSaved },
            loading: false,
            error: null,
        });
    } catch (e) {
        if (gen !== loadGeneration) {
            return;
        }
        // keep any previous snapshot visible; the view renders the failure banner from `error`.
        globalStore.set(fetchedBriefingStateAtom, {
            snapshot: globalStore.get(fetchedBriefingStateAtom).snapshot,
            loading: false,
            error: e instanceof Error ? e.message : String(e),
        });
    }
}

export function loadBriefing(): void {
    void loadBriefingAsync();
}

// Refresh uses the same load and cursor rules as reopening Briefing.
export function refreshBriefing(): void {
    loadBriefing();
}

// --- launch-local landing guard (once per Wave frontend load, survives surface unmounts) ----------
let landingConsumed = false;
export function briefingLandingConsumed(): boolean {
    return landingConsumed;
}
export function consumeBriefingLanding(): void {
    landingConsumed = true;
}

// --- inline all-work ask (stateless; launch-local; never a JarvisConversation) --------------------
export type BriefingAskState = "idle" | "pending" | "answered" | "error";
export const briefingAskStateAtom = atom<BriefingAskState>("idle") as PrimitiveAtom<BriefingAskState>;
export const briefingAnswerAtom = atom<{
    answer: string;
    sources: JarvisConvoSourceRef[];
    terminal: string;
} | null>(null) as PrimitiveAtom<{ answer: string; sources: JarvisConvoSourceRef[]; terminal: string } | null>;

let askGeneration = 0;
export async function askAcrossWorkAsync(prompt: string): Promise<void> {
    const gen = ++askGeneration;
    globalStore.set(briefingAskStateAtom, "pending");
    try {
        // cwd:"" is the shipped all-project scope; the raised timeout matches the CLI — the handler
        // runs a relevance judge and a TierMid synthesis synchronously.
        const rtn = await RpcApi.JarvisAskCommand(TabRpcClient, { prompt, cwd: "" }, { timeout: 180_000 });
        if (gen !== askGeneration) {
            return;
        }
        globalStore.set(briefingAnswerAtom, { answer: rtn.answer, sources: rtn.sources ?? [], terminal: rtn.terminal });
        globalStore.set(briefingAskStateAtom, "answered");
    } catch (e) {
        if (gen !== askGeneration) {
            return;
        }
        // keep the prior settled answer visible; the view renders the error note.
        globalStore.set(briefingAskStateAtom, "error");
    }
}

export function askAcrossWork(prompt: string): void {
    void askAcrossWorkAsync(prompt);
}
