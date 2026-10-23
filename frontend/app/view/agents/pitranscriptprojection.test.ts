// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { extractPiTasks, extractPiTitle, projectPiTranscript } from "./pitranscriptprojection";

const L = JSON.stringify;
const session = L({
    type: "session",
    version: 3,
    id: "s1",
    timestamp: "2026-08-11T03:00:00Z",
    cwd: "/repo",
});

// Pi v3 records tool calls as {type:"toolCall", id, name, arguments} and joins them to a
// {role:"toolResult", toolCallId, toolName, content, isError} message record. Sequential calls
// in one fixture must chain: each call's parentId points at the previous record (defaults to the
// user seed "u"), or the later calls become abandoned sibling branches and never render.
const toolCall = (id: string, name: string, args: unknown, ts = "2026-08-11T03:00:00.000Z", parent = "u") =>
    L({
        type: "message",
        id: "call-" + id,
        parentId: parent,
        timestamp: ts,
        message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] },
    });
const toolResult = (
    id: string,
    name: string,
    text: string,
    isError = false,
    ts = "2026-08-11T03:00:01.000Z",
    parent = "call-" + id
) =>
    L({
        type: "message",
        id: "res-" + id,
        parentId: parent,
        timestamp: ts,
        message: {
            role: "toolResult",
            toolCallId: id,
            toolName: name,
            content: [{ type: "text", text }],
            isError,
        },
    });
const user = (id: string, text: string) =>
    L({ type: "message", id, parentId: null, message: { role: "user", content: text } });

