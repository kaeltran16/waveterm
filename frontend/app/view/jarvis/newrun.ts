// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The pure half of starting a run from the Brief header. A project is the only thing the user names: the
// channel a run needs is storage (CreateRunCommand requires a channelid, and copies the worker cwd and the
// resolved profile off it), so it is resolved by path or minted on the spot rather than created by hand.
// That is why this is a decision and not a create call — a create call cannot be unit-tested, and getting
// "does this project already have a channel" wrong is how you end up with the duplicates we are removing.

import { fuzzyScore } from "@/app/cockpit/palette-match";
import { resolveTargetChannel } from "@/app/view/agents/channelderive";
import type { RunShape } from "@/app/view/agents/composercommand";
import type { Orchestration } from "@/app/view/agents/orchestratorpicker";

export type ChannelTarget = { kind: "existing"; oid: string } | { kind: "create"; name: string; path: string };

// Null means the channel list has not arrived. That is not the same as "this project has no channel", and
// the difference is load-bearing: minting one on an unread list creates a duplicate of a channel we simply
// could not see yet, which is the exact state this modal exists to stop producing.
export function resolveChannelTarget(
    channels: Channel[] | null,
    projectName: string,
    projectPath: string
): ChannelTarget | null {
    if (channels == null) {
        return null;
    }
    const existing = resolveTargetChannel(channels, projectPath);
    if (existing != null) {
        return { kind: "existing", oid: existing.oid };
    }
    // named after the project, because the project is the only name for it a user will ever see
    return { kind: "create", name: projectName, path: projectPath };
}

export interface RunConfig {
    shape: RunShape;
    orchestration: Orchestration;
    parallelism: number;
    workerRoute: RoutePin | null;
}

export interface LaunchOpts {
    mode: string;
    orchestration?: string;
    parallelism?: number;
    workerRoute?: RoutePin;
}

// What the launcher's controls mean as CreateRun's arguments. The mode cannot simply be omitted: the
// server reads an unset mode as `quick` (resolveRunPlan), so a project configured as `pipeline` would
// silently get a quick run. The dials below the shape describe an engine orchestrator only — an adaptive
// lead dispatches its own subagents, so a width and a worker route there would promise a fan-out that
// never happens, which is the same reason runLauncherFace hides them.
export function launchOptsFromConfig(config: RunConfig): LaunchOpts {
    const { shape, orchestration, parallelism, workerRoute } = config;
    if (shape !== "orchestrator") {
        return { mode: shape };
    }
    const engine = orchestration === "engine";
    return {
        mode: shape,
        orchestration,
        ...(engine ? { parallelism } : {}),
        ...(engine && workerRoute != null ? { workerRoute } : {}),
    };
}

// Which projects a typed query leaves, best first. Reuses the palette's scorer so one query language
// covers both places a project is picked by name. An empty query is not a filter: the registry's own
// order stands rather than being re-sorted into a ranking the user never asked for.
export function rankProjects(names: string[], query: string): string[] {
    const q = query.trim();
    if (q === "") {
        return names;
    }
    return names
        .map((name, index) => ({ name, index, score: fuzzyScore(q, name) }))
        .filter((row): row is { name: string; index: number; score: number } => row.score != null)
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .map((row) => row.name);
}

// Arrow-key movement over the filtered rows. It wraps, because a list this short has no scrollbar to say
// an end was reached and a selection that silently stops reads as broken. A `current` the filter has since
// removed is not a position to step from, so the move restarts at the end the user is heading toward.
export function stepPick(rows: string[], current: string | null, delta: number): string | null {
    if (rows.length === 0) {
        return null;
    }
    const at = current == null ? -1 : rows.indexOf(current);
    if (at < 0) {
        return delta > 0 ? rows[0] : rows[rows.length - 1];
    }
    return rows[(at + delta + rows.length) % rows.length];
}
