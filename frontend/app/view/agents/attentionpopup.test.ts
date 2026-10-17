import { describe, expect, it } from "vitest";
import { newAttention, POPUP_AT_REST, popupBubble, popupFace, popupPlacement, type PopupFace } from "./attentionpopup";
import { taskbarSignal } from "./attentionstore";

const item = (over: Partial<AttentionItem>): AttentionItem =>
    ({ kind: "ask", key: "k", source: "s", text: "t", action: "Answer", waitingsince: 0, ...over }) as AttentionItem;

describe("newAttention", () => {
    it("keeps next's order", () => {
        const next = [item({ key: "c" }), item({ key: "a" }), item({ key: "b" })];
        expect(newAttention([item({ key: "a" })], next).map((i) => i.key)).toEqual(["c", "b"]);
    });
    it("is empty when every key was there", () => {
        expect(newAttention([item({ key: "a" })], [item({ key: "a" })])).toEqual([]);
    });
    it("is everything when prev is empty", () => {
        expect(newAttention([], [item({ key: "a" }), item({ key: "b" })])).toHaveLength(2);
    });
});

describe("popupBubble", () => {
    it("is null while focused", () => {
        expect(popupBubble([], [item({ key: "a" })], true)).toBeNull();
    });
    it("is null when nothing is new", () => {
        expect(popupBubble([item({ key: "a" })], [item({ key: "a" })], false)).toBeNull();
    });
    it("reads Asking you for an ask", () => {
        expect(popupBubble([], [item({ key: "a", source: "loom", text: "which?" })], false)).toEqual({
            key: "a",
            label: "Asking you",
            name: "loom",
            text: "which?",
            more: 0,
        });
    });
    it.each([
        ["dag-gate", "Review"],
        ["escalation", "Decide"],
        ["run-unverified", "Acknowledge"],
        ["radar-triage", "Triage"],
    ])("labels %s with its action %s", (kind, action) => {
        expect(popupBubble([], [item({ kind, action })], false).label).toBe(action);
    });
    it("names the first new item with the others counted", () => {
        const next = [item({ key: "a" }), item({ key: "b" }), item({ key: "c" })];
        expect(popupBubble([], next, false)).toMatchObject({ key: "a", more: 2 });
    });
    it("counts only items new in the same poll", () => {
        const old = [item({ key: "a" }), item({ key: "b" })];
        expect(popupBubble(old, [...old, item({ key: "c" })], false)).toMatchObject({ key: "c", more: 0 });
    });
    it("names the first new item even when an older one ranks above it", () => {
        const next = [item({ key: "old" }), item({ key: "new" })];
        expect(popupBubble([item({ key: "old" })], next, false)).toMatchObject({ key: "new" });
    });
    it("agrees with taskbarSignal", () => {
        const a = item({ key: "a" });
        const b = item({ key: "b" });
        const lists = [[], [a], [b], [a, b]];
        for (const prev of lists) {
            for (const next of lists) {
                for (const focused of [true, false]) {
                    expect(popupBubble(prev, next, focused) != null).toBe(
                        taskbarSignal(prev, next, focused) === "flash"
                    );
                }
            }
        }
    });
});

describe("popupBubble for a brainstorm question", () => {
    const question = item({
        kind: "brainstorm",
        key: "brainstorm:t1:5",
        source: "lag-alerts",
        text: "Who reads the page first?",
        reason: "For “What on-call sees” · question 5",
        action: "brainstorm",
    });

    it("reads the agent's name, brainstorm, the question and the part it is for", () => {
        expect(popupBubble([], [question], false)).toEqual({
            key: "brainstorm:t1:5",
            kind: "brainstorm",
            label: "lag-alerts · brainstorm",
            name: undefined,
            text: "Who reads the page first?",
            detail: "For “What on-call sees” · question 5",
            more: 0,
            face: undefined,
        });
    });
    it("is null while focused", () => {
        expect(popupBubble([], [question], true)).toBeNull();
    });
    it("is null for a question already seen", () => {
        expect(popupBubble([question], [question], false)).toBeNull();
    });
});

describe("popupFace", () => {
    const gate: PopupFace = { expression: { kind: "tired", provider: "claude", pct: 92 }, posture: "review-gate" };

    it("carries the face it was given", () => {
        const bubble = popupBubble([], [item({ key: "a" })], false, gate);
        expect(bubble.face).toEqual(gate);
        expect(popupFace(bubble)).toEqual(gate);
    });
    it("is at rest with no posture when the payload has no face", () => {
        const bubble = popupBubble([], [item({ key: "a" })], false);
        expect(popupFace(bubble)).toEqual({ expression: { kind: "at-rest" }, posture: "none" });
        expect(popupFace(bubble)).toBe(POPUP_AT_REST);
    });
});

describe("popupPlacement", () => {
    it("sits 16px in from the bottom right of the work area", () => {
        expect(popupPlacement({ x: 0, y: 0, width: 1920, height: 1040 }, { width: 268, height: 96 })).toEqual({
            x: 1636,
            y: 928,
        });
    });
    it("is offset by a non-zero origin", () => {
        expect(popupPlacement({ x: 48, y: 30, width: 1800, height: 1010 }, { width: 268, height: 96 })).toEqual({
            x: 1564,
            y: 928,
        });
    });
});
