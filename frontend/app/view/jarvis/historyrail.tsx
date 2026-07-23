// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { useAtom, useAtomValue } from "jotai";
import { conversationsAtom, activeFixtureAtom } from "./jarvisstore";
import { FIXTURE_STATES, type FixtureState } from "./jarvisfixtures";

// Left conversation-history rail. In Plan 1 rows map 1:1 to fixture conversations; selecting one sets
// the active fixture. Plan 2 replaces the id mapping with real conversation ids.
export function HistoryRail() {
    const convs = useAtomValue(conversationsAtom);
    const [active, setActive] = useAtom(activeFixtureAtom);
    const stateById = new Map<string, FixtureState>(
        FIXTURE_STATES.filter((s) => s !== "narrow").map((s) => [s, s])
    );
    return (
        <nav className="flex w-[240px] shrink-0 flex-col border-r border-border bg-surface" aria-label="Conversations">
            <div className="px-4 pb-2 pt-4 text-[11px] font-semibold uppercase tracking-wide text-muted">Conversations</div>
            <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-3">
                {convs.map((c) => {
                    const state = stateById.get(c.id);
                    const isActive = state === active;
                    return (
                        <button
                            key={c.id}
                            type="button"
                            onClick={() => state && setActive(state)}
                            className={cn(
                                "cursor-pointer truncate rounded-[8px] px-3 py-2 text-left text-[13px] text-ink-mid hover:bg-surface-hover hover:text-secondary",
                                isActive && "bg-accentbg text-accent-soft"
                            )}
                        >
                            {c.title}
                        </button>
                    );
                })}
            </div>
        </nav>
    );
}
