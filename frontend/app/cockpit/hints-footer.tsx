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
import { watchFocusedCanvas, whenVersionAtom } from "@/app/store/keybindings/whenstate";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { formatChordString } from "@/util/keysym";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { ctrlHeldAtom } from "./ctrlheld";
import { visibleHints } from "./footer-visible";
import { GLOBAL_HINTS, SURFACE_HINTS } from "./footerhints";
import { RemoteReadout } from "./remotereadout";
import { ResMonReadout } from "./resmonreadout";

// the readouts close every posture on the right; they are data, not key hints, so they never dim with the chips
function FooterBar({
    model,
    children,
    readout = true,
}: {
    model: AgentsViewModel;
    children?: React.ReactNode;
    readout?: boolean;
}) {
    return (
        <div
            data-hints-footer=""
            className="flex h-7 shrink-0 items-center gap-4 border-t border-edge-strong bg-modalbg px-4"
        >
            {children}
            {readout ? (
                <div className="ml-auto flex shrink-0 items-center gap-2">
                    <RemoteReadout model={model} />
                    <ResMonReadout />
                </div>
            ) : null}
        </div>
    );
}

// every chip is one bar-tall line with no row gap, so a chip that does not fit wraps to a second line the
// row's own height clips: the tail (lowest priority, see visibleHints) drops whole instead of spilling out
function ChipRow({ dim, children }: { dim?: boolean; children: React.ReactNode }) {
    return (
        <div
            data-footer-chips=""
            className={cn(
                "flex h-full min-w-0 flex-1 flex-wrap content-start items-center gap-x-4 self-stretch overflow-hidden",
                dim && "opacity-60"
            )}
        >
            {children}
        </div>
    );
}

// lit: the chip's key is held right now (Ctrl for peek), so it reads as armed
function Chip({ glyph, label, lit }: { glyph: string; label: string; lit?: boolean }) {
    return (
        <span
            className={cn(
                "flex h-full shrink-0 items-center gap-1.5 whitespace-nowrap text-[12px]",
                lit ? "text-accent-soft" : "text-secondary"
            )}
        >
            <span
                className={cn(
                    "rounded-[5px] border px-[6px] py-0.5 font-mono text-[10.5px] text-primary",
                    lit ? "border-accent bg-accentbg" : "border-edge-mid"
                )}
            >
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
    const ctrlHeld = useAtomValue(ctrlHeldAtom);
    // subscribe-only: some when(ctx) predicates read state ctx doesn't carry (see whenstate.ts), so
    // this is what tells React to recompute chips below when that state changes.
    useAtomValue(whenVersionAtom);
    useEffect(() => watchFocusedCanvas(model), [model]);
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
        // the cockpit's hints bar always carries a readout, so on that surface the footer yields its own
        return (
            <FooterBar model={model} readout={surface !== "cockpit"}>
                <span className="shrink-0 font-mono text-[11px] text-accent-soft">{leader} →</span>
                <ChipRow>
                    {items.map((it) => (
                        <Chip key={it.next} glyph={it.next} label={it.label} />
                    ))}
                </ChipRow>
            </FooterBar>
        );
    }

    // The cockpit surface renders its own consolidated hints bar (cockpitsurface.tsx HINTS), so the
    // footer's rest posture would be a redundant second row here. Leader posture above still shows
    // (the which-key bar must appear on every surface).
    if (surface === "cockpit") {
        return null;
    }

    // Rest / in-terminal posture: both fall out of filtering hints by live when(ctx).
    const ctx = deriveKeyContext();
    const chips = visibleHints(ctx, bindings, SURFACE_HINTS[surface] ?? [], GLOBAL_HINTS);
    return (
        <FooterBar model={model}>
            <ChipRow dim={ctx.editable}>
                {chips.map((c) => (
                    <Chip
                        key={(c.glyph ?? c.keys) + c.label}
                        glyph={c.glyph ?? formatChordString(c.keys!)}
                        label={c.label}
                        lit={c.ctrlLit && ctrlHeld}
                    />
                ))}
            </ChipRow>
        </FooterBar>
    );
}
