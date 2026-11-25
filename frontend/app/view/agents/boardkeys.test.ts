// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { BOARD_KEY_TYPE, relayedKey, type BoardKeyMessage } from "./boardkeys";

const BOARD = "http://127.0.0.1:61234";
// stand-ins for window objects: only their identity matters
const frame = {} as Window;
const other = {} as Window;

const msg = (over: Partial<BoardKeyMessage> = {}): BoardKeyMessage => ({
    type: BOARD_KEY_TYPE,
    key: "Escape",
    code: "Escape",
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    editable: false,
    ...over,
});

const from = (data: unknown, source: Window | null = frame, origin = BOARD) => ({ data, source, origin });

describe("relayedKey", () => {
    it("re-dispatches a key from its own board as the same keydown", () => {
        expect(relayedKey(from(msg({ key: "]", code: "BracketRight", shiftKey: true })), frame, BOARD)).toEqual({
            key: "]",
            code: "BracketRight",
            ctrlKey: false,
            shiftKey: true,
            altKey: false,
            metaKey: false,
        });
    });

    it.each([
        ["another window", from(msg(), other)],
        ["no window", from(msg(), null)],
        ["another origin", from(msg(), frame, "http://127.0.0.1:5174")],
        ["another message type", from({ ...msg(), type: "other" })],
        ["no data", from(null)],
        ["a key that is not a string", from({ ...msg(), key: 27 })],
        ["a non-Escape key from a field", from(msg({ key: "m", code: "KeyM", editable: true }))],
    ])("drops a message from %s", (_name, e) => {
        expect(relayedKey(e, frame, BOARD)).toBeNull();
    });

    it("takes Escape from a field, the one key the host takes from a field", () => {
        expect(relayedKey(from(msg({ editable: true })), frame, BOARD)).toMatchObject({ key: "Escape" });
    });

    it("drops everything while the iframe has no window", () => {
        expect(relayedKey(from(msg(), null), null, BOARD)).toBeNull();
    });
});
