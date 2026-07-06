// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Always-on keyboard hints footer. Three postures, all in one bar:
//  - leader active (e.g. after `g`): show the continuation list (the former WhichKeyBar).
//  - otherwise: show visibleHints(ctx) — surface hints at rest, and only editable-surviving chords
//    (dimmed) when focus is in the terminal. In-terminal falls out of the filter, not a special case.
// Mounted in layout flow (reserves ~28px), so it never overlays content.

import { deriveKeyContext } from "@/app/store/keybindings/dispatcher";
import { activeLeaderAtom } from "@/app/store/keybindings/leaderatom";
import { bindingsAtom } from "@/app/store/keybindings/store";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { visibleHints } from "./footer-visible";
import { GLOBAL_HINTS, SURFACE_HINTS } from "./footerhints";

function FooterBar({ children, dim }: { children?: React.ReactNode; dim?: boolean }) {
    return (
        <div
            className={cn(
                "flex h-7 shrink-0 items-center gap-4 border-t border-edge-strong bg-modalbg px-4",
                dim && "opacity-60"
            )}
        >
            {children}
        </div>
    );
}

function Chip({ glyph, label }: { glyph: string; label: string }) {
    return (
        <span className="flex items-center gap-1.5 text-[12px] text-secondary">
            <span className="rounded-[5px] border border-edge-mid px-[6px] py-0.5 font-mono text-[10.5px] text-primary">
                {glyph}
            </span>
            {label}
        </span>
    );
}

export function HintsFooter({ model }: { model: AgentsViewModel }) {
    const surface = useAtomValue(model.surfaceAtom);
    const leader = useAtomValue(activeLeaderAtom);
    const bindings = useAtomValue(bindingsAtom);
    // `editable` reads document.activeElement (not atom-tracked); recompute on focus moves.
    const [, recomputeOnFocus] = useState(0);
    useEffect(() => {
        const bump = () => recomputeOnFocus((n) => n + 1);
        window.addEventListener("focusin", bump);
        window.addEventListener("focusout", bump);
        return () => {
            window.removeEventListener("focusin", bump);
            window.removeEventListener("focusout", bump);
        };
    }, []);

    // Leader posture: continuations for the active leader (ported from the old WhichKeyBar).
    if (leader != null) {
        const items = bindings
            .filter((b) => b.keys.startsWith(leader + " "))
            .map((b) => ({ next: b.keys.split(" ")[1], label: b.label }));
        return (
            <FooterBar>
                <span className="shrink-0 font-mono text-[11px] text-accent-soft">{leader} →</span>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    {items.map((it) => (
                        <Chip key={it.next} glyph={it.next} label={it.label} />
                    ))}
                </div>
            </FooterBar>
        );
    }

    // Rest / in-terminal posture: both fall out of filtering hints by live when(ctx).
    const ctx = deriveKeyContext();
    const chips = visibleHints(ctx, bindings, SURFACE_HINTS[surface] ?? [], GLOBAL_HINTS);
    return (
        <FooterBar dim={ctx.editable}>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                {chips.map((c) => (
                    <Chip key={c.glyph + c.label} glyph={c.glyph} label={c.label} />
                ))}
            </div>
        </FooterBar>
    );
}
