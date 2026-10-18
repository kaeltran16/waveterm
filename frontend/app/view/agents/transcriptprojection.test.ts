import { describe, expect, it } from "vitest";
import { extractAiTitle, extractSubagentSpawns, extractTasks, projectTranscript } from "./transcriptprojection";

const LINES: string[] = [
    JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "fix the race" }] } }), // human prompt -> user entry
    JSON.stringify({
        type: "assistant",
        message: {
            content: [
                { type: "thinking", thinking: "let me look" }, // skipped
                { type: "text", text: "The clone re-reads the source block by id, so a stale id slips through." },
                { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/home/u/proj/sessionmodel.go" } },
            ],
        },
    }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false }] } }), // edited, non-ran -> no outcome
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "go test ./...", description: "go test ./..." } }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", is_error: true }] } }), // ran + error -> fail
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t3", name: "Bash", input: { description: "go build" } }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t3", is_error: false }] } }), // ran + success -> ok
    "{ not valid json", // skipped
    JSON.stringify({ type: "file-history-snapshot", foo: 1 }), // unknown type -> ignored
];

describe("projectTranscript", () => {
    it("projects messages, actions, and outcomes in order", () => {
        expect(projectTranscript(LINES)).toEqual([
            { kind: "user", text: "fix the race" },
            { kind: "message", text: "The clone re-reads the source block by id, so a stale id slips through." },
            { kind: "action", verb: "edited", target: "sessionmodel.go" },
            { kind: "action", verb: "ran", target: "go test ./...", outcome: "fail" },
            { kind: "action", verb: "ran", target: "go build", outcome: "ok" },
        ]);
    });

    it("returns [] for empty input and skips unparseable lines", () => {
        expect(projectTranscript([])).toEqual([]);
        expect(projectTranscript(["garbage", "{bad"])).toEqual([]);
    });

    it("maps unknown tools to a lowercased verb and the salient input", () => {
        const out = projectTranscript([
            JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "x", name: "WebFetch", input: { pattern: "abc" } }] } }),
        ]);
        expect(out).toEqual([{ kind: "action", verb: "webfetch", target: "abc" }]);
    });

    it("emits an action with no outcome when tool_use has no id (result can't be matched)", () => {
        const out = projectTranscript([
            JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { description: "go test ./..." } }] } }),
            JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "missing", is_error: true }] } }),
        ]);
        expect(out).toEqual([{ kind: "action", verb: "ran", target: "go test ./..." }]);
    });
});

describe("projectTranscript user turns", () => {
    const L = (obj: unknown) => JSON.stringify(obj);

    it("projects a user string turn as a user entry, in order", () => {
        const out = projectTranscript([
            L({ type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } }),
            L({ type: "user", message: { content: "do the thing" } }),
        ]);
        expect(out).toEqual([
            { kind: "message", text: "Hello" },
            { kind: "user", text: "do the thing" },
        ]);
    });

    it("projects a user text block as a user entry", () => {
        const out = projectTranscript([L({ type: "user", message: { content: [{ type: "text", text: "option B" }] } })]);
        expect(out).toEqual([{ kind: "user", text: "option B" }]);
    });

    it("emits no user entry for a tool_result-only record but still applies the outcome", () => {
        const out = projectTranscript([
            L({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } }),
            L({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false }] } }),
        ]);
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({ kind: "action", verb: "ran", outcome: "ok" });
    });
});

describe("projectTranscript commands and isMeta", () => {
    const L = (o: unknown) => JSON.stringify(o);

    it("parses a <command-name> user string into a command entry (slash kept, message dropped, args when present)", () => {
        const withArgs = "<command-name>/review</command-name>\n  <command-message>review</command-message>\n  <command-args>PR #402</command-args>";
        const bare = "<command-name>/clear</command-name>\n  <command-message>clear</command-message>\n  <command-args></command-args>";
        expect(projectTranscript([L({ type: "user", message: { content: withArgs } })])).toEqual([
            { kind: "command", name: "/review", args: "PR #402" },
        ]);
        expect(projectTranscript([L({ type: "user", message: { content: bare } })])).toEqual([
            { kind: "command", name: "/clear" },
        ]);
    });

    it("normalizes a command-name that lacks a leading slash", () => {
        const out = projectTranscript([
            L({ type: "user", message: { content: "<command-name>compact</command-name><command-args></command-args>" } }),
        ]);
        expect(out).toEqual([{ kind: "command", name: "/compact" }]);
    });

    it("skips synthetic isMeta user records (skill body dumps, caveats, continuation)", () => {
        const out = projectTranscript([
            L({ type: "user", isMeta: true, message: { content: [{ type: "text", text: "# Skill body\n\nlong markdown" }] } }),
            L({ type: "user", isMeta: true, message: { content: "<local-command-caveat>Caveat...</local-command-caveat>" } }),
            L({ type: "user", message: { content: "real prompt" } }),
        ]);
        expect(out).toEqual([{ kind: "user", text: "real prompt" }]);
    });
    it("renders a user-invoked skill (caller.direct) as a skill command chip with the leaf name", () => {
        const out = projectTranscript([
            L({
                type: "assistant",
                message: {
                    content: [
                        { type: "tool_use", id: "s1", name: "Skill", input: { skill: "superpowers:brainstorming", args: "design the cache" }, caller: { type: "direct" } },
                    ],
                },
            }),
        ]);
        expect(out).toEqual([{ kind: "command", name: "brainstorming", isSkill: true, args: "design the cache" }]);
    });

    it("omits args for a skill chip with no args", () => {
        const out = projectTranscript([
            L({ type: "assistant", message: { content: [{ type: "tool_use", id: "s2", name: "Skill", input: { skill: "commit" }, caller: { type: "direct" } }] } }),
        ]);
        expect(out).toEqual([{ kind: "command", name: "commit", isSkill: true }]);
    });
});

