// frontend/app/view/code/codeviewmode.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: which view the open text file is in. Blame and review comments only exist beside the source editor,
// so whatever turns them on asks this first.

import { isMarkdownPath } from "./codeclassify";

export function showsSourceEditor(mode: "preview" | "source" | "diff", path: string): boolean {
    return mode !== "diff" && !(isMarkdownPath(path) && mode === "preview");
}
