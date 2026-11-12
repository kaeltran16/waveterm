// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Lands the drawer's answers (decision 6). wavesrv leaves each answer in the board's inbox and publishes
// board:update; this applies it, to the open canvas when the board is open, else to the file under the rev it read,
// then acks it with the shape ids it added or changed. An answer that cannot land stays in the inbox for the next
// try, so a reload or a restart loses nothing; opening a board reads its inbox again, so a board fixed and opened
// takes its waiting answers then. One answer per board is in flight at a time, oldest first. It also toasts an
// agent's briefing turn once it is answered, asks you, or fails (decision 14); your own asks get no toast.

import { pushToast } from "@/app/cockpit/notificationstore";
import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import type { AgentsViewModel } from "../agents/agents";
import { openTarget } from "../jarvis/openref";
import { BoardFileError, parseBoardFile, serializeBoard } from "./boardmodel";
import { boardListAtom, liveBoardApply, onLiveBoardRegistered } from "./boardstore";

const SAVE_TRIES = 3;
const TOASTED_STATES = new Set(["answered", "asks", "failed"]);

// the name as the list has it; a toast still names something when the list can't be read
async function boardName(channelId: string, boardId: string): Promise<string> {
    const named = (list: BoardListRtnData | null | undefined) => list?.boards?.find((b) => b.id === boardId)?.name;
    const cached = named(globalStore.get(boardListAtom(channelId)));
    if (cached) {
        return cached;
    }
    try {
        return named(await RpcApi.BoardListCommand(TabRpcClient, { channelid: channelId })) || `board ${boardId}`;
    } catch {
        return `board ${boardId}`;
    }
}

// the event names the reason when wavesrv has one; else the talk does
async function failedReason(data: BoardUpdateData): Promise<string> {
    if (data.reason) {
        return data.reason;
    }
    try {
        const talk = await RpcApi.BoardTalkCommand(TabRpcClient, { channelid: data.channelid, boardid: data.boardid });
        return talk?.turns?.find((t) => t.id === data.turnid)?.reason || "no reason given";
    } catch {
        return "no reason given";
    }
}

// read, apply, save under the rev read; a save that lost to another writer re-reads and reapplies
async function saveToFile(answer: BoardAnswer): Promise<string[]> {
    const ref = { channelid: answer.channelid, boardid: answer.boardid };
    // loaded on the first answer: the shell mounts this at boot, and Excalidraw's runtime is ~2 MB
    const { landAnswer } = await import("./boardconvert");
    for (let i = 0; i < SAVE_TRIES; i++) {
        const read = await RpcApi.BoardReadCommand(TabRpcClient, ref);
        if (read?.info?.loaderror) {
            throw new BoardFileError(read.info.loaderror);
        }
        const { scene, shapeIds } = landAnswer(parseBoardFile(read.data), answer, Date.now());
        const saved = await RpcApi.BoardSaveCommand(TabRpcClient, {
            ...ref,
            data: serializeBoard(scene),
            baserev: read.rev,
        });
        if (!saved?.conflict) {
            return shapeIds;
        }
    }
    throw new Error(`the board changed under ${SAVE_TRIES} saves in a row`);
}

export function startBoardApplier(model: AgentsViewModel): () => void {
    // an answer is taken once; one that fails to land is let go, so the next inbox read retries it
    const taken = new Set<string>();
    const chains = new Map<string, Promise<void>>();
    // a turn's state is published more than once (a delivery, then its ack); each is toasted once
    const toasted = new Set<string>();
    let stopped = false;

    const openAction = (channelId: string, boardId: string) => ({
        label: "Open",
        run: () => fireAndForget(() => openTarget(model, { kind: "board", channelId, boardId })),
    });

    // true once the answer is on the board
    async function land(answer: BoardAnswer): Promise<boolean> {
        if (stopped) {
            return false;
        }
        let shapeIds: string[];
        try {
            const live = liveBoardApply(answer.boardid);
            shapeIds = live != null ? await live(answer) : await saveToFile(answer);
        } catch (e) {
            // a board that won't open keeps its answers, silently: the surface shows why it won't open
            console.warn("boards: an answer could not land; it stays in the inbox", answer.boardid, answer.id, e);
            return false;
        }
        try {
            await RpcApi.BoardAnswerAckCommand(TabRpcClient, {
                channelid: answer.channelid,
                boardid: answer.boardid,
                answerid: answer.id,
                turnid: answer.turnid,
                shapeids: shapeIds,
            });
        } catch (e) {
            // the answer is on the board; taken stays set, so this session does not land it twice
            console.warn("boards: acking a landed answer failed", answer.boardid, answer.id, e);
        }
        return true;
    }

    function take(answer: BoardAnswer): void {
        if (stopped || taken.has(answer.id)) {
            return;
        }
        taken.add(answer.id);
        const prev = chains.get(answer.boardid) ?? Promise.resolve();
        chains.set(
            answer.boardid,
            prev.then(async () => {
                if (!(await land(answer))) {
                    taken.delete(answer.id);
                }
            })
        );
    }

    function readInbox(data: CommandBoardInboxData): void {
        RpcApi.BoardAnswerInboxCommand(TabRpcClient, data)
            .then((answers) => (answers ?? []).forEach(take))
            .catch((e) => console.warn("boards: reading the answer inbox failed", data, e));
    }

    async function toastBriefing(data: BoardUpdateData): Promise<void> {
        const name = await boardName(data.channelid, data.boardid);
        const action = openAction(data.channelid, data.boardid);
        if (data.state === "answered") {
            pushToast({
                title: `The drawer answered on ${name}`,
                message: `From ${data.from}'s briefing`,
                level: "info",
                action,
            });
        } else if (data.state === "asks") {
            pushToast({
                title: `The drawer asks you on ${name}`,
                message: `Does ${data.from}'s briefing belong on a new board?`,
                level: "info",
                action,
            });
        } else {
            const reason = await failedReason(data);
            pushToast({ title: `The drawer couldn't answer on ${name}`, message: reason, level: "error", action });
        }
    }

    function onTalk(data: BoardUpdateData): void {
        if (!data.from || !data.boardid) {
            return;
        }
        const key = `${data.boardid}:${data.turnid}:${data.state}`;
        if (!TOASTED_STATES.has(data.state ?? "")) {
            // the turn runs again (Retry), so its next outcome toasts again
            TOASTED_STATES.forEach((state) => toasted.delete(`${data.boardid}:${data.turnid}:${state}`));
            return;
        }
        if (toasted.has(key)) {
            return;
        }
        toasted.add(key);
        fireAndForget(() => toastBriefing(data));
    }

    const unsubscribe = waveEventSubscribeSingle({
        eventType: "board:update",
        handler: (event) => {
            const data = event.data as BoardUpdateData;
            if (stopped || data == null) {
                return;
            }
            if (data.what === "answer") {
                readInbox({ channelid: data.channelid, boardid: data.boardid });
            } else if (data.what === "talk") {
                onTalk(data);
            }
        },
    });
    const unlisten = onLiveBoardRegistered((channelid, boardid) => readInbox({ channelid, boardid }));
    readInbox({});
    return () => {
        stopped = true;
        unsubscribe();
        unlisten();
    };
}