describe("projectTranscript compaction", () => {
    const L = (o: unknown) => JSON.stringify(o);
    const boundary = L({
        type: "system",
        subtype: "compact_boundary",
        content: "Conversation compacted",
        compactMetadata: { trigger: "manual", preTokens: 415334, postTokens: 22859 },
    });
    const summary = L({ type: "user", isCompactSummary: true, message: { content: "This session is being continued...\n\nSummary:\n**kept**" } });

    it("merges an adjacent boundary + summary into one compaction entry", () => {
        expect(projectTranscript([boundary, summary])).toEqual([
            { kind: "compaction", trigger: "manual", preTokens: 415334, postTokens: 22859, summary: "This session is being continued...\n\nSummary:\n**kept**" },
        ]);
    });

    it("produces a summary-only compaction when there is no boundary", () => {
        expect(projectTranscript([summary])).toEqual([{ kind: "compaction", summary: "This session is being continued...\n\nSummary:\n**kept**" }]);
    });

    it("produces a stats-only compaction when there is no summary", () => {
        expect(projectTranscript([boundary])).toEqual([{ kind: "compaction", trigger: "manual", preTokens: 415334, postTokens: 22859 }]);
    });

    it("does not fold a real user turn into the compaction", () => {
        const out = projectTranscript([boundary, L({ type: "user", message: { content: "next thing" } }), summary]);
        expect(out).toEqual([
            { kind: "compaction", trigger: "manual", preTokens: 415334, postTokens: 22859 },
            { kind: "user", text: "next thing" },
            { kind: "compaction", summary: "This session is being continued...\n\nSummary:\n**kept**" },
        ]);
    });
});

describe("projectTranscript task-notification, stdout, and interrupts", () => {
    const L = (o: unknown) => JSON.stringify(o);

    it("projects a task-notification user string into a notification entry (summary/status/result)", () => {
        const content = [
            "<task-notification>",
            "<task-id>abc123</task-id>",
            "<tool-use-id>toolu_1</tool-use-id>",
            "<status>completed</status>",
            '<summary>Agent "Map layout" finished</summary>',
            "<note>a note</note>",
            "<result>Here is the report.</result>",
            "</task-notification>",
        ].join("\n");
        expect(projectTranscript([L({ type: "user", message: { content } })])).toEqual([
            { kind: "notification", summary: 'Agent "Map layout" finished', status: "completed", result: "Here is the report." },
        ]);
    });

    it("omits result when the task-notification has none", () => {
        const content = "<task-notification>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>";
        expect(projectTranscript([L({ type: "user", message: { content } })])).toEqual([
            { kind: "notification", summary: "done", status: "completed" },
        ]);
    });

    it("skips a user-string <local-command-stdout> record (with ANSI) rather than leaking the raw tag", () => {
        const content = "<local-command-stdout>[2mCompacted (ctrl+o to see full summary)[22m</local-command-stdout>";
        expect(projectTranscript([L({ type: "user", message: { content } })])).toEqual([]);
    });

    it("projects [Request interrupted by user] as an interrupted marker, both as a text block and a string", () => {
        expect(projectTranscript([L({ type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } })])).toEqual([
            { kind: "interrupted" },
        ]);
        expect(projectTranscript([L({ type: "user", message: { content: "[Request interrupted by user for tool use]" } })])).toEqual([
            { kind: "interrupted" },
        ]);
    });
});

