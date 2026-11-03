// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    failureLine,
    footerPosted,
    lastPostedLine,
    moveFailedLines,
    moveOptions,
    onDraft,
    onEdit,
    onSummaries,
    postLabel,
    postSentence,
} from "./jirapost";

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

const CODE = "Progress: 1 of 3 parts done.\n\nDone\n- Retry with backoff. Merged into main as 3e91a0c.";
const DRAFTED = "Progress: 1 of 3 parts done.\n\nDone\n- Retry with backoff. Deliveries that get a 429 are retried.";

const draftRtn = (over: Partial<CommandJiraPostDraftRtnData> = {}): CommandJiraPostDraftRtnData => ({
    key: "PAY-318",
    status: "To Do",
    comment: CODE,
    donechunks: ["Retry with backoff"],
    transitions: [],
    ...over,
});

describe("onDraft", () => {
    it("opens on the code draft, drafting, untouched", () => {
        expect(onDraft(draftRtn())).toEqual({ text: CODE, drafting: true, edited: false, note: "" });
    });
});

describe("onSummaries", () => {
    it("swaps the drafted summaries when untouched", () => {
        const d = onSummaries(onDraft(draftRtn()), { comment: DRAFTED, rewritten: true });
        expect(d).toEqual({ text: DRAFTED, drafting: false, edited: false, note: "" });
    });

    it("keeps the user's edits when summaries land late", () => {
        const edited = onEdit(onDraft(draftRtn()), CODE + "\nmine");
        const d = onSummaries(edited, { comment: DRAFTED, rewritten: true });
        expect(d.text).toBe(CODE + "\nmine");
        expect(d.drafting).toBe(false);
        expect(d.note).toBe("Kept your edits; the drafted summaries were not applied.");
    });

    it("keeps the code draft and says why when the summaries were not rewritten", () => {
        const d = onSummaries(onDraft(draftRtn()), {
            comment: CODE,
            rewritten: false,
            reason: "Headless AI is not set up",
        });
        expect(d).toEqual({
            text: CODE,
            drafting: false,
            edited: false,
            note: "Summaries were not rewritten: Headless AI is not set up",
        });
    });

    it("says nothing when there was nothing to rewrite", () => {
        const d = onSummaries(onDraft(draftRtn()), { comment: CODE, rewritten: false });
        expect(d.note).toBe("");
        expect(d.drafting).toBe(false);
    });

    it("says the summaries were not rewritten even over the user's edits", () => {
        const edited = onEdit(onDraft(draftRtn()), "mine");
        const d = onSummaries(edited, { comment: CODE, rewritten: false, reason: "timed out" });
        expect(d.text).toBe("mine");
        expect(d.note).toBe("Summaries were not rewritten: timed out");
    });
});

describe("onEdit", () => {
    it("takes the text and marks it edited, still drafting", () => {
        expect(onEdit(onDraft(draftRtn()), "x")).toEqual({ text: "x", drafting: true, edited: true, note: "" });
    });
});

describe("moveOptions", () => {
    it("puts Leave as is first, then each move by its target status", () => {
        const t: JiraTransition[] = [
            { id: "21", name: "Start work", to: "In Progress" },
            { id: "31", name: "In Review", to: "In Review" },
        ];
        expect(moveOptions(t)).toEqual([
            { id: "", label: "Leave as is" },
            { id: "21", label: "In Progress" },
            { id: "31", label: "In Review" },
        ]);
    });

    it("falls back to the transition name without a target", () => {
        expect(moveOptions([{ id: "41", name: "Done", to: "" }])[1]).toEqual({ id: "41", label: "Done" });
    });

    it("offers only Leave as is with no moves", () => {
        expect(moveOptions(undefined)).toEqual([{ id: "", label: "Leave as is" }]);
    });
});

describe("postSentence and postLabel", () => {
    const leave = { id: "", label: "Leave as is" };
    const move = { id: "21", label: "In Progress" };

    it("says the ticket stays when left as is", () => {
        expect(postSentence("To Do", leave)).toBe("Posts the comment; the ticket stays To Do.");
        expect(postLabel(leave)).toBe("Post comment");
    });

    it("says the move when one is picked", () => {
        expect(postSentence("To Do", move)).toBe("Posts the comment, then moves To Do to In Progress.");
        expect(postLabel(move)).toBe("Post and move");
    });
});

describe("lastPostedLine", () => {
    it("reads never before any post", () => {
        expect(lastPostedLine(undefined, NOW)).toBe("Last posted: never.");
    });

    it("reads the age of the last post", () => {
        expect(lastPostedLine({ ts: NOW - 2 * HOUR, commenturl: "u", from: "To Do" }, NOW)).toBe("Last posted 2h ago.");
    });
});

describe("footerPosted", () => {
    it("names the move when the post moved the ticket", () => {
        const lp = { ts: NOW - 2 * HOUR, commenturl: "u", from: "To Do", movedto: "In Progress" };
        expect(footerPosted(lp, NOW)).toBe("Posted 2h ago, moved to In Progress");
    });

    it("reads the age alone without a move, or after a failed one", () => {
        expect(footerPosted({ ts: NOW - 2 * HOUR, commenturl: "u", from: "To Do" }, NOW)).toBe("Posted 2h ago");
        expect(
            footerPosted(
                { ts: NOW - 2 * HOUR, commenturl: "u", from: "To Do", moveerror: "Field 'Reviewer' is required" },
                NOW
            )
        ).toBe("Posted 2h ago");
    });
});

describe("moveFailedLines", () => {
    it("names the move, Jira's real status and Jira's message", () => {
        const rtn: CommandJiraPostRtnData = {
            commenturl: "u",
            postedts: NOW,
            from: "To Do",
            moveerror: "EC-JIRA-HTTP 400: Field 'Reviewer' is required for this transition.",
            status: "To Do",
        };
        expect(moveFailedLines("In Review", rtn)).toEqual({
            failed: "Couldn't move it to In Review, so it is still To Do.",
            jira: "Jira: Field 'Reviewer' is required for this transition.",
        });
    });
});

describe("failureLine", () => {
    it("shows Jira's status and message on a refusal", () => {
        expect(failureLine({ kind: "refused", status: 401, message: "Client must be authenticated" })).toBe(
            "Jira 401: Client must be authenticated"
        );
    });

    it("shows the message alone otherwise", () => {
        expect(failureLine({ kind: "other", message: "dial tcp: connection refused" })).toBe(
            "dial tcp: connection refused"
        );
        expect(failureLine({ kind: "off", message: "Jira isn't set up" })).toBe("Jira isn't set up");
    });
});
