// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Focus handoff for ModalShell. A modal that never takes focus is not keyboard-operable: the close-agent
// confirm dialog opened over a focused xterm (double Ctrl+C), and xterm's own keydown handler calls
// stopPropagation() on Enter and Escape, so the dialog's window-level listeners never ran — and the
// keystroke was forwarded to the live agent shell instead. Taking focus fixes both halves.
//
// It must not steal focus from a child that already claimed it (an autoFocus'd input), and it must hand
// focus back on close so the terminal is live again without a click.

export function focusTrapTarget(
    focusables: HTMLElement[],
    active: Element | null,
    reverse: boolean
): HTMLElement | null {
    if (focusables.length === 0) {
        return null;
    }
    const index = active == null ? -1 : focusables.indexOf(active as HTMLElement);
    if (index < 0) {
        return reverse ? focusables[focusables.length - 1] : focusables[0];
    }
    const next = reverse ? index - 1 : index + 1;
    return focusables[(next + focusables.length) % focusables.length];
}

export function takeModalFocus(panel: HTMLElement | null, previous: HTMLElement | null): () => void {
    if (panel != null && !panel.contains(previous)) {
        panel.focus();
    }
    return () => {
        // a confirmed close tears down what had focus; refocusing a detached node would silently
        // land focus on <body> instead of leaving it where the browser already put it
        if (previous?.isConnected) {
            previous.focus();
        }
    };
}
