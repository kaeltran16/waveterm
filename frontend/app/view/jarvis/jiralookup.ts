// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Ticket field in initiative details, looked up in Jira on blur: when to look, and the line drawn under the
// fields for each outcome. Pure: no React, no Wave runtime imports.

import { normalizeKey, parseJiraError } from "./jiraticket";

const NOT_FOUND_STATUS = 404;

export type LookupState =
    | { kind: "idle" }
    | { kind: "looking"; key: string }
    | { kind: "found"; key: string; summary: string; type: string; status: string }
    | { kind: "notfound"; key: string }
    | { kind: "off" }
    | { kind: "error"; message: string };

// off and error are no answer about the key (Jira connected since, a network blip), so the same key may look again
const RETRYABLE: ReadonlySet<LookupState["kind"]> = new Set(["off", "error"]);

// the normalized key when the field holds a key-shaped value worth looking up, else null: one call per changed
// key, plus a retry of the same key after an off or error outcome
export function shouldLookUp(prevKey: string, raw: string, last: LookupState): string | null {
    const key = normalizeKey(raw);
    if (key === "") {
        return null;
    }
    return key !== prevKey || RETRYABLE.has(last.kind) ? key : null;
}

export type LookupLine = {
    text: string;
    tone: "muted" | "error" | "faint" | "ok";
    fieldError: boolean;
    connect: boolean;
};

// a found ticket has no line: its own row draws the check, the summary and `type · status`
export function lookupLine(s: LookupState): LookupLine | null {
    switch (s.kind) {
        case "looking":
            return { text: `Looking up ${s.key} in Jira…`, tone: "muted", fieldError: false, connect: false };
        case "notfound":
            return {
                text: `Jira has no ${s.key}, or your account can't see it. Saving keeps it as text.`,
                tone: "error",
                fieldError: true,
                connect: false,
            };
        case "off":
            return {
                text: "Saved as text; Arc can't check it until Jira is connected.",
                tone: "faint",
                fieldError: false,
                connect: true,
            };
        case "error":
            return { text: s.message, tone: "error", fieldError: false, connect: false };
        default:
            return null;
    }
}

export function fromLookupError(key: string, err: unknown): LookupState {
    const failure = parseJiraError(err);
    if (failure.kind === "off") {
        return { kind: "off" };
    }
    if (failure.kind === "refused") {
        return failure.status === NOT_FOUND_STATUS
            ? { kind: "notfound", key }
            : { kind: "error", message: `Jira answered ${failure.status}: ${failure.message}` };
    }
    return { kind: "error", message: failure.message };
}
