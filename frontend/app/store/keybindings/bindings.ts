// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cheatsheetOpenAtom } from "@/app/cockpit/shortcuts-cheatsheet";
import { globalStore } from "@/app/store/jotaiStore";
import { confirmCloseAgent } from "@/app/view/agents/agentactions";
import { AgentsViewModel, SURFACE_ORDER, type SurfaceKey } from "@/app/view/agents/agents";
import { moveCursor, type AgentVM } from "@/app/view/agents/agentsviewmodel";
import { railVisibleAtom, terminalFullscreenAtom } from "@/app/view/agents/railstore";
import type { Binding, KeyContext } from "./types";

const DOUBLE_CTRL_C_MS = 500;

// g-leader surface teleports (collision-free letters; see design spec).
const GO_TARGETS: { letter: string; surface: SurfaceKey; label: string }[] = [
    { letter: "h", surface: "cockpit", label: "Cockpit (home)" },
    { letter: "a", surface: "agent", label: "Agent" },
    { letter: "v", surface: "activity", label: "Activity" },
    { letter: "c", surface: "channels", label: "Channels" },
    { letter: "s", surface: "sessions", label: "Sessions" },
    { letter: "f", surface: "files", label: "Files" },
    { letter: "m", surface: "memory", label: "Memory" },
    { letter: "u", surface: "usage", label: "Usage" },
    { letter: ",", surface: "settings", label: "Settings" },
];

const navigate = (ctx: KeyContext) => !ctx.editable && !ctx.modalOpen;

// Spec §5 (agent-tab-fixes): the second Ctrl+C closes the *focused* session — agent or plain
// terminal alike (the UI labels both "terminal": "Close terminal — ends the agent"). Returns null
// only when nothing focusable is targeted, so the press falls through to the PTY instead.
export function closeTargetForDoubleCtrlC(agents: AgentVM[], focusId: string | undefined): AgentVM | null {
    if (!focusId) {
        return null;
    }
    return agents.find((x) => x.id === focusId) ?? null;
}

export function buildGlobalBindings(model: AgentsViewModel): Binding[] {
    let lastCtrlC: number | null = null;

    const surfaceChords: Binding[] = SURFACE_ORDER.slice(0, 8).map((surface, i) => ({
        id: `surface:${surface}`,
        keys: `Ctrl:${i + 1}`,
        group: "Global",
        label: `Jump to ${surface}`,
        run: () => globalStore.set(model.surfaceAtom, surface),
    }));

    const goBindings: Binding[] = GO_TARGETS.map((t) => ({
        id: `go:${t.surface}`,
        keys: `g ${t.letter}`,
        group: "Go to",
        label: t.label,
        when: navigate,
        run: () => globalStore.set(model.surfaceAtom, t.surface),
    }));

    return [
        ...surfaceChords,
        ...goBindings,
        {
            id: "palette",
            keys: "Ctrl:p",
            group: "Global",
            label: "Command palette",
            run: () => globalStore.set(model.paletteOpenAtom, (v) => !v),
        },
        {
            id: "go:palette",
            keys: "g p",
            group: "Go to",
            label: "Command palette",
            when: navigate,
            run: () => globalStore.set(model.paletteOpenAtom, true),
        },
        {
            id: "new-agent",
            keys: "Ctrl:n",
            group: "Global",
            label: "New agent",
            run: () => globalStore.set(model.newAgentOpenAtom, true),
        },
        {
            id: "cycle-agent-next",
            keys: "Ctrl:Tab",
            group: "Agent",
            label: "Next agent",
            when: (ctx) => ctx.surface === "agent",
            run: () => model.cycleFocus(false),
        },
        {
            id: "cycle-agent-prev",
            keys: "Ctrl:Shift:Tab",
            group: "Agent",
            label: "Previous agent",
            when: (ctx) => ctx.surface === "agent",
            run: () => model.cycleFocus(true),
        },
        {
            id: "close-agent",
            keys: "Ctrl:c",
            group: "Agent",
            label: "Close agent (press twice)",
            // Global chord (allowed while the terminal is focused/editable), Agent surface only.
            when: (ctx) => ctx.surface === "agent",
            run: () => {
                const inTerm = (document.activeElement as HTMLElement | null)?.closest?.(".cockpit-focus-pane") != null;
                if (!inTerm) {
                    return false; // let ^C reach the shell when not in the focus pane
                }
                const now = performance.now();
                if (lastCtrlC != null && now - lastCtrlC < DOUBLE_CTRL_C_MS) {
                    lastCtrlC = null;
                    const agents = [...globalStore.get(model.agentsAtom), ...globalStore.get(model.terminalsAtom)];
                    const fid = globalStore.get(model.focusIdAtom);
                    const a = closeTargetForDoubleCtrlC(agents, fid);
                    if (a) {
                        confirmCloseAgent(a.id, a.name);
                        return true;
                    }
                    return false;
                }
                lastCtrlC = now;
                return false; // first press falls through so the PTY receives ^C
            },
        },
        {
            id: "help",
            keys: "Shift:?",
            group: "Help",
            label: "Keyboard shortcuts",
            when: navigate,
            run: () => globalStore.set(cheatsheetOpenAtom, true),
        },
    ];
}

