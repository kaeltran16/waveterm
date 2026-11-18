import { describe, expect, it, vi } from "vitest";
import { bashNeverRan, extractAiTitle, extractSubagentSpawns, extractTasks, projectTranscript } from "./transcriptprojection";

// every projection here runs over deep-frozen records: the live stream hands the same records to every chunk's
// projection, so a projector that mutates one throws here (modules are strict)
vi.mock("./transcriptrecords", async (importOriginal) => {
    const orig = await importOriginal<typeof import("./transcriptrecords")>();
    const freeze = (v: unknown): unknown => {
        if (v != null && typeof v === "object" && !Object.isFrozen(v)) {
            Object.freeze(v);
            Object.values(v).forEach(freeze);
        }
        return v;
    };
    return { ...orig, parseTranscriptLines: (lines: readonly string[]) => orig.parseTranscriptLines(lines).map(freeze) };
});

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
    JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false }] },
    }), // edited, non-ran -> no outcome
    JSON.stringify({
        type: "assistant",
        message: {
            content: [
                {
                    type: "tool_use",
                    id: "t2",
                    name: "Bash",
                    input: { command: "go test ./...", description: "go test ./..." },
                },
            ],
        },
    }),
    JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "t2", is_error: true }] },
    }), // ran + error -> fail
    JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "t3", name: "Bash", input: { description: "go build" } }] },
    }),
    JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "t3", is_error: false }] },
    }), // ran + success -> ok
    "{ not valid json", // skipped
    JSON.stringify({ type: "file-history-snapshot", foo: 1 }), // unknown type -> ignored
];

describe("projectTranscript", () => {
    it("projects messages, actions, and outcomes in order", () => {
        expect(projectTranscript(LINES)).toEqual([
            { kind: "user", text: "fix the race" },
            { kind: "message", text: "The clone re-reads the source block by id, so a stale id slips through." },
            { kind: "action", verb: "edited", target: "sessionmodel.go" },
            { kind: "action", verb: "ran", target: "go test ./...", command: "go test ./...", outcome: "fail" },
            { kind: "action", verb: "ran", target: "go build", outcome: "ok" },
        ]);
    });

    it("returns [] for empty input and skips unparseable lines", () => {
        expect(projectTranscript([])).toEqual([]);
        expect(projectTranscript(["garbage", "{bad"])).toEqual([]);
    });

    it("maps unknown tools to a spaced lowercase verb and the salient input", () => {
        const out = projectTranscript([
            JSON.stringify({
                type: "assistant",
                message: { content: [{ type: "tool_use", id: "x", name: "WebFetch", input: { pattern: "abc" } }] },
            }),
        ]);
        expect(out).toEqual([{ kind: "action", verb: "web fetch", target: "abc", pending: true }]);
    });

    it("emits an action with no outcome when tool_use has no id (result can't be matched)", () => {
        const out = projectTranscript([
            JSON.stringify({
                type: "assistant",
                message: { content: [{ type: "tool_use", name: "Bash", input: { description: "go test ./..." } }] },
            }),
            JSON.stringify({
                type: "user",
                message: { content: [{ type: "tool_result", tool_use_id: "missing", is_error: true }] },
            }),
        ]);
        expect(out).toEqual([{ kind: "action", verb: "ran", target: "go test ./...", pending: true }]);
    });

    it("reads a Bash call refused before it ran as blocked with no exit code, and one that ran and failed as fail", () => {
        const refusal = "<tool_use_error>Refused by Arc: Claude Code already saves a background command's output.</tool_use_error>";
        const use = (id: string, command: string) =>
            JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });
        const result = (id: string, content: string) =>
            JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: true, content }] } });
        const out = projectTranscript([use("b1", "task build > log"), result("b1", refusal), use("b2", "grep x f"), result("b2", "Exit code 1\n")]);
        expect(out[0]).toMatchObject({ outcome: "blocked", detail: { kind: "bash", exit: null, output: "" } });
        expect(out[1]).toMatchObject({ outcome: "fail", detail: { kind: "bash", exit: 1 } });
    });
});

// the errored Bash result shapes Claude Code writes, as seen in real transcripts
describe("bashNeverRan", () => {
    it("reads a refusal before the command started as never ran", () => {
        for (const body of [
            "<tool_use_error>Refused by Arc: Claude Code already saves a background command's output</tool_use_error>",
            "<tool_use_error>Blocked: sleep 170 followed by: cat out.log</tool_use_error>",
            "The user doesn't want to proceed with this tool use. The tool use was rejected",
            "Permission for this action was denied by the Claude Code auto mode classifier.",
        ]) {
            expect(bashNeverRan(body), body).toBe(true);
        }
    });

    it("reads a command that ran, or may have, as a failure", () => {
        for (const body of [
            "Exit code 1",
            "Exit code 143\nCommand timed out after 2m 0s\n",
            "Interrupted: the call was stopped while running; it may have partially completed.",
            "[Tool call interrupted: the session ended before this call's result was recorded]",
            "",
        ]) {
            expect(bashNeverRan(body), body).toBe(false);
        }
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
        const out = projectTranscript([
            L({ type: "user", message: { content: [{ type: "text", text: "option B" }] } }),
        ]);
        expect(out).toEqual([{ kind: "user", text: "option B" }]);
    });

    it("emits no user entry for a tool_result-only record but still applies the outcome", () => {
        const out = projectTranscript([
            L({
                type: "assistant",
                message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] },
            }),
            L({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false }] } }),
        ]);
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({ kind: "action", verb: "ran", outcome: "ok" });
    });

    it("stamps user, command and message entries with the record time", () => {
        const at = (s: string) => `2026-07-08T00:00:${s}.000Z`;
        const out = projectTranscript([
            L({ type: "user", timestamp: at("00"), message: { content: "do the thing" } }),
            L({
                type: "user",
                timestamp: at("05"),
                message: { content: "<command-name>/review</command-name>\n<command-args></command-args>" },
            }),
            L({
                type: "assistant",
                timestamp: at("09"),
                message: { content: [{ type: "text", text: "done" }] },
            }),
        ]);
        expect(out.map((e) => (e as { ts?: number }).ts)).toEqual([
            Date.parse(at("00")),
            Date.parse(at("05")),
            Date.parse(at("09")),
        ]);
    });

    it("leaves ts off when the record has no valid timestamp", () => {
        const out = projectTranscript([
            L({ type: "user", message: { content: "no time" } }),
            L({ type: "user", timestamp: "nope", message: { content: "bad time" } }),
            L({ type: "assistant", timestamp: "nope", message: { content: [{ type: "text", text: "bad" }] } }),
        ]);
        expect(out).toHaveLength(3);
        for (const e of out) {
            expect("ts" in e).toBe(false);
        }
    });
});

