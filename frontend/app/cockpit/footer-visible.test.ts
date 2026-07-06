// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Binding, KeyContext } from "@/app/store/keybindings/types";
import { describe, expect, it } from "vitest";
import type { FooterHint } from "./footerhints";
import { visibleHints } from "./footer-visible";

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
