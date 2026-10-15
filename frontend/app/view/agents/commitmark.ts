// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The commit tick on an agent's card and tree row: the turn that just ended committed the agent's work.
// `wsh agent-hook` stamps the agent's block with the time of its last successful `git commit`, of its last
// file edit, and of its latest prompt (wshcmd-agenthook.go workStampKey). A working agent shows no tick even
// after a commit, so the tick never reads as "done" mid-run, and a commit from an earlier turn does not carry
// over. Edits made through Bash (sed, scripts) are not stamped.

/** Pure: is the agent done (idle, no background shell tasks), having committed this turn and not edited since? */
export function hasCommittedWork(meta: MetaType | undefined, done: boolean): boolean {
    if (!done) {
        return false;
    }
    const committed = meta?.["agent:lastcommitts"] ?? 0;
    const since = Math.max(meta?.["agent:lasteditts"] ?? 0, meta?.["agent:turnstartts"] ?? 0);
    return committed > 0 && committed > since;
}