describe("projectPiTranscript", () => {
    it("projects only the active parent branch root-first, joining tool results to calls", () => {
        const lines = [
            session,
            user("root", "implement it"),
            // abandoned sibling: on disk, never on the active chain
            L({
                type: "message",
                id: "abandoned",
                parentId: "root",
                message: { role: "assistant", content: "Approach A failed" },
            }),
            L({
                type: "message",
                id: "inspecting",
                parentId: "root",
                timestamp: "2026-08-11T03:01:00Z",
                message: {
                    role: "assistant",
                    content: [
                        { type: "text", text: "Inspecting." },
                        { type: "toolCall", id: "t1", name: "bash", arguments: { command: "go test ./pkg/..." } },
                    ],
                },
            }),
            L({
                type: "message",
                id: "tr1",
                parentId: "inspecting",
                timestamp: "2026-08-11T03:01:05Z",
                message: { role: "toolResult", toolCallId: "t1", toolName: "bash", content: "ok" },
            }),
            L({
                type: "message",
                id: "approachb",
                parentId: "tr1",
                message: { role: "user", content: "use approach B" },
            }),
            L({
                type: "message",
                id: "final",
                parentId: "approachb",
                message: { role: "assistant", content: "Approach B works." },
            }),
        ];
        expect(projectPiTranscript(lines)).toEqual([
            { kind: "user", text: "implement it" },
            { kind: "message", text: "Inspecting." },
            {
                kind: "action",
                verb: "ran",
                target: "go test ./pkg/...",
                outcome: "ok",
                durationMs: 5000,
                detail: { kind: "bash", command: "go test ./pkg/...", output: "ok", exit: 0 },
            },
            { kind: "user", text: "use approach B" },
            { kind: "message", text: "Approach B works." },
        ]);
        expect(projectPiTranscript(lines).some((e) => JSON.stringify(e).includes("Approach A failed"))).toBe(false);
    });

    it("marks a failed tool call fail via the tool result's error flag", () => {
        const lines = [
            session,
            user("u", "build it"),
            toolCall("b1", "bash", { command: "make build" }),
            toolResult("b1", "bash", "build failed", true),
        ];
        expect(projectPiTranscript(lines)).toEqual([
            { kind: "user", text: "build it" },
            {
                kind: "action",
                verb: "ran",
                target: "make build",
                outcome: "fail",
                durationMs: 1000,
                detail: { kind: "bash", command: "make build", output: "build failed", exit: 1 },
            },
        ]);
    });

    it("renders a skill-block user message as a skill chip plus the trailing user bubble", () => {
        const skillText = `<skill name="superpowers:brainstorming" location="C:\\skills\\brainstorming\\SKILL.md">\nReferences are relative to C:\\skills\\brainstorming.\n\n# Brainstorming\n\nUse this before any creative work.\n</skill>\n\nplan the dashboard`;
        const lines = [
            session,
            L({ type: "message", id: "u", parentId: null, message: { role: "user", content: skillText } }),
        ];
        expect(projectPiTranscript(lines)).toEqual([
            { kind: "command", name: "brainstorming", isSkill: true },
            { kind: "user", text: "plan the dashboard" },
        ]);
    });

    it("renders a bare skill-block user message (no trailing text) as just the skill chip", () => {
        const skillText = `<skill name="grilling" location="C:\\skills\\grilling\\SKILL.md">\nReferences are relative to C:\\skills\\grilling.\n\n# Grilling\n\nStress-test the plan.\n</skill>`;
        const lines = [
            session,
            L({ type: "message", id: "u", parentId: null, message: { role: "user", content: skillText } }),
        ];
        expect(projectPiTranscript(lines)).toEqual([{ kind: "command", name: "grilling", isSkill: true }]);
    });

    it("keeps plain user text as a user bubble", () => {
        const lines = [session, user("u", "just a question")];
        expect(projectPiTranscript(lines)).toEqual([{ kind: "user", text: "just a question" }]);
    });

    it("carries inline edit diffs for edit (multi-edit) and write tool calls", () => {
        const lines = [
            session,
            user("u", "refactor"),
            toolCall("e1", "edit", {
                path: "src/a.ts",
                edits: [
                    { oldText: "const x = 1;", newText: "const x = 2;" },
                    { oldText: "old", newText: "new" },
                ],
            }),
            toolResult("e1", "edit", ""),
            toolCall(
                "w1",
                "write",
                { path: "src/b.ts", content: "export const b = 1;" },
                "2026-08-11T03:00:02.000Z",
                "res-e1"
            ),
            toolResult("w1", "write", ""),
        ];
        const entries = projectPiTranscript(lines);
        const edit = entries.find((e) => e.kind === "action" && e.verb === "edited");
        expect(edit).toBeDefined();
        expect(edit!.kind).toBe("action");
        const detail = (edit as any).detail;
        expect(detail.kind).toBe("edit");
        expect(detail.files).toHaveLength(2);
        expect(detail.files[0].path).toBe("src/a.ts");
        expect(detail.files[0].badge).toBe("M");
        expect(detail.files[0].adds).toBe(1);
        expect(detail.files[0].dels).toBe(1);
        const write = entries.find((e) => e.kind === "action" && e.verb === "wrote");
        expect((write as any).detail.files[0]).toMatchObject({ path: "src/b.ts", badge: "A", adds: 1, dels: 0 });
    });

    it("enriches read and grep actions with detail from the tool result", () => {
        const readBody = ["line1", "line2", "line3"].join("\n");
        const grepBody = "src/a.ts:12: const x = 1;\nsrc/a.ts:14: const y = 2;";
        const lines = [
            session,
            user("u", "inspect"),
            toolCall("r1", "read", { path: "src/a.ts", offset: 1, limit: 3 }),
            toolResult("r1", "read", readBody),
            toolCall("g1", "grep", { pattern: "const", path: "src" }, "2026-08-11T03:00:02.000Z", "res-r1"),
            toolResult("g1", "grep", grepBody),
        ];
        const entries = projectPiTranscript(lines);
        const read = entries.find((e) => e.kind === "action" && e.verb === "read") as any;
        expect(read.detail).toEqual({ kind: "read", snippet: readBody, truncated: false });
        expect(read.summary).toBe("3 lines");
        expect(read.outcome).toBeUndefined(); // non-bash success: no explicit ok (renders ✓)
        const grep = entries.find((e) => e.kind === "action" && e.verb === "grep") as any;
        expect(grep.detail.kind).toBe("grep");
        expect(grep.detail.matches).toEqual([
            { loc: "src/a.ts:12", code: " const x = 1;" },
            { loc: "src/a.ts:14", code: " const y = 2;" },
        ]);
        expect(grep.summary).toBe("2 matches");
    });

    it("enriches bash actions with command + output + exit and computes duration", () => {
        const lines = [
            session,
            user("u", "run tests"),
            toolCall("b1", "bash", { command: "npm test" }, "2026-08-11T03:00:10.000Z"),
            toolResult("b1", "bash", "12 passing\n3 failing", false, "2026-08-11T03:00:16.500Z"),
        ];
        const entries = projectPiTranscript(lines);
        const bash = entries.find((e) => e.kind === "action" && e.verb === "ran") as any;
        expect(bash.target).toBe("npm test");
        expect(bash.detail).toEqual({ kind: "bash", command: "npm test", output: "12 passing\n3 failing", exit: 0 });
        expect(bash.outcome).toBe("ok");
        expect(bash.durationMs).toBe(6500);
    });

    it("maps the task/subagent tool family to descriptive verbs and targets", () => {
        const lines = [
            session,
            user("u", "organize"),
            toolCall("t1", "TaskCreate", { subject: "Fix auth bug", description: "details" }),
            toolResult("t1", "TaskCreate", "Task #1 created successfully: Fix auth bug"),
            toolCall("t2", "TaskUpdate", { taskId: "1", status: "completed" }, "2026-08-11T03:00:02.000Z", "res-t1"),
            toolResult("t2", "TaskUpdate", "Task #1 updated"),
            toolCall(
                "s1",
                "subagent",
                { agent: "reviewer", task: "review the diff" },
                "2026-08-11T03:00:03.000Z",
                "res-t2"
            ),
            toolResult("s1", "subagent", "done"),
        ];
        const entries = projectPiTranscript(lines);
        const verbs = entries
            .filter((e) => e.kind === "action")
            .map((e) => ({ verb: (e as any).verb, target: (e as any).target }));
        expect(verbs).toEqual([
            { verb: "created task", target: "Fix auth bug" },
            { verb: "updated task", target: "task #1" },
            { verb: "spawned", target: "reviewer" },
        ]);
    });

    it("maps compaction records to the compaction entry kind", () => {
        const lines = [
            session,
            user("u", "long task"),
            L({ type: "message", id: "a1", parentId: "u", message: { role: "assistant", content: "part one" } }),
            L({
                type: "compaction",
                id: "c",
                parentId: "a1",
                timestamp: "2026-08-11T03:01:00Z",
                summary: "kept the essentials",
                tokensBefore: 120000,
            }),
            L({ type: "message", id: "a2", parentId: "c", message: { role: "assistant", content: "resumed" } }),
        ];
        expect(projectPiTranscript(lines)).toEqual([
            { kind: "user", text: "long task" },
            { kind: "message", text: "part one" },
            { kind: "compaction", summary: "kept the essentials", preTokens: 120000 },
            { kind: "message", text: "resumed" },
        ]);
    });

    it("never renders branch_summary as content", () => {
        const lines = [
            session,
            user("u", "task"),
            L({
                type: "branch_summary",
                id: "bs",
                parentId: "u",
                timestamp: "2026-08-11T03:02:00Z",
                summary: "did things",
            }),
        ];
        const entries = projectPiTranscript(lines);
        expect(entries).toEqual([{ kind: "user", text: "task" }]);
        expect(entries.some((e) => JSON.stringify(e).includes("did things"))).toBe(false);
    });

    it("skips malformed lines and keeps the reachable branch", () => {
        const lines = [
            session,
            user("u", "keep me"),
            "{ this is not json",
            L({ type: "message", id: "a", parentId: "u", message: { role: "assistant", content: "done" } }),
        ];
        expect(projectPiTranscript(lines)).toEqual([
            { kind: "user", text: "keep me" },
            { kind: "message", text: "done" },
        ]);
    });

    it("terminates on a parent cycle and projects the reachable suffix", () => {
        const lines = [
            session,
            L({ type: "message", id: "a", parentId: "b", message: { role: "assistant", content: "one" } }),
            L({ type: "message", id: "b", parentId: "a", message: { role: "assistant", content: "two" } }),
        ];
        expect(() => projectPiTranscript(lines)).not.toThrow();
        expect(projectPiTranscript(lines)).toEqual([
            { kind: "message", text: "one" },
            { kind: "message", text: "two" },
        ]);
    });
});