describe("extractAiTitle", () => {
    it("returns the LAST ai-title's aiTitle", () => {
        const lines = [
            JSON.stringify({ type: "mode", mode: "normal" }),
            JSON.stringify({ type: "ai-title", aiTitle: "First guess" }),
            JSON.stringify({ type: "last-prompt", lastPrompt: "do the thing" }),
            JSON.stringify({ type: "ai-title", aiTitle: "Fix duplicate-session race" }),
        ];
        expect(extractAiTitle(lines)).toBe("Fix duplicate-session race");
    });

    it("returns undefined when there is no ai-title, and skips unparseable lines", () => {
        expect(extractAiTitle([JSON.stringify({ type: "assistant", message: { content: [] } }), "{bad"])).toBeUndefined();
        expect(extractAiTitle([])).toBeUndefined();
    });

    it("ignores records that are not an ai-title, and an ai-title that is blank or not a string", () => {
        const lines = [
            JSON.stringify({ type: "ai-title", aiTitle: "Real title" }),
            JSON.stringify({ type: "summary", aiTitle: "Other record" }),
            JSON.stringify({ type: "assistant", message: { content: [] } }),
            JSON.stringify({ type: "ai-title" }),
            JSON.stringify({ type: "ai-title", aiTitle: 5 }),
            JSON.stringify({ type: "ai-title", aiTitle: "" }),
            JSON.stringify({ type: "ai-title", aiTitle: "   " }),
        ];
        expect(extractAiTitle(lines)).toBe("Real title");
    });
});

describe("extractTasks", () => {
    const todoUse = (todos: unknown[]) =>
        JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "tool_use", id: "tw1", name: "TodoWrite", input: { todos } }] },
        });

    it("returns undefined when the transcript has no TodoWrite", () => {
        expect(extractTasks([])).toBeUndefined();
        expect(
            extractTasks([
                JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "e", name: "Edit", input: {} }] } }),
            ])
        ).toBeUndefined();
    });

    it("maps content to text and completed status to done:true, others to false", () => {
        const out = extractTasks([
            todoUse([
                { content: "Read the failing test", status: "completed", activeForm: "Reading the failing test" },
                { content: "Patch the handler", status: "in_progress", activeForm: "Patching the handler" },
                { content: "Add a regression test", status: "pending", activeForm: "Adding a regression test" },
            ]),
        ]);
        expect(out).toEqual([
            { text: "Read the failing test", done: true },
            { text: "Patch the handler", done: false },
            { text: "Add a regression test", done: false },
        ]);
    });

    it("uses the LAST TodoWrite when several are present", () => {
        const out = extractTasks([
            todoUse([{ content: "old task", status: "pending" }]),
            todoUse([
                { content: "new a", status: "completed" },
                { content: "new b", status: "pending" },
            ]),
        ]);
        expect(out).toEqual([
            { text: "new a", done: true },
            { text: "new b", done: false },
        ]);
    });

    it("returns [] for an empty todos list", () => {
        expect(extractTasks([todoUse([])])).toEqual([]);
    });

    it("skips unparseable lines and malformed todo entries", () => {
        const out = extractTasks([
            "{ not json",
            todoUse([{ content: "kept", status: "completed" }, { status: "pending" }, { content: 42, status: "pending" }]),
        ]);
        expect(out).toEqual([{ text: "kept", done: true }]);
    });

    it("ignores a TodoWrite in a record that is not an assistant message", () => {
        const user = JSON.stringify({
            type: "user",
            message: { content: [{ type: "tool_use", id: "u1", name: "TodoWrite", input: { todos: [{ content: "x" }] } }] },
        });
        expect(extractTasks([user])).toBeUndefined();
    });

    it("skips an assistant record without a content array and still finds a later list", () => {
        const noContent = JSON.stringify({ type: "assistant", message: {} });
        const stringContent = JSON.stringify({ type: "assistant", message: { content: "plain" } });
        const out = extractTasks([noContent, stringContent, todoUse([{ content: "later", status: "pending" }])]);
        expect(out).toEqual([{ text: "later", done: false }]);
    });

    it("takes only a tool_use block named TodoWrite whose todos are an array", () => {
        const block = (b: unknown) => JSON.stringify({ type: "assistant", message: { content: [b] } });
        const todos = [{ content: "wrong", status: "completed" }];
        const lines = [
            block({ type: "text", text: "hello" }),
            block(null),
            block({ type: "tool_use", id: "o1", name: "Other", input: { todos } }),
            block({ type: "text", name: "TodoWrite", input: { todos } }),
            block({ type: "tool_use", id: "o2", name: "TodoWrite", input: { todos: "not a list" } }),
            block({ type: "tool_use", id: "o3", name: "TodoWrite" }),
        ];
        expect(extractTasks(lines)).toBeUndefined();
        expect(extractTasks([todoUse([{ content: "kept" }]), ...lines])).toEqual([{ text: "kept", done: false }]);
    });
});

describe("projectTranscript thinking blocks", () => {
    it("skips assistant thinking blocks (internal chain-of-thought is not narration)", () => {
        const lines = [
            JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: "secret reasoning" }] } }),
            JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "visible narration" }] } }),
        ];
        const entries = projectTranscript(lines);
        expect(entries).toEqual([{ kind: "message", text: "visible narration" }]);
    });
});

