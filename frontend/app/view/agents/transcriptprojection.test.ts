import { describe, expect, it } from "vitest";
import { extractAiTitle, extractTasks, projectTranscript } from "./transcriptprojection";

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
