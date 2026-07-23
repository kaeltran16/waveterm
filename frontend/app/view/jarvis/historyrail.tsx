// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { activeConversationIdAtom, activeFixtureAtom, conversationsAtom, conversationsByIdAtom, selectConversation } from "./jarvisstore";

// Left conversation-history rail. Real conversations select by id; dev-fixture rows fall back to the fixture
// selector (see selectConversation). A row is active when it is the active real conversation, or — when no
// real conversation is active — the selected fixture.
export function HistoryRail() {
    const convs = useAtomValue(conversationsAtom);
    const activeConvId = useAtomValue(activeConversationIdAtom);
    const activeFixture = useAtomValue(activeFixtureAtom);
    const byId = useAtomValue(conversationsByIdAtom);
    return (
        <nav className="flex w-[240px] shrink-0 flex-col border-r border-border bg-surface" aria-label="Conversations">
            <div className="px-4 pb-2 pt-4 text-[11px] font-semibold uppercase tracking-wide text-muted">Conversations</div>
            <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-3">
                {convs.map((c) => {
                    const isReal = byId[c.id] != null;
                    const isActive = isReal ? c.id === activeConvId : activeConvId == null && c.id === activeFixture;
                    return (
                        <button
                            key={c.id}
                            type="button"
                            onClick={() => selectConversation(c.id)}
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
