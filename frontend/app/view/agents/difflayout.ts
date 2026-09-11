// frontend/app/view/agents/difflayout.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: how wide the Diff surface is -> whether the commit column is a column or a rail. The
// surface ships in a 1000x700 window (src-tauri/tauri.conf.json), where a fixed 460px history plus
// a 300px file list leaves the diff pane about 240px — unreadable. One threshold on one column is
// the whole of it; the rest of the folding cascade stays declined (docs/deferred.md).

import { atom, type PrimitiveAtom } from "jotai";

export const HISTORY_COLLAPSE_PX = 1280;

// null = follow the width; true/false = the user said so and resizing must not undo it
export const historyCollapsedAtom = atom<boolean | null>(null) as PrimitiveAtom<boolean | null>;

export function resolveCollapsed(explicit: boolean | null, surfaceWidth: number): boolean {
    if (explicit != null) {
        return explicit;
    }
    if (surfaceWidth <= 0) {
        return false; // not measured yet; expanding first avoids a rail that flashes and vanishes
    }
    return surfaceWidth < HISTORY_COLLAPSE_PX;
}
