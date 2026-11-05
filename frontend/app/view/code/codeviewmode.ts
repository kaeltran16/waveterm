// frontend/app/view/code/codeviewmode.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: which view the open text file is in. Blame and review comments only exist beside the source editor,
// so whatever turns them on asks this first.

import { isMarkdownPath } from "./codeclassify";

// preview is markdown-only, so a non-markdown file left in preview mode is showing its source
export function shownViewMode(mode: "preview" | "source" | "diff", path: string): "preview" | "source" | "diff" {
    return mode === "preview" && !isMarkdownPath(path) ? "source" : mode;
}

export function showsSourceEditor(mode: "preview" | "source" | "diff", path: string): boolean {
    return mode !== "diff" && !(isMarkdownPath(path) && mode === "preview");
}
