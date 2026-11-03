// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// A Jira ticket as the cockpit draws it: key shape, links, status tone, the "seen" stamp, and the
// EC-JIRA-* errors wavesrv sends (pkg/jira). Pure: no React, no Wave runtime imports.

import { formatAgeShort } from "@/app/view/agents/agentsviewmodel";
import { noteStamp } from "./initiativework";

const KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;

// the same rule as pkg/jira NormalizeKey: anything not key-shaped is "" and never sent to Jira
export function normalizeKey(s: string): string {
    const key = s.trim().toUpperCase();
    return KEY_RE.test(key) ? key : "";
}

export function ticketUrl(site: string | undefined, key: string): string | null {
    if (!site) {
        return null;
    }
    return `${site.replace(/\/+$/, "")}/browse/${key}`;
}

export type JiraFailure =
    | { kind: "off"; message: string }
    | { kind: "refused"; status: number; message: string }
    | { kind: "other"; message: string };

const NOT_CONFIGURED_RE = /EC-JIRA-NOTCONFIGURED:\s*([\s\S]*)$/;
const HTTP_RE = /EC-JIRA-HTTP (\d+):\s*([\s\S]*)$/;
const UNREACHABLE_RE = /EC-JIRA-UNREACHABLE:\s*([\s\S]*)$/;

// rpc errors can arrive wrapped, so the code is searched for rather than expected at the start
export function parseJiraError(err: unknown): JiraFailure {
    const text = err instanceof Error ? err.message : String(err);
    const off = NOT_CONFIGURED_RE.exec(text);
    if (off) {
        return { kind: "off", message: off[1] };
    }
    const http = HTTP_RE.exec(text);
    if (http) {
        return { kind: "refused", status: Number(http[1]), message: http[2] };
    }
    const unreachable = UNREACHABLE_RE.exec(text);
    return { kind: "other", message: unreachable ? unreachable[1] : text };
}

export type StatusTone = "todo" | "progress" | "done";

export function statusTone(category: string): StatusTone {
    if (category === "indeterminate") {
        return "progress";
    }
    return category === "done" ? "done" : "todo";
}

export const STATUS_CHIP: Record<StatusTone, string> = {
    todo: "bg-surface-hover text-muted-foreground",
    progress: "bg-accentbg text-accent",
    done: "bg-success/10 text-success",
};

export function seenLabel(seenTs: number, now: number): string {
    return `seen ${formatAgeShort(now - seenTs)} ago`;
}

const SEEN_VIA: Record<string, string> = {
    check: "on Check Jira",
    show: "when an agent ran wsh jira show",
    refresh: "when you refreshed it",
    post: "when you posted progress",
    lookup: "when you looked it up in initiative details",
    make: "when the initiative was made from it",
};

export function seenTitle(seenTs: number, via: string): string {
    const base = `Arc last saw this ticket ${noteStamp(seenTs)}`;
    const how = SEEN_VIA[via];
    return how ? `${base}, ${how}` : base;
}
