// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { buildAgentBindings, buildGlobalBindings } from "@/app/store/keybindings/bindings";
import type { Binding, KeyContext, SurfaceKey } from "@/app/store/keybindings/types";
import { attachCanvas, detachCanvas, setCanvasMode, setMarking, updateCanvas } from "@/app/view/agents/canvasstore";
import { atom, type PrimitiveAtom } from "jotai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { visibleHints } from "./footer-visible";
import { GLOBAL_HINTS, SURFACE_HINTS, type FooterHint } from "./footerhints";

const nav = (c: KeyContext) => !c.editable && !c.modalOpen && c.surface === "agent";
const bindings: Binding[] = [
    { id: "agent:move", keys: "j", group: "Agent", label: "", when: nav, run: () => {} },
    { id: "palette", keys: "Ctrl:p", group: "Global", label: "", run: () => {} },
    { id: "agent:leave", keys: "Shift:Escape", group: "Agent", label: "", when: (c) => c.surface === "agent" && c.editable, run: () => {} },
];
const surfaceHints: FooterHint[] = [
    { ids: ["agent:move"], glyph: "↑↓", label: "move" },
    { ids: ["agent:leave"], glyph: "⇧Esc", label: "leave" },
    { ids: ["nonexistent"], glyph: "x", label: "ghost" },
];
const globalHints: FooterHint[] = [{ ids: ["palette"], glyph: "⌃P", label: "palette" }];

const rest: KeyContext = { surface: "agent", editable: false, modalOpen: false, leader: null };
const term: KeyContext = { surface: "agent", editable: true, modalOpen: false, leader: null };

describe("visibleHints", () => {
    it("at rest shows nav + always-on hints, hides editable-only and dangling ones", () => {
        expect(visibleHints(rest, bindings, surfaceHints, globalHints).map((c) => c.label)).toEqual(["move", "palette"]);
    });

    it("in the terminal drops nav hints and shows editable-surviving ones", () => {
        expect(visibleHints(term, bindings, surfaceHints, globalHints).map((c) => c.label)).toEqual(["leave", "palette"]);
    });

    it("never shows a hint whose binding id does not exist", () => {
        const labels = visibleHints(rest, bindings, surfaceHints, globalHints).map((c) => c.label);
        expect(labels).not.toContain("ghost");
    });

    it("de-dupes a hint referenced by both surface and global tables", () => {
        const s: FooterHint[] = [{ ids: ["palette"], glyph: "⌃P", label: "palette" }];
        const g: FooterHint[] = [{ ids: ["palette"], glyph: "⌃P", label: "palette" }];
        expect(visibleHints(rest, bindings, s, g).filter((c) => c.label === "palette").length).toBe(1);
    });
});

describe("agent canvas mode chips", () => {
    const model = {
        focusIdAtom: atom<string | undefined>("a1") as PrimitiveAtom<string | undefined>,
        surfaceAtom: atom<SurfaceKey>("agent"),
    } as any;
    const real = [...buildGlobalBindings(model), ...buildAgentBindings(model)];
    const chips = () =>
        visibleHints(rest, real, SURFACE_HINTS.agent!, GLOBAL_HINTS).map((c) => `${c.glyph ?? c.keys} ${c.label}`);
    const globals = () => visibleHints(rest, real, [], GLOBAL_HINTS).map((c) => `${c.glyph ?? c.keys} ${c.label}`);

    beforeEach(() => {
        attachCanvas("a1", { topic: "t", dir: "/p/.superpowers/design/t", projectDir: "/p" }, 0);
        updateCanvas("a1", (s) => ({ ...s, status: "ready", boards: [{ name: "Main.dc.html", w: 1440 }] }));
    });

    afterEach(() => {
        detachCanvas("a1");
    });

    it("terminal mode with a canvas offers c canvas between full and back", () => {
        expect(chips()).toEqual([
            "↑↓ move",
            "d rail",
            "f full",
            "F11 full",
            "c canvas",
            "esc back",
            "Ctrl:Tab cycle",
            ...globals(),
        ]);
    });

    it("canvas mode shows only terminal, board and mark before the globals", () => {
        setCanvasMode("a1", "canvas", 1);
        expect(chips()).toEqual(["c terminal", "[ ] board", "m mark", ...globals()]);
    });

    it("marking shows stop marking, then terminal", () => {
        setCanvasMode("a1", "canvas", 1);
        setMarking("a1", true);
        expect(chips()).toEqual(["m stop marking", "c terminal", ...globals()]);
    });
});