describe("extractPiTasks", () => {
    it("tracks tasks from TaskCreate results and TaskUpdate statuses", () => {
        const lines = [
            session,
            user("u", "plan"),
            toolCall("t1", "TaskCreate", { subject: "Fix auth bug" }),
            toolResult("t1", "TaskCreate", "Task #1 created successfully: Fix auth bug"),
            toolCall("t2", "TaskCreate", { subject: "Ship dashboard" }),
            toolResult("t2", "TaskCreate", "Task #2 created successfully: Ship dashboard"),
            toolCall("t3", "TaskUpdate", { taskId: "1", status: "in_progress" }),
            toolResult("t3", "TaskUpdate", "Task #1 updated"),
            toolCall("t4", "TaskUpdate", { taskId: "1", status: "completed" }),
            toolResult("t4", "TaskUpdate", "Task #1 updated"),
        ];
        expect(extractPiTasks(lines)).toEqual([
            { text: "Fix auth bug", done: true },
            { text: "Ship dashboard", done: false },
        ]);
    });

    it("uses a TaskList snapshot as a full-state fallback", () => {
        const lines = [
            session,
            user("u", "check"),
            toolCall("t1", "TaskList", {}),
            toolResult("t1", "TaskList", "#1 [completed] Fix auth bug\n#2 [pending] Ship dashboard"),
        ];
        expect(extractPiTasks(lines)).toEqual([
            { text: "Fix auth bug", done: true },
            { text: "Ship dashboard", done: false },
        ]);
    });

    it("returns undefined when the task tools were never used", () => {
        const lines = [
            session,
            user("u", "hello"),
            L({ type: "message", id: "a", parentId: "u", message: { role: "assistant", content: "hi" } }),
        ];
        expect(extractPiTasks(lines)).toBeUndefined();
    });

    it("ignores a TaskList result that reports no tasks", () => {
        const lines = [
            session,
            user("u", "check"),
            toolCall("t1", "TaskCreate", { subject: "Seed" }),
            toolResult("t1", "TaskCreate", "Task #1 created successfully: Seed"),
            toolCall("t2", "TaskList", {}),
            toolResult("t2", "TaskList", "No tasks found"),
        ];
        expect(extractPiTasks(lines)).toEqual([{ text: "Seed", done: false }]);
    });
});

