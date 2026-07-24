// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure builder for the command palette's "Focus on task" group (mirrors palette-launch/palette-ask). One
// row per active|paused task (from ListDossiersCommand); run() focuses that task. When a Space is already
// active it prepends an "Exit focus" row. Empty list + no active Space => no rows.

export interface FocusItem {
    key: string;
    title: string;
    subtitle?: string;
    run: () => void;
}

export interface FocusDeps {
    focus: (space: SpaceSummary) => void;
    exit: () => void;
}

export function buildFocusItems(spaces: SpaceSummary[], activeSpaceId: string | null, deps: FocusDeps): FocusItem[] {
    const items: FocusItem[] = [];
    if (activeSpaceId != null) {
        items.push({ key: "focus-exit", title: "Exit focus", subtitle: "Return to Global", run: deps.exit });
    }
    for (const s of spaces) {
        items.push({
            key: `focus-${s.id}`,
            title: s.objective,
            subtitle: s.ticket || undefined,
            run: () => deps.focus(s),
        });
    }
    return items;
}
