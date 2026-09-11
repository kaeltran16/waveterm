// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Jarvis surface state. The surface UNMOUNTS on nav-switch (only the agent surface stays mounted), so
// every survive-worthy value lives here as a module atom, never component useState. In Plan 1 the
// conversation source is the fixtures; Plan 2 replaces activeConversationAtom's source with the real
// backend behind the same reads.

import { globalStore } from "@/app/store/global";
import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom, type PrimitiveAtom } from "jotai";
import type {
    AnswerSegment,
    GroundingCard,
    JarvisAnswerTurn,
    JarvisConversation,
    JarvisScope,
    JarvisUserTurn,
    Terminal,
    WorkingStep,
} from "./jarviscontract";
import { sourceConversationAtom } from "./jarvissubjectstore";
import { terminalAfterStreamFailure } from "./jarvisturnderive";
import { mapConvoRecord, mapWireCard, parseCitations } from "./recallderive";

// The record the Brief's peek is open on, or null. Module-level rather than surface state because the
// Jarvis surface unmounts when you navigate away from it, and a peek opened from an oref must survive the
// surface flip that oref triggers.
export const briefPeekRecordAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;

// Whether the Brief's detail sheet is showing. The subject it draws is the surface's active subject, not a
// second copy of it here: keeping the target in two atoms is how a sheet and the thing it claims to show
// end up naming different objects. Session-scoped, because the subject is what is persisted and a closed
// sheet clears it — so what reopens on the next launch is the subject that was left open, not this flag.
export const briefSheetOpenAtom = atom(false);

// The graph peek overlay. Session-scoped, not persisted: a peek is a momentary look at one object's
// neighbourhood, so reopening the app on top of one would be reopening a destination it is not.
export const graphPeekOpenAtom = atom(false);

// The record the Brief's graph peek was opened to focus, or null. Separate from the peek's `record` atom
// because a map button names an object to centre on, and the graph's other routes (an attached source, a
// cited record) derive their focus from state that is already there. Cleared with the peek, so the next
// unaddressed open falls back to deriving focus rather than re-centring on a record the user has left.
export const briefGraphRecordAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;

// --- real conversations (Plan 2) -------------------------------------------------------------------
// Writable source of truth for real recall conversations, keyed by id. Mirrors channelsstore's
// Record<string,…> primitive-atom + module-setter pattern so an in-flight stream keeps writing after the
// surface unmounts (writes go through globalStore.set at module scope, never component useState).
export const conversationsByIdAtom = atom<Record<string, JarvisConversation>>({});
// null until the first list lands, so the boot-time subject restore can tell "no threads" from "not yet".
// Cast per this repo's convention: atom<T | null>(null) infers a read-only Atom under the pinned jotai.
export const persistedSummariesAtom = atom<JarvisConversationSummary[] | null>(null) as PrimitiveAtom<
    JarvisConversationSummary[] | null
>;

// null => show the dev/CDP fixture selected by activeFixtureAtom; a string => show that real conversation.
// Cast per this repo's convention: atom<T | null>(null) infers a read-only Atom under the pinned jotai.
export const activeConversationIdAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;

// read-only: the history-rail list — real conversations first (newest-first by insertion).
// --- module accessors + mutators (module scope: survive unmount) -----------------------------------
export function summaryToRailConversation(summary: JarvisConversationSummary): JarvisConversation {
    return {
        id: summary.id,
        title: summary.title,
        turns: [],
        scope: { mode: summary.scopemode as JarvisScope["mode"], chips: [], attached: [] },
        archived: summary.archived === true,
    };
}

// Rebuild the oref -> conversation map from persisted summaries, so asking about the same Run after a
// restart continues its thread instead of minting an identical second one. Summaries arrive newest-first,
// so the first claim on an oref wins; an in-session mapping always beats a persisted one.
export function rehydrateSourceMap(
    summaries: JarvisConversationSummary[],
    existing: Record<string, string>
): Record<string, string> {
    const next: Record<string, string> = {};
    for (const summary of summaries) {
        for (const oref of summary.attachedorefs ?? []) {
            if (next[oref] == null) {
                next[oref] = summary.id;
            }
        }
    }
    return { ...next, ...existing };
}

export function loadJarvisConversations(): void {
    fireAndForget(async () => {
        const result = await RpcApi.ListJarvisConversationsCommand(TabRpcClient);
        const summaries = result?.conversations ?? [];
        globalStore.set(persistedSummariesAtom, summaries);
        globalStore.set(sourceConversationAtom, rehydrateSourceMap(summaries, globalStore.get(sourceConversationAtom)));
    });
}

