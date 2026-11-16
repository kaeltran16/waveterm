// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure: what a wsh effort call's card or view shows. The call's argv is the record of what changed; the effort record
// (or the effort list) only adds names and progress, so a card with no record still draws from argv. No React.

import { CHIP_CAP, chunkTone, type ChunkTone } from "@/app/view/jarvis/effortmodel";
import type { WshCall } from "./wshcall";

// the effort show view lists this many chunks before "N more chunks"; the list view this many rows
export const SHOW_CHUNKS_SHOWN = 5;
export const LIST_ROWS_SHOWN = 7;
// an advance names the chunk of the record's chunk-done event nearest the call, within this much
const ADVANCE_MATCH_MS = 60_000;
const EFFORT_PREFIX = "effort:";

export const bareEffortId = (ref: string): string =>
    ref.startsWith(EFFORT_PREFIX) ? ref.slice(EFFORT_PREFIX.length) : ref;

export interface Progress {
    done: number;
    total: number;
}
export interface ChunkFacts {
    number?: number;
    label?: string;
}
export interface NumberedChunk {
    number: number;
    label: string;
}

interface CardBase {
    effortId: string;
    error?: string;
}
export type InitiativeCard =
    | (CardBase & { kind: "chunk-done"; chunk: ChunkFacts; note?: string; progress?: Progress; title?: string })
    | (CardBase & { kind: "chunk-blocked"; chunk: ChunkFacts; needs?: string })
    | (CardBase & { kind: "chunk-status"; chunk: ChunkFacts; status: string })
    | (CardBase & { kind: "chunk-added"; chunk: ChunkFacts; initiative?: string })
    | (CardBase & { kind: "chunk-noted"; chunk: ChunkFacts; note?: string })
    | (Omit<CardBase, "effortId"> & {
          kind: "initiative-created";
          effortId?: string;
          title: string;
          ticket?: string;
          project?: string;
          chunks: NumberedChunk[];
          progress?: Progress;
      });

export interface CardSource {
    effort?: Effort;
    efforts?: EffortSummary[];
    error?: string;
    // the call's own time, to tell which advance an effort's several chunk-done events belong to
    ts?: number;
}

const flagText = (call: WshCall, name: string): string | undefined => {
    const v = call.flags[name];
    return typeof v === "string" && v !== "" ? v : undefined;
};

function progressOf(effort: Effort): Progress {
    return { done: effort.chunks.filter((c) => c.status === "done").length, total: effort.chunks.length };
}

// a chunk ref is a 1-based number or an exact label (wsh's chunkRef); the record fills in whichever argv lacks
function resolveChunk(ref: string | undefined, effort?: Effort): ChunkFacts {
    if (ref == null) {
        return {};
    }
    const n = /^\d+$/.test(ref) ? Number(ref) : undefined;
    const chunks = effort?.chunks ?? [];
    if (n != null) {
        const c = chunks[n - 1];
        return c ? { number: n, label: c.label } : { number: n };
    }
    const at = chunks.findIndex((c) => c.label === ref);
    return at >= 0 ? { number: at + 1, label: ref } : { label: ref };
}

// the chunk an advance marked done, from the record's chunk-done events: the one nearest the call's time, else the latest
function advancedChunk(effort: Effort | undefined, ts: number | undefined): { chunk: ChunkFacts; text?: string } {
    const done = (effort?.events ?? []).filter((e) => e.kind === "chunk-done" && e.label);
    if (done.length === 0) {
        return { chunk: {} };
    }
    let pick = done[done.length - 1];
    if (ts != null) {
        const nearest = done.reduce((a, b) => (Math.abs(b.ts - ts) < Math.abs(a.ts - ts) ? b : a));
        if (Math.abs(nearest.ts - ts) <= ADVANCE_MATCH_MS) {
            pick = nearest;
        }
    }
    return { chunk: resolveChunk(pick.label, effort), text: pick.text };
}

function lastIndexOfLabel(effort: Effort | undefined, label: string): number {
    const labels = (effort?.chunks ?? []).map((c) => c.label);
    return labels.lastIndexOf(label);
}

