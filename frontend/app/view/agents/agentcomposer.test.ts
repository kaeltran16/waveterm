import { describe, expect, it, vi } from "vitest";
import { canSendComposer, submitComposer } from "./agentcomposer";

describe("submitComposer", () => {
    it("clears with the sent text only after the send resolves", async () => {
        let resolve: () => void;
        const send = vi.fn(() => new Promise<void>((r) => (resolve = r)));
        const clear = vi.fn();
        const p = submitComposer("hello", "block:1", clear, send);
        expect(send).toHaveBeenCalledWith("block:1", "hello");
        await Promise.resolve();
        expect(clear).not.toHaveBeenCalled();
        resolve!();
        await p;
        expect(clear).toHaveBeenCalledWith("hello");
    });
    it("keeps the text and logs when the send fails", async () => {
        const err = vi.spyOn(console, "error").mockImplementation(() => {});
        const clear = vi.fn();
        await submitComposer("hello", "block:1", clear, () => Promise.reject(new Error("send to block block:1: boom")));
        expect(clear).not.toHaveBeenCalled();
        expect(err).toHaveBeenCalled();
        err.mockRestore();
    });
});

describe("canSendComposer", () => {
    it("is false when block-less (idle composer with no live terminal — T4)", () => {
        expect(canSendComposer("hello", undefined)).toBe(false);
    });
    it("is false when text is empty or whitespace", () => {
        expect(canSendComposer("", "block:1")).toBe(false);
        expect(canSendComposer("   ", "block:1")).toBe(false);
    });
    it("is true with non-empty text and a live block", () => {
        expect(canSendComposer("hi", "block:1")).toBe(true);
    });
});
