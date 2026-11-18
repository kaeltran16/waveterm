// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Per-agent brainstorm state, all in one map: the poller reads every attached brainstorm, and the tree line and
// the attention popup need unfocused agents' questions, so the set must be enumerable as well as keyed.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type Atom, type PrimitiveAtom } from "jotai";
import { atomFamily } from "jotai/utils";
import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import {
    brainstormFilePath,
    brainstormWait,
    builderCheckView,
    samePath,
    seenMark,
    shownFile,
    type BrainstormFile,
    type BrainstormWait,
    type Picks,
    type SeenMark,
    type SentLine,
} from "./brainstormmodel";
import { canvasDir, type CanvasBoard } from "./canvasmodel";
import { attachCanvas, setMarking } from "./canvasstore";
import { closeWorkspaceTab, openWorkspaceTab } from "./workspacestore";

export type BrainstormState = {
    topic: string;
    path: string;
    cwd: string;
    mode: "terminal" | "brainstorm";
    // the last good contents: a read that fails to parse never replaces them
    file: BrainstormFile | null;
    // shown only after two consecutive failed reads, so an agent mid-write never flashes an error
    error: string | null;
    failedReads: number;
    // set only after two consecutive polls found no file, so an agent's delete-then-rename write never shows it gone
    removed: boolean;
    missedStats: number;
    modifiedMs: number | null;
    // when brainstorm mode was last shown: the compaction banner and the unseen mark compare against it
    lastViewedMs: number;
    board: string | null;
    // the design opened over the question or the working note; kept here so a board's Back returns to it
    designOpen: boolean;
    boards: CanvasBoard[];
    // where wavesrv serves the project's design folder; null until the poller has asked it to
    base: string | null;
    // the boards this turn wrote, sized from their canvas.json: `canvases` holds canvas.json's boards for each canvas
    // the turn wrote on, and `read` the board keys (`<canvas>/<name>`) they were read for, so the poller does IO only
    // when the turn writes a board it has not read. Apart from `boards`, which stays the file's own canvas.
    turn: { read: string[]; canvases: Record<string, CanvasBoard[]> };
    // the last line Arc sent, until the agent has taken it (the poller settles it)
    sent: SentLine | null;
    // keep, put back and confirm picks not sent yet: here, not in the pane, so they survive a surface switch
    picks: Picks;
    // the send time of the last `brainstorm: check` the agent took, until Arc's check record is newer than it: with
    // none newer, the agent ended its turn without starting the check
    sentCheckAt: number | null;
    // when the agent's current turn started (agent:turnstartts on its block), as the poller last read it
    turnStartMs?: number;
    // the answered builder check record's ts once the agent took its questions in (nextCheckTakenTs)
    checkTakenTs?: number | null;
    // the check review's cursor row and the rows opened to their was/now; here because the keybindings and the
    // asking rail's links act on them from outside the review
    review: { cursor: string | null; open: Record<string, boolean> };
    // a part opened from outside the pane (openBrainstormAt): the pane opens its row, scrolls to it, then clears it
    partTarget?: string | null;
};

// what every view draws: the file, with a pending sent line read as the agent writing
export function shownBrainstormFile(s: BrainstormState | null | undefined): BrainstormFile | null {
    return s?.file != null ? shownFile(s.file, s.sent) : null;
}

// the picks a row draws as chosen: the ones waiting, and the ones a pending line carried until the agent takes it
export function shownPicks(s: BrainstormState): Picks {
    return { ...(s.sent?.picks ?? {}), ...s.picks };
}

// what the agent's brainstorm waits on the user for, its builder check's record included
export function brainstormWaitOf(s: BrainstormState | null | undefined, agent: AgentVM): BrainstormWait | null {
    const f = shownBrainstormFile(s);
    if (s == null || f == null) {
        return null;
    }
    return brainstormWait(
        f,
        builderCheckView(agent.builderCheck, s.sentCheckAt, s.file, s.modifiedMs, agent, s.turnStartMs, s.checkTakenTs)
    );
}

// the tab meta key holding the attached brainstorm.json's absolute path
export const SESSION_BRAINSTORM = "session:brainstorm";