// Thread lifecycle. Mirrors channelsstore's delete/archive: mutate, then re-list, because the Threads group
// is built from the summary snapshot rather than from a live subscription.
export async function deleteJarvisConversation(id: string): Promise<void> {
    await RpcApi.DeleteJarvisConversationCommand(TabRpcClient, { conversationid: id });
    // drop the live copy too, else the deleted thread survives in conversationsByIdAtom for the session
    const byId = { ...globalStore.get(conversationsByIdAtom) };
    delete byId[id];
    globalStore.set(conversationsByIdAtom, byId);
    if (globalStore.get(activeConversationIdAtom) === id) {
        globalStore.set(activeConversationIdAtom, null);
    }
    loadJarvisConversations();
}

export async function archiveJarvisConversation(id: string, archived: boolean): Promise<void> {
    await RpcApi.ArchiveJarvisConversationCommand(TabRpcClient, { conversationid: id, archived });
    // the live copy shadows its own summary in conversationsAtom, so re-listing alone would leave a thread
    // you had opened this session sitting in Threads until the next launch. Mirrors the delete path.
    const conv = getConversation(id);
    if (conv != null) {
        setConversation({ ...conv, archived });
    }
    loadJarvisConversations();
}

export function getConversation(id: string): JarvisConversation | undefined {
    return globalStore.get(conversationsByIdAtom)[id];
}

export function setConversation(conv: JarvisConversation): void {
    globalStore.set(conversationsByIdAtom, { ...globalStore.get(conversationsByIdAtom), [conv.id]: conv });
}

// Drop a thread that was never asked in. Both "+ Thread" and every contextual entry create the
// conversation up front, so an unasked one is a false start titled "New conversation" — it used to sit in
// the Threads group for the rest of the session. Nothing durable is lost: the backend record is created by
// the *first* turn (wshserver_jarvis.go), so a turnless conversation has never reached the store.
// Deliberately narrow — an id this map does not hold is left alone, because a persisted thread the user
// clicked before its load landed is absent, not empty (and a persisted one always has turns).
export function pruneEmptyConversation(id: string): boolean {
    const byId = globalStore.get(conversationsByIdAtom);
    const conv = byId[id];
    if (conv == null || conv.turns.length > 0) {
        return false;
    }
    const next = { ...byId };
    delete next[id];
    globalStore.set(conversationsByIdAtom, next);
    return true;
}

// startConversation creates an empty real conversation, makes it active, and returns its id.
export function startConversation(scope: JarvisScope): string {
    const id = crypto.randomUUID();
    setConversation({ id, title: "New conversation", turns: [], scope });
    globalStore.set(activeConversationIdAtom, id);
    return id;
}

// selectConversation activates a row: a real conversation by id, loading it if this session has not seen
// it yet.
export function selectConversation(id: string): void {
    if (globalStore.get(conversationsByIdAtom)[id]) {
        globalStore.set(activeConversationIdAtom, id);
        return;
    }
    globalStore.set(activeConversationIdAtom, id);
    fireAndForget(async () => {
        const oref = WOS.makeORef("jarvisconversation", id);
        if (oref == null) return;
        const record = await WOS.loadAndPinWaveObject<JarvisConvo>(oref);
        if (record) setConversation(mapConvoRecord(record));
    });
}

// --- streaming submit (Plan 2) ---------------------------------------------------------------------
// A consult runs a headless CLI up to the backend's 120s cap; give the RPC stream headroom past it (the
// layer's 5s default would kill it long before an answer lands). Mirrors usefleetsummary's constant.
const JARVIS_RPC_TIMEOUT_MS = 130_000;

// patchAnswer immutably updates the streaming jarvis turn at turns[idx] of a conversation.
function patchAnswer(convId: string, idx: number, partial: Partial<JarvisAnswerTurn>): void {
    const conv = getConversation(convId);
    if (!conv) return;
    const turn = conv.turns[idx];
    if (!turn || turn.role !== "jarvis") return;
    const turns = conv.turns.slice();
    turns[idx] = { ...turn, ...partial };
    setConversation({ ...conv, turns });
}

// upsertStep replaces a step with the same id (a lifecycle transition) or appends a new one.
function upsertStep(steps: WorkingStep[], step: WorkingStep): WorkingStep[] {
    const i = steps.findIndex((s) => s.id === step.id);
    if (i >= 0) {
        const next = steps.slice();
        next[i] = step;
        return next;
    }
    return [...steps, step];
}

// Live converse streams, keyed conversation:answerIdx. The generator is the cancel handle: calling
// gen.return() sends the wire cancel (wshrpcutil-base.ts), which unwinds the server's streaming goroutine
// through ctx.Done() - so there is no separate abort protocol to build.
const liveStreams = new Map<string, { gen: AsyncGenerator<unknown, void, boolean>; cancelled: boolean }>();

