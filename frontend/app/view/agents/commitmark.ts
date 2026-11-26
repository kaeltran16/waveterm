// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The commit mark on an agent's card and tree row: the turn that just ended committed the agent's work.
// `wsh agent-hook` stamps the agent's block with the time of its last successful `git commit`, of its last
// file edit, and of its latest prompt (wshcmd-agenthook.go workStampKey), and with the commit's branch when it
// was made in a linked worktree. A working agent shows no mark even after a commit, so the mark never reads as
// "done" mid-run, and a commit from an earlier turn does not carry over. Edits made through Bash (sed,
// scripts) are not stamped. A worktree commit is not landed until its branch merges, so it shows the branch
// in place of the tick.

export type CommitMark = { kind: "tick" } | { kind: "branch"; branch: string };

/** Pure: the mark for an agent done (idle, no background shell tasks), having committed this turn and not
 * edited since; null otherwise. */
export function commitMark(meta: MetaType | undefined, done: boolean): CommitMark | null {
    if (!done) {
        return null;
    }
    const committed = meta?.["agent:lastcommitts"] ?? 0;
    const since = Math.max(meta?.["agent:lasteditts"] ?? 0, meta?.["agent:turnstartts"] ?? 0);
    if (committed <= 0 || committed <= since) {
        return null;
    }
    const branch = meta?.["agent:lastcommitbranch"];
    return branch ? { kind: "branch", branch } : { kind: "tick" };
}
