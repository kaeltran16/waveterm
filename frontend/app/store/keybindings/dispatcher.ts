// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { resmonOpenAtom } from "@/app/cockpit/resmonstore";
import { anyModalOpen } from "@/app/modals/modalstack";
import { contextMenuAtom } from "@/app/store/contextmenu";
import { globalStore } from "@/app/store/jotaiStore";
import { modalsModel } from "@/app/store/modalmodel";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { docReviewAtom } from "@/app/view/agents/docreview";
import { finalShotsViewerOpenAtom } from "@/app/view/jarvis/finalshotsstore";
import { petPeekOpenAtom } from "@/app/view/jarvis/petstore";
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

// A control reached with Tab owns Enter and Space, as it does anywhere on the web: without this the Brief's
// list:activate took Enter from a tabbed-to button and opened the cursor row instead. One focused by a click
// does not, or the chip just pressed with the mouse would take the Enter meant for the list cursor.
let tabbing = false;
let tabbedTo: Element | null = null;

function isPressable(el: Element): boolean {
    const tag = el.tagName;
    return (
        (tag === "BUTTON" && !(el as HTMLButtonElement).disabled) ||
        (tag === "A" && el.hasAttribute("href")) ||
        tag === "SUMMARY"
    );
}

// Exported for its unit test.
export function controlOwnsKey(e: WaveKeyboardEvent, active: Element | null, tabbed: Element | null): boolean {
    if (active == null || active !== tabbed || e.shift || e.control || e.alt || e.meta) {
        return false;
    }
    return (e.key === "Enter" || e.key === " ") && isPressable(active);
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

// Whether a surface just switched to should leave focus where it is: a visible field or an open modal
// already took it. Visibility matters because a field on the surface just hidden is still activeElement
// until Chromium's next rendering update.
export function focusClaimed(): boolean {
    const active = document.activeElement as HTMLElement | null;
    return (isEditableTarget(active) && active.checkVisibility()) || anyModalOpen();
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
        globalStore.get(model.newRunOpenAtom) ||
        globalStore.get(model.newInitiativeOpenAtom) ||
        globalStore.get(model.newProjectOpenAtom) ||
        // the DAG modal too: left out, the Brief's bindings underneath took the graph's own keys first
        // (Enter submitted an ask, Escape closed the Chunk sidebar). Only the Brief mounts it, and its state
        // outlives a switch away, since opening a worker from the graph lands on the Agent surface.
        (surface === "jarvis" && globalStore.get(dagModalStateAtom) != null) ||
        globalStore.get(docReviewAtom) != null ||
        // the avatar popup is window chrome over any surface, and its own keys (Enter, f, Space, Escape) are
        // surface keys too; uncounted, the Agent surface's f toggled fullscreen under an open item
        globalStore.get(petPeekOpenAtom) ||
        // the Final check viewer over the run sheet: its arrows and Escape are its own, not the Brief's list
        globalStore.get(finalShotsViewerOpenAtom) ||
        // the Resource Manager popover is window chrome too, and its arrows, Enter, x and Escape are surface keys
        globalStore.get(resmonOpenAtom) ||
        // a context menu moves its highlight with the arrows and closes on Escape; uncounted, the Brief's
        // list cursor took the arrows and Escape left the surface under the open menu
        globalStore.get(contextMenuAtom) != null ||
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
        tabbing = e.key === "Tab";
        const waveEvent = keyutil.adaptFromReactOrNativeKeyEvent(e);
        if (controlOwnsKey(waveEvent, document.activeElement, tabbedTo)) {
            return;
        }
        const handled = handleWaveEvent(waveEvent);
        if (handled) {
            e.preventDefault();
            e.stopImmediatePropagation();
        }
    };
    const onFocusIn = (e: FocusEvent) => {
        tabbedTo = tabbing ? (e.target as Element) : null;
        tabbing = false;
    };
    // a click on the control Tab already focused moves no focus, so it clears the mark itself
    const onPointerDown = () => {
        tabbing = false;
        tabbedTo = null;
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("focusin", onFocusIn, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
        window.removeEventListener("keydown", onKeyDown, true);
        window.removeEventListener("focusin", onFocusIn, true);
        window.removeEventListener("pointerdown", onPointerDown, true);
        boundModel = null;
    };
}
