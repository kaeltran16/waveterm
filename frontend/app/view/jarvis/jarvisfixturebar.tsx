// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// DEV-ONLY. A row of buttons that switch the active Jarvis fixture (and toggle the grounding rail), so a
// human and the CDP verify:ui harness can render every surface state without a backend. Compiled out of
// production builds (import.meta.env.DEV is statically false there). Remove when Plan 2 lands real data.

import { cn } from "@/util/util";
import { globalStore } from "@/app/store/jotaiStore";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { activeFixtureAtom, stageRailOpenAtom } from "./jarvisstore";
import { FIXTURE_STATES } from "./jarvisfixtures";
import { BRIEFING_FIXTURES, setBriefingAskFixtureForDev, type BriefingFixtureName } from "./briefingfixtures";
import { briefingFixtureAtom } from "./briefingstore";
import { selectSubject } from "./jarvissubjectstore";

export function JarvisFixtureBar() {
    if (!import.meta.env.DEV) return null;
    const [active, setActive] = useAtom(activeFixtureAtom);
    const setRailOpen = useSetAtom(stageRailOpenAtom);
    const briefingActive = useAtomValue(briefingFixtureAtom);
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
                        // the Stage draws a thread only for a conversation subject, so selecting the
                        // fixture as one is what makes the state visible at all.
                        selectSubject({ kind: "conversation", id: s });
                    }}
                    className={cn(
                        "cursor-pointer rounded-[6px] px-2 py-0.5 text-[11px]",
                        active === s ? "bg-accentbg text-accent-soft" : "text-ink-mid hover:bg-surface-hover"
                    )}
                >
                    {s}
                </button>
            ))}
            <div data-testid="jarvis-briefing-fixture-bar" className="flex flex-wrap items-center gap-1">
                <span className="mr-1 text-[10px] font-semibold uppercase tracking-wide text-muted">briefing</span>
                {(Object.keys(BRIEFING_FIXTURES) as BriefingFixtureName[]).map((s) => (
                    <button
                        key={s}
                        type="button"
                        data-briefing-fixture={s}
                        onClick={() => {
                            globalStore.set(briefingFixtureAtom, s);
                            selectSubject({ kind: "briefing", id: "all" });
                        }}
                        className={cn(
                            "cursor-pointer rounded-[6px] px-2 py-0.5 text-[11px]",
                            briefingActive === s ? "bg-accentbg text-accent-soft" : "text-ink-mid hover:bg-surface-hover"
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
                        selectSubject({ kind: "briefing", id: "all" });
                    }}
                    className="cursor-pointer rounded-[6px] px-2 py-0.5 text-[11px] text-ink-mid hover:bg-surface-hover"
                >
                    ask
                </button>
            </div>
        </div>
    );
}
