// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Rendered box's ! bash mode is state, not text: as in Claude Code, a ! into an empty box switches the mode and
// is not kept.

const BASH_PREFIX = "!";

// a ! typed or pasted into an empty box turns bash mode on; a pasted !cmd keeps cmd
export function bashOnInput(prevText: string, nextText: string): { bash: true; text: string } | null {
    if (prevText !== "" || !nextText.startsWith(BASH_PREFIX)) {
        return null;
    }
    return { bash: true, text: nextText.slice(BASH_PREFIX.length) };
}

// Esc with no panel open, or Backspace on an empty box, turns bash mode off
export function bashOffKey(key: string, text: string, panelOpen: boolean): boolean {
    if (key === "Escape") {
        return !panelOpen;
    }
    return key === "Backspace" && text === "";
}
