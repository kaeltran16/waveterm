// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The pure half of starting a run from the New run window. A project is the only thing the user names: the
// channel a run needs is storage (CreateRunCommand requires a channelid, and copies the worker cwd and the
// resolved profile off it), so it is resolved by path or minted on the spot rather than created by hand.
// That is why this is a decision and not a create call — a create call cannot be unit-tested, and getting
// "does this project already have a channel" wrong is how you end up with the duplicates we are removing.

import { fuzzyScore } from "@/app/cockpit/palette-match";
import { resolveTargetChannel } from "@/app/view/agents/channelderive";
import { appendAttachments, type Attachment } from "@/app/view/agents/composerattachments";
import { DEFAULT_START, type DesignFirst, type RunShape, type StartFrom } from "@/app/view/agents/runconfig";

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
    parallelism: number;
    workerRoute: RoutePin | null;
    start: StartFrom;
    planPath: string;
    reviewerPicks: boolean;
    reviewerRoute: RoutePin | null;
    lightReviewerRoute: RoutePin | null;
    autonomous: boolean;
    // the approved design, sent on a design start only: a brainstorm's spec and a canvas's board; absolute, since
    // a run's worktree has no copy of the design folder
    spec?: string;
    prototype?: string;
    // a goal start's Design first; absent is off
    designFirst?: DesignFirst;
}

export interface LaunchOpts {
    mode: string;
    parallelism?: number;
    workerRoute?: RoutePin;
    planPath?: string;
    reviewerPicks?: boolean;
    reviewerRoute?: RoutePin;
    lightReviewerRoute?: RoutePin;
    spec?: string;
    prototype?: string;
    designFirst?: DesignFirst;
    autonomous?: boolean;
}

// What the launcher's controls mean as CreateRun's arguments. The mode cannot simply be omitted: the server
// reads an unset mode as `quick` (resolveRunPlan). Every orchestrator run is an engine run, so the machine
// is the server's to set. reviewerPicks goes out even when false: the server reads an unset one as the
// profile's, and the launcher has already shown the user the profile's answer and let them change it. autonomous
// goes out the same way, and never on quick, which the server refuses it on. The design rides only its own
// start, so switching to Goal or Plan file launches a run that never sees it.
export function launchOptsFromConfig(config: RunConfig): LaunchOpts {
    const {
        shape,
        parallelism,
        workerRoute,
        start,
        planPath,
        reviewerPicks,
        reviewerRoute,
        lightReviewerRoute,
        spec,
        prototype,
        designFirst,
        autonomous,
    } = config;
    if (shape !== "orchestrator") {
        return { mode: shape };
    }
    return {
        mode: shape,
        parallelism,
        ...(workerRoute != null ? { workerRoute } : {}),
        ...(start === "plan" ? { planPath: planPath.trim() } : {}),
        reviewerPicks,
        ...(reviewerRoute != null ? { reviewerRoute } : {}),
        ...(lightReviewerRoute != null ? { lightReviewerRoute } : {}),
        ...(start === "design" && spec ? { spec } : {}),
        ...(start === "design" && prototype ? { prototype } : {}),
        ...(start === "goal" && designFirst ? { designFirst } : {}),
        autonomous,
    };
}

// The goal a launch sends. A plan start sends none: the server names the run by its plan, and a goal typed
// before switching to the plan is hidden, so it must not name a run the user can no longer see it on. The
// goal's attachments hide with it, and otherwise reach the run as paths appended to the goal text.
export function launchGoal(
    config: Pick<RunConfig, "shape" | "start">,
    goal: string,
    attachments: Attachment[] = []
): string {
    return config.shape === "orchestrator" && config.start === "plan"
        ? ""
        : appendAttachments(goal.trim(), attachments);
}

// Which project + Run opens on. The modal is rebuilt on every open (NewRunControl unmounts it on close),
// so the remembered name is checked against the registry as it stands now: a project unregistered since
// must not preselect a row that is no longer there. One project is not a choice, so it preselects either
// way — which is also the answer before anything has been remembered.
export function initialPick(names: string[], remembered: string | null): string | null {
    if (remembered != null && names.includes(remembered)) {
        return remembered;
    }
    return names.length === 1 ? names[0] : null;
}

// onStarted hears the id of a run this launch starts, so what filled the window can follow it; with it set,
// the window does not switch to the run's Brief
export type NewRunPrefill = {
    projectName: string;
    goal: string;
    shape: RunShape;
    // an approved design: a brainstorm's spec, a canvas's board; both absolute
    spec?: string;
    prototype?: string;
    onStarted?: (runId: string) => void;
};

// What the window opens on when something filled it (a brainstorm's Approve, a canvas's Build this…, the palette's
// Quick and Orchestrate): the prefill's shape on the goal start, except that a design only rides an orchestrator
// run, so one that came with a spec or a prototype opens an orchestrator on the Approved design start. The project
// is picked only if it is registered, as initialPick does.
export function prefillToLaunch(
    prefill: NewRunPrefill,
    projectNames: string[]
): { picked: string | null; shape: RunShape; start: StartFrom; goal: string; spec: string; prototype: string } {
    const { projectName, goal } = prefill;
    const spec = prefill.spec ?? "";
    const prototype = prefill.prototype ?? "";
    const hasDesign = spec !== "" || prototype !== "";
    return {
        picked: projectName !== "" && projectNames.includes(projectName) ? projectName : null,
        shape: hasDesign ? "orchestrator" : prefill.shape,
        start: hasDesign ? "design" : DEFAULT_START,
        goal,
        spec,
        prototype,
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
