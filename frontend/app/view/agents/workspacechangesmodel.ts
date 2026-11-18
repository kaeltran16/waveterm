// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure: what the workspace pane's Changes tab draws from the rail's git read (railStateAtom), so the tab, the rail
// and the header chip count the same files.

import { fileTotals } from "./agentrailmodel";
import { firstInList } from "./filetree";
import type { GitChange } from "./gitstatus";
import type { RailGitState } from "./railstore";

export type ChangesView = "loading" | "failed" | "norepo" | "clean" | "files";

export function changesView(rail: RailGitState | null): ChangesView {
    if (rail == null) {
        return "loading";
    }
    if (rail.failure != null) {
        return "failed";
    }
    if (!rail.isRepo || rail.changes == null) {
        return "norepo";
    }
    return rail.changes.files.length === 0 ? "clean" : "files";
}

// the tab's selection while the list has it, else the first file the list draws
export function changesShown(files: GitChange[], selected: string | null, tree: boolean): string | null {
    if (selected != null && files.some((f) => f.path === selected)) {
        return selected;
    }
    return firstInList(files, tree) ?? null;
}

// "N files +A −D · <branch>, <scope>": the scope is the base the list was read against
export function changesLine(rail: RailGitState): { count: string; adds: number; dels: number; where: string } {
    const scope = rail.ref ? "since session start" : "uncommitted";
    return {
        ...fileTotals(rail.changes?.files ?? []),
        where: rail.branch ? `${rail.branch}, ${scope}` : scope,
    };
}
