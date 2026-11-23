// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The brainstorm side of the canvas window: the scope a question or a part opens, and when the band may offer Pick.

import {
    judgeWait,
    judgeWork,
    optionNumber,
    partGist,
    questionBoardLayout,
    type BrainstormFile,
    type BrainstormQuestion,
} from "./brainstormmodel";
import { boardLabel } from "./canvasmodel";
import type { BandAnswer, ScopeBand, ScopeSource, ScopeTab, WindowScope } from "./canvaswindowmodel";

const EVERY_ANSWER = "Every answer";

// questionBoardLayout only asks whether the canvas is served, which a scope does not need
const SERVED = "";

function bandAnswers(q: BrainstormQuestion, judging: boolean): BandAnswer[] {
    if (judging) {
        return (q.approaches ?? []).map((a, index) => ({
            index,
            label: a.name,
            detail: a.description,
            pick: false,
            pros: [],
            cons: [],
        }));
    }
    return (q.options ?? []).map((o, index) => ({
        index,
        label: o.label,
        detail: o.detail,
        pick: o.pick === true,
        pros: o.pros ?? [],
        cons: o.cons ?? [],
    }));
}

// the answers' boards in answer order, a board several answers name once, at its first answer
function answerBoards(rows: string[][]): Map<string, number[]> {
    const named = new Map<string, number[]>();
    rows.forEach((row, i) => row.forEach((b) => named.set(b, [...(named.get(b) ?? []), i])));
    return named;
}

// a board one answer names, and that answer names no other, takes the answer's label; any other answer board keeps
// its own name behind the numbers of the answers that name it
function answerTabLabel(board: string, owners: number[], rows: string[][], answers: BandAnswer[]): string {
    if (owners.length === 1 && rows[owners[0]].length === 1) {
        return `${optionNumber(owners[0])} · ${answers[owners[0]].label}`;
    }
    return `${owners.map(optionNumber).join(", ")} · ${boardLabel(board)}`;
}

export function questionScope(f: BrainstormFile, onCanvas: string[], judging: boolean): WindowScope | null {
    const q = f.question;
    if (q == null || (f.working != null && !judging)) {
        return null;
    }
    const layout = questionBoardLayout(f, SERVED, onCanvas, judging);
    if (layout == null) {
        return null;
    }
    const answers = bandAnswers(q, judging);
    const owned = answerBoards(layout.rows);
    const tabs: ScopeTab[] = [...owned].map(([board, owners]) => ({
        board,
        label: answerTabLabel(board, owners, layout.rows, answers),
        band: { kind: "answers", answers: owners.map((i) => answers[i]) },
    }));
    const shared = layout.shared.filter((b) => onCanvas.includes(b));
    for (const board of shared) {
        const label = shared.length === 1 ? EVERY_ANSWER : `${EVERY_ANSWER} · ${boardLabel(board)}`;
        tabs.push({ board, label, band: { kind: "every" } });
    }
    if (tabs.length === 0) {
        return null;
    }
    const source: ScopeSource = {
        kind: "question",
        n: q.n,
        text: q.text,
        judging,
        judged: judgeWork(q)?.judged === true,
    };
    return { source, tabs };
}

export function partScope(f: BrainstormFile, partId: string, onCanvas: string[]): WindowScope | null {
    const p = f.parts.find((x) => x.id === partId);
    const boards = [...new Set(p?.boards ?? [])].filter((b) => onCanvas.includes(b));
    if (p == null || boards.length === 0) {
        return null;
    }
    const band: ScopeBand = { kind: "part", title: p.title, gist: partGist(f, p) };
    return {
        source: { kind: "part", id: p.id, title: p.title },
        tabs: boards.map((board) => ({ board, label: boardLabel(board), band })),
    };
}

// Pick answers the live question, so it shows only while the scope's question is still the one asked, in the same
// judging state, and the agent is not writing over it (the judge's wait aside)
export function bandPickable(f: BrainstormFile, source: ScopeSource, linePending: boolean): boolean {
    if (source.kind !== "question" || f.question?.n !== source.n) {
        return false;
    }
    const waiting = judgeWait(f, linePending);
    return source.judging === waiting && (waiting || f.working == null);
}

// where `o` opens: the focused answer's first tab, else the scope's first
export function scopeOpenBoard(scope: WindowScope, answer: number | null): string | null {
    const named =
        answer == null
            ? undefined
            : scope.tabs.find((t) => t.band.kind === "answers" && t.band.answers.some((a) => a.index === answer));
    return (named ?? scope.tabs[0])?.board ?? null;
}
