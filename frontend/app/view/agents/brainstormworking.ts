// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: what the brainstorm's Working view shows of the agent's current turn, read from its live transcript entries:
// the step it is on, how long the turn has run, and the boards it has written.

import type { AgentEntry, AgentVM } from "./agentsviewmodel";
import { canvasDesignDir } from "./canvasmodel";
import { fmtDuration } from "./runcompletion";

export type TurnBoard = { canvas: string; name: string };
export type WorkingStep = { verb: string; target: string };
export type WorkingTurn = {
    step: WorkingStep | null;
    elapsed: string | null;
    boards: TurnBoard[];
    latest: TurnBoard | null;
};

const BOARD_EXT = ".dc.html";
const PROJECT_DIR = "project";
const ABSOLUTE = /^([a-z]:)?\//i;

// the stream tails the transcript, so a tail without a prompt starts inside the turn; entries carry no timestamps,
// so the last human prompt is the only boundary they give
export function turnEntries(entries: AgentEntry[]): AgentEntry[] {
    for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (e.kind === "user" || (e.kind === "command" && !e.isSkill)) {
            return entries.slice(i + 1);
        }
    }
    return entries;
}

export function boardKey(b: TurnBoard): string {
    return `${b.canvas}/${b.name}`;
}

function slashed(p: string): string {
    return p.replace(/[\\/]+/g, "/");
}

// a file is a board only at <design>/<canvas>/project/<name>.dc.html, compared as Windows does
function boardOf(path: string, designPrefix: string, cwd: string): TurnBoard | null {
    let p = slashed(path).replace(/^\.\//, "");
    if (!ABSOLUTE.test(p)) {
        p = `${slashed(cwd).replace(/\/$/, "")}/${p}`;
    }
    if (!p.toLowerCase().startsWith(designPrefix.toLowerCase())) {
        return null;
    }
    const [canvas, folder, name, ...rest] = p.slice(designPrefix.length).split("/");
    if (
        !canvas ||
        rest.length > 0 ||
        folder?.toLowerCase() !== PROJECT_DIR ||
        !name?.toLowerCase().endsWith(BOARD_EXT)
    ) {
        return null;
    }
    return { canvas, name };
}

export function turnBoards(entries: AgentEntry[], cwd: string): { boards: TurnBoard[]; latest: TurnBoard | null } {
    const designPrefix = `${slashed(canvasDesignDir(cwd))}/`;
    const boards: TurnBoard[] = [];
    let latest: TurnBoard | null = null;
    for (const e of turnEntries(entries)) {
        // a pending write has not landed its file yet
        if (e.kind !== "action" || e.detail?.kind !== "edit" || e.pending || e.outcome === "fail") {
            continue;
        }
        for (const f of e.detail.files) {
            const b = boardOf(f.path, designPrefix, cwd);
            if (b == null) {
                continue;
            }
            latest = boards.find((x) => boardKey(x) === boardKey(b)) ?? b;
            if (!boards.includes(latest)) {
                boards.push(latest);
            }
        }
    }
    return { boards, latest };
}

// a running command is the current step, so a pending action counts
export function workingStep(entries: AgentEntry[]): WorkingStep | null {
    const turn = turnEntries(entries);
    for (let i = turn.length - 1; i >= 0; i--) {
        const e = turn[i];
        if (e.kind === "action") {
            return { verb: e.verb, target: e.target };
        }
    }
    return null;
}

// null unless the agent is working: an idle or asking agent shows none of the live parts, so no stale timer
export function workingTurn(
    agent: Pick<AgentVM, "state">,
    entries: AgentEntry[],
    cwd: string,
    turnStartMs: number | undefined,
    nowMs: number
): WorkingTurn | null {
    if (agent.state !== "working") {
        return null;
    }
    return {
        step: workingStep(entries),
        elapsed: turnStartMs != null ? fmtDuration(nowMs - turnStartMs) : null,
        ...turnBoards(entries, cwd),
    };
}
