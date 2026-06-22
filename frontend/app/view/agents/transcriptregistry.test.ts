import { describe, expect, it } from "vitest";
import { projectorFor } from "./transcriptregistry";

// A line each format understands; the other format projects it to nothing — so which entries come
// back tells us which projector the resolver picked, without coupling to the registry internals.
const codexLine = JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] } });
const claudeLine = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } });
const MSG = [{ kind: "message", text: "hi" }];

describe("projectorFor", () => {
    it("routes by explicit agent: codex", () => {
        expect(projectorFor("codex").project([codexLine])).toEqual(MSG);
        expect(projectorFor("codex").project([claudeLine])).toEqual([]);
    });

    it("routes by explicit agent: claude", () => {
        expect(projectorFor("claude").project([claudeLine])).toEqual(MSG);
        expect(projectorFor("claude").project([codexLine])).toEqual([]);
    });

    it("falls back to the transcript path when the agent is absent", () => {
        expect(projectorFor(undefined, "C:/Users/u/.codex/sessions/2026/r.jsonl").project([codexLine])).toEqual(MSG);
        expect(projectorFor(undefined, "/home/u/.claude/projects/enc/x.jsonl").project([claudeLine])).toEqual(MSG);
    });

    it("prefers a .claude path even when it also contains .codex (claude working in a codex dir)", () => {
        const p = "/home/u/.claude/projects/C--Users-u--codex-spike/x.jsonl";
        expect(projectorFor(undefined, p).project([claudeLine])).toEqual(MSG);
    });

    it("defaults to claude for an unknown agent and no path", () => {
        expect(projectorFor("opencode").project([claudeLine])).toEqual(MSG);
        expect(projectorFor(undefined, undefined).project([claudeLine])).toEqual(MSG);
    });

    it("exposes extractTitle for claude (ai-title) and omits it for codex (deferred)", () => {
        const titleLine = JSON.stringify({ type: "ai-title", aiTitle: "Fix it" });
        expect(projectorFor("claude").extractTitle?.([titleLine])).toBe("Fix it");
        expect(projectorFor("codex").extractTitle).toBeUndefined();
    });
});
