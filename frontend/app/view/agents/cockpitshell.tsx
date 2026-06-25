// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { CockpitFocusPane } from "@/app/cockpit/focus-pane";
import { globalStore } from "@/app/store/jotaiStore";
import { useAtomValue } from "jotai";
import { AgentsView, AgentsViewModel } from "./agents";
import { FocusView } from "./focusview";
import { NavRail } from "./navrail";
import { PlaceholderSurface } from "./placeholdersurface";

// Interim Agent surface (1a): the on-demand terminal (CockpitFocusPane) takes precedence — openTerminal
// and "+ New Agent" route here with a term blockId, and rendering the block starts its controller. With
// no terminal target it shows the existing FocusView for focusIdAtom, falling back to the cockpit body.
// 1b replaces this with the 3-pane focus surface; routing is shell-side to keep agents.tsx free of the
// focus-pane import (which would close an agents -> focus-pane -> blockregistry -> agents cycle).
function AgentSurfaceInterim({ model, tabId }: { model: AgentsViewModel; tabId: string }) {
    const terminalTarget = useAtomValue(model.terminalTargetAtom);
    const focusId = useAtomValue(model.focusIdAtom);
    const now = useAtomValue(model.nowAtom);
    const agents = useAtomValue(model.agentsAtom);
    if (terminalTarget) {
        return <CockpitFocusPane blockId={terminalTarget} tabId={tabId} />;
    }
    const agent = focusId != null ? agents.find((a) => a.id === focusId) : undefined;
    if (!agent) {
        return <AgentsView model={model} />;
    }
    return (
        <FocusView
            agent={agent}
            now={now}
            autofocusComposer={false}
            hasPrev={false}
            hasNext={false}
            selections={{}}
            sent={false}
            activeQuestion={0}
            onBack={() => globalStore.set(model.surfaceAtom, "cockpit")}
            onPrev={() => {}}
            onNext={() => {}}
            onOpenTerminal={() => model.openTerminal(agent.id)}
            onToggleAnswer={() => {}}
            onSubmitAnswer={() => {}}
            onSelectQuestion={() => {}}
        />
    );
}

export function CockpitShell({ model, tabId }: { model: AgentsViewModel; tabId: string }) {
    const surface = useAtomValue(model.surfaceAtom);
    return (
        <div className="flex h-full w-full">
            <NavRail model={model} />
            <div className="relative min-w-0 flex-1">
                {surface === "cockpit" ? (
                    <AgentsView model={model} />
                ) : surface === "agent" ? (
                    <AgentSurfaceInterim model={model} tabId={tabId} />
                ) : (
                    <PlaceholderSurface surface={surface} />
                )}
            </div>
        </div>
    );
}
