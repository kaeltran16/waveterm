// frontend/app/view/agents/difflayout.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: how wide the Diff surface is -> how wide its one list column is, and whether it is a column or a
// rail. The column holds the history over the selected commit's files, so the diff pane takes the rest;
// the column folds to a rail where even its narrowest would push the diff under its floor. The rest of
// the folding cascade stays declined (docs/deferred.md). Also which body the surface draws (diffBody).

import { atom, type PrimitiveAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";

export const HISTORY_MIN_PX = 300;
export const HISTORY_MAX_PX = 560;
export const HISTORY_DEFAULT_PX = 380;
// under this a unified diff wraps most lines in this repo
export const DIFF_FLOOR_PX = 640;
export const HISTORY_COLLAPSE_PX = HISTORY_MIN_PX + DIFF_FLOOR_PX;

const KEY_STEP_PX = 16;
const KEY_STEP_SHIFT_PX = 40;

// null = follow the width; true/false = the user said so and resizing must not undo it
export const historyCollapsedAtom = atom<boolean | null>(null) as PrimitiveAtom<boolean | null>;

// the Diff surface's measured width (0 = not measured), so ⇧H can flip what is drawn rather than the raw override
export const filesSurfaceWidthAtom = atom<number>(0) as PrimitiveAtom<number>;

// the width the user dragged the column to; historyWidthFor fits it to the surface on every read
export const historyWidthAtom = atomWithStorage<number>("diff.history.width", HISTORY_DEFAULT_PX);

export function historyMaxWidth(surfaceWidth: number): number {
    if (!(surfaceWidth > 0)) {
        return HISTORY_MAX_PX;
    }
    return Math.max(HISTORY_MIN_PX, Math.min(HISTORY_MAX_PX, surfaceWidth - DIFF_FLOOR_PX));
}

export function historyWidthFor(stored: number, surfaceWidth: number): number {
    const width = typeof stored === "number" && Number.isFinite(stored) ? stored : HISTORY_DEFAULT_PX;
    return Math.min(historyMaxWidth(surfaceWidth), Math.max(HISTORY_MIN_PX, Math.round(width)));
}

export function nextHistoryWidth(
    current: number,
    key: "ArrowLeft" | "ArrowRight" | "Home" | "End",
    shiftKey: boolean,
    max: number
): number {
    if (key === "Home") {
        return HISTORY_MIN_PX;
    }
    if (key === "End") {
        return max;
    }
    const step = shiftKey ? KEY_STEP_SHIFT_PX : KEY_STEP_PX;
    return Math.min(max, Math.max(HISTORY_MIN_PX, current + (key === "ArrowRight" ? step : -step)));
}

export function resolveCollapsed(explicit: boolean | null, surfaceWidth: number): boolean {
    if (explicit != null) {
        return explicit;
    }
    if (surfaceWidth <= 0) {
        return false; // not measured yet; expanding first avoids a rail that flashes and vanishes
    }
    return surfaceWidth < HISTORY_COLLAPSE_PX;
}

export type HistoryLayout = "rail" | "column" | "overlay";

// An explicit expand below the threshold overlays the panes instead of pushing the column into the
// window, which is what left the diff pane unreadably narrow.
export function historyLayout(explicit: boolean | null, width: number): HistoryLayout {
    if (resolveCollapsed(explicit, width)) {
        return "rail";
    }
    return width > 0 && width < HISTORY_COLLAPSE_PX ? "overlay" : "column";
}

export type DiffBody = "history-failure-in-column" | "whole-body-failure" | "not-a-repo" | "body";

// What the surface's body draws. A history failure takes over the whole body only when the change list has
// no good read to keep: then the read that failed is also the one that would say whether this is a repo. With
// a good change list the failure stays in the history column and the working tree stays usable.
export function diffBody(
    historyFailed: boolean,
    changeList: { cwd: string | null; isRepo: boolean; changes: unknown } | null
): DiffBody {
    if (historyFailed) {
        const good = changeList?.isRepo === true && changeList.changes != null;
        return good ? "history-failure-in-column" : "whole-body-failure";
    }
    if (changeList?.isRepo === false && changeList.cwd) {
        return "not-a-repo";
    }
    return "body";
}
