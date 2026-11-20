// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The workspace pane's Docs tab, pure: the rows the agent's Docs list draws (AgentDocsCommand's docs), which of them
// shows before the fold, and which one the tab renders.

import { sameRepoPath } from "@/util/paths";
import { relativeToCwd } from "./permissionmodel";

// rows shown before "Show N more"
export const DOCS_SHOWN = 6;

export type DocRow = {
    // absolute, as the server lists it
    path: string;
    // the path relative to the agent's cwd, absolute outside it
    rel: string;
    name: string;
    // rel's folder, "" at the cwd itself
    folder: string;
    // "written 10:05", "edited 11-03", or "gone"
    when: string;
    // when's two halves, for the narrow layout that drops the verb; a gone doc has no verb
    verb: string | null;
    time: string;
    ts: number;
    gone: boolean;
};

const pad = (n: number) => String(n).padStart(2, "0");

// HH:MM today, MM-DD on any other day, in local time
function stamp(ts: number, now: Date): string {
    const d = new Date(ts);
    const today =
        d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    return today ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function splitPath(path: string): { folder: string; name: string } {
    const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    return i < 0 ? { folder: "", name: path } : { folder: path.slice(0, i), name: path.slice(i + 1) };
}

export function docRows(docs: AgentDoc[], cwd: string | null, now: Date): DocRow[] {
    return [...docs]
        .sort((a, b) => b.ts - a.ts)
        .map((d) => {
            const rel = relativeToCwd(d.path, cwd ?? undefined);
            const gone = d.gone === true;
            const time = gone ? "gone" : stamp(d.ts, now);
            const verb = gone ? null : d.verb;
            return {
                path: d.path,
                rel,
                name: splitPath(d.path).name,
                folder: splitPath(rel).folder,
                when: verb == null ? time : `${verb} ${time}`,
                verb,
                time,
                ts: d.ts,
                gone,
            };
        });
}

// expanded: the user asked for the rest; a selected doc past the fold opens it too, or the shown doc has no row
export function docsFold(
    rows: DocRow[],
    expanded: boolean,
    selected: string | null
): { shown: DocRow[]; more: string | null } {
    const past = selected != null && rows.slice(DOCS_SHOWN).some((r) => sameRepoPath(r.path, selected));
    if (expanded || past || rows.length <= DOCS_SHOWN) {
        return { shown: rows, more: null };
    }
    return { shown: rows.slice(0, DOCS_SHOWN), more: `Show ${rows.length - DOCS_SHOWN} more` };
}

// null, or a path the list no longer holds, is the newest doc
export function selectedDocRow(rows: DocRow[], selected: string | null): DocRow | null {
    const hit = selected == null ? null : rows.find((r) => sameRepoPath(r.path, selected));
    return hit ?? rows[0] ?? null;
}