function createdCard(call: WshCall, efforts: EffortSummary[] | undefined, error?: string): InitiativeCard {
    const title = call.args[0] ?? "";
    const ticket = flagText(call, "ticket");
    const match = (efforts ?? [])
        .filter((e) => e.title === title && (ticket == null || e.ticket === ticket))
        .sort((a, b) => b.updatedts - a.updatedts)[0];
    const card: InitiativeCard = { kind: "initiative-created", title, chunks: [] };
    if (ticket) card.ticket = ticket;
    if (!match) {
        if (error) card.error = error;
        return card;
    }
    card.effortId = bareEffortId(match.oref);
    if (match.project) card.project = match.project;
    card.chunks = (match.chunks ?? []).map((c, i) => ({ number: i + 1, label: c.label }));
    card.progress = { done: match.done, total: match.total };
    return card;
}

export function buildInitiativeCard(key: string, call: WshCall, src: CardSource): InitiativeCard {
    if (key === "effort-create") {
        return createdCard(call, src.efforts, src.error);
    }
    const { effort } = src;
    const effortId = bareEffortId(call.args[0] ?? "");
    const base: CardBase = { effortId, ...(!effort && src.error ? { error: src.error } : {}) };
    const note = flagText(call, "note");
    switch (key) {
        case "effort-advance": {
            const advanced = advancedChunk(effort, src.ts);
            return doneCard(base, advanced.chunk, note ?? advanced.text, effort);
        }
        case "chunk-add": {
            const label = call.args[1] ?? "";
            const at = Number(flagText(call, "at"));
            const number = at > 0 ? at : lastIndexOfLabel(effort, label) + 1 || undefined;
            return {
                ...base,
                kind: "chunk-added",
                chunk: number != null ? { number, label } : { label },
                ...(effort ? { initiative: effort.title } : {}),
            };
        }
        case "chunk-note":
            return {
                ...base,
                kind: "chunk-noted",
                chunk: resolveChunk(call.args[1], effort),
                ...(note ? { note } : {}),
            };
    }
    const chunk = resolveChunk(call.args[1], effort);
    const status = call.args[2] ?? "";
    if (status === "done") {
        return doneCard(base, chunk, note, effort);
    }
    if (status === "blocked") {
        return { ...base, kind: "chunk-blocked", chunk, ...(note ? { needs: note } : {}) };
    }
    return { ...base, kind: "chunk-status", chunk, status };
}

function doneCard(base: CardBase, chunk: ChunkFacts, note: string | undefined, effort?: Effort): InitiativeCard {
    return {
        ...base,
        kind: "chunk-done",
        chunk,
        ...(note ? { note } : {}),
        ...(effort ? { progress: progressOf(effort), title: effort.title } : {}),
    };
}

export interface ShowRow {
    number: number;
    label: string;
    tone: ChunkTone;
    notes: number;
}
export interface EffortShowModel {
    title: string;
    project?: string;
    status: string;
    done: number;
    total: number;
    rows: ShowRow[];
    // how many of rows draw before "N more chunks"
    shown: number;
}

export function effortShowModel(effort: Effort): EffortShowModel {
    const { done, total } = progressOf(effort);
    const rows = effort.chunks.map((c, i) => ({
        number: i + 1,
        label: c.label,
        tone: chunkTone(c.status),
        notes: c.notes?.length ?? 0,
    }));
    return {
        title: effort.title,
        project: effort.project,
        status: effort.status,
        done,
        total,
        rows,
        shown: Math.min(rows.length, SHOW_CHUNKS_SHOWN),
    };
}

export interface ListRow {
    id: string;
    title: string;
    ticket?: string;
    done: number;
    total: number;
    fraction: number;
    current?: string;
}
export interface EffortListModel {
    rows: ListRow[];
    // how many of rows draw before "N more initiatives"
    shown: number;
}

export function effortListModel(efforts: EffortSummary[]): EffortListModel {
    const rows = efforts.map((e) => ({
        id: bareEffortId(e.oref),
        title: e.title,
        ticket: e.ticket,
        done: e.done,
        total: e.total,
        fraction: e.total > 0 ? e.done / e.total : 0,
        current: e.activechunk,
    }));
    return { rows, shown: Math.min(rows.length, LIST_ROWS_SHOWN) };
}

// what `wsh effort list` asked for, and the cache key its result lives under (a plain list is the one shared key)
export function effortListRequest(call: WshCall): { key: string; includearchived: boolean; project?: string } {
    const includearchived = call.flags["archived"] === true;
    const project = flagText(call, "project");
    if (!includearchived && project == null) {
        return { key: "efforts", includearchived };
    }
    return {
        key: `efforts:${includearchived ? "archived" : ""}:${project ?? ""}`,
        includearchived,
        ...(project ? { project } : {}),
    };
}

// a created initiative's chunk rows are capped like the Brief's chips
export const CREATED_CHUNKS_SHOWN = CHIP_CAP;
