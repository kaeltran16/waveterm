import { toastsAtom } from "@/app/cockpit/notificationstore";
import { globalStore } from "@/app/store/jotaiStore";
import { describe, expect, it, vi } from "vitest";
import { canSendComposer, submitComposer } from "./agentcomposer";
import type { Attachment } from "./composerattachments";

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
    it("hands the text to onSubmitText when the send starts, before it lands", async () => {
        const calls: string[] = [];
        const send = vi.fn(async () => {
            calls.push("send");
        });
        const onSubmitText = vi.fn((t: string) => calls.push(`start:${t}`));
        await submitComposer("/config", "block:1", () => {}, send, onSubmitText);
        expect(onSubmitText).toHaveBeenCalledWith("/config");
        expect(calls).toEqual(["start:/config", "send"]);
    });
    it("keeps the text and shows the refusal in an error toast when the send fails", async () => {
        const err = vi.spyOn(console, "error").mockImplementation(() => {});
        globalStore.set(toastsAtom, []);
        const clear = vi.fn();
        const refusal = "send to block block:1: block block:1 has no live terminal: nothing was sent";
        await submitComposer("hello", "block:1", clear, () => Promise.reject(new Error(refusal)));
        expect(clear).not.toHaveBeenCalled();
        expect(globalStore.get(toastsAtom)).toMatchObject([{ level: "error", message: refusal }]);
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
    it("is false while an attachment is still uploading, even with text", () => {
        expect(canSendComposer("hi", "block:1", [att("uploading")])).toBe(false);
    });
    it("is false while an attachment has failed, even with text", () => {
        expect(canSendComposer("hi", "block:1", [att("ready", "C:/t/a.png"), att("error")])).toBe(false);
    });
    it("is true with blank text and a ready attachment", () => {
        expect(canSendComposer("  ", "block:1", [att("ready", "C:/t/a.png")])).toBe(true);
    });
    it("is false with blank text and no attachments", () => {
        expect(canSendComposer("", "block:1", [])).toBe(false);
    });
    it("is false with no block, whatever is attached", () => {
        expect(canSendComposer("hi", undefined, [att("ready", "C:/t/a.png")])).toBe(false);
    });
});

function att(status: Attachment["status"], path?: string): Attachment {
    return { id: crypto.randomUUID(), name: "a.png", kind: "image", status, path };
}