describe("extractPiTitle", () => {
    it("uses the latest session_info name on the active branch", () => {
        const lines = [
            session,
            L({ type: "session_info", id: "si1", parentId: null, name: "old title" }),
            L({ type: "message", id: "u", parentId: "si1", message: { role: "user", content: "task" } }),
            L({ type: "session_info", id: "si2", parentId: "u", name: "new title" }),
        ];
        expect(extractPiTitle(lines)).toBe("new title");
    });

    it("falls back to the first active user text", () => {
        const lines = [session, user("u", "fix the bug")];
        expect(extractPiTitle(lines)).toBe("fix the bug");
    });

    it("skips the skill block when deriving a title from user text", () => {
        const skillText = `<skill name="grilling" location="C:\\skills\\grilling\\SKILL.md">\nReferences are relative to C:\\skills\\grilling.\n\n# Grilling\n\nBody\n</skill>\n\nstress-test my plan`;
        const lines = [
            session,
            L({ type: "message", id: "u", parentId: null, message: { role: "user", content: skillText } }),
        ];
        expect(extractPiTitle(lines)).toBe("stress-test my plan");
    });
});

describe("projectPiTranscript malformed and mistyped records", () => {
    const assistant = (content: unknown) =>
        L({ type: "message", id: "a", parentId: "u", message: { role: "assistant", content } });

    it("skips an assistant record with no content", () => {
        const lines = [
            session,
            user("u", "hi"),
            L({ type: "message", id: "a", parentId: "u", message: { role: "assistant" } }),
        ];
        expect(projectPiTranscript(lines)).toEqual([{ kind: "user", text: "hi" }]);
    });

    it("ignores blocks that are not a named tool call", () => {
        const lines = [
            session,
            user("u", "go"),
            assistant([
                null,
                { type: "text", text: "kept", name: "foo" },
                { type: "toolCall", id: "x" },
                { type: "toolCall", id: "y", name: "" },
                { type: "toolCall", id: "z", name: 7 },
            ]),
        ];
        expect(projectPiTranscript(lines)).toEqual([
            { kind: "user", text: "go" },
            { kind: "message", text: "kept" },
        ]);
    });

    it("projects the older tool_use / toolCallId / args spelling and joins its result", () => {
        const lines = [
            session,
            user("u", "go"),
            assistant([{ type: "tool_use", toolCallId: "c1", name: "bash", args: { command: "ls" } }]),
            L({
                type: "message",
                id: "r",
                parentId: "a",
                message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: "file.txt" },
            }),
        ];
        expect(projectPiTranscript(lines)).toEqual([
            { kind: "user", text: "go" },
            {
                kind: "action",
                verb: "ran",
                target: "ls",
                outcome: "ok",
                detail: { kind: "bash", command: "ls", output: "file.txt", exit: 0 },
            },
        ]);
    });

    it("keeps a call with no usable args as a bare action", () => {
        const lines = [
            session,
            user("u", "go"),
            assistant([
                { type: "toolCall", id: "a", name: "TaskList" },
                { type: "tool_use", id: "b", name: "read", args: null },
                { type: "tool_use", id: "c", name: "bash", args: null },
            ]),
        ];
        expect(projectPiTranscript(lines)).toStrictEqual([
            { kind: "user", text: "go" },
            { kind: "action", verb: "listed tasks", target: "TaskList" },
            { kind: "action", verb: "read", target: "read" },
            { kind: "action", verb: "ran", target: "bash" },
        ]);
    });

    it("drops a bash command that is not a string from the bash detail", () => {
        const lines = [
            session,
            user("u", "go"),
            toolCall("b1", "bash", { command: 5 }),
            toolResult("b1", "bash", "out"),
        ];
        const detail = (projectPiTranscript(lines)[1] as any).detail;
        expect(detail.command).toBeUndefined();
        expect(detail).toEqual({ kind: "bash", output: "out", exit: 0 });
    });

    it("ignores a tool call timestamp that is not a string", () => {
        const call = L({
            type: "message",
            id: "call-b1",
            parentId: "u",
            timestamp: 5,
            message: {
                role: "assistant",
                content: [{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "x" } }],
            },
        });
        const lines = [session, user("u", "go"), call, toolResult("b1", "bash", "out")];
        expect((projectPiTranscript(lines)[1] as any).durationMs).toBeUndefined();
    });
});

