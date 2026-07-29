// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { SURFACE_ORDER, type SurfaceKey } from "@/app/view/agents/agents";
import { atom } from "jotai";
import { describe, expect, it } from "vitest";
import { appliedAtom, decisionsAtom, reviewModelAtom, reviewSelectedAtom } from "@/app/view/agents/reviewstore";
import { focusSubagentAtom } from "@/app/view/agents/subagentsstore";
import { activeChannelRunsAtom } from "@/app/view/agents/channelsstore";
import { graphPeekOpenAtom, stageRailOpenAtom } from "@/app/view/jarvis/jarvisstore";
import { activeRunIdAtom, activeSubjectAtom } from "@/app/view/jarvis/jarvissubjectstore";
import {
    buildAgentBindings,
    buildGlobalBindings,
    buildJarvisBindings,
    buildListNavBindings,
    buildReviewBindings,
    closeTargetForDoubleCtrlC,
} from "./bindings";
import { listNavAtom } from "./listnav";
import type { KeyContext } from "./types";

const ctx = (surface: SurfaceKey = "cockpit"): KeyContext => ({
    surface,
    editable: false,
    modalOpen: false,
    leader: null,
});

describe("closeTargetForDoubleCtrlC", () => {
    const agents = [
        { id: "agent-tab", name: "Agent", state: "working" },
        { id: "terminal-tab", name: "Terminal", state: "idle", kind: "terminal" },
    ] as any;

    it("closes a focused agent session (spec §5: double-Ctrl+C closes the agent)", () => {
        expect(closeTargetForDoubleCtrlC(agents, "agent-tab")).toEqual(agents[0]);
    });

    it("closes a focused plain terminal row", () => {
        expect(closeTargetForDoubleCtrlC(agents, "terminal-tab")).toEqual(agents[1]);
    });

    it("returns null (no close) when nothing is focused", () => {
        expect(closeTargetForDoubleCtrlC(agents, undefined)).toBeNull();
    });

    it("returns null when the focused id is not in the roster", () => {
        expect(closeTargetForDoubleCtrlC(agents, "gone")).toBeNull();
    });
});

describe("surface switch [ / ]", () => {
    it("cycles SURFACE_ORDER forward/back with wrap and reaches radar", () => {
        const model = { surfaceAtom: atom<SurfaceKey>("cockpit") } as any;
        const bindings = buildGlobalBindings(model);
        const next = bindings.find((b) => b.id === "surface:next")!;
        const prev = bindings.find((b) => b.id === "surface:prev")!;
        expect(next.keys).toBe("]");
        expect(prev.keys).toBe("[");

        next.run(ctx()); // cockpit -> jarvis
        expect(globalStore.get(model.surfaceAtom)).toBe("jarvis");

        globalStore.set(model.surfaceAtom, "agent");
        next.run(ctx()); // agent -> radar (radar is in SURFACE_ORDER)
        expect(globalStore.get(model.surfaceAtom)).toBe("radar");

        globalStore.set(model.surfaceAtom, SURFACE_ORDER[SURFACE_ORDER.length - 1]);
        next.run(ctx()); // wrap forward to first
        expect(globalStore.get(model.surfaceAtom)).toBe(SURFACE_ORDER[0]);

        prev.run(ctx()); // wrap back to last
        expect(globalStore.get(model.surfaceAtom)).toBe(SURFACE_ORDER[SURFACE_ORDER.length - 1]);
    });

    it("enters the cycle gracefully from a surface not in SURFACE_ORDER (settings)", () => {
        const model = { surfaceAtom: atom<SurfaceKey>("settings") } as any;
        const bindings = buildGlobalBindings(model);
        bindings.find((b) => b.id === "surface:next")!.run(ctx("settings"));
        expect(globalStore.get(model.surfaceAtom)).toBe(SURFACE_ORDER[0]);
    });

    it("switch bindings are suppressed while typing / modal open", () => {
        const model = { surfaceAtom: atom<SurfaceKey>("cockpit") } as any;
        const next = buildGlobalBindings(model).find((b) => b.id === "surface:next")!;
        expect(next.when!({ surface: "cockpit", editable: true, modalOpen: false, leader: null })).toBe(false);
        expect(next.when!({ surface: "cockpit", editable: false, modalOpen: true, leader: null })).toBe(false);
        expect(next.when!(ctx())).toBe(true);
    });

    it("exposes a g r leader teleport to radar", () => {
        const model = { surfaceAtom: atom<SurfaceKey>("cockpit") } as any;
        const b = buildGlobalBindings(model).find((x) => x.id === "go:radar")!;
        expect(b.keys).toBe("g r");
        b.run(ctx());
        expect(globalStore.get(model.surfaceAtom)).toBe("radar");
    });
});

