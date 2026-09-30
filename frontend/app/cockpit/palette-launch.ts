// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure builder for the palette's "Start in #project" block: the ways to act on typed text that names
// nothing. The typed query is the *goal*, not a filter — these rows are never ranked. The component
// injects the impure deps and renders LaunchItem's presentational fields.

import type { RunShape } from "@/app/view/agents/runconfig";

export type LaunchIcon = "quick" | "orchestrate" | "setup" | "ask";

export interface LaunchItem {
    key: string; // launch:quick | launch:orchestrate | launch:setup | launch:consult:<runtime>
    icon: LaunchIcon;
    title: string;
    desc: string; // mono subtitle describing the mode
    verb: "Start" | "Open" | "Ask";
    echo: string; // one-line echo of what firing this row does to the goal
    run: () => void;
    alt?: { echo: string; run: () => void }; // Ctrl+Enter
    chord?: string; // the key that reaches this row from anywhere in the block
}

export interface LaunchDeps {
    quick: (goal: string) => void; // one worker, no plan
    orchestrate: (goal: string) => void; // a lead plans tasks, workers run them
    setup: (goal: string, shape: RunShape) => void; // the New run window, prefilled
    consult: (runtime: string, goal: string) => void; // one-shot answer, no worker
}

// claude and pi are the runtimes this cockpit actually runs; the second row is the second opinion
export const CONSULT_RUNTIMES = ["claude", "pi"] as const;

// Empty goal or no project -> []. Otherwise the 5 launch rows, Quick first (preselected by the caller).
// Ctrl+Enter orchestrates from any of them, so Orchestrate is one chord rather than a trip down the list.
export function buildLaunchItems(query: string, projectName: string | undefined, deps: LaunchDeps): LaunchItem[] {
    const goal = query.trim();
    if (!goal || !projectName) {
        return [];
    }
    const [primary, second] = CONSULT_RUNTIMES;
    const orchestrate = { echo: "Starts an orchestrator run instead", run: () => deps.orchestrate(goal) };
    return [
        {
            key: "launch:quick",
            icon: "quick",
            title: "Quick",
            desc: "one worker, no plan",
            verb: "Start",
            echo: `Starts a Quick worker on “${goal}” in #${projectName}`,
            run: () => deps.quick(goal),
            alt: orchestrate,
        },
        {
            key: "launch:orchestrate",
            icon: "orchestrate",
            title: "Orchestrate",
            desc: "a lead plans tasks, workers run them",
            verb: "Start",
            echo: `Starts an orchestrator run on “${goal}” in #${projectName}`,
            run: () => deps.orchestrate(goal),
            chord: "Ctrl:Enter",
        },
        {
            key: "launch:setup",
            icon: "setup",
            title: "Set up the run…",
            desc: "New run window with this goal: plan file, workers, models",
            verb: "Open",
            echo: `Opens the New run window with the goal and #${projectName} filled in`,
            // what the window adds over the two rows above (a plan file, workers, reviewers) is orchestrator
            // setup; Quick needs none, and the window's own toggle still switches it
            run: () => deps.setup(goal, "orchestrator"),
            alt: orchestrate,
        },
        {
            key: `launch:consult:${primary}`,
            icon: "ask",
            title: `Ask · ${primary}`,
            desc: "one-shot answer, no worker",
            verb: "Ask",
            echo: `Asks ${primary} about “${goal}”, nothing is spawned`,
            run: () => deps.consult(primary, goal),
            alt: orchestrate,
        },
        {
            key: `launch:consult:${second}`,
            icon: "ask",
            title: `Ask · ${second}`,
            desc: `a second opinion from ${second}`,
            verb: "Ask",
            echo: `Asks ${second} about “${goal}”, nothing is spawned`,
            run: () => deps.consult(second, goal),
            alt: orchestrate,
        },
    ];
}