export const brainstormsAtom = atom<Record<string, BrainstormState>>({}) as PrimitiveAtom<
    Record<string, BrainstormState>
>;

export const brainstormAtom = atomFamily(
    (agentId: string): Atom<BrainstormState | null> => atom((get) => get(brainstormsAtom)[agentId] ?? null)
);

export function getBrainstorm(agentId: string): BrainstormState | null {
    return globalStore.get(brainstormsAtom)[agentId] ?? null;
}

export function updateBrainstorm(agentId: string, fn: (s: BrainstormState) => BrainstormState): void {
    const all = globalStore.get(brainstormsAtom);
    const s = all[agentId];
    if (s != null) {
        globalStore.set(brainstormsAtom, { ...all, [agentId]: fn(s) });
    }
}

// what the user has seen of each brainstorm, keyed by its file's path: apart from the per-agent state, so a resume in a
// new agent, or the pane's remount on a surface switch, keeps it
export const brainstormSeenAtom = atom<Record<string, SeenMark>>({}) as PrimitiveAtom<Record<string, SeenMark>>;

export function markBrainstormSeen(path: string, f: BrainstormFile): void {
    globalStore.set(brainstormSeenAtom, { ...globalStore.get(brainstormSeenAtom), [path]: seenMark(f) });
}

// the first read is what the user is taken to have seen: what is new is measured from there
export function baselineBrainstormSeen(path: string, f: BrainstormFile): void {
    if (!(path in globalStore.get(brainstormSeenAtom))) {
        markBrainstormSeen(path, f);
    }
}

// one brainstorm per agent: the agent reveals on every write, so the same one keeps its state, and any other
// (a new topic, or the same topic in another project) starts over in its place
// mode is where a new one opens; the same one attached again keeps the mode the user chose
export function attachBrainstorm(
    agentId: string,
    a: { topic: string; cwd: string },
    now: number,
    mode: BrainstormState["mode"] = "terminal"
): void {
    const prev = getBrainstorm(agentId);
    if (prev != null && prev.topic === a.topic && samePath(prev.cwd, a.cwd)) {
        return;
    }
    const next: BrainstormState = {
        topic: a.topic,
        path: brainstormFilePath(a.cwd, a.topic),
        cwd: a.cwd,
        mode,
        file: null,
        error: null,
        failedReads: 0,
        removed: false,
        missedStats: 0,
        modifiedMs: null,
        lastViewedMs: now,
        board: null,
        designOpen: false,
        boards: [],
        base: null,
        turn: { read: [], canvases: {} },
        sent: null,
        picks: {},
        sentCheckAt: null,
        review: { cursor: null, open: {} },
    };
    globalStore.set(brainstormsAtom, { ...globalStore.get(brainstormsAtom), [agentId]: next });
}

// its workspace tab goes with it: left open, the tab would draw an empty body
export function detachBrainstorm(agentId: string): void {
    const all = globalStore.get(brainstormsAtom);
    if (agentId in all) {
        const { [agentId]: _gone, ...rest } = all;
        globalStore.set(brainstormsAtom, rest);
        closeWorkspaceTab(agentId, "brainstorm");
    }
}

// the tab meta is what re-attaches a brainstorm after a restart, so a dismissed one has to lose it too
export async function dismissBrainstorm(agentId: string): Promise<void> {
    detachBrainstorm(agentId);
    try {
        await RpcApi.SetMetaCommand(TabRpcClient, { oref: `tab:${agentId}`, meta: { [SESSION_BRAINSTORM]: null } });
    } catch (e) {
        console.warn("brainstorm dismiss: clearing session:brainstorm failed", agentId, e);
    }
}

export function brainstormOwner(topic: string): string | null {
    const all = globalStore.get(brainstormsAtom);
    return Object.keys(all).find((id) => all[id].topic === topic) ?? null;
}

// mode is the Terminal view's: whether the brainstorm takes over the center there (agentpanes.ts's showPane)
export function setBrainstormMode(agentId: string, mode: "terminal" | "brainstorm", now: number): void {
    updateBrainstorm(agentId, (s) => (mode === "brainstorm" ? { ...s, mode, lastViewedMs: now } : { ...s, mode }));
}