describe("projectTranscript detail", () => {
    const L = (o: unknown) => JSON.stringify(o);

    it("attaches an edit diff from Edit old/new strings", () => {
        const out = projectTranscript([
            L({ type: "assistant", message: { content: [{ type: "tool_use", id: "e1", name: "Edit", input: { file_path: "/p/a.ts", old_string: "a\nb", new_string: "c" } }] } }),
            L({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "e1", is_error: false }] } }),
        ]);
        expect(out[0]).toMatchObject({ kind: "action", verb: "edited", target: "a.ts" });
        expect((out[0] as any).detail).toEqual({
            kind: "edit",
            files: [
                {
                    path: "/p/a.ts",
                    badge: "M",
                    adds: 1,
                    dels: 2,
                    lines: [
                        { sign: "-", text: "a" },
                        { sign: "-", text: "b" },
                        { sign: "+", text: "c" },
                    ],
                },
            ],
        });
    });

    it("attaches the raw command (not the description) plus output + exit to a bash detail", () => {
        const out = projectTranscript([
            L({ type: "assistant", message: { content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "npm test", description: "run tests" } }] } }),
            L({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "b1", is_error: false, content: "24 passing" }] } }),
        ]);
        // the line shows the human description; the raw command lives in the detail
        expect(out[0]).toMatchObject({ kind: "action", verb: "ran", target: "run tests" });
        expect((out[0] as any).detail).toEqual({ kind: "bash", command: "npm test", output: "24 passing", exit: 0 });
    });

    it("renders a Skill call as a labeled line (verb + skill name) with an args detail", () => {
        const out = projectTranscript([
            L({ type: "assistant", message: { content: [{ type: "tool_use", id: "s1", name: "Skill", input: { skill: "brainstorming", args: "design the cache" } }] } }),
        ]);
        expect(out[0]).toMatchObject({ kind: "action", verb: "skill", target: "brainstorming" });
        expect((out[0] as any).detail).toEqual({ kind: "skill", name: "brainstorming", args: "design the cache" });
    });

    it("omits the args detail field when a Skill call has no args", () => {
        const out = projectTranscript([
            L({ type: "assistant", message: { content: [{ type: "tool_use", id: "s2", name: "Skill", input: { skill: "commit" } }] } }),
        ]);
        expect(out[0]).toMatchObject({ kind: "action", verb: "skill", target: "commit" });
        expect((out[0] as any).detail).toEqual({ kind: "skill", name: "commit" });
    });

    it("computes durationMs from record timestamps", () => {
        const out = projectTranscript([
            L({ type: "assistant", timestamp: "2026-07-08T00:00:00.000Z", message: { content: [{ type: "tool_use", id: "b2", name: "Bash", input: { command: "x" } }] } }),
            L({ type: "user", timestamp: "2026-07-08T00:00:03.200Z", message: { content: [{ type: "tool_result", tool_use_id: "b2", is_error: false, content: "" }] } }),
        ]);
        expect((out[0] as any).durationMs).toBe(3200);
    });

    it("does not leak private scratch fields (_useTs/_tool)", () => {
        const out = projectTranscript([
            L({ type: "assistant", timestamp: "2026-07-08T00:00:00.000Z", message: { content: [{ type: "tool_use", id: "b3", name: "Bash", input: { command: "x" } }] } }),
            L({ type: "user", timestamp: "2026-07-08T00:00:01.000Z", message: { content: [{ type: "tool_result", tool_use_id: "b3", is_error: false, content: "out" }] } }),
        ]);
        expect(Object.keys(out[0])).not.toContain("_useTs");
        expect(Object.keys(out[0])).not.toContain("_tool");
        expect(Object.keys(out[0])).not.toContain("_command");
    });
});

