// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The creature's own state. Module atoms, never component state: the pet lives in window chrome and is
// the one object in the app that survives a surface switch (every surface but Agent unmounts), which is
// the whole point of mounting it in cockpit-root rather than inside a surface.
//
// Two values are remembered across launches — where it sits, and how much it has already said. The
// seed-from-localStorage-at-module-load pattern is ratelimitstore.ts's, so the pet is already in its
// corner on the first frame rather than jumping there after a hydration pass.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, type PrimitiveAtom } from "jotai";
import type { PetEvent, PetWatermark } from "./petvoice";

const CORNER_KEY = "wave:pet.corner";
const WATERMARK_KEY = "wave:pet.watermark";

// Corners rather than free x/y: an offset is measured against a viewport that changes size, while a
// corner still means the same place after a resize. Occlusion is the corner dweller's cost, and moving
// between corners is how it is paid (design §9).
//
// The bottom two only. A top pair used to be here and sat on the surface heading band — measured, that
// band runs y=66 to ~144 with the page title starting at x=106, and a top-corner creature spanned
// y=58-102: title text on the left, and because SurfaceHeader is justify-between, the header's action
// buttons on the right. A corner whose whole job is escaping occlusion cannot be the one that occludes
// most, so the escape is left/right along the bottom edge — the axis content is aligned on anyway.
export const PET_CORNERS = ["bottom-right", "bottom-left"] as const;
export type PetCorner = (typeof PET_CORNERS)[number];

const DEFAULT_CORNER: PetCorner = "bottom-right";

// Best-effort reads; any failure (no localStorage, parse error, a value written by an older shape) falls
// back to the default rather than throwing on the boot path.
function readCorner(): PetCorner {
    try {
        const raw = globalThis.localStorage?.getItem(CORNER_KEY);
        return (PET_CORNERS as readonly string[]).includes(raw ?? "") ? (raw as PetCorner) : DEFAULT_CORNER;
    } catch {
        return DEFAULT_CORNER;
    }
}

function readWatermark(): PetWatermark | null {
    try {
        const raw = globalThis.localStorage?.getItem(WATERMARK_KEY);
        if (!raw) {
            return null;
        }
        const parsed = JSON.parse(raw);
        return typeof parsed?.at === "number" && typeof parsed?.id === "string"
            ? { at: parsed.at, id: parsed.id }
            : null;
    } catch {
        return null;
    }
}

export const petCornerAtom = atom<PetCorner>(readCorner()) as PrimitiveAtom<PetCorner>;

export function setPetCorner(corner: PetCorner): void {
    globalStore.set(petCornerAtom, corner);
    try {
        globalThis.localStorage?.setItem(CORNER_KEY, corner);
    } catch {
        // quota/disabled — the in-memory atom still holds it for this session
    }
}

// Persisted, because "push once per event" has to survive a relaunch: an unpersisted watermark would
// make every launch re-say whatever the last session already said.
export const petWatermarkAtom = atom<PetWatermark | null>(readWatermark()) as PrimitiveAtom<PetWatermark | null>;

export function setPetWatermark(mark: PetWatermark): void {
    globalStore.set(petWatermarkAtom, mark);
    try {
        globalThis.localStorage?.setItem(WATERMARK_KEY, JSON.stringify(mark));
    } catch {
        // as above
    }
}

// Everything the creature could say, newest or oldest in any order — petvoice.ts orders them. This is
// the seam every Voice source writes into. All four triggers in the design (the launch resume narrative,
// a gardener sweep, a distillation batch, notes written into the vault) are backend reads that do not
// exist yet, so today nothing pushes and the creature is silent by construction rather than by a flag.
export const PET_EVENTS_MAX = 50;
export const petEventsAtom = atom<PetEvent[]>([]) as PrimitiveAtom<PetEvent[]>;

export function pushPetEvent(event: PetEvent): void {
    // by id, because a poller re-reporting the same completion must not queue it twice
    const events = globalStore.get(petEventsAtom).filter((e) => e.id !== event.id);
    globalStore.set(petEventsAtom, [event, ...events].slice(0, PET_EVENTS_MAX));
}

// What the bubble is showing, or null. Session-scoped: a bubble is a moment, not a state to restore.
export const petBubbleAtom = atom<PetEvent | null>(null) as PrimitiveAtom<PetEvent | null>;

// The unread marker. Set when a bubble auto-dismisses without being opened, cleared by the peek — the
// creature keeps the KIND of what happened, never a count of it (design §3).
export const petUnreadAtom = atom(false);

// Everything the creature has said this session, newest first. Auto-dismiss loses nothing because the
// peek reads this back. Bounded: it is a recent-history panel, not a log.
export const PET_SAID_MAX = 20;
export const petSaidAtom = atom<PetEvent[]>([]) as PrimitiveAtom<PetEvent[]>;

export function rememberSaid(event: PetEvent): void {
    const said = globalStore.get(petSaidAtom).filter((e) => e.id !== event.id);
    globalStore.set(petSaidAtom, [event, ...said].slice(0, PET_SAID_MAX));
}

// The embedding index's status, or null when it has not been read yet (or the read failed). Held as the
// raw wire shape rather than the narrowed signal so the peek can show `reason`/`detail` — the diagnostic
// half of the rank-1 condition, which is what turns "why is Jarvis useless" into an answer.
//
// Deliberately NOT on the attention poller's 10s cadence: the backend read parses the whole vault to count
// drift, and index state changes on the order of minutes to hours. petsources.tsx reads it at launch and
// on a slow interval.
export const petIndexAtom = atom<EmbedIndexStatus | null>(null) as PrimitiveAtom<EmbedIndexStatus | null>;

// The peek overlay's open state. Global for the same reason graphPeekOpenAtom and autonomyPanelOpenAtom
// are: Escape on a deep surface is bound to "back to Cockpit" (bindings.ts surface:back-home) and the
// dispatcher runs on window CAPTURE, so floating-ui's own Escape handling can never pre-empt it. Without
// the guard there, dismissing the peek also ejects the user to the Cockpit.
export const petPeekOpenAtom = atom(false);

// When Jarvis last said something, as a performance.now() reading, or null if not yet this session.
//
// Session-scoped and deliberately not persisted: it drives the data rings' surge, and a relaunch surging
// about something said an hour ago would be a lie. Held as a timestamp rather than as an animating value
// because the render loop derives the envelope per frame — a 60-per-second atom write would put a React
// render on every frame in a window running live terminals.
export const petSpokeAtAtom = atom<number | null>(null) as PrimitiveAtom<number | null>;

export function markPetSpoke(at: number): void {
    globalStore.set(petSpokeAtAtom, at);
}

// No pocket atom here on purpose. The Concierge floor's "it holds" (design §6) needs the carry/drop
// gestures and this store together; an atom with a reader and no writer made the peek's Pocket section
// unreachable, which is worse than absent — it cannot be tested and it reads as shipped. Build both
// halves at once. See docs/deferred.md.
