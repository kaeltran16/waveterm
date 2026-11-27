// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Cockpit's zoomed view: one session at full size inside the Cockpit, its Rendered transcript and composer in the
// middle, its own workspace pane on the right, and the grid's other sessions as a filmstrip to hop between. Its keys
// (Esc, [ ], d, Enter) are bindings.ts' cockpit:zoom-*; which tabs a zoom adds is cockpitzoommodel.ts'.

import { indicatorSlide } from "@/app/element/motiontokens";
import { ViewSwap } from "@/app/element/viewswap";
import { useDimensionsWithCallbackRef } from "@/app/hook/useDimensions";
import { globalStore } from "@/app/store/jotaiStore";
import { effortDetailAtom, loadEffortDetail } from "@/app/view/jarvis/effortstore";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { ChevronLeft } from "lucide-react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { useEffect, useMemo } from "react";
import type { AgentsViewModel } from "./agents";
import { displayAgeMs, formatAgeShort, projectOf, type AgentVM } from "./agentsviewmodel";
import { lastLine, lastTurnEntries, type CockpitSession } from "./cockpitsessionmodel";
import { cockpitViewAtomFor, cockpitZoomAtom, runWaitAtom } from "./cockpitsessionstore";
import { StateChip, THUMB_ROWS } from "./cockpitthumbnail";
import { zoomTabs, type ZoomTabs } from "./cockpitzoommodel";
import { entriesAtomFor } from "./livetranscriptatoms";
import { canRender } from "./renderedmode";
import { RenderedView } from "./renderedview";
import { isEndedWorkerId } from "./runlineage";
import { paneShape, tabKey } from "./workspacemodel";
import { WorkspacePane } from "./workspacepane";
import { activateWorkspaceTab, pushWorkspaceTab, updateWorkspaceTab, workspaceAtom } from "./workspacestore";

const KBD = "rounded-[4px] border border-edge-strong px-[5px] font-mono text-[10.5px] text-ink-mid";

export function CockpitZoom({
    model,
    agentId,
    onBack,
}: {
    model: AgentsViewModel;
    agentId: string;
    onBack: () => void;
}) {
    const view = useAtomValue(cockpitViewAtomFor(model));
    const session = [...view.sessions, ...view.idle].find((s) => s.agent.id === agentId);
    useZoomTabs(model, agentId);
    if (session == null) {
        return null;
    }
    return (
        <div data-cockpit-zoom={agentId} className="flex h-full min-h-0 w-full flex-col bg-background">
            <ZoomHeader model={model} session={session} onBack={onBack} />
            <ViewSwap swapKey={agentId} className="flex min-h-0 flex-1">
                <ZoomBody model={model} agent={session.agent} />
            </ViewSwap>
            <Filmstrip sessions={view.sessions} current={agentId} />
        </div>
    );
}

// On zoom, and on each hop: the session's runs and initiatives join its pane and the default run shows. Applied at once
// from what is cached, then once more after the initiatives load, so a chunk unknown at first is still marked; the
// second pass never moves the shown tab.
function useZoomTabs(model: AgentsViewModel, agentId: string): void {
    useEffect(() => {
        let live = true;
        const decide = (): ZoomTabs | null => {
            const view = globalStore.get(cockpitViewAtomFor(model));
            const session = [...view.sessions, ...view.idle].find((s) => s.agent.id === agentId);
            if (session == null) {
                return null;
            }
            const waits = Object.fromEntries(session.runs.map((r) => [r.id, globalStore.get(runWaitAtom(r.id))]));
            return zoomTabs(session, waits, globalStore.get(effortDetailAtom), globalStore.get(workspaceAtom(agentId)));
        };
        const first = decide();
        if (first == null) {
            return;
        }
        applyZoomTabs(agentId, first, true);
        const efforts = [...new Set(first.tabs.flatMap((t) => (t.kind === "initiative" ? [t.effortId] : [])))];
        void Promise.allSettled(efforts.map((id) => loadEffortDetail(`effort:${id}`))).then(() => {
            const again = live ? decide() : null;
            if (again != null) {
                applyZoomTabs(agentId, again, false);
            }
        });
        return () => {
            live = false;
        };
    }, [model, agentId]);
}

function applyZoomTabs(agentId: string, z: ZoomTabs, activate: boolean): void {
    for (const t of z.tabs) {
        pushWorkspaceTab(agentId, t);
        if (t.kind === "initiative" && t.open !== undefined) {
            updateWorkspaceTab(agentId, tabKey(t), { open: t.open });
        }
    }
    if (activate && z.activate != null) {
        activateWorkspaceTab(agentId, z.activate);
    }
}

