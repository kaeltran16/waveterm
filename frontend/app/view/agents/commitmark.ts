// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The commit tick on an agent's card and tree row. `wsh agent-hook` stamps the agent's block with the time
// of its last successful `git commit` and of its last file edit (wshcmd-agenthook.go workStampKey). The tick
// means "its latest work is committed": a long-running agent that edits again after a commit loses it until
// the next commit. Edits made through Bash (sed, scripts) are not stamped.

/** Pure: has the agent committed, and not edited a file since? */
export function hasCommittedWork(meta: MetaType | undefined): boolean {
    const committed = meta?.["agent:lastcommitts"] ?? 0;
    return committed > 0 && committed > (meta?.["agent:lasteditts"] ?? 0);
}
