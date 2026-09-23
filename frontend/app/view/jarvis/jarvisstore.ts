// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Jarvis surface state. The surface UNMOUNTS on nav-switch (only the agent surface stays mounted), so
// every survive-worthy value lives here as a module atom, never component useState.

import { atom, type PrimitiveAtom } from "jotai";

// The record the Brief's peek is open on, or null. Module-level rather than surface state because the
// Jarvis surface unmounts when you navigate away from it, and a peek opened from an oref must survive the
// surface flip that oref triggers.
export const briefPeekRecordAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;

// Whether the Brief's detail sheet is showing. The subject it draws is the surface's active subject, not a
// second copy of it here: keeping the target in two atoms is how a sheet and the thing it claims to show
// end up naming different objects. Session-scoped, because the subject is what is persisted and a closed
// sheet clears it — so what reopens on the next launch is the subject that was left open, not this flag.
export const briefSheetOpenAtom = atom(false);

// The Brief composer's rendered height, 0 when there is none. The composer stays above the detail sheet on
// purpose (it talks to the session the sheet is showing), so the sheet ends its content this far above the
// surface's bottom — otherwise its dock sits underneath the composer.
export const briefComposerHeightAtom = atom(0);

// The Brief's inline tracker: the chunk row whose note trail the sidebar is showing, and the index of the
// note open in its reader. Here rather than inside briefsurface because Escape has to claim them ahead of
// esc-home (bindings.ts), the same way the Vault's reader overlay does — a single press must close the
// note you are reading, not the note AND the surface.
export const noteChunkAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
export const readingNoteAtom = atom<number | null>(null) as PrimitiveAtom<number | null>;

// Alt+↑/↓ moves the chunk under the Brief cursor. The Brief publishes the handler while the cursor is on
// a chunk, because only it holds the plan the move is computed against.
export const chunkMoveAtom = atom<((dir: "up" | "down") => void) | null>(null) as PrimitiveAtom<
    ((dir: "up" | "down") => void) | null
>;

// The graph peek overlay. Session-scoped, not persisted: a peek is a momentary look at one object's
// neighbourhood, so reopening the app on top of one would be reopening a destination it is not.
export const graphPeekOpenAtom = atom(false);

// The record the Brief's graph peek was opened to focus, or null. Separate from the peek's `record` atom
// because a map button names an object to centre on. Cleared with the peek, so the next unaddressed open
// does not re-centre on a record the user has left.
export const briefGraphRecordAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
