// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Terminal | Rendered: two views of one claude process in the Agent surface center. The mode is per agent and not
// persisted (every agent opens in the terminal). A picker command sent from the rendered composer flips the agent to
// the terminal until its next prompt boundary, since the picker only exists in the TUI.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, type PrimitiveAtom } from "jotai";
import { hasAnswerableAsk, type AgentVM } from "./agentsviewmodel";

export type ViewMode = "terminal" | "rendered";

const viewModeAtoms = new Map<string, PrimitiveAtom<ViewMode>>();
const pickerFlipAtoms = new Map<string, PrimitiveAtom<number | null>>();

export function viewModeAtom(agentId: string): PrimitiveAtom<ViewMode> {
    let a = viewModeAtoms.get(agentId);
    if (a == null) {
        a = atom<ViewMode>("terminal");
        viewModeAtoms.set(agentId, a);
    }
    return a;
}

// when a picker command was sent from the composer (Date.now()); null when no picker holds the terminal
export function pickerFlipAtom(agentId: string): PrimitiveAtom<number | null> {
    let a = pickerFlipAtoms.get(agentId);
    if (a == null) {
        a = atom(null) as PrimitiveAtom<number | null>;
        pickerFlipAtoms.set(agentId, a);
    }
    return a;
}

export function effectiveViewMode(mode: ViewMode, flipTs: number | null): ViewMode {
    return flipTs != null ? "terminal" : mode;
}

// the rendered view docks an asking agent's choices above its composer, so the question is answered there
export function askDocked(agent: AgentVM): boolean {
    return agent.state === "asking" && hasAnswerableAsk(agent);
}

// only a live claude session has the control paths the rendered view drives
export function canRender(agent: AgentVM, opts: { ended: boolean; stage: boolean }): boolean {
    return agent.agent === "claude" && agent.blockId != null && agent.kind !== "terminal" && !opts.ended && !opts.stage;
}

// commands that open a full-screen picker in the TUI; /model with an alias switches without one
const PICKER_COMMANDS = new Set([
    "/config",
    "/settings",
    "/resume",
    "/rewind",
    "/permissions",
    "/agents",
    "/mcp",
    "/hooks",
    "/memory",
    "/login",
    "/logout",
    "/status",
    "/doctor",
    "/theme",
    "/plugin",
    "/plugins",
    "/ide",
    "/export",
    "/add-dir",
    "/output-style",
    "/statusline",
    "/terminal-setup",
    "/usage",
    "/cost",
    "/context",
]);

export function isPickerCommand(text: string): boolean {
    const [cmd, ...rest] = text.trim().split(/\s+/);
    if (cmd === "/model") {
        return rest.length === 0;
    }
    return PICKER_COMMANDS.has(cmd);
}

// the hooks that fire only once the TUI is back at (or past) its prompt; Notification and background tool hooks
// fire while a picker is still open
export const UNFLIP_HOOKS = ["UserPromptSubmit", "Stop", "SessionStart"];

export function shouldUnflip(flipTs: number | null, last: { hook: string; ts: number } | null): boolean {
    return flipTs != null && last != null && UNFLIP_HOOKS.includes(last.hook) && last.ts > flipTs;
}

export function toggleViewMode(agentId: string): void {
    const flipAtom = pickerFlipAtom(agentId);
    const shown = effectiveViewMode(globalStore.get(viewModeAtom(agentId)), globalStore.get(flipAtom));
    globalStore.set(flipAtom, null);
    globalStore.set(viewModeAtom(agentId), shown === "rendered" ? "terminal" : "rendered");
}
