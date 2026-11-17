// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { footList, waitingPrompts } from "./queuedprompts";

const T = Date.UTC(2026, 10, 17, 9, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const op = (operation: string, ms: number, extra: Record<string, unknown> = {}) => ({
    type: "queue-operation",
    operation,
    timestamp: iso(ms),
    sessionId: "s",
    ...extra,
});
const enqueue = (content: string | undefined, ms: number) => op("enqueue", ms, content == null ? {} : { content });
const texts = (records: unknown[]) => waitingPrompts(records).map((w) => w.text);

describe("waitingPrompts (Claude Code's own queue)", () => {
    it("an enqueue with nothing after it waits", () => {
        expect(texts([enqueue("x", T)])).toEqual(["x"]);
    });

    it("a remove absorbed_mid_turn takes it", () => {
        const recs = [enqueue("x", T), op("remove", T + 1, { content: "x", reason: "absorbed_mid_turn" })];
        expect(texts(recs)).toEqual([]);
    });

    it("a dequeue takes the oldest", () => {
        expect(texts([enqueue("x", T), enqueue("y", T + 1), op("dequeue", T + 2)])).toEqual(["y"]);
    });

    it("popAll drops every waiting one", () => {
        expect(texts([enqueue("x", T), enqueue("y", T + 1), op("popAll", T + 2, { content: "x\ny" })])).toEqual([]);
    });

    it("a content-less enqueue is never drawn and still shifts the FIFO", () => {
        expect(texts([enqueue(undefined, T)])).toEqual([]);
        expect(texts([enqueue(undefined, T), enqueue("x", T + 1), op("dequeue", T + 2)])).toEqual(["x"]);
    });

    it("a task notification is counted but never drawn", () => {
        const note = "<task-notification>\nshell done\n</task-notification>";
        expect(texts([enqueue(note, T)])).toEqual([]);
        expect(texts([enqueue(note, T), enqueue("x", T + 1), op("dequeue", T + 2)])).toEqual(["x"]);
    });

    it("keeps a slash command and the enqueue's time", () => {
        expect(waitingPrompts([enqueue("/review now", T)])).toMatchObject([{ text: "/review now", ts: T }]);
    });

    it("ignores records that are not queue operations", () => {
        expect(texts([{ type: "user", message: { content: "hi" } }, null, enqueue("x", T)])).toEqual(["x"]);
    });
});

describe("footList", () => {
    it("draws Claude Code's waiting prompts in the order they were sent", () => {
        const waiting = waitingPrompts([enqueue("one", T), enqueue("two", T + 1)]);
        expect(footList(waiting).map((i) => i.text)).toEqual(["one", "two"]);
    });

    it("splits a slash command into the command row's name and args", () => {
        const items = footList(
            waitingPrompts([enqueue("  /review the branch ", T), enqueue("plain", T + 1), enqueue("/clear", T + 2)])
        );
        expect(items[0].command).toEqual({ name: "/review", args: "the branch" });
        expect(items[1].command).toBeUndefined();
        expect(items[2].command).toEqual({ name: "/clear" });
    });

    it("gives every item a distinct key", () => {
        const items = footList(waitingPrompts([enqueue("same", T), enqueue("same", T)]));
        expect(new Set(items.map((i) => i.key)).size).toBe(2);
    });
});
