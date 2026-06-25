// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { CockpitFocusPane } from "@/app/cockpit/focus-pane";
import { globalStore } from "@/app/store/jotaiStore";
import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";
import type { AgentsViewModel } from "./agents";
import { moveCursor, toggleSelection } from "./agentsviewmodel";
import { CockpitSurface } from "./cockpitsurface";
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
    const focusReply = useAtomValue(model.focusReplyAtom);
    const now = useAtomValue(model.nowAtom);
    const agents = useAtomValue(model.agentsAtom);
    const order = useAtomValue(model.orderAtom);
    const answerSel = useAtomValue(model.answerSelAtom);
    const answerTab = useAtomValue(model.answerTabAtom);
    const sentIds = useAtomValue(model.sentIdsAtom);
    const wrapRef = useRef<HTMLDivElement>(null);
    const agent = focusId != null ? agents.find((a) => a.id === focusId) : undefined;
    const showFocus = !terminalTarget && agent != null;
    // pull keyboard focus to the wrapper so the focus-view keys (esc/←→/t) work without a click
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
    const i = order.indexOf(agent.id);
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
        <div ref={wrapRef} tabIndex={0} onKeyDown={onKeyDown} className="h-full w-full outline-none">
            <FocusView
                agent={agent}
                now={now}
                autofocusComposer={focusReply}
                hasPrev={i > 0}
                hasNext={i >= 0 && i < order.length - 1}
                selections={answerSel[agent.id] ?? {}}
                sent={sentIds.has(agent.id)}
                activeQuestion={answerTab[agent.id] ?? 0}
                onBack={() => globalStore.set(model.surfaceAtom, "cockpit")}
                onPrev={() => step(-1)}
                onNext={() => step(1)}
                onOpenTerminal={() => model.openTerminal(agent.id)}
                onToggleAnswer={(qi, oi) => {
                    const multi = agent.ask?.questions?.[qi]?.multiSelect ?? false;
                    globalStore.set(model.answerSelAtom, {
                        ...answerSel,
                        [agent.id]: toggleSelection(answerSel[agent.id] ?? {}, qi, oi, multi),
                    });
                }}
                onSubmitAnswer={() => model.submitAnswer(agent.id)}
                onSelectQuestion={(qi) => globalStore.set(model.answerTabAtom, { ...answerTab, [agent.id]: qi })}
            />
        </div>
    );
}

export function CockpitShell({ model, tabId }: { model: AgentsViewModel; tabId: string }) {
    const surface = useAtomValue(model.surfaceAtom);
    return (
        <div className="flex h-full w-full">
            <NavRail model={model} />
            <div className="relative min-w-0 flex-1">
                {surface === "cockpit" ? (
                    <CockpitSurface model={model} />
                ) : surface === "agent" ? (
                    <AgentSurfaceInterim model={model} tabId={tabId} />
                ) : (
                    <PlaceholderSurface surface={surface} />
                )}
            </div>
        </div>
    );
}
