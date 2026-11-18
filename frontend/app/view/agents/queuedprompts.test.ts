// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { footList, SEND_TO_ENQUEUE_MS, waitingPrompts } from "./queuedprompts";

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

    it("a content-less enqueue waits with no text and still shifts the FIFO", () => {
        expect(waitingPrompts([enqueue(undefined, T)])).toEqual([{ key: expect.any(String), ts: T }]);
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

    // claude records a message typed during a compaction as an enqueue with no content
    it("fills a content-less enqueue with the message sent from the box just before it", () => {
        const waiting = waitingPrompts([enqueue(undefined, T + 300)]);
        expect(footList(waiting, [{ text: "banana", ts: T }]).map((i) => i.text)).toEqual(["banana"]);
    });

    // seen live: the /compact sent just before it runs at once and is never queued, so it must not take the message's place
    it("fills it with the latest send before it, not the /compact that started the compaction", () => {
        const waiting = waitingPrompts([enqueue(undefined, T + 1600)]);
        const sent = [
            { text: "/compact", ts: T },
            { text: "banana", ts: T + 1500 },
        ];
        expect(footList(waiting, sent).map((i) => i.text)).toEqual(["banana"]);
    });

    it("draws nothing for a content-less enqueue no send from the box explains", () => {
        const waiting = waitingPrompts([enqueue(undefined, T + SEND_TO_ENQUEUE_MS + 1)]);
        expect(footList(waiting, [{ text: "old", ts: T }])).toEqual([]);
        expect(footList(waiting)).toEqual([]);
    });

    it("gives each send to one content-less enqueue, in order", () => {
        const waiting = waitingPrompts([
            enqueue(undefined, T + 100),
            enqueue("typed", T + 150),
            enqueue(undefined, T + 200),
        ]);
        const sent = [
            { text: "first", ts: T },
            { text: "second", ts: T + 50 },
        ];
        expect(footList(waiting, sent).map((i) => i.text)).toEqual(["first", "typed", "second"]);
    });

    it("gives every item a distinct key", () => {
        const items = footList(waitingPrompts([enqueue("same", T), enqueue("same", T)]));
        expect(new Set(items.map((i) => i.key)).size).toBe(2);
    });
});
