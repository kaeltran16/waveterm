// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// An expanded initiative's plan, flattened into the Brief's own row list.
//
// The Brief has one cursor: briefsurface publishes `navIds` to useSurfaceListNav, and j/k walks it.
// An inline tracker that kept its own ↑/↓ would be a second cursor fighting the first, so the chunk
// rows of an expanded initiative are spliced INTO that list instead — j/k falls into the plan and
// back out of it, and Enter on a chunk opens its notes the same way Enter on a line opens its target.
//
// Stage headers render but are not navigable: they carry no content of their own, and stopping the
// cursor on them would put two dead rows between every group of chunks.
//
// Pure: no React.

import type { BriefLine } from "./briefrows";
import { groupChunksByStage, nextChunk } from "./effortmodel";
import type { ChunkRowModel } from "./effortstore";

export type TrackerRow =
    | { kind: "line"; id: string; line: BriefLine; expanded: boolean }
    | {
          kind: "facts";
          id: string;
          oref: string;
          count: string;
      }
    | {
          kind: "stage";
          id: string;
          oref: string;
          stage: string;
          fraction: string;
          done: number;
          total: number;
          collapsed: boolean;
          at: number;
          first: boolean;
      }
    | { kind: "chunk"; id: string; oref: string; row: ChunkRowModel; notes: number; next: boolean }
    | { kind: "pending"; id: string; oref: string; message: string };

// The rows that make up an expanded initiative's block — every TrackerRow except the Brief lines the
// plan is spliced between. InitiativeDetail draws exactly these.
export type DetailRow = Exclude<TrackerRow, { kind: "line" }>;

// A line is expandable when it stands for an effort. Only the "Initiatives" region builds those from
// initiativeLine; a Behind-you digest names the same effort but is a day's summary, not the object.
export function expandableORef(line: BriefLine): string | null {
    if (!line.id.startsWith("initiatives:")) {
        return null;
    }
    const target = line.target;
    return target != null && "oref" in target && target.oref.startsWith("effort:") ? target.oref : null;
}

export const chunkRowId = (lineId: string, label: string): string => `${lineId}/chunk:${label}`;
// position-keyed, because a stage is a label on a run of chunks and the same name can head two runs.
// This doubles as the key an explicit collapse/expand is stored under, so there is one identifier,
// not a row id and a separate override key that can drift apart.
export const stageRowId = (lineId: string, stage: string, at: number): string => `${lineId}/stage:${at}:${stage}`;

/**
 * Which stages start open when an initiative is first expanded — the design's rule (design L1357): a
 * stage of two or more chunks that is entirely done starts folded; every other stage starts open. An
 * explicit toggle always wins over this default.
 */
export function stageStartsOpen(group: { rows: ChunkRowModel[] }): boolean {
    const done = group.rows.filter((r) => r.status === "done").length;
    return !(group.rows.length > 1 && done === group.rows.length);
}

/**
 * The Brief's visible lines with the open initiative's plan spliced in after its row.
 *
 * `chunks` is null while the effort detail is still loading — the row still expands, so the click
 * lands somewhere, and says so rather than flickering an empty plan.
 */
export function trackerRows(args: {
    lines: BriefLine[];
    openLineId: string | null;
    chunks: ChunkRowModel[] | null;
    noteCounts: Map<string, number>;
    stageOverrides: Record<string, boolean>;
}): TrackerRow[] {
    const { lines, openLineId, chunks, noteCounts, stageOverrides } = args;
    const out: TrackerRow[] = [];
    for (const line of lines) {
        const oref = expandableORef(line);
        const expanded = oref != null && line.id === openLineId;
        out.push({ kind: "line", id: line.id, line, expanded });
        if (!expanded || oref == null) {
            continue;
        }
        if (chunks == null) {
            out.push({ kind: "pending", id: line.id + "/pending", oref, message: "Loading this initiative's plan…" });
            continue;
        }
        if (chunks.length === 0) {
            out.push({ kind: "pending", id: line.id + "/pending", oref, message: "No chunks on this initiative yet." });
            continue;
        }
        const doneN = chunks.filter((c) => c.status === "done").length;
        out.push({
            kind: "facts",
            id: line.id + "/facts",
            oref,
            count: `${chunks.length} chunk${chunks.length === 1 ? "" : "s"} · ${doneN} done`,
        });
        const next = nextChunk(chunks);
        groupChunksByStage(chunks).forEach((group, at) => {
            const id = stageRowId(line.id, group.stage, at);
            const open = stageOverrides[id] ?? stageStartsOpen(group);
            out.push({
                kind: "stage",
                id,
                oref,
                stage: group.stage,
                fraction: group.fraction,
                done: group.done,
                total: group.total,
                collapsed: !open,
                at,
                first: at === 0,
            });
            if (!open) {
                return;
            }
            for (const row of group.rows) {
                out.push({
                    kind: "chunk",
                    id: chunkRowId(line.id, row.label),
                    oref,
                    row,
                    notes: noteCounts.get(row.label) ?? 0,
                    next: next != null && row.label === next.label,
                });
            }
        });
    }
    return out;
}

// Stage headers and the facts/pending rows carry no primary action, so the cursor skips them.
export function trackerNavIds(rows: TrackerRow[]): string[] {
    return rows.filter((r) => r.kind === "line" || r.kind === "chunk").map((r) => r.id);
}