describe("extractSubagentSpawns", () => {
    const asst = (blocks: any[]) => JSON.stringify({ type: "assistant", message: { content: blocks } });
    const usr = (blocks: any[]) => JSON.stringify({ type: "user", message: { content: blocks } });

    it("pairs a completed Task with its ok result", () => {
        const lines = [
            asst([{ type: "tool_use", id: "t1", name: "Task", input: { subagent_type: "Explore", prompt: "look at X" } }]),
            usr([{ type: "tool_result", tool_use_id: "t1", is_error: false }]),
        ];
        expect(extractSubagentSpawns(lines)).toEqual([
            { toolUseId: "t1", subagentType: "Explore", prompt: "look at X", done: true, failed: false },
        ]);
    });

    it("marks a still-running Task as not done", () => {
        const lines = [asst([{ type: "tool_use", id: "t2", name: "Task", input: { subagent_type: "Plan", prompt: "plan Y" } }])];
        expect(extractSubagentSpawns(lines)[0]).toMatchObject({ done: false, failed: false });
    });

    it("marks an errored Task as failed", () => {
        const lines = [
            asst([{ type: "tool_use", id: "t3", name: "Task", input: { subagent_type: "Test", prompt: "test Z" } }]),
            usr([{ type: "tool_result", tool_use_id: "t3", is_error: true }]),
        ];
        expect(extractSubagentSpawns(lines)[0]).toMatchObject({ done: true, failed: true });
    });

    it("keeps parallel spawns in first-seen order and ignores non-Task tools", () => {
        const lines = [
            asst([{ type: "tool_use", id: "r", name: "Read", input: { file_path: "a" } }]),
            asst([{ type: "tool_use", id: "a", name: "Task", input: { subagent_type: "Explore", prompt: "P1" } }]),
            asst([{ type: "tool_use", id: "b", name: "Task", input: { subagent_type: "Explore", prompt: "P2" } }]),
        ];
        expect(extractSubagentSpawns(lines).map((s) => s.toolUseId)).toEqual(["a", "b"]);
    });

    it("lists an Agent tool_use as a spawn like a Task", () => {
        const lines = [asst([{ type: "tool_use", id: "g1", name: "Agent", input: { subagent_type: "Plan", prompt: "plan it" } }])];
        expect(extractSubagentSpawns(lines)).toStrictEqual([
            { toolUseId: "g1", subagentType: "Plan", prompt: "plan it", done: false, failed: false },
        ]);
    });

    it("reads a missing or non-string subagent_type and prompt as empty strings", () => {
        const lines = [
            asst([{ type: "tool_use", id: "e1", name: "Task", input: { prompt: 5 } }]),
            asst([{ type: "tool_use", id: "e2", name: "Task", input: { subagent_type: 7 } }]),
            asst([{ type: "tool_use", id: "e3", name: "Task" }]),
        ];
        expect(extractSubagentSpawns(lines)).toStrictEqual([
            { toolUseId: "e1", subagentType: "", prompt: "", done: false, failed: false },
            { toolUseId: "e2", subagentType: "", prompt: "", done: false, failed: false },
            { toolUseId: "e3", subagentType: "", prompt: "", done: false, failed: false },
        ]);
    });

    it("ignores records without content, blocks that are not Task tool_use with an id, and results for no spawn", () => {
        const lines = [
            JSON.stringify({ type: "system" }),
            asst([
                null,
                { type: "text", name: "Task", id: "x1" },
                { type: "tool_use", name: "Task", input: { prompt: "no id" } },
                { type: "tool_use", id: 9, name: "Task", input: { prompt: "numeric id" } },
                { type: "tool_use", id: "k1", name: "Task", input: { prompt: "real" } },
            ]),
            usr([
                { type: "tool_result", tool_use_id: "unknown", is_error: true },
                { type: "text", tool_use_id: "k1" },
                { type: "tool_result" },
            ]),
        ];
        expect(extractSubagentSpawns(lines)).toStrictEqual([
            { toolUseId: "k1", subagentType: "", prompt: "real", done: false, failed: false },
        ]);
    });
});

describe("projectTranscript AskUserQuestion", () => {
    const store = {
        question: "Which store?",
        header: "Store",
        multiSelect: false,
        options: [
            { label: "SQLite", description: "Reuse the object store" },
            { label: "In-memory map", description: "" },
        ],
    };
    const checks = {
        question: "Which checks?",
        header: "Checks",
        multiSelect: true,
        options: [{ label: "Go tests" }, { label: "CDP scenario" }, { label: "Lint" }],
    };
    const ask = (questions: unknown[]) =>
        JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "tool_use", id: "q1", name: "AskUserQuestion", input: { questions } }] },
        });
    const result = (toolUseResult: unknown, isError = false) =>
        JSON.stringify({
            type: "user",
            toolUseResult,
            message: { content: [{ type: "tool_result", tool_use_id: "q1", is_error: isError, content: "x" }] },
        });

    it("shows the question as the target and lists the options before an answer comes", () => {
        expect(projectTranscript([ask([store])])).toEqual([
            {
                kind: "action",
                verb: "asked",
                target: "Which store?",
                detail: {
                    kind: "ask",
                    questions: [
                        {
                            question: "Which store?",
                            header: "Store",
                            options: [{ label: "SQLite", description: "Reuse the object store" }, { label: "In-memory map" }],
                            picked: [],
                        },
                    ],
                },
            },
        ]);
    });

    it("puts a single answer in the summary and marks the picked option", () => {
        const [action] = projectTranscript([ask([store]), result({ answers: { "Which store?": "SQLite" } })]) as any[];
        expect(action.summary).toBe("SQLite");
        expect(action.outcome).toBeUndefined();
        expect(action.detail.questions[0].picked).toEqual(["SQLite"]);
        expect(action.detail.questions[0].typed).toBeUndefined();
    });

    it("splits several picks from a typed answer, and counts answers across questions", () => {
        const [action] = projectTranscript([
            ask([store, checks]),
            result({ answers: { "Which store?": "a bolt file", "Which checks?": "Go tests, CDP scenario, a soak run" } }),
        ]) as any[];
        expect(action.summary).toBe("2 answers");
        expect(action.detail.questions[0]).toMatchObject({ picked: [], typed: "a bolt file" });
        expect(action.detail.questions[1]).toMatchObject({ picked: ["Go tests", "CDP scenario"], typed: "a soak run" });
    });

    it("cuts a long single answer so the summary cannot push the question out", () => {
        const long = "x".repeat(60);
        const [action] = projectTranscript([ask([store]), result({ answers: { "Which store?": long } })]) as any[];
        expect(action.summary).toBe("x".repeat(31) + "…");
        expect(action.detail.questions[0].typed).toBe(long);
    });

    it("fails a rejected question and leaves it unanswered", () => {
        const [action] = projectTranscript([ask([store]), result("User rejected tool use", true)]) as any[];
        expect(action.outcome).toBe("fail");
        expect(action.summary).toBeUndefined();
        expect(action.detail.questions[0].picked).toEqual([]);
    });
});