describe("list-nav bindings", () => {
    const chanCtx: KeyContext = { surface: "jarvis", editable: false, modalOpen: false, leader: null };

    it("is inactive with no controller, when editable/modal, or on a mismatched surface", () => {
        globalStore.set(listNavAtom, null);
        const j = buildListNavBindings().find((b) => b.id === "list:next-j")!;
        expect(j.keys).toBe("j");
        expect(j.when!(chanCtx)).toBe(false); // no controller

        globalStore.set(listNavAtom, { surface: "jarvis", navigableIds: ["a", "b"], cursorId: "a", setCursor() {} });
        expect(j.when!(chanCtx)).toBe(true);
        expect(j.when!({ ...chanCtx, editable: true })).toBe(false);
        expect(j.when!({ ...chanCtx, modalOpen: true })).toBe(false);
        expect(j.when!({ ...chanCtx, surface: "memory" })).toBe(false); // controller is for jarvis
        globalStore.set(listNavAtom, null);
    });

    it("j/ArrowDown move forward and k/ArrowUp back via moveCursor (clamped, no wrap)", () => {
        const seen: string[] = [];
        globalStore.set(listNavAtom, {
            surface: "jarvis",
            navigableIds: ["a", "b", "c"],
            cursorId: "b",
            setCursor: (id) => seen.push(id),
        });
        const bindings = buildListNavBindings();
        bindings.find((b) => b.id === "list:next-j")!.run(chanCtx);
        bindings.find((b) => b.id === "list:prev-k")!.run(chanCtx);
        bindings.find((b) => b.id === "list:next")!.run(chanCtx);
        bindings.find((b) => b.id === "list:prev")!.run(chanCtx);
        expect(seen).toEqual(["c", "a", "c", "a"]); // from "b": +1=c, -1=a, +1=c, -1=a
        globalStore.set(listNavAtom, null);
    });

    it("first press from an empty/absent cursor lands on the first id", () => {
        const seen: string[] = [];
        globalStore.set(listNavAtom, { surface: "jarvis", navigableIds: ["a", "b"], cursorId: undefined, setCursor: (id) => seen.push(id) });
        buildListNavBindings().find((b) => b.id === "list:next-j")!.run(chanCtx);
        expect(seen).toEqual(["a"]);
        globalStore.set(listNavAtom, null);
    });
});

describe("jarvis surface bindings", () => {
    const jarvisCtx: KeyContext = { surface: "jarvis", editable: false, modalOpen: false, leader: null };
    const byId = (id: string) => buildJarvisBindings().find((b) => b.id === id)!;

    // the click-through bindings (+ Channel, the record band) and composer focus act on rendered DOM, so
    // only their guards are asserted here — this suite runs in node, and the surface has no render harness
    // (see docs: surface behaviour is checked over CDP, not jsdom).

    it("toggles the context rail with d", () => {
        globalStore.set(stageRailOpenAtom, true);
        const d = byId("jarvis:toggle-rail");
        expect(d.keys).toBe("d");
        d.run(jarvisCtx);
        expect(globalStore.get(stageRailOpenAtom)).toBe(false);
        d.run(jarvisCtx);
        expect(globalStore.get(stageRailOpenAtom)).toBe(true);
    });

    it("toggles the graph peek with Shift:g — distinct from the g leader, and live while the peek is open", () => {
        globalStore.set(graphPeekOpenAtom, false);
        const g = byId("jarvis:graph-peek");
        expect(g.keys).toBe("Shift:g");
        g.run(jarvisCtx);
        expect(globalStore.get(graphPeekOpenAtom)).toBe(true);
        expect(g.when!(jarvisCtx)).toBe(true); // its own toggle stays reachable behind the overlay
        g.run(jarvisCtx);
        expect(globalStore.get(graphPeekOpenAtom)).toBe(false);
    });

    it("suppresses the Stage keys while the graph peek owns the surface", () => {
        globalStore.set(graphPeekOpenAtom, true);
        for (const id of ["jarvis:toggle-rail", "jarvis:new-thread", "jarvis:record-band", "jarvis:next-run"]) {
            expect(byId(id).when!(jarvisCtx)).toBe(false);
        }
        globalStore.set(graphPeekOpenAtom, false);
        expect(byId("jarvis:toggle-rail").when!(jarvisCtx)).toBe(true);
    });

    it("guards every key on the surface, the typing state and modals", () => {
        globalStore.set(graphPeekOpenAtom, false);
        for (const b of buildJarvisBindings()) {
            expect(b.when!({ ...jarvisCtx, surface: "cockpit" })).toBe(false);
            expect(b.when!({ ...jarvisCtx, modalOpen: true })).toBe(false);
        }
        // ...except the composer's own Escape, which exists *because* focus is in a field
        expect(byId("jarvis:blur-composer").when!({ ...jarvisCtx, editable: true })).toBe(true);
        for (const b of buildJarvisBindings().filter((x) => x.id !== "jarvis:blur-composer")) {
            expect(b.when!({ ...jarvisCtx, editable: true })).toBe(false);
        }
    });

    it("opens a new thread with n and puts it on the Stage", () => {
        globalStore.set(graphPeekOpenAtom, false);
        globalStore.set(activeSubjectAtom, null);
        byId("jarvis:new-thread").run(jarvisCtx);
        const subject = globalStore.get(activeSubjectAtom);
        expect(subject?.kind).toBe("conversation");
        expect(subject?.id).toBeTruthy();
    });

    it("steps the selected channel's runs with Shift:j / Shift:k, clamped at both ends", () => {
        globalStore.set(graphPeekOpenAtom, false);
        globalStore.set(activeSubjectAtom, { kind: "channel", id: "ch1" });
        globalStore.set(activeChannelRunsAtom, [
            { id: "r1", status: "running" },
            { id: "r2", status: "running" },
        ] as any);
        globalStore.set(activeRunIdAtom, { ch1: "r1" });
        const next = byId("jarvis:next-run");
        const prev = byId("jarvis:prev-run");
        expect(next.keys).toBe("Shift:j");
        expect(prev.keys).toBe("Shift:k");

        next.run(jarvisCtx);
        expect(globalStore.get(activeRunIdAtom)["ch1"]).toBe("r2");
        next.run(jarvisCtx); // clamped at the end
        expect(globalStore.get(activeRunIdAtom)["ch1"]).toBe("r2");
        prev.run(jarvisCtx);
        expect(globalStore.get(activeRunIdAtom)["ch1"]).toBe("r1");
    });

    it("passes the run keys through when the subject is not a channel, or has nothing to switch", () => {
        globalStore.set(graphPeekOpenAtom, false);
        globalStore.set(activeSubjectAtom, { kind: "conversation", id: "c1" });
        expect(byId("jarvis:next-run").run(jarvisCtx)).toBe(false);

        globalStore.set(activeSubjectAtom, { kind: "channel", id: "ch1" });
        globalStore.set(activeChannelRunsAtom, [{ id: "r1", status: "running" }] as any);
        expect(byId("jarvis:next-run").run(jarvisCtx)).toBe(false); // a single run is not a switch
        globalStore.set(activeChannelRunsAtom, []);
        globalStore.set(activeSubjectAtom, null);
    });
});

