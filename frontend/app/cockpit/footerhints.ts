// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Curated footer hints. Presentation source of truth: each chip supplies a terse glyph + label and
// references the real binding id(s) it stands for. The footer only renders a chip when at least one
// referenced binding is active for the current KeyContext (footer-visible.ts), so a chip can never
// show a key that wouldn't fire. footerhints.test.ts asserts every referenced id exists.

import type { SurfaceKey } from "@/app/store/keybindings/types";

export interface FooterHint {
    ids: string[]; // binding ids this chip represents (>=1); shown if any is active in ctx
    glyph: string; // terse key display, e.g. "↑↓", "⌃P"
    label: string; // terse action, e.g. "move", "palette"
}

// Appended to every surface; each filtered by its binding's live when(ctx).
export const GLOBAL_HINTS: FooterHint[] = [
    { ids: ["go:cockpit"], glyph: "g", label: "go" }, // g-leader nav; drops in the terminal
    { ids: ["palette"], glyph: "⌃P", label: "palette" },
    { ids: ["new-agent"], glyph: "⌃N", label: "new" },
    { ids: ["help"], glyph: "?", label: "help" }, // Shift+?; drops in the terminal
];

// Only the agent surface has surface-specific bindings today (see spec Finding). Other surfaces
// fall back to GLOBAL_HINTS only.
export const SURFACE_HINTS: Partial<Record<SurfaceKey, FooterHint[]>> = {
    agent: [
        { ids: ["agent:prev-k", "agent:next-j", "agent:prev", "agent:next"], glyph: "↑↓", label: "move" },
        { ids: ["agent:toggle-rail"], glyph: "d", label: "rail" },
        { ids: ["agent:fullscreen"], glyph: "f", label: "full" },
        { ids: ["agent:back"], glyph: "esc", label: "back" },
        { ids: ["cycle-agent-next", "cycle-agent-prev"], glyph: "^Tab", label: "cycle" },
        { ids: ["agent:return-nav"], glyph: "⇧Esc", label: "leave" }, // editable-only via its binding
    ],
};
