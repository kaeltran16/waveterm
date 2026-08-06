// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Binding, KeyContext } from "@/app/store/keybindings/types";
import { describe, expect, it, vi } from "vitest";
import { buildCommandItems, buildExtraItems, postCloseContext } from "./palette-commands";

const bind = (over: Partial<Binding> & Pick<Binding, "id" | "keys" | "label">): Binding => ({
    group: "Global",
    run: () => {},
    ...over,
});

// The guard shape most cockpit bindings use: only while the user is looking at a surface, not typing
// into a field and not behind a modal.
const navigate = (ctx: KeyContext) => !ctx.editable && !ctx.modalOpen;

describe("postCloseContext", () => {
    it("describes the posture one frame after the palette closes", () => {
        expect(postCloseContext("usage")).toEqual({
            surface: "usage",
            editable: false,
            modalOpen: false,
            leader: null,
        });
    });
    it("passes a navigate guard that the palette's own live context would fail", () => {
        const live: KeyContext = { surface: "usage", editable: true, modalOpen: true, leader: null };
        expect(navigate(postCloseContext("usage"))).toBe(true);
        expect(navigate(live)).toBe(false);
    });
});

describe("buildCommandItems", () => {
    const ctx = postCloseContext("usage");

    it("omits bindings tagged paletteHidden", () => {
        const items = buildCommandItems([bind({ id: "list:next", keys: "j", label: "Next item", paletteHidden: true })], ctx);
        expect(items).toEqual([]);
    });

    it("omits bindings whose guard rejects the post-close context", () => {
        const items = buildCommandItems(
            [bind({ id: "only-code", keys: "Ctrl:s", label: "Save", when: (c) => c.surface === "code" })],
            ctx
        );
        expect(items).toEqual([]);
    });

    it("keeps bindings with no guard at all", () => {
        const items = buildCommandItems([bind({ id: "new-agent", keys: "Ctrl:n", label: "New agent" })], ctx);
        expect(items.map((i) => i.key)).toEqual(["new-agent"]);
    });

    it("collapses same-labelled bindings, keeping the leader sequence", () => {
        const items = buildCommandItems(
            [
                bind({ id: "cycle-agent-next", keys: "Ctrl:Tab", label: "Next agent" }),
                bind({ id: "agent:next", keys: "ArrowRight", label: "Next agent" }),
                bind({ id: "go:next", keys: "g n", label: "Next agent" }),
            ],
            ctx
        );
        expect(items).toHaveLength(1);
        expect(items[0].keys).toBe("g n");
    });

    it("prefers a modifier chord over a bare posture key", () => {
        const items = buildCommandItems(
            [
                bind({ id: "agent:next", keys: "ArrowRight", label: "Next agent" }),
                bind({ id: "cycle-agent-next", keys: "Ctrl:Tab", label: "Next agent" }),
            ],
            ctx
        );
        expect(items[0].keys).toBe("Ctrl:Tab");
    });

    it("runs the binding with the post-close context, not the live one", () => {
        const run = vi.fn();
        const items = buildCommandItems([bind({ id: "x", keys: "Ctrl:x", label: "X", run })], ctx);
        items[0].run();
        expect(run).toHaveBeenCalledWith(ctx);
    });
});

describe("buildExtraItems", () => {
    const deps = () => ({ openNewProject: vi.fn(), openNewMemory: vi.fn(), setTheme: vi.fn() });

    it("offers the two chordless modals and one row per picker theme", () => {
        const items = buildExtraItems(deps());
        expect(items.slice(0, 2).map((i) => i.key)).toEqual(["cmd:new-project", "cmd:new-memory"]);
        expect(items.filter((i) => i.key.startsWith("cmd:theme:"))).toHaveLength(6);
    });
    it("carries no chord", () => {
        expect(buildExtraItems(deps()).every((i) => i.keys == null)).toBe(true);
    });
    it("switches to the chosen preset id", () => {
        const d = deps();
        buildExtraItems(d).find((i) => i.key === "cmd:theme:carbon")!.run();
        expect(d.setTheme).toHaveBeenCalledWith("carbon");
    });
});
