// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentActionEntry } from "./agentsviewmodel";
import type { BrainstormFile, BrainstormQuestion } from "./brainstormmodel";
import {
    JIRA_COMMENT_CLAMP,
    JIRA_DESCRIPTION_CLAMP,
    NOTE_BULLET_MAX,
    findNote,
    jiraDateOf,
    jiraKeyOf,
    jiraShowOf,
    jiraTicketOf,
    judgeCardOf,
    noteCardOf,
    noteDataKey,
    noteIdOf,
    noteNeedsRecord,
} from "./notescards";
import { parseWshCalls } from "./wshcall";

const action = (command: string, output?: string, exit = 0): AgentActionEntry => ({
    kind: "action",
    verb: "ran",
    target: command,
    command,
    ...(output != null ? { detail: { kind: "bash", command, output, exit } } : {}),
});

const callOf = (command: string) => parseWshCalls(command)[0];

describe("note card", () => {
    const BODY = "- **Motion sweep**, 6/7: flake watch left\n- Chatbot reads CE alerts, 4/5\n- Performance candidates";

    it("draws from argv: the title, and the body's bullets with their bold lead-in", () => {
        const command = `wsh note add "Initiatives close to done" --body "${BODY.replace(/\n/g, "\\n")}"`;
        const card = noteCardOf(callOf(`wsh note add "Initiatives close to done" --body '${BODY}'`), action(command));
        expect(card.title).toBe("Initiatives close to done");
        expect(card.bullets).toHaveLength(3);
        expect(card.bullets[0]).toEqual([{ text: "Motion sweep", strong: true }, { text: ", 6/7: flake watch left" }]);
        expect(card.noteId).toBeUndefined();
    });

    it("keys the record by note id, else by title", () => {
        const call = callOf("wsh note add Title");
        expect(noteDataKey(call, action("wsh note add Title", "added note n-7"))).toBe("note:n-7");
        expect(noteDataKey(call, action("wsh note add Title"))).toBe("note:title:Title");
    });

    it("reads a double-quoted body that spans lines", () => {
        const command = 'wsh note add "Two" --body "- **First** thing\n- second thing"';
        const card = noteCardOf(callOf(command), action(command));
        expect(card.bullets).toEqual([
            [{ text: "First", strong: true }, { text: " thing" }],
            [{ text: "second thing" }],
        ]);
    });

    it("takes the id wsh printed, from the text line or from --json", () => {
        expect(noteIdOf(action("wsh note add T", "added note n-7\n"))).toBe("n-7");
        expect(noteIdOf(action("wsh note add T --json", JSON.stringify({ id: "n-9", title: "T" })))).toBe("n-9");
        expect(noteIdOf(action("wsh note add T"))).toBeUndefined();
    });

    it("prefers the note's record: its title, id and body over the argv", () => {
        const record: UserNote = { id: "n-3", title: "Saved title", day: "2026-11-16", body: "- one\n- two" };
        const card = noteCardOf(callOf(`wsh note add "Argv title" --body "- argv"`), action("wsh note add x"), record);
        expect(card.title).toBe("Saved title");
        expect(card.noteId).toBe("n-3");
        expect(card.bullets.map((b) => b[0].text)).toEqual(["one", "two"]);
    });

    it("keeps the title alone when the body was piped and the note did not load", () => {
        const call = callOf(`wsh note add "Piped" --body -`);
        const card = noteCardOf(call, action("wsh note add Piped --body -"));
        expect(card).toEqual({ title: "Piped", noteId: undefined, bullets: [] });
        expect(noteNeedsRecord(call, action("wsh note add Piped --body -", "added note n-1"))).toBe(true);
    });

    it("needs no record when the id and the body are both in the call", () => {
        const call = callOf(`wsh note add T --body "- a"`);
        expect(noteNeedsRecord(call, action("wsh note add T", "added note n-1"))).toBe(false);
        expect(noteNeedsRecord(call, action("wsh note add T"))).toBe(true);
    });

    it("shows a body with no bullets as its first lines, capped", () => {
        const lines = Array.from({ length: NOTE_BULLET_MAX + 3 }, (_, i) => `# line ${i}`).join("\n");
        const card = noteCardOf(callOf("wsh note add T"), action("wsh note add T"), {
            id: "n-1",
            title: "T",
            day: "d",
            body: lines,
        });
        expect(card.bullets).toHaveLength(NOTE_BULLET_MAX);
        expect(card.bullets[0][0].text).toBe("line 0");
    });

    it("finds a note by id, else the newest with the title", () => {
        const notes: UserNote[] = [
            { id: "a", title: "Same", day: "1" },
            { id: "b", title: "Same", day: "2" },
            { id: "c", title: "Other", day: "3" },
        ];
        expect(findNote(notes, "a", "Same")?.id).toBe("a");
        expect(findNote(notes, undefined, "Same")?.id).toBe("b");
        expect(findNote(notes, "gone", "Same")?.id).toBe("b");
        expect(findNote(notes, undefined, "None")).toBeUndefined();
        expect(findNote(undefined, "a", "Same")).toBeUndefined();
    });
});

