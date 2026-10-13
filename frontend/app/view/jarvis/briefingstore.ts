// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Briefing load lifecycle: one RPC per entry, a validated persisted visit cursor, generation-guarded
// snapshot writes, the launch-local landing guard, and the Brief composer's draft.

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

// A look at Behind you does not clear it at once: each acknowledged visit is held for an hour before it
// moves the cursor, so rows you only glanced at stay to be read properly.
export const SEEN_HOLD_MS = 60 * 60 * 1000;
export type SeenMark = { through: number; at: number };
export const briefingSeenMarksAtom = atomWithStorage<SeenMark[]>("jarvis.briefing.seenmarks", [], undefined, {
    getOnInit: true,
});
// the default storage is localStorage, which is synchronous, so its value is never the promise it is typed as
const readCursor = () => globalStore.get(briefingCursorAtom) as number | null;
const readMarks = () => globalStore.get(briefingSeenMarksAtom) as SeenMark[];

// Folds every mark older than the hold into the cursor; the cursor only ever moves forward.
export function settleSeen(
    cursor: number | null,
    marks: SeenMark[],
    now: number
): { cursor: number | null; marks: SeenMark[] } {
    const valid = (Array.isArray(marks) ? marks : []).filter(
        (m) => Number.isFinite(m?.through) && Number.isFinite(m?.at)
    );
    const due = valid.filter((m) => m.at <= now - SEEN_HOLD_MS);
    const kept = valid.filter((m) => m.at > now - SEEN_HOLD_MS);
    const settled = due.reduce<number | null>((c, m) => (c == null || m.through > c ? m.through : c), cursor);
    return { cursor: settled, marks: kept };
}

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

// FetchWorkState walks every ledger leg (channel runs, transcript scans, vault) and routinely takes
// well past the server's 5s default RPC budget (measured ~14s on a warm corpus) — the same EC-TIME
// trap the ask CLI raised its timeout for. Raised here so the briefing landing actually loads.
export const stateRpcTimeoutMs = 180_000;

// every load gets a generation; only the latest may write the snapshot. Guards React remounts and
// rapid subject changes without a backend write or lock.
let loadGeneration = 0;

function validCursor(v: unknown, at: number): v is number {
    return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= at;
}

export async function loadBriefingAsync(): Promise<void> {
    const gen = ++loadGeneration;
    const queryStartedAt = Date.now();
    const sevenDaysAgo = queryStartedAt - SEVEN_DAYS_MS;
    const prevCursor = readCursor();
    const prevMarks = readMarks();
    const settled = settleSeen(prevCursor, prevMarks, queryStartedAt);
    if (settled.cursor !== prevCursor || settled.marks.length !== prevMarks.length) {
        try {
            globalStore.set(briefingCursorAtom, settled.cursor);
            globalStore.set(briefingSeenMarksAtom, settled.marks);
        } catch {
            // an unsaved settle only repeats on the next load; this one still reads the settled cursor
        }
    }
    const stored = settled.cursor;
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
        const rtn = await RpcApi.JarvisStateCommand(
            TabRpcClient,
            { project: "", sincems: fetchSince },
            { timeout: stateRpcTimeoutMs }
        );
        if (gen !== loadGeneration) {
            return; // superseded
        }
        const state = rtn.state;
        const complete = state.sources.runs === true && state.sources.dossiers === true;
        globalStore.set(briefingAckAtom, "waiting");
        globalStore.set(fetchedBriefingStateAtom, {
            snapshot: { state, queryStartedAt, actualCursor, complete },
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

// --- visit acknowledgment (dwell-based; the safe consequence of skipping it is repetition) --------
export type BriefingAckState = "idle" | "waiting" | "saved" | "failed";
export const briefingAckAtom = atom<BriefingAckState>("idle") as PrimitiveAtom<BriefingAckState>;

// Records that the current snapshot was seen through its query start; the cursor reaches it once the
// mark is SEEN_HOLD_MS old. Called by the view after a dwell on Behind you, not at load completion — a
// glance-and-close must not mark the delta seen.
export function ackBriefingVisit(): void {
    const st = globalStore.get(fetchedBriefingStateAtom);
    if (st.snapshot == null || !st.snapshot.complete || st.loading) {
        return;
    }
    try {
        // re-read before the write: a peer window may already hold a later mark, and a mark that adds
        // nothing past it or the cursor is dropped rather than stacked
        const through = st.snapshot.queryStartedAt;
        const cur = readCursor();
        const marks = readMarks();
        const latest = Math.max(
            typeof cur === "number" && Number.isFinite(cur) ? cur : 0,
            ...marks.map((m) => m.through)
        );
        if (through > latest) {
            globalStore.set(briefingSeenMarksAtom, [...marks, { through, at: Date.now() }]);
        }
        globalStore.set(briefingAckAtom, "saved");
    } catch {
        // keep the accepted snapshot and say the marker was not saved; repetition beats a lost event.
        globalStore.set(briefingAckAtom, "failed");
    }
}

// "mark seen" (design L287, L1794): the visit cursor jumps to this snapshot's query start now instead of
// after the dwell and the hold, and the Brief re-reads so Behind you empties. Returns the undo.
export function markBriefingSeen(): () => void {
    const prev = readCursor();
    const prevMarks = readMarks();
    const st = globalStore.get(fetchedBriefingStateAtom);
    if (st.snapshot == null) {
        return () => {};
    }
    const through = st.snapshot.queryStartedAt;
    globalStore.set(briefingCursorAtom, through);
    globalStore.set(
        briefingSeenMarksAtom,
        prevMarks.filter((m) => m.through > through)
    );
    loadBriefing();
    return () => {
        globalStore.set(briefingCursorAtom, prev);
        globalStore.set(briefingSeenMarksAtom, prevMarks);
        loadBriefing();
    };
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

// the Brief composer's draft. Module scope so it survives the surface unmounting on a nav switch.
export const briefDraftAtom = atom("");

// The once-per-launch guard on the Brief's subject restore. Session-scoped: the Brief unmounts on every nav
// switch, so a restore keyed to the surface would re-run — and re-open a peek the user had already closed —
// every time they came back.
export const briefRestoreConsumedAtom = atom(false) as PrimitiveAtom<boolean>;
