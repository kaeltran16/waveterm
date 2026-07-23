// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Jarvis surface state. The surface UNMOUNTS on nav-switch (only the agent surface stays mounted), so
// every survive-worthy value lives here as a module atom, never component useState. In Plan 1 the
// conversation source is the fixtures; Plan 2 replaces activeConversationAtom's source with the real
// backend behind the same reads.

import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import type { JarvisConversation } from "./jarviscontract";
import { FIXTURES, FIXTURE_STATES, type FixtureState } from "./jarvisfixtures";

export type JarvisMode = "recall" | "fleet";

// session-scoped: which mode the surface shows. Fleet mode is a placeholder in Plan 1 (migrated in Plan 3).
export const jarvisModeAtom = atom<JarvisMode>("recall");

// which fixture the surface renders. In Plan 2+ this is superseded by a real active-conversation id;
// kept in Plan 1 as the single source that the dev fixture bar and CDP drive.
export const activeFixtureAtom = atom<FixtureState>("empty");

// grounding rail expanded state — persisted, default collapsed so narrow panes keep conversation width
// (mirrors channelRailOpenAtom in railstore.ts). "narrow" state == this collapsed on a small viewport.
export const groundingRailOpenAtom = atomWithStorage("jarvis.grounding.open", false);

// read-only: the conversation currently shown. Source is fixtures in Plan 1.
export const activeConversationAtom = atom<JarvisConversation>((get) => FIXTURES[get(activeFixtureAtom)]);

// read-only: the history-rail list. In Plan 1 this is the fixture set (excluding the "narrow" alias so a
// state does not appear twice); Plan 2 replaces it with persisted conversations.
export const conversationsAtom = atom<JarvisConversation[]>(() =>
    FIXTURE_STATES.filter((s) => s !== "narrow").map((s) => FIXTURES[s])
);
