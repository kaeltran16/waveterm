// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Transcript projection registry: maps a coding agent to the pure projector for its transcript
// format. AgentEntry[] is the shared, format-neutral contract every consumer renders, so adding a
// new agent (e.g. opencode) is a new projector file + one entry here + its tests — nothing else.

import type { AgentEntry, CardTask } from "./agentsviewmodel";
import { extractCodexTasks, projectCodexTranscript } from "./codextranscriptprojection";
import { extractAiTitle, extractTasks, projectTranscript } from "./transcriptprojection";

export interface TranscriptProjector {
    project(lines: string[]): AgentEntry[];
    // optional because title derivation is format-specific and not yet implemented for every agent
    extractTitle?(lines: string[]): string | undefined;
    // optional because a card task list needs a TodoWrite-equivalent; Codex maps its update_plan
    extractTasks?(lines: string[]): CardTask[] | undefined;
}

const PROJECTORS: Record<string, TranscriptProjector> = {
    claude: { project: projectTranscript, extractTitle: extractAiTitle, extractTasks },
    codex: { project: projectCodexTranscript, extractTasks: extractCodexTasks },
};

const DEFAULT_AGENT = "claude";

// Fallback when the agent identity is missing/unknown: infer the format from the transcript path.
// `.claude` is checked first because a Claude transcript path always contains it but may also
// contain `.codex` (e.g. Claude working on codex tooling); a Codex rollout path never contains
// `.claude`, so this ordering disambiguates correctly.
function agentFromPath(path?: string): string | undefined {
    if (!path) {
        return undefined;
    }
    if (path.includes(".claude")) {
        return "claude";
    }
    if (path.includes(".codex")) {
        return "codex";
    }
    return undefined;
}

/** Pure: pick the projector for an agent. The explicit agent identity wins; the transcript path is
 *  a resilience fallback; anything unrecognized defaults to Claude. Never returns undefined. */
export function projectorFor(agent?: string, transcriptPath?: string): TranscriptProjector {
    const key = (agent && PROJECTORS[agent] ? agent : undefined) ?? agentFromPath(transcriptPath) ?? DEFAULT_AGENT;
    return PROJECTORS[key] ?? PROJECTORS[DEFAULT_AGENT];
}
