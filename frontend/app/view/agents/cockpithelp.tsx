// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The cockpit surface's hints bar. The keyboard-help overlay was removed: the single source of truth is
// now the shared cheat sheet (Shift+?), which documents the cockpit triage keys via buildCockpitBindings.
// The `?` chip here opens that cheat sheet too.

import { RemoteReadout } from "@/app/cockpit/remotereadout";
import { ResMonReadout } from "@/app/cockpit/resmonreadout";
import { formatChordString } from "@/util/keysym";
import { cn } from "@/util/util";
import type { AgentsViewModel } from "./agents";

// One consolidated hints bar for the cockpit surface. The triage keys are cockpit-local (handled by
// the surface's onKeyDown, not the global keybinding registry); the trailing global chips are the same
// ones the global HintsFooter shows elsewhere — folded in here so the cockpit surface renders a single
// bar (the footer suppresses its rest posture on this surface — see hints-footer.tsx).
// Before the roster is ready there is nothing to triage, so only the resource readout shows.
export function HintsBar({
    model,
    ready,
    onOpenHelp,
}: {
    model: AgentsViewModel;
    ready: boolean;
    onOpenHelp: () => void;
}) {
    // Built at render (not module-eval) so the platform-aware modifier glyphs resolve after boot.
    const HINTS: [string, string][] = [
        ["↑↓ / j k", "move"],
        ["← → / h l", "column"],
        ["⏎", "open"],
        ["1–9", "answer"],
        ["r", "reply"],
        ["t", "terminal"],
        ["b", "background"],
        ["n", "next ask"],
        ["space", "peek"],
        ["[ ]", "switch surface"],
        ["g", "go"],
        [formatChordString("Ctrl:p"), "palette"],
        [formatChordString("Ctrl:n"), "new"],
    ];
    return (
        <div
            data-cockpit-hints=""
            className="flex shrink-0 items-center gap-4 border-t border-border bg-background px-[18px] py-1.5 text-[11px] text-muted"
        >
            {/* one line: hints that don't fit wrap onto a clipped second line, so they drop whole from the end */}
            {ready ? (
                <div
                    data-cockpit-hints-row=""
                    className="flex h-5 min-w-0 flex-1 flex-wrap items-center gap-x-4 overflow-hidden"
                >
                    {HINTS.map(([k, d]) => (
                        <span key={k} className="flex h-5 shrink-0 items-center gap-1">
                            <span className="rounded-[4px] bg-edge-mid px-1.5 py-0.5 font-mono leading-4 text-secondary">
                                {k}
                            </span>
                            {d}
                        </span>
                    ))}
                </div>
            ) : null}
            {ready ? (
                <button
                    type="button"
                    data-cockpit-help=""
                    onClick={onOpenHelp}
                    className="shrink-0 cursor-pointer font-mono hover:text-secondary"
                >
                    ?
                </button>
            ) : null}
            <div className={cn("flex shrink-0 items-center gap-2", !ready && "ml-auto")}>
                <RemoteReadout model={model} />
                <ResMonReadout />
            </div>
        </div>
    );
}