describe("projectTranscript commands and isMeta", () => {
    const L = (o: unknown) => JSON.stringify(o);

    it("parses a <command-name> user string into a command entry (slash kept, message dropped, args when present)", () => {
        const withArgs =
            "<command-name>/review</command-name>\n  <command-message>review</command-message>\n  <command-args>PR #402</command-args>";
        const bare =
            "<command-name>/clear</command-name>\n  <command-message>clear</command-message>\n  <command-args></command-args>";
        expect(projectTranscript([L({ type: "user", message: { content: withArgs } })])).toEqual([
            { kind: "command", name: "/review", args: "PR #402" },
        ]);
        expect(projectTranscript([L({ type: "user", message: { content: bare } })])).toEqual([
            { kind: "command", name: "/clear" },
        ]);
    });

    it("normalizes a command-name that lacks a leading slash", () => {
        const out = projectTranscript([
            L({
                type: "user",
                message: { content: "<command-name>compact</command-name><command-args></command-args>" },
            }),
        ]);
        expect(out).toEqual([{ kind: "command", name: "/compact" }]);
    });

    it("skips synthetic isMeta user records (skill body dumps, caveats, continuation)", () => {
        const out = projectTranscript([
            L({
                type: "user",
                isMeta: true,
                message: { content: [{ type: "text", text: "# Skill body\n\nlong markdown" }] },
            }),
            L({
                type: "user",
                isMeta: true,
                message: { content: "<local-command-caveat>Caveat...</local-command-caveat>" },
            }),
            L({ type: "user", message: { content: "real prompt" } }),
        ]);
        expect(out).toEqual([{ kind: "user", text: "real prompt" }]);
    });
    // caller.type "direct" is on every model tool call, so it never means the user typed the skill
    it("draws a model's Skill call (caller.direct) as an action, and a typed /skill as a command", () => {
        const out = projectTranscript([
            L({ type: "user", message: { content: "<command-name>/superpowers:brainstorming</command-name>" } }),
            L({
                type: "assistant",
                message: {
                    content: [
                        {
                            type: "tool_use",
                            id: "s1",
                            name: "Skill",
                            input: { skill: "superpowers:brainstorming", args: "design the cache" },
                            caller: { type: "direct" },
                        },
                    ],
                },
            }),
        ]);
        expect(out).toEqual([
            { kind: "command", name: "/superpowers:brainstorming" },
            {
                kind: "action",
                verb: "skill",
                target: "superpowers:brainstorming",
                pending: true,
                detail: { kind: "skill", name: "superpowers:brainstorming", args: "design the cache" },
            },
        ]);
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
    const summary = L({
        type: "user",
        isCompactSummary: true,
        message: { content: "This session is being continued...\n\nSummary:\n**kept**" },
    });

    it("merges an adjacent boundary + summary into one compaction entry", () => {
        expect(projectTranscript([boundary, summary])).toEqual([
            {
                kind: "compaction",
                trigger: "manual",
                preTokens: 415334,
                postTokens: 22859,
                summary: "This session is being continued...\n\nSummary:\n**kept**",
            },
        ]);
    });

    it("produces a summary-only compaction when there is no boundary", () => {
        expect(projectTranscript([summary])).toEqual([
            { kind: "compaction", summary: "This session is being continued...\n\nSummary:\n**kept**" },
        ]);
    });

    it("produces a stats-only compaction when there is no summary", () => {
        expect(projectTranscript([boundary])).toEqual([
            { kind: "compaction", trigger: "manual", preTokens: 415334, postTokens: 22859 },
        ]);
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
            {
                kind: "notification",
                summary: 'Agent "Map layout" finished',
                status: "completed",
                result: "Here is the report.",
                source: "subagent",
            },
        ]);
    });

    it("omits result when the task-notification has none", () => {
        const content =
            "<task-notification>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>";
        expect(projectTranscript([L({ type: "user", message: { content } })])).toEqual([
            { kind: "notification", summary: "done", status: "completed" },
        ]);
    });

    describe("subagent finish vs background notice", () => {
        const call = (id: string, name: string) =>
            L({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input: {} }] } });
        const finish = (id: string, status: string, summary: string) =>
            L({
                type: "user",
                message: {
                    content: `<task-notification>\n<task-id>t1</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`,
                },
            });
        const notes = (lines: string[]) => projectTranscript(lines).filter((e) => e.kind === "notification");

        // its own record starts a turn (spec #6), so a background shell's finish is a notification by source, not a notice
        it("labels a background shell's finish by its source", () => {
            const summary = "Background shell command didn't finish before the previous session ended";
            expect(notes([call("toolu_b", "Bash"), finish("toolu_b", "stopped", summary)])).toEqual([
                { kind: "notification", summary, status: "stopped", source: "command" },
            ]);
        });

        it("keeps a killed subagent, which carries no result, a subagent finish", () => {
            expect(notes([call("toolu_a", "Agent"), finish("toolu_a", "killed", 'Agent "x" was stopped')])).toEqual([
                { kind: "notification", summary: 'Agent "x" was stopped', status: "killed", source: "subagent" },
            ]);
        });
    });

    it("skips a user-string <local-command-stdout> record (with ANSI) rather than leaking the raw tag", () => {
        const content = "<local-command-stdout>[2mCompacted (ctrl+o to see full summary)[22m</local-command-stdout>";
        expect(projectTranscript([L({ type: "user", message: { content } })])).toEqual([]);
    });

    describe("slash command output", () => {
        const cmd = (name: string, args = "") =>
            L({
                type: "user",
                message: { content: `<command-name>${name}</command-name><command-args>${args}</command-args>` },
            });
        const stdout = (text: string) => L({ type: "user", message: { content: `<local-command-stdout>${text}</local-command-stdout>` } });
        const stderr = (text: string) => L({ type: "user", message: { content: `<local-command-stderr>${text}</local-command-stderr>` } });

        it("attaches a stdout, colour codes stripped, to the command right before it", () => {
            const out = projectTranscript([
                cmd("/mcp"),
                stdout("\x1b[1mAuthentication successful.\x1b[22m Connected to siem-portal."),
            ]);
            expect(out).toEqual([
                { kind: "command", name: "/mcp", output: "Authentication successful. Connected to siem-portal." },
            ]);
        });

        it("attaches a stderr the same way", () => {
            expect(projectTranscript([cmd("/config", "x"), stderr("Unknown setting")])).toEqual([
                { kind: "command", name: "/config", args: "x", output: "Unknown setting" },
            ]);
        });

        it("gives /compact no output", () => {
            expect(projectTranscript([cmd("/compact"), stdout("Compacted (ctrl+o to see full summary)")])).toEqual([
                { kind: "command", name: "/compact" },
            ]);
        });

        it("draws nothing for an output with no command, or after another entry", () => {
            expect(projectTranscript([stdout("orphan")])).toEqual([]);
            const out = projectTranscript([
                cmd("/mcp"),
                L({ type: "user", message: { content: "a prompt" } }),
                stdout("late"),
            ]);
            expect(out).toEqual([{ kind: "command", name: "/mcp" }, { kind: "user", text: "a prompt" }]);
        });

        it("keeps the first output when a command prints twice", () => {
            const out = projectTranscript([cmd("/mcp"), stdout("first"), stdout("second")]);
            expect(out).toEqual([{ kind: "command", name: "/mcp", output: "first" }]);
        });

        it("leaves a command that printed nothing with no output", () => {
            expect(projectTranscript([cmd("/clear")])).toEqual([{ kind: "command", name: "/clear" }]);
            expect(projectTranscript([cmd("/clear"), stdout("")])).toEqual([{ kind: "command", name: "/clear" }]);
        });
    });

    it("projects [Request interrupted by user] as an interrupted marker, both as a text block and a string", () => {
        expect(
            projectTranscript([
                L({ type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } }),
            ])
        ).toEqual([{ kind: "interrupted" }]);
        expect(
            projectTranscript([L({ type: "user", message: { content: "[Request interrupted by user for tool use]" } })])
        ).toEqual([{ kind: "interrupted" }]);
    });
});

