// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Font selection state, persisted to localStorage (the atomWithStorage convention from themestore.ts).
// Pure-frontend appearance -> no wconfig / no task generate. Applied by useApplyCockpitFonts, mounted
// alongside useApplyCockpitTheme in cockpit-root.

import { useAtomValue } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { useLayoutEffect } from "react";

import { applyFontVars, DEFAULT_MONO, DEFAULT_SANS } from "./fonts";

export const fontSansAtom = atomWithStorage<string>("cockpit.font.sans", DEFAULT_SANS);
export const fontMonoAtom = atomWithStorage<string>("cockpit.font.mono", DEFAULT_MONO);

// Writes the active fonts' CSS vars to <html> before paint. atomWithStorage hydrates synchronously
// from localStorage, so a non-default font applies without a flash of the default.
export function useApplyCockpitFonts(): void {
    const sansId = useAtomValue(fontSansAtom);
    const monoId = useAtomValue(fontMonoAtom);
    useLayoutEffect(() => {
        applyFontVars(document.documentElement, sansId, monoId);
    }, [sansId, monoId]);
}
