// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The cockpit surface's hints bar and keyboard-help overlay. Extracted from cockpitsurface.tsx.

// One consolidated hints bar for the cockpit surface. The triage keys are cockpit-local (handled by
// the surface's onKeyDown, not the global keybinding registry); the trailing global chips are the same
// ones the global HintsFooter shows elsewhere — folded in here so the cockpit surface renders a single
// bar (the footer suppresses its rest posture on this surface — see hints-footer.tsx).
const HINTS: [string, string][] = [
    ["↑↓ / j k", "move"],
    ["⏎", "open"],
    ["esc", "back"],
    ["1–9", "answer"],
    ["r", "reply"],
    ["t", "terminal"],
    ["b", "background"],
    ["n", "next ask"],
    ["[ ]", "switch surface"],
    ["g", "go"],
    ["⌃P", "palette"],
    ["⌃N", "new"],
];

export function HintsBar({ onOpenHelp }: { onOpenHelp: () => void }) {
    return (
        <div className="flex shrink-0 items-center gap-4 border-t border-border bg-background px-[18px] py-1.5 text-[11px] text-muted">
            {HINTS.map(([k, d]) => (
                <span key={k} className="flex items-center gap-1">
                    <span className="rounded-[4px] bg-white/[0.06] px-1.5 py-0.5 font-mono text-secondary">
                        {k}
                    </span>
                    {d}
                </span>
            ))}
            <button
                type="button"
                onClick={onOpenHelp}
                className="ml-auto cursor-pointer font-mono hover:text-secondary"
            >
                ?
            </button>
        </div>
    );
}

export function HelpOverlay({ onClose }: { onClose: () => void }) {
    const rows: [string, string][] = [
        ["↑ / k", "move cursor up"],
        ["↓ / j", "move cursor down"],
        ["n", "jump to next ask"],
        ["1–9", "select an answer option"],
        ["← → / h l", "switch question (multi-question asks)"],
        ["↵ (Enter)", "confirm selected answer, else open focus view"],
        ["r", "reply inline to the highlighted agent"],
        ["t", "open the highlighted agent's terminal tab"],
        ["b", "background the highlighted agent (keeps running)"],
        ["esc", "leave focus view / blur reply box / close this"],
        ["?", "toggle this help"],
    ];
    return (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
            <div
                className="min-w-[320px] rounded-[10px] border border-border bg-background p-4 shadow-xl"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="mb-2 text-[13px] font-semibold text-primary">Keyboard</div>
                {rows.map(([k, d]) => (
                    <div key={k} className="flex items-center justify-between gap-6 py-1 text-[12px]">
                        <span className="font-mono text-secondary">{k}</span>
                        <span className="text-muted">{d}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}
