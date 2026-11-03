// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Check Jira: the dialog's state and the words it draws. The state lives in atoms rather than in the dialog,
// because Make initiative switches to the Agent surface, which unmounts the Brief and the dialog with it; going
// back must redraw the same check, its Building in Agent marks included, without calling Jira again.

import { formatAge } from "@/app/view/agents/agentsviewmodel";
import { atom, type PrimitiveAtom } from "jotai";
import { noteStamp } from "./initiativework";
import { normalizeKey, type JiraFailure } from "./jiraticket";

export const checkJiraOpenAtom = atom(false) as PrimitiveAtom<boolean>;

// null until the open dialog first checks; closing the dialog clears it, since the list is not kept between checks
export const checkJiraStateAtom = atom<CheckState | null>(null) as PrimitiveAtom<CheckState | null>;

// ticket key -> the tab of the agent building its initiative ("" while the launch is in flight)
export const jiraBuildingAtom = atom<Record<string, string>>({}) as PrimitiveAtom<Record<string, string>>;

export type CheckState =
    | { kind: "loading"; prev?: CommandJiraCheckRtnData }
    | { kind: "list"; data: CommandJiraCheckRtnData }
    | { kind: "off"; message: string }
    | { kind: "refused"; status: number; message: string; site: string; lastChecked?: number }
    | { kind: "other"; message: string };

const JUST_NOW_MS = 60_000;

// visible is how many rows are still drawn: a row leaves once its initiative exists
export function checkSubtitle(s: CheckState, visible?: number): string {
    switch (s.kind) {
        case "loading":
            return "Checking your open tickets";
        case "list":
            return `${visible ?? s.data.tickets.length} assigned to you without an initiative`;
        case "off":
            return "Jira isn't set up";
        case "refused":
            return s.lastChecked ? `Last checked ${noteStamp(s.lastChecked)}` : "";
        case "other":
            return "Couldn't reach Jira";
    }
}

export function siteHost(site: string | undefined): string {
    return (site ?? "").replace(/^[a-z]+:\/\//i, "").replace(/\/+$/, "");
}

function ago(ms: number): string {
    return ms < JUST_NOW_MS ? "just now" : `${formatAge(ms)} ago`;
}

// the header's "<site> · just now"; settingsSite stands in until a check has named the site
export function headerWhen(s: CheckState, settingsSite: string | undefined, now: number): string {
    switch (s.kind) {
        case "list":
            return `${siteHost(s.data.site)} · ${ago(now - s.data.checkedts)}`;
        case "loading":
            return siteHost(s.prev?.site ?? settingsSite);
        case "refused":
            return siteHost(s.site);
        case "other":
            return siteHost(settingsSite);
        case "off":
            return "";
    }
}

export function checkFailure(f: JiraFailure, site: string, lastOkTs: number): CheckState {
    if (f.kind === "refused") {
        return {
            kind: "refused",
            status: f.status,
            message: f.message,
            site,
            ...(lastOkTs ? { lastChecked: lastOkTs } : {}),
        };
    }
    return f;
}

export function refusedHeadline(status: number): string {
    return status === 401
        ? "Jira rejected your API token. It may have expired or been revoked."
        : "Jira refused the check.";
}

export function visibleRows(data: CommandJiraCheckRtnData, onInitiative: Set<string>): JiraTicketRow[] {
    const taken = new Set([...onInitiative].map(normalizeKey));
    return data.tickets.filter((t) => !taken.has(normalizeKey(t.key)));
}

export function footerLine(covered: number): string {
    if (covered <= 0) {
        return "";
    }
    return covered === 1
        ? "1 more assigned ticket already has an initiative."
        : `${covered} more assigned tickets already have an initiative.`;
}

// No event says an initiative was created, so the dialog watches the building agents instead: a change in this
// key (an agent starting, going idle after its turn, asking) is when the Brief re-reads its initiatives.
export function buildingAgentsKey(building: Record<string, string>, agents: { id: string; state: string }[]): string {
    const tabs = new Set(Object.values(building).filter(Boolean));
    return agents
        .filter((a) => tabs.has(a.id))
        .map((a) => `${a.id}:${a.state}`)
        .sort()
        .join(",");
}

export function emptyDetail(checked: number): string {
    return `${checked} open ${checked === 1 ? "ticket" : "tickets"} checked. New assignments show here the next time you check.`;
}

export function ticketMeta(row: JiraTicketRow, now: number): string {
    const parts = [row.type, row.status];
    if (row.updatedts) {
        parts.push(`updated ${ago(now - row.updatedts)}`);
    }
    return parts.filter(Boolean).join(" · ");
}
