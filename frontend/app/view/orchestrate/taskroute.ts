// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Where a task's worker and reviewer models come from. taskRoute mirrors effectiveTaskRoute
// (pkg/orchestrate/modelroute.go) and reviewerRouteOf mirrors reviewerRoute (stagesession.go): the graph names
// sources the engine does not send, so it derives them by the same rule.

import { shortModel } from "../agents/modelname";

// the engine's default runtime for a route that names only a model (runroute.DefaultRuntime)
const DEFAULT_RUNTIME = "claude";

// the route a Light pick sends (orchestrate.LightPickRoute)
export const LIGHT_PICK: RoutePin = { runtime: "claude", model: "sonnet" };

export type RouteSource = "plan" | "reviewer" | "owner" | "escalation" | "pinned" | "workers" | "inherited";

function route(runtime: string | undefined, model: string | undefined): RoutePin {
    return { runtime: runtime || DEFAULT_RUNTIME, ...(model ? { model } : {}) };
}

function names(pin: { runtime?: string; model?: string } | undefined): boolean {
    return pin != null && (!!pin.runtime || !!pin.model);
}

function leadRoute(owner: Run): RoutePin {
    return route(owner.runtime, owner.model);
}

// workersRoute is the model a task runs on when nothing picked one for it: the group's worker route, else the lead's.
export function workersRoute(group: TaskGroup, owner: Run): RoutePin {
    const w = group.workerroute;
    return names(w) ? route(w.runtime, w.model) : leadRoute(owner);
}

export function taskRoute(task: TaskNode, owner: Run, group: TaskGroup): { route: RoutePin; source: RouteSource } {
    const spec = task.runspec;
    const pin = names(spec) ? route(spec.runtime || owner.runtime, spec.model) : null;
    const source = task.modelsource ?? "";
    if (pin != null) {
        if (source === "") return { route: pin, source: "pinned" };
        if (source === "owner" || source === "escalation") return { route: pin, source };
        if ((source === "plan" || source === "reviewer") && group.reviewerpicks) return { route: pin, source };
    }
    if (names(group.workerroute)) return { route: workersRoute(group, owner), source: "workers" };
    return { route: leadRoute(owner), source: "inherited" };
}

export function routeSourceLabel(source: RouteSource): string {
    switch (source) {
        case "plan":
            return "plan's pick";
        case "reviewer":
            return "reviewer's pick";
        case "owner":
            return "your pick";
        case "escalation":
            return "escalated";
        case "pinned":
            return "pinned";
        case "workers":
            return "workers route";
        default:
            return "same as lead";
    }
}

const CARD_TAG: Partial<Record<RouteSource, string>> = {
    plan: "plan",
    reviewer: "review",
    owner: "you",
    escalation: "escalated",
    pinned: "pinned",
};

// cardModelTag marks a card whose task runs off the run's workers model, and says who put it there.
export function cardModelTag(task: TaskNode, owner: Run, group: TaskGroup): string | null {
    const { route: r, source } = taskRoute(task, owner, group);
    const tag = CARD_TAG[source];
    if (tag == null || (r.model ?? "") === (workersRoute(group, owner).model ?? "")) return null;
    return `${shortModel(r.model)} · ${tag}`;
}

export function reviewStateText(task: TaskNode): string {
    if (task.reviewverdict === "pass") {
        const failed = task.reviewround ?? 0;
        return failed === 0 ? "passed first time" : `passed after ${failed} failed`;
    }
    if (task.reviewverdict === "fail") return "failed";
    if (task.reviewrunid) return "reviewing";
    return "not started";
}

// reviewerRouteOf is the route task reviewers and stage sessions run on; custom when the group names its own.
export function reviewerRouteOf(group: TaskGroup, owner: Run): { route: RoutePin; custom: boolean } {
    const r = group.reviewerroute;
    return names(r) ? { route: route(r.runtime, r.model), custom: true } : { route: leadRoute(owner), custom: false };
}

export function workersChip(group: TaskGroup, owner: Run): string {
    if (group.reviewerpicks) return "workers · reviewer picks";
    if (!names(group.workerroute)) return "workers · same as lead";
    return `workers · ${shortModel(workersRoute(group, owner).model)}`;
}

export function reviewersChip(group: TaskGroup, owner: Run): string {
    const { route: r, custom } = reviewerRouteOf(group, owner);
    return custom ? `reviewers · ${shortModel(r.model)}` : "reviewers · same as lead";
}

export type StageEntry = { key: "planreview" | "final"; text: string; tone: "done" | "failed" | "open" };

const STAGE_TONE: Record<string, StageEntry["tone"]> = { passed: "done", accepted: "done", failed: "failed" };

// stageEntries is the graph's stage line: each judging session's state and the model it runs on. A plan review
// shows only once one ran; every dag ends in a final verify.
export function stageEntries(group: TaskGroup, owner: Run): StageEntry[] {
    const model = shortModel(reviewerRouteOf(group, owner).route.model);
    const entry = (key: StageEntry["key"], label: string, state: string): StageEntry => ({
        key,
        text: `${label} · ${state} · ${model}`,
        tone: STAGE_TONE[state] ?? "open",
    });
    const out: StageEntry[] = [];
    if (group.planreview != null) out.push(entry("planreview", "plan review", group.planreview.state));
    out.push(entry("final", "final verify", group.final?.state || "waiting"));
    return out;
}

// isWaiting mirrors taskWaiting: a task nothing has started or touched, whose model can still change.
export function isWaiting(task: TaskNode): boolean {
    return (
        (task.state === "pending" || task.state === "ready") &&
        !task.runid &&
        !task.attempts &&
        !task.escalations &&
        !task.firstactivity
    );
}
