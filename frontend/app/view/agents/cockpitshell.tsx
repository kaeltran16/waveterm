// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { atoms } from "@/app/store/global-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";
import { ActivitySurface } from "./activitysurface";
import type { AgentsViewModel } from "./agents";
import { AgentSurface } from "./agentsurface";
import { ChannelsSurface } from "./channelssurface";
import { CockpitSurface } from "./cockpitsurface";
import { FilesSurface } from "./filessurface";
import { MemorySurface } from "./memorysurface";
import { NavRail } from "./navrail";
import { PlaceholderSurface } from "./placeholdersurface";
import { SessionsSurface } from "./sessionssurface";
import { UsageSurface } from "./usagesurface";

// Clears a pending launch once it's no longer "booting": its real roster row arrived (tabId in the
// base roster) OR its tab was closed (was present in the workspace, now gone). The seen-present ref
// avoids a creation race — a tab is only pruned-on-close after we've observed it present at least once.
function usePrunePendingLaunches(model: AgentsViewModel) {
    const ws = useAtomValue(atoms.workspace);
    const base = useAtomValue(model.baseRosterAtom);
    const pending = useAtomValue(model.pendingLaunchesAtom);
    const seenRef = useRef<Set<string>>(new Set());
    useEffect(() => {
        const tabIds = new Set(ws?.tabids ?? []);
        const baseIds = new Set(base.map((a) => a.id));
        for (const p of pending) {
            if (tabIds.has(p.tabId)) {
                seenRef.current.add(p.tabId);
            }
        }
        const next = pending.filter(
            (p) => !baseIds.has(p.tabId) && !(seenRef.current.has(p.tabId) && !tabIds.has(p.tabId))
        );
        if (next.length !== pending.length) {
            globalStore.set(model.pendingLaunchesAtom, next);
        }
    }, [ws?.tabids, base, pending, model]);
}

export function CockpitShell({ model, tabId }: { model: AgentsViewModel; tabId: string }) {
    usePrunePendingLaunches(model);
    const surface = useAtomValue(model.surfaceAtom);
    return (
        <div className="flex h-full w-full">
            <NavRail model={model} />
            <div className="relative min-w-0 flex-1 bg-background">
                {/* Agent surface stays mounted so its live terminal is never torn down on tab switch
                    (destroy+remount re-fits xterm at a stale size and mangles the TUI). Hidden via
                    display:none when off-surface; the termwrap resize guard skips the 0-size fit. */}
                <div className={cn("absolute inset-0", surface === "agent" ? "" : "hidden")}>
                    <AgentSurface model={model} tabId={tabId} />
                </div>
                {surface !== "agent" ? (
                    <div className="absolute inset-0">
                        {surface === "cockpit" ? (
                            <CockpitSurface model={model} />
                        ) : surface === "channels" ? (
                            <ChannelsSurface model={model} />
                        ) : surface === "activity" ? (
                            <ActivitySurface model={model} />
                        ) : surface === "files" ? (
                            <FilesSurface model={model} />
                        ) : surface === "sessions" ? (
                            <SessionsSurface model={model} />
                        ) : surface === "usage" ? (
                            <UsageSurface model={model} />
                        ) : surface === "memory" ? (
                            <MemorySurface model={model} />
                        ) : (
                            <PlaceholderSurface surface={surface} />
                        )}
                    </div>
                ) : null}
            </div>
        </div>
    );
}
