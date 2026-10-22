// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Brief's j/k cursor. The ids it walks are the drawn lines' own (briefrows.ts builds them, region-
// prefixed, because one object can sit in two regions), so a filtered or folded row is never navigable.

import type { ListNavController } from "@/app/store/keybindings/listnav";
import { lineOpenTarget, type BriefLine, type LineTarget } from "./briefrows";
import { expandableORef, type TrackerRow } from "./inlinetracker";

/**
 * The cursor the surface should actually render. The Brief re-derives every row on each snapshot
 * refresh, so the row under the cursor can resolve out from under it — an ask gets answered, a session
 * finishes. A cursor naming a row that no longer exists would leave j/k dead with nothing highlighted,
 * so it falls back to the first row rather than persisting a reference to something gone.
 */
export function resolveBriefCursor(ids: string[], cursor: string | undefined): string | undefined {
    if (ids.length === 0) {
        return undefined;
    }
    return cursor != null && ids.includes(cursor) ? cursor : ids[0];
}

export type RunNav = { lines: BriefLine[]; cursorId: string | undefined };

/**
 * With a run sheet open on a run of the published list, j/k step the sheet through that list (design
 * L1830): the rows are the ones its n / N counts, and landing on one opens it. The cursor is still the
 * Brief's one cursor, so closing the sheet leaves it on the run last shown. null when the sheet is closed
 * or shows a run outside the list.
 */
export function runNavLines(input: {
    sheetOpen: boolean;
    stageRun: { id: string; status: string } | null | undefined;
    runList: string[];
    shippedLines: BriefLine[];
    sessionLines: BriefLine[];
}): RunNav | null {
    const { stageRun, runList } = input;
    if (!input.sheetOpen || stageRun == null || !runList.includes(stageRun.id)) {
        return null;
    }
    const inList = new Set(runList);
    const shippedList = stageRun.status === "done";
    const oidOf = (l: BriefLine) =>
        shippedList
            ? l.target != null && "oref" in l.target
                ? l.target.oref.replace(/^run:/, "")
                : ""
            : (l.runOid ?? "");
    const lines = (shippedList ? input.shippedLines : input.sessionLines).filter((l) => inList.has(oidOf(l)));
    return { lines, cursorId: lines.find((l) => oidOf(l) === stageRun.id)?.id };
}

export type CursorAction =
    | { kind: "select-chunk"; id: string }
    | { kind: "toggle-initiative"; id: string }
    | { kind: "open"; target: NonNullable<LineTarget> }
    | null;

/**
 * Enter's primary action, by what the cursor is on: an initiative expands in place (it no longer has a
 * sheet to open), a chunk opens its sidebar (its newest short note already reads open), every other row
 * opens its target.
 */
export function cursorAction(row: TrackerRow | null): CursorAction {
    if (row == null) {
        return null;
    }
    if (row.kind === "chunk") {
        return { kind: "select-chunk", id: row.id };
    }
    if (row.kind !== "line") {
        return null;
    }
    if (expandableORef(row.line) != null) {
        return { kind: "toggle-initiative", id: row.id };
    }
    return row.line.target != null ? { kind: "open", target: row.line.target } : null;
}

/**
 * The Brief's list-nav controller: j/k across every region in render order, and Enter opens the row under
 * the cursor. Enter is left alone while a sheet is open, because the sheet's own Enter (an ask's submit) is
 * the one on screen, and on a row that opens nothing, so the key passes through. With a run sheet open on
 * the published run list, j/k walk that list instead and open each run they land on.
 */
export function briefListNav(input: {
    runNav: RunNav | null;
    navIds: string[];
    cursor: string | undefined;
    setCursor: (id: string) => void;
    openLine: (target: LineTarget) => void;
    sheetOpen: boolean;
    cursorRow: TrackerRow | null;
    activate: () => void;
    cursorTarget: LineTarget;
}): ListNavController {
    const { runNav, setCursor } = input;
    if (runNav != null) {
        return {
            surface: "jarvis",
            navigableIds: runNav.lines.map((l) => l.id),
            cursorId: runNav.cursorId,
            setCursor: (id: string) => {
                setCursor(id);
                const target = runNav.lines.find((l) => l.id === id)?.target;
                if (target != null) {
                    input.openLine(target);
                }
            },
        };
    }
    return {
        surface: "jarvis",
        navigableIds: input.navIds,
        cursorId: input.cursor,
        setCursor,
        activate: input.sheetOpen || input.cursorRow == null ? undefined : input.activate,
        peekTarget: input.sheetOpen ? undefined : () => lineOpenTarget(input.cursorTarget),
    };
}
