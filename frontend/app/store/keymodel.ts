// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { atoms, getApi, getSettingsKeyAtom, globalStore } from "@/app/store/global";
import { handleWaveEvent } from "@/app/store/keybindings/dispatcher";
import * as jotai from "jotai";

const simpleControlShiftAtom = jotai.atom(false);
let globalKeybindingsDisabled = false;

function setControlShift() {
    globalStore.set(simpleControlShiftAtom, true);
    const disableDisplay = globalStore.get(getSettingsKeyAtom("app:disablectrlshiftdisplay"));
    if (!disableDisplay) {
        setTimeout(() => {
            const simpleState = globalStore.get(simpleControlShiftAtom);
            if (simpleState) {
                globalStore.set(atoms.controlShiftDelayAtom, true);
            }
        }, 400);
    }
}

function unsetControlShift() {
    globalStore.set(simpleControlShiftAtom, false);
    globalStore.set(atoms.controlShiftDelayAtom, false);
}

// Public seam kept for the terminal (term-model), Monaco editor (preview-edit), and waveconfig.
// The global keybinding registry now owns matching + leader/chord state; the dispatcher's own
// per-native-event dedup makes double delivery (window-capture then a component reinjection) a no-op.
function appHandleKeyDown(waveEvent: WaveKeyboardEvent): boolean {
    if (globalKeybindingsDisabled) {
        return false;
    }
    return handleWaveEvent(waveEvent);
}

function registerControlShiftStateUpdateHandler() {
    getApi().onControlShiftStateUpdate((state: boolean) => {
        if (state) {
            setControlShift();
        } else {
            unsetControlShift();
        }
    });
}

function tryReinjectKey(event: WaveKeyboardEvent): boolean {
    return appHandleKeyDown(event);
}

export { appHandleKeyDown, registerControlShiftStateUpdateHandler, tryReinjectKey };
