// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Presence-C escape-hatch banner on a scoped surface (roster, channels). "Show all" reveals the
// hidden rows for this surface without leaving the Space; once revealed it flips to "Re-focus". Copy is
// computed by spaceBannerText (pure).

import type { SurfaceKey } from "./agents";
import { concealSurface, revealSurface } from "./spacestore";

export function SpaceBanner({ surface, text, revealed }: { surface: SurfaceKey; text: string; revealed: boolean }) {
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