describe("extractPiTasks edge cases", () => {
    const created = (id: string, subject: string) =>
        toolResult("c" + id, "TaskCreate", `Task #${id} created successfully: ${subject}`);
    const update = (args: unknown) => toolCall("t", "TaskUpdate", args);
    const msg = (message: unknown) => L({ type: "message", message });

    it("skips records that are not messages", () => {
        const lines = [
            session,
            "null",
            L({ type: "message" }),
            L({
                type: "compaction",
                message: { role: "toolResult", toolName: "TaskCreate", content: "Task #1 created successfully: Ghost" },
            }),
        ];
        expect(extractPiTasks(lines)).toBeUndefined();
    });

    it("reads the subject from a padded TaskCreate result and keeps the first of a repeated id", () => {
        const lines = [
            toolResult("a", "TaskCreate", "  Task #1 created successfully:   Fix it  \n"),
            toolResult("b", "TaskCreate", "Failed to create task"),
            created("1", "Other name"),
        ];
        expect(extractPiTasks(lines)).toEqual([{ text: "Fix it", done: false }]);
    });

    it("ignores task-list text from a tool that is not TaskList", () => {
        expect(extractPiTasks([toolResult("t", "bash", "#3 [pending] sneaky")])).toBeUndefined();
    });

    it("reads TaskList lines with stray whitespace and updates a known task in place", () => {
        const lines = [created("1", "Fix"), toolResult("l", "TaskList", "  #1 [completed] Fix\r\n#2 [pending] Ship\r")];
        expect(extractPiTasks(lines)).toEqual([
            { text: "Fix", done: true },
            { text: "Ship", done: false },
        ]);
    });

    it("reopens a task on a status other than completed", () => {
        const lines = [
            created("1", "Fix"),
            update({ taskId: "1", status: "completed" }),
            update({ taskId: "1", status: "pending" }),
        ];
        expect(extractPiTasks(lines)).toEqual([{ text: "Fix", done: false }]);
    });

    it("ignores a TaskUpdate for an unknown id, without arguments, or without a status", () => {
        const lines = [
            created("1", "Fix"),
            update({ taskId: "1", status: "completed" }),
            update({ taskId: "9", status: "completed" }),
            update(undefined),
            L({
                type: "message",
                message: { role: "assistant", content: [{ type: "tool_use", name: "TaskUpdate", args: null }] },
            }),
            update({ taskId: "1" }),
        ];
        expect(extractPiTasks(lines)).toEqual([{ text: "Fix", done: true }]);
    });

    it("only lets an assistant TaskUpdate tool call change a task", () => {
        const lines = [
            created("1", "Fix"),
            msg({
                role: "assistant",
                content: [{ type: "text", name: "TaskUpdate", arguments: { taskId: "1", status: "completed" } }],
            }),
            toolCall("t", "TaskGet", { taskId: "1", status: "completed" }),
            msg({
                role: "user",
                content: [{ type: "toolCall", name: "TaskUpdate", arguments: { taskId: "1", status: "completed" } }],
            }),
            msg({ role: "assistant" }),
        ];
        expect(extractPiTasks(lines)).toEqual([{ text: "Fix", done: false }]);
    });

    it("reads a TaskUpdate in the older tool_use / args spelling", () => {
        const lines = [
            created("1", "Fix"),
            msg({
                role: "assistant",
                content: [{ type: "tool_use", name: "TaskUpdate", args: { taskId: "1", status: "completed" } }],
            }),
        ];
        expect(extractPiTasks(lines)).toEqual([{ text: "Fix", done: true }]);
    });
});

describe("projectPiTranscript action targets", () => {
    const targetOf = (args: unknown, name = "foo") => {
        const lines = [session, user("u", "go"), toolCall("x", name, args)];
        return (projectPiTranscript(lines)[1] as any).target;
    };

    it("trims string args and keeps a non-string, non-object arg as the bare tool name", () => {
        expect(targetOf("  ls -la  ")).toBe("ls -la");
        expect(targetOf(5)).toBe("foo");
    });

    it("falls to the bare tool name for null args", () => {
        const call = L({
            type: "message",
            id: "call-x",
            parentId: "u",
            message: {
                role: "assistant",
                content: [{ type: "toolCall", id: "x", name: "foo", arguments: null, args: null }],
            },
        });
        expect((projectPiTranscript([session, user("u", "go"), call])[1] as any).target).toBe("foo");
    });

    it("shows the trimmed command, skipping a blank or non-string one", () => {
        expect(targetOf({ command: "  make  " })).toBe("make");
        expect(targetOf({ command: "   ", path: "src/b.ts" })).toBe("b.ts");
        expect(targetOf({ command: 5, path: "src/b.ts" })).toBe("b.ts");
    });

    it("shows the leaf of a path, skipping an empty or non-string one", () => {
        expect(targetOf({ path: "C:\\repo\\src\\a.ts" })).toBe("a.ts");
        expect(targetOf({ path: "", pattern: "needle" })).toBe("needle");
        expect(targetOf({ path: 5, pattern: "needle" })).toBe("needle");
    });

    it("shows a pattern, then a subject, skipping empty or non-string values", () => {
        expect(targetOf({ pattern: "needle", subject: "S" })).toBe("needle");
        expect(targetOf({ pattern: "", subject: "S" })).toBe("S");
        expect(targetOf({ pattern: 5, subject: "S" })).toBe("S");
        expect(targetOf({ subject: "", taskId: "7" })).toBe("task #7");
        expect(targetOf({ subject: 5, taskId: "7" })).toBe("task #7");
    });

    it("shows a task id, then a task id list, skipping an empty or non-string id", () => {
        expect(targetOf({ taskId: "3", task_ids: ["1"] })).toBe("task #3");
        expect(targetOf({ taskId: "", task_ids: ["1", 2] })).toBe("task #1, task #2");
        expect(targetOf({ taskId: 3, task_ids: ["1"] })).toBe("task #1");
        expect(targetOf({ task_ids: ["4", "5"], agent: "rev" })).toBe("task #4, task #5");
    });

    it("shows an agent name, skipping an empty or non-string one", () => {
        expect(targetOf({ agent: "rev" })).toBe("rev");
        expect(targetOf({ agent: "" })).toBe("foo");
        expect(targetOf({ agent: 5 })).toBe("foo");
    });
});

