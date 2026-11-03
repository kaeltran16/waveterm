// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The ticket bar above an open initiative's plan: its key, link and the last-seen copy of the Jira ticket
// (Effort.Jira) as the bar draws them. Pure: no React.

import { seenLabel, seenTitle, statusTone, ticketUrl, type StatusTone } from "./jiraticket";

export type TicketBarModel = {
    key: string;
    url: string | null;
    type: string;
    status: string;
    tone: StatusTone;
    firstLine: string;
    description: string;
    acceptance: string[];
    seen: string;
    seenTitle: string;
};

export function ticketBarModel(effort: Effort, site: string | undefined, now: number): TicketBarModel | null {
    const key = effort.ticket?.trim() ?? "";
    if (key === "") {
        return null;
    }
    const jira = effort.jira;
    const description = jira?.description ?? "";
    return {
        key,
        url: ticketUrl(site, key),
        type: jira?.type ?? "",
        status: jira?.status ?? "",
        tone: statusTone(jira?.statuscategory ?? ""),
        firstLine:
            description
                .split("\n")
                .map((l) => l.trim())
                .find((l) => l !== "") ?? "",
        description,
        acceptance: jira?.acceptance ?? [],
        seen: jira != null ? seenLabel(jira.seents, now) : "not seen yet",
        seenTitle: jira != null ? seenTitle(jira.seents, jira.seenvia) : "",
    };
}
