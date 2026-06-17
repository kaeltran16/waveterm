import { describe, expect, it } from "vitest";
import { projectTranscript } from "./transcriptprojection";

const LINES: string[] = [
    JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "fix the race" }] } }), // human prompt -> skipped
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