describe("ticket card", () => {
    const long = "word ".repeat(200).trim();
    const data = (
        over: Partial<JiraTicket> = {},
        rest: Partial<CommandJiraShowRtnData> = {}
    ): CommandJiraShowRtnData => ({
        ticket: {
            key: "SIEM-1748",
            summary: "AI Chatbot improvements",
            type: "Enhancement",
            status: "New",
            statuscategory: "new",
            url: "https://jira.example/browse/SIEM-1748",
            description: "A short description.",
            ...over,
        },
        project: "cyber_assistant",
        sure: true,
        seents: 1,
        ...rest,
    });

    it("writes a comment's date as month-day", () => {
        expect(jiraDateOf(new Date(2026, 10, 9, 12).getTime())).toBe("11-09");
        expect(jiraDateOf(undefined)).toBeUndefined();
    });

    it("reads the key from a url or a lower-case argument", () => {
        expect(jiraKeyOf(callOf("wsh jira show siem-1748"))).toBe("SIEM-1748");
        expect(jiraKeyOf(callOf("wsh jira show https://jira.example/browse/PAY-318"))).toBe("PAY-318");
    });

    it("carries the key, summary, type and status, url and Arc project", () => {
        const card = jiraTicketOf(data());
        expect(card).toMatchObject({
            key: "SIEM-1748",
            summary: "AI Chatbot improvements",
            typeStatus: "Enhancement · New",
            url: "https://jira.example/browse/SIEM-1748",
            project: "cyber_assistant",
            projectSure: true,
        });
        expect(card.description).toEqual({
            text: "A short description.",
            full: "A short description.",
            clamped: false,
        });
    });

    it("clamps a long description at a word and keeps the whole text", () => {
        const { description } = jiraTicketOf(data({ description: long }));
        expect(description.clamped).toBe(true);
        expect(description.full).toBe(long);
        expect(description.text.length).toBeLessThanOrEqual(JIRA_DESCRIPTION_CLAMP + 1);
        expect(description.text.endsWith("…")).toBe(true);
    });

    it("makes a tile per attachment, marking the images", () => {
        const card = jiraTicketOf(
            data({
                attachments: [
                    { id: "1", filename: "a.png", mimetype: "image/png", size: 1 },
                    { id: "2", filename: "log.txt", mimetype: "text/plain", size: 1 },
                ],
            })
        );
        expect(card.attachments).toEqual([
            { id: "1", filename: "a.png", image: true },
            { id: "2", filename: "log.txt", image: false },
        ]);
    });

    it("shows the newest comment on one clamped line", () => {
        const card = jiraTicketOf(
            data({
                comments: [
                    { id: "c2", author: "Khang Tran", createdts: 2000, body: `can you give\nan example ${long}` },
                    { id: "c1", author: "Older", createdts: 1000, body: "first" },
                ],
            })
        );
        expect(card.comment?.author).toBe("Khang Tran");
        expect(card.comment?.text).not.toContain("\n");
        expect(card.comment!.text.length).toBeLessThanOrEqual(JIRA_COMMENT_CLAMP + 1);
    });

    it("has no comment, attachments or project when the ticket has none", () => {
        const card = jiraTicketOf(data({}, { project: "", sure: false }));
        expect(card.comment).toBeUndefined();
        expect(card.attachments).toEqual([]);
        expect(card.project).toBeUndefined();
        expect(card.projectSure).toBe(false);
    });

    it("reads the call's own --json output, and nothing from a failed or plain call", () => {
        const json = JSON.stringify(data());
        expect(jiraShowOf(action("wsh jira show SIEM-1748 --json", json))?.ticket.key).toBe("SIEM-1748");
        expect(jiraShowOf(action("wsh jira show SIEM-1748", json))).toBeNull();
        expect(jiraShowOf(action("wsh jira show SIEM-1748 --json", json, 1))).toBeNull();
        expect(jiraShowOf(action("wsh jira show SIEM-1748 --json"))).toBeNull();
    });
});

describe("judge card", () => {
    const question = (over: Partial<BrainstormQuestion> = {}): BrainstormQuestion => ({
        n: 3,
        text: "How should a run keep its memory under the limit?",
        part: "p",
        approaches: [1, 2, 3, 4, 5].map((i) => ({ name: `A${i}`, description: "", facts: [] })),
        ...over,
    });
    const file = (over: Partial<BrainstormFile> = {}): BrainstormFile => ({
        v: 1,
        title: "t",
        spec: "",
        question: null,
        working: null,
        parts: [],
        history: [],
        done: false,
        check: null,
        run: null,
        ...over,
    });

    it("is weighing while the file works over a question that lists approaches", () => {
        expect(judgeCardOf(file({ question: question(), working: "Weighing the approaches." }))).toEqual({
            state: "weighing",
            n: 3,
            approaches: 5,
            text: "How should a run keep its memory under the limit?",
        });
    });

    it("is done once the question carries Arc's weighed record", () => {
        const q = question({ judge: { kind: "weighed", added: [], dropped: [] } });
        expect(judgeCardOf(file({ question: q }))).toMatchObject({ state: "done", n: 3, approaches: 5 });
    });

    it("is failed when the record says the judge failed", () => {
        const q = question({ judge: { kind: "failed", reason: "no reply" } });
        expect(judgeCardOf(file({ question: q }))).toMatchObject({ state: "failed", n: 3 });
    });

    it("reads a finished judge from the history once the question moved on", () => {
        const history = [
            { kind: "question" as const, n: 2, q: "Older", a: "x", into: [] },
            {
                kind: "question" as const,
                n: 3,
                q: "Judged",
                a: "y",
                into: [],
                judge: { kind: "weighed" as const, added: [], dropped: [] },
            },
        ];
        expect(judgeCardOf(file({ question: question({ n: 4, approaches: undefined }), history }))).toEqual({
            state: "done",
            n: 3,
            text: "Judged",
        });
    });

    it("is unknown with no file, or no judge record anywhere in it", () => {
        expect(judgeCardOf(null)).toEqual({ state: "unknown" });
        expect(judgeCardOf(file({ question: question({ approaches: undefined }) }))).toEqual({ state: "unknown" });
    });
});
