// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure. No DOM, no atoms. Given the live KeyContext, the active registry, and the curated hint
// tables, returns the ordered chips to render. A hint shows only if at least one referenced binding
// is currently active (its when(ctx) passes) — so the footer inherits the dispatcher's posture rules
// and can never show a key that wouldn't fire. Surface hints first, then global; de-duped by id.

import type { Binding, KeyContext } from "@/app/store/keybindings/types";
import type { FooterHint } from "./footerhints";

export interface HintChip {
    glyph: string;
    label: string;
}

export function visibleHints(
    ctx: KeyContext,
    bindings: Binding[],
    surfaceHints: FooterHint[],
    globalHints: FooterHint[]
): HintChip[] {
    const activeIds = new Set(bindings.filter((b) => (b.when ? b.when(ctx) : true)).map((b) => b.id));
    const shown = new Set<string>();
    const out: HintChip[] = [];
    for (const h of [...surfaceHints, ...globalHints]) {
        if (!h.ids.some((id) => activeIds.has(id))) {
            continue;
        }
        if (h.ids.some((id) => shown.has(id))) {
            continue; // already rendered (id referenced by both tables)
        }
        h.ids.forEach((id) => shown.add(id));
        out.push({ glyph: h.glyph, label: h.label });
    }
    return out;
}
