// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Post progress to Jira, the dialog's model: the comment draft as the code version and the model's rewrite
// arrive, the moves the ticket allows, and the words the dialog and the plan's footer say. Pure apart from the
// open atom: no React, no RPC.

import { formatAgeShort } from "@/app/view/agents/agentsviewmodel";
import { atom, type PrimitiveAtom } from "jotai";
import type { JiraFailure } from "./jiraticket";

// the effort oref the dialog is open on
export const jiraPostOpenAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;

export type PostDraft = { text: string; drafting: boolean; edited: boolean; note: string };

export type MovePick = { id: string; label: string };

const LEAVE: MovePick = { id: "", label: "Leave as is" };

export function onDraft(rtn: CommandJiraPostDraftRtnData): PostDraft {
    return { text: rtn.comment, drafting: true, edited: false, note: "" };
}

// Post never waits on the model, so the rewrite can land after you started typing: your text wins
export function onSummaries(d: PostDraft, s: CommandJiraPostSummariesRtnData): PostDraft {
    if (!s.rewritten) {
        const note = s.reason ? `Summaries were not rewritten: ${s.reason}` : "";
        return { ...d, drafting: false, note };
    }
    if (d.edited) {
        return { ...d, drafting: false, note: "Kept your edits; the drafted summaries were not applied." };
    }
    return { text: s.comment, drafting: false, edited: false, note: "" };
}

export function onEdit(d: PostDraft, text: string): PostDraft {
    return { ...d, text, edited: true };
}

export function moveOptions(t: JiraTransition[] | undefined): MovePick[] {
    return [LEAVE, ...(t ?? []).map((x) => ({ id: x.id, label: x.to || x.name }))];
}

export function postSentence(status: string, pick: MovePick): string {
    return pick.id === ""
        ? `Posts the comment; the ticket stays ${status}.`
        : `Posts the comment, then moves ${status} to ${pick.label}.`;
}

export function postLabel(pick: MovePick): "Post comment" | "Post and move" {
    return pick.id === "" ? "Post comment" : "Post and move";
}

export function lastPostedLine(lp: EffortJiraPost | undefined, now: number): string {
    return lp == null ? "Last posted: never." : `Last posted ${formatAgeShort(now - lp.ts)} ago.`;
}

export function footerPosted(lp: EffortJiraPost, now: number): string {
    const posted = `Posted ${formatAgeShort(now - lp.ts)} ago`;
    return lp.movedto ? `${posted}, moved to ${lp.movedto}` : posted;
}

// the comment posted but the move did not: what the dialog says, with Jira's real status after the attempt
export function moveFailedLines(picked: string, rtn: CommandJiraPostRtnData): { failed: string; jira: string } {
    return {
        failed: `Couldn't move it to ${picked}, so it is still ${rtn.status}.`,
        jira: `Jira: ${rtn.moveerror}`,
    };
}

// one line for a failed draft or comment: a refusal carries Jira's own status and message
export function failureLine(f: JiraFailure): string {
    return f.kind === "refused" ? `Jira ${f.status}: ${f.message}` : f.message;
}
