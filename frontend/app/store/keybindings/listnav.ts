// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The single home for the cockpit's "active list cursor". A plain master-detail list surface
// publishes its cursor list here while its list view is active; the registry's list-nav bindings
// (bindings.ts) read it on keypress. Only one surface is mounted at a time (cockpitshell), so at
// most one controller is active. The rich surfaces (cockpit/agent) own their own keys and MUST NOT
// register a controller.

import { globalStore } from "@/app/store/jotaiStore";
import type { SurfaceKey } from "@/app/view/agents/agents";
import { atom, type PrimitiveAtom } from "jotai";
import { useEffect } from "react";

export interface ListNavController {
    surface: SurfaceKey;
    navigableIds: string[];
    cursorId: string | undefined;
    setCursor: (id: string) => void; // cursor == selection: moving IS selecting
    // Enter on the focused row: fire the row's PRIMARY action (beyond mere selection) — e.g. Jump/Resume
    // a session, investigate a finding. Optional; when absent Enter passes through (bindings.ts).
    activate?: () => void;
}

export const listNavAtom = atom<ListNavController | null>(null) as PrimitiveAtom<ListNavController | null>;

// Register `controller` as the active list cursor for the caller's lifetime (or while its list view
// is active). Pass null when the list is not the active view (e.g. memory graph, files review) to
// withdraw. Memoize `controller` (useMemo) so registration only churns when the list/cursor changes.
export function useSurfaceListNav(controller: ListNavController | null): void {
    useEffect(() => {
        if (controller == null) {
            return;
        }
        globalStore.set(listNavAtom, controller);
        return () => {
            globalStore.set(listNavAtom, (prev) => (prev === controller ? null : prev));
        };
    }, [controller]);
}