const agentNav = (ctx: KeyContext) => navigate(ctx) && ctx.surface === "agent";

// Agent (Focus) surface bindings. Moved out of agentsurface.tsx so the registry has one home
// and the array is stable: run() reads live atoms instead of closing over per-render focus/order.
// focusIdAtom is kept synced to the resolved focused agent (agentsurface.tsx), so reading it live
// is equivalent to the old closure over `agent.id`.
export function buildAgentBindings(model: AgentsViewModel): Binding[] {
    const step = (delta: number) => {
        const order = globalStore.get(model.orderAtom);
        const fid = globalStore.get(model.focusIdAtom);
        globalStore.set(model.focusIdAtom, moveCursor(order, fid, delta) ?? fid);
        globalStore.set(model.focusReplyAtom, false);
    };
    return [
        {
            id: "agent:back",
            keys: "Escape",
            group: "Agent",
            label: "Back to Cockpit (or exit fullscreen)",
            when: agentNav,
            run: () => {
                if (globalStore.get(terminalFullscreenAtom)) {
                    globalStore.set(terminalFullscreenAtom, false);
                } else {
                    globalStore.set(model.surfaceAtom, "cockpit");
                }
            },
        },
        { id: "agent:prev", keys: "ArrowLeft", group: "Agent", label: "Previous agent", when: agentNav, run: () => step(-1) },
        { id: "agent:next", keys: "ArrowRight", group: "Agent", label: "Next agent", when: agentNav, run: () => step(1) },
        { id: "agent:prev-k", keys: "k", group: "Agent", label: "Previous agent", when: agentNav, run: () => step(-1) },
        { id: "agent:next-j", keys: "j", group: "Agent", label: "Next agent", when: agentNav, run: () => step(1) },
        {
            id: "agent:toggle-rail",
            keys: "d",
            group: "Agent",
            label: "Toggle agent rail",
            when: agentNav,
            run: () => globalStore.set(railVisibleAtom, !globalStore.get(railVisibleAtom)),
        },
        {
            id: "agent:fullscreen",
            keys: "f",
            group: "Agent",
            label: "Toggle terminal fullscreen",
            when: agentNav,
            run: () => globalStore.set(terminalFullscreenAtom, !globalStore.get(terminalFullscreenAtom)),
        },
        {
            id: "agent:return-nav",
            keys: "Shift:Escape",
            group: "Agent",
            label: "Return focus to nav",
            when: (ctx) => ctx.surface === "agent" && ctx.editable, // only while the TUI owns focus
            run: () => {
                (document.activeElement as HTMLElement | null)?.blur?.();
                // refocus the surface wrapper (tabIndex=0) so ↑↓/j/k/d/f resume
                document.querySelector<HTMLElement>("[data-cockpit-surface-wrap]")?.focus();
            },
        },
    ];
}
