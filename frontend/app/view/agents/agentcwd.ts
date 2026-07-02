// frontend/app/view/agents/agentcwd.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: extract the agent's working directory from raw transcript JSONL lines. Claude records
// carry a top-level "cwd"; Codex carries it on the session_meta record (payload.cwd). Returns the
// first cwd found, or null. No React, no Wave imports. Codex's session_meta is the FIRST line, so a
// long session scrolls it off the tail — resolveCwd falls back to a head read for that case.

export function agentCwd(lines: string[]): string | null {
    for (const line of lines) {
        const t = line.trim();
        if (!t) {
            continue;
        }
        let obj: any;
        try {
            obj = JSON.parse(t);
        } catch {
            continue;
        }
        if (typeof obj?.cwd === "string" && obj.cwd) {
            return obj.cwd; // Claude
        }
        if (obj?.type === "session_meta" && typeof obj?.payload?.cwd === "string" && obj.payload.cwd) {
            return obj.payload.cwd; // Codex
        }
    }
    return null;
}
