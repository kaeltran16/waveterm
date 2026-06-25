// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Agent (Focus) surface (Phase 1b): a 3-pane focus over the existing agents/* data. When a
// terminal target is set ("Open terminal"), the whole surface is the term block (CockpitFocusPane),
// matching the interim. With no focus it falls back to the Cockpit surface. Routing is shell-side
// (this file is imported only by cockpitshell.tsx) so agents.tsx never imports CockpitFocusPane,
// keeping the agents -> focus-pane -> blockregistry -> agents eval cycle broken.

import { CockpitFocusPane } from "@/app/cockpit/focus-pane";
import { globalStore } from "@/app/store/jotaiStore";
import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";
import type { AgentsViewModel } from "./agents";
import { AgentDetailsRail } from "./agentdetailsrail";
import { AgentTranscript } from "./agenttranscript";
import { AgentTree } from "./agenttree";
import { moveCursor } from "./agentsviewmodel";
import { CockpitSurface } from "./cockpitsurface";

export function AgentSurface({ model, tabId }: { model: AgentsViewModel; tabId: string }) {
    const terminalTarget = useAtomValue(model.terminalTargetAtom);
    const focusId = useAtomValue(model.focusIdAtom);
    const agents = useAtomValue(model.agentsAtom);
    const order = useAtomValue(model.orderAtom);
    const wrapRef = useRef<HTMLDivElement>(null);
    const agent = focusId != null ? agents.find((a) => a.id === focusId) : undefined;
    const showFocus = !terminalTarget && agent != null;

    // pull keyboard focus to the wrapper so esc/←→/t work without a click (mirrors the interim)
    useEffect(() => {
        if (showFocus) {
            wrapRef.current?.focus();
        }
    }, [showFocus, agent?.id]);

    if (terminalTarget) {
        return <CockpitFocusPane blockId={terminalTarget} tabId={tabId} />;
    }
    if (!agent) {
        return <CockpitSurface model={model} />;
    }

    const step = (delta: number) => {
        globalStore.set(model.focusIdAtom, moveCursor(order, agent.id, delta) ?? agent.id);
        globalStore.set(model.focusReplyAtom, false);
    };
    const onKeyDown = (e: React.KeyboardEvent) => {
        const el = e.target as HTMLElement;
        if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) {
            return;
        }
        if (e.key === "Escape") {
            e.preventDefault();
            globalStore.set(model.surfaceAtom, "cockpit");
        } else if (e.key === "ArrowLeft") {
            e.preventDefault();
            step(-1);
        } else if (e.key === "ArrowRight") {
            e.preventDefault();
            step(1);
        } else if (e.key === "t") {
            e.preventDefault();
            model.openTerminal(agent.id);
        }
    };

    return (
        <div ref={wrapRef} tabIndex={0} onKeyDown={onKeyDown} className="flex h-full w-full outline-none">
            <AgentTree model={model} />
            <AgentTranscript model={model} agent={agent} />
            <AgentDetailsRail model={model} agent={agent} />
        </div>
    );
}