function ZoomHeader({
    model,
    session,
    onBack,
}: {
    model: AgentsViewModel;
    session: CockpitSession;
    onBack: () => void;
}) {
    const now = useAtomValue(model.nowAtom);
    const agent = session.agent;
    const project = projectOf(agent);
    return (
        <div
            data-cockpit-zoom-state={session.state}
            className="flex h-[50px] flex-none items-center gap-[10px] border-b border-border px-[18px]"
        >
            <button
                type="button"
                data-cockpit-zoom-back
                onClick={onBack}
                className="inline-flex h-[28px] cursor-pointer items-center gap-[7px] rounded-[6px] border border-edge-mid bg-surface-raised px-[10px] text-[12.5px] text-secondary hover:bg-surface-hover"
            >
                <ChevronLeft size={13} strokeWidth={2} aria-hidden />
                All sessions
                <span className={KBD}>Esc</span>
            </button>
            <span className="h-[20px] w-px bg-edge-mid" aria-hidden />
            <span className="truncate whitespace-nowrap text-[15px] font-semibold text-primary">{agent.name}</span>
            {project ? <span className="whitespace-nowrap text-[12px] text-muted">{project}</span> : null}
            <StateChip state={session.state} />
            <span className="font-mono text-[11px] text-muted">{formatAgeShort(displayAgeMs(agent, now))}</span>
            <span className="flex-1" />
            <span className="inline-flex items-center gap-[6px] whitespace-nowrap text-[12px] text-muted">
                <span className={KBD}>Enter</span> opens it on the Agent surface
            </span>
        </div>
    );
}

// the transcript and composer in the middle, the session's own pane on the right while it has tabs
function ZoomBody({ model, agent }: { model: AgentsViewModel; agent: AgentVM }) {
    const ws = useAtomValue(workspaceAtom(agent.id));
    const shape = paneShape(ws);
    const [rowRef, , rowRect] = useDimensionsWithCallbackRef<HTMLDivElement>();
    const renders = canRender(agent, { ended: isEndedWorkerId(agent.id), stage: false });
    return (
        <div ref={rowRef} className="relative flex min-w-0 flex-1">
            <div
                data-cockpit-zoom-center
                className={cn("flex min-w-0 flex-col", shape === "expanded" ? "invisible absolute inset-0" : "flex-1")}
            >
                {renders ? (
                    <RenderedView key={agent.id} model={model} agent={agent} />
                ) : (
                    <div className="flex flex-1 items-center justify-center text-[13px] text-muted">
                        This session has no Rendered view. Enter opens it on the Agent surface.
                    </div>
                )}
            </div>
            <AnimatePresence>
                {shape !== "none" ? (
                    <WorkspacePane
                        key="workspace"
                        model={model}
                        agent={agent}
                        ws={ws}
                        availablePx={rowRect?.width ?? null}
                    />
                ) : null}
            </AnimatePresence>
        </div>
    );
}

// the grid's sessions, the current one ringed; a click hops to another (the ring slides, moment 9, and the view swaps)
function Filmstrip({ sessions, current }: { sessions: CockpitSession[]; current: string }) {
    return (
        <div
            data-cockpit-filmstrip
            className="flex h-[76px] flex-none gap-[10px] overflow-hidden border-t border-border bg-surface px-[18px] py-[10px]"
        >
            <LayoutGroup id="cockpit-filmstrip">
                {sessions.map((s) => (
                    <FilmItem key={s.agent.id} session={s} current={s.agent.id === current} />
                ))}
            </LayoutGroup>
        </div>
    );
}

function FilmItem({ session, current }: { session: CockpitSession; current: boolean }) {
    const id = session.agent.id;
    const entries = useAtomValue(entriesAtomFor(id));
    const line = useMemo(() => lastLine(lastTurnEntries(entries, THUMB_ROWS)), [entries]);
    return (
        <button
            type="button"
            data-cockpit-film={id}
            data-current={current || undefined}
            aria-current={current || undefined}
            // a hop leaves focus where it was, so Enter still opens the session rather than pressing this button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => globalStore.set(cockpitZoomAtom, id)}
            className={cn(
                "relative flex min-w-0 max-w-[280px] flex-1 basis-0 cursor-pointer flex-col gap-[4px] rounded-[8px] border px-[10px] py-[7px] text-left",
                current
                    ? "border-transparent bg-surface-selected"
                    : "border-edge-mid bg-surface-raised hover:bg-surface-hover"
            )}
        >
            {current ? (
                <motion.span
                    layoutId="cockpit-film-ring"
                    data-cockpit-film-ring
                    aria-hidden
                    transition={indicatorSlide}
                    className="pointer-events-none absolute inset-[-1px] rounded-[8px] border border-accent"
                />
            ) : null}
            <span className="flex min-w-0 items-center gap-[6px]">
                <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-primary">
                    {session.agent.name}
                </span>
                <StateChip state={session.state} small />
            </span>
            <span className="truncate text-[11.5px] text-ink-mid">{line}</span>
        </button>
    );
}
