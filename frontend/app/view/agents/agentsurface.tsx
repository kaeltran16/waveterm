// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Agent (Focus) surface: AgentTree | center [| AgentDetailsRail]. The rail is toggleable
// (railVisibleAtom, default off, `d` key) so the surface is normally 2 panes, 3 with the rail open.
// The center is the focused agent's live Claude Code terminal (CockpitFocusPane) — the real TUI,
// not a narrated transcript; an AgentHeader bar sits above it for identity + the rail toggle. With no
// explicit focus it defaults to the first agent in order (handoff dc.html:1790
// `focusAgent = …find(fid) || list[0]`) — never the cockpit grid; only a zero-agent roster shows an
// empty state. Routing is shell-side (this file is imported only by cockpitshell.tsx) so agents.tsx
// never imports CockpitFocusPane, keeping the agents -> focus-pane -> blockregistry -> agents eval
// cycle broken.

import { CockpitFocusPane } from "@/app/cockpit/focus-pane";
import { globalStore } from "@/app/store/jotaiStore";
import { buildAgentBindings } from "@/app/store/keybindings/bindings";
import { useKeybindings } from "@/app/store/keybindings/store";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { MotionConfig } from "motion/react";
import { useEffect, useMemo, useRef } from "react";
import type { AgentsViewModel } from "./agents";
import { AgentDetailsRail } from "./agentdetailsrail";
import { AgentHeader } from "./agentheader";
import { AgentLaunchHero } from "./agentlaunchhero";
import { AgentTree } from "./agenttree";
import { terminalFullscreenAtom } from "./railstore";
import { SubagentInterior } from "./subagentinterior";
import { focusSubagentAtom } from "./subagentsstore";

export function AgentSurface({ model, tabId }: { model: AgentsViewModel; tabId: string }) {
    const focusId = useAtomValue(model.focusIdAtom);
    const agents = useAtomValue(model.agentsAtom);
    const terminals = useAtomValue(model.terminalsAtom);
    const order = useAtomValue(model.orderAtom);
    const fullscreen = useAtomValue(terminalFullscreenAtom);
    const focusSub = useAtomValue(focusSubagentAtom);
    const wrapRef = useRef<HTMLDivElement>(null);
    // Focusable set = agents + background terminals. handoff (dc.html:1790): focusAgent = …find(fid) ||
    // list[0] — the Focus surface always shows something, defaulting to the first agent in order (never
    // a terminal, so background terminals stay backgrounded); it falls back to the first terminal only
    // when there are no agents. focusId is kept "always real" (initialized to a default, never empty).
    const mountable = [...agents, ...terminals];
    const focused = focusId != null ? mountable.find((a) => a.id === focusId) : undefined;
    const agent = focused ?? agents.find((a) => a.id === order[0]) ?? agents[0] ?? terminals[0];
    const showSub = focusSub != null && focusSub.parentId === agent?.id;

    // sync focusId to the defaulted agent so the tree highlights it and ←/→ start from the right place
    useEffect(() => {
        if (agent != null && focusId !== agent.id) {
            globalStore.set(model.focusIdAtom, agent.id);
        }
    }, [agent?.id, focusId, model]);

    // a stale interior (its parent is no longer focused) closes so the terminal returns
    useEffect(() => {
        if (focusSub != null && focusSub.parentId !== agent?.id) {
            globalStore.set(focusSubagentAtom, null);
        }
    }, [agent?.id, focusSub]);

    // only pull focus to the wrapper for the no-terminal fallback (so esc/←→/d work without a click).
    // when the live terminal is shown it must own focus for immediate typing — stealing it back to the
    // wrapper would force a click before every keystroke, defeating the real-TUI default. the
    // surface keys still fire whenever focus isn't inside the terminal (e.g. after a tree-row click).
    useEffect(() => {
        if (agent != null && agent.blockId == null) {
            wrapRef.current?.focus();
        }
    }, [agent?.id]);

    // Agent-surface keys live in the registry (bindings.ts). Stable array — run() reads live atoms.
    const agentBindings = useMemo(() => buildAgentBindings(model), [model]);
    useKeybindings(agentBindings);

    if (!agent) {
        return <AgentLaunchHero model={model} />;
    }

    return (
        <MotionConfig reducedMotion="user">
            <div ref={wrapRef} tabIndex={0} data-cockpit-surface-wrap className="flex h-full w-full bg-background outline-none">
                {!fullscreen ? <AgentTree model={model} /> : null}
                <div className="flex min-w-0 flex-1 flex-col">
                    {/* terminal stack stays mounted (hidden) while a subagent interior is shown, so
                        returning to the parent never remounts/replays the live TUI (frame-stacking) */}
                    <div className={cn("flex min-h-0 flex-1 flex-col", showSub && "hidden")}>
                        <AgentHeader agent={agent} />
                        {mountable
                            .filter((a) => a.blockId != null)
                            .map((a) => (
                                <div
                                    key={a.id}
                                    className={cn("min-h-0 flex-1", a.id === agent.id ? "flex flex-col" : "hidden")}
                                >
                                    <CockpitFocusPane blockId={a.blockId!} tabId={tabId} />
                                </div>
                            ))}
                        {agent.blockId == null ? (
                            <div className="flex flex-1 items-center justify-center text-[13px] text-muted">
                                No live terminal for this agent.
                            </div>
                        ) : null}
                    </div>
                    {showSub ? <SubagentInterior sub={focusSub!} parentName={agent.name} /> : null}
                </div>
                {!fullscreen && agent.kind !== "terminal" ? <AgentDetailsRail model={model} agent={agent} /> : null}
            </div>
        </MotionConfig>
    );
}