describe("projectTranscript malformed and mistyped records", () => {
    const L = (o: unknown) => JSON.stringify(o);
    const asst = (blocks: any[], extra: object = {}) => L({ type: "assistant", ...extra, message: { content: blocks } });
    const usr = (blocks: any[], extra: object = {}) => L({ type: "user", ...extra, message: { content: blocks } });
    const result = (id: string, content?: unknown, isError = false, extra: object = {}) =>
        usr([{ type: "tool_result", tool_use_id: id, is_error: isError, content }], extra);

    it("skips assistant and user records whose content is not an array", () => {
        const out = projectTranscript([
            L({ type: "assistant" }),
            L({ type: "assistant", message: { content: "plain" } }),
            L({ type: "user" }),
            L({ type: "user", message: { content: 5 } }),
        ]);
        expect(out).toEqual([]);
    });

    it("ignores assistant blocks that are not text or a named tool_use", () => {
        const out = projectTranscript([
            asst([
                null,
                { type: "thinking", text: "hidden" },
                { type: "thinking", name: "Bash" },
                { type: "text" },
                { type: "text", text: "   " },
                { type: "tool_use", id: "x" },
                { type: "tool_use", id: "y", name: 5 },
                { type: "text", text: "kept" },
            ]),
        ]);
        expect(out).toEqual([{ kind: "message", text: "kept" }]);
    });

    it("keeps a tool call with no input as a bare action", () => {
        const out = projectTranscript([
            asst([
                { type: "tool_use", id: "a", name: "Bash" },
                { type: "tool_use", id: "b", name: "AskUserQuestion" },
                { type: "tool_use", id: "c", name: "Edit" },
                { type: "tool_use", id: "d", name: "Write" },
                { type: "tool_use", id: "e", name: "Skill" },
            ]),
        ]);
        expect(out).toEqual([
            { kind: "action", verb: "ran", target: "" },
            { kind: "action", verb: "asked", target: "" },
            { kind: "action", verb: "edited", target: "" },
            { kind: "action", verb: "wrote", target: "" },
            { kind: "action", verb: "skill", target: "" },
        ]);
    });

    it("attaches a detail only to the tool that owns it", () => {
        const out = projectTranscript([
            asst([
                { type: "tool_use", id: "a", name: "Read", input: { file_path: "/p/a.ts", old_string: "a", new_string: "b" } },
                { type: "tool_use", id: "b", name: "Read", input: { content: "x" } },
                { type: "tool_use", id: "c", name: "Read", input: { questions: [{ question: "which?" }] } },
                { type: "tool_use", id: "d", name: "Read", input: { skill: "foo" }, caller: { type: "direct" } },
            ]),
        ]);
        expect(out).toEqual([
            { kind: "action", verb: "read", target: "a.ts" },
            { kind: "action", verb: "read", target: "" },
            { kind: "action", verb: "read", target: "which?" },
            { kind: "action", verb: "read", target: "foo" },
        ]);
    });

    it("attaches an added-file diff to a Write call", () => {
        const out = projectTranscript([
            asst([{ type: "tool_use", id: "w", name: "Write", input: { file_path: "/p/a.ts", content: "x\ny" } }]),
        ]);
        expect(out).toEqual([
            {
                kind: "action",
                verb: "wrote",
                target: "a.ts",
                detail: {
                    kind: "edit",
                    files: [
                        {
                            path: "/p/a.ts",
                            badge: "A",
                            adds: 2,
                            dels: 0,
                            lines: [
                                { sign: "+", text: "x" },
                                { sign: "+", text: "y" },
                            ],
                        },
                    ],
                },
            },
        ]);
    });

    it("leaves a Skill call without a skill name as a plain action, direct or not", () => {
        const out = projectTranscript([
            asst([
                { type: "tool_use", id: "s1", name: "Skill", input: {}, caller: { type: "direct" } },
                { type: "tool_use", id: "s2", name: "Skill", input: { args: "x" } },
            ]),
        ]);
        expect(out).toEqual([
            { kind: "action", verb: "skill", target: "" },
            { kind: "action", verb: "skill", target: "" },
        ]);
    });

    it("trims skill args and drops args that are only whitespace", () => {
        const call = (id: string, args: string, direct: boolean) => ({
            type: "tool_use",
            id,
            name: "Skill",
            input: { skill: "commit", args },
            ...(direct ? { caller: { type: "direct" } } : {}),
        });
        const out = projectTranscript([
            asst([call("a", "  design the cache \n", true), call("b", "   ", true), call("c", "  design the cache \n", false), call("d", "   ", false)]),
        ]);
        expect(out).toEqual([
            { kind: "command", name: "commit", isSkill: true, args: "design the cache" },
            { kind: "command", name: "commit", isSkill: true },
            { kind: "action", verb: "skill", target: "commit", detail: { kind: "skill", name: "commit", args: "design the cache" } },
            { kind: "action", verb: "skill", target: "commit", detail: { kind: "skill", name: "commit" } },
        ]);
    });

    it("summarizes Grep, Read and Glob results with detail", () => {
        const grepBody = "src/a.ts:12: const x = 1;\nsrc/a.ts:14: const y = 2;";
        const out = projectTranscript([
            asst([{ type: "tool_use", id: "g", name: "Grep", input: { pattern: "const" } }]),
            result("g", grepBody),
            asst([{ type: "tool_use", id: "g1", name: "Grep", input: { pattern: "x" } }]),
            result("g1", "src/a.ts:12: const x = 1;"),
            asst([{ type: "tool_use", id: "r", name: "Read", input: { file_path: "/p/a.ts" } }]),
            result("r", "l1\nl2\nl3"),
            asst([{ type: "tool_use", id: "gl", name: "Glob", input: { pattern: "*.ts" } }]),
            result("gl", "a.ts\nb.ts"),
        ]);
        expect(out).toEqual([
            {
                kind: "action",
                verb: "grep",
                target: "const",
                summary: "2 matches",
                detail: {
                    kind: "grep",
                    matches: [
                        { loc: "src/a.ts:12", code: " const x = 1;" },
                        { loc: "src/a.ts:14", code: " const y = 2;" },
                    ],
                },
            },
            {
                kind: "action",
                verb: "grep",
                target: "x",
                summary: "1 match",
                detail: { kind: "grep", matches: [{ loc: "src/a.ts:12", code: " const x = 1;" }] },
            },
            {
                kind: "action",
                verb: "read",
                target: "a.ts",
                summary: "3 lines",
                detail: { kind: "read", snippet: "l1\nl2\nl3", truncated: false },
            },
            {
                kind: "action",
                verb: "glob",
                target: "*.ts",
                summary: "2 lines",
                detail: { kind: "read", snippet: "a.ts\nb.ts", truncated: false },
            },
        ]);
    });

    it("records exit 1 on a failed Bash result that has output", () => {
        const out = projectTranscript([
            asst([{ type: "tool_use", id: "b", name: "Bash", input: { command: "false" } }]),
            result("b", "boom", true),
        ]);
        expect(out).toEqual([
            {
                kind: "action",
                verb: "ran",
                target: "false",
                outcome: "fail",
                detail: { kind: "bash", command: "false", output: "boom", exit: 1 },
            },
        ]);
    });

    it("drops a Bash command that is not a string from the bash detail", () => {
        const out = projectTranscript([
            asst([{ type: "tool_use", id: "b", name: "Bash", input: { command: 42 } }]),
            result("b", "out"),
        ]);
        const detail = (out[0] as any).detail;
        expect(detail.command).toBeUndefined();
        expect(detail).toEqual({ kind: "bash", output: "out", exit: 0 });
    });

    it("ignores a tool_result-shaped block of another type or without a tool_use_id", () => {
        const out = projectTranscript([
            asst([{ type: "tool_use", id: "b", name: "Bash", input: { command: "ls" } }]),
            usr([null, { type: "image", tool_use_id: "b" }, { type: "tool_result" }, { type: "tool_result", tool_use_id: 7 }]),
        ]);
        expect(out).toEqual([{ kind: "action", verb: "ran", target: "ls" }]);
    });

    it("keeps only real text blocks of a user turn", () => {
        const out = projectTranscript([
            usr([
                null,
                { type: "image", text: "caption" },
                { type: "text" },
                { type: "text", text: "  " },
                { type: "tool_result" },
                { type: "text", text: "real" },
            ]),
        ]);
        expect(out).toEqual([{ kind: "user", text: "real" }]);
    });

    it("emits nothing for a blank user string", () => {
        const out = projectTranscript([L({ type: "user", message: { content: "" } }), L({ type: "user", message: { content: "   " } })]);
        expect(out).toEqual([]);
    });

    describe("AskUserQuestion results", () => {
        const ask = L({
            type: "assistant",
            message: { content: [{ type: "tool_use", id: "q1", name: "AskUserQuestion", input: { questions: [{ question: "Which?", options: [{ label: "A" }] }] } }] },
        });
        const answered = (extra: object) => L({ type: "user", ...extra, message: { content: [{ type: "tool_result", tool_use_id: "q1", content: "x" }] } });

        it("leaves a question unanswered when the result carries no toolUseResult", () => {
            const bare = [{ kind: "action", verb: "asked", target: "Which?", detail: { kind: "ask", questions: [{ question: "Which?", options: [{ label: "A" }], picked: [] }] } }];
            expect(projectTranscript([ask, answered({})])).toEqual(bare);
            expect(projectTranscript([ask, answered({ toolUseResult: null })])).toEqual(bare);
        });

        it("does not read answers off the result of a tool that is not a question", () => {
            const out = projectTranscript([
                asst([{ type: "tool_use", id: "b", name: "Bash", input: { command: "ls" } }]),
                result("b", "", false, { toolUseResult: { answers: {} } }),
            ]);
            expect(out).toEqual([{ kind: "action", verb: "ran", target: "ls", outcome: "ok" }]);
        });
    });

    describe("durations", () => {
        const use = (ts: unknown) => asst([{ type: "tool_use", id: "b", name: "Bash", input: { command: "x" } }], { timestamp: ts });
        const res = (ts: unknown) => result("b", "out", false, { timestamp: ts });
        const duration = (lines: string[]) => (projectTranscript(lines)[0] as any).durationMs;

        it("measures from the tool_use to the result", () => {
            expect(duration([use("2026-07-08T00:00:00.000Z"), res("2026-07-08T00:00:03.200Z")])).toBe(3200);
        });

        it("reports zero for a result stamped the same instant", () => {
            expect(duration([use("2026-07-08T00:00:01.000Z"), res("2026-07-08T00:00:01.000Z")])).toBe(0);
        });

        it("has no duration when the result is stamped before the tool_use", () => {
            expect(duration([use("2026-07-08T00:00:03.000Z"), res("2026-07-08T00:00:01.000Z")])).toBeUndefined();
        });

        it("has no duration when the result carries no timestamp", () => {
            expect(duration([use("2026-07-08T00:00:00.000Z"), res(undefined)])).toBeUndefined();
        });

        it("ignores a timestamp that is not a string", () => {
            expect(duration([use(5), res("2026-07-08T00:00:03.000Z")])).toBeUndefined();
            expect(duration([use("2000-01-01T00:00:00.000Z"), res(5)])).toBeUndefined();
        });
    });
});