describe("projectPiTranscript edit details", () => {
    const detailOf = (name: string, args: unknown) => {
        const lines = [session, user("u", "go"), toolCall("x", name, args)];
        return projectPiTranscript(lines)[1] as any;
    };

    it("gives no detail for null args", () => {
        const call = L({
            type: "message",
            id: "call-x",
            parentId: "u",
            message: {
                role: "assistant",
                content: [{ type: "toolCall", id: "x", name: "write", arguments: null, args: null }],
            },
        });
        expect(projectPiTranscript([session, user("u", "go"), call])[1]).toStrictEqual({
            kind: "action",
            verb: "wrote",
            target: "write",
        });
    });

    it("writes an empty path when the path is not a string", () => {
        const action = detailOf("write", { path: 5, content: "x" });
        expect(action.detail.files[0]).toMatchObject({ path: "", badge: "A", adds: 1, dels: 0 });
    });

    it("gives a write detail only for a write with string content", () => {
        expect(detailOf("write", { path: "a.ts" }).detail).toBeUndefined();
        expect(detailOf("write", { path: "a.ts", content: 5 }).detail).toBeUndefined();
        expect(detailOf("edit", { path: "a.ts", content: "x" }).detail).toBeUndefined();
    });

    it("gives an edit detail only for an edit with an edits array", () => {
        const edits = [{ oldText: "a", newText: "b" }];
        expect(detailOf("edit", { path: "a.ts", edits: "nope" }).detail).toBeUndefined();
        expect(detailOf("bash", { path: "a.ts", edits }).detail).toBeUndefined();
        expect(detailOf("edit", { path: "a.ts", edits }).detail.files).toHaveLength(1);
    });

    it("keeps only edits that carry both old and new text", () => {
        const action = detailOf("edit", {
            path: "a.ts",
            edits: [
                { oldText: "a", newText: "b" },
                { oldText: "only old" },
                { newText: "only new" },
                { oldText: 5, newText: "b" },
                { oldText: "a", newText: 5 },
            ],
        });
        expect(action.detail.files).toHaveLength(1);
        expect(action.detail.files[0]).toMatchObject({ path: "a.ts", badge: "M", adds: 1, dels: 1 });
    });

    it("gives no detail when no edit is usable", () => {
        expect(detailOf("edit", { path: "a.ts", edits: [] })).toStrictEqual({
            kind: "action",
            verb: "edited",
            target: "a.ts",
        });
        expect(detailOf("edit", { path: "a.ts", edits: [{ oldText: "a" }] })).toStrictEqual({
            kind: "action",
            verb: "edited",
            target: "a.ts",
        });
    });
});

describe("projectPiTranscript text blocks", () => {
    const userContent = (content: unknown) =>
        L({ type: "message", id: "u", parentId: null, message: { role: "user", content } });

    it("trims string content and drops blank string content", () => {
        expect(projectPiTranscript([session, userContent("  hi  ")])).toStrictEqual([{ kind: "user", text: "hi" }]);
        expect(projectPiTranscript([session, userContent("   ")])).toStrictEqual([]);
    });

    it("yields nothing for content that is neither a string nor an array", () => {
        expect(projectPiTranscript([session, userContent(5)])).toStrictEqual([]);
        expect(projectPiTranscript([session, userContent({ type: "text", text: "x" })])).toStrictEqual([]);
        expect(
            projectPiTranscript([session, L({ type: "message", id: "u", parentId: null, message: { role: "user" } })])
        ).toStrictEqual([]);
    });

    it("keeps text blocks with their text untrimmed and skips every other block", () => {
        const content = [
            { type: "text", text: " kept " },
            { type: "image", text: "not text" },
            { type: "text" },
            { type: "text", text: "   " },
            { type: "text", text: 5 },
            { type: "text", text: "second" },
        ];
        expect(projectPiTranscript([session, userContent(content)])).toStrictEqual([
            { kind: "user", text: " kept " },
            { kind: "user", text: "second" },
        ]);
    });
});

