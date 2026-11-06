// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The cockpit grid's pure layout: which column a card sits in and how much of the column's height it takes.
// The columns are flex columns at least one viewport tall, so these numbers are flex shares and floors,
// not pixel rects. No React, no atoms.

import type { ChipFilter } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import { leadAgentOf, roleRunId, runFinished, type Lineage, type RunInfo } from "./runlineage";

// a card that needs you is readable at a glance; below these the content clips
export const CARD_MIN_PX = { agent: 200, agentAsk: 320, run: 280, runAsk: 400 } as const;

export interface CardShare {
    grow: 1 | 2;
    minPx: number;
}

// a run card holds a run's tasks, so it weighs as two agent cards when the columns are balanced
const RUN_CARD_WEIGHT = 2;

/** Pure: two columns of about equal weight. Runs are placed first, then plain agents, each in the lighter column
 *  (the first on a tie), so a run card always sits above the agents of its column and a card changes column only
 *  when the set of cards changes, never with a card's state. A lone card spans. */
export function splitGridColumns<T>(items: T[], isRun: (t: T) => boolean): T[][] {
    if (items.length <= 1) {
        return items.length === 1 ? [items] : [];
    }
    const cols: T[][] = [[], []];
    const weight = [0, 0];
    for (const t of [...items.filter(isRun), ...items.filter((t) => !isRun(t))]) {
        const i = weight[1] < weight[0] ? 1 : 0;
        cols[i].push(t);
        weight[i] += isRun(t) ? RUN_CARD_WEIGHT : 1;
    }
    return cols;
}

// a run card's floor holds this many task rows beyond the two its base floor fits, then its rows scroll
const RUN_ROW_PX = 34;
const RUN_ROWS_IN_BASE = 2;
const RUN_ROWS_FLOOR_MAX = 10;

/** Pure: a card's flex share of its column and its floor. A run card's floor grows with the task rows it shows,
 *  up to the grid's own height (capPx), so a run of many tasks is not squeezed to two rows. */
export function cardShare(isRun: boolean, needsYou: boolean, rows = 0, capPx = Infinity): CardShare {
    if (isRun) {
        const base = needsYou ? CARD_MIN_PX.runAsk : CARD_MIN_PX.run;
        const extra = Math.min(Math.max(0, rows - RUN_ROWS_IN_BASE), RUN_ROWS_FLOOR_MAX) * RUN_ROW_PX;
        return { grow: needsYou ? 2 : 1, minPx: Math.max(base, Math.min(base + extra, capPx)) };
    }
    return { grow: needsYou ? 2 : 1, minPx: needsYou ? CARD_MIN_PX.agentAsk : CARD_MIN_PX.agent };
}

// a card is a plain agent or an orchestrator run; a run's card carries its lead whenever the lead is in the roster
export type GridCard =
    | { kind: "agent"; id: string; agent: AgentVM }
    | { kind: "run"; id: string; run: RunInfo; lead?: AgentVM };

const LEADLESS_PREFIX = "run:";

// a run's card with no lead in the roster goes by the run's address, which also opens its run sheet
export function leadlessCardId(runId: string): string {
    return `${LEADLESS_PREFIX}${runId}`;
}

export function isLeadlessCardId(id: string): boolean {
    return id.startsWith(LEADLESS_PREFIX);
}

/** Pure: the grid's cards in the order of `shown`. A run's workers are rows of its card, never cards of their
 *  own. A run gets one card at the place of whichever of its lead or workers is shown first, and the card
 *  carries the lead from the roster even when the lead itself is parked or filtered out. */
export function buildGridCards(shown: AgentVM[], lineage: Lineage, roster: AgentVM[]): GridCard[] {
    const cards: GridCard[] = [];
    const placed = new Set<string>();
    for (const a of shown) {
        const role = lineage.roles[a.id];
        const runId = role ? roleRunId(role) : undefined;
        if (runId == null || !lineage.runs[runId]) {
            cards.push({ kind: "agent", id: a.id, agent: a });
            continue;
        }
        if (placed.has(runId)) {
            continue;
        }
        placed.add(runId);
        const lead = role?.kind === "lead" ? a : leadAgentOf(lineage, roster, runId);
        cards.push({ kind: "run", id: lead?.id ?? leadlessCardId(runId), run: lineage.runs[runId], lead });
    }
    return cards;
}

const FINISHED_RUN = new Set(["done", "cancelled"]);

/** Pure: `shown` plus each lead in `scoped` whose run is still going. A lead idles between wakes, so parking it
 *  (or Live only) must not take its running run off the grid. */
export function withActiveRunLeads(shown: AgentVM[], scoped: AgentVM[], lineage: Lineage): AgentVM[] {
    const ids = new Set(shown.map((a) => a.id));
    const extra = scoped.filter((a) => {
        const role = lineage.roles[a.id];
        const dag = role?.kind === "lead" ? lineage.runs[role.runId]?.dag : undefined;
        return !ids.has(a.id) && dag != null && !FINISHED_RUN.has(dag.status);
    });
    return extra.length > 0 ? [...shown, ...extra] : shown;
}

