// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Projects the live keybinding registry into command-palette rows, so the registry is the single
// source of truth for what the cockpit can do and what it is called — and every row can show the chord
// that runs it. Before this module the palette hand-wrote eleven commands, duplicating a slice of the
// registry's labels and showing no chords at all.

import type { Binding, KeyContext, SurfaceKey } from "@/app/store/keybindings/types";
import { PICKER_THEMES } from "@/app/view/agents/themes";

export interface CommandItem {
    key: string; // binding id, or "cmd:<slug>" for a chordless extra
    title: string;
    keys?: string; // chord descriptor for formatChord; absent for chordless extras
    group: string;
    run: () => void;
}

// Binding guards are written against the posture of someone looking at a surface. While the palette is
// open the live context has modalOpen: true and editable: true (its search input holds focus), so
// evaluating guards against it would reject nearly everything worth listing. Applicability is judged
// against the context that exists one frame after the palette closes.
export function postCloseContext(surface: SurfaceKey): KeyContext {
    return { surface, editable: false, modalOpen: false, leader: null };
}

// Prefer the chord a user types deliberately: a leader sequence ("g u") over a modifier chord
// ("Ctrl:Tab") over a bare posture key ("j"), so a row never advertises the key you press without
// thinking when a memorable one exists for the same action.
function chordRank(keys: string): number {
    if (keys.includes(" ")) {
        return 0;
    }
    if (keys.includes(":")) {
        return 1;
    }
    return 2;
}

export function buildCommandItems(bindings: Binding[], ctx: KeyContext): CommandItem[] {
    const byLabel = new Map<string, Binding>();
    for (const b of bindings) {
        if (b.paletteHidden) {
            continue;
        }
        if (b.when != null && !b.when(ctx)) {
            continue;
        }
        const prev = byLabel.get(b.label);
        if (prev == null || chordRank(b.keys) < chordRank(prev.keys)) {
            byLabel.set(b.label, b);
        }
    }
    return [...byLabel.values()].map((b) => ({
        key: b.id,
        title: b.label,
        keys: b.keys,
        group: b.group,
        run: () => {
            b.run(ctx);
        },
    }));
}

export interface ExtraDeps {
    openNewProject: () => void;
    openNewMemory: () => void;
    setTheme: (presetId: string) => void;
}

// The cockpit actions that have no chord to derive from. PICKER_THEMES is already the dark-only subset
// the Settings picker offers, so Paper stays omitted here for the same reason it is omitted there.
export function buildExtraItems(deps: ExtraDeps): CommandItem[] {
    return [
        { key: "cmd:new-project", title: "New project", group: "Global", run: deps.openNewProject },
        { key: "cmd:new-memory", title: "New memory", group: "Memory", run: deps.openNewMemory },
        ...PICKER_THEMES.map((t) => ({
            key: `cmd:theme:${t.id}`,
            title: `Switch theme → ${t.name}`,
            group: "Appearance",
            run: () => deps.setTheme(t.id),
        })),
    ];
}
