// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure builder for the palette's "Start in #project" block: the ways to act on typed text that names
// nothing. The typed query is the *goal*, not a filter — these rows are never ranked. The component
// injects the impure deps and renders LaunchItem's presentational fields.

export type LaunchIcon = "quick" | "orchestrate" | "ask";

export interface LaunchItem {
    key: string; // launch:quick | launch:orchestrate | launch:consult:<runtime>
    icon: LaunchIcon;
    title: string;
    desc: string; // mono subtitle describing the mode
    verb: "Start" | "Ask";
    echo: string; // one-line echo of what firing this row does to the goal
    run: () => void;
}

export interface LaunchDeps {
    quick: (goal: string) => void; // one worker, no plan
    orchestrate: (goal: string) => void; // a lead plans tasks, workers run them
    consult: (runtime: string, goal: string) => void; // one-shot answer, no worker
}

// claude and pi are the runtimes this cockpit actually runs; the second row is the second opinion
export const CONSULT_RUNTIMES = ["claude", "pi"] as const;

// Empty goal or no project -> []. Otherwise the 4 launch rows, Quick first (preselected by the caller).
export function buildLaunchItems(query: string, projectName: string | undefined, deps: LaunchDeps): LaunchItem[] {
    const goal = query.trim();
    if (!goal || !projectName) {
        return [];
    }
    const [primary, second] = CONSULT_RUNTIMES;
    return [
        {
            key: "launch:quick",
            icon: "quick",
            title: "Quick",
            desc: "one worker, no plan",
            verb: "Start",
            echo: `Starts a Quick worker on “${goal}” in #${projectName}`,
            run: () => deps.quick(goal),
        },
        {
            key: "launch:orchestrate",
            icon: "orchestrate",
            title: "Orchestrate",
            desc: "a lead plans tasks, workers run them",
            verb: "Start",
            echo: `Starts an orchestrator run on “${goal}” in #${projectName}`,
            run: () => deps.orchestrate(goal),
        },
        {
            key: `launch:consult:${primary}`,
            icon: "ask",
            title: `Ask · ${primary}`,
            desc: "one-shot answer, no worker",
            verb: "Ask",
            echo: `Asks ${primary} about “${goal}”, nothing is spawned`,
            run: () => deps.consult(primary, goal),
        },
        {
            key: `launch:consult:${second}`,
            icon: "ask",
            title: `Ask · ${second}`,
            desc: `a second opinion from ${second}`,
            verb: "Ask",
            echo: `Asks ${second} about “${goal}”, nothing is spawned`,
            run: () => deps.consult(second, goal),
        },
    ];
}
