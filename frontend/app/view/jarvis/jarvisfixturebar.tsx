// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// DEV-ONLY. A row of buttons that switch the active Jarvis fixture (and toggle the grounding rail), so a
// human and the CDP verify:ui harness can render every surface state without a backend. Compiled out of
// production builds (import.meta.env.DEV is statically false there). Remove when Plan 2 lands real data.

import { cn } from "@/util/util";
import { useAtom, useSetAtom } from "jotai";
import { activeFixtureAtom, groundingRailOpenAtom } from "./jarvisstore";
import { FIXTURE_STATES } from "./jarvisfixtures";

export function JarvisFixtureBar() {
    if (!import.meta.env.DEV) return null;
    const [active, setActive] = useAtom(activeFixtureAtom);
    const setRailOpen = useSetAtom(groundingRailOpenAtom);
    return (
        <div
            data-testid="jarvis-fixture-bar"
            className="flex flex-wrap items-center gap-1 border-b border-dashed border-edge-mid bg-surface px-4 py-1.5"
        >
            <span className="mr-1 text-[10px] font-semibold uppercase tracking-wide text-muted">fixture</span>
            {FIXTURE_STATES.map((s) => (
                <button
                    key={s}
                    type="button"
                    data-fixture={s}
                    onClick={() => {
                        setActive(s);
                        setRailOpen(s !== "narrow"); // narrow == rail collapsed
                    }}
                    className={cn(
                        "cursor-pointer rounded-[6px] px-2 py-0.5 text-[11px]",
                        active === s ? "bg-accentbg text-accent-soft" : "text-ink-mid hover:bg-surface-hover"
                    )}
                >
                    {s}
                </button>
            ))}
        </div>
    );
}
