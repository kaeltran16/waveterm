// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Cockpit grid's pure layout: how many columns a width holds, the cursor's arrow path through the thumbnails,
// the Idle line's names and the no-conductor strip, and the anchored order that keeps each thumbnail in its slot.

import { mergeOrder } from "./agentsviewmodel";
import type { CockpitSession } from "./cockpitsessionmodel";

// under this grid width the thumbnails drop to two columns
export const NARROW_GRID_PX = 1100;
const WIDE_COLUMNS = 3;
const NARROW_COLUMNS = 2;
// rows that fill the viewport; a row past them scrolls at the same height
export const GRID_ROWS_IN_VIEW = 2;

export function gridColumns(widthPx: number): number {
    return widthPx < NARROW_GRID_PX ? NARROW_COLUMNS : WIDE_COLUMNS;
}

export type GridZone = "grid" | "idle" | "strip";
export type ArrowKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";

// every cursor stop in path order: thumbnails, then the Idle line's names, then the strip's lines
export interface GridPath {
    grid: string[];
    idle: string[];
    strip: string[];
    columns: number;
}

// the stop the cursor last held in each zone it left, so Up retraces the way Down came
export type GridTrail = Partial<Record<GridZone, string>>;

const ZONES: GridZone[] = ["grid", "idle", "strip"];

function zoneOf(path: GridPath, id: string | undefined): GridZone | null {
    return id == null ? null : (ZONES.find((z) => path[z].includes(id)) ?? null);
}

const clamp = (i: number, n: number) => Math.max(0, Math.min(n - 1, i));

// the first stop of the nearest non-empty zone below, or null at the bottom
function below(path: GridPath, zone: GridZone): string | null {
    for (const z of ZONES.slice(ZONES.indexOf(zone) + 1)) {
        if (path[z].length > 0) {
            return path[z][0];
        }
    }
    return null;
}

// where Up from a zone's top lands: the stop it left in the nearest non-empty zone above, else that zone's stop
// nearest the one below it (the grid's last thumbnail, the Idle line's first name)
function above(path: GridPath, zone: GridZone, trail: GridTrail): string | null {
    for (const z of ZONES.slice(0, ZONES.indexOf(zone)).reverse()) {
        const ids = path[z];
        if (ids.length === 0) {
            continue;
        }
        const back = trail[z];
        if (back != null && ids.includes(back)) {
            return back;
        }
        return z === "grid" ? ids[ids.length - 1] : ids[0];
    }
    return null;
}

function stepGrid(path: GridPath, i: number, key: ArrowKey): string | null {
    const ids = path.grid;
    const cols = path.columns;
    switch (key) {
        case "ArrowLeft":
            return ids[clamp(i - 1, ids.length)];
        case "ArrowRight":
            return ids[clamp(i + 1, ids.length)];
        case "ArrowUp":
            return i - cols >= 0 ? ids[i - cols] : ids[i];
        case "ArrowDown": {
            if (i + cols < ids.length) {
                return ids[i + cols];
            }
            const lastRow = Math.floor((ids.length - 1) / cols);
            // a cell with no thumbnail below it, above a shorter bottom row
            return Math.floor(i / cols) < lastRow ? ids[ids.length - 1] : below(path, "grid");
        }
    }
}

function stepZone(path: GridPath, zone: GridZone, i: number, key: ArrowKey, trail: GridTrail): string | null {
    if (zone === "grid") {
        return stepGrid(path, i, key);
    }
    const ids = path[zone];
    // the Idle line runs across, the strip down
    const [back, next] = zone === "idle" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
    if (key === back) {
        return i > 0 ? ids[i - 1] : zone === "strip" ? above(path, zone, trail) : ids[i];
    }
    if (key === next) {
        return ids[clamp(i + 1, ids.length)];
    }
    if (key === "ArrowUp") {
        return above(path, zone, trail);
    }
    if (key === "ArrowDown") {
        return below(path, zone);
    }
    return ids[i];
}

// One arrow press. A stop not on the path starts from the first stop. The trail records the stop left behind
// whenever the cursor changes zone.
export function stepCursor(
    path: GridPath,
    cur: string | undefined,
    key: ArrowKey,
    trail: GridTrail
): { id: string | undefined; trail: GridTrail } {
    const zone = zoneOf(path, cur);
    if (zone == null) {
        return { id: resolveCursor(path, undefined), trail };
    }
    const next = stepZone(path, zone, path[zone].indexOf(cur!), key, trail) ?? cur;
    const nextZone = zoneOf(path, next);
    return { id: next, trail: nextZone !== zone ? { ...trail, [zone]: cur } : trail };
}

// a cursor whose stop is gone falls to the first stop on the path
export function resolveCursor(path: GridPath, cur: string | undefined): string | undefined {
    if (zoneOf(path, cur) != null) {
        return cur;
    }
    return path.grid[0] ?? path.idle[0] ?? path.strip[0];
}

// the thumbnail that takes the cursor once id leaves the grid: the one after it, else the one before
export function dismissedCursor(grid: string[], id: string): string | undefined {
    const i = grid.indexOf(id);
    const left = grid.filter((g) => g !== id);
    return left[Math.min(Math.max(i, 0), left.length - 1)];
}

// Thumbnails in the anchored order: a kept id holds its slot whatever its state does, a new or returning one
// appends. Returns the order to store with them.
export function anchoredSessions(
    prev: string[],
    sessions: CockpitSession[]
): { order: string[]; sessions: CockpitSession[] } {
    const order = mergeOrder(
        prev,
        sessions.map((s) => s.agent.id)
    );
    const byId = new Map(sessions.map((s) => [s.agent.id, s]));
    return { order, sessions: order.map((id) => byId.get(id)!) };
}
