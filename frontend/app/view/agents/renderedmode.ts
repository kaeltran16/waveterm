// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Terminal | Rendered: two views of one claude process in the Agent surface center. Every agent opens in the view the
// Settings default names (one canRender refuses shows the terminal); a toggle overrides it for that agent until
// restart. A picker command sent from the rendered composer flips the agent to the terminal until its next prompt
// boundary, since the picker only exists in the TUI.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, type PrimitiveAtom, type WritableAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { contextTokens } from "./agentrailmodel";
import { hasAnswerableAsk, type AgentVM } from "./agentsviewmodel";

export type ViewMode = "terminal" | "rendered";

export const DEFAULT_VIEW_MODE: ViewMode = "rendered";

// getOnInit: toggleViewMode reads it outside React, before anything has mounted the atom
export const defaultViewModeAtom = atomWithStorage<ViewMode>("agent.view.default", DEFAULT_VIEW_MODE, undefined, {
    getOnInit: true,
}) as PrimitiveAtom<ViewMode>;

type ViewModeAtom = WritableAtom<ViewMode, [ViewMode], void>;

const viewModeAtoms = new Map<string, ViewModeAtom>();
const pickerFlipAtoms = new Map<string, PrimitiveAtom<number | null>>();

// the agent's toggled view, else the Settings default, so changing the default moves every untoggled agent
export function viewModeAtom(agentId: string): ViewModeAtom {
    let a = viewModeAtoms.get(agentId);
    if (a == null) {
        const chosen = atom(null) as PrimitiveAtom<ViewMode | null>;
        a = atom(
            (get) => get(chosen) ?? get(defaultViewModeAtom),
            (_get, set, mode: ViewMode) => set(chosen, mode)
        );
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

// the rendered view shows an asking agent's choices as a card in its column, so the question is answered there
export function askDocked(agent: AgentVM): boolean {
    return agent.state === "asking" && hasAnswerableAsk(agent);
}

export type ComposerBox = {
    kind: "new" | "idle" | "working";
    placeholder: string;
    // typing into the pty while Claude's question picker is open would land in the picker, so Send waits on the answer
    askBlocks: boolean;
    // a turn is in progress (working, or held on a question), so an empty box offers Stop
    live: boolean;
    // the Send button's aria-label and title
    sendLabel: "Send" | "Steer" | "Run";
};

export const BASH_PLACEHOLDER = "Run a shell command; its output joins the transcript";

// the message box's state from the agent's: which placeholder, whether Send is held, whether a turn can be stopped.
// bash: the box is in ! bash mode, which changes only the placeholder and the Send label (the text runs as a command,
// not a steer, whatever the agent's state)
export function composerBox(agent: AgentVM, hasTranscript: boolean, bash = false): ComposerBox {
    const askBlocks = askDocked(agent);
    const working = agent.state === "working";
    const kind = working ? "working" : hasTranscript ? "idle" : "new";
    const placeholder = bash
        ? BASH_PLACEHOLDER
        : kind === "working"
          ? "Steer the agent; it reads this before its next step"
          : kind === "idle"
            ? `Reply to ${agent.name}, @ to mention, / for commands`
            : `Message ${agent.name}, @ to mention, / for commands`;
    const sendLabel = bash ? "Run" : working ? "Steer" : "Send";
    return { kind, placeholder, askBlocks, live: working || askBlocks, sendLabel };
}

// the box's button: Stop while a turn is live and the box is empty, else Send (a steer while working)
export function boxButton(box: ComposerBox, filled: boolean): "send" | "stop" {
    return box.live && !filled ? "stop" : "send";
}

const RING_FULL = 1;

// the box's context ring: the reported percent, the arc it fills (0-1), and a title in tokens when the window is known
export function contextRing(usage: AgentUsage | undefined): { pct: number; arc: number; title: string } | null {
    const pct = usage?.contextpct;
    if (pct == null) {
        return null;
    }
    const shown = Math.round(pct);
    const tokens = contextTokens(pct, usage.contextmax);
    const title =
        tokens != null
            ? `${tokens} of ${contextTokens(100, usage.contextmax)} tokens in context`
            : `context: ${shown}% of the window`;
    return { pct: shown, arc: Math.min(RING_FULL, Math.max(0, pct / 100)), title };
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