describe("projectTranscript ! bash records", () => {
    const L = (o: unknown) => JSON.stringify(o);
    const userStr = (content: string, timestamp?: string) =>
        L({ type: "user", message: { content }, ...(timestamp ? { timestamp } : {}) });
    const input = (cmd: string, timestamp?: string) => userStr(`<bash-input>${cmd}</bash-input>`, timestamp);
    const output = (stdout: string, stderr: string) =>
        userStr(`<bash-stdout>${stdout}</bash-stdout><bash-stderr>${stderr}</bash-stderr>`);

    it("joins an input and its output into one shell entry with the trimmed command and both streams", () => {
        expect(
            projectTranscript([input("echo hi", "2026-11-16T10:00:00.000Z"), output("hi", "warn: x")])
        ).toEqual([
            { kind: "shell", command: "echo hi", stdout: "hi", stderr: "warn: x", ts: Date.UTC(2026, 10, 16, 10) },
        ]);
    });

    it("leaves both streams off an input with no output yet", () => {
        expect(projectTranscript([input("sleep 9")])).toEqual([{ kind: "shell", command: "sleep 9" }]);
    });

    it("gives each of two runs in a row its own output", () => {
        expect(projectTranscript([input("a"), output("A", ""), input("b"), output("", "B")])).toEqual([
            { kind: "shell", command: "a", stdout: "A", stderr: "" },
            { kind: "shell", command: "b", stdout: "", stderr: "B" },
        ]);
    });

    it("adds nothing for an output with no pending input", () => {
        expect(projectTranscript([output("orphan", "")])).toEqual([]);
        expect(projectTranscript([input("a"), output("A", ""), output("again", "")])).toEqual([
            { kind: "shell", command: "a", stdout: "A", stderr: "" },
        ]);
    });

    it("never draws either record as a user bubble", () => {
        const entries = projectTranscript([input("ls"), output("x", "")]);
        expect(entries.some((e) => e.kind === "user")).toBe(false);
    });

    it("trims a leading space in the input", () => {
        expect(projectTranscript([input(" gh auth switch")])).toEqual([{ kind: "shell", command: "gh auth switch" }]);
    });

    it("strips ANSI escapes from both streams", () => {
        expect(projectTranscript([input("ls"), output("\x1b[32mok\x1b[0m", "\x1b[31mbad\x1b[0m")])).toEqual([
            { kind: "shell", command: "ls", stdout: "ok", stderr: "bad" },
        ]);
    });

    it("keeps multi-line output whole", () => {
        expect(projectTranscript([input("ls"), output("a\nb\n", "")])).toEqual([
            { kind: "shell", command: "ls", stdout: "a\nb\n", stderr: "" },
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
        expect(
            extractAiTitle([JSON.stringify({ type: "assistant", message: { content: [] } }), "{bad"])
        ).toBeUndefined();
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
                JSON.stringify({
                    type: "assistant",
                    message: { content: [{ type: "tool_use", id: "e", name: "Edit", input: {} }] },
                }),
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
            todoUse([
                { content: "kept", status: "completed" },
                { status: "pending" },
                { content: 42, status: "pending" },
            ]),
        ]);
        expect(out).toEqual([{ text: "kept", done: true }]);
    });

    it("ignores a TodoWrite in a record that is not an assistant message", () => {
        const user = JSON.stringify({
            type: "user",
            message: {
                content: [{ type: "tool_use", id: "u1", name: "TodoWrite", input: { todos: [{ content: "x" }] } }],
            },
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
    const rec = (id: string | undefined, content: unknown[], ts?: string) =>
        JSON.stringify({ type: "assistant", ...(ts ? { timestamp: ts } : {}), message: { ...(id ? { id } : {}), content } });
    const think = (thinking: string) => ({ type: "thinking", thinking });
    const text = (t: string) => ({ type: "text", text: t });
    const use = (id: string) => ({ type: "tool_use", id, name: "Bash", input: { command: "ls" } });

    it("a message with thinking and no reply text projects its thinking as a thought, in place", () => {
        const out = projectTranscript([rec("m1", [think("  checking the caller first  ")], "2026-11-16T10:00:00Z"), rec("m1", [use("t1")])]);
        expect(out[0]).toEqual({ kind: "thought", text: "checking the caller first", ts: Date.parse("2026-11-16T10:00:00Z") });
        expect(out[1]).toMatchObject({ kind: "action", verb: "ran" });
    });

    it("a message with reply text keeps its thinking hidden, though the text arrives in a later record", () => {
        const out = projectTranscript([rec("m1", [think("secret reasoning")]), rec("m1", [text("visible reply")])]);
        expect(out).toEqual([{ kind: "message", text: "visible reply" }]);
    });

    it("a record with no message id is its own message", () => {
        const out = projectTranscript([rec(undefined, [think("alone")]), rec(undefined, [think("hidden"), text("said")])]);
        expect(out).toEqual([
            { kind: "thought", text: "alone" },
            { kind: "message", text: "said" },
        ]);
    });

    it("one message's back-to-back thinking blocks are one thought; another message's starts a new one", () => {
        const out = projectTranscript([rec("m1", [think("a")]), rec("m1", [think("b")]), rec("m2", [think("c")])]);
        expect(out).toEqual([
            { kind: "thought", text: "a\n\nb" },
            { kind: "thought", text: "c" },
        ]);
    });

    it("empty thinking (summaries off) projects nothing", () => {
        expect(projectTranscript([rec("m1", [think("   "), { type: "thinking", signature: "x" }]), rec("m1", [use("t1")])])).toEqual([
            expect.objectContaining({ kind: "action" }),
        ]);
    });
});

describe("projectTranscript detail", () => {
    const L = (o: unknown) => JSON.stringify(o);

    it("attaches an edit diff from Edit old/new strings", () => {
        const out = projectTranscript([
            L({
                type: "assistant",
                message: {
                    content: [
                        {
                            type: "tool_use",
                            id: "e1",
                            name: "Edit",
                            input: { file_path: "/p/a.ts", old_string: "a\nb", new_string: "c" },
                        },
                    ],
                },
            }),
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

    it("numbers an edit's diff from its result's structuredPatch, and leaves it unnumbered without one", () => {
        const use = (id: string) =>
            L({
                type: "assistant",
                message: {
                    content: [
                        { type: "tool_use", id, name: "Edit", input: { file_path: "/p/a.ts", old_string: "a", new_string: "b" } },
                    ],
                },
            });
        const patch = [{ oldStart: 7, oldLines: 2, newStart: 7, newLines: 2, lines: [" ctx", "-a", "+b"] }];
        const out = projectTranscript([
            use("e1"),
            L({
                type: "user",
                message: { content: [{ type: "tool_result", tool_use_id: "e1", is_error: false }] },
                toolUseResult: { filePath: "/p/a.ts", structuredPatch: patch },
            }),
            use("e2"),
            L({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "e2", is_error: false }] } }),
        ]);
        const numbered = (out[0] as any).detail.files[0];
        expect(numbered.lines.map((l: any) => [l.sign, l.oldNo, l.newNo])).toEqual([
            ["", 7, 7],
            ["-", 8, undefined],
            ["+", undefined, 8],
        ]);
        expect(numbered).toMatchObject({ path: "/p/a.ts", adds: 1, dels: 1 });
        const bare = (out[1] as any).detail.files[0].lines;
        expect(bare.every((l: any) => l.oldNo == null && l.newNo == null)).toBe(true);
    });

    it("attaches the raw command (not the description) plus output + exit to a bash detail", () => {
        const out = projectTranscript([
            L({
                type: "assistant",
                message: {
                    content: [
                        {
                            type: "tool_use",
                            id: "b1",
                            name: "Bash",
                            input: { command: "npm test", description: "run tests" },
                        },
                    ],
                },
            }),
            L({
                type: "user",
                message: {
                    content: [{ type: "tool_result", tool_use_id: "b1", is_error: false, content: "24 passing" }],
                },
            }),
        ]);
        // the line shows the human description; the raw command lives in the detail
        expect(out[0]).toMatchObject({ kind: "action", verb: "ran", target: "run tests" });
        expect((out[0] as any).detail).toEqual({ kind: "bash", command: "npm test", output: "24 passing", exit: 0 });
    });

    it("renders a Skill call as a labeled line (verb + skill name) with an args detail", () => {
        const out = projectTranscript([
            L({
                type: "assistant",
                message: {
                    content: [
                        {
                            type: "tool_use",
                            id: "s1",
                            name: "Skill",
                            input: { skill: "brainstorming", args: "design the cache" },
                        },
                    ],
                },
            }),
        ]);
        expect(out[0]).toMatchObject({ kind: "action", verb: "skill", target: "brainstorming" });
        expect((out[0] as any).detail).toEqual({ kind: "skill", name: "brainstorming", args: "design the cache" });
    });

    it("omits the args detail field when a Skill call has no args", () => {
        const out = projectTranscript([
            L({
                type: "assistant",
                message: { content: [{ type: "tool_use", id: "s2", name: "Skill", input: { skill: "commit" } }] },
            }),
        ]);
        expect(out[0]).toMatchObject({ kind: "action", verb: "skill", target: "commit" });
        expect((out[0] as any).detail).toEqual({ kind: "skill", name: "commit" });
    });

    it("computes durationMs from record timestamps", () => {
        const out = projectTranscript([
            L({
                type: "assistant",
                timestamp: "2026-07-08T00:00:00.000Z",
                message: { content: [{ type: "tool_use", id: "b2", name: "Bash", input: { command: "x" } }] },
            }),
            L({
                type: "user",
                timestamp: "2026-07-08T00:00:03.200Z",
                message: { content: [{ type: "tool_result", tool_use_id: "b2", is_error: false, content: "" }] },
            }),
        ]);
        expect((out[0] as any).durationMs).toBe(3200);
        expect((out[0] as any).startedTs).toBeUndefined();
    });

    it("keeps a still-running call's start time", () => {
        const out = projectTranscript([
            L({
                type: "assistant",
                timestamp: "2026-07-08T00:00:00.000Z",
                message: { content: [{ type: "tool_use", id: "b2", name: "Bash", input: { command: "x" } }] },
            }),
        ]);
        expect((out[0] as any).startedTs).toBe(Date.parse("2026-07-08T00:00:00.000Z"));
    });

    it("does not leak private scratch fields (_useTs/_tool)", () => {
        const out = projectTranscript([
            L({
                type: "assistant",
                timestamp: "2026-07-08T00:00:00.000Z",
                message: { content: [{ type: "tool_use", id: "b3", name: "Bash", input: { command: "x" } }] },
            }),
            L({
                type: "user",
                timestamp: "2026-07-08T00:00:01.000Z",
                message: { content: [{ type: "tool_result", tool_use_id: "b3", is_error: false, content: "out" }] },
            }),
        ]);
        expect(Object.keys(out[0])).not.toContain("_useTs");
        expect(Object.keys(out[0])).not.toContain("_tool");
        expect(Object.keys(out[0])).not.toContain("_command");
    });

    it("records the tool_use time and the raw Bash command on the action", () => {
        const out = projectTranscript([
            L({
                type: "assistant",
                timestamp: "2026-07-08T00:00:00.000Z",
                message: {
                    content: [
                        {
                            type: "tool_use",
                            id: "b4",
                            name: "Bash",
                            input: { command: 'wsh effort chunk status "$E" 3 done', description: "Mark chunk 3 done" },
                        },
                    ],
                },
            }),
            L({
                type: "user",
                timestamp: "2026-07-08T00:00:01.000Z",
                message: { content: [{ type: "tool_result", tool_use_id: "b4", is_error: false, content: "ok" }] },
            }),
        ]);
        expect(out[0]).toMatchObject({
            target: "Mark chunk 3 done",
            command: 'wsh effort chunk status "$E" 3 done',
            ts: Date.parse("2026-07-08T00:00:00.000Z"),
        });
    });

    it("records the command on a pending Bash call, before any result", () => {
        const out = projectTranscript([
            L({
                type: "assistant",
                timestamp: "2026-07-08T00:00:05.000Z",
                message: { content: [{ type: "tool_use", id: "b5", name: "Bash", input: { command: "wsh runs start plan.md" } }] },
            }),
        ]);
        expect(out[0]).toMatchObject({
            pending: true,
            command: "wsh runs start plan.md",
            ts: Date.parse("2026-07-08T00:00:05.000Z"),
            startedTs: Date.parse("2026-07-08T00:00:05.000Z"),
        });
    });

    it("leaves ts and command off an action whose record has neither", () => {
        const out = projectTranscript([
            L({ type: "assistant", message: { content: [{ type: "tool_use", id: "r1", name: "Read", input: { file_path: "/a/b.ts" } }] } }),
        ]);
        expect(Object.keys(out[0])).not.toContain("ts");
        expect(Object.keys(out[0])).not.toContain("command");
    });
});

describe("extractSubagentSpawns", () => {
    const asst = (blocks: any[]) => JSON.stringify({ type: "assistant", message: { content: blocks } });
    const usr = (blocks: any[]) => JSON.stringify({ type: "user", message: { content: blocks } });

    it("pairs a completed Task with its ok result", () => {
        const lines = [
            asst([
                { type: "tool_use", id: "t1", name: "Task", input: { subagent_type: "Explore", prompt: "look at X" } },
            ]),
            usr([{ type: "tool_result", tool_use_id: "t1", is_error: false }]),
        ];
        expect(extractSubagentSpawns(lines)).toEqual([
            {
                toolUseId: "t1",
                subagentType: "Explore",
                prompt: "look at X",
                done: true,
                failed: false,
                background: false,
            },
        ]);
    });

    it("marks a still-running Task as not done", () => {
        const lines = [
            asst([{ type: "tool_use", id: "t2", name: "Task", input: { subagent_type: "Plan", prompt: "plan Y" } }]),
        ];
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
        const lines = [
            asst([{ type: "tool_use", id: "g1", name: "Agent", input: { subagent_type: "Plan", prompt: "plan it" } }]),
        ];
        expect(extractSubagentSpawns(lines)).toStrictEqual([
            { toolUseId: "g1", subagentType: "Plan", prompt: "plan it", done: false, failed: false, background: false },
        ]);
    });

    it("reads a missing or non-string subagent_type and prompt as empty strings", () => {
        const lines = [
            asst([{ type: "tool_use", id: "e1", name: "Task", input: { prompt: 5 } }]),
            asst([{ type: "tool_use", id: "e2", name: "Task", input: { subagent_type: 7 } }]),
            asst([{ type: "tool_use", id: "e3", name: "Task" }]),
        ];
        expect(extractSubagentSpawns(lines)).toStrictEqual([
            { toolUseId: "e1", subagentType: "", prompt: "", done: false, failed: false, background: false },
            { toolUseId: "e2", subagentType: "", prompt: "", done: false, failed: false, background: false },
            { toolUseId: "e3", subagentType: "", prompt: "", done: false, failed: false, background: false },
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
            { toolUseId: "k1", subagentType: "", prompt: "real", done: false, failed: false, background: false },
        ]);
    });

    const spawnAgent = (id: string) =>
        asst([
            {
                type: "tool_use",
                id,
                name: "Agent",
                input: { subagent_type: "Explore", prompt: "dig", run_in_background: true },
            },
        ]);
    const launchAck = (id: string, toolUseResult: any) =>
        JSON.stringify({
            type: "user",
            toolUseResult,
            message: {
                content: [{ type: "tool_result", tool_use_id: id, content: "Async agent launched successfully" }],
            },
        });
    const notification = (id: string, status: string) =>
        JSON.stringify({
            type: "user",
            message: {
                content: `<task-notification>\n<task-id>x</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>${status}</status>\n<summary>s</summary>\n</task-notification>`,
            },
        });

    it("async spawn stays working after its launch ack", () => {
        const byStatus = extractSubagentSpawns([spawnAgent("b1"), launchAck("b1", { status: "async_launched" })]);
        expect(byStatus[0]).toMatchObject({ done: false, failed: false, background: true });
        const byFlag = extractSubagentSpawns([spawnAgent("b2"), launchAck("b2", { isAsync: true })]);
        expect(byFlag[0]).toMatchObject({ done: false, failed: false, background: true });
    });

    it("task notification ends a background spawn", () => {
        const lines = [spawnAgent("b1"), launchAck("b1", { isAsync: true }), notification("b1", "completed")];
        expect(extractSubagentSpawns(lines)[0]).toMatchObject({ done: true, failed: false, background: true });
    });

    it("failed notification marks the background spawn failed", () => {
        const lines = [spawnAgent("b1"), launchAck("b1", { status: "async_launched" }), notification("b1", "failed")];
        expect(extractSubagentSpawns(lines)[0]).toMatchObject({ done: true, failed: true, background: true });
    });

    it("foreground spawn is done by its tool result", () => {
        const lines = [
            spawnAgent("f1"),
            launchAck("f1", { status: "completed" }),
            spawnAgent("f2"),
            notification("f2", "completed"),
        ];
        const [done, running] = extractSubagentSpawns(lines);
        expect(done).toMatchObject({ done: true, failed: false, background: false });
        // a notification names only background spawns; one for a foreground spawn changes nothing
        expect(running).toMatchObject({ done: false, failed: false, background: false });
    });
});

describe("projectTranscript SubagentHandback", () => {
    it("projectTranscript drops SubagentHandback calls", () => {
        const lines = [
            JSON.stringify({
                type: "assistant",
                message: {
                    content: [
                        { type: "tool_use", id: "h1", name: "SubagentHandback", input: { description: "report" } },
                        { type: "tool_use", id: "r1", name: "Read", input: { file_path: "/a/b.ts" } },
                    ],
                },
            }),
            JSON.stringify({
                type: "user",
                message: {
                    content: [
                        { type: "tool_result", tool_use_id: "h1", content: "handed back" },
                        { type: "tool_result", tool_use_id: "r1", content: "x" },
                    ],
                },
            }),
        ];
        const out = projectTranscript(lines);
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({ kind: "action", verb: "read", target: "b.ts" });
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
                pending: true,
                detail: {
                    kind: "ask",
                    questions: [
                        {
                            question: "Which store?",
                            header: "Store",
                            options: [
                                { label: "SQLite", description: "Reuse the object store" },
                                { label: "In-memory map" },
                            ],
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
            result({
                answers: { "Which store?": "a bolt file", "Which checks?": "Go tests, CDP scenario, a soak run" },
            }),
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

    it("reads a rejected question as declined and leaves it unanswered", () => {
        const rejected = JSON.stringify({
            type: "user",
            toolUseResult: "User rejected tool use",
            message: {
                content: [
                    {
                        type: "tool_result",
                        tool_use_id: "q1",
                        is_error: true,
                        content: "The user doesn't want to proceed with this tool use. The tool use was rejected.",
                    },
                ],
            },
        });
        const [action] = projectTranscript([ask([store]), rejected]) as any[];
        expect(action.outcome).toBe("declined");
        expect(action.summary).toBeUndefined();
        expect(action.detail.questions[0].picked).toEqual([]);
    });
});

describe("projectTranscript malformed and mistyped records", () => {
    const L = (o: unknown) => JSON.stringify(o);
    const asst = (blocks: any[], extra: object = {}) =>
        L({ type: "assistant", ...extra, message: { content: blocks } });
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
            { kind: "action", verb: "ran", target: "", pending: true },
            { kind: "action", verb: "asked", target: "", pending: true },
            { kind: "action", verb: "edited", target: "", pending: true },
            { kind: "action", verb: "wrote", target: "", pending: true },
            { kind: "action", verb: "skill", target: "", pending: true },
        ]);
    });

    it("attaches a detail only to the tool that owns it", () => {
        const out = projectTranscript([
            asst([
                {
                    type: "tool_use",
                    id: "a",
                    name: "Read",
                    input: { file_path: "/p/a.ts", old_string: "a", new_string: "b" },
                },
                { type: "tool_use", id: "b", name: "Read", input: { content: "x" } },
                { type: "tool_use", id: "c", name: "Read", input: { questions: [{ question: "which?" }] } },
                { type: "tool_use", id: "d", name: "Read", input: { skill: "foo" }, caller: { type: "direct" } },
            ]),
        ]);
        expect(out).toEqual([
            { kind: "action", verb: "read", target: "a.ts", pending: true },
            { kind: "action", verb: "read", target: "", pending: true },
            { kind: "action", verb: "read", target: "which?", pending: true },
            { kind: "action", verb: "read", target: "foo", pending: true },
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
                pending: true,
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
            { kind: "action", verb: "skill", target: "", pending: true },
            { kind: "action", verb: "skill", target: "", pending: true },
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
            asst([
                call("a", "  design the cache \n", true),
                call("b", "   ", true),
                call("c", "  design the cache \n", false),
                call("d", "   ", false),
            ]),
        ]);
        const withArgs = {
            kind: "action",
            verb: "skill",
            target: "commit",
            pending: true,
            detail: { kind: "skill", name: "commit", args: "design the cache" },
        };
        const noArgs = { kind: "action", verb: "skill", target: "commit", pending: true, detail: { kind: "skill", name: "commit" } };
        expect(out).toEqual([withArgs, noArgs, withArgs, noArgs]);
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
                    pattern: "const",
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
                detail: { kind: "grep", pattern: "x", matches: [{ loc: "src/a.ts:12", code: " const x = 1;" }] },
            },
            {
                kind: "action",
                verb: "read",
                target: "a.ts",
                summary: "3 lines",
                detail: { kind: "read", snippet: "l1\nl2\nl3", truncated: false, path: "/p/a.ts" },
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

    it("summarizes a one-line Glob result as 1 line", () => {
        const out = projectTranscript([
            asst([{ type: "tool_use", id: "gl", name: "Glob", input: { pattern: "*.ts" } }]),
            result("gl", "a.ts"),
            asst([{ type: "tool_use", id: "gl2", name: "Glob", input: { pattern: "*.zz" } }]),
            result("gl2", "No files found"),
        ]);
        expect(out.map((e: any) => e.summary)).toEqual(["1 line", "1 line"]);
    });

    it("records exit 1 on a failed Bash result that has output", () => {
        const out = projectTranscript([
            asst([{ type: "tool_use", id: "b", name: "Bash", input: { command: "false" } }]),
            result("b", "Exit code 1\nboom", true),
        ]);
        expect(out).toEqual([
            {
                kind: "action",
                verb: "ran",
                target: "false",
                command: "false",
                outcome: "fail",
                detail: { kind: "bash", command: "false", output: "Exit code 1\nboom", exit: 1 },
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
            usr([
                null,
                { type: "image", tool_use_id: "b" },
                { type: "tool_result" },
                { type: "tool_result", tool_use_id: 7 },
            ]),
        ]);
        expect(out).toEqual([{ kind: "action", verb: "ran", target: "ls", command: "ls", pending: true }]);
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
        const out = projectTranscript([
            L({ type: "user", message: { content: "" } }),
            L({ type: "user", message: { content: "   " } }),
        ]);
        expect(out).toEqual([]);
    });

    describe("AskUserQuestion results", () => {
        const ask = L({
            type: "assistant",
            message: {
                content: [
                    {
                        type: "tool_use",
                        id: "q1",
                        name: "AskUserQuestion",
                        input: { questions: [{ question: "Which?", options: [{ label: "A" }] }] },
                    },
                ],
            },
        });
        const answered = (extra: object) =>
            L({
                type: "user",
                ...extra,
                message: { content: [{ type: "tool_result", tool_use_id: "q1", content: "x" }] },
            });

        it("leaves a question unanswered when the result carries no toolUseResult", () => {
            const bare = [
                {
                    kind: "action",
                    verb: "asked",
                    target: "Which?",
                    detail: { kind: "ask", questions: [{ question: "Which?", options: [{ label: "A" }], picked: [] }] },
                },
            ];
            expect(projectTranscript([ask, answered({})])).toEqual(bare);
            expect(projectTranscript([ask, answered({ toolUseResult: null })])).toEqual(bare);
        });

        it("does not read answers off the result of a tool that is not a question", () => {
            const out = projectTranscript([
                asst([{ type: "tool_use", id: "b", name: "Bash", input: { command: "ls" } }]),
                result("b", "", false, { toolUseResult: { answers: {} } }),
            ]);
            expect(out).toEqual([{ kind: "action", verb: "ran", target: "ls", command: "ls", outcome: "ok" }]);
        });
    });

    describe("durations", () => {
        const use = (ts: unknown) =>
            asst([{ type: "tool_use", id: "b", name: "Bash", input: { command: "x" } }], { timestamp: ts });
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
        const out = projectTranscript([
            summaryOf([{ type: "text", text: "part one" }, { type: "image" }, { type: "text", text: "part two" }]),
        ]);
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
        const boundary = (compactMetadata?: object) =>
            L({ type: "system", subtype: "compact_boundary", compactMetadata });
        expect(projectTranscript([boundary()])).toStrictEqual([{ kind: "compaction" }]);
        expect(projectTranscript([boundary({ trigger: "auto" })])).toStrictEqual([
            { kind: "compaction", trigger: "auto" },
        ]);
        expect(projectTranscript([boundary({ preTokens: 10 })])).toStrictEqual([{ kind: "compaction", preTokens: 10 }]);
        expect(projectTranscript([boundary({ postTokens: 4 })])).toStrictEqual([{ kind: "compaction", postTokens: 4 }]);
    });
});

describe("projectTranscript pasted_content", () => {
    const wrapped = '<pasted_content id="p1">\nfix the race\nin the clone\n</pasted_content id="p1">';
    it("unwraps pasted_content in a string prompt", () => {
        const line = JSON.stringify({ type: "user", message: { content: `see this: ${wrapped}` } });
        expect(projectTranscript([line])).toStrictEqual([
            { kind: "user", text: "see this: fix the race\nin the clone" },
        ]);
    });
    it("unwraps pasted_content in a text block", () => {
        const line = JSON.stringify({ type: "user", message: { content: [{ type: "text", text: wrapped }] } });
        expect(projectTranscript([line])).toStrictEqual([{ kind: "user", text: "fix the race\nin the clone" }]);
    });
});

describe("projectTranscript tool result images", () => {
    const L = (o: unknown) => JSON.stringify(o);
    const use = (name: string) =>
        L({
            type: "assistant",
            message: { content: [{ type: "tool_use", id: "t1", name, input: { file_path: "/p/a.png" } }] },
        });
    const result = (content: unknown) =>
        L({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content }] } });

    it("puts a Read result's base64 image items on the action", () => {
        const out = projectTranscript([
            use("Read"),
            result([{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR" } }]),
        ]);
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({ kind: "action", images: [{ mediaType: "image/png", data: "iVBOR" }] });
    });

    it("leaves images off a result with none", () => {
        const out = projectTranscript([use("Read"), result([{ type: "text", text: "line 1" }])]);
        expect(out[0]).not.toHaveProperty("images");
    });
});

describe("projectTranscript pasted images", () => {
    const L = (o: unknown) => JSON.stringify(o);
    const img = (media_type = "image/png") => ({ type: "image", source: { type: "base64", media_type, data: "iVBOR" } });
    const user = (content: unknown) => L({ type: "user", message: { content } });

    it("attaches an image block to the user entry of its record", () => {
        const out = projectTranscript([user([{ type: "text", text: "look [Image #1]" }, img()])]);
        expect(out).toStrictEqual([
            { kind: "user", text: "look [Image #1]", images: [{ mediaType: "image/png", data: "iVBOR" }] },
        ]);
    });

    it("projects a record of an image alone as a user entry with empty text", () => {
        const out = projectTranscript([user([img()])]);
        expect(out).toStrictEqual([{ kind: "user", text: "", images: [{ mediaType: "image/png", data: "iVBOR" }] }]);
    });

    it("drops an image whose media type is not image/*", () => {
        expect(projectTranscript([user([img("application/pdf")])])).toStrictEqual([]);
        const out = projectTranscript([user([{ type: "text", text: "see" }, img("application/pdf")])]);
        expect(out).toStrictEqual([{ kind: "user", text: "see" }]);
    });

    it("leaves images off a user entry with none", () => {
        const out = projectTranscript([user([{ type: "text", text: "hi" }])]);
        expect(out[0]).not.toHaveProperty("images");
    });
});

describe("projectTranscript queued attachments", () => {
    const L = (o: unknown) => JSON.stringify(o);
    const queued = (attachment: object, timestamp = "2026-05-01T10:00:00.000Z") =>
        L({ type: "attachment", timestamp, attachment: { type: "queued_command", ...attachment } });

    it("projects a queued prompt as a queued user entry at its place", () => {
        const out = projectTranscript([
            L({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } }),
            queued({ commandMode: "prompt", prompt: "land them" }),
            L({ type: "assistant", message: { content: [{ type: "text", text: "landed" }] } }),
        ]);
        expect(out.map((e) => e.kind)).toEqual(["message", "user", "message"]);
        expect(out[1]).toStrictEqual({
            kind: "user",
            text: "land them",
            queued: true,
            ts: Date.parse("2026-05-01T10:00:00.000Z"),
        });
    });

    it("takes ts from the attachment's timestamp over the record's", () => {
        const attachmentTs = "2026-05-01T11:30:00.000Z";
        const out = projectTranscript([
            queued({ commandMode: "prompt", prompt: "go", timestamp: attachmentTs }, "2026-05-01T10:00:00.000Z"),
        ]);
        expect(out[0]).toMatchObject({ kind: "user", ts: Date.parse(attachmentTs) });
    });

    it("falls back to the record's timestamp when the attachment has none", () => {
        const recordTs = "2026-05-01T10:00:00.000Z";
        const out = projectTranscript([queued({ commandMode: "prompt", prompt: "go" }, recordTs)]);
        expect(out[0]).toMatchObject({ kind: "user", ts: Date.parse(recordTs) });
    });

    it("unwraps pasted content in a queued prompt", () => {
        const wrapped = '<pasted_content id="p1">\nfix it\n</pasted_content id="p1">';
        const out = projectTranscript([queued({ commandMode: "prompt", prompt: wrapped })]);
        expect(out[0]).toMatchObject({ kind: "user", text: "fix it", queued: true });
    });

    it("projects a structured task-notification as a notice", () => {
        const prompt =
            "<task-notification><task-id>b1</task-id><summary>Background command finished</summary><status>completed</status></task-notification>";
        const out = projectTranscript([queued({ commandMode: "task-notification", prompt })]);
        expect(out).toStrictEqual([
            {
                kind: "notification",
                summary: "Background command finished",
                status: "completed",
                source: "command",
                notice: true,
            },
        ]);
    });

    it("takes the text inside the tag of a free-text task-notification as the summary", () => {
        const prompt = "<task-notification>arc-skim: its prompt.compose hook was skipped</task-notification>";
        const out = projectTranscript([queued({ commandMode: "task-notification", prompt })]);
        expect(out).toStrictEqual([
            { kind: "notification", summary: "arc-skim: its prompt.compose hook was skipped", notice: true },
        ]);
    });

    it("projects nothing for any other command mode or a non-queued attachment", () => {
        expect(projectTranscript([queued({ commandMode: "bash", prompt: "ls" })])).toStrictEqual([]);
        expect(
            projectTranscript([L({ type: "attachment", attachment: { type: "hook_success", prompt: "x" } })])
        ).toStrictEqual([]);
    });

    it("projects nothing for a queued prompt with no text", () => {
        expect(projectTranscript([queued({ commandMode: "prompt", prompt: "  " })])).toStrictEqual([]);
        expect(projectTranscript([queued({ commandMode: "prompt" })])).toStrictEqual([]);
    });
});

describe("projectTranscript texts the arc mod joined mid-turn", () => {
    const L = (o: unknown) => JSON.stringify(o);
    const ARC = { kind: "plugin", name: "arc" };
    const toolUse = L({
        type: "assistant",
        timestamp: "2026-05-01T10:00:00.000Z",
        message: { content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "npm test" } }] },
    });
    const toolResult = L({
        type: "user",
        timestamp: "2026-05-01T10:00:05.000Z",
        message: { content: [{ type: "tool_result", tool_use_id: "b1", content: "ok" }] },
    });
    const joined = (content: unknown, origin: unknown = ARC) =>
        L({ type: "user", isMeta: true, origin, timestamp: "2026-05-01T10:00:06.000Z", message: { content } });

    it("projects a joined text as a queued user entry where it was written", () => {
        const out = projectTranscript([
            toolUse,
            toolResult,
            joined([{ type: "text", text: "t-5 passed review" }]),
            L({ type: "assistant", message: { content: [{ type: "text", text: "noted" }] } }),
        ]);
        expect(out.map((e) => e.kind)).toEqual(["action", "user", "message"]);
        expect(out[1]).toEqual({
            kind: "user",
            text: "t-5 passed review",
            queued: true,
            ts: Date.parse("2026-05-01T10:00:06.000Z"),
        });
    });

    it("projects a joined string content the same way", () => {
        expect(projectTranscript([joined("wake: task 3 failed (exit 1)")])).toMatchObject([
            { kind: "user", text: "wake: task 3 failed (exit 1)", queued: true },
        ]);
    });

    it("still skips a meta record from anywhere else, such as a skill body", () => {
        const out = projectTranscript([
            L({ type: "user", isMeta: true, message: { content: [{ type: "text", text: "# Skill body" }] } }),
            joined([{ type: "text", text: "from another plugin" }], { kind: "plugin", name: "other" }),
        ]);
        expect(out).toEqual([]);
    });

    it("draws nothing for the mod's read mid-turn notice", () => {
        const out = projectTranscript([
            L({ type: "system", subtype: "informational", content: "read mid-turn: also check b", level: "info" }),
        ]);
        expect(out).toEqual([]);
    });

    // the row Claude Code 2.1.326 writes for $.session.append at a tool result
    const note = (attachment: Record<string, unknown>) =>
        L({
            type: "attachment",
            timestamp: "2026-05-01T10:00:06.000Z",
            attachment: { type: "plugin_note", plugin: "arc", rowUuid: "r1", sentAs: "system", ...attachment },
        });

    it("projects a plugin note as a queued user entry where it was written, its lines joined", () => {
        const out = projectTranscript([
            toolUse,
            toolResult,
            note({ content: ["wake: task 3 passed review", "wsh jarvis dag status t-3"] }),
            L({ type: "assistant", message: { content: [{ type: "text", text: "noted" }] } }),
        ]);
        expect(out.map((e) => e.kind)).toEqual(["action", "user", "message"]);
        expect(out[1]).toEqual({
            kind: "user",
            text: "wake: task 3 passed review\nwsh jarvis dag status t-3",
            queued: true,
            ts: Date.parse("2026-05-01T10:00:06.000Z"),
        });
    });

    it("skips a plugin note the engine has not sent yet, and one from another plugin", () => {
        const out = projectTranscript([
            note({ content: [], heldContent: ["Reply with KIWI."], sentAs: undefined }),
            note({ plugin: "other", content: ["from another plugin"] }),
        ]);
        expect(out).toEqual([]);
    });

    it("projects the person's held messages sent at the turn's end as their own prompt", () => {
        const out = projectTranscript([
            L({
                type: "user",
                timestamp: "2026-05-01T10:01:00.000Z",
                origin: { kind: "plugin", name: "arc", asUser: true },
                promptSource: "system",
                message: { role: "user", content: "only touch renderedcomposer.tsx\nand keep the Esc order" },
            }),
        ]);
        expect(out).toEqual([
            {
                kind: "user",
                text: "only touch renderedcomposer.tsx\nand keep the Esc order",
                ts: Date.parse("2026-05-01T10:01:00.000Z"),
            },
        ]);
    });
});

// shapes from the 11-17 evidence sessions (worker f860511c t-4, detector eed05670)
describe("projectTranscript fix round 2", () => {
    const L = (o: unknown) => JSON.stringify(o);
    const CWD = "C:\\Users\\kael02\\AppData\\Local\\arc-wt\\f860511c-t-4";
    const TS = "2026-11-17T03:19:30.120Z";
    const use = (id: string, name: string, input: unknown) =>
        L({
            type: "assistant",
            cwd: CWD,
            timestamp: TS,
            message: { content: [{ type: "tool_use", id, name, input }] },
        });
    const result = (id: string, content: unknown, opts: { is_error?: boolean; toolUseResult?: unknown } = {}) =>
        L({
            type: "user",
            cwd: CWD,
            timestamp: TS,
            message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: opts.is_error ?? false }] },
            ...(opts.toolUseResult !== undefined ? { toolUseResult: opts.toolUseResult } : {}),
        });
    const notificationRecord = (summary: string, timestamp?: string) =>
        L({
            type: "user",
            ...(timestamp ? { timestamp } : {}),
            origin: { kind: "task-notification", producer: "session-task" },
            message: {
                content: [
                    "<task-notification>",
                    "<task-id>b58fanlr5</task-id>",
                    `<summary>${summary}</summary>`,
                    "<event>1:2026-11-17 14:34:26 start: train</event>",
                    "</task-notification>",
                ].join("\n"),
            },
        });

    it("gives a record of an interruption and images no empty-text user entry", () => {
        const out = projectTranscript([
            L({
                type: "user",
                message: {
                    content: [
                        { type: "text", text: "[Request interrupted by user]" },
                        { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR" } },
                    ],
                },
            }),
        ]);
        expect(out).toEqual([{ kind: "interrupted" }]);
    });

    it("draws a brief that quotes both tags as a user prompt with its full text", () => {
        const brief =
            "You are the worker for task 4.\nA `<task-notification>` arrives as a user record, and a slash command's " +
            "`<local-command-stdout>` fills its command.\n<summary>not a notification</summary>";
        const stdoutOnly = "Read the `<local-command-stdout>` record shape first.";
        const out = projectTranscript([
            L({ type: "user", timestamp: TS, message: { content: brief } }),
            L({ type: "user", timestamp: TS, message: { content: stdoutOnly } }),
        ]);
        expect(out).toEqual([
            { kind: "user", text: brief, ts: Date.parse(TS) },
            { kind: "user", text: stdoutOnly, ts: Date.parse(TS) },
        ]);
    });

    it("gives a notification user record its record time and a monitor source", () => {
        const summary = 'Monitor event: "plant bench cycle on .236 (step starts/ends, stop)"';
        expect(projectTranscript([notificationRecord(summary, "2026-11-17T07:05:55.079Z")])).toEqual([
            { kind: "notification", summary, source: "monitor", ts: Date.parse("2026-11-17T07:05:55.079Z") },
        ]);
    });

    it.each([
        ['Background command "Run transcript-base scenario in isolated dev app" completed (exit code 0)', "command"],
        ["Background shell command didn't finish before the previous session ended", "command"],
        ['Monitor event: "plant bench cycle on .236"', "monitor"],
        ['Agent "Map layout" finished', "subagent"],
    ])("reads the source of %s", (summary, source) => {
        expect(projectTranscript([notificationRecord(summary)])[0]).toMatchObject({ kind: "notification", source });
    });

    it("leaves the source off a notification whose summary names no known source", () => {
        expect(projectTranscript([notificationRecord("Something else happened")])[0]).not.toHaveProperty("source");
    });

    it("reads the source of a queued notice too, which keeps no record time", () => {
        const out = projectTranscript([
            L({
                type: "attachment",
                timestamp: TS,
                attachment: {
                    type: "queued_command",
                    commandMode: "task-notification",
                    prompt: '<task-notification>\n<task-id>b58</task-id>\n<summary>Monitor event: "bench"</summary>\n</task-notification>',
                },
            }),
        ]);
        expect(out).toEqual([{ kind: "notification", summary: 'Monitor event: "bench"', source: "monitor", notice: true }]);
    });

    it("strips ANSI colour codes from a Bash result's output", () => {
        const out = projectTranscript([
            use("b1", "Bash", { command: "npx prettier --check x.ts", description: "Lint and format check" }),
            result("b1", "Checking formatting...\n[\x1b[33mwarn\x1b[39m] frontend/x.ts"),
        ]);
        expect((out[0] as any).detail.output).toBe("Checking formatting...\n[warn] frontend/x.ts");
    });

    it("puts a refused Bash call's reason in error, unwrapped, and leaves no wrapper in its output", () => {
        const reason =
            "Refused by Arc: Claude Code already saves a background command's output to its output file, which Arc shows.";
        const out = projectTranscript([
            use("b1", "Bash", { command: "node final-verify.mjs > t4-final.log 2>&1", run_in_background: true }),
            result("b1", `<tool_use_error>${reason}</tool_use_error>`, {
                is_error: true,
                toolUseResult: `Error: ${reason}`,
            }),
        ]);
        expect(out[0]).toMatchObject({
            outcome: "blocked",
            error: reason,
            detail: { kind: "bash", command: "node final-verify.mjs > t4-final.log 2>&1", exit: null, output: "" },
        });
        expect(JSON.stringify(out)).not.toContain("tool_use_error");
    });

    it("keeps a Bash call that ran and failed to its output and exit code, with no error", () => {
        const out = projectTranscript([
            use("b1", "Bash", { command: "go test ./x" }),
            result("b1", "Exit code 1\nFAIL x", { is_error: true }),
        ]);
        expect(out[0]).toMatchObject({ outcome: "fail", detail: { kind: "bash", output: "Exit code 1\nFAIL x", exit: 1 } });
        expect(out[0]).not.toHaveProperty("error");
    });

    it("puts a failed Edit's error on it, with no attempted diff shown as applied", () => {
        const msg = "No changes to make: old_string and new_string are exactly the same.";
        const file = `${CWD}\\frontend\\app\\view\\agents\\transcriptprojection.ts`;
        const out = projectTranscript([
            use("e1", "Edit", { file_path: file, old_string: "// a", new_string: "// a" }),
            result("e1", `<tool_use_error>${msg}</tool_use_error>`, { is_error: true, toolUseResult: `Error: ${msg}` }),
        ]);
        expect(out[0]).toMatchObject({ outcome: "fail", error: msg });
        expect(out[0]).not.toHaveProperty("detail");
    });

    it("puts a failed Monitor call's multi-line error on the action", () => {
        const msg =
            "InputValidationError: Monitor failed due to the following issue:\nThe required parameter `description` is missing";
        const out = projectTranscript([
            use("m1", "Monitor", { query: "select:Monitor", max_results: "1" }),
            result("m1", `<tool_use_error>${msg}</tool_use_error>`, { is_error: true }),
        ]);
        expect(out[0]).toMatchObject({ kind: "action", outcome: "fail", error: msg });
        expect(out[0]).not.toHaveProperty("detail");
    });

    it("gives a failed Read its error and no read panel built from the error text", () => {
        const out = projectTranscript([
            use("r1", "Read", { file_path: `${CWD}\\missing.ts` }),
            result("r1", "File does not exist.", { is_error: true }),
        ]);
        expect(out[0]).toMatchObject({ outcome: "fail", error: "File does not exist." });
        expect(out[0]).not.toHaveProperty("detail");
    });

    it("sets no error on a call that succeeded", () => {
        const out = projectTranscript([use("r1", "Read", { file_path: `${CWD}\\a.ts` }), result("r1", "1\tx")]);
        expect(out[0]).not.toHaveProperty("error");
    });

    it("writes edit paths relative to the record's cwd, and a path outside it absolute, with forward slashes", () => {
        const patch = [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ["-a", "+b"] }];
        const out = projectTranscript([
            use("e1", "Edit", { file_path: `${CWD}\\frontend\\app\\a.ts`, old_string: "a", new_string: "b" }),
            result("e1", "ok", { toolUseResult: { structuredPatch: patch } }),
            use("e2", "Edit", { file_path: "D:\\other\\b.ts", old_string: "a", new_string: "b" }),
            result("e2", "ok"),
            use("w1", "Write", {
                file_path: "c:/users/kael02/appdata/local/arc-wt/f860511c-t-4/docs/c.md",
                content: "x",
            }),
            result("w1", "ok"),
        ]);
        expect(out.map((e: any) => e.detail.files[0].path)).toEqual(["frontend/app/a.ts", "D:/other/b.ts", "docs/c.md"]);
    });

    it("compares a POSIX cwd by whole path segments", () => {
        const at = (file_path: string) =>
            L({
                type: "assistant",
                cwd: "/home/u/proj",
                message: { content: [{ type: "tool_use", id: file_path, name: "Write", input: { file_path, content: "x" } }] },
            });
        const out = projectTranscript([at("/home/u/proj/src/a.ts"), at("/home/u/project2/a.ts")]);
        expect(out.map((e: any) => e.detail.files[0].path)).toEqual(["src/a.ts", "/home/u/project2/a.ts"]);
    });

    it("gives a Grep detail relative locations, its pattern and its case-insensitive flag", () => {
        const body = [
            `${CWD}\\frontend\\app\\cockpit\\palette-items.ts:144:                kind: "command" as const,`,
            'frontend\\app\\view\\agents\\agentsviewmodel.test.ts:1184:            { kind: "command", name: "/clear" },',
        ].join("\n");
        const out = projectTranscript([
            use("g1", "Grep", {
                pattern: "local-command-stdout|CommandChip",
                path: `${CWD}\\frontend`,
                output_mode: "content",
                "-i": true,
            }),
            result("g1", body),
        ]);
        expect((out[0] as any).detail).toEqual({
            kind: "grep",
            pattern: "local-command-stdout|CommandChip",
            ignoreCase: true,
            matches: [
                { loc: "frontend/app/cockpit/palette-items.ts:144", code: '                kind: "command" as const,' },
                {
                    loc: "frontend/app/view/agents/agentsviewmodel.test.ts:1184",
                    code: '            { kind: "command", name: "/clear" },',
                },
            ],
        });
    });

    it("leaves ignoreCase off a case-sensitive Grep", () => {
        const out = projectTranscript([
            use("g1", "Grep", { pattern: "x", output_mode: "content", "-n": true }),
            result("g1", "a.ts:1:x"),
        ]);
        expect((out[0] as any).detail).toMatchObject({ kind: "grep", pattern: "x" });
        expect((out[0] as any).detail).not.toHaveProperty("ignoreCase");
    });

    it("gives a cat -n Read detail its path relative to the cwd", () => {
        const body = "200\t}\n201\t\n202\t// the messages that have reply text";
        const out = projectTranscript([
            use("r1", "Read", {
                file_path: `${CWD}\\frontend\\app\\view\\agents\\transcriptprojection.ts`,
                offset: 200,
                limit: 3,
            }),
            result("r1", body),
        ]);
        expect((out[0] as any).detail).toEqual({
            kind: "read",
            snippet: body,
            truncated: false,
            path: "frontend/app/view/agents/transcriptprojection.ts",
        });
    });

    it("keeps a Write that created a file as badge A, and draws a Write that updated one as its patch with badge M", () => {
        const update = [{ oldStart: 4, oldLines: 2, newStart: 4, newLines: 2, lines: [" keep", "-old", "+new"] }];
        const out = projectTranscript([
            use("w1", "Write", { file_path: `${CWD}\\docs\\new.md`, content: "# Title\nbody" }),
            result("w1", "File created successfully", { toolUseResult: { type: "create", structuredPatch: [] } }),
            use("w2", "Write", { file_path: `${CWD}\\docs\\plan.md`, content: "keep\nnew" }),
            result("w2", "The file has been updated", { toolUseResult: { type: "update", structuredPatch: update } }),
        ]);
        expect((out[0] as any).detail.files[0]).toEqual({
            path: "docs/new.md",
            badge: "A",
            adds: 2,
            dels: 0,
            lines: [
                { sign: "+", text: "# Title" },
                { sign: "+", text: "body" },
            ],
        });
        expect((out[1] as any).detail.files[0]).toMatchObject({ path: "docs/plan.md", badge: "M", adds: 1, dels: 1 });
        expect((out[1] as any).detail.files[0].lines[0]).toEqual({ sign: "", text: "keep", oldNo: 4, newNo: 4 });
    });

    it("does not leak the scratch fields it keeps for the result", () => {
        const out = projectTranscript([use("g1", "Grep", { pattern: "x" }), result("g1", "a.ts:1:x")]);
        expect(Object.keys(out[0]).filter((k) => k.startsWith("_"))).toEqual([]);
    });
});

// the census's projection findings (findings.md A1-A8, C7, F5, decision 1), each from trimmed records of the specimen
// it names
describe("projectTranscript census fixes", () => {
    const L = (o: unknown) => JSON.stringify(o);
    const use = (id: string, name: string, input: unknown) =>
        L({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
    const result = (id: string, content: unknown, opts: { is_error?: boolean; extra?: object } = {}) =>
        L({
            type: "user",
            ...opts.extra,
            message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: opts.is_error ?? false }] },
        });
    const REJECTED =
        "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the " +
        "new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

    // #143
    it("A1: projects a PowerShell call as a shell command with its command, output and exit", () => {
        const command = "Get-ChildItem env: | Where-Object { $_.Name -match 'ARC|RUN' } | Format-Table -AutoSize";
        const output =
            "Exit code 1\nName          Value\r\n----          -----\r\nARC_RUN_AGENT 1\r\n\r\nError: in no Arc project";
        const out = projectTranscript([
            use("p1", "PowerShell", { command, description: "Inspect run-related env vars and list runs" }),
            result("p1", output, { is_error: true }),
            use("p2", "PowerShell", { command: "Get-Location" }),
            result("p2", "Path\n----\nC:\\x"),
        ]);
        expect(out[0]).toMatchObject({
            verb: "ran",
            target: "Inspect run-related env vars and list runs",
            command,
            outcome: "fail",
            detail: {
                kind: "bash",
                command,
                output: "Exit code 1\nName          Value\n----          -----\nARC_RUN_AGENT 1\n\nError: in no Arc project",
                exit: 1,
            },
        });
        expect(out[0]).not.toHaveProperty("error");
        expect(out[1]).toMatchObject({ verb: "ran", outcome: "ok", detail: { kind: "bash", exit: 0 } });
    });

    // #75, #8, #126
    it("A2: decodes XML entities in a task-notification's fields, once", () => {
        const content = [
            "<task-notification>",
            "<task-id>b1</task-id>",
            '<summary>Background command "mkdir -p out &amp;&amp; node final-verify.mjs agent-rendered 2&gt;&amp;1" completed (exit code 0)</summary>',
            "<status>completed</status>",
            "<result>flows: `a --&gt; b`, quoted &quot;x&quot; and &#39;y&#39;, a literal &amp;lt;tag&amp;gt;</result>",
            "</task-notification>",
        ].join("\n");
        const [note] = projectTranscript([L({ type: "user", message: { content } })]) as any[];
        expect(note.summary).toBe(
            'Background command "mkdir -p out && node final-verify.mjs agent-rendered 2>&1" completed (exit code 0)'
        );
        expect(note.result).toBe("flows: `a --> b`, quoted \"x\" and 'y', a literal &lt;tag&gt;");
    });

    // #16
    it("A3: drops Claude Code's system-reminder block from a compaction summary", () => {
        const summary =
            "This session is being continued from a previous conversation that ran out of context.\n\n" +
            "<system-reminder>\n<tools-used-before-summary>Bash, Grep</tools-used-before-summary>\n</system-reminder>\n" +
            "Summary:\n1. Primary Request and Intent:\n   - **Spec:** docs/x.md";
        const [c] = projectTranscript([
            L({ type: "user", isCompactSummary: true, message: { content: summary } }),
        ]) as any[];
        expect(c.summary).toBe(
            "This session is being continued from a previous conversation that ran out of context.\n\n" +
                "Summary:\n1. Primary Request and Intent:\n   - **Spec:** docs/x.md"
        );
    });

    // #51
    it("A4: keeps no diff on a failed Edit or Write, only its error", () => {
        const msg = "String to replace not found in file.\nString: \t\torchestrate.MarkInterruptedRuns(ctx)";
        const out = projectTranscript([
            use("e1", "Edit", { file_path: "/p/main-server.go", old_string: "a\nb", new_string: "a\nb\nc" }),
            result("e1", `<tool_use_error>${msg}</tool_use_error>`, { is_error: true }),
            use("w1", "Write", { file_path: "/p/new.md", content: "x\ny" }),
            result("w1", "<tool_use_error>File has not been read yet.</tool_use_error>", { is_error: true }),
        ]);
        expect(out[0]).toMatchObject({ verb: "edited", outcome: "fail", error: msg });
        expect(out[0]).not.toHaveProperty("detail");
        expect(out[1]).toMatchObject({ verb: "wrote", outcome: "fail", error: "File has not been read yet." });
        expect(out[1]).not.toHaveProperty("detail");
    });

    // #70, #74, #75, #84, #87, #145, #150
    it.each([
        ["SendFeedback", { type: "bug", title: "Lead stalled", details: "long" }, "send feedback", "Lead stalled"],
        ["ListAgents", {}, "list agents", ""],
        ["TaskStop", { task_id: "b1ggaf2wk" }, "task stop", "b1ggaf2wk"],
        ["KillShell", { shell_id: "s42" }, "kill shell", "s42"],
        ["ToolSearch", { query: "select:Monitor", max_results: 1 }, "tool search", "select:Monitor"],
        ["WebSearch", { query: "vitest related flag" }, "web search", "vitest related flag"],
        ["WebFetch", { url: "https://example.com/a", prompt: "summarise" }, "web fetch", "https://example.com/a"],
        [
            "ScheduleWakeup",
            { delaySeconds: 1200, reason: "fallback check", prompt: "Check the run" },
            "schedule wakeup",
            "fallback check",
        ],
        ["mcp__ccd_turn__update_plan", { prompt: "next step" }, "update plan", "next step"],
        ["request_user_input_async", {}, "request user input async", ""],
    ])("A5: reads the unmapped tool %s as a spaced verb and its salient input", (name, input, verb, target) => {
        expect(projectTranscript([use("x1", name, input)])[0]).toMatchObject({ verb, target });
    });

    // #31, #47, #124
    it("A7: drops the harness's boilerplate lines from a tool result", () => {
        const background =
            "Command running in background with ID: b4j6qw37i. Output is being written to: C:\\T\\b4j6qw37i.output. " +
            "You will be notified when it completes — do not poll that file or sleep while waiting.";
        const out = projectTranscript([
            use("b1", "Bash", { command: "node final-verify.mjs", run_in_background: true }),
            result("b1", background),
            use("b2", "Bash", { command: "wsh runs show 2ef30fc3" }),
            result(
                "b2",
                "Error: no run 2ef30fc3 in any project\nShell cwd was reset to C:\\Users\\kael02\\IdeaProjects\\waveterm"
            ),
            use("b3", "Bash", { command: "sed -i s/a/b/ Taskfile.yml" }),
            result(
                "b3",
                "done\n[This command modified 1 file you've previously read: Taskfile.yml. Call Read before editing.]"
            ),
        ]) as any[];
        expect(out.map((e) => e.detail.output)).toEqual(["", "Error: no run 2ef30fc3 in any project", "done"]);
    });

    // #123
    it("A8: collapses carriage-return progress to each line's last state", () => {
        const out = projectTranscript([
            use("b1", "Bash", { command: "git checkout --detach HEAD" }),
            result(
                "b1",
                "Preparing files (detached HEAD 1a2b)\nUpdating files:  57% (1784/3093)\rUpdating files:  58% (1794/3093)\r" +
                    "Updating files: 100% (3093/3093), done.\r\nHEAD is now at 1a2b fix\r"
            ),
        ]) as any[];
        expect(out[0].detail.output).toBe(
            "Preparing files (detached HEAD 1a2b)\nUpdating files: 100% (3093/3093), done.\nHEAD is now at 1a2b fix"
        );
    });

    // #141, #53
    it("C7: strips ANSI escapes from a Read body", () => {
        const body = "109\tconst OUT = `\x1b[1m${LINES[0]}\x1b[0m\n110\t\x1b[32mdone\x1b[0m`;";
        const [action] = projectTranscript([
            use("r1", "Read", { file_path: "/p/scenarios.mjs" }),
            result("r1", body),
        ]) as any[];
        expect(action.detail.snippet).toBe("109\tconst OUT = `${LINES[0]}\n110\tdone`;");
    });

    // #31
    it("F5: reads an InputValidationError as its message, without the schema the harness appends", () => {
        const msg =
            "InputValidationError: Monitor failed due to the following issue:\nThe required parameter `description` is missing\n\n" +
            "This tool's schema was not sent to the API. For reference, this tool's input schema is: " +
            '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"}';
        const [action] = projectTranscript([
            use("m1", "Monitor", { command: "tail -f x" }),
            result("m1", `<tool_use_error>${msg}</tool_use_error>`, { is_error: true }),
        ]) as any[];
        expect(action).toMatchObject({
            outcome: "fail",
            error: "InputValidationError: Monitor failed due to the following issue:\nThe required parameter `description` is missing",
        });
    });

    describe("decision 1: declined", () => {
        // #4
        it("reads a question the user declined as declined, with the question's own line", () => {
            const [action] = projectTranscript([
                use("q1", "AskUserQuestion", {
                    questions: [{ question: "What do you dislike?", options: [{ label: "A" }] }],
                }),
                result("q1", REJECTED, {
                    is_error: true,
                    extra: { toolUseResult: "User rejected tool use", toolDenialKind: "user-rejected" },
                }),
            ]) as any[];
            expect(action).toMatchObject({
                outcome: "declined",
                error: "You declined the question, so Claude stopped and waited for you.",
                detail: { kind: "ask" },
            });
            expect(action).not.toHaveProperty("summary");
        });

        // #84
        it("reads any other call the user declined as declined, with the call's line", () => {
            const [action] = projectTranscript([
                use("w1", "WebSearch", { query: "x" }),
                result("w1", REJECTED, { is_error: true }),
            ]) as any[];
            expect(action).toMatchObject({
                outcome: "declined",
                error: "You declined this call, so Claude stopped and waited for you.",
            });
        });

        it("tells a user-rejected Bash (declined) from a hook-refused one (blocked), neither having run", () => {
            const out = projectTranscript([
                use("b1", "Bash", { command: "rm -rf build" }),
                result("b1", REJECTED, { is_error: true }),
                use("b2", "Bash", { command: "task build > log" }),
                result(
                    "b2",
                    "<tool_use_error>Refused by Arc: Claude Code already saves a background command's output.</tool_use_error>",
                    { is_error: true }
                ),
            ]);
            expect(out[0]).toMatchObject({
                outcome: "declined",
                error: "You declined this call, so Claude stopped and waited for you.",
                detail: { kind: "bash", exit: null, output: "" },
            });
            expect(out[1]).toMatchObject({ outcome: "blocked", detail: { kind: "bash", exit: null, output: "" } });
        });

        it("keeps a permission denial's first sentence, which names the rule", () => {
            const out = projectTranscript([
                use("r1", "Read", { file_path: "C:\\Users\\kael02\\Downloads\\bench" }),
                result("r1", "Permission to read C:\\Users\\kael02\\Downloads\\bench has been denied.", {
                    is_error: true,
                }),
                use("b1", "Bash", { command: "rm -rf $X/" }),
                result(
                    "b1",
                    "Permission for this command was denied by a built-in Claude Code safety check, not by the user. The check stops removals.",
                    { is_error: true }
                ),
                use("b2", "PowerShell", { command: "Get-Item $(pwd)" }),
                result("b2", "Command contains subexpressions $(). Approve only if you trust it.", {
                    is_error: true,
                    extra: { toolDenialKind: "user-rejected" },
                }),
            ]);
            expect(out.map((e: any) => [e.outcome, e.error])).toEqual([
                ["declined", "Permission to read C:\\Users\\kael02\\Downloads\\bench has been denied."],
                [
                    "declined",
                    "Permission for this command was denied by a built-in Claude Code safety check, not by the user.",
                ],
                ["declined", "Command contains subexpressions $()."],
            ]);
        });

        it("keeps a real error a failure, and a command that printed a refusal phrase a failed run", () => {
            const out = projectTranscript([
                use("b1", "Bash", { command: "grep -h 'rejected' *.jsonl" }),
                result("b1", `Exit code 1\n${REJECTED}`, { is_error: true }),
                use("r1", "Read", { file_path: "/p/missing.ts" }),
                result("r1", "<tool_use_error>File does not exist.</tool_use_error>", { is_error: true }),
                use("e1", "Edit", { file_path: "/p/a.ts", old_string: "a", new_string: "b" }),
                result("e1", "<tool_use_error>File not found: /p/a.ts</tool_use_error>", { is_error: true }),
            ]);
            expect(out.map((e: any) => e.outcome)).toEqual(["fail", "fail", "fail"]);
            expect(out[0]).toMatchObject({ detail: { kind: "bash", exit: 1 } });
        });
    });
});
