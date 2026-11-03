// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Make initiative from a Jira ticket: start an agent that reads the ticket and creates the initiative through
// wsh, the way the initiatives skill does. With a sure project it starts in that project's folder; unsure, it
// starts in the home folder with no project and asks first. It only runs wsh, so a home folder cannot touch
// the wrong repo.

import { launchAgent } from "@/app/cockpit/cockpit-actions";
import { globalStore } from "@/app/store/jotaiStore";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { projectsAtom } from "@/app/view/agents/projectsstore";
import { projectPathFor } from "./initiativework";
import { briefLaunchCommand } from "./initiativeworkaction";

// the CDP scenario stands in for the agent here rather than starting a real model session
export const jiraMakeDeps: { launch: typeof launchAgent } = { launch: launchAgent };

export function makePrompt(row: JiraTicketRow): string {
    const key = row.key;
    const sure = row.sure && !!row.project;
    const where = sure
        ? `It belongs to the Arc project ${row.project}.`
        : `Arc couldn't tell which project it belongs to (${row.evidence || "no history"}): ` +
          `guess the project from the ticket and my registered Arc projects, and ask me to confirm it before creating anything.`;
    const create = sure
        ? `\`wsh effort create "<the ticket's summary>" --ticket ${key} --project ${row.project}\``
        : `\`wsh effort create "<the ticket's summary>" --ticket ${key} --project <the project I confirmed>\``;
    return [
        `Make an Arc initiative from the Jira ticket ${key}, following the initiatives skill.`,
        where,
        `First read the ticket with \`wsh jira show ${key}\`.`,
        `Then create it with ${create} and a --chunk for each part, planned from the description and acceptance criteria.`,
        `Then leave a first note, "Made from ${key}", saying how you planned the chunks: ` +
            `\`wsh effort chunk note <effort> <first chunk> --note "Made from ${key}: <how you planned them>"\`.`,
        `Only run wsh commands; don't change any code.`,
    ].join(" ");
}

export function makeTarget(
    row: JiraTicketRow,
    registry: Record<string, { path?: string }>
): { projectPath: string; projectName: string } {
    const projectPath = row.sure ? projectPathFor(row.project, registry) : "";
    return projectPath ? { projectPath, projectName: row.project! } : { projectPath: "", projectName: "" };
}

export async function makeInitiative(model: AgentsViewModel, row: JiraTicketRow): Promise<string> {
    return jiraMakeDeps.launch(model, {
        ...briefLaunchCommand(),
        ...makeTarget(row, globalStore.get(projectsAtom)),
        task: makePrompt(row),
        label: `${row.key} ${row.summary}`,
    });
}
