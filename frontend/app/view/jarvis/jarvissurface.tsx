// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Jarvis cockpit surface: three regions (history rail · conversation · grounding rail) with a mode
// switch (Recall / Fleet). Fleet mode is a placeholder in Plan 1 (migrated in Plan 3). All state lives
// in jarvisstore atoms because this surface unmounts on nav-switch.

import { SurfaceHeader } from "@/app/view/agents/surfacescaffold";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { cn } from "@/util/util";
import { useAtom, useAtomValue } from "jotai";
import { useEffect } from "react";
import { Composer } from "./composer";
import { ConversationView } from "./conversationview";
import { FleetMode } from "./fleetmode";
import { GroundingRail } from "./groundingrail";
import { HistoryRail } from "./historyrail";
import { JarvisFixtureBar } from "./jarvisfixturebar";
import { activeConversationAtom, jarvisModeAtom, loadJarvisConversations } from "./jarvisstore";

export function JarvisSurface({ model }: { model: AgentsViewModel }) {
    const [mode, setMode] = useAtom(jarvisModeAtom);
    const conv = useAtomValue(activeConversationAtom);
    useEffect(() => loadJarvisConversations(), []);
    return (
        <div className="flex h-full w-full flex-col bg-background">
            <SurfaceHeader
                title="Jarvis"
                actions={
                    <div className="flex items-center gap-1 rounded-[9px] border border-border bg-surface p-0.5">
                        {(["recall", "fleet"] as const).map((m) => (
                            <button
                                key={m}
                                type="button"
                                onClick={() => setMode(m)}
                                className={cn(
                                    "cursor-pointer rounded-[7px] px-3 py-1 text-[12.5px] font-semibold capitalize",
                                    mode === m ? "bg-accentbg text-accent-soft" : "text-ink-mid hover:text-secondary"
                                )}
                            >
                                {m}
                            </button>
                        ))}
                    </div>
                }
            />
            <JarvisFixtureBar />
            {mode === "fleet" ? (
                <FleetMode model={model} />
            ) : (
                <div className="flex min-h-0 flex-1">
                    <HistoryRail />
                    <div className="flex min-w-0 flex-1 flex-col">
                        <div className="min-h-0 flex-1 overflow-y-auto">
                            <ConversationView conversation={conv} model={model} />
                        </div>
                        <Composer />
                    </div>
                    <GroundingRail conversation={conv} model={model} />
                </div>
            )}
        </div>
    );
}
