// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Keys from inside a board. A board loads cross-origin to the app (wavesrv's web listener), so once a click focuses
// its iframe the app's window sees no keydown. pkg/canvasserve injects a relay into every board page that posts the
// keys the board left alone; the board's iframe re-dispatches them as a keydown on itself, so the keybinding
// dispatcher and ModalShell see them as if focus were in the app.

// the relay's message type, the literal pkg/canvasserve's keyRelay script posts
export const BOARD_KEY_TYPE = "arc:board-key";

export type BoardKeyMessage = {
    type: typeof BOARD_KEY_TYPE;
    key: string;
    code: string;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    metaKey: boolean;
    // focus was in a field of the board
    editable: boolean;
};

type Posted = { data: unknown; source: unknown; origin: string };

function isBoardKey(d: unknown): d is BoardKeyMessage {
    const m = d as BoardKeyMessage | null;
    return (
        m != null &&
        typeof m === "object" &&
        m.type === BOARD_KEY_TYPE &&
        typeof m.key === "string" &&
        typeof m.code === "string" &&
        typeof m.editable === "boolean"
    );
}

// The keydown to re-dispatch for a posted message, or null: only from this iframe's own window at the board's origin,
// and from a field only Escape, matching the app, where a field mutes bare keys but Esc still closes a modal
export function relayedKey(e: Posted, frame: Window | null, boardOrigin: string): KeyboardEventInit | null {
    if (frame == null || e.source !== frame || e.origin !== boardOrigin || !isBoardKey(e.data)) {
        return null;
    }
    const m = e.data;
    if (m.editable && m.key !== "Escape") {
        return null;
    }
    return {
        key: m.key,
        code: m.code,
        ctrlKey: !!m.ctrlKey,
        shiftKey: !!m.shiftKey,
        altKey: !!m.altKey,
        metaKey: !!m.metaKey,
    };
}

// re-dispatches the board's relayed keys on its iframe until the returned unsubscribe
export function listenBoardKeys(iframe: HTMLIFrameElement, src: string): () => void {
    const origin = new URL(src, window.location.href).origin;
    const onMessage = (e: MessageEvent) => {
        const init = relayedKey(e, iframe.contentWindow, origin);
        if (init != null) {
            iframe.dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true }));
        }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
}
