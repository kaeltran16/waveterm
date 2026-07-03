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
import { useKeybindings } from "@/app/store/keybindings/store";
import type { Binding } from "@/app/store/keybindings/types";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useRef } from "react";
import type { AgentsViewModel } from "./agents";
import { AgentDetailsRail } from "./agentdetailsrail";
import { AgentHeader } from "./agentheader";
import { AgentLaunchHero } from "./agentlaunchhero";
import { AgentTree } from "./agenttree";
import { moveCursor } from "./agentsviewmodel";
import { railVisibleAtom, terminalFullscreenAtom } from "./railstore";

export function AgentSurface({ model, tabId }: { model: AgentsViewModel; tabId: string }) {
    const focusId = useAtomValue(model.focusIdAtom);
    const agents = useAtomValue(model.agentsAtom);
    const terminals = useAtomValue(model.terminalsAtom);
    const order = useAtomValue(model.orderAtom);
    const fullscreen = useAtomValue(terminalFullscreenAtom);
    const wrapRef = useRef<HTMLDivElement>(null);
    // Focusable set = agents + background terminals. handoff (dc.html:1790): focusAgent = …find(fid) ||
    // list[0] — the Focus surface always shows something, defaulting to the first agent in order (never
    // a terminal, so background terminals stay backgrounded); it falls back to the first terminal only
    // when there are no agents. focusId is kept "always real" (initialized to a default, never empty).
    const mountable = [...agents, ...terminals];
    const focused = focusId != null ? mountable.find((a) => a.id === focusId) : undefined;
    const agent = focused ?? agents.find((a) => a.id === order[0]) ?? agents[0] ?? terminals[0];

    // sync focusId to the defaulted agent so the tree highlights it and ←/→ start from the right place
    useEffect(() => {
        if (agent != null && focusId !== agent.id) {
            globalStore.set(model.focusIdAtom, agent.id);
        }
    }, [agent?.id, focusId, model]);

    // only pull focus to the wrapper for the no-terminal fallback (so esc/←→/d work without a click).
    // when the live terminal is shown it must own focus for immediate typing — stealing it back to the
    // wrapper would force a click before every keystroke, defeating the real-TUI default. the
    // surface keys still fire whenever focus isn't inside the terminal (e.g. after a tree-row click).
    useEffect(() => {
        if (agent != null && agent.blockId == null) {
            wrapRef.current?.focus();
        }
    }, [agent?.id]);

    // null-safe: the roster can be empty (agent == null -> AgentLaunchHero below). Defined before the
    // early return so the binding hooks stay above it (Rules of Hooks).
    const step = (delta: number) => {
        if (agent == null) {
            return;
        }
        globalStore.set(model.focusIdAtom, moveCursor(order, agent.id, delta) ?? agent.id);
        globalStore.set(model.focusReplyAtom, false);
    };

    // Agent-surface keys migrated into the registry (spec §; discoverable in the cheat sheet, governed
    // by the shared posture rules). Rebuilt when the roster/focus changes so step() sees current order.
    const agentBindings = useMemo<Binding[]>(() => {
        const nav = (ctx: { editable: boolean; modalOpen: boolean; surface: string }) =>
            !ctx.editable && !ctx.modalOpen && ctx.surface === "agent";
        return [
            {
                id: "agent:back",
                keys: "Escape",
                group: "Agent",
                label: "Back to Cockpit (or exit fullscreen)",
                when: nav,
                run: () => {
                    if (globalStore.get(terminalFullscreenAtom)) {
                        globalStore.set(terminalFullscreenAtom, false);
                    } else {
                        globalStore.set(model.surfaceAtom, "cockpit");
                    }
                },
            },
            { id: "agent:prev", keys: "ArrowLeft", group: "Agent", label: "Previous agent", when: nav, run: () => step(-1) },
            { id: "agent:next", keys: "ArrowRight", group: "Agent", label: "Next agent", when: nav, run: () => step(1) },
            { id: "agent:prev-k", keys: "k", group: "Agent", label: "Previous agent", when: nav, run: () => step(-1) },
            { id: "agent:next-j", keys: "j", group: "Agent", label: "Next agent", when: nav, run: () => step(1) },
            {
                id: "agent:toggle-rail",
                keys: "d",
                group: "Agent",
                label: "Toggle agent rail",
                when: nav,
                run: () => globalStore.set(railVisibleAtom, !globalStore.get(railVisibleAtom)),
            },
            {
                id: "agent:fullscreen",
                keys: "f",
                group: "Agent",
                label: "Toggle terminal fullscreen",
                when: nav,
                run: () => globalStore.set(terminalFullscreenAtom, !globalStore.get(terminalFullscreenAtom)),
            },
        ];
    }, [model, order, agent?.id]);
    useKeybindings(agentBindings);

    if (!agent) {
        return <AgentLaunchHero model={model} />;
    }

    return (
        <div ref={wrapRef} tabIndex={0} className="flex h-full w-full outline-none">
            {!fullscreen ? <AgentTree model={model} /> : null}
            <div className="flex min-w-0 flex-1 flex-col">
                <AgentHeader agent={agent} />
                {/* Keep every live agent's terminal mounted and toggle display:none, mirroring the
                    surface-level keep-alive (cockpitshell.tsx). Swapping one pane's blockId on focus
                    change disposes+recreates the term, whose restore replays a serialized snapshot and
                    then resumes the live Claude Code TUI's differential stream on top of it — the frames
                    stack (the "distortion"). A visibility toggle avoids the remount entirely. */}
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
            {!fullscreen && agent.kind !== "terminal" ? <AgentDetailsRail model={model} agent={agent} /> : null}
        </div>
    );
}