const streamKey = (convId: string, answerIdx: number) => `${convId}:${answerIdx}`;

export function cancelJarvisQuery(convId: string, answerIdx: number): void {
    const key = streamKey(convId, answerIdx);
    const live = liveStreams.get(key);
    if (live == null || live.cancelled) {
        return;
    }
    // mark first: gen.return() can surface in the stream's catch, which would otherwise overwrite this
    // with "error" and tell the user something broke when they are the one who stopped it.
    live.cancelled = true;
    patchAnswer(convId, answerIdx, { terminal: "cancelled", streaming: false });
    void live.gen.return(undefined);
}

// submitJarvisQuery appends the user's turn + a live jarvis turn, then streams JarvisConverseCommand into
// that jarvis turn. Runs under fireAndForget at module scope so the turn keeps accumulating even if the
// surface unmounts on a nav-switch. Grounding cards + working-steps arrive as typed chunks; prose arrives as
// text fragments re-parsed into [n] segments each chunk; the terminal chunk sets the verdict.
export function submitJarvisQuery(convId: string, text: string): void {
    const conv = getConversation(convId);
    const trimmed = text.trim();
    if (!conv || trimmed === "") return;

    const userTurn: JarvisUserTurn = { role: "user", text: trimmed, attachments: conv.scope.attached };
    const answerTurn: JarvisAnswerTurn = {
        role: "jarvis",
        workingSteps: [],
        segments: [],
        grounding: [],
        terminal: "answered",
        streaming: true,
    };
    const title = conv.turns.length === 0 ? trimmed : conv.title;
    setConversation({ ...conv, title, turns: [...conv.turns, userTurn, answerTurn] });
    const answerIdx = conv.turns.length + 1;

    fireAndForget(async () => {
        let raw = "";
        let steps: WorkingStep[] = [];
        const cards: GroundingCard[] = [];
        const key = streamKey(convId, answerIdx);
        try {
            const gen = RpcApi.JarvisConverseCommand(
                TabRpcClient,
                {
                    conversationid: convId,
                    prompt: trimmed,
                    scopemode: conv.scope.mode,
                    projectpath: "",
                    attachedorefs: conv.scope.attached.map((a) => a.oref),
                    requestid: `${convId}-${answerIdx}`,
                },
                { timeout: JARVIS_RPC_TIMEOUT_MS }
            );
            liveStreams.set(key, { gen, cancelled: false });
            for await (const chunk of gen) {
                if (chunk == null) continue;
                if (chunk.kind === "step" && chunk.step) {
                    steps = upsertStep(steps, {
                        id: chunk.step.id,
                        label: chunk.step.label,
                        status: chunk.step.status as WorkingStep["status"],
                    });
                    patchAnswer(convId, answerIdx, { workingSteps: steps });
                } else if (chunk.kind === "grounding" && chunk.grounding) {
                    cards.push(mapWireCard(chunk.grounding));
                    patchAnswer(convId, answerIdx, { grounding: [...cards] });
                } else if (chunk.kind === "text") {
                    raw += chunk.text ?? "";
                    const segments: AnswerSegment[] = parseCitations(raw, cards);
                    patchAnswer(convId, answerIdx, { segments });
                } else if (chunk.kind === "terminal") {
                    patchAnswer(convId, answerIdx, { terminal: (chunk.terminal as Terminal) ?? "answered" });
                }
            }
        } catch {
            // preserve whatever streamed, but say what actually happened: the request died. Marking it
            // "weak" drew the amber grounding badge, so a dead backend and a thin corpus were the same
            // turn. "error" is the only terminal that offers a retry.
            const terminal = terminalAfterStreamFailure(liveStreams.get(key)?.cancelled === true);
            if (terminal != null) {
                patchAnswer(convId, answerIdx, { terminal });
            }
        } finally {
            // every exit clears streaming — natural completion, error and cancel alike — so the Cancel
            // control disappears exactly when the stream closes.
            liveStreams.delete(key);
            patchAnswer(convId, answerIdx, { streaming: false });
        }
    });
}

// Re-run a failed turn: drop it and the question it answered, then submit the same prompt into the same
// conversation. Re-submitting rather than resuming in place keeps one streaming path — the failed turn
// has no stream left to attach to.
export function retryJarvisQuery(convId: string, answerIdx: number): void {
    const conv = getConversation(convId);
    if (!conv) {
        return;
    }
    const answer = conv.turns[answerIdx];
    const question = conv.turns[answerIdx - 1];
    if (answer?.role !== "jarvis" || question?.role !== "user") {
        return;
    }
    setConversation({ ...conv, turns: conv.turns.slice(0, answerIdx - 1) });
    submitJarvisQuery(convId, question.text);
}
