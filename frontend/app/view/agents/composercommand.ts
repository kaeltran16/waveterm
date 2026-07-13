// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure logic for the merged Channels surface's two-face composer. The Launch face is a plain goal input
// driven by a curated `@`-command vocabulary — @quick/@run/@ask — that sets the launch mode (a bare goal
// defaults to @run). parseComposerCommand strips the command; runFooterFor renders the channel's resolved
// run strategy (from ⚙) as a one-liner; composerFace picks Launch vs Talk from whether the selected run
// has a live worker. No React/jotai — unit-tested in composercommand.test.ts.

import { steerTarget } from "./runmodel";
import type { AgentVM } from "./agentsviewmodel";

export type LaunchMode = "quick" | "run" | "ask";
export interface ComposerCommand {
    mode: LaunchMode;
    runtime?: string;
    body: string;
}

export const LAUNCH_COMMANDS: { cmd: string; mode: LaunchMode; desc: string }[] = [
    { cmd: "@quick", mode: "quick", desc: "one worker, no phases" },
    { cmd: "@run", mode: "run", desc: "managed run · channel strategy" },
    { cmd: "@ask", mode: "ask", desc: "one-shot consult · no worker" },
];

const KNOWN_RUNTIMES = new Set(["claude", "codex", "antigravity"]);

// Parse a Launch-face draft into its mode + goal. Only a leading `@quick`/`@run`/`@ask` token is a
// command; a mid-text `@` (e.g. "add @mentions") is left in the goal and defaults to run. `@ask` accepts
// an optional runtime override as its first word (`@ask codex …`); an unknown first word stays in the body.
export function parseComposerCommand(text: string): ComposerCommand {
    const trimmed = text.trim();
    const m = /^@(quick|run|ask)\b\s*([\s\S]*)$/i.exec(trimmed);
    if (!m) {
        return { mode: "run", body: trimmed };
    }
    const mode = m[1].toLowerCase() as LaunchMode;
    const rest = m[2].trim();
    if (mode === "ask") {
        const rm = /^(\w+)\s+([\s\S]*)$/.exec(rest);
        if (rm && KNOWN_RUNTIMES.has(rm[1].toLowerCase())) {
            return { mode, runtime: rm[1].toLowerCase(), body: rm[2].trim() };
        }
    }
    return { mode, body: rest };
}

// One-line description of what an `@run` will do, given the channel's resolved Jarvis profile (set in ⚙).
// The strategy (pipeline|orchestrator + plan gate) is the channel's setting, never chosen per-dispatch.
export function runFooterFor(profile: JarvisProfile | undefined): string {
    if (profile?.defaultmode === "orchestrator") {
        return "→ adaptive lead · splits the work · set in ⚙";
    }
    const gate = profile?.defaultplangate ?? true;
    return gate ? "→ pipeline run · stops at a review gate · set in ⚙" : "→ pipeline run · no gate · set in ⚙";
}

// The composer's face: Talk when the selected run has a live worker to message (the old "Steer" target),
// else Launch. A run has at most one live worker at a time (phases are sequential), so the target is
// never ambiguous.
export function composerFace(
    run: Run | undefined,
    agents: AgentVM[]
): { face: "launch" } | { face: "talk"; worker: AgentVM } {
    const worker = run ? steerTarget(run, agents) : undefined;
    return worker ? { face: "talk", worker } : { face: "launch" };
}