describe("projectPiTranscript tool results", () => {
    const callAt = (id: string, name: string, args: unknown, ts?: unknown, parent = "u") =>
        L({
            type: "message",
            id: "call-" + id,
            parentId: parent,
            ...(ts === undefined ? {} : { timestamp: ts }),
            message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] },
        });
    const resultMsg = (id: string, message: unknown, ts?: unknown) =>
        L({
            type: "message",
            id: "res-" + id,
            parentId: "call-" + id,
            ...(ts === undefined ? {} : { timestamp: ts }),
            message,
        });
    const actionOf = (lines: string[]) => projectPiTranscript([session, user("u", "go"), ...lines])[1] as any;

    it("joins a result to its call by a tool_result content block id when the message has none", () => {
        const action = actionOf([
            callAt("c1", "read", { path: "a.ts" }),
            resultMsg("c1", {
                role: "toolResult",
                content: [
                    { type: "tool_result", toolCallId: "c1" },
                    { type: "text", text: "body" },
                ],
            }),
        ]);
        expect(action.detail).toStrictEqual({ kind: "read", snippet: "body", truncated: false });
    });

    it("prefers the message-level call id over a content block id", () => {
        const action = actionOf([
            callAt("c1", "read", { path: "a.ts" }),
            resultMsg("c1", {
                role: "toolResult",
                toolCallId: "c1",
                content: [
                    { type: "tool_result", toolCallId: "other" },
                    { type: "text", text: "body" },
                ],
            }),
        ]);
        expect(action.detail).toStrictEqual({ kind: "read", snippet: "body", truncated: false });
    });

    it("skips content blocks that are not tool_result when looking for a call id", () => {
        const action = actionOf([
            callAt("c1", "read", { path: "a.ts" }),
            resultMsg("c1", { role: "toolResult", content: [{ type: "text", toolCallId: "c1", text: "body" }] }),
        ]);
        expect(action).toStrictEqual({ kind: "action", verb: "read", target: "a.ts" });
    });

    it("ignores a result that has no call id and no content", () => {
        const action = actionOf([callAt("c1", "bash", { command: "ls" }), resultMsg("c1", { role: "toolResult" })]);
        expect(action).toStrictEqual({ kind: "action", verb: "ran", target: "ls" });
    });

    it("ignores a result whose call id matches no call", () => {
        const action = actionOf([
            callAt("c1", "bash", { command: "ls" }),
            resultMsg("c1", { role: "toolResult", toolCallId: "ghost", content: "out", isError: true }),
        ]);
        expect(action).toStrictEqual({ kind: "action", verb: "ran", target: "ls" });
    });

    it("only settles an action from a toolResult role message", () => {
        const action = actionOf([
            callAt("c1", "bash", { command: "ls" }),
            resultMsg("c1", { role: "custom", toolCallId: "c1", content: "out", isError: true }),
        ]);
        expect(action).toStrictEqual({ kind: "action", verb: "ran", target: "ls" });
    });

    it("says '1 match' for a single grep match", () => {
        const action = actionOf([
            callAt("g1", "grep", { pattern: "x" }),
            resultMsg("g1", { role: "toolResult", toolCallId: "g1", content: "a.ts:3: x" }),
        ]);
        expect(action.summary).toBe("1 match");
    });

    it("gives bash detail only to a bash result with output", () => {
        const empty = actionOf([
            callAt("b1", "bash", { command: "true" }),
            resultMsg("b1", { role: "toolResult", toolCallId: "b1", content: "" }),
        ]);
        expect(empty).toStrictEqual({ kind: "action", verb: "ran", target: "true", outcome: "ok" });
        const other = actionOf([
            callAt("l1", "ls", { path: "src" }),
            resultMsg("l1", { role: "toolResult", toolCallId: "l1", content: "a.ts" }),
        ]);
        expect(other).toStrictEqual({ kind: "action", verb: "listed", target: "src" });
    });

    it("computes a duration only from two valid timestamps with the result not before the call", () => {
        const ok = { role: "toolResult", toolCallId: "t1", content: "" };
        const t0 = "2026-08-11T03:00:05.000Z";
        const duration = (callTs: unknown, resTs: unknown) =>
            actionOf([callAt("t1", "bash", { command: "x" }, callTs), resultMsg("t1", ok, resTs)]).durationMs;
        expect(duration(t0, "2026-08-11T03:00:07.500Z")).toBe(2500);
        expect(duration(t0, t0)).toBe(0);
        expect(duration(t0, "2026-08-11T03:00:01.000Z")).toBeUndefined();
        expect(duration(t0, undefined)).toBeUndefined();
        expect(duration(undefined, t0)).toBeUndefined();
        expect(duration(undefined, undefined)).toBeUndefined();
        expect(duration("1990-01-01T00:00:00.000Z", [t0])).toBeUndefined();
    });

    it("marks fail from a message-level isError or is_error flag", () => {
        const fail = (flags: object) =>
            actionOf([
                callAt("c1", "read", { path: "a.ts" }),
                resultMsg("c1", { role: "toolResult", toolCallId: "c1", content: "x", ...flags }),
            ]).outcome;
        expect(fail({ isError: true })).toBe("fail");
        expect(fail({ is_error: true })).toBe("fail");
        expect(fail({ isError: false, is_error: false })).toBeUndefined();
    });

    it("marks fail from a tool_result content block's isError or is_error flag", () => {
        const fail = (block: object) =>
            actionOf([
                callAt("c1", "read", { path: "a.ts" }),
                resultMsg("c1", {
                    role: "toolResult",
                    toolCallId: "c1",
                    content: [{ type: "text", text: "x" }, block],
                }),
            ]).outcome;
        expect(fail({ type: "tool_result", isError: true })).toBe("fail");
        expect(fail({ type: "tool_result", is_error: true })).toBe("fail");
        expect(fail({ type: "tool_result", isError: false })).toBeUndefined();
        expect(fail({ type: "text", isError: true })).toBeUndefined();
        expect(fail({ type: "text", is_error: true })).toBeUndefined();
    });

    it("does not read failure flags off a non-array content", () => {
        const action = actionOf([
            callAt("c1", "read", { path: "a.ts" }),
            resultMsg("c1", { role: "toolResult", toolCallId: "c1" }),
        ]);
        expect(action).toStrictEqual({ kind: "action", verb: "read", target: "a.ts" });
    });
});

