// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Jarvis surface state. The surface UNMOUNTS on nav-switch (only the agent surface stays mounted), so
// every survive-worthy value lives here as a module atom, never component useState. In Plan 1 the
// conversation source is the fixtures; Plan 2 replaces activeConversationAtom's source with the real
// backend behind the same reads.

import { globalStore } from "@/app/store/global";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import * as WOS from "@/app/store/wos";
import { fireAndForget } from "@/util/util";
import { atom, type PrimitiveAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
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
import { FIXTURES, FIXTURE_STATES, type FixtureState } from "./jarvisfixtures";
import { mapConvoRecord, mapWireCard, parseCitations } from "./recallderive";

// DEV-ONLY fixtures. A fabricated thread carrying fabricated citations and freshness badges is
// indistinguishable from a real one, so the fixture *data* is gated exactly like the fixture bar that
// drives it. import.meta.env.DEV is statically false in a production build, so every branch below folds
// away and jarvisfixtures.ts leaves the bundle.
const DEV_FIXTURES = import.meta.env.DEV;

// which fixture the surface renders, or null for none. Only the dev fixture bar (and CDP through it) ever
// sets this: null is the ordinary state, and it must mean "no conversation", not "the empty fixture" —
// conflating the two is what leaked fixture scope chips onto records that had never been asked anything.
export const activeFixtureAtom = atom<FixtureState | null>(null) as PrimitiveAtom<FixtureState | null>;

// what the Stage shows when nothing is selected. A real value rather than null so every consumer can read
// .scope/.turns without a guard.
const NO_CONVERSATION: JarvisConversation = {
    id: "",
    title: "New conversation",
    turns: [],
    scope: { mode: "all", chips: [], attached: [] },
};

// The channel profile drawer (the ⚙), opened from the Stage header. Session-scoped, not persisted.
export const profileRailOpenAtom = atom(false);

// The merged surface's one context rail. Open by default, unlike the two rails it replaces: it now carries
// Needs you, which is the surface's attention channel and must not start hidden behind a 44px strip.
export const stageRailOpenAtom = atomWithStorage("jarvis.stagerail.open", true);

// The graph peek overlay. Session-scoped, not persisted: a peek is a momentary look at one object's
// neighbourhood, so reopening the app on top of one would be reopening a destination it is not.
export const graphPeekOpenAtom = atom(false);

// @jarvis handoff: the rail's Fleet section runs a summary once for the channel named here and clears it,
// so the summary lands in place rather than moving the user off their subject. null = no pending handoff.
// Module atom so it survives a nav-switch mid-flight.
// UNREACHABLE as of the consolidation: the only writer is channelactions' @jarvis branch, and no composer
// path can produce a leading "@jarvis" any more (parseComposerCommand knows @quick/@run/@ask only, and both
// callers synthesize their own transport string). Either wire it up or delete the branch, the atom and the
// StageRail effect together — do not leave it looking live.
// Cast per this repo's convention: atom<T | null>(null) infers a read-only Atom under the pinned jotai.
export const pendingFleetSummaryAtom = atom<{ channelId: string; focus: string } | null>(
    null
) as PrimitiveAtom<{ channelId: string; focus: string } | null>;

// --- real conversations (Plan 2) -------------------------------------------------------------------
// Writable source of truth for real recall conversations, keyed by id. Mirrors channelsstore's
// Record<string,…> primitive-atom + module-setter pattern so an in-flight stream keeps writing after the
// surface unmounts (writes go through globalStore.set at module scope, never component useState).
export const conversationsByIdAtom = atom<Record<string, JarvisConversation>>({});
export const persistedSummariesAtom = atom<JarvisConversationSummary[]>([]);

// null => show the dev/CDP fixture selected by activeFixtureAtom; a string => show that real conversation.
// Cast per this repo's convention: atom<T | null>(null) infers a read-only Atom under the pinned jotai.
export const activeConversationIdAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;

// ephemeral composer draft; a module atom (not useState) so a nav-switch away and back keeps the draft.
export const jarvisDraftAtom = atom<string>("");

// read-only: the conversation currently shown. Real conversation wins; else a dev fixture if the fixture
// bar has explicitly selected one; else the empty conversation.
export const activeConversationAtom = atom<JarvisConversation>((get) => {
    const id = get(activeConversationIdAtom);
    if (id != null) {
        const conv = get(conversationsByIdAtom)[id];
        if (conv) return conv;
    }
    const fixture = DEV_FIXTURES ? get(activeFixtureAtom) : null;
    return fixture != null ? FIXTURES[fixture] : NO_CONVERSATION;
});

// read-only: the history-rail list — real conversations first (newest-first by insertion), then the dev
// fixtures (excluding the "narrow" alias), which exist only in a dev build.
export const conversationsAtom = atom<JarvisConversation[]>((get) => {
    const byId = get(conversationsByIdAtom);
    const real = Object.values(byId).reverse();
    const liveIds = new Set(Object.keys(byId));
    const persisted = get(persistedSummariesAtom)
        .filter((summary) => !liveIds.has(summary.id))
        .map(summaryToRailConversation);
    if (!DEV_FIXTURES) {
        return [...real, ...persisted];
    }
    const fixtures = FIXTURE_STATES.filter((s) => s !== "narrow").map((s) => FIXTURES[s]);
    return [...real, ...persisted, ...fixtures];
});

// --- module accessors + mutators (module scope: survive unmount) -----------------------------------
export function summaryToRailConversation(summary: JarvisConversationSummary): JarvisConversation {
    return {
        id: summary.id,
        title: summary.title,
        turns: [],
        scope: { mode: summary.scopemode as JarvisScope["mode"], chips: [], attached: [] },
    };
}

export function loadJarvisConversations(): void {
    fireAndForget(async () => {
        const result = await RpcApi.ListJarvisConversationsCommand(TabRpcClient);
        globalStore.set(persistedSummariesAtom, result?.conversations ?? []);
    });
}

export function getConversation(id: string): JarvisConversation | undefined {
    return globalStore.get(conversationsByIdAtom)[id];
}

export function setConversation(conv: JarvisConversation): void {
    globalStore.set(conversationsByIdAtom, { ...globalStore.get(conversationsByIdAtom), [conv.id]: conv });
}

// startConversation creates an empty real conversation, makes it active, and returns its id.
export function startConversation(scope: JarvisScope): string {
    const id = crypto.randomUUID();
    setConversation({ id, title: "New conversation", turns: [], scope });
    globalStore.set(activeConversationIdAtom, id);
    return id;
}

// selectConversation activates a history-rail row: a real conversation by id, or (for a dev fixture row)
// falls back to the fixture selector and clears the real-active id.
export function selectConversation(id: string): void {
    if (globalStore.get(conversationsByIdAtom)[id]) {
        globalStore.set(activeConversationIdAtom, id);
        return;
    }
    if (DEV_FIXTURES && (FIXTURE_STATES as string[]).includes(id)) {
        globalStore.set(activeFixtureAtom, id as FixtureState);
        globalStore.set(activeConversationIdAtom, null);
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

// submitJarvisQuery appends the user's turn + a live jarvis turn, then streams JarvisConverseCommand into
// that jarvis turn. Runs under fireAndForget at module scope so the turn keeps accumulating even if the
// surface unmounts on a nav-switch. Grounding cards + working-steps arrive as typed chunks; prose arrives as
// text fragments re-parsed into [n] segments each chunk; the terminal chunk sets the verdict.
export function submitJarvisQuery(convId: string, text: string): void {
    const conv = getConversation(convId);
    const trimmed = text.trim();
    if (!conv || trimmed === "") return;

    const userTurn: JarvisUserTurn = { role: "user", text: trimmed, attachments: conv.scope.attached };
    const answerTurn: JarvisAnswerTurn = { role: "jarvis", workingSteps: [], segments: [], grounding: [], terminal: "answered" };
    const title = conv.turns.length === 0 ? trimmed : conv.title;
    setConversation({ ...conv, title, turns: [...conv.turns, userTurn, answerTurn] });
    const answerIdx = conv.turns.length + 1;

    fireAndForget(async () => {
        let raw = "";
        let steps: WorkingStep[] = [];
        const cards: GroundingCard[] = [];
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
            for await (const chunk of gen) {
                if (chunk == null) continue;
                if (chunk.kind === "step" && chunk.step) {
                    steps = upsertStep(steps, { id: chunk.step.id, label: chunk.step.label, status: chunk.step.status as WorkingStep["status"] });
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
            // preserve whatever streamed; mark the turn weak (mirrors usefleetsummary's error path).
            patchAnswer(convId, answerIdx, { terminal: "weak" });
        }
    });
}
