// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Presence-C escape-hatch banner on a scoped surface (roster, channels). "Show all" reveals the
// hidden rows for this surface without leaving the focus; once revealed it flips to "Re-focus". Copy is
// computed by focusBannerText (pure).

import type { SurfaceKey } from "./agents";
import { concealSurface, revealSurface } from "./focusstore";
import { divergenceText, type SubjectDecision } from "./focussubject";

export function FocusBanner({ surface, text, revealed }: { surface: SurfaceKey; text: string; revealed: boolean }) {
    const toggle = () => (revealed ? concealSurface(surface) : revealSurface(surface));
    return (
        <div className="mx-1 mb-2 flex items-center gap-2 rounded-[8px] border border-accent/30 bg-accent/5 px-3 py-1.5 text-[12px] text-secondary">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
            <span className="flex-1 truncate">{text}</span>
            <button
                type="button"
                onClick={toggle}
                className="shrink-0 cursor-pointer font-medium text-accent-soft hover:text-accent-100"
            >
                {revealed ? "Re-focus" : "Show all"}
            </button>
        </div>
    );
}

// The subject-posture counterpart to FocusBanner. A subject surface hides nothing, so it needs a
// rejoin rather than a reveal — and it renders nothing at all when aligned, because the app bar
// already carries the global answer and silence is the reward for being in sync.
export function DivergenceBanner({ decision, onRejoin }: { decision: SubjectDecision; onRejoin: () => void }) {
    if (decision.kind !== "diverged") {
        return null;
    }
    return (
        <div
            data-divergence-banner
            className="mx-1 mb-2 flex items-center gap-2 rounded-[8px] border border-edge-strong bg-surface px-3 py-1.5 text-[12px] text-secondary"
        >
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted" />
            <span className="flex-1 truncate">{divergenceText(decision.focus, decision.local)}</span>
            <button
                type="button"
                data-divergence-rejoin
                onClick={onRejoin}
                className="shrink-0 cursor-pointer font-medium text-accent-soft hover:text-accent-100"
            >
                Follow focus
            </button>
        </div>
    );
}
