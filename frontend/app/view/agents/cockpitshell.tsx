// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { useAtomValue } from "jotai";
import { ActivitySurface } from "./activitysurface";
import type { AgentsViewModel } from "./agents";
import { AgentSurface } from "./agentsurface";
import { CockpitSurface } from "./cockpitsurface";
import { FilesSurface } from "./filessurface";
import { NavRail } from "./navrail";
import { PlaceholderSurface } from "./placeholdersurface";

export function CockpitShell({ model, tabId }: { model: AgentsViewModel; tabId: string }) {
    const surface = useAtomValue(model.surfaceAtom);
    return (
        <div className="flex h-full w-full">
            <NavRail model={model} />
            <div className="relative min-w-0 flex-1">
                {surface === "cockpit" ? (
                    <CockpitSurface model={model} />
                ) : surface === "agent" ? (
                    <AgentSurface model={model} tabId={tabId} />
                ) : surface === "activity" ? (
                    <ActivitySurface model={model} />
                ) : surface === "files" ? (
                    <FilesSurface model={model} />
                ) : (
                    <PlaceholderSurface surface={surface} />
                )}
            </div>
        </div>
    );
}
