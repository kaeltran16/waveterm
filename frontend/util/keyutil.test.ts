import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    adaptFromReactOrNativeKeyEvent,
    checkKeyPressed,
    getKeyUtilPlatform,
    parseKeyDescription,
    setKeyUtilPlatform,
} from "./keyutil";

function waveEvent(over: Partial<WaveKeyboardEvent> = {}): WaveKeyboardEvent {
    return {
        type: "keydown",
        key: "a",
        code: "KeyA",
        control: false,
        shift: false,
        cmd: false,
        option: false,
        meta: false,
        alt: false,
        repeat: false,
        location: 0,
        ...over,
    } as WaveKeyboardEvent;
}

function domEvent(over: Record<string, unknown> = {}): KeyboardEvent {
    return {
        type: "keydown",
        key: "a",
        code: "KeyA",
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        location: 0,
        repeat: false,
        ...over,
    } as unknown as KeyboardEvent;
}

let savedPlatform: NodeJS.Platform;
beforeEach(() => {
    savedPlatform = getKeyUtilPlatform();
    setKeyUtilPlatform("darwin");
});
afterEach(() => setKeyUtilPlatform(savedPlatform));

describe("parseKeyDescription", () => {
    it("maps Cmd, Option, Alt and Meta onto each other's modifiers on macOS", () => {
        expect(parseKeyDescription("Cmd:a")).toStrictEqual({
            key: "a",
            keyType: "key",
            mods: { Meta: true, Cmd: true },
        });
        expect(parseKeyDescription("Option:a")).toStrictEqual({
            key: "a",
            keyType: "key",
            mods: { Alt: true, Option: true },
        });
        expect(parseKeyDescription("Alt:a")).toStrictEqual({
            key: "a",
            keyType: "key",
            mods: { Option: true, Alt: true },
        });
        expect(parseKeyDescription("Meta:a")).toStrictEqual({
            key: "a",
            keyType: "key",
            mods: { Cmd: true, Meta: true },
        });
    });
    it("maps them the other way off macOS", () => {
        setKeyUtilPlatform("linux");
        expect(parseKeyDescription("Cmd:a")).toStrictEqual({
            key: "a",
            keyType: "key",
            mods: { Alt: true, Cmd: true },
        });
        expect(parseKeyDescription("Option:a")).toStrictEqual({
            key: "a",
            keyType: "key",
            mods: { Meta: true, Option: true },
        });
        expect(parseKeyDescription("Alt:a")).toStrictEqual({
            key: "a",
            keyType: "key",
            mods: { Cmd: true, Alt: true },
        });
        expect(parseKeyDescription("Meta:a")).toStrictEqual({
            key: "a",
            keyType: "key",
            mods: { Option: true, Meta: true },
        });
    });
    it("applies Shift to an upper case letter, and to nothing longer than one character", () => {
        expect(parseKeyDescription("A")).toStrictEqual({ key: "A", keyType: "key", mods: { Shift: true } });
        expect(parseKeyDescription("a")).toStrictEqual({ key: "a", keyType: "key", mods: {} });
        expect(parseKeyDescription("Enter")).toStrictEqual({ key: "Enter", keyType: "key", mods: {} });
    });
    it("reads a single space as the Space key", () => {
        expect(parseKeyDescription(" ")).toStrictEqual({ key: "Space", keyType: "key", mods: {} });
    });
});

describe("checkKeyPressed", () => {
    it("fails when the event holds a modifier the description does not name", () => {
        expect(checkKeyPressed(waveEvent({ option: true }), "a")).toBe(false);
        expect(checkKeyPressed(waveEvent({ cmd: true }), "a")).toBe(false);
        expect(checkKeyPressed(waveEvent({ alt: true }), "a")).toBe(false);
        expect(checkKeyPressed(waveEvent({ meta: true }), "a")).toBe(false);
        expect(checkKeyPressed(waveEvent(), "a")).toBe(true);
    });
    it("matches a code description against the event's code, not its key", () => {
        expect(checkKeyPressed(waveEvent({ key: "a", code: "KeyA" }), "c{KeyA}")).toBe(true);
        expect(checkKeyPressed(waveEvent({ key: "a", code: "KeyB" }), "c{KeyA}")).toBe(false);
        expect(checkKeyPressed(waveEvent({ key: "KeyA", code: "KeyB" }), "c{KeyA}")).toBe(false);
    });
    it("matches a modifiers-only description whatever key the event carries", () => {
        expect(checkKeyPressed(waveEvent({ cmd: true, meta: true, code: "KeyA" }), "Cmd")).toBe(true);
    });
    it("accepts an upper case event letter for a lower case description and the reverse", () => {
        expect(checkKeyPressed(waveEvent({ key: "E", shift: true }), "Shift:e")).toBe(true);
        expect(checkKeyPressed(waveEvent({ key: "E", shift: true }), "Shift:E")).toBe(true);
        expect(checkKeyPressed(waveEvent({ key: "E", shift: true }), "E")).toBe(true);
    });
    it("does not fold case for a lower case event letter against an upper case description", () => {
        expect(checkKeyPressed(waveEvent({ key: "a", shift: true }), "A")).toBe(false);
    });
    it("does not fold case for a multi-character key", () => {
        expect(checkKeyPressed(waveEvent({ key: "Enter" }), "enter")).toBe(false);
        expect(checkKeyPressed(waveEvent({ key: "Enter" }), "Enter")).toBe(true);
    });
    it("fails, without throwing, when the event has no key", () => {
        expect(checkKeyPressed(waveEvent({ key: null }), "a")).toBe(false);
        expect(checkKeyPressed(waveEvent({ key: undefined }), "a")).toBe(false);
    });
    it("matches a space event against Space and a single space", () => {
        expect(checkKeyPressed(waveEvent({ key: " " }), "Space")).toBe(true);
        expect(checkKeyPressed(waveEvent({ key: " " }), " ")).toBe(true);
        expect(checkKeyPressed(waveEvent({ key: " " }), "a")).toBe(false);
    });
});

describe("adaptFromReactOrNativeKeyEvent", () => {
    it("reads Cmd from the meta key and Option from the alt key on macOS", () => {
        const e = adaptFromReactOrNativeKeyEvent(domEvent({ metaKey: true, altKey: false }));
        expect([e.cmd, e.option, e.meta, e.alt]).toEqual([true, false, true, false]);
    });
    it("reads Cmd from the alt key and Option from the meta key elsewhere", () => {
        setKeyUtilPlatform("linux");
        const e = adaptFromReactOrNativeKeyEvent(domEvent({ metaKey: true, altKey: false }));
        expect([e.cmd, e.option, e.meta, e.alt]).toEqual([false, true, true, false]);
    });
    it("keeps keydown, keyup and keypress types and calls any other unknown", () => {
        expect(
            ["keydown", "keyup", "keypress", "click"].map(
                (t) => adaptFromReactOrNativeKeyEvent(domEvent({ type: t })).type
            )
        ).toEqual(["keydown", "keyup", "keypress", "unknown"]);
    });
});