describe("projectPiTranscript record filtering", () => {
    it("renders only message records that carry a message", () => {
        const lines = [
            session,
            user("u", "keep"),
            L({ type: "custom", id: "x", parentId: "u", message: { role: "user", content: "ghost" } }),
            L({ type: "message", id: "y", parentId: "x" }),
        ];
        expect(projectPiTranscript(lines)).toStrictEqual([{ kind: "user", text: "keep" }]);
    });

    it("keeps a compaction summary only when it is a non-blank string, and tokensBefore only when a number", () => {
        const compaction = (extra: object) =>
            projectPiTranscript([
                session,
                user("u", "go"),
                L({ type: "compaction", id: "c", parentId: "u", ...extra }),
            ])[1];
        expect(compaction({})).toStrictEqual({ kind: "compaction" });
        expect(compaction({ summary: "   ", tokensBefore: "9" })).toStrictEqual({ kind: "compaction" });
        expect(compaction({ summary: 5 })).toStrictEqual({ kind: "compaction" });
        expect(compaction({ summary: "kept", tokensBefore: 7 })).toStrictEqual({
            kind: "compaction",
            summary: "kept",
            preTokens: 7,
        });
    });

    it("does not link a child to a parent whose id is not a string", () => {
        const lines = [
            session,
            L({ type: "message", id: 5, parentId: null, message: { role: "user", content: "numeric parent" } }),
            L({ type: "message", id: "a", parentId: 5, message: { role: "assistant", content: "child" } }),
        ];
        expect(projectPiTranscript(lines)).toStrictEqual([{ kind: "message", text: "child" }]);
    });
});

describe("extractPiTitle record filtering", () => {
    it("takes the latest non-blank string session name, trimmed", () => {
        const lines = [
            session,
            L({ type: "session_info", id: "s1", parentId: null, name: "  first  " }),
            L({ type: "session_info", id: "s2", parentId: "s1", name: "   " }),
            L({ type: "session_info", id: "s3", parentId: "s2", name: 5 }),
            L({ type: "model_change", id: "s4", parentId: "s3", name: "not a session name" }),
        ];
        expect(extractPiTitle(lines)).toBe("first");
    });

    it("trims a lone session name", () => {
        const lines = [session, L({ type: "session_info", id: "s1", parentId: null, name: "  padded  " })];
        expect(extractPiTitle(lines)).toBe("padded");
    });

    it("falls back to the first user message, skipping records that are not user messages", () => {
        const lines = [
            session,
            L({ type: "model_change", id: "m", parentId: null }),
            L({ type: "custom", id: "c", parentId: "m", message: { role: "user", content: "ghost" } }),
            L({ type: "message", id: "a", parentId: "c", message: { role: "assistant", content: "assistant text" } }),
            L({ type: "message", id: "u", parentId: "a", message: { role: "user", content: "real prompt" } }),
        ];
        expect(extractPiTitle(lines)).toBe("real prompt");
    });
});
