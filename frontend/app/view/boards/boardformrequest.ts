// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The Boards surface's ask form, requested from anywhere (the palette, a briefing's toast, the board's own
// header). The surface reads the request when it shows, opens the form to match and clears it.

import { atom, type PrimitiveAtom } from "jotai";

export type BoardFormRequest =
    | { kind: "new"; channelId: string }
    | { kind: "about"; channelId: string; about: BoardSource }
    | { kind: "handoff"; channelId: string; fromBoardId: string }
    | { kind: "briefing"; channelId: string; fromBoardId: string; turnId: string; about: BoardSource; ask: string };

export const boardFormAtom = atom<BoardFormRequest | null>(null) as PrimitiveAtom<BoardFormRequest | null>;