// showing the brainstorm, in either view, is a look at it
export function stampBrainstormViewed(agentId: string, now: number): void {
    updateBrainstorm(agentId, (s) => ({ ...s, lastViewedMs: now }));
}

export function openBrainstormBoard(agentId: string, board: string | null): void {
    updateBrainstorm(agentId, (s) => ({ ...s, board }));
}

export function openBrainstormDesign(agentId: string, open: boolean): void {
    updateBrainstorm(agentId, (s) => ({ ...s, designOpen: open }));
}

// The pane at a place, for a control outside it (the Rendered transcript's cards): a part opens the design at that
// part's row (in the check phase, the review's cursor on it), a board the pane's board view on that board of the
// brainstorm's canvas, marking on for mark; neither, the pane as it was. Its callers are Rendered cards, so the pane
// opens as the workspace's Brainstorm tab, beside the transcript
export function openBrainstormAt(
    agentId: string,
    at: { part?: string; board?: string; mark?: boolean },
    now: number = Date.now()
): void {
    const s = getBrainstorm(agentId);
    if (s == null) {
        return;
    }
    stampBrainstormViewed(agentId, now);
    openWorkspaceTab(agentId, { kind: "brainstorm" });
    const canvas = s.file?.canvas;
    if (at.part != null) {
        const part = at.part;
        updateBrainstorm(agentId, (x) => ({
            ...x,
            board: null,
            designOpen: true,
            partTarget: part,
            review: x.file?.check != null ? { ...x.review, cursor: part } : x.review,
        }));
    } else if (at.board != null && canvas != null) {
        attachCanvas(
            agentId,
            { topic: canvas, dir: canvasDir(s.cwd, canvas), projectDir: s.cwd, board: at.board },
            now
        );
        setMarking(agentId, at.mark === true);
        openBrainstormBoard(agentId, at.board);
    }
}

export function clearPartTarget(agentId: string): void {
    updateBrainstorm(agentId, (s) => ({ ...s, partTarget: null }));
}

// every answer Arc sent to a brainstorm question, keyed by the brainstorm file's path, so the transcript can tell an
// answer picked in its own card from one picked in the pane. In memory only: after a restart the transcript claims no
// place for an answer
export type AnswerOrigin = "transcript" | "pane";
export type AnswerRecord = {
    line: string;
    question: number | null;
    builder: string | null;
    answer: string;
    origin: AnswerOrigin;
    at: number;
};

export const brainstormAnswersAtom = atom<Record<string, AnswerRecord[]>>({}) as PrimitiveAtom<
    Record<string, AnswerRecord[]>
>;

export function recordAnswer(path: string, rec: AnswerRecord): void {
    const all = globalStore.get(brainstormAnswersAtom);
    globalStore.set(brainstormAnswersAtom, { ...all, [path]: [...(all[path] ?? []), rec] });
}

// ids is the review's rows in cursor order; a cursor not among them (none yet, or its row gone) starts at the first
export function moveReviewCursor(agentId: string, ids: string[], delta: 1 | -1): void {
    if (ids.length === 0) {
        return;
    }
    updateBrainstorm(agentId, (s) => {
        const at = s.review.cursor != null ? ids.indexOf(s.review.cursor) : -1;
        const next = at < 0 ? 0 : Math.min(ids.length - 1, Math.max(0, at + delta));
        return { ...s, review: { ...s.review, cursor: ids[next] } };
    });
}

export function setReviewCursor(agentId: string, id: string): void {
    updateBrainstorm(agentId, (s) => ({ ...s, review: { ...s.review, cursor: id } }));
}

export function toggleReviewRow(agentId: string, id: string): void {
    updateBrainstorm(agentId, (s) => ({
        ...s,
        review: { ...s.review, open: { ...s.review.open, [id]: !s.review.open[id] } },
    }));
}

// read through the per-agent atom, the one watchFocusedCanvas (whenstate.ts) subscribes for the key predicates
export function focusedBrainstorm(model: AgentsViewModel): BrainstormState | null {
    const id = globalStore.get(model.focusIdAtom);
    return id ? globalStore.get(brainstormAtom(id)) : null;
}
