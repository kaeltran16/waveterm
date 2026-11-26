// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure: join on-disk subagent files (SubagentFileInfo, from GetSubagentsCommand) to the parent's Task
// spawns (SubagentSpawn): by the toolUseId the file's meta names, else by prompt-match. type + outcome come
// from the matched spawn and the file's own facts; an unmatched file (spawn not yet in the tailed parent
// window) takes its meta's type, else a prompt-derived label. SubagentFileInfo is a generated global type
// (gotypes.d.ts).
//
// Prompt match, the fallback for a file with no meta (Phase 0 spike, 2026-07-09): normalized-exact prompt
// equality. 582/606 (96%) of real child files match this way; the 24 that don't are workflow-orchestrated
// subagents whose parent has no Task tool_use (16) or a substantively-different prompt (7) — a prefix compare
// would rescue only 1 while risking false-positive collisions, so it was rejected.

import type { SubagentState, SubagentVM } from "./session-models/sessionviewmodel";
import { subagentCallEntry, type SubagentSpawn } from "./transcriptprojection";

const FALLBACK_LABEL_MAX = 40;

function normPrompt(p: string): string {
    return p.trim().replace(/\s+/g, " ");
}

function firstLineLabel(prompt: string): string {
    const line = prompt.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
    return line.length > FALLBACK_LABEL_MAX ? line.slice(0, FALLBACK_LABEL_MAX) : line;
}

// Outcome precedence: a stopped file (the user stopped it) wins; then the spawn's tool_result or a background
// spawn's notification, which alone tells success from failure; then a finished file, as the neutral "done" (a
// finished child ends its step before the parent's result lands, so no spinner freezes); then the parent's session
// ending, which loses an unfinished child as "stopped"; else it still works.
function resolveState(spawn: SubagentSpawn | undefined, f: SubagentFileInfo, parentEnded: boolean): SubagentState {
    if (f.stopped) {
        return "stopped";
    }
    if (spawn?.done) {
        return spawn.failed ? "failure" : "success";
    }
    if (f.done) {
        return "done";
    }
    return parentEnded ? "stopped" : "working";
}

// a file's spawn: the one its meta names, else (a file with no meta) the first unclaimed spawn with its prompt
function matchSpawns(spawns: SubagentSpawn[], files: SubagentFileInfo[]): (SubagentSpawn | undefined)[] {
    const byId = new Map(spawns.map((s) => [s.toolUseId, s]));
    const claimed = new Set(files.map((f) => f.tooluseid).filter((id) => id != null && id !== ""));
    const byPrompt = new Map<string, SubagentSpawn[]>();
    for (const s of spawns) {
        if (claimed.has(s.toolUseId)) {
            continue;
        }
        const key = normPrompt(s.prompt);
        const bucket = byPrompt.get(key);
        if (bucket) {
            bucket.push(s);
        } else {
            byPrompt.set(key, [s]);
        }
    }
    // shift() consumes the match so parallel same-prompt spawns pair 1:1 with files in order
    return files.map((f) => (f.tooluseid ? byId.get(f.tooluseid) : byPrompt.get(normPrompt(f.firstprompt))?.shift()));
}

export function correlateSubagents(
    spawns: SubagentSpawn[],
    files: SubagentFileInfo[],
    opts: { parentEnded?: boolean } = {}
): SubagentVM[] {
    const matched = matchSpawns(spawns, files);
    return files.map((f, i) => {
        const spawn = matched[i];
        const state = resolveState(spawn, f, opts.parentEnded === true);
        const type = spawn?.subagentType || f.agenttype || firstLineLabel(f.firstprompt) || "subagent";
        const toolUseId = f.tooluseid || spawn?.toolUseId;
        const description = f.description || spawn?.description;
        const currentCall = state === "working" && f.currentcall ? subagentCallEntry(f.currentcall) : undefined;
        return {
            id: f.agentid,
            type,
            state,
            background: spawn?.background === true || f.background === true,
            transcriptPath: f.transcriptpath,
            startedAtMs: f.startedatms,
            toolCount: f.toolcount,
            ...(f.endedatms ? { endedAtMs: f.endedatms } : {}),
            ...(toolUseId ? { toolUseId } : {}),
            ...(description ? { description } : {}),
            ...(currentCall ? { currentCall } : {}),
        };
    });
}
