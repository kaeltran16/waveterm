// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// DEV-ONLY. A row of buttons that switch the active Briefing fixture, so a human and the CDP verify:ui
// harness can render every surface state without a backend. Compiled out of production builds
// (import.meta.env.DEV is statically false there).

import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { BRIEFING_FIXTURES, setBriefingAskFixtureForDev, type BriefingFixtureName } from "./briefingfixtures";
import { briefingFixtureAtom } from "./briefingstore";

export function JarvisFixtureBar() {
    if (!import.meta.env.DEV) return null;
    const briefingActive = useAtomValue(briefingFixtureAtom);
    return (
        <div
            data-testid="jarvis-fixture-bar"
            className="flex flex-wrap items-center gap-1 border-b border-dashed border-edge-mid bg-surface px-4 py-1.5"
        >
            <div data-testid="jarvis-briefing-fixture-bar" className="flex flex-wrap items-center gap-1">
                <span className="mr-1 text-[10px] font-semibold uppercase tracking-wide text-muted">briefing</span>
                {(Object.keys(BRIEFING_FIXTURES) as BriefingFixtureName[]).map((s) => (
                    <button
                        key={s}
                        type="button"
                        data-briefing-fixture={s}
                        onClick={() => {
                            globalStore.set(briefingFixtureAtom, s);
                        }}
                        className={cn(
                            "cursor-pointer rounded-[6px] px-2 py-0.5 text-[11px]",
                            briefingActive === s
                                ? "bg-accentbg text-accent-soft"
                                : "text-ink-mid hover:bg-surface-hover"
                        )}
                    >
                        {s}
                    </button>
                ))}
                <button
                    type="button"
                    data-briefing-fixture="ask"
                    onClick={() => {
                        // the answer needs a snapshot to hang on; the ask fixture seeds the normal state
                        // so the ask section renders beside the answer.
                        globalStore.set(briefingFixtureAtom, "normal");
                        setBriefingAskFixtureForDev();
                    }}
                    className="cursor-pointer rounded-[6px] px-2 py-0.5 text-[11px] text-ink-mid hover:bg-surface-hover"
                >
                    ask
                </button>
            </div>
        </div>
    );
}
