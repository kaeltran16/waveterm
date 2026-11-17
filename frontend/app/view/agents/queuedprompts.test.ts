// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentEntry } from "./agentsviewmodel";
import { footList, nextModItems, waitingPrompts, type ModItem } from "./queuedprompts";

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

const prompt = (id: string, text: string, ts: number) => ({ id, text, ts });
const held = (...items: QueuedPrompt[]): AgentQueueData => ({ oref: "block:b", held: items });

describe("nextModItems", () => {
    const a = prompt("a", "first", T);
    const b = prompt("b", "second", T + 1);

    it("marks the reported items held, in their order", () => {
        expect(nextModItems([], held(a, b))).toEqual([
            { ...a, held: true },
            { ...b, held: true },
        ]);
    });

    it("keeps an item gone from held as not held", () => {
        const prev = nextModItems([], held(a, b));
        expect(nextModItems(prev, held(b))).toEqual([
            { ...a, held: false },
            { ...b, held: true },
        ]);
    });

    it("drops a lost item", () => {
        const prev = nextModItems([], held(a, b));
        expect(nextModItems(prev, { oref: "block:b", held: [b], lost: [a] })).toEqual([{ ...b, held: true }]);
    });

    it("the same report again changes nothing", () => {
        const prev = nextModItems([], held(a));
        expect(nextModItems(prev, held(a))).toEqual(prev);
    });
});

const mod = (id: string, text: string, ts: number, isHeld: boolean): ModItem => ({ id, text, ts, held: isHeld });
const user = (text: string, ts?: number): AgentEntry => ({ kind: "user", text, ...(ts == null ? {} : { ts }) });

describe("footList", () => {
    it("draws held items queued, with the queued count", () => {
        const foot = footList([mod("a", "one", T, true), mod("b", "two", T + 1, true)], [], []);
        expect(foot.items.map((i) => [i.text, i.queued])).toEqual([
            ["one", true],
            ["two", true],
        ]);
        expect(foot.queued).toBe(2);
    });

    it("a mod item gone from held with no matching entry still draws, without the Queued line", () => {
        const foot = footList([mod("a", "one", T, false)], [], [user("something else", T + 5)]);
        expect(foot.items.map((i) => [i.text, i.queued])).toEqual([["one", false]]);
        expect(foot.queued).toBe(0);
        expect(foot.retired).toEqual([]);
    });

    it("items a and b retire once a later user entry a\\nb exists", () => {
        const items = [mod("a", "a", T, false), mod("b", "b", T + 1, false)];
        const foot = footList(items, [], [user("a\nb", T + 10)]);
        expect(foot.items).toEqual([]);
        expect(foot.retired).toEqual(["a", "b"]);
    });

    it("a multi-line item retires only on a contiguous run of its lines", () => {
        const item = [mod("m", "x\ny", T, false)];
        expect(footList(item, [], [user("x\nz\ny", T + 1)]).retired).toEqual([]);
        expect(footList(item, [], [user("w\nx\ny", T + 1)]).retired).toEqual(["m"]);
    });

    it("an item /x arg retires on a later command entry {name: /x, args: arg}", () => {
        const items = [mod("c", "/x arg", T, false)];
        expect(footList(items, [], [{ kind: "command", name: "/x", args: "arg", ts: T + 3 }]).retired).toEqual(["c"]);
        expect(footList(items, [], [{ kind: "command", name: "/x", ts: T + 3 }]).retired).toEqual([]);
        const bare = [mod("d", "/clear", T, false)];
        expect(footList(bare, [], [{ kind: "command", name: "/clear", ts: T + 3 }]).retired).toEqual(["d"]);
    });

    it("an entry from before the item's ts retires nothing", () => {
        const items = [mod("a", "again", T, false)];
        const foot = footList(items, [], [user("again", T - 1), user("again")]);
        expect(foot.items.map((i) => i.text)).toEqual(["again"]);
        expect(foot.retired).toEqual([]);
    });

    it("a held item is never retired by a matching entry", () => {
        const foot = footList([mod("a", "one", T, true)], [], [user("one", T + 1)]);
        expect(foot.items.map((i) => [i.text, i.queued])).toEqual([["one", true]]);
    });

    it("a lost item does not draw", () => {
        const items = nextModItems(nextModItems([], held(prompt("a", "one", T))), {
            oref: "block:b",
            held: [],
            lost: [prompt("a", "one", T)],
        });
        expect(footList(items, [], []).items).toEqual([]);
    });

    it("draws Claude Code's waiting prompts queued, in time order with the mod's, counted together", () => {
        const waiting = waitingPrompts([enqueue("typed in the terminal", T + 1)]);
        const foot = footList([mod("a", "one", T, true), mod("b", "two", T + 2, true)], waiting, []);
        expect(foot.items.map((i) => i.text)).toEqual(["one", "typed in the terminal", "two"]);
        expect(foot.queued).toBe(3);
    });

    it("splits a slash command into the command row's name and args", () => {
        const foot = footList([mod("c", "  /review the branch ", T, true), mod("p", "plain", T + 1, true)], [], []);
        expect(foot.items[0].command).toEqual({ name: "/review", args: "the branch" });
        expect(foot.items[1].command).toBeUndefined();
        expect(footList([mod("c", "/clear", T, true)], [], []).items[0].command).toEqual({ name: "/clear" });
    });

    it("gives every item a distinct key", () => {
        const waiting = waitingPrompts([enqueue("same", T), enqueue("same", T)]);
        const foot = footList([mod("same", "same", T, true)], waiting, []);
        expect(new Set(foot.items.map((i) => i.key)).size).toBe(3);
    });
});