describe("subagent vs agent Escape", () => {
    it("routes Escape to subagent-back only while a subagent is focused, else to agent-back", () => {
        const bindings = buildAgentBindings({} as any);
        const sub = bindings.find((b) => b.id === "subagent:back")!;
        const back = bindings.find((b) => b.id === "agent:back")!;
        expect(sub.keys).toBe("Escape");
        const agentCtx: KeyContext = { surface: "agent", editable: false, modalOpen: false, leader: null };

        globalStore.set(focusSubagentAtom, { parentId: "p", agentId: "s" } as any);
        expect(sub.when!(agentCtx)).toBe(true);
        expect(back.when!(agentCtx)).toBe(false);
        sub.run(agentCtx);
        expect(globalStore.get(focusSubagentAtom)).toBeNull();

        // now that no subagent is focused, Escape falls to agent-back
        expect(sub.when!(agentCtx)).toBe(false);
        expect(back.when!(agentCtx)).toBe(true);
    });
});

describe("review bindings", () => {
    const filesCtx: KeyContext = { surface: "files", editable: false, modalOpen: false, leader: null };

    it("is active only on files with a loaded, un-applied review and respects the typing-guard", () => {
        const a = buildReviewBindings().find((b) => b.id === "review:accept")!;
        expect(a.keys).toBe("a");
        globalStore.set(reviewModelAtom, null);
        expect(a.when!(filesCtx)).toBe(false); // no model

        globalStore.set(reviewModelAtom, { cwd: "/x", files: [] } as any);
        globalStore.set(appliedAtom, null);
        expect(a.when!(filesCtx)).toBe(true);
        expect(a.when!({ ...filesCtx, editable: true })).toBe(false);
        expect(a.when!({ ...filesCtx, surface: "memory" })).toBe(false);

        globalStore.set(appliedAtom, { accepted: 1, rejected: 0, failures: [] });
        expect(a.when!(filesCtx)).toBe(false); // already applied

        globalStore.set(reviewModelAtom, null);
        globalStore.set(appliedAtom, null);
    });

    it("j/k move the selected review file", () => {
        globalStore.set(reviewModelAtom, {
            cwd: "/x",
            files: [{ path: "x", hunks: [] }, { path: "y", hunks: [] }],
        } as any);
        globalStore.set(appliedAtom, null);
        globalStore.set(reviewSelectedAtom, "x");
        globalStore.set(decisionsAtom, {});
        buildReviewBindings().find((b) => b.id === "review:next-j")!.run(filesCtx);
        expect(globalStore.get(reviewSelectedAtom)).toBe("y");
        globalStore.set(reviewModelAtom, null);
        globalStore.set(appliedAtom, null);
    });
});
