// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { modalsModel } from "@/app/store/modalmodel";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { dagModalStateAtom } from "@/app/view/orchestrate/dagmodalstate";
import * as keyutil from "@/util/keyutil";
import { CHORD_TIMEOUT } from "@/util/sharedconst";
import { activeLeaderAtom } from "./leaderatom";
import { matchBinding } from "./matcher";
import { bindingsAtom } from "./store";
import type { Binding, KeyContext } from "./types";

let boundModel: AgentsViewModel | null = null;
let leader: string | null = null;
let leaderTimeout: ReturnType<typeof setTimeout> | null = null;
let lastHandledEvent: KeyboardEvent | null = null;
// when the user last pressed any key: the cockpit UI API waits for a quiet moment before it moves the view
// (cockpit/uiclient.ts)
let lastKeyTs = 0;

export function lastKeyActivityTs(): number {
    return lastKeyTs;
}

function setLeader(next: string | null): void {
    leader = next;
    globalStore.set(activeLeaderAtom, next);
    if (leaderTimeout) {
        clearTimeout(leaderTimeout);
        leaderTimeout = null;
    }
    if (next != null) {
        leaderTimeout = setTimeout(() => setLeader(null), CHORD_TIMEOUT);
    }
}

// Exported for its unit test. Getting this wrong is not cosmetic: every bare-letter binding is gated
// on it, so a false negative fires cockpit actions out of the middle of a word.
export function isEditableTarget(el: Element | null): boolean {
    if (el == null) {
        return false;
    }
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (el as HTMLElement).isContentEditable) {
        return true;
    }
    // Monaco 0.52+ types into a <div class="native-edit-context"> (the EditContext API) rather than a
    // hidden textarea, and that div is neither a form element nor contenteditable — so the tag test
    // alone called the Code editor "not editable" and bare `r` refreshed the index mid-word, bare `g`
    // opened the leader, and Escape left the surface. Matching the container covers both edit-context
    // implementations and any future swap of the focus target.
    return el.closest?.(".monaco-editor") != null;
}

export function deriveKeyContext(): KeyContext {
    const model = boundModel;
    if (model == null) {
        return { surface: "cockpit", editable: false, modalOpen: false, leader };
    }
    const surface = globalStore.get(model.surfaceAtom);
    const modalOpen =
        globalStore.get(model.paletteOpenAtom) ||
        globalStore.get(model.newAgentOpenAtom) ||
        globalStore.get(model.newProjectOpenAtom) ||
        // the DAG modal too: left out, the Brief's bindings underneath took the graph's own keys first
        // (Enter submitted an ask, Escape closed the Chunk sidebar). Only the Brief mounts it, and its state
        // outlives a switch away, since opening a worker from the graph lands on the Agent surface.
        (surface === "jarvis" && globalStore.get(dagModalStateAtom) != null) ||
        globalStore.get(modalsModel.modalsAtom).length > 0;
    return {
        surface,
        editable: isEditableTarget(document.activeElement),
        modalOpen,
        leader,
    };
}

// Runs a binding; returns whether the key should be consumed (false only when run() returns false).
function runBinding(binding: Binding, ctx: KeyContext): boolean {
    return binding.run(ctx) !== false;
}

// The single entry point. Returns true if the app claimed the key (caller should preventDefault).
export function handleWaveEvent(waveEvent: WaveKeyboardEvent): boolean {
    const nativeEvent = (waveEvent as any).nativeEvent as KeyboardEvent | undefined;
    if (nativeEvent != null && lastHandledEvent === nativeEvent) {
        return false; // already processed (e.g. window-capture then a component-level reinjection)
    }
    if (nativeEvent != null) {
        lastHandledEvent = nativeEvent;
    }
    const ctx = deriveKeyContext();
    const bindings = globalStore.get(bindingsAtom);
    let result = matchBinding(waveEvent, ctx, bindings);
    if (result.kind === "resetAndProcess") {
        setLeader(null);
        result = result.result;
    }
    switch (result.kind) {
        case "enterLeader":
            setLeader(result.leader);
            return true;
        case "reset":
            setLeader(null);
            return true;
        case "run": {
            if (leader != null) {
                setLeader(null);
            }
            return runBinding(result.binding, ctx);
        }
        default:
            return false;
    }
}

export function initKeybindingDispatcher(model: AgentsViewModel): () => void {
    boundModel = model;
    const onKeyDown = (e: KeyboardEvent) => {
        lastKeyTs = Date.now();
        const waveEvent = keyutil.adaptFromReactOrNativeKeyEvent(e);
        const handled = handleWaveEvent(waveEvent);
        if (handled) {
            e.preventDefault();
            e.stopImmediatePropagation();
        }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
        window.removeEventListener("keydown", onKeyDown, true);
        boundModel = null;
    };
}
