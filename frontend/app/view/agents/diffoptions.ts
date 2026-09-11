// frontend/app/view/agents/diffoptions.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: the Diff pane's two view switches -> the options Monaco is handed. The switches live here
// rather than in the pane because the surface unmounts on a nav switch and the keybindings flip them
// from outside it, and the mapping lives here because it is the only part worth a test.

import { atom } from "jotai";
import type * as MonacoTypes from "monaco-editor";

// below this the two editors are narrower than most lines in this repo, so the toggle is offered
// disabled rather than producing a view nobody can read
export const SPLIT_MIN_PX = 900;

export const splitViewAtom = atom<boolean>(false);

// Monaco ignores leading and trailing whitespace by default, so a whitespace-only change draws as no
// change at all while the counts in the same header read +2 -2 — the pane contradicting the list it
// was opened from. Off by default so the two agree; on is the opt-in for reading through a reformat.
export const ignoreWsAtom = atom<boolean>(false);

export function paneOptions(split: boolean, ignoreWs: boolean): MonacoTypes.editor.IDiffEditorOptions {
    return {
        readOnly: true,
        originalEditable: false,
        renderSideBySide: split,
        ignoreTrimWhitespace: ignoreWs,
        scrollBeyondLastLine: false,
        minimap: { enabled: false },
        fontSize: 12.5,
        fontFamily: "var(--font-mono)",
        smoothScrolling: true,
        scrollbar: { useShadows: false, verticalScrollbarSize: 6, horizontalScrollbarSize: 6 },
    };
}
