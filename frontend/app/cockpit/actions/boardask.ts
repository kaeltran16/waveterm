// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Ask a board about this…: the one palette action every askable kind adds. It lands on the Boards surface with
// the ask form open on the thing; the board, name and question are typed there.

import { globalStore } from "@/app/store/jotaiStore";
import { resolveTargetChannel } from "@/app/view/agents/channelderive";
import { activeChannelAtom, channelsAtom } from "@/app/view/agents/channelsstore";
import { projectListAtom, recentProjectsAtom } from "@/app/view/agents/projectsstore";
import { openBoardAsk } from "@/app/view/jarvis/openref";
import { palettePickChannel } from "../palette-data";
import type { ThingAction } from "./types";

export const ASK_BOARD_LABEL = "Ask a board about this…";

// the project the board is in, and the thing the drawer reads first
export interface BoardAskTarget {
    channelId: string;
    about: BoardSource;
}

export function askBoardAction<T>(kind: string, target: (thing: T) => BoardAskTarget | null): ThingAction<T> {
    return {
        id: `${kind}:ask-board`,
        label: ASK_BOARD_LABEL,
        group: "open",
        applies: (thing) => target(thing) != null,
        run: (thing, { model }) => {
            const t = target(thing);
            if (t == null) {
                throw new Error("nothing to ask about");
            }
            openBoardAsk(model, t.channelId, t.about);
        },
    };
}

// The project a thing is asked about in: the channel at its project path, else the one named like its project,
// else the palette's current project.
export function pickBoardChannel(
    channels: Channel[] | null,
    current: () => Channel | null,
    path?: string,
    name?: string
): string | null {
    const all = channels ?? [];
    const byPath = path ? resolveTargetChannel(all, path) : undefined;
    const byName = name ? all.find((c) => c.name === name) : undefined;
    return (byPath ?? byName ?? current())?.oid ?? null;
}

// pickBoardChannel over the live stores, the current project being the palette's own
export function boardChannelFor(path?: string, name?: string): string | null {
    const current = () =>
        palettePickChannel(
            globalStore.get(activeChannelAtom),
            globalStore.get(projectListAtom),
            globalStore.get(recentProjectsAtom)[0] ?? null
        );
    return pickBoardChannel(globalStore.get(channelsAtom), current, path, name);
}
