// frontend/app/view/code/codetreekeys.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: the Code tree's whole keyboard contract, as rows x cursor x key -> one action.
//
// Extracted because the pane's previous wiring derived its cursor from the OPEN FILE and only acted
// on file rows, which made every directory row a dead end — the cursor could not move past one and
// Enter could never match one — and none of that was testable without a DOM.
//
// Moving deliberately does NOT open. The shared list-nav contract says "cursor == selection: moving
// IS selecting", which is right for a session list and wrong for a file tree: every keypress would
// stat-then-read a file over RPC and push a back/forward history entry.

import { moveCursor } from "@/app/view/agents/agentsviewmodel";
import type { TreeRow } from "./codetree";

export type TreeKey = "next" | "prev" | "collapse" | "expand" | "activate";

export type TreeAction =
    | { kind: "move"; path: string }
    | { kind: "toggle"; path: string }
    | { kind: "open"; path: string }
    | { kind: "none" };

const NONE: TreeAction = { kind: "none" };

export function treeKeyAction(rows: readonly TreeRow[], cursor: string | null, key: TreeKey): TreeAction {
    if (rows.length === 0) {
        return NONE;
    }
    if (key === "next" || key === "prev") {
        const next = moveCursor(
            rows.map((r) => r.path),
            cursor ?? undefined,
            key === "next" ? 1 : -1
        );
        // moveCursor clamps rather than wraps, so at either end it hands back the cursor we passed in
        return next == null || next === cursor ? NONE : { kind: "move", path: next };
    }
    const row = rows.find((r) => r.path === cursor);
    if (row == null) {
        return NONE; // a refreshed index can retire the row the cursor named
    }
    if (key === "activate") {
        return row.kind === "dir" ? { kind: "toggle", path: row.path } : { kind: "open", path: row.path };
    }
    if (row.kind !== "dir") {
        return NONE; // collapse and expand are directory gestures
    }
    const wantOpen = key === "expand";
    return row.expanded === wantOpen ? NONE : { kind: "toggle", path: row.path };
}
