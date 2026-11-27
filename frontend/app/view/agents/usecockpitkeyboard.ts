// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Cockpit grid's own keys: the arrows walk the cursor along the path (thumbnails, the Idle line, the strip),
// Space zooms a thumbnail or an Idle name and opens a strip line's run, d dismisses a thumbnail, Enter opens a
// session on the Agent surface. Cockpit-local, handled here rather than by the global keybinding registry.

import { tabbedControlOwns } from "@/app/store/keybindings/dispatcher";
import { type KeyboardEvent, type MutableRefObject } from "react";
import { dismissedCursor, stepCursor, type ArrowKey, type GridPath, type GridTrail } from "./cockpitgridmodel";

export type CockpitKeyDeps = {
    path: GridPath;
    cursorId: string | undefined;
    setCursorId: (id: string | undefined) => void;
    trailRef: MutableRefObject<GridTrail>;
    zoom: (agentId: string) => void;
    // an Idle name zooms back out of the Idle line
    zoomIdle: (agentId: string) => void;
    dismiss: (agentId: string, nextCursor: string | undefined) => void;
    openStrip: (stopId: string) => void;
    openAgent: (agentId: string) => void;
};

const ARROWS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

export function useCockpitKeyboard(deps: CockpitKeyDeps): (e: KeyboardEvent) => void {
    const { path, cursorId, setCursorId, trailRef, zoom, zoomIdle, dismiss, openStrip, openAgent } = deps;
    return (e: KeyboardEvent) => {
        const t = e.target as HTMLElement;
        if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) {
            return;
        }
        // every key here is a bare key: a chord the global dispatcher did not take is not this surface's
        if (e.ctrlKey || e.altKey || e.metaKey) {
            return;
        }
        // a button reached with Tab owns Enter and Space, as the dispatcher already lets it
        if (tabbedControlOwns(e)) {
            return;
        }
        if (ARROWS.has(e.key)) {
            e.preventDefault();
            const step = stepCursor(path, cursorId, e.key as ArrowKey, trailRef.current);
            trailRef.current = step.trail;
            setCursorId(step.id);
            return;
        }
        if (cursorId == null) {
            return;
        }
        const onGrid = path.grid.includes(cursorId);
        const onIdle = path.idle.includes(cursorId);
        const onStrip = path.strip.includes(cursorId);
        if (e.key === " ") {
            if (onGrid) {
                e.preventDefault();
                zoom(cursorId);
            } else if (onIdle) {
                e.preventDefault();
                zoomIdle(cursorId);
            } else if (onStrip) {
                e.preventDefault();
                openStrip(cursorId);
            }
        } else if (e.key === "d" && onGrid) {
            e.preventDefault();
            dismiss(cursorId, dismissedCursor(path.grid, cursorId));
        } else if (e.key === "Enter" && (onGrid || onIdle)) {
            e.preventDefault();
            openAgent(cursorId);
        }
    };
}
