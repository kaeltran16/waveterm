// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Keeps the live terminal's palette in step with the active cockpit theme. The terminal is cockpit
// chrome, not a guest window: its colors derive from the same ThemePalette that paints every other
// surface, so switching presets re-skins the TUI with no remount.

import type { TermWrap } from "@/app/view/term/termwrap";
import { activePalette, deriveTermTheme } from "@/app/view/agents/themes";
import { themeOverridesAtom, themePresetAtom } from "@/app/view/agents/themestore";
import { useAtomValue } from "jotai";
import { useEffect, useMemo } from "react";

interface TermThemeProps {
    termRef: React.RefObject<TermWrap>;
}

const TermThemeUpdater = ({ termRef }: TermThemeProps) => {
    const preset = useAtomValue(themePresetAtom);
    const overrides = useAtomValue(themeOverridesAtom);
    // memoized so the effect re-runs on a real theme change, not on every parent render
    const theme = useMemo(() => deriveTermTheme(activePalette(preset), overrides), [preset, overrides]);
    useEffect(() => {
        if (termRef.current?.terminal) {
            termRef.current.terminal.options.theme = theme;
        }
    }, [theme, termRef]);
    return null;
};

export { TermThemeUpdater };
