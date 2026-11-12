// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Draw on a board…: the one palette action every drawable kind adds. The palette's board drill collects the
// board, the ask and the follow, then runs the action with them; the scribe does the drawing.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { resolveTargetChannel } from "@/app/view/agents/channelderive";
import { activeChannelAtom, channelsAtom } from "@/app/view/agents/channelsstore";
import { projectListAtom, recentProjectsAtom } from "@/app/view/agents/projectsstore";
import { when } from "@/app/view/agents/storagemodel";
import { palettePickChannel } from "../palette-data";
import { rankPaletteItems } from "../palette-match";
import type { BoardDrawTarget, ThingAction } from "./types";

export const DRAW_ON_BOARD_LABEL = "Draw on a board…";

// what the board drill hands the action as its value
export interface BoardChoice {
    boardId: string;
    ask: string;
    follow: boolean;
}

export function parseBoardChoice(value: string | undefined): BoardChoice {
    const c = value ? (JSON.parse(value) as Partial<BoardChoice>) : {};
    if (!c.boardId) {
        throw new Error("no board was picked");
    }
    return { boardId: c.boardId, ask: c.ask ?? "", follow: c.follow === true };
}

export function drawOnBoardAction<T>(kind: string, target: (thing: T) => BoardDrawTarget | null): ThingAction<T> {
    return {
        id: `${kind}:draw-board`,
        label: DRAW_ON_BOARD_LABEL,
        group: "open",
        applies: (thing) => target(thing) != null,
        // applies guards the null: the palette offers the action only where it has a target
        input: { kind: "board", target: (thing) => target(thing)! },
        run: (thing, _deps, value) => drawOnBoard(target(thing), parseBoardChoice(value)),
    };
}

async function drawOnBoard(target: BoardDrawTarget | null, choice: BoardChoice): Promise<void> {
    if (target == null) {
        throw new Error("nothing to draw from");
    }
    const ask = choice.ask.trim();
    await RpcApi.BoardDrawCommand(TabRpcClient, {
        channelid: target.channelId,
        boardid: choice.boardId,
        source: target.source,
        ...(ask !== "" ? { ask } : {}),
        ...(target.followable && choice.follow ? { follow: true } : {}),
    });
}

export function listBoards(channelId: string): Promise<BoardListRtnData> {
    return RpcApi.BoardListCommand(TabRpcClient, { channelid: channelId });
}

export function createBoard(channelId: string, name: string): Promise<BoardInfo> {
    return RpcApi.BoardCreateCommand(TabRpcClient, { channelid: channelId, name });
}

// what the scribe reads with no ask: a transcript's newest turn, anything else whole
const READS: Record<string, { noun: string; whole: string }> = {
    agent: { noun: "agent", whole: "this agent's latest turn as it reads it" },
    session: { noun: "session", whole: "this session's latest turn as it reads it" },
    run: { noun: "run", whole: "the whole run" },
    effort: { noun: "initiative", whole: "the whole initiative" },
    record: { noun: "record", whole: "the whole record" },
};

// the ask step's line on what the ask changes
export function boardAskHint(kind: string): string {
    const r = READS[kind] ?? { noun: "thing", whole: "the whole thing" };
    return `What to draw is optional. Without it, the scribe draws ${r.whole}; with it, the drawing keeps to your ask, and the same ${r.noun} with the same ask redraws its group in place.`;
}

export function followLine(title: string): string {
    return `Redraw at each of ${title}'s turn ends until it closes or you press Stop. Each redraw is a scribe session.`;
}

// the footer line: what Enter at the ask step does
export function boardDrawEcho(p: { title: string; ask: string; board: string; follow: boolean }): string {
    const ask = p.ask.trim();
    return `Draw ${p.title}${ask !== "" ? `: ${ask}` : ""} on ${p.board}${p.follow ? ", and keep following" : ""}`;
}

// a board row's second line: its groups and when it was last drawn (or made)
export function boardSub(b: BoardInfo, now: number = Date.now()): string {
    if (b.loaderror) {
        return "won't open";
    }
    const groups = `${b.groups} ${b.groups === 1 ? "group" : "groups"}`;
    return `${groups} · ${when(b.lastdrawnts || b.createdts, now)}`;
}

// The board step's list: the boards what was typed matches, and the name New board… carries ("" when nothing
// was typed, or it names a board already there).
export function boardPickList(boards: BoardInfo[], query: string): { boards: BoardInfo[]; newName: string } {
    const typed = query.trim();
    const hits = rankPaletteItems(
        boards.map((b) => ({ search: b.name, b })),
        typed
    ).map((r) => r.b);
    const exact = boards.some((b) => b.name.trim().toLowerCase() === typed.toLowerCase());
    return { boards: hits, newName: exact ? "" : typed };
}

// The project a thing draws in: the channel at its project path, else the one named like its project, else the
// palette's current project.
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