describe("projectTranscript compaction edge cases", () => {
    const L = (o: unknown) => JSON.stringify(o);
    const summaryOf = (content: unknown) => L({ type: "user", isCompactSummary: true, message: { content } });

    it("joins the text blocks of an array summary", () => {
        const out = projectTranscript([summaryOf([{ type: "text", text: "part one" }, { type: "image" }, { type: "text", text: "part two" }])]);
        expect(out).toEqual([{ kind: "compaction", summary: "part one\npart two" }]);
    });

    it("omits the summary when it is blank", () => {
        expect(projectTranscript([summaryOf("  \n")])).toStrictEqual([{ kind: "compaction" }]);
        expect(projectTranscript([summaryOf([])])).toStrictEqual([{ kind: "compaction" }]);
    });

    it("only treats a system compact_boundary as a compaction", () => {
        const out = projectTranscript([
            L({ type: "system", subtype: "local_command", content: "x" }),
            L({ type: "progress", subtype: "compact_boundary" }),
        ]);
        expect(out).toEqual([]);
    });

    it("carries only the metadata the boundary has", () => {
        const boundary = (compactMetadata?: object) => L({ type: "system", subtype: "compact_boundary", compactMetadata });
        expect(projectTranscript([boundary()])).toStrictEqual([{ kind: "compaction" }]);
        expect(projectTranscript([boundary({ trigger: "auto" })])).toStrictEqual([{ kind: "compaction", trigger: "auto" }]);
        expect(projectTranscript([boundary({ preTokens: 10 })])).toStrictEqual([{ kind: "compaction", preTokens: 10 }]);
        expect(projectTranscript([boundary({ postTokens: 4 })])).toStrictEqual([{ kind: "compaction", postTokens: 4 }]);
    });
});
