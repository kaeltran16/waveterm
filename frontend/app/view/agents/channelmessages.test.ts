// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { parseMentions, planMessage } from "./channelmessages";

describe("parseMentions", () => {
    it("returns no mentions for plain text", () => {
        expect(parseMentions("hello there")).toEqual({ mentions: [], body: "hello there" });
    });

    it("extracts leading mentions and strips them from the body", () => {
        expect(parseMentions("@codex build the auth refactor")).toEqual({
            mentions: ["codex"],
            body: "build the auth refactor",
        });
    });

    it("lowercases mentions and keeps interior text intact", () => {
        expect(parseMentions("@API-Auth do the thing")).toEqual({ mentions: ["api-auth"], body: "do the thing" });
    });
});

const roster = [
    { id: "t1", name: "api-auth", blockId: "b1" },
    { id: "t2", name: "web", blockId: "b2" },
];

describe("planMessage", () => {
    it("plans a dispatch when the mention is a known runtime", () => {
        expect(planMessage("@codex build it", roster)).toEqual({
            kind: "dispatch",
            runtime: "codex",
            text: "build it",
        });
    });

    it("plans a steer when the mention is a live worker name", () => {
        expect(planMessage("@api-auth run the tests", roster)).toEqual({
            kind: "steer",
            targetId: "t1",
            blockId: "b1",
            text: "run the tests",
        });
    });

    it("plans a plain post when there is no actionable mention", () => {
        expect(planMessage("just a note", roster)).toEqual({ kind: "post", text: "just a note" });
    });

    it("treats an unknown mention as a plain post", () => {
        expect(planMessage("@nobody hi", roster)).toEqual({ kind: "post", text: "@nobody hi" });
    });
});