/** Pure: every roster id a shown run card owns: its lead, its workers and its stage sessions. They are the card's
 *  rows, so they are never also listed as plain agents in Idle or Backgrounded. */
export function runCardMemberIds(cards: GridCard[], lineage: Lineage): Set<string> {
    const runs = new Set(cards.flatMap((c) => (c.kind === "run" ? [c.run.runId] : [])));
    return new Set(
        Object.entries(lineage.roles)
            .filter(([, role]) => runs.has(roleRunId(role)))
            .map(([id]) => id)
    );
}

/** Pure: backgrounding a lead backgrounds its run's card, until something in the run needs you. */
export function isBackgroundedRun(card: GridCard, backgroundedIds: Set<string>, needsYou: boolean): boolean {
    return card.kind === "run" && card.lead != null && backgroundedIds.has(card.lead.id) && !needsYou;
}

/** Pure: a status tab's press. Pressing the selected tab again returns to everything. */
export function toggleChip(current: ChipFilter, pressed: ChipFilter): ChipFilter {
    return current === pressed ? "all" : pressed;
}

/** Pure: does the status chip show this card. A card shows under Asking when it needs you. A booting agent is
 *  live but not yet working; one standing by (idle with a running shell task) has not finished, so it is
 *  working, not up for review. */
export function cardMatchesChip(card: GridCard, chip: ChipFilter, needsYou: boolean, standingBy = false): boolean {
    if (chip === "all") {
        return true;
    }
    if (chip === "asking") {
        return needsYou;
    }
    if (card.kind === "agent") {
        const { state, booting } = card.agent;
        if (chip === "working") {
            return (state === "working" && !booting) || standingBy;
        }
        return state === "idle" && !standingBy;
    }
    if (chip === "working") {
        return card.lead?.state === "working" || card.run.dag?.status === "running";
    }
    // a run is up for review once it ends; a lead idling between wakes is still running it
    return runFinished(card.run);
}

const CHIPS: ChipFilter[] = ["asking", "working", "idle", "all"];

/** Pure: each status tab's count, in cards, as the tab filters them. */
export function chipCounts(
    cards: GridCard[],
    needsYou: (c: GridCard) => boolean,
    standingBy: (c: GridCard) => boolean
): Record<ChipFilter, number> {
    const counts = { asking: 0, working: 0, idle: 0, all: 0 };
    for (const c of cards) {
        for (const chip of CHIPS) {
            if (cardMatchesChip(c, chip, needsYou(c), standingBy(c))) {
                counts[chip]++;
            }
        }
    }
    return counts;
}

// what the keyboard does on a focused task row: open, answer the worker's question, or run the row's actions
export interface RowTarget {
    openId?: string;
    askAgentId?: string;
    actions: (() => void)[];
    // the row's live worker, which space peeks
    peekId?: string;
    // opens the row's Tell input, which r is on a task row: a reply to its worker
    tell?: () => void;
}

/** Pure: whose question the cursor is on: a card's own agent, or the asking worker of a task row. */
export function askerAt(
    cursorId: string | undefined,
    roster: AgentVM[],
    rowTargets: Record<string, RowTarget>
): AgentVM | undefined {
    if (cursorId == null) {
        return undefined;
    }
    const id = cursorId in rowTargets ? rowTargets[cursorId].askAgentId : cursorId;
    return id != null ? roster.find((a) => a.id === id) : undefined;
}

/** Pure: each column's cursor stops: a card, then its task rows. */
export function columnNavIds(columns: GridCard[][], rowKeysOf: (card: GridCard) => string[]): string[][] {
    return columns.map((col) => col.flatMap((c) => [c.id, ...rowKeysOf(c)]));
}

/** Pure: h/l. From a card or one of its rows, go to the card at the same card index in the other column. */
export function columnJump(
    cols: string[][],
    cardOf: (id: string) => string,
    cur: string | undefined,
    dir: -1 | 1
): string | undefined {
    if (cols.length !== 2 || cur == null) {
        return undefined;
    }
    const card = cardOf(cur);
    const cardsIn = (col: string[]) => col.filter((id) => cardOf(id) === id);
    const from = cols.findIndex((col) => col.includes(cur));
    const to = from + dir;
    if (from < 0 || to < 0 || to > 1) {
        return undefined;
    }
    const target = cardsIn(cols[to]);
    return target[Math.min(cardsIn(cols[from]).indexOf(card), target.length - 1)];
}

/** Pure: keep the cursor on something visible. An id with no stop of its own (a worker, whose ask lives in its
 *  lead's row) goes to its alias. */
export function resolveCursor(
    cur: string | undefined,
    nav: string[],
    alias: Record<string, string>
): string | undefined {
    if (nav.length === 0) {
        return undefined;
    }
    if (cur != null && nav.includes(cur)) {
        return cur;
    }
    const aliased = cur != null ? alias[cur] : undefined;
    return aliased != null && nav.includes(aliased) ? aliased : nav[0];
}
