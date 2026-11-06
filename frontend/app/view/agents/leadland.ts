// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure: what a run lead's rail says once its run has landed. The land removes the run's worktree, so the rail's
// own git read of it would say "Branch —" and "Not a git repository".

import type { RunInfo } from "./runlineage";

// git's short form of a hash
const SHORT_SHA = 7;

export interface LeadLandFacts {
    branch: string;
    files: string;
    commits: { sha: string; subject: string }[];
}

/** Pure: the Branch line, the Files touched note and the landed commits of a run that has landed; null otherwise.
 *  A commit's subject is its task's label, as the run sheet names it. */
export function leadLandFacts(run: RunInfo | undefined): LeadLandFacts | null {
    if (run?.land?.state !== "landed") {
        return null;
    }
    const where = run.base ? `landed on ${run.base}` : "landed";
    const commit = run.land.commit?.slice(0, SHORT_SHA);
    const labels = new Map((run.dag?.tasks ?? []).map((t) => [t.id, t.label] as const));
    return {
        branch: commit ? `${where} · ${commit}` : where,
        files: "worktree removed after landing",
        commits: (run.digest?.report?.commits ?? []).map((c) => ({
            sha: c.commit.slice(0, SHORT_SHA),
            subject: labels.get(c.taskid) || c.taskid,
        })),
    };
}
