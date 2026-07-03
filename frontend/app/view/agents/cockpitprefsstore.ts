// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Cockpit-native preferences persisted to localStorage (the atomWithStorage convention established
// by railstore.ts). The Settings surface edits these; the cockpit reads them on boot.

import { atomWithStorage } from "jotai/utils";
import { SURFACE_ORDER, type SurfaceKey } from "./agents";

// Which surface opens on launch. Defaults to the cockpit overview (matches prior hardcoded behavior).
export const startupSurfaceAtom = atomWithStorage<SurfaceKey>("cockpit.startup.surface", "cockpit");

// Surfaces offered as a startup choice: the numbered workflow set minus "agent" (it needs a live
// agent to be meaningful). "settings" is naturally absent — it was never in SURFACE_ORDER.
export function startupSurfaceOptions(): SurfaceKey[] {
    return SURFACE_ORDER.filter((k) => k !== "agent");
}

const FONT_SIZE_MIN = 6;
const FONT_SIZE_MAX = 48;

// Parse a font-size input to an integer within range, or null when the input isn't a usable number
// (so the caller can skip the config write instead of persisting garbage).
export function coerceFontSize(raw: string): number | null {
    const n = Number(raw);
    if (raw.trim() === "" || Number.isNaN(n)) {
        return null;
    }
    return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.floor(n)));
}

const SCROLLBACK_MIN = 0;
const SCROLLBACK_MAX = 100000;

// Parse a scrollback input to an integer within range, or null when unusable (so the caller can skip
// the config write instead of persisting garbage). Mirrors coerceFontSize.
export function coerceScrollback(raw: string): number | null {
    const n = Number(raw);
    if (raw.trim() === "" || Number.isNaN(n)) {
        return null;
    }
    return Math.min(SCROLLBACK_MAX, Math.max(SCROLLBACK_MIN, Math.floor(n)));
}

// Clamp a transparency value to [0, 1]. Non-finite input coerces to 0 (fully opaque).
export function coerceTransparency(n: number): number {
    if (!Number.isFinite(n)) {
        return 0;
    }
    return Math.min(1, Math.max(0, n));
}
