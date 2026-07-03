// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { matchBinding } from "./matcher";
import type { Binding, KeyContext } from "./types";

// Build a minimal WaveKeyboardEvent literal (keyutil reads these fields directly).
function ev(key: string, mods: Partial<WaveKeyboardEvent> = {}): WaveKeyboardEvent {
    return {
        control: false,
        shift: false,
        cmd: false,
        option: false,
        meta: false,
        alt: false,
        key,
        code: "",
        location: 0,
        repeat: false,
        type: "keydown",
        ...mods,
    } as WaveKeyboardEvent;
}

const navCtx: KeyContext = { surface: "cockpit", editable: false, modalOpen: false, leader: null };
const editCtx: KeyContext = { surface: "cockpit", editable: true, modalOpen: false, leader: null };

function bind(over: Partial<Binding>): Binding {
    return { id: "x", keys: "j", group: "g", label: "l", run: () => {}, ...over };
}

describe("matchBinding", () => {
    it("matches a global chord even when editable", () => {
        const b = bind({ id: "palette", keys: "Ctrl:p", when: () => true });
        const r = matchBinding(ev("p", { control: true }), editCtx, [b]);
        expect(r).toEqual({ kind: "run", binding: b });
    });

    it("does not match a navigate single-key when editable", () => {
        const b = bind({ id: "nav", keys: "j", when: (c) => !c.editable });
        expect(matchBinding(ev("j"), editCtx, [b])).toEqual({ kind: "none" });
    });

    it("matches a navigate single-key when not editable", () => {
        const b = bind({ id: "nav", keys: "j", when: (c) => !c.editable });
        expect(matchBinding(ev("j"), navCtx, [b])).toEqual({ kind: "run", binding: b });
    });

    it("enters leader mode when a leader prefix is pressed (navigate posture)", () => {
        const b = bind({ id: "go-agent", keys: "g a", when: (c) => !c.editable && !c.modalOpen });
        expect(matchBinding(ev("g"), navCtx, [b])).toEqual({ kind: "enterLeader", leader: "g" });
    });

    it("does not enter leader mode when editable", () => {
        const b = bind({ id: "go-agent", keys: "g a", when: (c) => !c.editable && !c.modalOpen });
        expect(matchBinding(ev("g"), editCtx, [b])).toEqual({ kind: "none" });
    });

    it("runs the continuation binding when leader is active", () => {
        const b = bind({ id: "go-agent", keys: "g a", when: (c) => !c.editable && !c.modalOpen });
        const ctx: KeyContext = { ...navCtx, leader: "g" };
        expect(matchBinding(ev("a"), ctx, [b])).toEqual({ kind: "run", binding: b });
    });

    it("resets and consumes on an invalid continuation letter", () => {
        const b = bind({ id: "go-agent", keys: "g a", when: (c) => !c.editable && !c.modalOpen });
        const ctx: KeyContext = { ...navCtx, leader: "g" };
        expect(matchBinding(ev("z"), ctx, [b])).toEqual({ kind: "reset" });
    });

    it("resets and re-processes a modifier chord pressed during leader mode", () => {
        const seq = bind({ id: "go-agent", keys: "g a", when: (c) => !c.editable && !c.modalOpen });
        const chord = bind({ id: "s1", keys: "Ctrl:1", when: () => true });
        const ctx: KeyContext = { ...navCtx, leader: "g" };
        expect(matchBinding(ev("1", { control: true }), ctx, [seq, chord])).toEqual({
            kind: "resetAndProcess",
            result: { kind: "run", binding: chord },
        });
    });

    it("returns none when nothing matches", () => {
        expect(matchBinding(ev("q"), navCtx, [bind({ keys: "j" })])).toEqual({ kind: "none" });
    });
});
